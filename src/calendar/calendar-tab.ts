/**
 * Вкладка «Календарь» (ТЗ §4.4; кадры 09, 13, 15): заголовок «Октябрь 2026» с выбором месяца
 * и года, «Сегодня», выбор источников, «Список / Временная шкала / Месяц», лента недели,
 * список дня, временная шкала и месяц. Данные — только `DayItemsProvider`; режим и источники
 * хранятся в настройках (`ui.calendarMode`, `ui.calendarSources`). «+» получает выбранный день.
 */

import { Menu, setIcon } from 'obsidian';
import type {
  CalendarCacheReader,
  Clock,
  DatePickerFactory,
  DatePickerHandle,
  DayItemsProvider,
  EventService,
  FormatPreferencesProvider,
  NoteIndex,
  NoteService,
  Notifier,
  PendingDeletes,
  PlannerViewHost,
  SettingsStore,
  TabController,
  TabFactory,
  TaskService,
} from '../app/contracts';
import type {
  CalendarMode,
  CalendarSourceFilter,
  DayItem,
  DayItemsByDate,
  LocalDateString,
  OpResult,
  QuadrantKey,
  TaskDayItem,
  Unsubscribe,
  VaultPath,
} from '../model/types';
import { floatingFromDate, isValidTimeZone, minutesToTime, parseDateParts, timeToMinutes } from '../model/dates';
import { DEFAULT_QUADRANT_STYLE, DEFAULT_QUADRANT_TITLES } from '../model/defaults';
import { registerDictionary, t } from '../i18n';
import { ruCalendar } from '../i18n/ru/calendar';
import { enCalendar } from '../i18n/en/calendar';
import { ruCalendarModel } from '../i18n/ru/calendar-model';
import { enCalendarModel } from '../i18n/en/calendar-model';
import { ruCache } from '../i18n/ru/cache';
import { enCache } from '../i18n/en/cache';
import { createDatePicker } from '../ui/controls/date-picker';
import type { HapticKind } from '../ui/haptics';
import { SyncStatusLine, type SyncStatusSource } from './sync-status-line';
import { showMenuAt } from '../ui/controls/context-menu';
import { errorMessageKey } from '../tasks/tasks-presenter';
import { addTaskMenuItems } from '../tasks/task-menu';
import { shiftEventPatch } from '../events/event-draft';
import { calendarItemMenu, type CalendarMenuAction } from './item-menu';
import {
  CALENDAR_MODES,
  SOURCE_KEYS,
  addContextFor,
  buildDayList,
  buildWeekCells,
  goToday,
  headerMonth,
  hideItems,
  initCalendarState,
  isFilterNarrowed,
  itemAction,
  monthYearTitle,
  moveSelection,
  refreshToday,
  selectDate,
  setMode,
  shiftPeriod,
  showTodayButton,
  taskToggleRequest,
  toggleSource,
  visibleRange,
  type CalendarLabelStrings,
  type CalendarState,
  type DayListRow,
} from './calendar-state';
import { renderDayList, type DayListContext } from './day-list';
import { renderWeekStrip } from './week-strip';
import { renderTimeline } from './timeline-view';
import { renderMonthView } from './month-view';
import { DEFAULT_MAX_BARS, layoutMonth } from './month-layout';
import { DaySwipeGesture, DayWheel, dayKeyStep, type DayStep, type DaySwipeEffect } from './day-swipe';
import { isSidebarEdgeTouch } from '../ui/view-state';

// Словари регистрируются идемпотентно (повторная регистрация заменяет модуль).
registerDictionary('ru', 'calendar', ruCalendar);
registerDictionary('en', 'calendar', enCalendar);
registerDictionary('ru', 'calendar-model', ruCalendarModel);
registerDictionary('en', 'calendar-model', enCalendarModel);
registerDictionary('ru', 'cache', ruCache);
registerDictionary('en', 'cache', enCache);

/** Пауза анимации выполнения перед записью, мс. */
const COMPLETE_ANIMATION_MS = 220;
/** Уезжающий день после свайпа, мс (как `transition` в `50-calendar.css`). */
const DAY_OUT_MS = 150;
/** Въезжающий день, мс. */
const DAY_IN_MS = 220;
/** Возврат на место, мс. */
const DAY_BACK_MS = 200;

const MODE_ICONS: Record<CalendarMode, string> = {
  list: 'list',
  timeline: 'clock',
  month: 'calendar-days',
};

export interface CalendarTabDeps {
  dayItems: DayItemsProvider;
  settings: SettingsStore;
  clock: Clock;
  format: FormatPreferencesProvider;
  notifier: Notifier;
  /** Выполнение кружком и меню задачи (перенос в квадрант, на завтра, удаление). */
  tasks: Pick<TaskService, 'complete' | 'uncomplete' | 'moveToQuadrant' | 'postponeToTomorrow' | 'delete'>;
  /** Меню события-заметки: «Перенести на завтра» и «Удалить» (с меткой удаления). */
  events?: Pick<EventService, 'update' | 'delete'> | null;
  /** Меню быстрой заметки: «Удалить». */
  notes?: Pick<NoteService, 'delete'> | null;
  /** Состояние кэша для сообщений о покрытии и названий календарей (необязательно). */
  cache?: Pick<CalendarCacheReader, 'getState' | 'getCalendars' | 'onChange'> | null;
  /** Названия квадрантов, готовность индекса и заметки элементов для меню (необязательно). */
  index?: (Pick<NoteIndex, 'getMatrix' | 'isReady' | 'whenReady'> & Partial<Pick<NoteIndex, 'getById'>>) | null;
  /** Выбор месяца и года; по умолчанию — общий `createDatePicker`. */
  datePicker?: DatePickerFactory;
  /** Тактильный отклик (`CoreServices.haptics`). */
  haptic?(kind: HapticKind): void;
  /** Статус синхронизации с «Календарём» iOS — строка под шапкой (доработка 006, §7). */
  syncStatus?: SyncStatusSource | null;
  /** Удаления с «Вернуть»: такие элементы скрыты до удаления (доработка 006, §12). */
  pendingDeletes?: Pick<PendingDeletes, 'has' | 'onChange'> | null;
}

