/**
 * Редактор обоев (ТЗ §4.5; кадры 17, 18; доработка 007): лист «Настроить»
 * с предпросмотром и разделами «Шаблон», «Фон», «Палитра», «Параметры».
 *
 * Поверх предпросмотра — макет экрана блокировки iOS (дата, часы, виджеты,
 * фонарик и камера, зона уведомлений); на PNG он не рисуется.
 * Предпросмотр — `WallpaperService.renderPreview`. Изменения живут в черновике
 * (`wallpaper-draft.ts`) до «Готово»; закрытие с изменениями спрашивает «Сбросить изменения?».
 */

import { FuzzySuggestModal, Platform, Setting, setIcon } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type {
  CalendarCacheReader,
  Clock,
  FormatPreferencesProvider,
  Notifier,
  SettingsStore,
  SheetHandle,
  SheetPresenter,
  WallpaperService,
  WallpaperStatusTracker,
  WriteGuard,
} from '../app/contracts';
import { registerDictionary, t } from '../i18n';
import { enLockscreen } from '../i18n/en/lockscreen';
import { ruLockscreen } from '../i18n/ru/lockscreen';
import { enWallpaperPhoto } from '../i18n/en/wallpaper-photo';
import { ruWallpaperPhoto } from '../i18n/ru/wallpaper-photo';
import type { HapticKind } from '../ui/haptics';
import { floatingFromDate } from '../model/dates';
import type {
  LocalDateString,
  VaultPath,
  WallpaperProfile,
  WallpaperSettings,
  WallpaperTemplate,
} from '../model/types';
import { BackgroundImageCache, createVaultImageReader, findBackgroundError, type WallpaperBackgroundError } from './background';
import { layoutCardBoxes } from './composition';
import { openCropEditor } from './crop-editor';
import { isDefaultCrop } from './crop-math';
import { iosDateText, iosTimeText, renderIosOverlay } from './ios-overlay';
import { PALETTE_SPECS, resolvePalette } from './layout';
import {
  PHOTO_FOLDER_NAME,
  createBrowserPhotoEnv,
  importPhoto,
  megapixels,
  photoFolder,
  type PhotoImportEnv,
  type PhotoImportFailure,
  type PhotoImportResult,
} from './photo-import';
import {
  BACKGROUND_KINDS,
  GRADIENT_PRESETS,
  LAYOUT_PRESETS,
  PALETTES,
  SOLID_PRESETS,
  TEMPLATE_CATALOG,
  createDraft,
  effectiveCalendarIds,
  isDirty,
  applyDraft,
  previewSettings,
  profileOptions,
  resetCrop,
  setBackgroundKind,
  setCalendarEnabled,
  setCrop,
  setGradient,
  setImage,
  setLayoutPreset,
  setPalette,
  setProfile,
  setSolidColor,
  setTasksPerQuadrant,
  setTemplate,
  setWeekStart,
  showsItemTitles,
  useDefaultCalendars,
  useExplicitCalendars,
  type WallpaperDraft,
} from './wallpaper-draft';

registerDictionary('ru', 'lockscreen', ruLockscreen);
registerDictionary('en', 'lockscreen', enLockscreen);
registerDictionary('ru', 'wallpaperPhoto', ruWallpaperPhoto);
registerDictionary('en', 'wallpaperPhoto', enWallpaperPhoto);

export type EditorSection = 'template' | 'background' | 'palette' | 'params';

const SECTIONS: readonly { id: EditorSection; icon: string }[] = [
  { id: 'template', icon: 'layout-template' },
  { id: 'background', icon: 'image' },
  { id: 'palette', icon: 'palette' },
  { id: 'params', icon: 'sliders-horizontal' },
];

/** Задержка перерисовки предпросмотра при частых изменениях (ползунки), мс. */
const PREVIEW_DEBOUNCE_MS = 60;

/** «Показать зоны iOS»: запоминается до перезапуска Obsidian. */
let showIosZones = true;

export interface WallpaperEditorDeps {
  settings: SettingsStore;
  wallpaper: Pick<WallpaperService, 'renderPreview' | 'resolveProfile'>;
  /** Изменение настроек обоев делает сохранённые PNG устаревшими. */
  status: Pick<WallpaperStatusTracker, 'markDataChanged'>;
  sheets: SheetPresenter;
  clock: Clock;
  format: FormatPreferencesProvider;
  notifier: Notifier;
  /** Календари из кэша компаньона; `null` — кэш не подключён. */
  calendars: Pick<CalendarCacheReader, 'getCalendars'> | null;
  /** Выбор картинки из хранилища (см. `createVaultImagePicker`). */
  pickImage(): Promise<VaultPath | null>;
  /** Хранилище: «Выбрать из Фото» и кадрировщик; без него этих кнопок нет. */
  app?: App | null;
  /** Запрет записи (режим только чтения) для «Выбрать из Фото». */
  writeGuard?: Pick<WriteGuard, 'check'> | null;
  /** Подмена декодирования/кодирования фото (тесты). */
  photoImportEnv?: PhotoImportEnv;
  /** Тактильный отклик. */
  haptic?(kind: HapticKind): void;
}

export interface WallpaperEditorOptions {
  /** Сразу выбрать шаблон (из галереи). */
  template?: WallpaperTemplate;
  section?: EditorSection;
  onClose?(): void;
}

// ===========================================================================
// Общие помощники предпросмотра (используются и вкладкой)
// ===========================================================================

/** Сегодняшняя дата по часам плагина. */
export function todayOf(clock: Clock): LocalDateString {
  return floatingFromDate(clock.now(), clock.timeZone()).date;
}

/** Наибольшая высота холста предпросмотра редактора, px. */
export const PREVIEW_MAX_HEIGHT = 960;
/** Наибольшая высота холста миниатюры вкладки, px. */
export const THUMBNAIL_MAX_HEIGHT = 560;

