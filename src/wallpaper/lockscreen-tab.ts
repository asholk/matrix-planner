/**
 * Вкладка «Блокировка» (ТЗ §4.5; кадр 16): карточка «Текущий» с миниатюрой,
 * шаблоном, статусом и кнопками «Настроить» / «Обновить экран блокировки»,
 * галерея шаблонов с фильтром «Все / Календарь / Задачи».
 *
 * Миниатюры — `WallpaperService.renderPreview` на сегодня (без макета часов).
 * Статус и действие — `WallpaperStatusTracker`; кнопка обновления вызывает
 * `run()` синхронно в обработчике клика (жест пользователя для `shortcuts://`).
 */

import { setIcon } from 'obsidian';
import type {
  CompanionStore,
  DayItemsProvider,
  PlannerViewHost,
  TabController,
  TabFactory,
} from '../app/contracts';
import { registerDictionary, t } from '../i18n';
import { enLockscreen } from '../i18n/en/lockscreen';
import { ruLockscreen } from '../i18n/ru/lockscreen';
import type { Unsubscribe, WallpaperSettings, WallpaperTemplate } from '../model/types';
import {
  bannerViewModelOf,
  openWallpaperHelp,
  statusNeedsAttention,
  statusTextOf,
  type WallpaperStatusTrackerExt,
} from './update-banner';
import { TEMPLATE_FILTERS, filterTemplates, templateInfo, type TemplateFilter, type TemplateInfo } from './wallpaper-draft';
import {
  clockOverlayText,
  createPhoneFrame,
  openWallpaperEditor,
  prepareCanvas,
  todayOf,
  type WallpaperEditorDeps,
} from './wallpaper-editor';

registerDictionary('ru', 'lockscreen', ruLockscreen);
registerDictionary('en', 'lockscreen', enLockscreen);

/** Задержка перерисовки миниатюр после изменения данных, мс. */
const THUMBNAIL_DEBOUNCE_MS = 400;

export interface LockscreenTabDeps extends WallpaperEditorDeps {
  status: WallpaperStatusTrackerExt;
  /** Изменения статуса обоев в `companion.json` (подтверждение с другого устройства). */
  companion?: Pick<CompanionStore, 'onChange'> | null;
  /** Изменения задач и событий — перерисовать миниатюры. */
  dayItems?: Pick<DayItemsProvider, 'onChange'> | null;
}