/** Окно «Вернуть» после выполнения задачи во вкладке, мс. */
export const COMPLETE_UNDO_MS = 5000;

/** Период проверки смены суток, пока вкладка показана, мс. */
export const DAY_CHECK_INTERVAL_MS = 60_000;

export interface DayChangeWatcherDeps {
  /** Текущая дата в зоне устройства. */
  today: () => LocalDateString;
  /** Вызывается при смене даты (и при возвращении из фона — для пересчёта зоны и т. п.). */
  onCheck: (dayChanged: boolean) => void;
  setInterval: (callback: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  /** Документ для `visibilitychange`; `null` — без подписки. */
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null;
}

/**
 * Следит за сменой суток: таймер раз в минуту (только между `start` и `stop`) и
 * `visibilitychange` (возвращение из фона, между `attach` и `detach`).
 */
export class DayChangeWatcher {
  private timer: number | null = null;
  private lastDay: LocalDateString;
  private readonly onVisibility = () => {
    if (this.deps.doc?.visibilityState === 'visible') this.check(true);
  };
  private attached = false;

  constructor(private readonly deps: DayChangeWatcherDeps) {
    this.lastDay = deps.today();
  }

  /** Запоминает текущий день (после отрисовки). */
  sync(day: LocalDateString): void {
    this.lastDay = day;
  }

  attach(): void {
    if (this.attached || !this.deps.doc) return;
    this.attached = true;
    this.deps.doc.addEventListener('visibilitychange', this.onVisibility);
  }

  detach(): void {
    if (!this.attached || !this.deps.doc) return;
    this.attached = false;
    this.deps.doc.removeEventListener('visibilitychange', this.onVisibility);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.deps.setInterval(() => this.check(false), DAY_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    this.deps.clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.detach();
  }

  /** `always` — сообщить о проверке, даже если дата не сменилась. */
  check(always: boolean): void {
    const day = this.deps.today();
    const changed = day !== this.lastDay;
    this.lastDay = day;
    if (changed || always) this.deps.onCheck(changed);
  }
}

/** Фабрика вкладки для `PlannerViewOptions.tabs.calendar`. */
export function createCalendarTab(deps: CalendarTabDeps): TabFactory {
  return (host) => new CalendarTab(host, deps);
}

export class CalendarTab implements TabController {
  readonly id = 'calendar' as const;

  private rootEl: HTMLElement | null = null;
  private headerEl: HTMLElement | null = null;
  private syncLine: SyncStatusLine | null = null;
  private pickerEl: HTMLElement | null = null;
  private weekEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private readonly subscriptions: Unsubscribe[] = [];
  private renderTimer: number | null = null;

  private state: CalendarState;
  /** Последний режим, прочитанный из настроек. */
  private settingsMode: CalendarMode;
  private picker: DatePickerHandle | null = null;
  private pickerCleanup: (() => void) | null = null;
  private readonly busy = new Set<string>();
  /** Прокрутка временной шкалы по дню (сохраняется между перерисовками). */
  private timelineScroll: { date: LocalDateString; top: number } | null = null;
  private timelineEl: HTMLElement | null = null;
  private dayWatcher: DayChangeWatcher | null = null;
  /** Листание дней свайпом (доработка 007). */
  private readonly daySwipe = new DaySwipeGesture();
  private readonly dayWheel = new DayWheel();
  private daySwipeCleanup: (() => void) | null = null;
  /** Анимация смены дня: таймер и завершение (вызывается досрочно новым жестом). */
  private dayAnimation: { timer: number; finish: () => void } | null = null;
  /** После свайпа ближайший `click` не открывает элемент. */
  private daySwipeClickUntil = 0;

  constructor(
    private readonly host: PlannerViewHost,
    private readonly deps: CalendarTabDeps,
  ) {
    this.settingsMode = deps.settings.get().ui.calendarMode;
    this.state = initCalendarState(this.today(), this.settingsMode);
  }

  /** Смена суток или возвращение из фона: «Сегодня» и выбранный «сегодняшний» день переходят на новую дату. */
  private onDayCheck(dayChanged: boolean): void {
    // Обращение к кэшу пересчитывает время событий, если сменилась зона устройства.
    this.deps.cache?.getState();
    if (!this.rootEl) return;
    if (dayChanged || this.state.today !== this.today()) this.render();
  }

  // --- Жизненный цикл ---

