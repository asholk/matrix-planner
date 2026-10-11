/**
 * Вкладка «Задачи» (ТЗ §4.2; кадры 01, 07, 08): шапка с датой, погодой и серией «🔥 N», фильтр «Выполнено N»,
 * переключатель «Сетка / Список», матрица 2 × 2 и списки, меню и перенос карточек.
 * Данные — `NoteIndex` (подписка на изменения), действия — `TaskService` и `PlannerActions`.
 *
 * Доработка 005: выполнение — галочка, зачёркивание и сворачивание карточки (~600 мс); долгое
 * нажатие пальцем поднимает карточку для переноса между квадрантами, над «+» появляется зона
 * удаления (удаление откладывается на 5 с, в уведомлении — «Вернуть»). Меню — только ПКМ,
 * клавиатура и скрытая кнопка «Действия» для диктора. Пустой квадрант — «⊕ Нажмите, чтобы добавить».
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
import { ruWeather } from '../i18n/ru/weather';
import { enWeather } from '../i18n/en/weather';
import { ruStats } from '../i18n/ru/stats';
import { enStats } from '../i18n/en/stats';
import { completionEntries } from '../model/task-selectors';
import { computeStreak } from '../stats/stats';
import { conditionKey, formatWeatherLine, weatherCondition } from '../weather/weather-format';
import type { WeatherProvider } from '../weather/weather-types';
import {
  QUADRANT_CSS_VARS,
  buildTasksView,
  errorMessageKey,
  formatTodayTitle,
  quadrantColorOverrides,
  type DateSection,
  type QuadrantSection,
  type TaskCardModel,
  type TaskLabelFormat,
  type TasksMode,
  type TasksViewModel,
} from './tasks-presenter';
import { renderTaskCard, type TaskCardHandlers } from './task-card';
import {
  CardGesture,
  TASK_DRAG_GESTURE_OPTIONS,
  deleteZoneRect,
  isHighlightedZone,
  resolveDrop,
  startDrag,
  updateDrag,
  type DragSession,
  type DropZone,
  type GestureEffect,
  type Rect,
} from './task-drag';
import { DeferredDeletes, UNDO_DELETE_MS } from './deferred-delete';
import { addTaskMenuItems } from './task-menu';
import { MENU_DEBOUNCE_MS, isTouchContextMenu, showMenuAt, toPointerKind } from '../ui/controls/context-menu';

registerDictionary('ru', 'tasks', ruTasks);
registerDictionary('en', 'tasks', enTasks);
registerDictionary('ru', 'weather', ruWeather);
registerDictionary('en', 'weather', enWeather);
registerDictionary('ru', 'stats', ruStats);
registerDictionary('en', 'stats', enStats);
// Подписи дат (`formatDueLabel`) берутся из словаря `model`; его регистрирует сборка (app/compose-core).

/** Длительность анимации выполнения (галочка → зачёркивание → сворачивание) перед записью, мс. */
export const COMPLETE_ANIMATION_MS = 600;
/** Размер зоны «Перетащите сюда, чтобы удалить», px. */
const DELETE_ZONE = { width: 300, height: 52, gap: 12 };
/** Проверка устаревания (срок наступил, полночь, погода), пока вкладка показана, мс. */
export const TASKS_REFRESH_INTERVAL_MS = 60_000;

export interface TasksTabDeps {
  index: NoteIndex;
  tasks: TaskService;
  settings: SettingsStore;
  clock: Clock;
  format: FormatPreferencesProvider;
  notifier: Notifier;
  /** Погода в шапке; без неё строка не показывается. */
  weather?: WeatherProvider;
  /** Открыть «Статистику» (таблетка серии); без него таблетки нет. */
  openStats?: () => void;
}

/** Фабрика вкладки для `PlannerViewOptions.tabs.tasks`. */
export function createTasksTab(deps: TasksTabDeps): TabFactory {
  return (host) => new TasksTab(host, deps);
}

interface ActiveDrag {
  session: DragSession;
  card: TaskCardModel;
  cardEl: HTMLElement;
  ghost: HTMLElement | null;
  offsetX: number;
  offsetY: number;
  zones: DropZone[];
  zoneEls: Map<QuadrantKey, HTMLElement>;
  deleteEl: HTMLElement | null;
  deleteRect: Rect | null;
}

