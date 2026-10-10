/**
 * Вид «Планировщик» (S1.T4, ТЗ §4.1): единственный `ItemView` с нижней панелью
 * вкладок «Задачи / Календарь / Блокировка / Настройки», местом для баннера над панелью
 * и плавающей «+» над баннером справа. Вкладки и баннер подключаются фабриками
 * из `PlannerViewOptions`; состояние — чистый модуль `view-state`.
 *
 * Док (панель вкладок, баннер, «+») плавает над содержимым и поднимается над нижними
 * панелями Obsidian (плавающая навигация 1.11+ на телефоне), см. `dock-insets`.
 */

import { ItemView, setIcon } from 'obsidian';
import type { ViewStateResult, WorkspaceLeaf } from 'obsidian';
import type {
  AddContext,
  BannerController,
  PlannerActions,
  PlannerViewHost,
  PlannerViewOptions,
  PlatformInfo,
  TabController,
} from '../app/contracts';
import type { LocalDateString, PlannerTabId } from '../model/types';
import { registerDictionary, t } from '../i18n';
import { ruShell } from '../i18n/ru/shell';
import { enShell } from '../i18n/en/shell';
import {
  PLANNER_TAB_ORDER,
  SPLIT_MIN_WIDTH,
  adjacentTab,
  createViewState,
  getAddContext,
  navigationKeyFor,
  requestFocus,
  restoreViewState,
  serializeViewState,
  setAddContext,
  setWidth,
  switchTab,
  takePendingFocus,
  visibleTabs,
} from './view-state';
import type { PlannerViewState } from './view-state';
import { OBSIDIAN_BOTTOM_BAR_SELECTORS, findBottomBars, measureBottomOverlap } from './dock-insets';

registerDictionary('ru', 'shell', ruShell);
registerDictionary('en', 'shell', enShell);

export const VIEW_TYPE_PLANNER = 'matrix-planner';

const TAB_ICONS: Record<PlannerTabId, string> = {
  tasks: 'layout-grid',
  calendar: 'calendar-days',
  lockscreen: 'lock',
  settings: 'settings',
};

/** Расширение опций вида (локально, без изменения контракта). */
export interface PlannerShellOptions extends PlannerViewOptions {
  /**
   * Хук широкой раскладки: с этой ширины «Задачи» и «Календарь» стоят рядом.
   * `null` — выключено; по умолчанию 900 px (ТЗ §7.1).
   */
  splitMinWidth?: number | null;
}

interface TabSlot {
  id: PlannerTabId;
  buttonEl: HTMLButtonElement;
  panelEl: HTMLElement;
  controller: TabController | null;
  mounted: boolean;
  shown: boolean;
}