  mount(containerEl: HTMLElement): void {
    this.unmount();
    const root = containerEl.createDiv({ cls: 'mp-calendar' });
    this.rootEl = root;
    this.headerEl = root.createDiv({ cls: 'mp-cal-header', attr: { role: 'toolbar', 'aria-label': t('calendar.header.toolbar') } });
    if (this.deps.syncStatus) {
      const line = new SyncStatusLine({
        source: this.deps.syncStatus,
        openSettings: () => this.host.actions.openSettings(),
        haptic: (kind) => this.haptic(kind),
      });
      line.mount(root.createDiv());
      this.syncLine = line;
    }
    this.pickerEl = root.createDiv({ cls: 'mp-cal-picker' });
    this.pickerEl.hidden = true;
    this.weekEl = root.createDiv({ cls: 'mp-cal-week' });
    this.bodyEl = root.createDiv({ cls: 'mp-cal-body' });
    this.attachDayGestures(this.bodyEl);

    this.subscriptions.push(this.deps.dayItems.onChange(() => this.scheduleRender()));
    this.subscriptions.push(
      this.deps.settings.onChange(() => {
        this.syncLine?.refresh();
        this.scheduleRender();
      }),
    );
    if (this.deps.pendingDeletes) this.subscriptions.push(this.deps.pendingDeletes.onChange(() => this.scheduleRender()));
    if (this.deps.cache) this.subscriptions.push(this.deps.cache.onChange(() => this.scheduleRender()));

    const doc = (containerEl as { ownerDocument?: Document | null }).ownerDocument ?? (typeof document === 'undefined' ? null : document);
    const view = doc?.defaultView ?? (typeof window === 'undefined' ? null : window);
    if (view) {
      const watcher = new DayChangeWatcher({
        today: () => this.today(),
        onCheck: (changed) => this.onDayCheck(changed),
        setInterval: (callback, ms) => view.setInterval(callback, ms),
        clearInterval: (id) => view.clearInterval(id),
        doc,
      });
      watcher.attach();
      this.dayWatcher = watcher;
    }

    const index = this.deps.index;
    if (index && !index.isReady()) {
      this.bodyEl.createDiv({ cls: 'mp-cal-loading', text: t('calendar.loading') });
      void index.whenReady().then(() => {
        if (this.rootEl === root) this.render();
      });
      return;
    }
    this.render();
  }

  unmount(): void {
    this.endDaySwipe();
    this.settleDayAnimation();
    this.dayWatcher?.dispose();
    this.dayWatcher = null;
    this.closePicker();
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.syncLine?.unmount();
    this.syncLine = null;
    this.rootEl?.remove();
    this.rootEl = null;
    this.headerEl = null;
    this.pickerEl = null;
    this.weekEl = null;
    this.bodyEl = null;
    this.timelineEl = null;
  }

  onShow(): void {
    this.dayWatcher?.start();
    this.publishAddContext();
    // «Сегодня» могло смениться, пока вкладка была скрыта.
    if (this.rootEl) this.render();
  }

  onHide(): void {
    this.endDaySwipe();
    this.settleDayAnimation();
    this.dayWatcher?.stop();
    this.closePicker();
  }

  focus(options: { date?: LocalDateString }): void {
    if (options.date && parseDateParts(options.date)) this.update(selectDate(this.state, options.date));
  }

  // --- Состояние ---

  private today(): LocalDateString {
    const zone = this.deps.clock.timeZone();
    return floatingFromDate(this.deps.clock.now(), isValidTimeZone(zone) ? zone : undefined).date;
  }

  private nowMinute(): number {
    const zone = this.deps.clock.timeZone();
    const now = floatingFromDate(this.deps.clock.now(), isValidTimeZone(zone) ? zone : undefined);
    return timeToMinutes(now.time);
  }

  private update(next: CalendarState, focus: 'week' | 'month' | null = null): void {
    if (next === this.state && !focus) return;
    const dateChanged = next.selected !== this.state.selected;
    this.state = next;
    if (dateChanged) this.publishAddContext();
    this.render(focus);
  }

  private publishAddContext(): void {
    this.host.setAddContext(addContextFor(this.state));
  }

  private sources(): CalendarSourceFilter {
    return this.deps.settings.get().ui.calendarSources;
  }

  private labelStrings(): CalendarLabelStrings {
    const format = this.deps.format.get();
    return {
      language: format.language,
      hour12: format.hour12,
      today: t('calendar.relative.today'),
      tomorrow: t('calendar.relative.tomorrow'),
      yesterday: t('calendar.relative.yesterday'),
      am: t('calendar.am'),
      pm: t('calendar.pm'),
    };
  }

  // --- Отрисовка ---

  private scheduleRender(): void {
    if (!this.rootEl || this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 0);
  }

  private render(focus: 'week' | 'month' | null = null): void {
    if (!this.rootEl || !this.bodyEl || !this.weekEl) return;
    // Режим из настроек применяется только при его изменении (своя запись уже учтена в `changeMode`).
    const settingsMode = this.deps.settings.get().ui.calendarMode;
    const today = this.today();
    this.dayWatcher?.sync(today);
    let state = refreshToday(this.state, today);
    if (settingsMode !== this.settingsMode) {
      this.settingsMode = settingsMode;
      state = setMode(state, settingsMode);
    }
    if (state.selected !== this.state.selected) {
      this.state = state;
      this.publishAddContext();
    }
    this.state = state;

    const format = this.deps.format.get();
    const strings = this.labelStrings();
    const range = visibleRange(state, format.weekStart);
    let days: DayItemsByDate;
    try {
      days = this.deps.dayItems.getDays(range, { includeCompleted: true });
      const pending = this.deps.pendingDeletes;
      if (pending) days = hideItems(days, (id) => pending.has(id));
    } catch (error) {
      console.error('[matrix-planner] calendar data failed', error);
      days = new Map();
    }

    this.renderHeader(strings);

    // Лента недели — в «Списке» и «Временной шкале».
    this.weekEl.hidden = state.mode === 'month';
    if (state.mode !== 'month') {
      const focusWeek = focus === 'week' || this.weekEl.contains(this.rootEl.doc.activeElement);
      renderWeekStrip(
        this.weekEl,
        buildWeekCells({ selected: state.selected, today: state.today, weekStart: format.weekStart, days, language: format.language }),
        {
          select: (date) => this.update(selectDate(this.state, date)),
          shift: (delta) => this.update(shiftPeriod(this.state, delta)),
          move: (offset) => this.update(moveSelection(this.state, offset), 'week'),
        },
        { showArrows: !this.host.platform.isMobile, focusSelected: focusWeek },
      );
    }

    this.renderBody(days, strings, focus);
  }