/** Фабрика вкладки для `PlannerViewOptions.tabs.lockscreen`. */
export function createLockscreenTab(deps: LockscreenTabDeps): TabFactory {
  return (host) => new LockscreenTab(host, deps);
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

interface Thumbnail {
  canvas: HTMLCanvasElement;
  frameEl: HTMLElement;
  /** Настройки, с которыми рисовать (шаблон галереи поверх текущих). */
  settings(): WallpaperSettings;
}

export class LockscreenTab implements TabController {
  readonly id = 'lockscreen' as const;

  private rootEl: HTMLElement | null = null;
  private currentEl: HTMLElement | null = null;
  private filtersEl: HTMLElement | null = null;
  private galleryEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private updateButtonEl: HTMLButtonElement | null = null;
  private readonly subscriptions: Unsubscribe[] = [];

  private filter: TemplateFilter = 'all';
  private thumbnails: Thumbnail[] = [];
  private shown = false;
  /** Миниатюры устарели, пока вкладка была скрыта. */
  private thumbnailsStale = false;
  private thumbnailTimer: number | null = null;
  /** Поколение отрисовки: новая отрисовка отменяет незавершённую очередь. */
  private generation = 0;
  private editorOpen = false;

  constructor(
    private readonly host: PlannerViewHost,
    private readonly deps: LockscreenTabDeps,
  ) {}

  // --- Жизненный цикл ---

  mount(containerEl: HTMLElement): void {
    this.unmount();
    const root = containerEl.createDiv({ cls: 'mp-ls' });
    this.rootEl = root;

    const header = root.createDiv({ cls: 'mp-ls-header' });
    header.createEl('h2', { cls: 'mp-ls-title', text: t('lockscreen.title') });
    const help = header.createEl('button', {
      cls: 'mp-icon-button mp-ls-help-button',
      attr: { type: 'button', 'aria-label': t('lockscreen.help.button'), title: t('lockscreen.help.button') },
    });
    setIcon(help, 'help-circle');
    help.addEventListener('click', () => this.openHelp());

    this.currentEl = root.createDiv({ cls: 'mp-ls-current' });
    this.filtersEl = root.createDiv({ cls: 'mp-ls-filters', attr: { role: 'radiogroup', 'aria-label': t('lockscreen.filter.label') } });
    this.galleryEl = root.createDiv({ cls: 'mp-ls-gallery' });

    this.subscriptions.push(this.deps.status.onChange(() => this.renderStatus()));
    this.subscriptions.push(
      this.deps.settings.onChange((settings, previous) => {
        if (!sameJson(settings.wallpaper, previous.wallpaper) || !sameJson(settings.visibleCalendars, previous.visibleCalendars)) this.render();
      }),
    );
    const companion = this.deps.companion;
    if (companion) this.subscriptions.push(companion.onChange(() => this.renderStatus()));
    const dayItems = this.deps.dayItems;
    if (dayItems) this.subscriptions.push(dayItems.onChange(() => this.scheduleThumbnails()));

    this.render();
  }

  unmount(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    if (this.thumbnailTimer !== null) window.clearTimeout(this.thumbnailTimer);
    this.thumbnailTimer = null;
    this.generation += 1;
    this.thumbnails = [];
    this.rootEl?.remove();
    this.rootEl = null;
    this.currentEl = null;
    this.filtersEl = null;
    this.galleryEl = null;
    this.statusEl = null;
    this.updateButtonEl = null;
  }

  onShow(): void {
    this.shown = true;
    this.host.setAddContext({ date: null, quadrant: null });
    this.renderStatus();
    // «Сегодня» могло смениться, пока вкладка была скрыта.
    if (this.thumbnailsStale) this.scheduleThumbnails(0);
  }

  onHide(): void {
    this.shown = false;
  }

  // --- Отрисовка ---

  private wallpaper(): WallpaperSettings {
    return this.deps.settings.get().wallpaper;
  }

  private render(): void {
    if (!this.rootEl) return;
    this.thumbnails = [];
    this.renderCurrent();
    this.renderFilters();
    this.renderGallery();
    this.renderStatus();
    this.scheduleThumbnails(0);
  }

  private renderCurrent(): void {
    const el = this.currentEl;
    if (!el) return;
    el.empty();
    const settings = this.wallpaper();
    const info = templateInfo(settings.template);
    const templateName = t(`lockscreen.templates.${info.id}`);

    const top = el.createDiv({ cls: 'mp-ls-current-top' });
    const { frameEl, canvas } = createPhoneFrame(top, {
      cls: 'mp-ls-phone-thumb',
      clock: this.clockText(),
      label: t('lockscreen.current.thumbnail', { template: templateName }),
    });
    frameEl.addEventListener('click', () => this.openEditor());
    this.thumbnails.push({ canvas, frameEl, settings: () => this.wallpaper() });

    const meta = top.createDiv({ cls: 'mp-ls-current-meta' });
    meta.createDiv({ cls: 'mp-ls-eyebrow', text: t('lockscreen.current.label') });
    const name = meta.createDiv({ cls: 'mp-ls-current-template' });
    setIcon(name.createSpan({ cls: 'mp-ls-template-icon', attr: { 'aria-hidden': 'true' } }), info.icon);
    name.createSpan({ text: templateName });
    this.statusEl = meta.createDiv({ cls: 'mp-ls-status', attr: { role: 'status', 'aria-live': 'polite' } });

    const customize = meta.createEl('button', { cls: 'mp-ls-button mod-primary', attr: { type: 'button' } });
    setIcon(customize.createSpan({ cls: 'mp-ls-button-icon', attr: { 'aria-hidden': 'true' } }), 'sliders-horizontal');
    customize.createSpan({ text: t('lockscreen.current.customize') });
    customize.addEventListener('click', () => this.openEditor());

    const update = el.createEl('button', { cls: 'mp-ls-button mp-ls-update', attr: { type: 'button' } });
    update.addEventListener('click', () => this.runUpdate());
    this.updateButtonEl = update;
  }

  private renderStatus(): void {
    const status = this.deps.status;
    if (this.statusEl) {
      this.statusEl.empty();
      this.statusEl.toggleClass('is-attention', statusNeedsAttention(status));
      this.statusEl.createSpan({ cls: 'mp-ls-status-dot', attr: { 'aria-hidden': 'true' } });
      this.statusEl.createSpan({ text: statusTextOf(status) });
    }
    const button = this.updateButtonEl;
    if (button) {
      const model = bannerViewModelOf(status);
      button.empty();
      button.toggleClass('is-busy', model.busy);
      button.setAttr('aria-busy', model.busy ? 'true' : 'false');
      setIcon(button.createSpan({ cls: 'mp-ls-button-icon', attr: { 'aria-hidden': 'true' } }), model.icon);
      button.createSpan({ text: model.title });
    }
  }

  private renderFilters(): void {
    const el = this.filtersEl;
    if (!el) return;
    el.empty();
    for (const filter of TEMPLATE_FILTERS) {
      const active = filter === this.filter;
      const chip = el.createEl('button', {
        cls: 'mp-chip',
        text: t(`lockscreen.filter.${filter}`),
        attr: { type: 'button', role: 'radio', 'aria-checked': active ? 'true' : 'false' },
      });
      chip.toggleClass('is-active', active);
      chip.addEventListener('click', () => {
        if (this.filter === filter) return;
        this.filter = filter;
        this.render();
      });
    }
  }

  private renderGallery(): void {
    const el = this.galleryEl;
    if (!el) return;
    el.empty();
    const items = filterTemplates(this.filter);
    if (items.length === 0) {
      el.createDiv({ cls: 'mp-ls-hint', text: t('lockscreen.templates.empty') });
      return;
    }
    const current = this.wallpaper().template;
    for (const info of items) this.renderGalleryCard(el, info, info.id === current);
  }

  private renderGalleryCard(parentEl: HTMLElement, info: TemplateInfo, selected: boolean): void {
    const name = t(`lockscreen.templates.${info.id}`);
    const card = parentEl.createEl('button', {
      cls: 'mp-ls-gallery-card',
      attr: { type: 'button', 'aria-label': t('lockscreen.templates.choose', { template: name }), 'aria-pressed': selected ? 'true' : 'false' },
    });
    card.toggleClass('is-active', selected);
    const { frameEl, canvas } = createPhoneFrame(card, { cls: 'mp-ls-phone-gallery', clock: this.clockText(), label: name });
    this.thumbnails.push({ canvas, frameEl, settings: () => ({ ...this.wallpaper(), template: info.id }) });
    const caption = card.createDiv({ cls: 'mp-ls-gallery-caption' });
    caption.createDiv({ cls: 'mp-ls-eyebrow', text: t(`lockscreen.templates.category.${info.category}`) });
    const title = caption.createDiv({ cls: 'mp-ls-gallery-title' });
    title.createSpan({ text: name });
    if (selected) {
      const badge = title.createSpan({ cls: 'mp-ls-selected', attr: { 'aria-label': t('lockscreen.templates.current'), title: t('lockscreen.templates.current') } });
      setIcon(badge, 'check');
    }
    card.addEventListener('click', () => this.openEditor(info.id));
  }

  private clockText(): { date: string; time: string } {
    const format = this.deps.format.get();
    return clockOverlayText(this.deps.clock.now(), this.deps.clock.timeZone(), format.language, format.hour12);
  }

  // --- Миниатюры ---

  private scheduleThumbnails(delay = THUMBNAIL_DEBOUNCE_MS): void {
    if (!this.rootEl) return;
    if (!this.shown && delay > 0) {
      this.thumbnailsStale = true;
      return;
    }
    if (this.thumbnailTimer !== null) window.clearTimeout(this.thumbnailTimer);
    this.thumbnailTimer = window.setTimeout(() => {
      this.thumbnailTimer = null;
      void this.renderThumbnails();
    }, delay);
  }

  /** Последовательно, чтобы не держать несколько больших canvas в работе одновременно. */
  private async renderThumbnails(): Promise<void> {
    const generation = ++this.generation;
    this.thumbnailsStale = false;
    const date = todayOf(this.deps.clock);
    for (const thumb of [...this.thumbnails]) {
      if (generation !== this.generation) return;
      try {
        const settings = thumb.settings();
        prepareCanvas(thumb.canvas, this.deps.wallpaper.resolveProfile(settings));
        await this.deps.wallpaper.renderPreview(thumb.canvas, settings, date);
        thumb.frameEl.removeClass('is-failed');
      } catch (error) {
        console.error('[matrix-planner] wallpaper thumbnail failed', error);
        thumb.frameEl.addClass('is-failed');
      }
    }
  }

  // --- Действия ---

  /** Синхронно из клика: трекер открывает быструю команду до первого `await`. */
  private runUpdate(): void {
    if (this.deps.status.getState().kind === 'rendering') return;
    void this.deps.status.run();
  }

  private openEditor(template?: WallpaperTemplate): void {
    if (this.editorOpen) return;
    this.editorOpen = true;
    openWallpaperEditor(this.deps, {
      template,
      onClose: () => {
        this.editorOpen = false;
      },
    });
  }

  private openHelp(): void {
    const settings = this.wallpaper();
    let profileId = settings.profile;
    try {
      profileId = this.deps.wallpaper.resolveProfile(settings).id;
    } catch {
      // Остаётся значение из настроек.
    }
    openWallpaperHelp(this.deps.sheets, {
      actionKind: this.deps.status.getActionKind(),
      profileId,
      shortcutName: settings.shortcutName,
    });
  }
}
