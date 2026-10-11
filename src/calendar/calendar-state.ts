/**
 * Состояние и модели отображения вкладки «Календарь» (ТЗ §4.4).
 * Чистый модуль: без `obsidian` и DOM. «Сегодня», язык и строки приходят параметрами.
 *
 * Состояние — выбранный день, «сегодня» и режим. Месяц заголовка всегда равен месяцу
 * выбранного дня, поэтому режимы «Список / Временная шкала / Месяц» согласованы: смена
 * режима не меняет выбранный день, а «+» получает его в любом режиме.
 */

import type { AddContext } from '../app/contracts';
import type {
  CacheCoverage,
  CalendarCacheState,
  CalendarMode,
  CalendarSourceFilter,
  DateRange,
  DayAgenda,
  DayItem,
  DayItemsByDate,
  EventColor,
  LocalDateString,
  QuadrantKey,
  TaskDayItem,
  WeekStartDay,
} from '../model/types';
import { addDays, addMonthsClamped, daysInMonth, formatDateParts, formatTimeLabel, minutesToTime, parseDateParts, relativeDay } from '../model/dates';
import { EVENT_COLOR_CSS, coverageMessageKey, isAgendaEmpty } from './day-items';
import { cacheNoticeKey } from './cache-schema';
import { buildWeekStrip, shiftWeek, weekRange } from './week-layout';
import { monthGridRange } from './month-layout';
import { MINUTES_PER_DAY, type TimelineBlock } from './timeline-layout';

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

export const CALENDAR_MODES: readonly CalendarMode[] = ['list', 'timeline', 'month'];

export interface CalendarState {
  selected: LocalDateString;
  today: LocalDateString;
  mode: CalendarMode;
}

export function initCalendarState(today: LocalDateString, mode: CalendarMode = 'list', selected?: LocalDateString | null): CalendarState {
  return { today, mode, selected: selected && parseDateParts(selected) ? selected : today };
}

export function selectDate(state: CalendarState, date: LocalDateString): CalendarState {
  if (!parseDateParts(date) || state.selected === date) return state;
  return { ...state, selected: date };
}

/** Кнопка «Сегодня». */
export function goToday(state: CalendarState): CalendarState {
  return selectDate(state, state.today);
}

/** Смена суток: если был выбран прежний «сегодня», выбор переходит на новый. */
export function refreshToday(state: CalendarState, today: LocalDateString): CalendarState {
  if (state.today === today) return state;
  return { ...state, today, selected: state.selected === state.today ? today : state.selected };
}

export function setMode(state: CalendarState, mode: CalendarMode): CalendarState {
  if (state.mode === mode || !CALENDAR_MODES.includes(mode)) return state;
  return { ...state, mode };
}

/** Сдвиг периода: в «Месяце» — на месяцы (день прижимается к концу месяца), иначе — на недели. */
export function shiftPeriod(state: CalendarState, delta: number): CalendarState {
  if (delta === 0) return state;
  const selected = state.mode === 'month' ? addMonthsClamped(state.selected, delta) : shiftWeek(state.selected, delta);
  return { ...state, selected };
}

/** Сдвиг выбранного дня (клавиши-стрелки в ленте и сетке). */
export function moveSelection(state: CalendarState, days: number): CalendarState {
  return days === 0 ? state : { ...state, selected: addDays(state.selected, days) };
}

/** Выбор месяца и года: тот же день месяца, прижатый к его концу. `month` — 1–12. */
export function setMonthYear(state: CalendarState, year: number, month: number): CalendarState {
  const parts = parseDateParts(state.selected);
  if (!parts || month < 1 || month > 12 || !Number.isInteger(year)) return state;
  const day = Math.min(parts.day, daysInMonth(year, month));
  return selectDate(state, formatDateParts({ year, month, day }));
}

/** Год и месяц (1–12) заголовка. */
export function headerMonth(state: CalendarState): { year: number; month: number } {
  const parts = parseDateParts(state.selected);
  return { year: parts?.year ?? 1970, month: parts?.month ?? 1 };
}

/** Диапазон данных для текущего режима: неделя ленты или сетка месяца (всегда включает выбранный день). */
export function visibleRange(state: CalendarState, weekStart: WeekStartDay): DateRange {
  if (state.mode === 'month') {
    const { year, month } = headerMonth(state);
    return monthGridRange(year, month, weekStart);
  }
  return weekRange(state.selected, weekStart);
}

export function showTodayButton(state: CalendarState): boolean {
  return state.selected !== state.today;
}

/** Контекст «+» вкладки: выбранный день передаётся в форму. */
export function addContextFor(state: CalendarState): AddContext {
  return { date: state.selected, quadrant: null };
}