  private renderHeader(strings: CalendarLabelStrings): void {
    const el = this.headerEl;
    if (!el) return;
    el.empty();
    const state = this.state;
    const { year, month } = headerMonth(state);
    const title = monthYearTitle(strings.language, year, month);

    const titleRow = el.createDiv({ cls: 'mp-cal-title-row' });
    if (state.mode === 'month') this.iconButton(titleRow, 'chevron-left', t('calendar.header.prevMonth'), () => this.update(shiftPeriod(this.state, -1)));
    const titleButton = titleRow.createEl('button', {
      cls: 'mp-cal-title',
      attr: {
        type: 'button',
        'aria-label': t('calendar.header.chooseMonth', { value: title }),
        'aria-expanded': this.picker ? 'true' : 'false',
        'aria-haspopup': 'dialog',
      },
    });
    titleButton.createSpan({ cls: 'mp-cal-title-text', text: title });
    setIcon(titleButton.createSpan({ cls: 'mp-cal-title-icon', attr: { 'aria-hidden': 'true' } }), 'chevron-down');
    titleButton.addEventListener('click', () => (this.picker ? this.closePicker(true) : this.openPicker()));
    if (state.mode === 'month') this.iconButton(titleRow, 'chevron-right', t('calendar.header.nextMonth'), () => this.update(shiftPeriod(this.state, 1)));

    const actions = el.createDiv({ cls: 'mp-cal-actions' });
    const sources = this.sources();
    const filter = this.iconButton(actions, 'list-filter', t('calendar.header.sources'), (evt) => this.openSourcesMenu(evt));
    filter.addClass('mp-cal-filter');
    filter.toggleClass('is-active', isFilterNarrowed(sources));
    filter.setAttr('aria-haspopup', 'menu');

    const modes = actions.createDiv({ cls: 'mp-segmented mp-cal-modes', attr: { role: 'group', 'aria-label': t('calendar.header.modes') } });
    for (const mode of CALENDAR_MODES) {
      const label = t(`calendar.modes.${mode}`);
      const active = state.mode === mode;
      const button = modes.createEl('button', {
        cls: 'mp-segment',
        attr: { type: 'button', 'aria-label': label, title: label, 'aria-pressed': active ? 'true' : 'false' },
      });
      button.toggleClass('is-active', active);
      setIcon(button, MODE_ICONS[mode]);
      button.addEventListener('click', () => this.changeMode(mode));
    }

    if (showTodayButton(state)) {
      const today = actions.createEl('button', {
        cls: 'mp-chip mp-cal-today',
        text: t('calendar.header.today'),
        attr: { type: 'button', 'aria-label': t('calendar.header.goToday') },
      });
      today.addEventListener('click', () => this.update(goToday(this.state), this.state.mode === 'month' ? 'month' : 'week'));
    }
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
    const button = parent.createEl('button', {
      cls: 'mp-icon-button',
      attr: { type: 'button', 'aria-label': label, title: label },
    });
    setIcon(button, icon);
    button.addEventListener('click', onClick);
    return button;
  }

  private renderBody(days: DayItemsByDate, strings: CalendarLabelStrings, focus: 'week' | 'month' | null): void {
    const body = this.bodyEl;
    if (!body) return;
    const state = this.state;
    const format = this.deps.format.get();

    // Сохраняем прокрутку панели и шкалы: обновление данных не должно сбивать пользователя.
    const panel = this.rootEl?.parentElement ?? null;
    const panelScroll = panel?.scrollTop ?? 0;
    if (this.timelineEl && this.timelineScroll) this.timelineScroll.top = this.timelineEl.scrollTop;
    const monthFocus = focus === 'month' || Boolean(body.querySelector('.mp-cal-month')?.contains(this.rootEl?.doc.activeElement ?? null));

    body.empty();
    body.setAttr('data-mode', state.mode);
    this.timelineEl = null;

    const cache = this.deps.cache?.getState() ?? null;
    const model = buildDayList({
      agenda: days.get(state.selected),
      date: state.selected,
      today: state.today,
      strings,
      sources: this.sources(),
      cache,
    });
    const ctx = this.listContext();

    if (state.mode === 'month') {
      const { year, month } = headerMonth(state);
      const layout = layoutMonth({ year, month, weekStart: format.weekStart, days, today: state.today, selected: state.selected, maxBars: DEFAULT_MAX_BARS });
      renderMonthView(
        body,
        layout,
        {
          select: (date) => this.update(selectDate(this.state, date)),
          open: (item) => this.openItem(item),
          menu: (item, anchor) => this.openItemMenu(item, anchor),
          move: (offset) => this.update(moveSelection(this.state, offset), 'month'),
          shift: (delta) => this.update(shiftPeriod(this.state, delta)),
        },
        {
          language: format.language,
          maxBars: DEFAULT_MAX_BARS,
          title: monthYearTitle(format.language, year, month),
          focusSelected: monthFocus,
          menuHaptic: () => this.haptic('tap'),
        },
      );
      renderDayList(body, model, ctx);
    } else if (state.mode === 'timeline') {
      const previous = this.timelineScroll && this.timelineScroll.date === state.selected ? this.timelineScroll.top : null;
      this.timelineEl = renderTimeline(body, model, ctx, {
        nowMinute: state.selected === state.today ? this.nowMinute() : null,
        strings,
        scrollTop: previous,
        onLongPressEmpty: this.host.actions.isAvailable('event') ? (minute) => this.createEventAt(minute) : null,
      });
      this.timelineScroll = { date: state.selected, top: this.timelineEl.scrollTop };
      const timeline = this.timelineEl;
      timeline.addEventListener('scroll', () => {
        if (this.timelineScroll && this.timelineEl === timeline) this.timelineScroll.top = timeline.scrollTop;
      });
    } else {
      const section = renderDayList(body, model, ctx);
      section.setAttr('tabindex', '0');
    }
    if (state.mode !== 'month') {
      const area = state.mode === 'timeline' ? this.timelineEl : body.querySelector<HTMLElement>('.mp-cal-day');
      area?.setAttr('aria-keyshortcuts', 'ArrowLeft ArrowRight');
    }

    if (panel) panel.scrollTop = panelScroll;
  }