export class PlannerView extends ItemView {
  private state: PlannerViewState;
  private readonly slots = new Map<PlannerTabId, TabSlot>();
  private readonly cleanups: Array<() => void> = [];
  private banner: BannerController | null = null;
  private rootEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private dockEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Наблюдение за размерами нижних панелей Obsidian. */
  private barObserver: ResizeObserver | null = null;
  private readonly observedBars = new Set<Element>();
  private insetsFrame: number | null = null;
  private opened = false;
  /** Уникальность id элементов при нескольких открытых видах. */
  private readonly key = Math.random().toString(36).slice(2, 8);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly options: PlannerShellOptions,
  ) {
    super(leaf);
    const available = PLANNER_TAB_ORDER.filter((tab) => Boolean(options.tabs[tab]));
    this.state = createViewState({ available, initialTab: options.initialTab });
  }

  getViewType(): string {
    return VIEW_TYPE_PLANNER;
  }

  getDisplayText(): string {
    return t('common.viewTitle');
  }

  getIcon(): string {
    return 'layout-grid';
  }

  get actions(): PlannerActions {
    return this.options.actions;
  }

  get platform(): PlatformInfo {
    return this.options.platform;
  }

  getActiveTab(): PlannerTabId {
    return this.state.activeTab;
  }

  /** Контекст «+» активной вкладки. */
  getAddContext(): AddContext {
    return getAddContext(this.state);
  }

  /** Переключение вкладки из команды или ссылки, при необходимости — с датой. */
  showTab(tab: PlannerTabId, options: { date?: LocalDateString } = {}): void {
    this.applyState(requestFocus(this.state, tab, options));
  }

  switchTab(tab: PlannerTabId): void {
    this.applyState(switchTab(this.state, tab));
  }

  // --- Жизненный цикл ItemView ---

  async onOpen(): Promise<void> {
    this.opened = true;
    this.build();
    this.observeSize();
    this.render();
  }

  async onClose(): Promise<void> {
    this.opened = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.barObserver?.disconnect();
    this.barObserver = null;
    this.observedBars.clear();
    if (this.insetsFrame !== null) {
      const win = this.rootEl?.win;
      win?.cancelAnimationFrame?.(this.insetsFrame);
      this.insetsFrame = null;
    }
    for (const slot of this.slots.values()) this.unmountSlot(slot);
    this.slots.clear();
    if (this.banner) {
      try {
        this.banner.unmount();
      } catch (error) {
        console.error('[matrix-planner] banner unmount failed', error);
      }
      this.banner = null;
    }
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        console.error('[matrix-planner] view cleanup failed', error);
      }
    }
    this.contentEl.empty();
    this.rootEl = null;
    this.bodyEl = null;
    this.dockEl = null;
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), ...serializeViewState(this.state) };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.applyState(restoreViewState(this.state, state));
    await super.setState(state, result);
  }

  // --- Построение DOM ---

  private build(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass('mp-view-container');
    const root = container.createDiv({ cls: 'mp-view' });
    root.toggleClass('is-mobile', this.platform.isMobile);
    root.toggleClass('is-phone', this.platform.isPhone);
    root.toggleClass('is-ios', this.platform.isIos);
    this.rootEl = root;

    const body = root.createDiv({ cls: 'mp-view-body' });
    this.bodyEl = body;

    const dock = root.createDiv({ cls: 'mp-view-dock' });
    this.dockEl = dock;
    const fabRow = dock.createDiv({ cls: 'mp-fab-row' });
    const fab = fabRow.createEl('button', {
      cls: 'mp-fab',
      attr: { type: 'button', 'aria-label': t('shell.add.button'), title: t('shell.add.button'), 'aria-haspopup': 'dialog' },
    });
    setIcon(fab, 'plus');
    fab.addEventListener('click', (evt) => this.actions.openAddMenu(this.getAddContext(), evt));

    const bannerSlot = dock.createDiv({ cls: 'mp-banner-slot' });
    this.mountBanner(bannerSlot);

    const tabBar = dock.createDiv({
      cls: 'mp-tabbar',
      attr: { role: 'tablist', 'aria-label': t('shell.tabBar'), 'aria-orientation': 'horizontal' },
    });
    for (const id of PLANNER_TAB_ORDER) this.buildTab(id, tabBar, body);
    tabBar.addEventListener('keydown', (evt) => this.onTabKey(evt));
  }

  private buildTab(id: PlannerTabId, tabBar: HTMLElement, body: HTMLElement): void {
    const available = this.state.available.includes(id);
    const tabId = `mp-tab-${id}-${this.key}`;
    const panelId = `mp-panel-${id}-${this.key}`;
    const label = t(`common.tabs.${id}`);
    const buttonEl = tabBar.createEl('button', {
      cls: `mp-tab mp-tab-${id}`,
      attr: { type: 'button', role: 'tab', id: tabId, 'aria-controls': panelId },
    });
    setIcon(buttonEl.createSpan({ cls: 'mp-tab-icon', attr: { 'aria-hidden': 'true' } }), TAB_ICONS[id]);
    buttonEl.createSpan({ cls: 'mp-tab-label', text: label });
    if (!available) {
      buttonEl.addClass('is-disabled');
      buttonEl.setAttr('aria-disabled', 'true');
      buttonEl.setAttr('title', t('shell.tabUnavailable'));
    }
    buttonEl.addEventListener('click', () => {
      if (available) this.switchTab(id);
    });

    const panelEl = body.createDiv({
      cls: `mp-panel mp-panel-${id}`,
      attr: { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId },
    });
    panelEl.hidden = true;
    // В двух колонках активной становится колонка, с которой работает пользователь.
    const activate = (): void => {
      if (this.state.split && this.state.activeTab !== id && available) this.switchTab(id);
    };
    panelEl.addEventListener('pointerdown', activate);
    panelEl.addEventListener('focusin', activate);

    this.slots.set(id, { id, buttonEl, panelEl, controller: null, mounted: false, shown: false });
  }

  private mountBanner(slotEl: HTMLElement): void {
    const factory = this.options.banner;
    if (!factory) return;
    try {
      this.banner = factory(this.createHost(null));
      this.banner.mount(slotEl);
    } catch (error) {
      console.error('[matrix-planner] banner mount failed', error);
      this.banner = null;
      slotEl.empty();
    }
  }

  private onTabKey(evt: KeyboardEvent): void {
    const direction = navigationKeyFor(evt.key);
    if (!direction) return;
    evt.preventDefault();
    const target = adjacentTab(this.state, this.state.activeTab, direction);
    this.switchTab(target);
    this.slots.get(target)?.buttonEl.focus();
  }

  private observeSize(): void {
    const update = (): void => this.updateLayout();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(update);
      this.resizeObserver.observe(this.contentEl);
      if (this.dockEl) this.resizeObserver.observe(this.dockEl);
      this.barObserver = new ResizeObserver(() => this.scheduleInsets());
    }
    // Окно, клавиатура и панели Obsidian меняют перекрытие без изменения размеров вида.
    const win = this.rootEl?.win;
    if (win && typeof win.addEventListener === 'function') {
      this.registerDomEvent(win, 'resize', update);
      const viewport = win.visualViewport;
      if (viewport) {
        const onViewport = (): void => this.scheduleInsets();
        viewport.addEventListener('resize', onViewport);
        viewport.addEventListener('scroll', onViewport);
        this.register(() => {
          viewport.removeEventListener('resize', onViewport);
          viewport.removeEventListener('scroll', onViewport);
        });
      }
      const doc = win.document;
      const onBarMotion = (evt: Event): void => {
        const target = evt.target as Element | null;
        if (!target || typeof target.closest !== 'function' || this.rootEl?.contains(target)) return;
        if (target.closest(OBSIDIAN_BOTTOM_BAR_SELECTORS)) this.scheduleInsets();
      };
      this.registerDomEvent(doc, 'transitionend', onBarMotion, { capture: true });
      this.registerDomEvent(doc, 'animationend', onBarMotion, { capture: true });
    }
    this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleInsets()));
    this.registerEvent(this.app.workspace.on('resize', () => this.scheduleInsets()));
    update();
  }

  private updateLayout(): void {
    const root = this.rootEl;
    if (!root) return;
    const minWidth = this.options.splitMinWidth === undefined ? SPLIT_MIN_WIDTH : this.options.splitMinWidth;
    const width = this.contentEl.clientWidth;
    // Нулевая ширина — вид скрыт (фоновая вкладка): раскладку не меняем.
    if (width > 0) this.applyState(setWidth(this.state, width, minWidth));
    this.updateInsets();
  }

  /** Пересчёт отступов дока не чаще раза за кадр. */
  private scheduleInsets(): void {
    const root = this.rootEl;
    if (!root || this.insetsFrame !== null) return;
    const win = root.win as Window | undefined;
    if (typeof win?.requestAnimationFrame !== 'function') {
      this.updateInsets();
      return;
    }
    this.insetsFrame = win.requestAnimationFrame(() => {
      this.insetsFrame = null;
      this.updateInsets();
    });
  }

  /**
   * Док поднимается на перекрытие нижними панелями Obsidian; без них — на safe-area,
   * если вид доходит до нижнего края экрана. Панели вкладок получают отступ снизу
   * на высоту дока, чтобы последние элементы не прятались под ним.
   */
  private updateInsets(): void {
    const root = this.rootEl;
    if (!root || typeof root.getBoundingClientRect !== 'function') return;
    let overlap = 0;
    try {
      overlap = measureBottomOverlap(root, { probe: this.platform.isMobile });
    } catch (error) {
      console.error('[matrix-planner] cannot measure bottom bars', error);
    }
    const rect = root.getBoundingClientRect();
    const win = root.win;
    const atBottom = rect.height > 0 && win.innerHeight > 0 && rect.bottom >= win.innerHeight - 1;
    root.toggleClass('mp-at-screen-bottom', atBottom && overlap === 0);
    root.toggleClass('has-bottom-overlap', overlap > 0);
    const dockRect = this.dockEl && typeof this.dockEl.getBoundingClientRect === 'function' ? this.dockEl.getBoundingClientRect() : null;
    root.setCssProps({
      '--mp-bottom-overlap': `${overlap}px`,
      '--mp-view-top': `${Math.max(0, Math.round(rect.top))}px`,
      '--mp-dock-height': `${Math.ceil(dockRect?.height ?? 0)}px`,
    });
    this.observeBars(root);
  }

  /** Следит за размерами найденных нижних панелей (появление, скрытие, смена высоты). */
  private observeBars(root: HTMLElement): void {
    const observer = this.barObserver;
    const doc = root.ownerDocument as Document | null | undefined;
    if (!observer) return;
    findBottomBars(doc).forEach((el) => {
      if (this.observedBars.has(el)) return;
      this.observedBars.add(el);
      observer.observe(el);
    });
  }

  // --- Состояние и отрисовка ---

  private applyState(next: PlannerViewState): void {
    const prevTab = this.state.activeTab;
    this.state = next;
    if (!this.opened || !this.rootEl) return;
    this.render();
    if (prevTab !== next.activeTab) this.options.onTabChange?.(next.activeTab);
  }

  private render(): void {
    const root = this.rootEl;
    if (!root) return;
    root.toggleClass('is-split', this.state.split);
    root.setAttr('data-active-tab', this.state.activeTab);
    const visible = visibleTabs(this.state);
    for (const slot of this.slots.values()) {
      const active = slot.id === this.state.activeTab;
      slot.buttonEl.toggleClass('is-active', active);
      slot.buttonEl.setAttr('aria-selected', active ? 'true' : 'false');
      slot.buttonEl.setAttr('tabindex', active ? '0' : '-1');
      if (active) slot.buttonEl.setAttr('aria-current', 'page');
      else slot.buttonEl.removeAttribute('aria-current');
      slot.panelEl.toggleClass('is-active', active);
      if (visible.includes(slot.id)) this.showSlot(slot);
      else this.hideSlot(slot);
    }
    this.deliverPendingFocus();
    this.scheduleInsets();
  }

  private showSlot(slot: TabSlot): void {
    slot.panelEl.hidden = false;
    if (!slot.mounted) this.mountSlot(slot);
    if (!slot.shown) {
      slot.shown = true;
      this.safe(() => slot.controller?.onShow?.(), 'onShow');
    }
  }

  private hideSlot(slot: TabSlot): void {
    slot.panelEl.hidden = true;
    if (slot.shown) {
      slot.shown = false;
      this.safe(() => slot.controller?.onHide?.(), 'onHide');
    }
  }

  private mountSlot(slot: TabSlot): void {
    slot.mounted = true;
    const factory = this.options.tabs[slot.id];
    slot.panelEl.empty();
    if (!factory) {
      slot.panelEl.createDiv({ cls: 'mp-panel-empty', text: t('shell.tabUnavailable') });
      return;
    }
    try {
      slot.controller ??= factory(this.createHost(slot.id));
      slot.controller.mount(slot.panelEl);
    } catch (error) {
      console.error(`[matrix-planner] tab "${slot.id}" mount failed`, error);
      slot.controller = null;
      slot.panelEl.empty();
      slot.panelEl.createDiv({ cls: 'mp-panel-empty mod-warning', text: t('shell.tabFailed') });
    }
  }

  private unmountSlot(slot: TabSlot): void {
    if (slot.shown) this.safe(() => slot.controller?.onHide?.(), 'onHide');
    if (slot.mounted) this.safe(() => slot.controller?.unmount(), 'unmount');
    slot.shown = false;
    slot.mounted = false;
    slot.panelEl.empty();
  }

  /** Передаёт отложенный `focus` смонтированным видимым вкладкам. */
  private deliverPendingFocus(): void {
    for (const id of visibleTabs(this.state)) {
      const slot = this.slots.get(id);
      if (!slot?.controller || !slot.mounted) continue;
      const [next, request] = takePendingFocus(this.state, id);
      if (!request) continue;
      this.state = next;
      const controller = slot.controller;
      this.safe(() => controller.focus?.(request), 'focus');
    }
  }

  private safe(fn: () => void, what: string): void {
    try {
      fn();
    } catch (error) {
      console.error(`[matrix-planner] tab ${what} failed`, error);
    }
  }

  /** Хост для вкладки: контекст «+» хранится отдельно для каждой вкладки. */
  private createHost(owner: PlannerTabId | null): PlannerViewHost {
    return {
      actions: this.options.actions,
      platform: this.options.platform,
      getActiveTab: () => this.state.activeTab,
      switchTab: (tab) => this.switchTab(tab),
      setAddContext: (context) => {
        this.state = setAddContext(this.state, owner ?? this.state.activeTab, context);
      },
      getAddContext: () => getAddContext(this.state, owner ?? this.state.activeTab),
      register: (cleanup) => {
        this.cleanups.push(cleanup);
      },
    };
  }
}