/** Размер холста предпросмотра: пропорции профиля, высота не больше `maxHeight`. */
export function previewCanvasSize(profile: Pick<WallpaperProfile, 'width' | 'height'>, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxHeight / profile.height);
  return { width: Math.max(1, Math.round(profile.width * scale)), height: Math.max(1, Math.round(profile.height * scale)) };
}

/**
 * Готовит canvas под профиль: уменьшенный холст с пропорциями профиля (renderer
 * масштабирует рисунок под размер холста), пропорции рамки — CSS-переменной.
 * Полное разрешение профиля (~12 МБ на холст) в предпросмотре не нужно.
 */
export function prepareCanvas(canvas: HTMLCanvasElement, profile: WallpaperProfile, maxHeight: number = PREVIEW_MAX_HEIGHT): void {
  const size = previewCanvasSize(profile, maxHeight);
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  canvas.parentElement?.setCssProps({
    '--mp-ls-aspect': `${profile.width} / ${profile.height}`,
    '--mp-ls-ratio': String(profile.width / profile.height),
  });
}

/** Подписи макета часов iOS: «Сб 10 окт.» и «13:32». */
export function clockOverlayText(now: Date, timeZone: string, language: string, hour12: boolean): { date: string; time: string } {
  return { date: iosDateText(now, timeZone, language), time: iosTimeText(now, timeZone, hour12) };
}

export interface PhoneFrameOptions {
  cls?: string;
  clock?: { date: string; time: string } | null;
  label: string;
  /** Ряд виджетов под часами. */
  widgets?: boolean;
  /** Зоны iOS (виджеты, кнопки, уведомления); по умолчанию — только часы. */
  zones?: boolean;
}

/** Создаёт рамку «телефона» с canvas и (по желанию) макетом экрана блокировки iOS. */
export function createPhoneFrame(parentEl: HTMLElement, options: PhoneFrameOptions): { frameEl: HTMLElement; canvas: HTMLCanvasElement } {
  const frameEl = parentEl.createDiv({ cls: ['mp-ls-phone', ...(options.cls ? [options.cls] : [])] });
  const canvas = frameEl.createEl('canvas', { cls: 'mp-ls-canvas', attr: { role: 'img', 'aria-label': options.label } });
  if (options.clock) renderIosOverlay(frameEl, { ...options.clock, widgets: options.widgets ?? false, zones: options.zones ?? false });
  return { frameEl, canvas };
}

// ===========================================================================
// Выбор картинки из хранилища
// ===========================================================================

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);

class ImageSuggestModal extends FuzzySuggestModal<TFile> {
  private chosen = false;

  constructor(
    app: App,
    private readonly files: TFile[],
    private readonly done: (path: VaultPath | null) => void,
  ) {
    super(app);
    this.setPlaceholder(t('lockscreen.editor.background.pickerPlaceholder'));
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.chosen = true;
    this.done(item.path);
  }

  onClose(): void {
    super.onClose();
    // `onClose` приходит раньше `onChooseItem` — ждём один тик.
    window.setTimeout(() => {
      if (!this.chosen) this.done(null);
    }, 0);
  }
}

/** `pickImage` для редактора: поиск по картинкам хранилища (кроме папки `excludeFolder`). */
export function createVaultImagePicker(app: App, notifier: Notifier, excludeFolder?: () => string | null): () => Promise<VaultPath | null> {
  return () =>
    new Promise((resolve) => {
      const excluded = excludeFolder?.() ?? null;
      const files = app.vault
        .getFiles()
        .filter((file) => IMAGE_EXTENSIONS.has(file.extension.toLowerCase()))
        // Папка обоев скрыта, кроме загруженных фонов (`Обои/Фоны`).
        .filter(
          (file) =>
            !excluded ||
            file.path.startsWith(`${excluded}/${PHOTO_FOLDER_NAME}/`) ||
            !(file.path === excluded || file.path.startsWith(`${excluded}/`)),
        )
        .sort((a, b) => b.stat.mtime - a.stat.mtime);
      if (files.length === 0) {
        notifier.show(t('lockscreen.editor.background.pickerEmpty'));
        resolve(null);
        return;
      }
      let settled = false;
      new ImageSuggestModal(app, files, (path) => {
        if (settled) return;
        settled = true;
        resolve(path);
      }).open();
    });
}

// ===========================================================================
// Тексты ошибок
// ===========================================================================

/** Причина недоступного фона для сообщения у раздела «Фон». */
export function backgroundErrorMessage(error: unknown): string {
  const bg = findBackgroundError(error);
  if (!bg) return t('lockscreen.editor.previewFailed');
  const name = bg.path.split('/').pop() ?? bg.path;
  switch (bg.code) {
    case 'missing':
      return t('lockscreen.editor.bgError.missing', { file: name });
    case 'read':
      return t('lockscreen.editor.bgError.read', { file: name, reason: bg.detail ?? '' });
    case 'decode':
      return t('lockscreen.editor.bgError.decode', { file: name });
  }
}

const FORMAT_NAMES: Readonly<Record<string, string>> = {
  jpeg: 'JPEG',
  png: 'PNG',
  gif: 'GIF',
  webp: 'WebP',
  bmp: 'BMP',
  heic: 'HEIC',
  avif: 'AVIF',
  tiff: 'TIFF',
};

/** Текст причины, по которой фото не загружено (доработка 007). */
export function photoImportMessage(result: PhotoImportFailure): string {
  switch (result.code) {
    case 'read-only': {
      const specific = t(result.messageKey);
      return specific !== result.messageKey ? specific : t('wallpaperPhoto.readOnly');
    }
    case 'empty':
      return t('wallpaperPhoto.empty');
    case 'unsupported':
      if (result.format === 'heic') return t('wallpaperPhoto.heic');
      if (result.format === 'unknown') return t('wallpaperPhoto.notImage');
      return t('wallpaperPhoto.unsupported', { format: FORMAT_NAMES[result.format] ?? result.format });
    case 'corrupt':
      return t('wallpaperPhoto.corrupt', { format: FORMAT_NAMES[result.format] ?? result.format });
    case 'too-small':
      return t('wallpaperPhoto.tooSmall', { width: result.width, height: result.height, needWidth: result.needWidth, needHeight: result.needHeight });
    case 'too-large':
      return t('wallpaperPhoto.tooLarge', { megapixels: megapixels(result.width, result.height) });
    case 'encode':
      return t('wallpaperPhoto.encodeFailed', { reason: result.detail });
    case 'write':
      return t('wallpaperPhoto.writeFailed', { reason: result.detail });
  }
}