  private listContext(): DayListContext {
    const matrix = this.deps.index?.getMatrix() ?? null;
    const calendars = new Map((this.deps.cache?.getCalendars() ?? []).map((calendar) => [calendar.calendarId, calendar.title]));
    const planner = t('calendar.item.planner');
    return {
      isMobile: this.host.platform.isMobile,
      quadrantTitle: (key: QuadrantKey) => matrix?.byKey[key]?.title ?? DEFAULT_QUADRANT_TITLES[this.deps.format.get().language][key],
      quadrantIcon: (key: QuadrantKey) => matrix?.byKey[key]?.icon ?? DEFAULT_QUADRANT_STYLE[key].icon,
      // Задачи и события без календаря — локальный календарь «Планировщик».
      calendarTitle: (row: DayListRow) => {
        if (row.calendarId) return calendars.get(row.calendarId) ?? null;
        return row.source === 'task' || row.source === 'event' ? planner : null;
      },
      connectCalendar: () => this.host.actions.openSettings(),
      showAllSources: () => this.showAllSources(),
      menuHaptic: () => this.haptic('tap'),
      handlers: {
        open: (item) => this.openItem(item),
        menu: (item, anchor) => this.openItemMenu(item, anchor),
        toggle: (item, rowEl) => this.toggleTask(item, rowEl),
        isBusy: (key) => this.busy.has(key),
      },
    };
  }

  // --- Листание дней: свайп, колесо тачпада, стрелки (доработка 007) ---

  /** Обработчики на области дня; живут, пока смонтирована вкладка (содержимое области перерисовывается). */
  private attachDayGestures(body: HTMLElement): void {
    const enabled = (): boolean => this.state.mode !== 'month';

    body.addEventListener('pointerdown', (evt: PointerEvent) => {
      if (!enabled() || evt.pointerType === 'mouse' || evt.button !== 0 || !evt.isPrimary) return;
      // У самого края экрана свайп остаётся Obsidian (шторки).
      if (isSidebarEdgeTouch(evt.clientX, body.win?.innerWidth ?? 0)) return;
      // Жест во время анимации: предыдущая смена дня завершается сразу.
      this.settleDayAnimation();
      this.endDaySwipe();
      const width = body.getBoundingClientRect().width;
      this.daySwipe.down({ x: evt.clientX, y: evt.clientY, time: evt.timeStamp, width });
      if (this.daySwipe.getPhase() !== 'pending') return;

      const doc = body.doc;
      const pointerId = evt.pointerId;
      const cancel = (): void => {
        const effect = this.daySwipe.cancel();
        this.endDaySwipe();
        this.applyDaySwipe(effect);
      };
      const onMove = (e: PointerEvent): void => {
        if (e.pointerId !== pointerId) return;
        this.applyDaySwipe(this.daySwipe.move(e.clientX, e.clientY, e.timeStamp));
        if (this.daySwipe.isSwiping() && e.cancelable) e.preventDefault();
        // Жест отменён (прокрутка, долгое нажатие) — обработчики больше не нужны.
        if (this.daySwipe.getPhase() === 'cancelled') this.endDaySwipe();
      };
      const onUp = (e: PointerEvent): void => {
        if (e.pointerId !== pointerId) return;
        const effect = this.daySwipe.up(e.timeStamp);
        this.endDaySwipe();
        this.applyDaySwipe(effect);
      };
      const onCancel = (e: PointerEvent): void => {
        if (e.pointerId === pointerId) cancel();
      };
      // iOS: прокрутку во время свайпа останавливает только отмена `touchmove`.
      const onTouchMove = (e: TouchEvent): void => {
        if (this.daySwipe.isSwiping() && e.cancelable) e.preventDefault();
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') cancel();
      };
      doc.addEventListener('pointermove', onMove, { passive: false });
      doc.addEventListener('pointerup', onUp);
      doc.addEventListener('pointercancel', onCancel);
      doc.addEventListener('touchmove', onTouchMove, { passive: false });
      doc.addEventListener('keydown', onKey);
      this.daySwipeCleanup = () => {
        doc.removeEventListener('pointermove', onMove);
        doc.removeEventListener('pointerup', onUp);
        doc.removeEventListener('pointercancel', onCancel);
        doc.removeEventListener('touchmove', onTouchMove);
        doc.removeEventListener('keydown', onKey);
      };
    });

    // Касание, после которого был свайп, не открывает элемент.
    body.addEventListener(
      'click',
      (evt: MouseEvent) => {
        if (Date.now() >= this.daySwipeClickUntil) return;
        this.daySwipeClickUntil = 0;
        evt.preventDefault();
        evt.stopPropagation();
      },
      true,
    );

    // Горизонтальная прокрутка тачпада: один жест — один день.
    body.addEventListener(
      'wheel',
      (evt: WheelEvent) => {
        if (!enabled() || !DayWheel.isHorizontal(evt.deltaX, evt.deltaY)) return;
        evt.preventDefault();
        const step = this.dayWheel.push(evt.deltaX, evt.timeStamp);
        if (step !== 0) this.stepDay(step, 'none');
      },
      { passive: false },
    );

    // Стрелки ←/→ при фокусе в области дня (не в полях ввода).
    body.addEventListener('keydown', (evt: KeyboardEvent) => {
      if (!enabled() || evt.defaultPrevented) return;
      const target = evt.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const step = dayKeyStep(evt);
      if (step === 0) return;
      evt.preventDefault();
      this.stepDay(step, 'none', true);
    });
  }

