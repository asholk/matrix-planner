/**
 * «Получить фото»: картинка обоев на сегодня (`lock.png` профиля) как фото.
 *
 * Телефон и планшет — системный лист «Поделиться» (`navigator.share` с файлом →
 * «Сохранить изображение»). Лист открывается только синхронно из нажатия, поэтому
 * PNG готовится заранее (`warm`) или в два шага: первое нажатие рисует и читает
 * файл, кнопка меняется на «Поделиться». Без `navigator.share` — окно с картинкой
 * (нажать и удерживать → «Сохранить в Фото»).
 *
 * Компьютер — окно предпросмотра: «Сохранить как…», «Скопировать»,
 * «Показать в папке», «Открыть».
 */

import { Platform, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { Clock, Notifier, SheetHandle, SheetPresenter, WallpaperService, WallpaperStatusTracker } from '../app/contracts';
import { registerDictionary, t } from '../i18n';
import { enLockscreen } from '../i18n/en/lockscreen';
import { ruLockscreen } from '../i18n/ru/lockscreen';
import { floatingFromDate, isValidTimeZone } from '../model/dates';
import type { LocalDateString, OpResult, Unsubscribe, VaultPath } from '../model/types';

registerDictionary('ru', 'lockscreen', ruLockscreen);
registerDictionary('en', 'lockscreen', enLockscreen);

/** Источник картинки: рендер пакета и чтение `lock.png` (реализует `PlannerWallpaperService`). */
export interface PhotoWallpaperSource extends Pick<WallpaperService, 'renderAll' | 'resolveProfile'> {
  readCurrentImage(): Promise<OpResult<{ path: VaultPath; data: ArrayBuffer }>>;
}

export type PhotoStatus = Pick<WallpaperStatusTracker, 'isFresh' | 'getDataRevision' | 'getActionKind' | 'getState' | 'run'>;

/** Окружение браузера (подменяется в тестах). */
export interface PhotoEnvironment {
  isMobile(): boolean;
  canShare(data: ShareData): boolean;
  /** `null` — `navigator.share` недоступен. */
  share: ((data: ShareData) => Promise<void>) | null;
  /** `null` — запись картинки в буфер обмена недоступна. */
  copyImage: ((blob: Blob) => Promise<void>) | null;
  createFile(blob: Blob, name: string): File | null;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
}

export interface PhotoExportDeps {
  wallpaper: PhotoWallpaperSource;
  status: PhotoStatus;
  clock: Clock;
  notifier: Notifier;
  sheets: SheetPresenter;
  /** Для «Открыть файл», «Показать в папке», «Открыть»; без него эти кнопки скрыты. */
  app?: App | null;
  env?: Partial<PhotoEnvironment>;
}

/** Состояние кнопки «Получить фото». */
export interface PhotoButtonModel {
  /** `get` — «Получить фото», `share` — «Поделиться» (второй шаг на телефоне). */
  kind: 'get' | 'share';
  busy: boolean;
  label: string;
  icon: string;
}

interface PreparedPhoto {
  blob: Blob;
  path: VaultPath;
  fileName: string;
  revision: number;
  day: LocalDateString;
  profileId: string;
}

/** Внутренние методы `App` на компьютере (нет в типах API). */
interface DesktopAppInternals {
  showInFolder?(path: string): unknown;
  openWithDefaultApp?(path: string): unknown;
}

function desktopApp(app: App | null | undefined): DesktopAppInternals | null {
  return app ? (app as unknown as DesktopAppInternals) : null;
}

function navigatorOf(): Navigator | null {
  return typeof navigator === 'undefined' ? null : navigator;
}

function defaultEnvironment(): PhotoEnvironment {
  const nav = navigatorOf();
  const share = nav && typeof nav.share === 'function' ? (data: ShareData) => nav.share(data) : null;
  const clipboard = nav?.clipboard;
  const copyImage =
    clipboard && typeof clipboard.write === 'function' && typeof ClipboardItem === 'function'
      ? (blob: Blob) => clipboard.write([new ClipboardItem({ 'image/png': blob })])
      : null;
  return {
    isMobile: () => Platform.isMobile,
    canShare: (data) => {
      try {
        return typeof nav?.canShare === 'function' && nav.canShare(data);
      } catch {
        return false;
      }
    },
    share,
    copyImage,
    createFile: (blob, name) => (typeof File === 'function' ? new File([blob], name, { type: 'image/png' }) : null),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  };
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export class PhotoExporter {
  private readonly env: PhotoEnvironment;
  private cache: PreparedPhoto | null = null;
  /** Свой рендер (на iPhone через сервис, без быстрой команды): трекер о нём не знает. */
  private ownRender: { revision: number; day: LocalDateString; profileId: string } | null = null;
  private preparing = false;
  /** Второй шаг: PNG подготовлен по нажатию, кнопка показывает «Поделиться». */
  private armed = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: PhotoExportDeps) {
    this.env = { ...defaultEnvironment(), ...deps.env };
  }

  onChange(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.cache = null;
  }

  buttonModel(): PhotoButtonModel {
    if (this.preparing) return { kind: 'get', busy: true, label: t('lockscreen.photo.preparing'), icon: 'refresh-cw' };
    if (this.armed && this.validCache()) return { kind: 'share', busy: false, label: t('lockscreen.photo.share'), icon: 'share' };
    return { kind: 'get', busy: false, label: t('lockscreen.photo.get'), icon: 'image' };
  }

  /** Заранее читает свежий `lock.png` в память, чтобы «Поделиться» сработало с первого нажатия. */
  warm(): void {
    if (this.disposed || this.preparing || this.validCache() || !this.isFresh()) return;
    void this.load(false);
  }

  /**
   * Обработчик нажатия. Вызывать синхронно из `click`: `navigator.share`
   * должен начаться до первого `await`.
   */
  handleClick(): void {
    if (this.disposed || this.preparing) return;
    const photo = this.validCache();
    const mobile = this.env.isMobile();
    if (photo) {
      if (mobile) this.shareOrShow(photo);
      else this.openDesktopSheet(photo);
      return;
    }
    void this.prepare().then((prepared) => {
      if (!prepared || this.disposed) return;
      if (!mobile) {
        this.openDesktopSheet(prepared);
      } else if (this.canShareFile(prepared)) {
        // Жест пользователя потерян за время рендера — нужен второй тап.
        this.armed = true;
        this.emit();
        this.deps.notifier.show(t('lockscreen.photo.ready'));
      } else {
        this.openMobileSheet(prepared);
      }
    });
  }

  // --- Подготовка ---

  private today(): LocalDateString {
    const zone = this.deps.clock.timeZone();
    return floatingFromDate(this.deps.clock.now(), isValidTimeZone(zone) ? zone : undefined).date;
  }

  private profileId(): string {
    return this.deps.wallpaper.resolveProfile().id;
  }

  private isFresh(): boolean {
    if (this.deps.status.isFresh()) return true;
    const own = this.ownRender;
    return own !== null && own.revision === this.deps.status.getDataRevision() && own.day === this.today() && own.profileId === this.profileId();
  }

  private validCache(): PreparedPhoto | null {
    const cache = this.cache;
    if (!cache) return null;
    if (cache.revision !== this.deps.status.getDataRevision() || cache.day !== this.today() || cache.profileId !== this.profileId()) return null;
    return cache;
  }

  private async prepare(): Promise<PreparedPhoto | null> {
    this.preparing = true;
    this.armed = false;
    this.emit();
    try {
      if (!this.isFresh()) {
        const rendered = await this.render();
        if (!rendered) return null;
      }
      return await this.load(true);
    } finally {
      this.preparing = false;
      this.emit();
    }
  }

  /** Актуальный пакет: на компьютере и Android — через трекер (статус «Сохранено»), на iPhone — сервисом без быстрой команды. */
  private async render(): Promise<boolean> {
    const status = this.deps.status;
    if (status.getState().kind === 'rendering') {
      this.deps.notifier.show(t('lockscreen.photo.busy'));
      return false;
    }
    const revision = status.getDataRevision();
    const day = this.today();
    if (status.getActionKind() === 'save') {
      // Трекер сам сообщает об ошибке рендера.
      await status.run();
      return status.isFresh();
    }
    let ok = false;
    let profileId = this.profileId();
    try {
      const result = await this.deps.wallpaper.renderAll();
      if (result.ok && result.value.lockUpdated) {
        ok = true;
        profileId = result.value.profile.id;
      }
    } catch (error) {
      console.error('[matrix-planner] wallpaper render for photo failed', error);
    }
    if (!ok) {
      this.deps.notifier.show(t('lockscreen.photo.renderFailed'));
      return false;
    }
    this.ownRender = { revision, day, profileId };
    return true;
  }

  private async load(report: boolean): Promise<PreparedPhoto | null> {
    const revision = this.deps.status.getDataRevision();
    const day = this.today();
    const profileId = this.profileId();
    let read: Awaited<ReturnType<PhotoWallpaperSource['readCurrentImage']>>;
    try {
      read = await this.deps.wallpaper.readCurrentImage();
    } catch (error) {
      read = { ok: false, error: { code: 'unknown', detail: String(error) } };
    }
    if (!read.ok) {
      if (report) this.deps.notifier.show(t('lockscreen.photo.readFailed'));
      return null;
    }
    if (this.disposed) return null;
    const photo: PreparedPhoto = {
      blob: new Blob([read.value.data], { type: 'image/png' }),
      path: read.value.path,
      fileName: t('lockscreen.photo.fileName', { date: day }),
      revision,
      day,
      profileId,
    };
    this.cache = photo;
    this.emit();
    return photo;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  // --- Телефон ---

  private shareData(photo: PreparedPhoto): ShareData | null {
    const file = this.env.createFile(photo.blob, photo.fileName);
    return file ? { files: [file], title: t('lockscreen.photo.shareTitle') } : null;
  }

  private canShareFile(photo: PreparedPhoto): boolean {
    const data = this.shareData(photo);
    return data !== null && this.env.share !== null && this.env.canShare(data);
  }

  private shareOrShow(photo: PreparedPhoto): void {
    const data = this.shareData(photo);
    const share = this.env.share;
    if (!data || !share || !this.env.canShare(data)) {
      this.openMobileSheet(photo);
      return;
    }
    this.armed = false;
    this.emit();
    // Синхронно: до этого места нет `await`.
    share(data).catch((error: unknown) => {
      if (isAbort(error)) return;
      console.error('[matrix-planner] wallpaper share failed', error);
      if (!this.disposed) this.openMobileSheet(photo);
    });
  }

  private openMobileSheet(photo: PreparedPhoto): void {
    this.openSheet(photo, (contentEl, handle) => {
      contentEl.createDiv({ cls: 'mp-ls-hint mp-ls-photo-hint', text: t('lockscreen.photo.holdHint') });
      const actions = contentEl.createDiv({ cls: 'mp-ls-photo-actions' });
      if (this.deps.app) {
        actionButton(actions, 'file-image', t('lockscreen.photo.openFile'), () => {
          if (this.openInObsidian(photo.path)) handle.close();
        });
      }
    });
  }

  private openInObsidian(path: VaultPath): boolean {
    const app = this.deps.app;
    const file = app?.vault.getFileByPath(path) ?? null;
    if (!app || !file) {
      this.deps.notifier.show(t('lockscreen.photo.openFailed'));
      return false;
    }
    void app.workspace.getLeaf(true).openFile(file);
    return true;
  }

  // --- Компьютер ---

  private openDesktopSheet(photo: PreparedPhoto): void {
    this.openSheet(photo, (contentEl, _handle, url) => {
      contentEl.createDiv({ cls: 'mp-ls-hint mp-ls-photo-hint', text: t('lockscreen.photo.desktopHint') });
      const actions = contentEl.createDiv({ cls: 'mp-ls-photo-actions' });
      actionButton(actions, 'download', t('lockscreen.photo.saveAs'), () => {
        // В Electron ссылка с `download` открывает диалог сохранения.
        const link = contentEl.createEl('a', { cls: 'mp-ls-photo-download', attr: { href: url, download: photo.fileName } });
        link.click();
        link.remove();
      });
      const copyImage = this.env.copyImage;
      if (copyImage) {
        actionButton(actions, 'copy', t('lockscreen.photo.copy'), () => {
          copyImage(photo.blob).then(
            () => this.deps.notifier.show(t('lockscreen.photo.copied')),
            (error: unknown) => {
              console.error('[matrix-planner] wallpaper copy failed', error);
              this.deps.notifier.show(t('lockscreen.photo.copyFailed'));
            },
          );
        });
      }
      const internals = desktopApp(this.deps.app);
      if (internals && typeof internals.showInFolder === 'function') {
        actionButton(actions, 'folder-open', t('lockscreen.photo.showInFolder'), () => {
          this.callApp(() => internals.showInFolder?.(photo.path));
        });
      }
      if (internals && typeof internals.openWithDefaultApp === 'function') {
        actionButton(actions, 'external-link', t('lockscreen.photo.openDefault'), () => {
          this.callApp(() => internals.openWithDefaultApp?.(photo.path));
        });
      }
    });
  }

  private callApp(action: () => unknown): void {
    try {
      const result = action();
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          console.error('[matrix-planner] wallpaper file action failed', error);
          this.deps.notifier.show(t('lockscreen.photo.openFailed'));
        });
      }
    } catch (error) {
      console.error('[matrix-planner] wallpaper file action failed', error);
      this.deps.notifier.show(t('lockscreen.photo.openFailed'));
    }
  }

  // --- Общее окно ---

  private openSheet(photo: PreparedPhoto, renderActions: (contentEl: HTMLElement, handle: SheetHandle, url: string) => void): void {
    let url: string | null = this.env.createObjectUrl(photo.blob);
    this.deps.sheets.open({
      title: t('lockscreen.photo.title'),
      submitLabel: null,
      fullScreenOnPhone: true,
      render: (contentEl, handle) => {
        const root = contentEl.createDiv({ cls: 'mp-ls-photo' });
        const frame = root.createDiv({ cls: 'mp-ls-photo-frame' });
        frame.createEl('img', { cls: 'mp-ls-photo-image', attr: { src: url ?? '', alt: t('lockscreen.photo.imageAlt') } });
        renderActions(root, handle, url ?? '');
      },
      onClose: () => {
        if (url) this.env.revokeObjectUrl(url);
        url = null;
      },
    });
  }
}

function actionButton(parentEl: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = parentEl.createEl('button', { cls: 'mp-ls-button mp-ls-photo-action', attr: { type: 'button' } });
  setIcon(button.createSpan({ cls: 'mp-ls-button-icon', attr: { 'aria-hidden': 'true' } }), icon);
  button.createSpan({ text: label });
  button.addEventListener('click', onClick);
  return button;
}

/** Рисует содержимое кнопки «Получить фото» по модели. */
export function renderPhotoButton(button: HTMLElement, model: PhotoButtonModel): void {
  button.empty();
  button.toggleClass('is-busy', model.busy);
  button.toggleClass('mod-cta', model.kind === 'share');
  button.setAttr('aria-busy', model.busy ? 'true' : 'false');
  setIcon(button.createSpan({ cls: 'mp-ls-button-icon', attr: { 'aria-hidden': 'true' } }), model.icon);
  button.createSpan({ text: model.label });
}