/** Состояние загрузки фото под кнопкой «Выбрать из Фото». */
type PhotoIssue = { kind: 'error'; message: string } | { kind: 'warning'; message: string; file: Blob };

// ===========================================================================
// Редактор
// ===========================================================================

export function openWallpaperEditor(deps: WallpaperEditorDeps, options: WallpaperEditorOptions = {}): SheetHandle {
  const editor = new WallpaperEditor(deps, options);
  return deps.sheets.open({
    title: t('lockscreen.editor.title'),
    submitLabel: t('lockscreen.editor.submit'),
    fullScreenOnPhone: true,
    cls: 'mp-ls-editor-sheet',
    render: (contentEl) => editor.render(contentEl),
    onSubmit: () => editor.save(),
    onClose: () => {
      editor.dispose();
      options.onClose?.();
    },
    // «Сбросить изменения?» (п.9): черновик изменён или фото ещё загружается.
    isDirty: () => editor.hasUnsavedWork(),
    haptic: (kind) => deps.haptic?.(kind),
  });
}

class WallpaperEditor {
  private draft: WallpaperDraft;
  private section: EditorSection;
  private rootEl: HTMLElement | null = null;
  private previewFrameEl: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private sectionTabsEl: HTMLElement | null = null;
  private sectionBodyEl: HTMLElement | null = null;
  private bgErrorEl: HTMLElement | null = null;
  private privacyEl: HTMLElement | null = null;
  private zonesButtonEl: HTMLButtonElement | null = null;
  /** Скрытый `<input type="file">` для «Выбрать из Фото» (живёт с редактором). */
  private photoInputEl: HTMLInputElement | null = null;
  private photoImportBusy = false;
  private photoIssue: PhotoIssue | null = null;
  /** Недоступная картинка фона по последнему предпросмотру. */
  private backgroundError: WallpaperBackgroundError | null = null;
  /** Картинка фона для кадрировщика (своя: не мешает пакету). */
  private cropImages: BackgroundImageCache | null = null;
  private cropOpen = false;
  private previewTimer: number | null = null;
  private previewRunning = false;
  private previewPending = false;
  private disposed = false;

  constructor(
    private readonly deps: WallpaperEditorDeps,
    options: WallpaperEditorOptions,
  ) {
    this.draft = createDraft(deps.settings.get().wallpaper);
    if (options.template) this.draft = setTemplate(this.draft, options.template);
    this.section = options.section ?? 'template';
  }

  render(contentEl: HTMLElement): void {
    const root = contentEl.createDiv({ cls: 'mp-ls-editor' });
    this.rootEl = root;

    const previewWrap = root.createDiv({ cls: 'mp-ls-editor-preview' });
    const { frameEl, canvas } = createPhoneFrame(previewWrap, { cls: 'mp-ls-phone-large', label: t('lockscreen.editor.previewLabel') });
    this.previewFrameEl = frameEl;
    this.canvas = canvas;
    this.renderOverlay();
    frameEl.addEventListener('click', () => {
      // Касание предпросмотра с фото — сразу в кадрировщик.
      if (this.draft.current.background.kind === 'image' && this.canCrop()) this.openCrop();
    });

    const zones = previewWrap.createEl('button', { cls: 'mp-chip mp-ls-zones-toggle', attr: { type: 'button' } });
    setIcon(zones.createSpan({ cls: 'mp-ls-zones-icon', attr: { 'aria-hidden': 'true' } }), 'scan');
    zones.createSpan({ text: t('lockscreen.editor.zones.toggle') });
    zones.addEventListener('click', () => {
      showIosZones = !showIosZones;
      this.deps.haptic?.('select');
      this.renderOverlay();
    });
    this.zonesButtonEl = zones;

    const panel = root.createDiv({ cls: 'mp-ls-editor-panel' });
    this.sectionTabsEl = panel.createDiv({ cls: 'mp-ls-sections', attr: { role: 'tablist', 'aria-label': t('lockscreen.editor.sections.label') } });
    this.bgErrorEl = panel.createDiv({ cls: 'mp-ls-bg-error', attr: { role: 'alert' } });
    this.sectionBodyEl = panel.createDiv({ cls: 'mp-ls-section-body', attr: { role: 'tabpanel' } });
    this.privacyEl = panel.createDiv({ cls: 'mp-ls-privacy', attr: { role: 'note' } });
    setIcon(this.privacyEl.createSpan({ cls: 'mp-ls-privacy-icon', attr: { 'aria-hidden': 'true' } }), 'eye');
    this.privacyEl.createSpan({ text: t('lockscreen.editor.privacy') });

    this.renderSectionTabs();
    this.renderSection();
    this.renderBackgroundError();
    this.syncChrome();
    this.schedulePreview(0);
  }

  /** Есть что терять при закрытии: изменённый черновик или незавершённая загрузка фото. */
  hasUnsavedWork(): boolean {
    return isDirty(this.draft) || this.photoImportBusy;
  }

  async save(): Promise<boolean> {
    if (!isDirty(this.draft)) return true;
    const draft = this.draft;
    try {
      await this.deps.settings.update((settings) => {
        settings.wallpaper = applyDraft(settings.wallpaper, draft);
      });
    } catch (error) {
      console.error('[matrix-planner] wallpaper settings save failed', error);
      this.deps.notifier.show(t('lockscreen.editor.saveFailed'));
      return false;
    }
    this.deps.status.markDataChanged();
    // Сохранённое — новая точка отсчёта: повторное сохранение не сбросит свежесть PNG.
    this.draft = { original: draft.current, current: this.draft.current };
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.cropImages?.release();
    this.cropImages = null;
    this.rootEl = null;
    this.canvas = null;
    this.photoInputEl?.remove();
    this.photoInputEl = null;
  }