  private endDaySwipe(): void {
    this.daySwipeCleanup?.();
    this.daySwipeCleanup = null;
  }

  /** Содержимое дня, которое едет за пальцем. */
  private daySection(): HTMLElement | null {
    return this.bodyEl?.querySelector<HTMLElement>(':scope > .mp-cal-day') ?? null;
  }

  private reducedMotion(): boolean {
    const win = this.bodyEl?.win ?? (typeof window === 'undefined' ? null : window);
    return Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }

  private setDayOffset(section: HTMLElement | null, offset: number): void {
    section?.setCssProps({ '--mp-day-x': `${Math.round(offset)}px` });
  }

  private applyDaySwipe(effect: DaySwipeEffect): void {
    const body = this.bodyEl;
    if (!body) return;
    switch (effect.type) {
      case 'none':
        return;
      case 'start':
        body.addClass('is-day-moving');
        return;
      case 'move':
        this.setDayOffset(this.daySection(), effect.offset);
        if (effect.crossed && effect.armed) this.haptic('threshold');
        return;
      case 'commit':
        this.daySwipeClickUntil = Date.now() + 500;
        this.finishDaySwipe(effect.step);
        return;
      case 'cancel':
        if (!effect.wasSwiping) return;
        this.daySwipeClickUntil = Date.now() + 500;
        this.springBack();
        return;
    }
  }

  /** Короткий свайп: содержимое возвращается на место. */
  private springBack(): void {
    const body = this.bodyEl;
    const section = this.daySection();
    if (!body || !section || this.reducedMotion()) {
      this.clearDayMotion();
      return;
    }
    body.setCssProps({ '--mp-day-duration': `${DAY_BACK_MS}ms` });
    body.addClass('is-day-animating');
    this.setDayOffset(section, 0);
    this.startDayAnimation(DAY_BACK_MS, () => this.clearDayMotion());
  }

  /** Свайп за порогом: текущий день уезжает, соседний выезжает с другой стороны. */
  private finishDaySwipe(step: DayStep): void {
    const body = this.bodyEl;
    const section = this.daySection();
    if (!body || !section || this.reducedMotion()) {
      this.clearDayMotion();
      this.stepDay(step, 'none');
      return;
    }
    const width = body.getBoundingClientRect().width;
    body.addClass('is-day-moving');
    body.setCssProps({ '--mp-day-duration': `${DAY_OUT_MS}ms` });
    body.addClass('is-day-animating');
    this.setDayOffset(section, step > 0 ? -width : width);
    this.startDayAnimation(DAY_OUT_MS, () => this.stepDay(step, 'enter'));
  }

  /**
   * Смена дня на `step`: лента недели и «+» следуют за выбранным днём. `enter` — новый день
   * выезжает со стороны жеста; `keepFocus` — вернуть фокус области дня (клавиатура).
   */
  private stepDay(step: DayStep, motion: 'none' | 'enter', keepFocus = false): void {
    this.clearDayMotion();
    this.haptic('select');
    this.update(moveSelection(this.state, step));
    if (keepFocus) {
      const area = this.state.mode === 'timeline' ? this.timelineEl : this.daySection();
      area?.focus({ preventScroll: true });
    }
    const body = this.bodyEl;
    const section = this.daySection();
    if (motion !== 'enter' || !body || !section || this.reducedMotion()) return;
    const width = body.getBoundingClientRect().width;
    body.addClass('is-day-moving');
    this.setDayOffset(section, step > 0 ? width : -width);
    // Применить начальное положение без перехода, затем включить переход.
    void section.offsetWidth;
    body.setCssProps({ '--mp-day-duration': `${DAY_IN_MS}ms` });
    body.addClass('is-day-animating');
    this.setDayOffset(section, 0);
    this.startDayAnimation(DAY_IN_MS, () => this.clearDayMotion());
  }

  private startDayAnimation(ms: number, done: () => void): void {
    this.settleDayAnimation();
    const finish = (): void => {
      const current = this.dayAnimation;
      if (current?.finish !== finish) return;
      window.clearTimeout(current.timer);
      this.dayAnimation = null;
      done();
    };
    // Небольшой запас, чтобы переход успел закончиться.
    this.dayAnimation = { timer: window.setTimeout(finish, ms + 30), finish };
  }

  /** Завершить анимацию сразу (новый жест, скрытие вкладки). */
  private settleDayAnimation(): void {
    // Завершение уезжающего дня запускает въезд нового — его тоже завершить.
    for (let i = 0; i < 2 && this.dayAnimation; i++) this.dayAnimation.finish();
  }

  private clearDayMotion(): void {
    const body = this.bodyEl;
    if (!body) return;
    body.removeClass('is-day-moving');
    body.removeClass('is-day-animating');
    body.setCssProps({ '--mp-day-duration': '' });
    this.daySection()?.setCssProps({ '--mp-day-x': '' });
  }

  // --- Действия ---

  private haptic(kind: HapticKind): void {
    this.deps.haptic?.(kind);
  }

