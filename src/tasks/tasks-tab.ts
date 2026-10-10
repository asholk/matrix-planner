/**
 * Вкладка «Задачи» (ТЗ §4.2; кадры 01, 07, 08): приветствие, фильтр «Выполнено N»,
 * переключатель «Сетка / Список», матрица 2 × 2 и списки, меню и перенос карточек.
 * Данные — `NoteIndex` (подписка на изменения), действия — `TaskService` и `PlannerActions`.
 */

import { Menu, setIcon } from 'obsidian';
import type {
  Clock,
  FormatPreferencesProvider,
  NoteIndex,
  Notifier,
  PlannerViewHost,
  SettingsStore,
  TabController,
  TabFactory,
  TaskService,
} from '../app/contracts';
import type {
  FloatingDateTime,
  LocalDateString,
  LocalTimeString,
  OpResult,
  QuadrantKey,
  TasksLayout,
  TasksListGrouping,
  Unsubscribe,
} from '../model/types';
import {
  createDateLabelStrings,
  floatingFromDate,
  formatDateLabel,
  formatDueLabel,
  formatTimeLabel,
  parseDateParts,
  type DateLabelStrings,
} from '../model/dates';
import { interpolate, registerDictionary, t, tPlural } from '../i18n';
import { ruTasks } from '../i18n/ru/tasks';
import { enTasks } from '../i18n/en/tasks';
import { ruModel } from '../i18n/ru/model';
import { enModel } from '../i18n/en/model';
import {
  QUADRANT_CSS_VARS,
  buildTaskMenu,
  buildTasksView,
  errorMessageKey,
  greetingFor,
  quadrantColorOverrides,
  type DateSection,
  type QuadrantSection,
  type TaskCardModel,
  type TaskLabelFormat,
  type TaskMenuAction,
  type TasksMode,
  type TasksViewModel,
} from './tasks-presenter';
import { renderTaskCard, type TaskCardHandlers } from './task-card';
import {
  CardGesture,
  isHighlightedZone,
  resolveDrop,
  startDrag,
  updateDrag,
  type DragSession,
  type DropZone,
  type GestureEffect,
  type PointerKind,
} from './task-drag';

registerDictionary('ru', 'tasks', ruTasks);
registerDictionary('en', 'tasks', enTasks);
// Подписи дат (`formatDueLabel`) берутся из словаря модели.
registerDictionary('ru', 'model', ruModel);
registerDictionary('en', 'model', enModel);

/** Длительность анимации выполнения перед записью, мс. */
const COMPLETE_ANIMATION_MS = 260;
/** Повторное меню (долгое нажатие + `contextmenu` на Android) в этом окне игнорируется. */
const MENU_DEBOUNCE_MS = 700;

export interface TasksTabDeps {
  index: NoteIndex;
  tasks: TaskService;
  settings: SettingsStore;
  clock: Clock;
  format: FormatPreferencesProvider;
  notifier: Notifier;
}

/** Фабрика вкладки для `PlannerViewOptions.tabs.tasks`. */
export function createTasksTab(deps: TasksTabDeps): TabFactory {
  return (host) => new TasksTab(host, deps);
}

interface ActiveDrag {
  session: DragSession;
  cardEl: HTMLElement;
  ghost: HTMLElement | null;
  offsetX: number;
  offsetY: number;
  zones: DropZone[];
  zoneEls: Map<QuadrantKey, HTMLElement>;
}

export class TasksTab implements TabController {
  readonly id = 'tasks' as const;

  private rootEl: HTMLElement | null = null;
  private greetingEl: HTMLElement | null = null;
  private controlsEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  private readonly subscriptions: Unsubscribe[] = [];

  private mode: TasksMode = 'active';
  private model: TasksViewModel | null = null;
  private renderTimer: number | null = null;
  /** Изменения пришли во время перетаскивания — перерисовать после него. */
  private renderPending = false;
  /** Карточки с идущей операцией (ключ карточки). */
  private readonly busy = new Set<string>();