  // --- Черновик ---

  private update(next: WallpaperDraft | null, options: { rerenderSection?: boolean; delay?: number; haptic?: HapticKind } = {}): void {
    if (!next || next === this.draft) return;
    const backgroundChanged = JSON.stringify(next.current.background) !== JSON.stringify(this.draft.current.background);
    this.draft = next;
    if (options.haptic) this.deps.haptic?.(options.haptic);
    if (backgroundChanged && this.backgroundError) {
      // Новый фон — прежняя ошибка неактуальна; предпросмотр покажет, есть ли новая.
      this.backgroundError = null;
      this.renderBackgroundError();
    }
    if (options.rerenderSection) this.renderSection();
    this.syncChrome();
    this.schedulePreview(options.delay ?? 0);
  }

  private baseSettings(): WallpaperSettings {
    return this.deps.settings.get().wallpaper;
  }

  private settings(): WallpaperSettings {
    return previewSettings(this.baseSettings(), this.draft);
  }

  private clockText(): { date: string; time: string } {
    const format = this.deps.format.get();
    return clockOverlayText(this.deps.clock.now(), this.deps.clock.timeZone(), format.language, format.hour12);
  }

  /** Макет iOS зависит от композиции (виджеты) и переключателя зон. */
  private renderOverlay(): void {
    const frame = this.previewFrameEl;
    if (!frame) return;
    renderIosOverlay(frame, { ...this.clockText(), widgets: this.draft.current.layoutPreset === 'widgets', zones: showIosZones });
    if (this.zonesButtonEl) {
      this.zonesButtonEl.toggleClass('is-active', showIosZones);
      this.zonesButtonEl.setAttr('aria-pressed', showIosZones ? 'true' : 'false');
    }
  }

  private syncChrome(): void {
    if (this.privacyEl) this.privacyEl.hidden = !showsItemTitles(this.draft.current.template);
    this.previewFrameEl?.toggleClass('is-croppable', this.draft.current.background.kind === 'image' && this.canCrop());
    this.renderOverlay();
  }

  // --- Предпросмотр ---