  /** «Показать все» в пустом дне при суженном фильтре. */
  private showAllSources(): void {
    this.haptic('select');
    void this.deps.settings.update((draft) => {
      for (const key of SOURCE_KEYS) draft.ui.calendarSources[key] = true;
    });
  }

  /** Долгое нажатие на пустом месте шкалы — новое событие на это время (1 ч); отклик `tap` — при открытии формы. */
  private createEventAt(minute: number): void {
    this.host.actions.openEventForm({ mode: 'create', date: this.state.selected, time: minutesToTime(minute) });
  }

  private changeMode(mode: CalendarMode): void {
    if (this.state.mode === mode) return;
    this.haptic('select');
    this.closePicker();
    this.settingsMode = mode;
    this.update(setMode(this.state, mode));
    void this.deps.settings.update((draft) => {
      draft.ui.calendarMode = mode;
    });
  }

  private openSourcesMenu(evt: MouseEvent): void {
    this.haptic('tap');
    const sources = this.sources();
    const menu = new Menu();
    for (const key of SOURCE_KEYS) {
      menu.addItem((item) => {
        item
          .setTitle(t(`calendar.sources.${key}`))
          .setChecked(sources[key])
          .onClick(() => {
            this.haptic('select');
            void this.deps.settings.update((draft) => {
              draft.ui.calendarSources = toggleSource(draft.ui.calendarSources, key);
            });
          });
      });
    }
    if (evt.clientX !== 0 || evt.clientY !== 0) {
      menu.showAtMouseEvent(evt);
      return;
    }
    const target = evt.currentTarget as HTMLElement | null;
    const rect = target?.getBoundingClientRect();
    menu.showAtPosition({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 }, target?.doc);
  }

  /** Задача → форма, событие-заметка → форма события, внешнее → просмотр, заметка → редактор. */
  private openItem(item: DayItem): void {
    const actions = this.host.actions;
    const action = itemAction(item);
    switch (action.kind) {
      case 'task':
        actions.openTaskForm({ mode: 'edit', id: action.taskId });
        return;
      case 'event':
        if (actions.isAvailable('event')) actions.openEventForm({ mode: 'edit', id: action.eventId });
        else void actions.openItem(action.eventId);
        return;
      case 'external':
        actions.openEventForm({ mode: 'view-external', occurrenceKey: action.occurrenceKey });
        return;
      case 'note':
        void actions.openItem(action.noteId);
        return;
    }
  }

  // --- Меню элемента (долгое нажатие, ПКМ, Shift+F10) ---

  private openItemMenu(item: DayItem, anchor: MouseEvent | HTMLElement): void {
    const menu = new Menu();
    if (item.source === 'task') {
      if (!this.addTaskItems(menu, item)) return;
    } else {
      for (const entry of calendarItemMenu(item) ?? []) {
        if (!this.canRunMenuAction(item, entry.action)) continue;
        menu.addItem((menuItem) => {
          menuItem
            .setTitle(t(entry.labelKey))
            .setIcon(entry.icon)
            .setSection(entry.section)
            .setWarning(entry.warning)
            .onClick(() => this.runMenuAction(item, entry.action));
        });
      }
    }
    showMenuAt(menu, anchor);
  }

  /** Пункты задачи — как на вкладке «Задачи». `false` — меню задачи недоступно. */
  private addTaskItems(menu: Menu, item: TaskDayItem): boolean {
    const { tasks, index } = this.deps;
    const note = index?.getById?.(item.taskId);
    if (!index || !note || note.kind !== 'task') return false;
    const request = taskToggleRequest(item);
    addTaskMenuItems(
      menu,
      { taskId: item.taskId, path: note.path, quadrant: item.quadrant, done: item.completed, instanceDate: request.instanceDate ?? null },
      {
        tasks,
        matrix: () => index.getMatrix(),
        openNote: (path) => void this.host.actions.openNote(path),
        run: (op, successMessage) => void this.runItemOp(item.key, op, successMessage),
      },
    );
    return true;
  }

  /** Пункт доступен: есть сервис и заметка элемента. */
  private canRunMenuAction(item: DayItem, action: CalendarMenuAction): boolean {
    switch (action) {
      case 'view':
        return item.source === 'external';
      case 'edit':
        return item.source === 'event' && this.host.actions.isAvailable('event');
      case 'open-note':
        return this.itemPath(item) !== null;
      case 'postpone':
        return item.source === 'event' && Boolean(this.deps.events) && this.itemPath(item) !== null;
      case 'delete':
        return item.source === 'event' ? Boolean(this.deps.events) : item.source === 'note' && Boolean(this.deps.notes);
    }
  }

  private itemPath(item: DayItem): VaultPath | null {
    const id = item.source === 'event' ? item.eventId : item.source === 'note' ? item.noteId : item.source === 'task' ? item.taskId : null;
    if (id === null) return null;
    return this.deps.index?.getById?.(id)?.path ?? null;
  }

  private runMenuAction(item: DayItem, action: CalendarMenuAction): void {
    switch (action) {
      case 'view':
      case 'edit':
        this.openItem(item);
        return;
      case 'open-note': {
        const path = this.itemPath(item);
        if (path) void this.host.actions.openNote(path);
        return;
      }
      case 'postpone': {
        const events = this.deps.events;
        if (item.source !== 'event' || !events) return;
        const event = this.deps.index?.getById?.(item.eventId);
        if (!event || event.kind !== 'event') {
          this.deps.notifier.show(t('common.errors.notFound'));
          return;
        }
        void this.runItemOp(item.key, () => events.update(item.eventId, shiftEventPatch(event, 1)), t('calendar.notices.eventPostponed'));
        return;
      }
      case 'delete': {
        const { events, notes } = this.deps;
        if (item.source === 'event' && events) {
          void this.runItemOp(item.key, () => events.delete(item.eventId), t('calendar.notices.eventDeleted'));
        } else if (item.source === 'note' && notes) {
          void this.runItemOp(item.key, () => notes.delete(item.noteId), t('calendar.notices.noteDeleted'));
        }
        return;
      }
    }
  }