/** Направление свайпа ленты: влево → следующая неделя (+1), вправо → предыдущая (−1). */
export function swipeDirection(dx: number, dy: number, threshold = 40): -1 | 0 | 1 {
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy) * 1.2) return 0;
  return dx < 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Фильтр источников
// ---------------------------------------------------------------------------

export const SOURCE_KEYS = ['tasks', 'events', 'notes', 'external'] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

export function toggleSource(filter: CalendarSourceFilter, key: SourceKey): CalendarSourceFilter {
  return { ...filter, [key]: !filter[key] };
}

/** Фильтр сужен (часть источников скрыта) — значок фильтра выделяется. */
export function isFilterNarrowed(filter: CalendarSourceFilter): boolean {
  return SOURCE_KEYS.some((key) => !filter[key]);
}

// ---------------------------------------------------------------------------
// Цвета и действия элементов
// ---------------------------------------------------------------------------

const EVENT_COLOR_BY_HEX = new Map<string, EventColor>(
  (Object.entries(EVENT_COLOR_CSS) as Array<[EventColor, string]>).map(([key, hex]) => [hex.toLowerCase(), key]),
);

/** CSS-цвет: цвет палитры события → переменная `--mp-event-<цвет>` (под тему), прочее — как есть. */
export function colorCss(color: string): string {
  const key = EVENT_COLOR_BY_HEX.get(color.toLowerCase());
  return key ? `var(--mp-event-${key})` : color;
}

export function itemColorCss(item: Pick<DayItem, 'source' | 'color'>): string {
  return item.source === 'event' ? colorCss(item.color) : item.color;
}

/** Что открыть по нажатию на элемент. */
export type CalendarItemAction =
  | { kind: 'task'; taskId: string }
  | { kind: 'event'; eventId: string }
  | { kind: 'external'; occurrenceKey: string }
  | { kind: 'note'; noteId: string };

export function itemAction(item: DayItem): CalendarItemAction {
  switch (item.source) {
    case 'task':
      return { kind: 'task', taskId: item.taskId };
    case 'event':
      return { kind: 'event', eventId: item.eventId };
    case 'external':
      return { kind: 'external', occurrenceKey: item.occurrenceKey };
    case 'note':
      return { kind: 'note', noteId: item.noteId };
  }
}

/** Выполнение кружком: повторяющейся задаче передаётся дата повторения. */
export interface TaskToggleRequest {
  op: 'complete' | 'uncomplete';
  taskId: string;
  instanceDate: LocalDateString | undefined;
}

export function taskToggleRequest(item: TaskDayItem): TaskToggleRequest {
  return {
    op: item.completed ? 'uncomplete' : 'complete',
    taskId: item.taskId,
    instanceDate: item.recurring ? item.instanceDate : undefined,
  };
}

// ---------------------------------------------------------------------------
// Подписи (Intl без DOM)
// ---------------------------------------------------------------------------

export interface CalendarLabelStrings {
  language: 'ru' | 'en';
  hour12: boolean;
  today: string;
  tomorrow: string;
  yesterday: string;
  am: string;
  pm: string;
}

function formatUtc(language: string, date: LocalDateString, options: Intl.DateTimeFormatOptions): string {
  const parts = parseDateParts(date);
  if (!parts) return date;
  const ms = Date.UTC(parts.year, parts.month - 1, parts.day);
  return new Intl.DateTimeFormat(language, { ...options, timeZone: 'UTC' }).format(new Date(ms));
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value;
}

/** «Октябрь 2026» (именительный падеж, без «г.»). */
export function monthYearTitle(language: string, year: number, month: number): string {
  const date = formatDateParts({ year, month, day: 1 });
  return `${capitalize(formatUtc(language, date, { month: 'long' }))} ${year}`;
}

/** «10 октября» / «October 10». */
export function dayMonthLabel(language: string, date: LocalDateString): string {
  return formatUtc(language, date, { day: 'numeric', month: 'long' });
}