/** Пользователь просил меньше движения: анимация выполнения без задержки. */
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export class TasksTab implements TabController {
  readonly id = 'tasks' as const;

  private rootEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private weatherEl: HTMLElement | null = null;
  private streakEl: HTMLElement | null = null;
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

  private readonly gesture = new CardGesture(TASK_DRAG_GESTURE_OPTIONS);
  /** Палец (перо) нажат на карточке: системное `contextmenu` не открывает меню. */
  private touchDown = false;
  /** Задачи, брошенные в зону удаления: скрыты, в корзину уходят через 5 с без «Вернуть». */
  private readonly pendingDeletes = new DeferredDeletes();
  private gestureCard: { card: TaskCardModel; cardEl: HTMLElement } | null = null;
  private gestureCleanup: (() => void) | null = null;
  private longPressTimer: number | null = null;
  private drag: ActiveDrag | null = null;
  private lastMenuAt = 0;
  /** Вкладка показана (между `onShow` и `onHide`). */
  private shown = false;
  private refreshTimer: number | null = null;
  private visibilityCleanup: (() => void) | null = null;
  /** Снимок того, что зависит от времени: при изменении — перерисовка. */
  private timeKey = '';

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
    const heading = header.createDiv({ cls: 'mp-tasks-heading' });
    this.titleEl = heading.createEl('h2', { cls: 'mp-tasks-title' });
    this.weatherEl = heading.createDiv({ cls: 'mp-tasks-weather' });
    if (this.deps.openStats) {
      const openStats = this.deps.openStats;
      const streak = header.createEl('button', { cls: 'mp-tasks-streak', attr: { type: 'button' } });
      setIcon(streak.createSpan({ cls: 'mp-tasks-streak-icon', attr: { 'aria-hidden': 'true' } }), 'flame');
      streak.createSpan({ cls: 'mp-tasks-streak-count' });
      streak.addEventListener('click', () => openStats());
      this.streakEl = streak;
    }

    this.controlsEl = root.createDiv({ cls: 'mp-tasks-controls', attr: { role: 'toolbar', 'aria-label': t('tasks.controls.label') } });
    this.contentEl = root.createDiv({ cls: 'mp-tasks-content' });

    this.subscriptions.push(this.deps.index.onChange(() => this.scheduleRender()));
    this.subscriptions.push(this.deps.settings.onChange(() => this.scheduleRender()));
    if (this.deps.weather) this.subscriptions.push(this.deps.weather.onChange(() => this.renderWeather()));
    this.watchVisibility();

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
    // Закрытие вида не отменяет удаление: выполняем отложенные сразу.
    this.pendingDeletes.flush();
    this.stopRefresh();
    this.visibilityCleanup?.();
    this.visibilityCleanup = null;
    this.shown = false;
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.rootEl?.remove();
    this.rootEl = null;
    this.titleEl = null;
    this.weatherEl = null;
    this.streakEl = null;
    this.controlsEl = null;
    this.contentEl = null;
    this.model = null;
  }

  onShow(): void {
    this.host.setAddContext({ date: null, quadrant: null });
    this.shown = true;
    this.startRefresh();
    // Дата и «Сегодня» могли устареть, пока вкладка была скрыта.
    if (this.rootEl && this.deps.index.isReady()) this.render();
    this.refreshWeather();
  }

  onHide(): void {
    this.cancelGesture();
    this.shown = false;
    this.stopRefresh();
  }

  // --- Обновление по времени ---

  private startRefresh(): void {
    this.stopRefresh();
    if (!this.rootEl) return;
    this.refreshTimer = window.setInterval(() => this.refreshIfStale(), TASKS_REFRESH_INTERVAL_MS);
  }

  private stopRefresh(): void {
    if (this.refreshTimer === null) return;
    window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** Возврат приложения из фона: таймеры могли стоять — проверяем сразу. */
  private watchVisibility(): void {
    if (typeof document === 'undefined') return;
    const doc = document;
    const onVisibility = (): void => {
      if (doc.visibilityState !== 'visible') {
        this.stopRefresh();
        return;
      }
      if (!this.shown) return;
      this.refreshIfStale();
      this.startRefresh();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    this.visibilityCleanup = () => doc.removeEventListener('visibilitychange', onVisibility);
  }

  /** Перерисовывает, только если изменилось зависящее от времени (без лишней пересборки DOM). */
  private refreshIfStale(): void {
    // Погода: запрос уходит, только если кэш устарел или сменились сутки.
    this.refreshWeather();
    if (!this.rootEl || !this.deps.index.isReady()) return;
    if (this.timeKeyFor(this.now()) !== this.timeKey) this.scheduleRender();
  }

  private timeKeyFor(now: FloatingDateTime): string {
    const { format } = this.labelFormat();
    const model = buildTasksView({
      tasks: this.visibleTasks(),
      matrix: this.deps.index.getMatrix(),
      now,
      mode: this.mode,
      layout: this.layout(),
      grouping: this.grouping(),
      format,
    });
    return `${now.date}|${JSON.stringify(model)}`;
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

  /** Задачи индекса без ожидающих удаления. */
  private visibleTasks(): ReturnType<NoteIndex['getTasks']> {
    const tasks = this.deps.index.getTasks();
    if (this.pendingDeletes.size === 0) return tasks;
    return tasks.filter((task) => !this.pendingDeletes.has(task.id));
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
      tasks: this.visibleTasks(),
      matrix,
      now,
      mode: this.mode,
      layout: this.layout(),
      grouping: this.grouping(),
      format,
    });
    this.timeKey = `${now.date}|${JSON.stringify(this.model)}`;
    this.renderHeader();
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

  private renderHeader(): void {
    if (!this.titleEl) return;
    const now = this.now();
    const year = Number(now.date.slice(0, 4));
    this.titleEl.setText(formatTodayTitle(now.date, this.deps.format.get().language, year));
    this.renderWeather();
    this.renderStreak(now.date);
  }

  /** «☁️ +11°, облачно · ↓7° ↑12°»; при ошибке — «Погода недоступна», только если город задан явно. */
  private renderWeather(): void {
    const el = this.weatherEl;
    if (!el) return;
    const state = this.deps.weather?.getState() ?? { kind: 'off' as const };
    let text: string | null = null;
    if (state.kind === 'ready') {
      text = formatWeatherLine(state.snapshot, t(conditionKey(weatherCondition(state.snapshot.code))));
    } else if (state.kind === 'error' && this.deps.settings.get().weather.city !== '') {
      text = t('weather.unavailable');
    }
    el.setText(text ?? '');
    el.toggleClass('is-hidden', text === null);
    if (text === null) el.removeAttribute('aria-label');
    else el.setAttr('aria-label', t('weather.label', { value: text }));
  }

  private renderStreak(today: LocalDateString): void {
    const el = this.streakEl;
    if (!el) return;
    const dates = completionEntries(this.deps.index.getTasks()).map((entry) => entry.date);
    const streak = computeStreak(dates, today);
    el.querySelector('.mp-tasks-streak-count')?.setText(String(streak));
    const label = tPlural('stats.streak.pill', streak);
    el.setAttr('aria-label', label);
    el.setAttr('title', label);
  }

  private refreshWeather(): void {
    if (!this.shown || !this.deps.weather) return;
    void this.deps.weather.refresh().catch((error: unknown) => console.warn('[matrix-planner] weather refresh failed', error));
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
    // Число выполненных — только в подписи для диктора (в референсе таблетка без числа).
    doneChip.createSpan({ cls: 'mp-tasks-done-label', text: t('tasks.controls.done') });
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
      if (section.cards.length === 0) this.renderEmpty(list, model.mode, section);
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
      if (section.cards.length === 0) this.renderEmpty(list, model.mode, section);
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

  /** Пустой квадрант: «⊕ Нажмите, чтобы добавить» (кадр 02); в «Выполнено» — прежний текст. */
  private renderEmpty(parent: HTMLElement, mode: TasksMode, section: QuadrantSection): void {
    const empty = parent.createDiv({ cls: 'mp-tasks-empty', attr: { role: 'listitem' } });
    if (mode !== 'active') {
      setIcon(empty.createSpan({ cls: 'mp-tasks-empty-icon', attr: { 'aria-hidden': 'true' } }), 'circle-check');
      empty.createSpan({ text: t('tasks.emptyDone') });
      return;
    }
    const button = empty.createEl('button', {
      cls: 'mp-tasks-empty-add',
      attr: { type: 'button', 'aria-label': t('tasks.quadrant.add', { quadrant: section.title }) },
    });
    setIcon(button.createSpan({ cls: 'mp-tasks-empty-icon', attr: { 'aria-hidden': 'true' } }), 'circle-plus');
    button.createSpan({ cls: 'mp-tasks-empty-label', text: t('tasks.emptyAdd') });
    button.addEventListener('click', (evt) => this.addToQuadrant(section.key, evt));
  }

  private renderCard(parent: HTMLElement, card: TaskCardModel, model: TasksViewModel, byDate: boolean): void {
    const quadrant = model.quadrants.find((section) => section.key === card.quadrant);
    renderTaskCard(
      parent,
      card,
      {
        quadrantTitle: quadrant?.title ?? card.quadrant,
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
      onContextMenu: (card, evt) => {
        // Долгое нажатие пальцем — перетаскивание, не меню (Android присылает `contextmenu`).
        if (this.touchDown || this.drag || isTouchContextMenu(evt)) return;
        this.openMenu(card, evt);
      },
      onPointerDown: (card, evt, cardEl) => this.onPointerDown(card, evt, cardEl),
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
    // Высота для сворачивания карточки в конце анимации.
    const height = cardEl.getBoundingClientRect().height;
    if (height > 0) cardEl.style.setProperty('--mp-card-height', `${height}px`);
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
      void this.runOp(card, () => this.deps.tasks.complete(card.taskId, card.instanceDate ?? undefined)).then((ok) => {
        if (!ok) cardEl.removeClass('is-completing');
      });
    }, prefersReducedMotion() ? 0 : COMPLETE_ANIMATION_MS);
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

    const menu = new Menu();
    addTaskMenuItems(menu, card, {
      tasks: this.deps.tasks,
      matrix: () => this.deps.index.getMatrix(),
      openNote: (path) => void this.host.actions.openNote(path),
      run: (op, successMessage) => void this.runOp(card, op, successMessage),
    });
    showMenuAt(menu, anchor);
  }

  // --- Жесты: долгое нажатие и перетаскивание ---

  private onPointerDown(card: TaskCardModel, evt: PointerEvent, cardEl: HTMLElement): void {
    if (this.drag || this.busy.has(card.key)) return;
    // Перенос — только в активном режиме с квадрантами; иначе жест не нужен (меню — ПКМ и клавиатура).
    if (!this.canDrag(this.model)) return;
    const pointerType = toPointerKind(evt.pointerType);
    const target = evt.target as HTMLElement | null;
    const onControl = Boolean(target?.closest?.('.mp-task-check, .mp-task-more'));
    this.cancelGesture();
    const effect = this.gesture.down({
      x: evt.clientX,
      y: evt.clientY,
      time: evt.timeStamp,
      pointerType,
      button: evt.button,
      onControl,
    });
    if (this.gesture.getPhase() === 'idle') return;
    this.gestureCard = { card, cardEl };
    this.touchDown = pointerType !== 'mouse';

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
    // Во время перетаскивания страница не прокручивается (iOS требует отмены `touchmove`).
    const onTouchMove = (e: TouchEvent): void => {
      if (this.drag && e.cancelable) e.preventDefault();
    };
    // Прокрутка до срабатывания долгого нажатия (на iOS — без `pointercancel`) отменяет жест.
    const onScroll = (): void => {
      if (this.gesture.getPhase() === 'pressed') this.cancelGesture();
    };
    doc.addEventListener('pointermove', onMove, { passive: false });
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onCancel);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('touchmove', onTouchMove, { passive: false });
    doc.addEventListener('scroll', onScroll, true);
    this.gestureCleanup = () => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('pointercancel', onCancel);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('touchmove', onTouchMove);
      doc.removeEventListener('scroll', onScroll, true);
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
        // На вкладке «Задачи» долгое нажатие — перетаскивание (`drag-start`), меню не открывается.
        this.clearLongPress();
        return;
      case 'drag-start':
        this.clearLongPress();
        if (!current) return;
        if (effect.byLongPress && this.host.platform.isAndroid) {
          try {
            navigator.vibrate?.(10);
          } catch {
            // Вибрация необязательна.
          }
        }
        this.beginDrag(current.card, current.cardEl, effect.x, effect.y);
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
    const deleteZone = this.createDeleteZone(root);
    cardEl.addClass('is-dragging');
    root.addClass('is-dragging');
    this.drag = {
      session: startDrag(card.taskId, card.quadrant),
      card,
      cardEl,
      ghost,
      offsetX: x - rect.left,
      offsetY: y - rect.top,
      zones,
      zoneEls,
      deleteEl: deleteZone?.el ?? null,
      deleteRect: deleteZone?.rect ?? null,
    };
    this.moveDrag(x, y);
  }

  /** Зона «🗑 Перетащите сюда, чтобы удалить» на одной высоте с «+» (кадр 06). */
  private createDeleteZone(root: HTMLElement): { el: HTMLElement; rect: Rect } | null {
    const view = root.closest<HTMLElement>('.mp-view') ?? root;
    const viewBox = view.getBoundingClientRect();
    if (viewBox.width <= 0 || viewBox.height <= 0) return null;
    const fabBox = view.querySelector<HTMLElement>('.mp-fab')?.getBoundingClientRect() ?? null;
    const fab: Rect | null = fabBox && fabBox.width > 0 ? { left: fabBox.left, top: fabBox.top, right: fabBox.right, bottom: fabBox.bottom } : null;
    const rect = deleteZoneRect({ left: viewBox.left, top: viewBox.top, right: viewBox.right, bottom: viewBox.bottom }, fab, DELETE_ZONE);
    const el = root.doc.body.createDiv({ cls: 'mp-task-delete-zone', attr: { 'aria-hidden': 'true' } });
    el.setCssStyles({
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.right - rect.left}px`,
      height: `${rect.bottom - rect.top}px`,
    });
    setIcon(el.createSpan({ cls: 'mp-task-delete-zone-icon' }), 'trash-2');
    el.createSpan({ cls: 'mp-task-delete-zone-label', text: t('tasks.drag.deleteZone') });
    return { el, rect };
  }

  private moveDrag(x: number, y: number): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.ghost) drag.ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px) scale(1.04)`;
    const next = updateDrag(drag.session, drag.zones, x, y, drag.deleteRect);
    if (next === drag.session) return;
    drag.session = next;
    for (const [key, el] of drag.zoneEls) el.toggleClass('is-drop-target', isHighlightedZone(next, key));
    drag.deleteEl?.toggleClass('is-over', next.overDelete);
    drag.ghost?.toggleClass('is-over-delete', next.overDelete);
  }

  private endDrag(commit: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    drag.ghost?.remove();
    drag.deleteEl?.remove();
    drag.cardEl.removeClass('is-dragging');
    this.rootEl?.removeClass('is-dragging');
    for (const el of drag.zoneEls.values()) el.removeClass('is-drop-target');
    const drop = commit ? resolveDrop(drag.session) : null;
    if (drop?.kind === 'move') {
      void this.runOp(drag.card, () => this.deps.tasks.moveToQuadrant(drop.taskId, drop.quadrant));
    } else if (drop?.kind === 'delete') {
      this.deleteWithUndo(drag.card);
    }
    if (this.renderPending) {
      this.renderPending = false;
      this.scheduleRender();
    }
  }

  /**
   * Удаление из зоны перетаскивания: карточка сразу скрывается, в корзину задача уходит через
   * 5 с; «Вернуть» в уведомлении отменяет удаление (восстанавливать из корзины не нужно).
   */
  private deleteWithUndo(card: TaskCardModel): void {
    const id = card.taskId;
    this.pendingDeletes.schedule(
      id,
      () => {
        void this.runOp(null, () => this.deps.tasks.delete(id)).then(() => this.scheduleRender());
      },
      UNDO_DELETE_MS,
    );
    this.scheduleRender();
    const message = t('tasks.notices.deletedUndo');
    const undo = (): void => {
      if (!this.pendingDeletes.undo(id)) return;
      this.scheduleRender();
    };
    if (this.deps.notifier.showAction) this.deps.notifier.showAction(message, { label: t('tasks.notices.undo'), run: undo }, UNDO_DELETE_MS);
    else this.deps.notifier.show(message);
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
    this.touchDown = false;
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