  /** Операция из меню: ошибка — уведомление, успех с изменением — `successMessage`. */
  private async runItemOp(key: string, op: () => Promise<OpResult<unknown>>, successMessage?: string): Promise<boolean> {
    this.busy.add(key);
    try {
      const result = await op();
      if (!result.ok) {
        this.deps.notifier.show(t(errorMessageKey(result.error)));
        if (result.error.detail) console.warn('[matrix-planner] calendar item operation failed', result.error);
        return false;
      }
      if (successMessage && result.changed) this.deps.notifier.show(successMessage);
      return true;
    } catch (error) {
      console.error('[matrix-planner] calendar item operation failed', error);
      this.deps.notifier.show(t('common.errors.unknown'));
      return false;
    } finally {
      this.busy.delete(key);
    }
  }

  private toggleTask(item: TaskDayItem, rowEl: HTMLElement): void {
    // Будущее повторение выполнить нельзя: сервис принимает только текущее (`due`).
    if (this.busy.has(item.key) || (item.projected && !item.completed)) return;
    const request = taskToggleRequest(item);
    this.busy.add(item.key);
    rowEl.addClass('is-busy');
    if (request.op === 'complete') {
      rowEl.addClass('is-completing');
      this.haptic('success');
    } else {
      this.haptic('undo');
    }
    const run = async () => {
      try {
        const result =
          request.op === 'complete'
            ? await this.deps.tasks.complete(request.taskId, request.instanceDate)
            : await this.deps.tasks.uncomplete(request.taskId, request.instanceDate);
        if (!result.ok) {
          this.haptic('error');
          this.deps.notifier.show(t(errorMessageKey(result.error)));
          if (result.error.detail) console.warn('[matrix-planner] calendar task operation failed', result.error);
          rowEl.removeClass('is-completing');
        } else if (request.op === 'complete' && result.changed) {
          this.offerUncomplete(request.taskId, request.instanceDate);
        }
      } catch (error) {
        console.error('[matrix-planner] calendar task operation failed', error);
        this.haptic('error');
        this.deps.notifier.show(t('common.errors.unknown'));
        rowEl.removeClass('is-completing');
      } finally {
        this.busy.delete(item.key);
        rowEl.removeClass('is-busy');
      }
    };
    if (request.op === 'complete') window.setTimeout(() => void run(), COMPLETE_ANIMATION_MS);
    else void run();
  }

  /** «Задача выполнена · Вернуть» (как во вкладке «Задачи»): «Вернуть» снимает выполнение. */
  private offerUncomplete(taskId: string, instanceDate: LocalDateString | undefined): void {
    const notifier = this.deps.notifier;
    const message = t('calendar.notices.taskCompleted');
    if (!notifier.showAction) {
      notifier.show(message);
      return;
    }
    notifier.showAction(
      message,
      {
        label: t('calendar.notices.undo'),
        run: () => {
          this.haptic('undo');
          void this.runItemOp(`undo:${taskId}`, () => this.deps.tasks.uncomplete(taskId, instanceDate));
        },
      },
      COMPLETE_UNDO_MS,
    );
  }

  // --- Выбор месяца и года ---

  private openPicker(): void {
    const el = this.pickerEl;
    if (!el || this.picker) return;
    el.empty();
    el.hidden = false;
    el.setAttr('role', 'dialog');
    el.setAttr('aria-label', t('calendar.header.chooseMonth', { value: monthYearTitle(this.deps.format.get().language, headerMonth(this.state).year, headerMonth(this.state).month) }));
    const format = this.deps.format.get();
    const factory = this.deps.datePicker ?? createDatePicker;
    this.picker = factory(el, {
      value: this.state.selected,
      today: this.state.today,
      weekStart: format.weekStart,
      language: format.language,
      quickOptions: false,
      onChange: (value) => {
        if (!value) return;
        this.closePicker(true);
        this.update(selectDate(this.state, value));
      },
    });
    const close = el.createEl('button', { cls: 'mp-chip mp-cal-picker-close', text: t('common.actions.close'), attr: { type: 'button', 'aria-label': t('calendar.header.closePicker') } });
    close.addEventListener('click', () => this.closePicker(true));

    const doc = el.doc;
    const onKey = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        this.closePicker(true);
      }
    };
    const onPointer = (evt: PointerEvent) => {
      const target = evt.target as Node | null;
      if (!target || el.contains(target) || this.headerEl?.querySelector('.mp-cal-title')?.contains(target)) return;
      this.closePicker();
    };
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('pointerdown', onPointer, true);
    this.pickerCleanup = () => {
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('pointerdown', onPointer, true);
    };
    this.headerEl?.querySelector('.mp-cal-title')?.setAttr('aria-expanded', 'true');
    el.querySelector<HTMLElement>('.mp-datepicker-title')?.focus();
  }

  private closePicker(returnFocus = false): void {
    this.pickerCleanup?.();
    this.pickerCleanup = null;
    this.picker?.destroy();
    this.picker = null;
    if (this.pickerEl) {
      this.pickerEl.empty();
      this.pickerEl.hidden = true;
    }
    const title = this.headerEl?.querySelector<HTMLElement>('.mp-cal-title');
    title?.setAttr('aria-expanded', 'false');
    if (returnFocus) title?.focus();
  }
}
