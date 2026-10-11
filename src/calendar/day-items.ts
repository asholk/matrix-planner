/**
 * Сборка элементов дней для календаря и обоев (ТЗ §3.3–3.5, §4.4).
 *
 * Чистый модуль: без `obsidian` и DOM; «сегодня» и зона устройства приходят во входе.
 * Источники: задачи (с вычисленными будущими повторениями), события-заметки, быстрые заметки
 * с `date`, события кэша «Календаря» iOS. Событие кэша, связанное с заметкой, второй раз не показывается.
 *
 * Видимость календарей:
 * - «Планировщик» — флаг `planner` или его календарь на сервере (календарь для записи
 *   синхронизации, `plannerCalendarId`) в списке: это один календарь, а не два;
 * - событие-заметка без `calendar_id` или в календаре «Планировщика» — как «Планировщик»;
 * - событие-заметка с другим `calendar_id` — если календарь выбран в «Показываемых календарях»
 *   или включён «Планировщик» (это всё равно заметка Планировщика);
 * - событие кэша — календарь «Планировщика» как «Планировщик», «Дни рождения» по флагу
 *   `birthdays` или по списку, прочие — по списку.
 */

import type {
  CacheCoverage,
  CachedCalendar,
  CachedCalendarEvent,
  CalendarCacheState,
  CalendarSourceFilter,
  DateRange,
  DayAgenda,
  DayItem,
  DayItemsByDate,
  DayItemsInput,
  DaySummary,
  EventColor,
  EventDayItem,
  ExternalDayItem,
  ItemId,
  LocalDateString,
  MatrixConfig,
  NoteDayItem,
  OpResult,
  PlannerEvent,
  PlannerSettings,
  QuadrantKey,
  Task,
  TaskDayItem,
  TombstoneRecord,
  Unsubscribe,
  VisibleCalendarsSetting,
} from '../model/types';
import { QUADRANT_KEYS } from '../model/types';
import type { CalendarCacheReader, Clock, DayItemsBuilder, DayItemsOptions, DayItemsProvider, NoteIndex, SettingsStore } from '../app/contracts';
import { addDays, datesInRange, floatingFromDate, isValidTimeZone, timeToMinutes } from '../model/dates';
import { DEFAULT_TASK_DURATION, effectiveDuration, isValidDuration } from '../model/duration';
import { DEFAULT_QUADRANT_STYLE } from '../model/defaults';
import { canonicalId } from '../model/ids';
import { occurrencesInRange } from '../model/recurrence';
import { expandEventOccurrences, spanIntersects, splitSpanByDays, type DayPiece, type TimeSpan } from './event-occurrences';
import { partitionCacheEvents, shouldUseCacheOccurrences, uniqueByKey } from './deduplicate';

// ---------------------------------------------------------------------------
// Константы оформления
// ---------------------------------------------------------------------------

/** CSS-цвета палитры событий (системные цвета iOS). */
export const EVENT_COLOR_CSS: Readonly<Record<EventColor, string>> = {
  blue: '#007AFF',
  red: '#FF3B30',
  orange: '#FF9500',
  yellow: '#FFCC00',
  green: '#34C759',
  teal: '#30B0C7',
  sky: '#5AC8FA',
  purple: '#AF52DE',
};

/** Серая точка заметок. */
export const NOTE_DOT_COLOR = '#8E8E93';

/** Цвет события из неизвестного календаря. */
export const EXTERNAL_FALLBACK_COLOR = '#8E8E93';

/** Длительность задачи со временем без свойства `duration` (как в «Календаре» iOS). */
export const TASK_DURATION_MINUTES = DEFAULT_TASK_DURATION;

/** Максимум цветных точек под днём. */
export const MAX_DAY_DOTS = 3;

/** Ключи i18n модуля `calendar-model` (словари — `src/i18n/{ru,en}/calendar-model.ts`). */
export const CALENDAR_MODEL_KEYS = {
  coverage: {
    'no-cache': 'calendar-model.coverage.noCache',
    'out-of-range': 'calendar-model.coverage.outOfRange',
  },
  emptyDay: 'calendar-model.emptyDay',
  emptyDayDesktop: 'calendar-model.emptyDayDesktop',
  itemCount: 'calendar-model.itemCount',
  allDayBlock: 'calendar-model.blocks.allDay',
  notesBlock: 'calendar-model.blocks.notes',
  more: 'calendar-model.more',
} as const;