/** Полная дата для экранного диктора. */
export function fullDateLabel(language: string, date: LocalDateString): string {
  return formatUtc(language, date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** Буква дня недели («П», «В»…). */
export function weekdayNarrow(language: string, date: LocalDateString): string {
  return formatUtc(language, date, { weekday: 'narrow' });
}

export function weekdayShort(language: string, date: LocalDateString): string {
  return formatUtc(language, date, { weekday: 'short' });
}

/** Подпись минут дня; конец суток — «24:00». */
export function minuteLabel(minute: number, strings: Pick<CalendarLabelStrings, 'hour12' | 'am' | 'pm'>): string {
  if (minute >= MINUTES_PER_DAY && !strings.hour12) return '24:00';
  return formatTimeLabel(minutesToTime(minute), strings.hour12, strings);
}

/** Заголовок списка: «Сегодня» / «среда» и «10 октября». */
export function dayHeading(date: LocalDateString, today: LocalDateString, strings: CalendarLabelStrings): { title: string; date: string } {
  const rel = relativeDay(date, today);
  const title = rel ? strings[rel] : formatUtc(strings.language, date, { weekday: 'long' });
  return { title, date: dayMonthLabel(strings.language, date) };
}

// ---------------------------------------------------------------------------
// Список дня
// ---------------------------------------------------------------------------

export interface DayListRow {
  key: string;
  item: DayItem;
  source: DayItem['source'];
  title: string;
  /** CSS-цвет точки и плашки. */
  color: string;
  action: CalendarItemAction;
  /** Время начала слева (элементы по времени). */
  timeLabel: string | null;
  /** «9:00–10:00» для событий со временем и задач с длительностью. */
  rangeLabel: string | null;
  allDay: boolean;
  /**
   * Кружок выполнения: только задачи и не вычисленные будущие повторения
   * (выполнить можно лишь текущее повторение — его `due`).
   */
  checkable: boolean;
  completed: boolean;
  overdue: boolean;
  recurring: boolean;
  readOnly: boolean;
  continues: boolean;
  icon: string | null;
  quadrant: QuadrantKey | null;
  calendarId: string | null;
}

export interface DayListModel {
  date: LocalDateString;
  heading: { title: string; date: string };
  /** Число элементов списка (включая заметки). */
  count: number;
  allDay: DayListRow[];
  timed: DayListRow[];
  notes: DayListRow[];
  coverage: CacheCoverage;
  /** Ключ i18n сообщения о покрытии кэша; `null` — не показывать. */
  noticeKey: string | null;
  /** Показывать сообщение пустого дня. */
  empty: boolean;
  /**
   * День пуст, а часть источников скрыта фильтром (доработка 006, §5): вместо пустого дня —
   * «Нет элементов с выбранными фильтрами» и «Показать все».
   */
  filtered: boolean;
}

export function buildRow(item: DayItem, strings: CalendarLabelStrings): DayListRow {
  const timed = !item.allDay && item.startMinute !== null && item.source !== 'note';
  // Задача — диапазоном «18:00–19:30» только с заданной длительностью.
  const showRange = timed && item.endMinute !== null && (item.source !== 'task' || item.duration !== null);
  return {
    key: item.key,
    item,
    source: item.source,
    title: item.title,
    color: itemColorCss(item),
    action: itemAction(item),
    timeLabel: timed ? minuteLabel(item.startMinute as number, strings) : null,
    rangeLabel: showRange ? `${minuteLabel(item.startMinute as number, strings)}–${minuteLabel(item.endMinute as number, strings)}` : null,
    allDay: item.allDay,
    checkable: item.source === 'task' && !item.projected,
    completed: item.source === 'task' && item.completed,
    overdue: item.source === 'task' && item.overdue,
    recurring: (item.source === 'task' || item.source === 'event') && item.recurring,
    readOnly: item.source === 'external' && item.readOnly,
    continues: item.continuesFromPrevious,
    icon: item.icon,
    quadrant: item.source === 'task' ? item.quadrant : null,
    calendarId: item.source === 'event' || item.source === 'external' ? item.calendarId : null,
  };
}

/**
 * Ключ сообщения о покрытии: при известном состоянии кэша — `cacheNoticeKey` (различает
 * отсутствие, повреждение и новую версию), иначе — `coverageMessageKey`. Без источника
 * «Календарь iOS» сообщение не нужно.
 */
export function noticeKeyFor(
  coverage: CacheCoverage,
  sources: CalendarSourceFilter,
  cache: CalendarCacheState | null,
): string | null {
  if (!sources.external) return null;
  return cache ? cacheNoticeKey(cache, coverage) : coverageMessageKey(coverage);
}

export function emptyAgenda(date: LocalDateString, coverage: CacheCoverage = 'no-cache'): DayAgenda {
  return { date, allDay: [], timed: [], notes: [], coverage };
}

/**
 * Модель списка дня. Пустой день и покрытие кэша — разные состояния: вне диапазона кэша
 * «Здесь пока ничего нет» не показывается (события за период неизвестны), а без кэша
 * показываются оба сообщения (локальные данные действительно пусты).
 */
export function buildDayList(params: {
  agenda: DayAgenda | undefined;
  date: LocalDateString;
  today: LocalDateString;
  strings: CalendarLabelStrings;
  sources: CalendarSourceFilter;
  cache: CalendarCacheState | null;
}): DayListModel {
  const agenda = params.agenda ?? emptyAgenda(params.date, params.cache ? coverageOf(params.cache, params.date) : 'no-cache');
  const row = (item: DayItem) => buildRow(item, params.strings);
  const noticeKey = noticeKeyFor(agenda.coverage, params.sources, params.cache);
  const hidesEmpty = noticeKey !== null && agenda.coverage === 'out-of-range';
  return {
    date: params.date,
    heading: dayHeading(params.date, params.today, params.strings),
    count: agenda.allDay.length + agenda.timed.length + agenda.notes.length,
    allDay: agenda.allDay.map(row),
    timed: agenda.timed.map(row),
    notes: agenda.notes.map(row),
    coverage: agenda.coverage,
    noticeKey,
    empty: isAgendaEmpty(agenda) && !hidesEmpty,
    filtered: isAgendaEmpty(agenda) && !hidesEmpty && isFilterNarrowed(params.sources),
  };
}

function coverageOf(cache: CalendarCacheState, date: LocalDateString): CacheCoverage {
  if (cache.status !== 'ok') return 'no-cache';
  return date >= cache.data.range.from && date <= cache.data.range.to ? 'covered' : 'out-of-range';
}

// ---------------------------------------------------------------------------
// Лента недели
// ---------------------------------------------------------------------------

export interface WeekCell {
  date: LocalDateString;
  dayOfMonth: number;
  weekdayLabel: string;
  fullLabel: string;
  isToday: boolean;
  isSelected: boolean;
  /** До 3 CSS-цветов. */
  dots: string[];
  hasNotes: boolean;
  hasCompleted: boolean;
  count: number;
}

export function buildWeekCells(params: {
  selected: LocalDateString;
  today: LocalDateString;
  weekStart: WeekStartDay;
  days: DayItemsByDate;
  language: string;
}): WeekCell[] {
  return buildWeekStrip(params).map((day) => ({
    date: day.date,
    dayOfMonth: day.dayOfMonth,
    weekdayLabel: weekdayNarrow(params.language, day.date),
    fullLabel: fullDateLabel(params.language, day.date),
    isToday: day.isToday,
    isSelected: day.isSelected,
    dots: day.summary.dots.map(colorCss),
    hasNotes: day.summary.hasNotes,
    hasCompleted: day.summary.hasCompletedTasks,
    count: day.summary.count,
  }));
}

// ---------------------------------------------------------------------------
// Временная шкала
// ---------------------------------------------------------------------------

/** Положение блока в процентах высоты суток и ширины колонки. */
export interface TimelineGeometry {
  top: number;
  height: number;
  left: number;
  width: number;
}

export function timelineGeometry(block: Pick<TimelineBlock, 'startMinute' | 'endMinute' | 'column' | 'columns'>): TimelineGeometry {
  const columns = Math.max(1, block.columns);
  return {
    top: (block.startMinute / MINUTES_PER_DAY) * 100,
    height: (Math.max(0, block.endMinute - block.startMinute) / MINUTES_PER_DAY) * 100,
    left: (block.column / columns) * 100,
    width: 100 / columns,
  };
}

/** Минута, к которой прокрутить шкалу: сейчас (сегодня), иначе первое событие, иначе 8:00; с запасом 30 минут. */
export function initialScrollMinute(timed: readonly Pick<DayItem, 'startMinute'>[], nowMinute: number | null): number {
  const first = timed.reduce<number | null>((min, item) => (item.startMinute === null ? min : min === null ? item.startMinute : Math.min(min, item.startMinute)), null);
  const target = nowMinute ?? first ?? 8 * 60;
  return Math.max(0, target - 30);
}

// ---------------------------------------------------------------------------
// Скрытие элементов, ожидающих удаления (доработка 006, §12)
// ---------------------------------------------------------------------------

/** id заметки элемента (задача, событие, заметка); внешнее событие — `null`. */
export function itemNoteId(item: DayItem): string | null {
  switch (item.source) {
    case 'task':
      return item.taskId;
    case 'event':
      return item.eventId;
    case 'note':
      return item.noteId;
    default:
      return null;
  }
}

/** Дни без элементов, удаление которых ожидает «Вернуть» (без изменений — тот же объект). */
export function hideItems(days: DayItemsByDate, hidden: (id: string) => boolean): DayItemsByDate {
  const keep = (item: DayItem): boolean => {
    const id = itemNoteId(item);
    return id === null || !hidden(id);
  };
  let changed = false;
  const result = new Map<LocalDateString, DayAgenda>();
  for (const [date, agenda] of days) {
    const allDay = agenda.allDay.filter(keep);
    const timed = agenda.timed.filter(keep);
    const notes = agenda.notes.filter(keep);
    if (allDay.length !== agenda.allDay.length || timed.length !== agenda.timed.length || notes.length !== agenda.notes.length) {
      changed = true;
      result.set(date, { ...agenda, allDay, timed, notes });
    } else {
      result.set(date, agenda);
    }
  }
  return changed ? result : days;
}