  private readonly gesture = new CardGesture();
  private gestureCard: { card: TaskCardModel; cardEl: HTMLElement } | null = null;
  private gestureCleanup: (() => void) | null = null;
  private longPressTimer: number | null = null;
  private drag: ActiveDrag | null = null;
  private lastMenuAt = 0;

  constructor(
    private readonly host: PlannerViewHost,
    private readonly deps: TasksTabDeps,
  ) {}

  // --- Жизненный цикл ---

  mount(containerEl: HTMLElement): void {
    this.unmount();
    const root = containerEl.createDiv({ cls: 'mp-tasks' });
    this.rootEl = root;

    const header = root.createDiv({ cls: 'mp-tasks-header' });
    this.greetingEl = header.createEl('h2', { cls: 'mp-tasks-greeting' });
    header.createDiv({ cls: 'mp-tasks-subtitle', text: t('tasks.subtitle') });

    this.controlsEl = root.createDiv({ cls: 'mp-tasks-controls', attr: { role: 'toolbar', 'aria-label': t('tasks.controls.label') } });
    this.contentEl = root.createDiv({ cls: 'mp-tasks-content' });

    this.subscriptions.push(this.deps.index.onChange(() => this.scheduleRender()));
    this.subscriptions.push(this.deps.settings.onChange(() => this.scheduleRender()));

    if (this.deps.index.isReady()) {
      this.render();
    } else {
      this.contentEl.createDiv({ cls: 'mp-tasks-loading', text: t('tasks.loading') });
      this.renderHeader();
      void this.deps.index.whenReady().then(() => {
        if (this.rootEl === root) this.render();
      });
    }
  }

  unmount(): void {
    this.cancelGesture();
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.rootEl?.remove();
    this.rootEl = null;
    this.greetingEl = null;
    this.controlsEl = null;
    this.contentEl = null;
    this.model = null;
  }

  onShow(): void {
    this.host.setAddContext({ date: null, quadrant: null });
    // Приветствие и «Сегодня» могли устареть, пока вкладка была скрыта.
    if (this.rootEl && this.deps.index.isReady()) this.render();
  }

  onHide(): void {
    this.cancelGesture();
  }

  // --- Отрисовка ---