/** Ключ сообщения о покрытии кэша; `null` — день покрыт. */
export function coverageMessageKey(coverage: CacheCoverage): string | null {
  return coverage === 'covered' ? null : CALENDAR_MODEL_KEYS.coverage[coverage];
}

// ---------------------------------------------------------------------------
// Покрытие кэша и видимость календарей
// ---------------------------------------------------------------------------

/** Покрытие дня кэшем: нет (или нечитаемый) кэш → «нет компаньона»; вне диапазона → «не загружено». */
export function cacheCoverageFor(cache: CalendarCacheState, date: LocalDateString): CacheCoverage {
  if (cache.status !== 'ok') return 'no-cache';
  const { from, to } = cache.data.range;
  return date >= from && date <= to ? 'covered' : 'out-of-range';
}

/** «Планировщик» показывается: флаг или его календарь на сервере в «Показываемых календарях». */
export function isPlannerVisible(visible: VisibleCalendarsSetting, plannerCalendarId: string | null = null): boolean {
  return visible.planner || (plannerCalendarId !== null && visible.calendarIds.includes(plannerCalendarId));
}

export function isEventCalendarVisible(
  calendarId: string | null,
  visible: VisibleCalendarsSetting,
  plannerCalendarId: string | null = null,
): boolean {
  if (calendarId === null || calendarId === plannerCalendarId) return isPlannerVisible(visible, plannerCalendarId);
  return visible.planner || visible.calendarIds.includes(calendarId);
}

export function isExternalCalendarVisible(
  calendarId: string,
  calendar: CachedCalendar | undefined,
  visible: VisibleCalendarsSetting,
  plannerCalendarId: string | null = null,
): boolean {
  if (calendarId === plannerCalendarId) return isPlannerVisible(visible, plannerCalendarId);
  if (visible.calendarIds.includes(calendarId)) return true;
  return calendar?.kind === 'birthdays' && visible.birthdays;
}

