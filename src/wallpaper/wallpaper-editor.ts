/**
 * Редактор обоев (ТЗ §4.5; кадры 17, 18): лист «Настроить» с предпросмотром
 * и разделами «Шаблон», «Фон», «Палитра», «Параметры».
 *
 * Дата и время iOS — DOM-слой поверх предпросмотра, на PNG не рисуются.
 * Предпросмотр — `WallpaperService.renderPreview` (реализация S2.T7 внедряется сборкой).
 * Изменения живут в черновике (`wallpaper-draft.ts`) до «Готово».
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
import { PALETTE_SPECS } from './layout';
import { renderPhotoButton, type PhotoExporter } from './photo-export';
import { PHOTO_FOLDER_NAME, createBrowserPhotoEnv, importPhoto, photoFolder, type PhotoImportEnv, type PhotoImportResult } from './photo-import';
import {
  BACKGROUND_KINDS,
  CROP_MAX_SCALE,
  CROP_MIN_SCALE,
  GRADIENT_PRESETS,
  PALETTES,
  SOLID_PRESETS,
  TEMPLATE_CATALOG,
  createDraft,
  effectiveCalendarIds,
  isDirty,
  applyDraft,
  panCrop,
  previewSettings,
  profileOptions,
  resetCrop,
  setBackgroundKind,
  setCalendarEnabled,
  setCrop,
  setGradient,
  setImage,
  setPalette,
  setProfile,
  setSolidColor,
  setTasksPerQuadrant,
  setTemplate,
  setWeekStart,
  showsItemTitles,
  useDefaultCalendars,
  useExplicitCalendars,
  zoomCrop,
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
  /** Хранилище для «Выбрать из Фото»; без него кнопки нет. */
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
  /** «Получить фото» (общий с вкладкой: кэш PNG); без него кнопки нет. */
  photo?: PhotoExporter | null;
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
  canvas.parentElement?.setCssProps({ '--mp-ls-aspect': `${profile.width} / ${profile.height}` });
}