  private scheduleRender(): void {
    if (!this.rootEl) return;
    if (this.drag) {
      this.renderPending = true;
      return;
    }
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 0);
  }

  private now(): FloatingDateTime {
    return floatingFromDate(this.deps.clock.now(), this.deps.clock.timeZone());
  }

  private layout(): TasksLayout {
    return this.deps.settings.get().ui.tasksLayout;
  }

  private grouping(): TasksListGrouping {
    return this.deps.settings.get().ui.tasksListGrouping;
  }

  private labelFormat(): { format: TaskLabelFormat; strings: DateLabelStrings } {
    const strings = createDateLabelStrings((key) => t(key));
    const hour12 = this.deps.format.get().hour12;
    const format: TaskLabelFormat = {
      due: (due, today) => formatDueLabel(due, today, strings, { hour12 }),
      completed: (date, time) => formatCompletedLabel(date, time, strings, hour12),
    };
    return { format, strings };
  }

  private render(): void {
    if (!this.rootEl || !this.contentEl) return;
    if (this.drag) {
      this.renderPending = true;
      return;
    }
    const now = this.now();
    const { format, strings } = this.labelFormat();
    const matrix = this.deps.index.getMatrix();
    this.applyQuadrantColors(quadrantColorOverrides(matrix));
    this.model = buildTasksView({
      tasks: this.deps.index.getTasks(),
      matrix,
      now,
      mode: this.mode,
      layout: this.layout(),
      grouping: this.grouping(),
      format,
    });
    this.renderHeader(now);
    this.renderControls(this.model);
    this.renderContent(this.model, strings);
  }

  private applyQuadrantColors(vars: Record<string, string>): void {
    const root = this.rootEl;
    if (!root) return;
    for (const name of QUADRANT_CSS_VARS) {
      if (vars[name]) root.style.setProperty(name, vars[name]);
      else root.style.removeProperty(name);
    }
  }

  private renderHeader(now: FloatingDateTime = this.now()): void {
    if (!this.greetingEl) return;
    const hour = Number((now.time ?? '12:00').slice(0, 2));
    this.greetingEl.setText(t(`tasks.greeting.${greetingFor(hour)}`));
  }

  private renderControls(model: TasksViewModel): void {
    const el = this.controlsEl;
    if (!el) return;
    el.empty();
    const row = el.createDiv({ cls: 'mp-tasks-controls-row' });

    // Фильтр «Выполнено N».
    const doneActive = model.mode === 'done';
    const doneChip = row.createEl('button', {
      cls: 'mp-chip mp-tasks-done-filter',
      attr: {
        type: 'button',
        'aria-pressed': doneActive ? 'true' : 'false',
        'aria-label': doneActive ? t('tasks.controls.doneClose') : t('tasks.controls.doneCount', { count: model.doneCount }),
      },
    });
    doneChip.toggleClass('is-active', doneActive);
    setIcon(doneChip.createSpan({ cls: 'mp-tasks-done-icon', attr: { 'aria-hidden': 'true' } }), doneActive ? 'x' : 'circle-check');
    doneChip.createSpan({ cls: 'mp-tasks-done-label', text: t('tasks.controls.done') });
    if (!doneActive) doneChip.createSpan({ cls: 'mp-tasks-done-count', text: String(model.doneCount) });
    doneChip.addEventListener('click', () => {
      this.mode = this.mode === 'done' ? 'active' : 'done';
      this.render();
      this.controlsEl?.querySelector<HTMLElement>('.mp-tasks-done-filter')?.focus();
    });

    // «Сетка / Список».
    const layoutGroup = row.createDiv({ cls: 'mp-segmented mp-tasks-layout', attr: { role: 'group', 'aria-label': t('tasks.controls.label') } });
    this.segmentButton(layoutGroup, 'layout-grid', t('tasks.controls.grid'), model.layout === 'grid', () => this.setLayout('grid'));
    this.segmentButton(layoutGroup, 'list', t('tasks.controls.list'), model.layout === 'list', () => this.setLayout('list'));

    // Группировка списка.
    if (model.layout === 'list') {
      const groupRow = el.createDiv({ cls: 'mp-tasks-grouping', attr: { role: 'group', 'aria-label': t('tasks.controls.list') } });
      const chip = (grouping: TasksListGrouping, label: string): void => {
        const button = groupRow.createEl('button', {
          cls: 'mp-chip',
          text: label,
          attr: { type: 'button', 'aria-pressed': model.grouping === grouping ? 'true' : 'false' },
        });
        button.toggleClass('is-active', model.grouping === grouping);
        button.addEventListener('click', () => this.setGrouping(grouping));
      };
      chip('quadrant', t('tasks.controls.byQuadrant'));
      chip('date', t('tasks.controls.byDate'));
    }
  }

  private segmentButton(parent: HTMLElement, icon: string, label: string, active: boolean, onClick: () => void): void {
    const button = parent.createEl('button', {
      cls: 'mp-segment',
      attr: { type: 'button', 'aria-label': label, title: label, 'aria-pressed': active ? 'true' : 'false' },
    });
    button.toggleClass('is-active', active);
    setIcon(button, icon);
    button.addEventListener('click', onClick);
  }

  private setLayout(layout: TasksLayout): void {
    if (this.layout() === layout) return;
    void this.deps.settings.update((draft) => {
      draft.ui.tasksLayout = layout;
    });
  }

  private setGrouping(grouping: TasksListGrouping): void {
    if (this.grouping() === grouping) return;
    void this.deps.settings.update((draft) => {
      draft.ui.tasksListGrouping = grouping;
    });
  }

  private renderContent(model: TasksViewModel, strings: DateLabelStrings): void {
    const content = this.contentEl;
    if (!content) return;
    // Сохраняем прокрутку и фокус: перерисовка не должна сбивать пользователя.
    const panel = this.rootEl?.parentElement ?? null;
    const panelScroll = panel?.scrollTop ?? 0;
    const listScroll = new Map<string, number>();
    content.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((el) => {
      listScroll.set(el.dataset.scrollKey ?? '', el.scrollTop);
    });
    const focus = this.captureFocus();

    content.empty();
    content.setAttr('data-layout', model.layout);
    content.setAttr('data-mode', model.mode);

    if (model.layout === 'grid') this.renderGrid(content, model);
    else if (model.grouping === 'quadrant') this.renderQuadrantList(content, model);
    else this.renderDateList(content, model, strings);

    content.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((el) => {
      const top = listScroll.get(el.dataset.scrollKey ?? '');
      if (top) el.scrollTop = top;
    });
    if (panel) panel.scrollTop = panelScroll;
    this.restoreFocus(focus);
  }

  private renderGrid(parent: HTMLElement, model: TasksViewModel): void {
    const grid = parent.createDiv({ cls: 'mp-matrix' });
    for (const section of model.quadrants) {
      const el = grid.createEl('section', {
        cls: ['mp-quadrant', `mp-q-${section.key}`],
        attr: { 'data-quadrant': section.key, 'aria-label': section.title },
      });
      this.renderQuadrantHeader(el, section, model.mode);
      const list = el.createDiv({ cls: 'mp-quadrant-list', attr: { role: 'list', 'data-scroll-key': section.key } });
      if (section.cards.length === 0) this.renderEmpty(list, model.mode);
      for (const card of section.cards) this.renderCard(list, card, model, false);
    }
  }

  private renderQuadrantList(parent: HTMLElement, model: TasksViewModel): void {
    const wrap = parent.createDiv({ cls: 'mp-tasks-list' });
    for (const section of model.quadrants) {
      const el = wrap.createEl('section', {
        cls: ['mp-list-section', `mp-q-${section.key}`],
        attr: { 'data-quadrant': section.key, 'aria-label': section.title },
      });
      this.renderQuadrantHeader(el, section, model.mode);
      const list = el.createDiv({ cls: 'mp-list-section-cards', attr: { role: 'list' } });
      if (section.cards.length === 0) this.renderEmpty(list, model.mode);
      for (const card of section.cards) this.renderCard(list, card, model, false);
    }
  }

  private renderDateList(parent: HTMLElement, model: TasksViewModel, strings: DateLabelStrings): void {
    const wrap = parent.createDiv({ cls: 'mp-tasks-list' });
    if (model.dates.length === 0) {
      const empty = wrap.createDiv({ cls: 'mp-tasks-empty mp-tasks-empty-list' });
      setIcon(empty.createSpan({ cls: 'mp-tasks-empty-icon', attr: { 'aria-hidden': 'true' } }), 'circle-check');
      empty.createSpan({ text: t(model.mode === 'done' ? 'tasks.emptyDoneList' : 'tasks.emptyList') });
      return;
    }
    for (const section of model.dates) {
      const el = wrap.createEl('section', { cls: ['mp-list-section', 'mp-date-section', `mp-date-${section.kind}`] });
      const title = dateSectionTitle(section, model.today, strings);
      const header = el.createDiv({ cls: 'mp-list-section-header' });
      header.createEl('h3', { cls: 'mp-list-section-title', text: title });
      header.createSpan({ cls: 'mp-quadrant-count', text: String(section.cards.length), attr: { 'aria-hidden': 'true' } });
      el.setAttr('aria-label', `${title}, ${tPlural('tasks.quadrant.count', section.cards.length)}`);
      const list = el.createDiv({ cls: 'mp-list-section-cards', attr: { role: 'list' } });
      for (const card of section.cards) this.renderCard(list, card, model, true);
    }
  }

  private renderQuadrantHeader(parent: HTMLElement, section: QuadrantSection, mode: TasksMode): void {
    const header = parent.createDiv({ cls: 'mp-quadrant-header' });
    setIcon(header.createSpan({ cls: 'mp-quadrant-icon', attr: { 'aria-hidden': 'true' } }), section.icon);
    header.createEl('h3', { cls: 'mp-quadrant-title', text: section.title });
    header.createSpan({
      cls: 'mp-quadrant-count',
      text: String(section.count),
      attr: { 'aria-label': tPlural('tasks.quadrant.count', section.count) },
    });
    if (mode !== 'active') return;
    const label = t('tasks.quadrant.add', { quadrant: section.title });
    const add = header.createEl('button', { cls: 'mp-quadrant-add', attr: { type: 'button', 'aria-label': label, title: label } });
    setIcon(add, 'plus');
    add.addEventListener('click', (evt) => this.addToQuadrant(section.key, evt));
  }

  private renderEmpty(parent: HTMLElement, mode: TasksMode): void {
    const empty = parent.createDiv({ cls: 'mp-tasks-empty', attr: { role: 'listitem' } });
    if (mode === 'done') setIcon(empty.createSpan({ cls: 'mp-tasks-empty-icon', attr: { 'aria-hidden': 'true' } }), 'circle-check');
    empty.createSpan({ text: t(mode === 'done' ? 'tasks.emptyDone' : 'tasks.empty') });
  }

  private renderCard(parent: HTMLElement, card: TaskCardModel, model: TasksViewModel, byDate: boolean): void {
    const quadrant = model.quadrants.find((section) => section.key === card.quadrant);
    renderTaskCard(
      parent,
      card,
      {
        quadrantTitle: quadrant?.title ?? card.quadrant,
        showHandle: this.host.platform.isMobile && this.canDrag(model),
        showQuadrantDot: byDate,
        busy: this.busy.has(card.key),
      },
      this.cardHandlers(),
    );
  }

  /** Перенос между квадрантами — только в активном режиме, где квадранты видны. */
  private canDrag(model: TasksViewModel | null): boolean {
    if (!model || model.mode !== 'active') return false;
    return model.layout === 'grid' || model.grouping === 'quadrant';
  }

  private captureFocus(): { key: string; role: string } | null {
    const active = this.rootEl?.doc.activeElement as HTMLElement | null | undefined;
    const cardEl = active?.closest?.<HTMLElement>('[data-card-key]');
    if (!active || !cardEl || !this.contentEl?.contains(cardEl)) return null;
    return { key: cardEl.dataset.cardKey ?? '', role: active.dataset.role ?? 'main' };
  }

  private restoreFocus(focus: { key: string; role: string } | null): void {
    if (!focus || !this.contentEl) return;
    const cards = this.contentEl.querySelectorAll<HTMLElement>('[data-card-key]');
    for (const cardEl of Array.from(cards)) {
      if (cardEl.dataset.cardKey !== focus.key) continue;
      const target = cardEl.querySelector<HTMLElement>(`[data-role="${focus.role}"]`) ?? cardEl.querySelector<HTMLElement>('[data-role="main"]');
      target?.focus({ preventScroll: true });
      return;
    }
  }

  // --- Действия ---

  private cardHandlers(): TaskCardHandlers {
    return {
      onToggle: (card, cardEl) => this.toggleCard(card, cardEl),
      onOpen: (card) => this.host.actions.openTaskForm({ mode: 'edit', id: card.taskId }),
      onMenu: (card, anchor) => this.openMenu(card, anchor),
      onPointerDown: (card, evt, cardEl, onHandle) => this.onPointerDown(card, evt, cardEl, onHandle),
      consumeClick: () => this.gesture.consumesClick(),
    };
  }

  private addToQuadrant(quadrant: QuadrantKey, evt: MouseEvent): void {
    const context = { date: null, quadrant };
    this.host.setAddContext(context);
    if (this.host.actions.isAvailable('task')) this.host.actions.openTaskForm({ mode: 'create', quadrant, date: null });
    else this.host.actions.openAddMenu(context, evt);
    // Общая «+» снова без квадранта.
    this.host.setAddContext({ date: null, quadrant: null });
  }

  private toggleCard(card: TaskCardModel, cardEl: HTMLElement): void {
    if (this.busy.has(card.key)) return;
    if (card.done) {
      void this.runOp(card, () => this.deps.tasks.uncomplete(card.taskId, card.instanceDate ?? undefined));
      return;
    }
    this.busy.add(card.key);
    cardEl.addClass('is-completing');
    cardEl.querySelector('.mp-task-check')?.setAttr('aria-pressed', 'true');
    if (this.host.platform.isAndroid) {
      try {
        navigator.vibrate?.(15);
      } catch {
        // Вибрация необязательна.
      }
    }
    window.setTimeout(() => {
      this.busy.delete(card.key);
      void this.runOp(card, () => this.deps.tasks.complete(card.taskId)).then((ok) => {
        if (!ok) cardEl.removeClass('is-completing');
      });
    }, COMPLETE_ANIMATION_MS);
  }

  /** Выполняет операцию, показывает ошибку. Возвращает успех. */
  private async runOp(card: TaskCardModel | null, op: () => Promise<OpResult<unknown>>, successMessage?: string): Promise<boolean> {
    if (card) this.busy.add(card.key);
    try {
      const result = await op();
      if (!result.ok) {
        this.deps.notifier.show(t(errorMessageKey(result.error)));
        if (result.error.detail) console.warn('[matrix-planner] task operation failed', result.error);
        return false;
      }
      if (successMessage && result.changed) this.deps.notifier.show(successMessage);
      return true;
    } catch (error) {
      console.error('[matrix-planner] task operation failed', error);
      this.deps.notifier.show(t('common.errors.unknown'));
      return false;
    } finally {
      if (card) this.busy.delete(card.key);
    }
  }

  private openMenu(card: TaskCardModel, anchor: MouseEvent | HTMLElement): void {
    const nowMs = Date.now();
    if (nowMs - this.lastMenuAt < MENU_DEBOUNCE_MS) return;
    this.lastMenuAt = nowMs;

    const matrix = this.deps.index.getMatrix();
    const menu = new Menu();
    for (const item of buildTaskMenu(card, matrix)) {
      const title = item.labelParams ? interpolate(t(item.labelKey), item.labelParams) : t(item.labelKey);
      menu.addItem((menuItem) => {
        menuItem
          .setTitle(title)
          .setIcon(item.icon)
          .setSection(item.section)
          .setWarning(item.warning)
          .onClick(() => this.runMenuAction(card, item.action));
      });
    }
    if (isMouseEvent(anchor) && (anchor.clientX !== 0 || anchor.clientY !== 0)) {
      menu.showAtMouseEvent(anchor);
      return;
    }
    const target = isMouseEvent(anchor) ? (anchor.currentTarget as HTMLElement | null) : anchor;
    if (target) {
      const rect = target.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom }, target.doc);
    } else {
      menu.showAtPosition({ x: 0, y: 0 });
    }
  }

  private runMenuAction(card: TaskCardModel, action: TaskMenuAction): void {
    const { tasks, index } = this.deps;
    switch (action.kind) {
      case 'open-note':
        void this.host.actions.openNote(card.path);
        return;
      case 'move': {
        const title = index.getMatrix().byKey[action.quadrant]?.title ?? action.quadrant;
        void this.runOp(card, () => tasks.moveToQuadrant(card.taskId, action.quadrant), t('tasks.notices.moved', { quadrant: title }));
        return;
      }
      case 'postpone':
        void this.runOp(card, () => tasks.postponeToTomorrow(card.taskId));
        return;
      case 'uncomplete':
        void this.runOp(card, () => tasks.uncomplete(card.taskId, card.instanceDate ?? undefined));
        return;
      case 'delete':
        void this.runOp(card, () => tasks.delete(card.taskId), t('tasks.notices.deleted'));
        return;
    }
  }

  // --- Жесты: долгое нажатие и перетаскивание ---

  private onPointerDown(card: TaskCardModel, evt: PointerEvent, cardEl: HTMLElement, onHandle: boolean): void {
    if (this.drag || this.busy.has(card.key)) return;
    const pointerType = toPointerKind(evt.pointerType);
    const dragAllowed = this.canDrag(this.model);
    // Мышь без возможности переноса: жест не нужен (меню — по ПКМ).
    if (pointerType === 'mouse' && !dragAllowed) return;
    const target = evt.target as HTMLElement | null;
    const onControl = Boolean(target?.closest?.('.mp-task-check, .mp-task-more'));
    this.cancelGesture();
    const effect = this.gesture.down({
      x: evt.clientX,
      y: evt.clientY,
      time: evt.timeStamp,
      pointerType,
      button: evt.button,
      onHandle: onHandle && dragAllowed,
      onControl,
    });
    if (this.gesture.getPhase() === 'idle') return;
    this.gestureCard = { card, cardEl };
    if (onHandle && dragAllowed) {
      // За маркер тянем сразу, без прокрутки страницы.
      evt.preventDefault();
      try {
        (target ?? cardEl).setPointerCapture(evt.pointerId);
      } catch {
        // Захват необязателен.
      }
    }

    const doc = cardEl.doc;
    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== evt.pointerId) return;
      const result = this.gesture.move({ x: e.clientX, y: e.clientY, time: e.timeStamp });
      if (result.type === 'drag-move' || result.type === 'drag-start') e.preventDefault();
      this.applyEffect(result);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== evt.pointerId) return;
      this.applyEffect(this.gesture.up({ x: e.clientX, y: e.clientY, time: e.timeStamp }));
      this.finishGesture();
    };
    const onCancel = (e: PointerEvent): void => {
      if (e.pointerId !== evt.pointerId) return;
      this.cancelGesture();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.cancelGesture();
    };
    // Перетаскивание за маркер на iOS требует отмены `touchmove`, иначе прокручивается панель.
    const onTouchMove = (e: TouchEvent): void => {
      if (this.drag) e.preventDefault();
    };
    doc.addEventListener('pointermove', onMove, { passive: false });
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onCancel);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('touchmove', onTouchMove, { passive: false });
    this.gestureCleanup = () => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('pointercancel', onCancel);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('touchmove', onTouchMove);
    };
    this.applyEffect(effect);
  }

  private applyEffect(effect: GestureEffect): void {
    const current = this.gestureCard;
    switch (effect.type) {
      case 'none':
        return;
      case 'schedule-long-press':
        this.clearLongPress();
        this.longPressTimer = window.setTimeout(() => {
          this.longPressTimer = null;
          this.applyEffect(this.gesture.timeout());
        }, effect.delayMs);
        return;
      case 'long-press':
        this.clearLongPress();
        if (!current) return;
        if (this.host.platform.isAndroid) {
          try {
            navigator.vibrate?.(10);
          } catch {
            // Вибрация необязательна.
          }
        }
        this.openMenu(current.card, current.cardEl);
        return;
      case 'drag-start':
        this.clearLongPress();
        if (current) this.beginDrag(current.card, current.cardEl, effect.x, effect.y);
        return;
      case 'drag-move':
        this.moveDrag(effect.x, effect.y);
        return;
      case 'drop':
        this.endDrag(true);
        return;
      case 'cancel':
        this.clearLongPress();
        if (effect.wasDragging) this.endDrag(false);
        return;
    }
  }

  private beginDrag(card: TaskCardModel, cardEl: HTMLElement, x: number, y: number): void {
    const root = this.rootEl;
    if (!root) return;
    const zoneEls = new Map<QuadrantKey, HTMLElement>();
    const zones: DropZone[] = [];
    root.querySelectorAll<HTMLElement>('[data-quadrant]').forEach((el) => {
      const key = el.dataset.quadrant as QuadrantKey | undefined;
      if (!key) return;
      const rect = el.getBoundingClientRect();
      zoneEls.set(key, el);
      zones.push({ quadrant: key, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } });
    });
    const rect = cardEl.getBoundingClientRect();
    const ghost = cardEl.cloneNode(true) as HTMLElement;
    ghost.addClass('mp-task-drag-ghost');
    ghost.setAttr('aria-hidden', 'true');
    ghost.style.width = `${rect.width}px`;
    cardEl.doc.body.appendChild(ghost);
    // Переменные цветов матрицы нужны и призраку вне вкладки.
    for (const name of QUADRANT_CSS_VARS) {
      const value = root.style.getPropertyValue(name);
      if (value) ghost.style.setProperty(name, value);
    }
    cardEl.addClass('is-dragging');
    root.addClass('is-dragging');
    this.drag = {
      session: startDrag(card.taskId, card.quadrant),
      cardEl,
      ghost,
      offsetX: x - rect.left,
      offsetY: y - rect.top,
      zones,
      zoneEls,
    };
    this.moveDrag(x, y);
  }

  private moveDrag(x: number, y: number): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.ghost) drag.ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`;
    const next = updateDrag(drag.session, drag.zones, x, y);
    if (next === drag.session) return;
    drag.session = next;
    for (const [key, el] of drag.zoneEls) el.toggleClass('is-drop-target', isHighlightedZone(next, key));
  }

  private endDrag(commit: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    drag.ghost?.remove();
    drag.cardEl.removeClass('is-dragging');
    this.rootEl?.removeClass('is-dragging');
    for (const el of drag.zoneEls.values()) el.removeClass('is-drop-target');
    const drop = commit ? resolveDrop(drag.session) : null;
    if (drop) {
      const card = this.gestureCard?.card ?? null;
      void this.runOp(card, () => this.deps.tasks.moveToQuadrant(drop.taskId, drop.quadrant));
    }
    if (this.renderPending) {
      this.renderPending = false;
      this.scheduleRender();
    }
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private finishGesture(): void {
    this.clearLongPress();
    this.gestureCleanup?.();
    this.gestureCleanup = null;
    this.gestureCard = null;
  }

  private cancelGesture(): void {
    this.applyEffect(this.gesture.cancel());
    this.endDrag(false);
    this.finishGesture();
  }
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

function isMouseEvent(value: unknown): value is MouseEvent {
  return typeof MouseEvent !== 'undefined' && value instanceof MouseEvent;
}

function toPointerKind(type: string): PointerKind {
  return type === 'touch' || type === 'pen' ? type : 'mouse';
}

/** «10 окт. 2026, 13:31» — дата выполнения всегда с годом. */
function formatCompletedLabel(date: LocalDateString, time: LocalTimeString | null, strings: DateLabelStrings, hour12: boolean): string {
  const parts = parseDateParts(date);
  const dateText = parts
    ? interpolate(strings.dayMonthYear, { day: parts.day, month: strings.monthsShort[parts.month - 1] ?? String(parts.month), year: parts.year })
    : date;
  if (time === null) return dateText;
  return t('tasks.card.completedAt', { date: dateText, time: formatTimeLabel(time, hour12, strings) });
}

function dateSectionTitle(section: DateSection, today: LocalDateString, strings: DateLabelStrings): string {
  if (section.kind === 'overdue') return t('tasks.groups.overdue');
  if (section.kind === 'no-date' || !section.date) return t('tasks.groups.noDate');
  return formatDateLabel(section.date, today, strings);
}