  private schedulePreview(delay: number): void {
    if (this.disposed) return;
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      void this.renderPreview();
    }, delay);
  }

  /** Один рендер за раз; изменения во время рендера — ещё один проход. */
  private async renderPreview(): Promise<void> {
    if (this.previewRunning) {
      this.previewPending = true;
      return;
    }
    const canvas = this.canvas;
    if (!canvas || this.disposed) return;
    this.previewRunning = true;
    let error: unknown = null;
    try {
      const settings = this.settings();
      prepareCanvas(canvas, this.deps.wallpaper.resolveProfile(settings));
      await this.deps.wallpaper.renderPreview(canvas, settings, todayOf(this.deps.clock));
    } catch (caught) {
      error = caught;
    } finally {
      this.previewRunning = false;
    }
    if (this.disposed) return;
    if (this.previewPending) {
      // Черновик уже другой — итог покажет следующий проход.
      this.previewPending = false;
      void this.renderPreview();
      return;
    }
    this.previewFrameEl?.toggleClass('is-failed', error !== null);
    const background = error === null ? null : findBackgroundError(error);
    if (error !== null && !background) {
      console.error('[matrix-planner] wallpaper preview failed', error);
      this.previewFrameEl?.setAttr('title', t('lockscreen.editor.previewFailed'));
    } else {
      this.previewFrameEl?.removeAttribute('title');
    }
    this.setBackgroundError(background);
  }

  // --- Недоступный фон (п.8) ---

  private setBackgroundError(error: WallpaperBackgroundError | null): void {
    const before = this.backgroundError;
    if (before === error || (before && error && before.code === error.code && before.path === error.path)) return;
    this.backgroundError = error;
    if (error && !before) this.deps.haptic?.('error');
    this.renderBackgroundError();
    if (this.section === 'background') this.renderSection();
  }

  private renderBackgroundError(): void {
    const el = this.bgErrorEl;
    if (!el) return;
    el.empty();
    const error = this.backgroundError;
    el.hidden = !error;
    this.sectionTabsEl?.querySelector('[data-section="background"]')?.toggleClass('has-error', !!error);
    if (!error) return;
    const head = el.createDiv({ cls: 'mp-ls-bg-error-head' });
    setIcon(head.createSpan({ cls: 'mp-ls-bg-error-icon', attr: { 'aria-hidden': 'true' } }), 'image-off');
    const text = head.createDiv({ cls: 'mp-ls-bg-error-text' });
    text.createDiv({ cls: 'mp-ls-bg-error-title', text: t('lockscreen.editor.bgError.title') });
    text.createDiv({ cls: 'mp-ls-bg-error-reason', text: backgroundErrorMessage(error) });
    text.createDiv({ cls: 'mp-ls-bg-error-note', text: t('lockscreen.editor.bgError.note') });
    const actions = el.createDiv({ cls: 'mp-ls-bg-error-actions' });
    const choose = actions.createEl('button', { cls: 'mp-ls-button', text: t('lockscreen.editor.bgError.choose'), attr: { type: 'button' } });
    choose.addEventListener('click', () => void this.chooseImage());
    const solid = actions.createEl('button', { cls: 'mp-ls-button', text: t('lockscreen.editor.bgError.solid'), attr: { type: 'button' } });
    solid.addEventListener('click', () => {
      const next = setBackgroundKind(this.draft, 'solid');
      // Исходный фон мог быть однотонным — тогда вернётся он.
      this.update(next && next.current.background.kind === 'solid' ? next : setSolidColor(this.draft, SOLID_PRESETS[0]), {
        rerenderSection: true,
        haptic: 'select',
      });
    });
  }

  // --- Разделы ---

  private renderSectionTabs(): void {
    const tabs = this.sectionTabsEl;
    if (!tabs) return;
    tabs.empty();
    for (const item of SECTIONS) {
      const active = item.id === this.section;
      const label = t(`lockscreen.editor.sections.${item.id}`);
      const button = tabs.createEl('button', {
        cls: 'mp-ls-section-tab',
        attr: { type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false', 'aria-label': label, title: label, 'data-section': item.id },
      });
      button.toggleClass('is-active', active);
      button.toggleClass('has-error', item.id === 'background' && !!this.backgroundError);
      setIcon(button.createSpan({ cls: 'mp-ls-section-icon', attr: { 'aria-hidden': 'true' } }), item.icon);
      button.createSpan({ cls: 'mp-ls-section-label', text: label });
      button.addEventListener('click', () => {
        if (this.section === item.id) return;
        this.section = item.id;
        this.deps.haptic?.('select');
        this.renderSectionTabs();
        this.renderSection();
      });
    }
  }

  private renderSection(): void {
    const body = this.sectionBodyEl;
    if (!body) return;
    body.empty();
    switch (this.section) {
      case 'template':
        this.renderTemplateSection(body);
        break;
      case 'background':
        this.renderBackgroundSection(body);
        break;
      case 'palette':
        this.renderPaletteSection(body);
        break;
      case 'params':
        this.renderParamsSection(body);
        break;
    }
  }

  private renderTemplateSection(body: HTMLElement): void {
    const list = body.createDiv({ cls: 'mp-ls-options', attr: { role: 'radiogroup', 'aria-label': t('lockscreen.editor.sections.template') } });
    for (const info of TEMPLATE_CATALOG) {
      const selected = this.draft.current.template === info.id;
      const option = optionButton(list, selected);
      const iconEl = option.createSpan({ cls: 'mp-ls-option-icon', attr: { 'aria-hidden': 'true' } });
      setIcon(iconEl, info.icon);
      const text = option.createSpan({ cls: 'mp-ls-option-text' });
      text.createSpan({ cls: 'mp-ls-option-category', text: t(`lockscreen.templates.category.${info.category}`) });
      text.createSpan({ cls: 'mp-ls-option-title', text: t(`lockscreen.templates.${info.id}`) });
      text.createSpan({ cls: 'mp-ls-option-desc', text: t(`lockscreen.templates.${info.id}Desc`) });
      option.addEventListener('click', () => this.update(setTemplate(this.draft, info.id), { rerenderSection: true, haptic: 'select' }));
    }

    // Композиция (п.6): виджеты под часами есть / нет.
    const group = body.createDiv({ cls: 'mp-ls-composition' });
    const head = group.createDiv({ cls: 'mp-ls-composition-head' });
    head.createDiv({ cls: 'mp-ls-composition-title', text: t('lockscreen.editor.composition.label') });
    head.createDiv({ cls: 'mp-ls-hint', text: t('lockscreen.editor.composition.desc') });
    const segmented = group.createDiv({ cls: 'mp-segmented mp-ls-composition-options', attr: { role: 'radiogroup', 'aria-label': t('lockscreen.editor.composition.label') } });
    for (const preset of LAYOUT_PRESETS) {
      const active = this.draft.current.layoutPreset === preset;
      const button = segmented.createEl('button', {
        cls: 'mp-segment',
        text: t(`lockscreen.editor.composition.${preset === 'widgets' ? 'widgets' : 'noWidgets'}`),
        attr: { type: 'button', role: 'radio', 'aria-checked': active ? 'true' : 'false' },
      });
      button.toggleClass('is-active', active);
      button.addEventListener('click', () => this.update(setLayoutPreset(this.draft, preset), { rerenderSection: true, haptic: 'select' }));
    }
  }

  private renderBackgroundSection(body: HTMLElement): void {
    const background = this.draft.current.background;
    const kinds = body.createDiv({ cls: 'mp-segmented mp-ls-bg-kinds', attr: { role: 'radiogroup', 'aria-label': t('lockscreen.editor.background.kind') } });
    for (const kind of BACKGROUND_KINDS) {
      const active = background.kind === kind;
      const button = kinds.createEl('button', {
        cls: 'mp-segment',
        text: t(`lockscreen.editor.background.${kind}`),
        attr: { type: 'button', role: 'radio', 'aria-checked': active ? 'true' : 'false' },
      });
      button.toggleClass('is-active', active);
      button.addEventListener('click', () => {
        if (kind === 'image' && background.kind !== 'image') {
          const next = setBackgroundKind(this.draft, 'image');
          if (next) this.update(next, { rerenderSection: true, haptic: 'select' });
          else void this.chooseImage();
          return;
        }
        this.update(setBackgroundKind(this.draft, kind), { rerenderSection: true, haptic: 'select' });
      });
    }

    const content = body.createDiv({ cls: 'mp-ls-bg-content' });
    if (background.kind === 'image') {
      const row = content.createDiv({ cls: 'mp-ls-image-row' });
      const pathEl = row.createDiv({ cls: 'mp-ls-image-path', text: background.path || t('lockscreen.editor.background.noImage') });
      pathEl.setAttr('title', background.path);
      pathEl.toggleClass('is-error', !!this.backgroundError);
      const buttons = content.createDiv({ cls: 'mp-ls-image-actions' });
      if (this.canCrop()) {
        const crop = buttons.createEl('button', { cls: 'mp-ls-button mod-primary mp-ls-crop-open', attr: { type: 'button' } });
        setIcon(crop.createSpan({ cls: 'mp-ls-button-icon', attr: { 'aria-hidden': 'true' } }), 'crop');
        crop.createSpan({ text: t('lockscreen.editor.background.cropOpen') });
        crop.disabled = !!this.backgroundError;
        crop.addEventListener('click', () => this.openCrop());
      }
      const choose = buttons.createEl('button', { cls: 'mp-ls-button', attr: { type: 'button' } });
      setIcon(choose.createSpan({ cls: 'mp-ls-button-icon', attr: { 'aria-hidden': 'true' } }), 'image');
      choose.createSpan({ text: t('lockscreen.editor.background.changeImage') });
      choose.addEventListener('click', () => void this.chooseImage());
      this.renderPhotoImport(content);

      const crop = background.crop;
      const summary = content.createDiv({ cls: 'mp-ls-crop-summary' });
      summary.createSpan({ cls: 'mp-ls-hint', text: t('lockscreen.editor.background.cropSummary', { percent: Math.round(crop.scale * 100) }) });
      if (!isDefaultCrop(crop)) {
        const reset = summary.createEl('button', { cls: 'mp-chip', text: t('lockscreen.editor.background.resetCrop'), attr: { type: 'button' } });
        reset.addEventListener('click', () => this.update(resetCrop(this.draft), { rerenderSection: true, haptic: 'select' }));
      }
      return;
    }

    // Для цвета и градиента — тоже: картинки ещё может не быть.
    this.renderPhotoImport(content);

    if (background.kind === 'solid') {
      colorRow(content, t('lockscreen.editor.background.color'), background.color, (color) =>
        this.update(setSolidColor(this.draft, color), { delay: PREVIEW_DEBOUNCE_MS }),
      );
      const presets = content.createDiv({ cls: 'mp-ls-swatches', attr: { role: 'group', 'aria-label': t('lockscreen.editor.background.presets') } });
      for (const color of SOLID_PRESETS) {
        const swatch = swatchButton(presets, color, color.toLowerCase() === background.color.toLowerCase());
        swatch.setCssProps({ '--mp-ls-swatch': color });
        swatch.addEventListener('click', () => this.update(setSolidColor(this.draft, color), { rerenderSection: true, haptic: 'select' }));
      }
      return;
    }

    colorRow(content, t('lockscreen.editor.background.from'), background.from, (color) =>
      this.update(setGradient(this.draft, { from: color }), { delay: PREVIEW_DEBOUNCE_MS }),
    );
    colorRow(content, t('lockscreen.editor.background.to'), background.to, (color) =>
      this.update(setGradient(this.draft, { to: color }), { delay: PREVIEW_DEBOUNCE_MS }),
    );
    rangeRow(content, t('lockscreen.editor.background.angle'), { min: 0, max: 359, step: 1, value: background.angle, suffix: '°' }, (value) =>
      this.update(setGradient(this.draft, { angle: value }), { delay: PREVIEW_DEBOUNCE_MS }),
    );
    const presets = content.createDiv({ cls: 'mp-ls-swatches', attr: { role: 'group', 'aria-label': t('lockscreen.editor.background.presets') } });
    for (const preset of GRADIENT_PRESETS) {
      const selected =
        preset.from.toLowerCase() === background.from.toLowerCase() &&
        preset.to.toLowerCase() === background.to.toLowerCase() &&
        preset.angle === background.angle;
      const swatch = swatchButton(presets, `${preset.from} → ${preset.to}`, selected);
      swatch.setCssProps({ '--mp-ls-swatch': `linear-gradient(${preset.angle}deg, ${preset.from}, ${preset.to})` });
      swatch.addEventListener('click', () => this.update(setGradient(this.draft, preset), { rerenderSection: true, haptic: 'select' }));
    }
  }

  private async chooseImage(): Promise<void> {
    let path: VaultPath | null = null;
    try {
      path = await this.deps.pickImage();
    } catch (error) {
      console.error('[matrix-planner] image picker failed', error);
    }
    if (!path || this.disposed) return;
    this.update(setImage(this.draft, path), { rerenderSection: true, haptic: 'select' });
  }

  // --- Кадрировщик (п.14) ---

  private canCrop(): boolean {
    return !!this.deps.app;
  }

  private openCrop(): void {
    const app = this.deps.app;
    const background = this.draft.current.background;
    if (!app || background.kind !== 'image' || this.cropOpen || this.disposed) return;
    this.deps.haptic?.('tap');
    const settings = this.settings();
    const profile = this.deps.wallpaper.resolveProfile(settings);
    this.cropImages ??= new BackgroundImageCache(createVaultImageReader(app.vault));
    const images = this.cropImages;
    this.cropOpen = true;
    const path = background.path;
    openCropEditor(
      {
        sheets: this.deps.sheets,
        haptic: (kind) => this.deps.haptic?.(kind),
        acquireImage: (imagePath) => images.acquire(imagePath),
      },
      {
        path,
        crop: background.crop,
        profile,
        cards: layoutCardBoxes(settings, profile, todayOf(this.deps.clock)),
        cardFill: resolvePalette(settings.palette).card,
        clock: this.clockText(),
        widgets: settings.layoutPreset !== 'no-widgets',
        describeError: (error) => backgroundErrorMessage(error),
        onDone: (crop) => {
          const current = this.draft.current.background;
          if (current.kind === 'image' && current.path === path) this.update(setCrop(this.draft, crop), { rerenderSection: this.section === 'background' });
        },
        onClose: () => {
          this.cropOpen = false;
          images.release();
        },
      },
    );
  }

  // --- Выбрать из Фото (I) ---

  private renderPhotoImport(parentEl: HTMLElement): void {
    if (!this.deps.app) return;
    const wrap = parentEl.createDiv({ cls: 'mp-photo-import' });
    const busy = this.photoImportBusy;
    const label = busy ? t('wallpaperPhoto.loading') : Platform.isMobile ? t('wallpaperPhoto.pick') : t('wallpaperPhoto.pickDesktop');
    const button = wrap.createEl('button', {
      cls: 'mp-ls-button mp-photo-import-button',
      attr: { type: 'button', title: t('wallpaperPhoto.pickHint', { folder: photoFolder(this.deps.settings.get().rootFolder) }) },
    });
    setIcon(button.createSpan({ cls: 'mp-photo-import-icon', attr: { 'aria-hidden': 'true' } }), busy ? 'loader' : 'image-plus');
    button.createSpan({ text: label });
    button.toggleClass('is-loading', busy);
    button.setAttr('aria-busy', busy ? 'true' : 'false');
    button.disabled = busy;
    // Синхронно из клика: iOS открывает выбор файла только по жесту пользователя.
    button.addEventListener('click', () => {
      if (this.photoImportBusy || this.disposed) return;
      this.deps.haptic?.('tap');
      this.photoInput().click();
    });

    const issue = this.photoIssue;
    if (!issue || busy) return;
    const box = wrap.createDiv({ cls: `mp-photo-issue is-${issue.kind}`, attr: { role: issue.kind === 'error' ? 'alert' : 'status' } });
    setIcon(box.createSpan({ cls: 'mp-photo-issue-icon', attr: { 'aria-hidden': 'true' } }), issue.kind === 'error' ? 'alert-circle' : 'alert-triangle');
    const text = box.createDiv({ cls: 'mp-photo-issue-text' });
    text.createDiv({ text: issue.message });
    if (issue.kind === 'warning') {
      const actions = text.createDiv({ cls: 'mp-photo-issue-actions' });
      const anyway = actions.createEl('button', { cls: 'mp-ls-button mod-primary', text: t('wallpaperPhoto.useAnyway'), attr: { type: 'button' } });
      anyway.addEventListener('click', () => void this.importPhotoFile(issue.file, true));
      const other = actions.createEl('button', { cls: 'mp-ls-button', text: t('wallpaperPhoto.chooseOther'), attr: { type: 'button' } });
      other.addEventListener('click', () => {
        this.photoIssue = null;
        this.photoInput().click();
      });
    }
  }

  /** Без `capture`: iOS предлагает «Медиатека», «Снять фото», «Выбрать файл». */
  private photoInput(): HTMLInputElement {
    if (this.photoInputEl) return this.photoInputEl;
    const host = this.rootEl ?? activeDocument.body;
    const input = host.createEl('input', {
      cls: 'mp-photo-import-input',
      attr: { type: 'file', accept: 'image/*', tabindex: '-1', 'aria-hidden': 'true' },
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      // Сброс — чтобы то же фото можно было выбрать ещё раз.
      input.value = '';
      if (file) void this.importPhotoFile(file);
    });
    this.photoInputEl = input;
    return input;
  }

  /** Импорт выбранного файла (вызывается и из e2e-проверки с подменённым файлом). */
  async importPhotoFile(file: Blob, allowSmall = false): Promise<PhotoImportResult | null> {
    const app = this.deps.app;
    if (!app || this.photoImportBusy || this.disposed) return null;
    this.photoIssue = null;
    this.setPhotoImportBusy(true);
    let result: PhotoImportResult;
    try {
      result = await importPhoto(file, {
        vault: app.vault,
        guard: this.deps.writeGuard ?? null,
        env: this.deps.photoImportEnv ?? createBrowserPhotoEnv(),
        rootFolder: this.deps.settings.get().rootFolder,
        profile: this.deps.wallpaper.resolveProfile(this.settings()),
        now: this.deps.clock.now(),
        timeZone: this.deps.clock.timeZone(),
        allowSmall,
      });
    } catch (error) {
      result = { ok: false, code: 'write', detail: error instanceof Error ? error.message : String(error) };
    }
    this.photoImportBusy = false;
    if (this.disposed) return result;
    if (!result.ok) {
      const message = photoImportMessage(result);
      if (result.code === 'too-small') {
        this.photoIssue = { kind: 'warning', message, file };
        this.deps.haptic?.('warning');
      } else {
        console.error('[matrix-planner] photo import failed', result);
        this.photoIssue = { kind: 'error', message };
        this.deps.haptic?.('error');
        this.deps.notifier.show(message);
      }
      this.setPhotoImportBusy(false);
      return result;
    }
    // Новый путь — кадрирование по умолчанию; раздел и предпросмотр обновятся.
    const next = setImage(this.draft, result.path);
    this.update(next, { rerenderSection: this.section === 'background' });
    this.deps.haptic?.('success');
    this.deps.notifier.show(t('wallpaperPhoto.loaded'));
    return result;
  }

  private setPhotoImportBusy(busy: boolean): void {
    this.photoImportBusy = busy;
    if (this.section === 'background') this.renderSection();
  }

  private renderPaletteSection(body: HTMLElement): void {
    const list = body.createDiv({ cls: 'mp-ls-options', attr: { role: 'radiogroup', 'aria-label': t('lockscreen.editor.sections.palette') } });
    for (const palette of PALETTES) {
      const option = optionButton(list, this.draft.current.palette === palette);
      const spec = PALETTE_SPECS[palette];
      const swatch = option.createSpan({ cls: 'mp-ls-palette-swatch', attr: { 'aria-hidden': 'true' } });
      swatch.setCssProps({ '--mp-ls-card': spec.card, '--mp-ls-text': spec.text, '--mp-ls-secondary': spec.secondary });
      swatch.createSpan({ cls: 'mp-ls-palette-line' });
      swatch.createSpan({ cls: 'mp-ls-palette-line is-secondary' });
      const text = option.createSpan({ cls: 'mp-ls-option-text' });
      text.createSpan({ cls: 'mp-ls-option-title', text: t(`lockscreen.editor.palette.${palette}`) });
      text.createSpan({ cls: 'mp-ls-option-desc', text: t(`lockscreen.editor.palette.${palette}Desc`) });
      option.addEventListener('click', () => this.update(setPalette(this.draft, palette), { rerenderSection: true, haptic: 'select' }));
    }
  }

  private renderParamsSection(body: HTMLElement): void {
    const current = this.draft.current;
    const settings = this.deps.settings.get();

    // Календари
    new Setting(body).setName(t('lockscreen.editor.params.calendars')).setDesc(t('lockscreen.editor.params.calendarsDesc')).setHeading();
    const calendars = this.deps.calendars?.getCalendars() ?? [];
    if (calendars.length === 0) {
      body.createDiv({ cls: 'mp-ls-hint', text: t('lockscreen.editor.params.calendarsNone') });
    } else {
      new Setting(body).setName(t('lockscreen.editor.params.calendarsAuto')).addToggle((toggle) =>
        toggle.setValue(current.calendarIds === null).onChange((value) => {
          const next = value
            ? useDefaultCalendars(this.draft)
            : useExplicitCalendars(this.draft, settings.visibleCalendars, calendars);
          this.update(next, { rerenderSection: true });
        }),
      );
      const enabled = new Set(effectiveCalendarIds(current.calendarIds, settings.visibleCalendars, calendars));
      for (const calendar of calendars) {
        const row = new Setting(body).setName(calendar.title).addToggle((toggle) =>
          toggle
            .setValue(enabled.has(calendar.calendarId))
            .setDisabled(current.calendarIds === null)
            .onChange((value) =>
              this.update(setCalendarEnabled(this.draft, calendar.calendarId, value, settings.visibleCalendars, calendars), {
                rerenderSection: true,
              }),
            ),
        );
        row.settingEl.addClass('mp-ls-calendar-row');
        const dot = row.nameEl.createSpan({ cls: 'mp-ls-calendar-dot', attr: { 'aria-hidden': 'true' } });
        dot.setCssProps({ '--mp-ls-calendar': calendar.color });
        row.nameEl.prepend(dot);
      }
    }

    // Задачи в квадранте, неделя, профиль
    new Setting(body)
      .setName(t('lockscreen.editor.params.tasksPerQuadrant'))
      .setDesc(t('lockscreen.editor.params.tasksPerQuadrantDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('2', '2')
          .addOption('3', '3')
          .setValue(String(current.tasksPerQuadrant))
          .onChange((value) => this.update(setTasksPerQuadrant(this.draft, Number(value)))),
      );

    new Setting(body).setName(t('lockscreen.editor.params.weekStart')).addDropdown((dropdown) =>
      dropdown
        .addOption('auto', t('lockscreen.editor.params.weekAuto'))
        .addOption('monday', t('lockscreen.editor.params.weekMonday'))
        .addOption('sunday', t('lockscreen.editor.params.weekSunday'))
        .setValue(current.weekStart)
        .onChange((value) => {
          if (value === 'auto' || value === 'monday' || value === 'sunday') this.update(setWeekStart(this.draft, value));
        }),
    );

    const autoProfile = this.autoProfile();
    const profileSetting = new Setting(body)
      .setName(t('lockscreen.editor.params.profile'))
      .setDesc(t('lockscreen.editor.params.profileDesc'))
      .addDropdown((dropdown) => {
        for (const option of profileOptions(current.profile, autoProfile)) {
          let label: string;
          if (option.id === 'auto') {
            label = option.profile
              ? t('lockscreen.editor.params.profileAuto', { profile: option.profile.label })
              : t('lockscreen.editor.params.profileAutoUnknown');
          } else if (option.profile && option.profile.id.startsWith('iphone-')) {
            label = `${option.profile.label} (${option.profile.width} × ${option.profile.height})`;
          } else {
            label = t('lockscreen.editor.params.profileCustom', { id: option.id });
          }
          dropdown.addOption(option.id, label);
        }
        dropdown.setValue(current.profile).onChange((value) => this.update(setProfile(this.draft, value)));
      });
    profileSetting.settingEl.addClass('mp-ls-profile-setting');
    // На компьютере размер монитора не подходит для экрана блокировки.
    if (!Platform.isMobile) body.createDiv({ cls: 'mp-ls-hint mp-ls-profile-hint', text: t('lockscreen.editor.params.profileDesktopHint') });
  }

  private autoProfile(): WallpaperProfile | null {
    try {
      return this.deps.wallpaper.resolveProfile({ ...this.baseSettings(), profile: 'auto' });
    } catch {
      return null;
    }
  }
}

// ===========================================================================
// Мелкие элементы управления
// ===========================================================================

function optionButton(parentEl: HTMLElement, selected: boolean): HTMLButtonElement {
  const button = parentEl.createEl('button', {
    cls: 'mp-ls-option',
    attr: { type: 'button', role: 'radio', 'aria-checked': selected ? 'true' : 'false' },
  });
  button.toggleClass('is-active', selected);
  return button;
}

function swatchButton(parentEl: HTMLElement, label: string, selected: boolean): HTMLButtonElement {
  const button = parentEl.createEl('button', {
    cls: 'mp-ls-swatch',
    attr: { type: 'button', 'aria-label': label, title: label, 'aria-pressed': selected ? 'true' : 'false' },
  });
  button.toggleClass('is-active', selected);
  return button;
}

function colorRow(parentEl: HTMLElement, label: string, value: string, onInput: (color: string) => void): void {
  const row = parentEl.createEl('label', { cls: 'mp-ls-field' });
  row.createSpan({ cls: 'mp-ls-field-label', text: label });
  const input = row.createEl('input', { cls: 'mp-ls-color', attr: { type: 'color' } });
  input.value = value.length === 7 ? value.toLowerCase() : '#000000';
  input.addEventListener('input', () => onInput(input.value));
}

function rangeRow(
  parentEl: HTMLElement,
  label: string,
  options: { min: number; max: number; step: number; value: number; suffix?: string },
  onInput: (value: number) => void,
): void {
  const row = parentEl.createEl('label', { cls: 'mp-ls-field mp-ls-field-range' });
  row.createSpan({ cls: 'mp-ls-field-label', text: label });
  const input = row.createEl('input', {
    cls: 'mp-ls-range',
    attr: { type: 'range', min: String(options.min), max: String(options.max), step: String(options.step) },
  });
  input.value = String(options.value);
  const valueEl = row.createSpan({ cls: 'mp-ls-field-value', text: `${options.value}${options.suffix ?? ''}` });
  input.addEventListener('input', () => {
    const value = Number(input.value);
    valueEl.setText(`${value}${options.suffix ?? ''}`);
    onInput(value);
  });
}
