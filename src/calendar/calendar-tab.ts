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
  FormatPreferencesProvider,
  NoteIndex,
  Notifier,
  PlannerViewHost,
  SettingsStore,
  TabController,
  TabFactory,
  TaskService,
} from '../app/contracts';
import type { CalendarMode, CalendarSourceFilter, DayItem, DayItemsByDate, LocalDateString, QuadrantKey, TaskDayItem, Unsubscribe } from '../model/types';
import { floatingFromDate, isValidTimeZone, parseDateParts, timeToMinutes } from '../model/dates';
import { DEFAULT_QUADRANT_TITLES } from '../model/defaults';
import { registerDictionary, t } from '../i18n';
import { ruCalendar } from '../i18n/ru/calendar';
import { enCalendar } from '../i18n/en/calendar';
import { ruCalendarModel } from '../i18n/ru/calendar-model';
import { enCalendarModel } from '../i18n/en/calendar-model';
import { ruCache } from '../i18n/ru/cache';
import { enCache } from '../i18n/en/cache';
import { createDatePicker } from '../ui/controls/date-picker';
import { errorMessageKey } from '../tasks/tasks-presenter';
import {
  CALENDAR_MODES,
  SOURCE_KEYS,
  addContextFor,
  buildDayList,
  buildWeekCells,
  goToday,
  headerMonth,
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

// Словари регистрируются идемпотентно (повторная регистрация заменяет модуль).
registerDictionary('ru', 'calendar', ruCalendar);
registerDictionary('en', 'calendar', enCalendar);
registerDictionary('ru', 'calendar-model', ruCalendarModel);
registerDictionary('en', 'calendar-model', enCalendarModel);
registerDictionary('ru', 'cache', ruCache);
registerDictionary('en', 'cache', enCache);

/** Пауза анимации выполнения перед записью, мс. */
const COMPLETE_ANIMATION_MS = 220;

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
  tasks: Pick<TaskService, 'complete' | 'uncomplete'>;
  /** Состояние кэша для сообщений о покрытии и названий календарей (необязательно). */
  cache?: Pick<CalendarCacheReader, 'getState' | 'getCalendars' | 'onChange'> | null;
  /** Названия квадрантов и готовность индекса (необязательно). */
  index?: Pick<NoteIndex, 'getMatrix' | 'isReady' | 'whenReady'> | null;
  /** Выбор месяца и года; по умолчанию — общий `createDatePicker`. */
  datePicker?: DatePickerFactory;
}

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
    this.pickerEl = root.createDiv({ cls: 'mp-cal-picker' });
    this.pickerEl.hidden = true;
    this.weekEl = root.createDiv({ cls: 'mp-cal-week' });
    this.bodyEl = root.createDiv({ cls: 'mp-cal-body' });

    this.subscriptions.push(this.deps.dayItems.onChange(() => this.scheduleRender()));
    this.subscriptions.push(this.deps.settings.onChange(() => this.scheduleRender()));
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
    this.dayWatcher?.dispose();
    this.dayWatcher = null;
    this.closePicker();
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
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
          move: (offset) => this.update(moveSelection(this.state, offset), 'month'),
          shift: (delta) => this.update(shiftPeriod(this.state, delta)),
        },
        { language: format.language, maxBars: DEFAULT_MAX_BARS, title: monthYearTitle(format.language, year, month), focusSelected: monthFocus },
      );
      renderDayList(body, model, ctx);
    } else if (state.mode === 'timeline') {
      const previous = this.timelineScroll && this.timelineScroll.date === state.selected ? this.timelineScroll.top : null;
      this.timelineEl = renderTimeline(body, model, ctx, {
        nowMinute: state.selected === state.today ? this.nowMinute() : null,
        strings,
        scrollTop: previous,
      });
      this.timelineScroll = { date: state.selected, top: this.timelineEl.scrollTop };
      const timeline = this.timelineEl;
      timeline.addEventListener('scroll', () => {
        if (this.timelineScroll && this.timelineEl === timeline) this.timelineScroll.top = timeline.scrollTop;
      });
    } else {
      renderDayList(body, model, ctx);
    }

    if (panel) panel.scrollTop = panelScroll;
  }

  private listContext(): DayListContext {
    const matrix = this.deps.index?.getMatrix() ?? null;
    const calendars = new Map((this.deps.cache?.getCalendars() ?? []).map((calendar) => [calendar.calendarId, calendar.title]));
    return {
      isMobile: this.host.platform.isMobile,
      quadrantTitle: (key: QuadrantKey) => matrix?.byKey[key]?.title ?? DEFAULT_QUADRANT_TITLES[this.deps.format.get().language][key],
      calendarTitle: (row: DayListRow) => (row.calendarId ? (calendars.get(row.calendarId) ?? null) : null),
      handlers: {
        open: (item) => this.openItem(item),
        toggle: (item, rowEl) => this.toggleTask(item, rowEl),
        isBusy: (key) => this.busy.has(key),
      },
    };
  }

  // --- Действия ---

  private changeMode(mode: CalendarMode): void {
    if (this.state.mode === mode) return;
    this.closePicker();
    this.settingsMode = mode;
    this.update(setMode(this.state, mode));
    void this.deps.settings.update((draft) => {
      draft.ui.calendarMode = mode;
    });
  }

  private openSourcesMenu(evt: MouseEvent): void {
    const sources = this.sources();
    const menu = new Menu();
    for (const key of SOURCE_KEYS) {
      menu.addItem((item) => {
        item
          .setTitle(t(`calendar.sources.${key}`))
          .setChecked(sources[key])
          .onClick(() => {
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

  private toggleTask(item: TaskDayItem, rowEl: HTMLElement): void {
    // Будущее повторение выполнить нельзя: сервис принимает только текущее (`due`).
    if (this.busy.has(item.key) || (item.projected && !item.completed)) return;
    const request = taskToggleRequest(item);
    this.busy.add(item.key);
    rowEl.addClass('is-busy');
    if (request.op === 'complete') {
      rowEl.addClass('is-completing');
      if (this.host.platform.isAndroid) {
        try {
          navigator.vibrate?.(15);
        } catch {
          // Вибрация необязательна.
        }
      }
    }
    const run = async () => {
      try {
        const result =
          request.op === 'complete'
            ? await this.deps.tasks.complete(request.taskId, request.instanceDate)
            : await this.deps.tasks.uncomplete(request.taskId, request.instanceDate);
        if (!result.ok) {
          this.deps.notifier.show(t(errorMessageKey(result.error)));
          if (result.error.detail) console.warn('[matrix-planner] calendar task operation failed', result.error);
          rowEl.removeClass('is-completing');
        }
      } catch (error) {
        console.error('[matrix-planner] calendar task operation failed', error);
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