/** Подписи макета часов iOS: «суббота, 10 окт.» и «13:32». */
export function clockOverlayText(now: Date, timeZone: string, language: string, hour12: boolean): { date: string; time: string } {
  let date: string;
  try {
    date = new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'short', timeZone }).format(now);
  } catch {
    date = now.toDateString();
  }
  const time = floatingFromDate(now, timeZone).time;
  const [hh, mm] = time.split(':').map(Number);
  // Часы экрана блокировки iOS — без AM/PM.
  const hours = hour12 ? (hh % 12 === 0 ? 12 : hh % 12) : hh;
  return { date, time: `${hour12 ? hours : String(hours).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}

/** Создаёт рамку «телефона» с canvas и (по желанию) макетом часов. */
export function createPhoneFrame(
  parentEl: HTMLElement,
  options: { cls?: string; clock?: { date: string; time: string } | null; label: string },
): { frameEl: HTMLElement; canvas: HTMLCanvasElement } {
  const frameEl = parentEl.createDiv({ cls: ['mp-ls-phone', ...(options.cls ? [options.cls] : [])] });
  const canvas = frameEl.createEl('canvas', { cls: 'mp-ls-canvas', attr: { role: 'img', 'aria-label': options.label } });
  if (options.clock) {
    const overlay = frameEl.createDiv({ cls: 'mp-ls-clock', attr: { 'aria-hidden': 'true' } });
    overlay.createDiv({ cls: 'mp-ls-clock-date', text: options.clock.date });
    overlay.createDiv({ cls: 'mp-ls-clock-time', text: options.clock.time });
  }
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
// Редактор
// ===========================================================================

export function openWallpaperEditor(deps: WallpaperEditorDeps, options: WallpaperEditorOptions = {}): SheetHandle {
  const editor = new WallpaperEditor(deps, options);
  return deps.sheets.open({
    title: t('lockscreen.editor.title'),
    submitLabel: t('lockscreen.editor.submit'),
    fullScreenOnPhone: true,
    render: (contentEl) => editor.render(contentEl),
    onSubmit: () => editor.save(),
    onClose: () => {
      editor.dispose();
      options.onClose?.();
    },
  });
}

class WallpaperEditor {
  private draft: WallpaperDraft;
  private section: EditorSection;
  private rootEl: HTMLElement | null = null;
  private previewFrameEl: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private cropButtonEl: HTMLButtonElement | null = null;
  private sectionTabsEl: HTMLElement | null = null;
  private sectionBodyEl: HTMLElement | null = null;
  private privacyEl: HTMLElement | null = null;
  private photoButtonEl: HTMLButtonElement | null = null;
  /** Скрытый `<input type="file">` для «Выбрать из Фото» (живёт с редактором). */
  private photoInputEl: HTMLInputElement | null = null;
  private photoImportBusy = false;
  private readonly photo: PhotoExporter | null;
  private cropMode = false;
  private previewTimer: number | null = null;
  private previewRunning = false;
  private previewPending = false;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly deps: WallpaperEditorDeps,
    options: WallpaperEditorOptions,
  ) {
    this.draft = createDraft(deps.settings.get().wallpaper);
    if (options.template) this.draft = setTemplate(this.draft, options.template);
    this.section = options.section ?? 'template';
    this.photo = options.photo ?? null;
  }

  render(contentEl: HTMLElement): void {
    const root = contentEl.createDiv({ cls: 'mp-ls-editor' });
    this.rootEl = root;

    const previewWrap = root.createDiv({ cls: 'mp-ls-editor-preview' });
    const format = this.deps.format.get();
    const clock = clockOverlayText(this.deps.clock.now(), this.deps.clock.timeZone(), format.language, format.hour12);
    const { frameEl, canvas } = createPhoneFrame(previewWrap, { cls: 'mp-ls-phone-large', clock, label: t('lockscreen.editor.previewLabel') });
    this.previewFrameEl = frameEl;
    this.canvas = canvas;
    this.attachCropGestures(frameEl);

    const cropBtn = frameEl.createEl('button', { cls: 'mp-icon-button mp-ls-crop-button', attr: { type: 'button' } });
    setIcon(cropBtn, 'crop');
    cropBtn.addEventListener('click', () => this.setCropMode(!this.cropMode));
    this.cropButtonEl = cropBtn;

    const photo = this.photo;
    if (photo) {
      const button = previewWrap.createEl('button', { cls: 'mp-ls-button mp-ls-photo-button', attr: { type: 'button' } });
      button.addEventListener('click', () => this.getPhoto());
      this.photoButtonEl = button;
      this.cleanups.push(photo.onChange(() => this.renderPhotoButton()));
      this.renderPhotoButton();
    }

    const panel = root.createDiv({ cls: 'mp-ls-editor-panel' });
    this.sectionTabsEl = panel.createDiv({ cls: 'mp-ls-sections', attr: { role: 'tablist', 'aria-label': t('lockscreen.editor.sections.label') } });
    this.sectionBodyEl = panel.createDiv({ cls: 'mp-ls-section-body', attr: { role: 'tabpanel' } });
    this.privacyEl = panel.createDiv({ cls: 'mp-ls-privacy', attr: { role: 'note' } });
    setIcon(this.privacyEl.createSpan({ cls: 'mp-ls-privacy-icon', attr: { 'aria-hidden': 'true' } }), 'eye');
    this.privacyEl.createSpan({ text: t('lockscreen.editor.privacy') });

    this.renderSectionTabs();
    this.renderSection();
    this.syncChrome();
    this.schedulePreview(0);
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
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.rootEl = null;
    this.canvas = null;
    this.photoButtonEl = null;
    this.photoInputEl?.remove();
    this.photoInputEl = null;
  }

  // --- Получить фото ---

  private renderPhotoButton(): void {
    if (this.photoButtonEl && this.photo) renderPhotoButton(this.photoButtonEl, this.photo.buttonModel());
  }

  /** Фото — по сохранённым настройкам: несохранённый черновик сначала сохраняется. */
  private getPhoto(): void {
    const photo = this.photo;
    if (!photo) return;
    if (!isDirty(this.draft)) {
      // Синхронно из клика: лист «Поделиться» требует жеста пользователя.
      photo.handleClick();
      return;
    }
    void this.save().then((saved) => {
      if (saved && !this.disposed) photo.handleClick();
    });
  }

  // --- Черновик ---

  private update(next: WallpaperDraft | null, options: { rerenderSection?: boolean; delay?: number } = {}): void {
    if (!next || next === this.draft) return;
    this.draft = next;
    if (options.rerenderSection) this.renderSection();
    this.syncChrome();
    this.schedulePreview(options.delay ?? 0);
  }

  private baseSettings(): WallpaperSettings {
    return this.deps.settings.get().wallpaper;
  }

  /** Кнопка кадрирования и предупреждение зависят от черновика. */
  private syncChrome(): void {
    const isImage = this.draft.current.background.kind === 'image';
    if (!isImage && this.cropMode) this.setCropMode(false);
    if (this.cropButtonEl) {
      this.cropButtonEl.hidden = !isImage;
      const label = this.cropMode ? t('lockscreen.editor.cropDone') : t('lockscreen.editor.crop');
      this.cropButtonEl.setAttr('aria-label', label);
      this.cropButtonEl.setAttr('title', label);
      this.cropButtonEl.setAttr('aria-pressed', this.cropMode ? 'true' : 'false');
      this.cropButtonEl.toggleClass('is-active', this.cropMode);
    }
    if (this.privacyEl) this.privacyEl.hidden = !showsItemTitles(this.draft.current.template);
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
    try {
      const settings = previewSettings(this.baseSettings(), this.draft);
      prepareCanvas(canvas, this.deps.wallpaper.resolveProfile(settings));
      await this.deps.wallpaper.renderPreview(canvas, settings, todayOf(this.deps.clock));
      this.previewFrameEl?.removeClass('is-failed');
    } catch (error) {
      console.error('[matrix-planner] wallpaper preview failed', error);
      this.previewFrameEl?.addClass('is-failed');
      this.previewFrameEl?.setAttr('title', t('lockscreen.editor.previewFailed'));
    } finally {
      this.previewRunning = false;
    }
    if (this.previewPending && !this.disposed) {
      this.previewPending = false;
      void this.renderPreview();
    }
  }

  // --- Кадрирование перетаскиванием ---

  private setCropMode(active: boolean): void {
    this.cropMode = active;
    this.previewFrameEl?.toggleClass('is-cropping', active);
    if (this.previewFrameEl) {
      if (active) this.previewFrameEl.setAttr('title', t('lockscreen.editor.cropHint'));
      else this.previewFrameEl.removeAttribute('title');
    }
    this.syncChrome();
  }

  private attachCropGestures(frameEl: HTMLElement): void {
    let last: { x: number; y: number; id: number } | null = null;
    const down = (evt: PointerEvent): void => {
      if (!this.cropMode || evt.target === this.cropButtonEl || this.cropButtonEl?.contains(evt.target as Node)) return;
      last = { x: evt.clientX, y: evt.clientY, id: evt.pointerId };
      frameEl.setPointerCapture?.(evt.pointerId);
      evt.preventDefault();
    };
    const move = (evt: PointerEvent): void => {
      if (!last || evt.pointerId !== last.id) return;
      const rect = frameEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dx = (evt.clientX - last.x) / rect.width;
      const dy = (evt.clientY - last.y) / rect.height;
      last = { x: evt.clientX, y: evt.clientY, id: evt.pointerId };
      this.update(panCrop(this.draft, dx, dy), { delay: PREVIEW_DEBOUNCE_MS });
    };
    const up = (): void => {
      if (!last) return;
      last = null;
      // Ползунки раздела «Фон» показывают итоговый кадр.
      if (this.section === 'background') this.renderSection();
    };
    const wheel = (evt: WheelEvent): void => {
      if (!this.cropMode) return;
      evt.preventDefault();
      this.update(zoomCrop(this.draft, evt.deltaY < 0 ? 1.05 : 1 / 1.05), { delay: PREVIEW_DEBOUNCE_MS });
    };
    frameEl.addEventListener('pointerdown', down);
    frameEl.addEventListener('pointermove', move);
    frameEl.addEventListener('pointerup', up);
    frameEl.addEventListener('pointercancel', up);
    frameEl.addEventListener('wheel', wheel, { passive: false });
    this.cleanups.push(() => {
      frameEl.removeEventListener('pointerdown', down);
      frameEl.removeEventListener('pointermove', move);
      frameEl.removeEventListener('pointerup', up);
      frameEl.removeEventListener('pointercancel', up);
      frameEl.removeEventListener('wheel', wheel);
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
        attr: { type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false', 'aria-label': label, title: label },
      });
      button.toggleClass('is-active', active);
      setIcon(button.createSpan({ cls: 'mp-ls-section-icon', attr: { 'aria-hidden': 'true' } }), item.icon);
      button.createSpan({ cls: 'mp-ls-section-label', text: label });
      button.addEventListener('click', () => {
        if (this.section === item.id) return;
        this.section = item.id;
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
      option.addEventListener('click', () => this.update(setTemplate(this.draft, info.id), { rerenderSection: true }));
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
          if (next) this.update(next, { rerenderSection: true });
          else void this.chooseImage();
          return;
        }
        this.update(setBackgroundKind(this.draft, kind), { rerenderSection: true });
      });
    }

    const content = body.createDiv({ cls: 'mp-ls-bg-content' });
    if (background.kind === 'image') {
      const row = content.createDiv({ cls: 'mp-ls-image-row' });
      row.createDiv({ cls: 'mp-ls-image-path', text: background.path || t('lockscreen.editor.background.noImage') });
      const choose = row.createEl('button', { cls: 'mp-chip', text: t('lockscreen.editor.background.changeImage'), attr: { type: 'button' } });
      setIcon(choose.createSpan({ attr: { 'aria-hidden': 'true' } }), 'image');
      choose.addEventListener('click', () => void this.chooseImage());
      this.renderPhotoImportButton(row);

      const crop = background.crop;
      rangeRow(content, t('lockscreen.editor.background.offsetX'), { min: 0, max: 100, step: 1, value: Math.round(crop.centerX * 100) }, (value) =>
        this.update(setCrop(this.draft, { centerX: value / 100 }), { delay: PREVIEW_DEBOUNCE_MS }),
      );
      rangeRow(content, t('lockscreen.editor.background.offsetY'), { min: 0, max: 100, step: 1, value: Math.round(crop.centerY * 100) }, (value) =>
        this.update(setCrop(this.draft, { centerY: value / 100 }), { delay: PREVIEW_DEBOUNCE_MS }),
      );
      rangeRow(
        content,
        t('lockscreen.editor.background.scale'),
        { min: CROP_MIN_SCALE * 100, max: CROP_MAX_SCALE * 100, step: 5, value: Math.round(crop.scale * 100) },
        (value) => this.update(setCrop(this.draft, { scale: value / 100 }), { delay: PREVIEW_DEBOUNCE_MS }),
      );
      const reset = content.createEl('button', { cls: 'mp-chip', text: t('lockscreen.editor.background.resetCrop'), attr: { type: 'button' } });
      reset.addEventListener('click', () => this.update(resetCrop(this.draft), { rerenderSection: true }));
      return;
    }

    // Для цвета и градиента — отдельная строка: картинки ещё может не быть.
    this.renderPhotoImportButton(content.createDiv({ cls: 'mp-photo-import-row' }));

    if (background.kind === 'solid') {
      colorRow(content, t('lockscreen.editor.background.color'), background.color, (color) =>
        this.update(setSolidColor(this.draft, color), { delay: PREVIEW_DEBOUNCE_MS }),
      );
      const presets = content.createDiv({ cls: 'mp-ls-swatches', attr: { role: 'group', 'aria-label': t('lockscreen.editor.background.presets') } });
      for (const color of SOLID_PRESETS) {
        const swatch = swatchButton(presets, color, color.toLowerCase() === background.color.toLowerCase());
        swatch.setCssProps({ '--mp-ls-swatch': color });
        swatch.addEventListener('click', () => this.update(setSolidColor(this.draft, color), { rerenderSection: true }));
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
      swatch.addEventListener('click', () => this.update(setGradient(this.draft, preset), { rerenderSection: true }));
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
    this.update(setImage(this.draft, path), { rerenderSection: true });
  }

  // --- Выбрать из Фото ---

  private renderPhotoImportButton(parentEl: HTMLElement): void {
    if (!this.deps.app) return;
    const busy = this.photoImportBusy;
    const label = busy ? t('wallpaperPhoto.loading') : Platform.isMobile ? t('wallpaperPhoto.pick') : t('wallpaperPhoto.pickDesktop');
    const button = parentEl.createEl('button', {
      cls: 'mp-chip mp-photo-import-button',
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

  private async importPhotoFile(file: Blob): Promise<void> {
    const app = this.deps.app;
    if (!app || this.photoImportBusy || this.disposed) return;
    this.setPhotoImportBusy(true);
    let result: PhotoImportResult;
    try {
      result = await importPhoto(file, {
        vault: app.vault,
        guard: this.deps.writeGuard ?? null,
        env: this.deps.photoImportEnv ?? createBrowserPhotoEnv(),
        rootFolder: this.deps.settings.get().rootFolder,
        profile: this.deps.wallpaper.resolveProfile(previewSettings(this.baseSettings(), this.draft)),
        now: this.deps.clock.now(),
        timeZone: this.deps.clock.timeZone(),
      });
    } catch (error) {
      result = { ok: false, code: 'write', detail: error instanceof Error ? error.message : String(error) };
    }
    this.photoImportBusy = false;
    if (this.disposed) return;
    if (!result.ok) {
      console.error('[matrix-planner] photo import failed', result);
      this.deps.haptic?.('error');
      this.deps.notifier.show(photoImportMessage(result));
      this.setPhotoImportBusy(false);
      return;
    }
    // Новый путь — кадрирование по умолчанию; раздел и предпросмотр обновятся.
    const next = setImage(this.draft, result.path);
    if (this.section === 'background') this.update(next, { rerenderSection: true });
    else this.update(next);
    this.deps.haptic?.('success');
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
      option.addEventListener('click', () => this.update(setPalette(this.draft, palette), { rerenderSection: true }));
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
    new Setting(body)
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

/** Текст уведомления об ошибке «Выбрать из Фото». */
function photoImportMessage(result: Exclude<PhotoImportResult, { ok: true }>): string {
  switch (result.code) {
    case 'read-only': {
      const specific = t(result.messageKey);
      return specific !== result.messageKey ? specific : t('wallpaperPhoto.readOnly');
    }
    case 'decode':
      return t('wallpaperPhoto.decodeFailed');
    case 'encode':
      return t('wallpaperPhoto.encodeFailed');
    case 'write':
      return t('wallpaperPhoto.writeFailed', { reason: result.detail });
  }
}

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
  const row = parentEl.createEl('label', { cls: 'mp-ls-field' });
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