/** Ключ элемента без даты дня: общий у частей многодневного события. */
export function itemSpanKey(item: Pick<DayItem, 'key'>): string {
  const at = item.key.lastIndexOf('@');
  return at < 0 ? item.key : item.key.slice(0, at);
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

function quadrantColor(matrix: MatrixConfig, key: QuadrantKey): string {
  return matrix.byKey[key]?.color ?? DEFAULT_QUADRANT_STYLE[key].color;
}

function pieceFields(piece: DayPiece) {
  return {
    date: piece.date,
    allDay: piece.allDay,
    startMinute: piece.startMinute,
    endMinute: piece.endMinute,
    continuesFromPrevious: piece.continuesFromPrevious,
    continuesToNext: piece.continuesToNext,
  };
}

function inRange(date: LocalDateString, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

function taskItem(task: Task, instanceDate: LocalDateString, input: DayItemsInput, flags: { projected: boolean; completed: boolean }): TaskDayItem {
  const time = task.due?.time ?? null;
  const startMinute = time === null ? null : timeToMinutes(time);
  const duration = isValidDuration(task.duration) ? task.duration : null;
  return {
    key: `task:${task.id}:${instanceDate}@${instanceDate}`,
    source: 'task',
    date: instanceDate,
    title: task.title,
    allDay: startMinute === null,
    startMinute,
    endMinute: startMinute === null ? null : Math.min(1440, startMinute + effectiveDuration(duration)),
    continuesFromPrevious: false,
    continuesToNext: false,
    color: quadrantColor(input.matrix, task.quadrant),
    icon: null,
    taskId: task.id,
    quadrant: task.quadrant,
    priority: task.priority,
    duration,
    instanceDate,
    projected: flags.projected,
    recurring: task.repeat !== 'none',
    completed: flags.completed,
    overdue: !flags.completed && instanceDate < input.today,
  };
}

/** Элементы задач: текущий `due`, будущие повторения и выполненные повторения из `completions`. */
export function buildTaskItems(task: Task, input: DayItemsInput): TaskDayItem[] {
  const range = input.range;
  const result: TaskDayItem[] = [];
  if (task.repeat === 'none') {
    if (!task.due || !inRange(task.due.date, range)) return result;
    if (task.done && !input.includeCompleted) return result;
    result.push(taskItem(task, task.due.date, input, { projected: false, completed: task.done }));
    return result;
  }

  const completions = new Set(task.completions);
  if (input.includeCompleted) {
    for (const date of task.completions) {
      if (inRange(date, range)) result.push(taskItem(task, date, input, { projected: false, completed: true }));
    }
  }
  if (!task.due) return result;
  const due = task.due.date;
  const anchor = task.repeatAnchor ?? due;
  const pending = new Set<LocalDateString>();
  if (inRange(due, range)) pending.add(due);
  for (const date of occurrencesInRange(task.repeat, anchor, range, { notBefore: addDays(due, 1) })) pending.add(date);
  for (const date of [...pending].sort()) {
    if (completions.has(date)) continue;
    result.push(taskItem(task, date, input, { projected: date !== due, completed: false }));
  }
  return result;
}

function eventItemsFromSpan(
  event: PlannerEvent,
  span: TimeSpan,
  occurrenceStart: EventDayItem['occurrenceStart'],
  range: DateRange,
  title: string = event.title,
): EventDayItem[] {
  const occurrenceId = `${occurrenceStart.date}T${occurrenceStart.time ?? ''}`;
  return splitSpanByDays(span, range).map((piece) => ({
      key: `event:${event.id}:${occurrenceId}@${piece.date}`,
      source: 'event' as const,
      title,
      ...pieceFields(piece),
      color: EVENT_COLOR_CSS[event.color] ?? EVENT_COLOR_CSS.blue,
      icon: event.icon,
      eventId: event.id,
      calendarId: event.calendarId,
      recurring: event.repeat !== 'none',
      occurrenceStart,
    }));
}

function cacheSpan(event: CachedCalendarEvent): TimeSpan {
  return { start: event.start, end: event.end, allDay: event.allDay };
}

/** Элементы события-заметки; при свежем кэше повторения внутри его диапазона берутся из кэша. */
export function buildEventItems(
  event: PlannerEvent,
  input: DayItemsInput,
  linked: readonly CachedCalendarEvent[] | undefined,
): EventDayItem[] {
  const range = input.range;
  const timeZone = isValidTimeZone(input.timeZone) ? input.timeZone : 'UTC';
  const cache = input.cache.status === 'ok' ? input.cache.data : null;
  const useCache = cache !== null && shouldUseCacheOccurrences(event, linked, cache);
  const result: EventDayItem[] = [];

  // Свежий кэш — источник истины для повторений, пересекающих его диапазон
  // (в том числе начавшихся до его начала): чего в кэше нет, то удалено в «Календаре» iOS.
  for (const occurrence of expandEventOccurrences(event, range, timeZone)) {
    if (useCache && cache && spanIntersects(occurrence.span, cache.range)) continue;
    result.push(...eventItemsFromSpan(event, occurrence.span, occurrence.occurrenceStart, range));
  }
  if (useCache && cache && linked) {
    for (const cached of linked) {
      const span = cacheSpan(cached);
      if (!spanIntersects(span, cache.range)) continue;
      // Изменённое в iOS повторение: время и название из кэша, цвет и значок — заметки.
      const title = cached.title.trim() !== '' ? cached.title : event.title;
      result.push(...eventItemsFromSpan(event, span, cached.start, range, title));
    }
  }
  return result;
}

/** Элементы внешнего события кэша. */
export function buildExternalItems(
  event: CachedCalendarEvent,
  calendar: CachedCalendar | undefined,
  range: DateRange,
): ExternalDayItem[] {
  return splitSpanByDays(cacheSpan(event), range).map((piece) => ({
      key: `external:${event.occurrenceKey}@${piece.date}`,
      source: 'external' as const,
      title: event.title,
      ...pieceFields(piece),
      color: calendar?.color ?? EXTERNAL_FALLBACK_COLOR,
      icon: null,
      calendarId: event.calendarId,
      occurrenceKey: event.occurrenceKey,
      eventId: event.eventId,
      readOnly: !(calendar?.allowsModifications ?? false),
    }));
}

function noteItem(note: { id: ItemId; title: string }, date: LocalDateString): NoteDayItem {
  return {
    key: `note:${note.id}@${date}`,
    source: 'note',
    date,
    title: note.title,
    allDay: false,
    startMinute: null,
    endMinute: null,
    continuesFromPrevious: false,
    continuesToNext: false,
    color: NOTE_DOT_COLOR,
    icon: null,
    noteId: note.id,
  };
}

// ---------------------------------------------------------------------------
// Порядок внутри блоков
// ---------------------------------------------------------------------------

function compareText(a: string, b: string): number {
  return a.localeCompare(b);
}

function taskRank(item: DayItem): [number, number] {
  if (item.source !== 'task') return [0, 0];
  return [QUADRANT_KEYS.indexOf(item.quadrant), item.priority === 'high' ? 0 : 1];
}

function isCompleted(item: DayItem): boolean {
  return item.source === 'task' && item.completed;
}

/** «Весь день»: невыполненное раньше; события (продолжения — первыми), затем задачи по квадранту и приоритету. */
export function compareAllDay(a: DayItem, b: DayItem): number {
  const done = Number(isCompleted(a)) - Number(isCompleted(b));
  if (done !== 0) return done;
  const kind = Number(a.source === 'task') - Number(b.source === 'task');
  if (kind !== 0) return kind;
  const cont = Number(b.continuesFromPrevious) - Number(a.continuesFromPrevious);
  if (cont !== 0) return cont;
  const [qa, pa] = taskRank(a);
  const [qb, pb] = taskRank(b);
  if (qa !== qb) return qa - qb;
  if (pa !== pb) return pa - pb;
  return compareText(a.title, b.title) || compareText(a.key, b.key);
}

/** Элементы по времени: начало, затем более длинные, затем название. */
export function compareTimed(a: DayItem, b: DayItem): number {
  const start = (a.startMinute ?? 0) - (b.startMinute ?? 0);
  if (start !== 0) return start;
  const end = (b.endMinute ?? 0) - (a.endMinute ?? 0);
  if (end !== 0) return end;
  const done = Number(isCompleted(a)) - Number(isCompleted(b));
  if (done !== 0) return done;
  return compareText(a.title, b.title) || compareText(a.key, b.key);
}

// ---------------------------------------------------------------------------
// Основная функция
// ---------------------------------------------------------------------------

/** Сборка элементов дней диапазона по блокам ТЗ §4.4. Дни без элементов тоже присутствуют. */
export const buildDayItems: DayItemsBuilder = (input) => {
  const result = new Map<LocalDateString, DayAgenda>();
  const { range, sources } = input;
  if (range.from > range.to) return result;

  const buckets = new Map<LocalDateString, DayItem[]>();
  for (const date of datesInRange(range.from, range.to)) buckets.set(date, []);
  const add = (item: DayItem) => buckets.get(item.date)?.push(item);

  if (sources.tasks) {
    for (const task of input.tasks) for (const item of buildTaskItems(task, input)) add(item);
  }

  const cacheData = input.cache.status === 'ok' ? input.cache.data : null;
  const knownIds = new Set<ItemId>();
  const eventIds = new Set<ItemId>();
  for (const task of input.tasks) knownIds.add(task.id);
  for (const note of input.notes) knownIds.add(note.id);
  for (const event of input.events) {
    knownIds.add(event.id);
    eventIds.add(event.id);
  }
  const partition = cacheData
    ? partitionCacheEvents(cacheData.events, knownIds, eventIds)
    : { external: [], linkedToEvents: new Map<ItemId, CachedCalendarEvent[]>(), hiddenLinked: 0 };

  const plannerCalendarId = input.plannerCalendarId ?? null;
  if (sources.events) {
    for (const event of input.events) {
      if (event.deletedInCalendar) continue;
      if (!isEventCalendarVisible(event.calendarId, input.visibleCalendars, plannerCalendarId)) continue;
      for (const item of buildEventItems(event, input, partition.linkedToEvents.get(event.id))) add(item);
    }
  }

  if (sources.external && cacheData) {
    const calendars = new Map(cacheData.calendars.map((calendar) => [calendar.calendarId, calendar]));
    for (const event of partition.external) {
      const calendar = calendars.get(event.calendarId);
      if (!isExternalCalendarVisible(event.calendarId, calendar, input.visibleCalendars, plannerCalendarId)) continue;
      for (const item of buildExternalItems(event, calendar, range)) add(item);
    }
  }

  if (sources.notes) {
    for (const note of input.notes) {
      if (note.date !== null && inRange(note.date, range)) add(noteItem(note, note.date));
    }
  }

  for (const [date, items] of buckets) {
    const unique = uniqueByKey(items);
    const allDay: DayItem[] = [];
    const timed: DayItem[] = [];
    const notes: NoteDayItem[] = [];
    for (const item of unique) {
      if (item.source === 'note') notes.push(item);
      else if (item.allDay || item.startMinute === null) allDay.push(item);
      else timed.push(item);
    }
    allDay.sort(compareAllDay);
    timed.sort(compareTimed);
    notes.sort((a, b) => compareText(a.title, b.title) || compareText(a.key, b.key));
    result.set(date, { date, allDay, timed, notes, coverage: cacheCoverageFor(input.cache, date) });
  }
  return result;
};

/** Все элементы дня в порядке списка: «Весь день», по времени, «Заметки». */
export function agendaItems(agenda: DayAgenda): DayItem[] {
  return [...agenda.allDay, ...agenda.timed, ...agenda.notes];
}

/** Пустой день (без учёта покрытия кэша: сообщение о покрытии показывается отдельно). */
export function isAgendaEmpty(agenda: DayAgenda): boolean {
  return agenda.allDay.length === 0 && agenda.timed.length === 0 && agenda.notes.length === 0;
}

/** Сводка дня: до 3 разных цветов невыполненных элементов, серая точка заметок, галочка выполненных. */
export function summarizeDay(agenda: DayAgenda | undefined, date?: LocalDateString): DaySummary {
  const summary: DaySummary = {
    date: agenda?.date ?? date ?? '',
    dots: [],
    hasNotes: false,
    hasCompletedTasks: false,
    count: 0,
  };
  if (!agenda) return summary;
  for (const item of [...agenda.allDay, ...agenda.timed]) {
    summary.count++;
    if (isCompleted(item)) {
      summary.hasCompletedTasks = true;
      continue;
    }
    if (summary.dots.length < MAX_DAY_DOTS && !summary.dots.includes(item.color)) summary.dots.push(item.color);
  }
  summary.hasNotes = agenda.notes.length > 0;
  return summary;
}

// ---------------------------------------------------------------------------
// Провайдер для UI и обоев
// ---------------------------------------------------------------------------

/** Зависимости провайдера — только интерфейсы (реализации подключает сборка). */
export interface DayItemsProviderDeps {
  index: Pick<NoteIndex, 'getTasks' | 'getEvents' | 'getNotes' | 'getMatrix' | 'onChange'>;
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  cache: Pick<CalendarCacheReader, 'getState' | 'onChange'>;
  clock: Clock;
  /**
   * Метки удаления (`tombstones.json`, необязательно). Запись кэша, связанная с удалённой
   * заметкой, которой уже нет в индексе, не показывается как внешнее событие, пока компаньон
   * не удалит событие из «Календаря» iOS и не перепишет кэш.
   */
  tombstones?: TombstoneSource;
  /** `calendar_id` календаря «Планировщика» на сервере (см. `DayItemsInput.plannerCalendarId`). */
  plannerCalendarId?: () => string | null;
  /** Подмена сборки (тесты). */
  build?: DayItemsBuilder;
}

/** Источник меток удаления: `TombstoneWriter.list` и (необязательно) подписка на изменения. */
export interface TombstoneSource {
  list(): Promise<OpResult<readonly TombstoneRecord[]>> | OpResult<readonly TombstoneRecord[]>;
  onChange?(listener: () => void): Unsubscribe;
}

const EMPTY_IDS: ReadonlySet<ItemId> = new Set<ItemId>();

/** Состояние кэша без записей, связанных с удалёнными заметками, которых нет среди известных. */
export function withoutTombstoned(
  cache: CalendarCacheState,
  deletedIds: ReadonlySet<ItemId>,
  knownIds: ReadonlySet<ItemId>,
): CalendarCacheState {
  if (cache.status !== 'ok' || deletedIds.size === 0) return cache;
  const isGone = (event: CachedCalendarEvent) =>
    event.linkedItemId !== null && deletedIds.has(event.linkedItemId) && !knownIds.has(event.linkedItemId);
  if (!cache.data.events.some(isGone)) return cache;
  return { ...cache, data: { ...cache.data, events: cache.data.events.filter((event) => !isGone(event)) } };
}

/** Источники и календари обоев: без заметок; `wallpaper.calendarIds` заменяет список календарей. */
export function wallpaperFilters(
  settings: Readonly<PlannerSettings>,
  calendarIds?: readonly string[] | null,
): {
  sources: CalendarSourceFilter;
  visibleCalendars: VisibleCalendarsSetting;
} {
  const visible = settings.visibleCalendars;
  const ids = calendarIds === undefined ? settings.wallpaper.calendarIds : calendarIds;
  return {
    sources: { tasks: true, events: true, notes: false, external: true },
    visibleCalendars: ids === null ? visible : { planner: visible.planner, birthdays: false, calendarIds: [...ids] },
  };
}

export class PlannerDayItemsProvider implements DayItemsProvider {
  private readonly listeners = new Set<() => void>();
  private unsubscribes: Unsubscribe[] = [];
  private deletedIds: ReadonlySet<ItemId> = EMPTY_IDS;
  private tombstonesLoaded = false;
  /** Номер последнего запроса меток: устаревшие ответы отбрасываются. */
  private tombstonesSeq = 0;

  constructor(private readonly deps: DayItemsProviderDeps) {}

  /** Перечитывает метки удаления; при изменении набора оповещает слушателей. */
  async refreshTombstones(): Promise<void> {
    const source = this.deps.tombstones;
    if (!source) return;
    const seq = ++this.tombstonesSeq;
    this.tombstonesLoaded = true;
    let listed: OpResult<readonly TombstoneRecord[]>;
    try {
      listed = await source.list();
    } catch {
      return;
    }
    // Ошибка чтения — оставляем прежний набор.
    if (seq !== this.tombstonesSeq || !listed.ok) return;
    const next = new Set(listed.value.map((record) => canonicalId(record.id)));
    if (next.size === this.deletedIds.size && [...next].every((id) => this.deletedIds.has(id))) return;
    this.deletedIds = next;
    this.notify();
  }

  /** Перечитывает метки удаления, чтобы синхронный `getDays` их учёл. */
  async prepare(): Promise<void> {
    await this.refreshTombstones();
  }

  getDays(range: DateRange, options: DayItemsOptions = {}): DayItemsByDate {
    const settings = this.deps.settings.get();
    const forWallpaper = options.forWallpaper ?? false;
    const filters = forWallpaper
      ? wallpaperFilters(settings, options.calendarIds)
      : { sources: settings.ui.calendarSources, visibleCalendars: settings.visibleCalendars };
    const timeZone = this.deps.clock.timeZone();
    const zone = isValidTimeZone(timeZone) ? timeZone : undefined;
    if (this.deps.tombstones && !this.tombstonesLoaded) void this.refreshTombstones();
    const tasks = this.deps.index.getTasks();
    const events = this.deps.index.getEvents();
    const notes = this.deps.index.getNotes();
    let cache = this.deps.cache.getState();
    if (this.deletedIds.size > 0) {
      const known = new Set<ItemId>();
      for (const item of [...tasks, ...events, ...notes]) known.add(item.id);
      cache = withoutTombstoned(cache, this.deletedIds, known);
    }
    const input: DayItemsInput = {
      range,
      today: floatingFromDate(this.deps.clock.now(), zone).date,
      timeZone: zone ?? 'UTC',
      tasks,
      events,
      notes,
      cache,
      matrix: this.deps.index.getMatrix(),
      sources: filters.sources,
      visibleCalendars: filters.visibleCalendars,
      plannerCalendarId: this.deps.plannerCalendarId?.() ?? null,
      includeCompleted: options.includeCompleted ?? !forWallpaper,
    };
    return (this.deps.build ?? buildDayItems)(input);
  }

  /** Подписка на источники создаётся с первым слушателем и снимается с последним. */
  onChange(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.subscribe();
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.unsubscribe();
    };
  }

  /** Снимает все подписки (выгрузка плагина). */
  dispose(): void {
    this.listeners.clear();
    this.unsubscribe();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private subscribe(): void {
    const notify = () => this.notify();
    const tombstones = this.deps.tombstones;
    this.unsubscribes = [
      this.deps.index.onChange(() => {
        // Удаление заметки обычно идёт после записи метки — перечитываем метки.
        if (tombstones) void this.refreshTombstones();
        notify();
      }),
      this.deps.settings.onChange(notify),
      this.deps.cache.onChange(notify),
    ];
    if (tombstones?.onChange) this.unsubscribes.push(tombstones.onChange(() => void this.refreshTombstones()));
    if (tombstones) void this.refreshTombstones();
  }

  private unsubscribe(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
  }
}
