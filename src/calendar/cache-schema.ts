/**
 * Схема `_system/calendar-cache.json` (ТЗ §5.4.4) и её нормализация в `CalendarCacheData`.
 *
 * Чистый модуль: не импортирует `obsidian` и DOM. Часовой пояс устройства и текущее
 * время передаются параметрами. Внешний формат файла — docs/system-json.md.
 *
 * Правила:
 *  - нет объекта верхнего уровня, `version`, `generated_at` или `range` → `corrupt`;
 *  - `version` больше поддерживаемой → `unsupported-version` (данные не читаются);
 *  - отдельные битые календари и события пропускаются, остальные читаются;
 *  - неизвестные поля игнорируются (совместимость внутри версии).
 */

import type {
  CacheCoverage,
  CachedCalendar,
  CachedCalendarEvent,
  CachedCalendarKind,
  CalendarCacheData,
  CalendarCacheState,
  DateRange,
  FloatingDateTime,
  ItemId,
  LocalDateString,
} from '../model/types';
import { addDays, compareDates, floatingFromDate, isDateInRange, isValidDate, isValidTimeZone } from '../model/dates';
import { canonicalId, isUlid } from '../model/ids';

/** Поддерживаемая версия формата кэша. */
export const CALENDAR_CACHE_VERSION = 1;

/** Кэш старше этого порога считается устаревшим (флаг `stale`, данные показываются). */
export const DEFAULT_CACHE_STALE_MS = 48 * 60 * 60 * 1000;

/** Ссылка на заметку в поле URL события EventKit. */
export const ITEM_URL_PREFIX = 'matrixplanner://item/';

const CALENDAR_KINDS: readonly CachedCalendarKind[] = ['local', 'caldav', 'exchange', 'subscription', 'birthdays', 'other'];
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const SHORT_HEX_RE = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const DEFAULT_CALENDAR_COLOR = '#8e8e93';
/** `YYYY-MM-DDTHH:mm[:ss[.fff]]` + необязательное смещение `Z`/`±HH:mm`. */
const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

// ---------------------------------------------------------------------------
// Внешний формат (snake_case, как в файле)
// ---------------------------------------------------------------------------

/** Календарь в файле. */
export interface CalendarCacheFileCalendar {
  calendar_id: string;
  title: string;
  color: string;
  kind?: CachedCalendarKind;
  allows_modifications: boolean;
}

/** Повторение события в файле. Каждое повторение — отдельная запись. */
export interface CalendarCacheFileEvent {
  id: string;
  calendar_id: string;
  title: string;
  all_day: boolean;
  /** allDay: `YYYY-MM-DD`; иначе ISO 8601 со смещением. */
  start: string;
  /** allDay: `YYYY-MM-DD` исключительно; иначе ISO 8601 со смещением. */
  end: string;
  recurrence?: string | null;
  item_id?: string | null;
  location?: string | null;
  url?: string | null;
  notes?: string | null;
}

export interface CalendarCacheFile {
  version: number;
  generated_at: string;
  device_name?: string | null;
  time_zone?: string | null;
  range: { from: string; to: string };
  calendars: CalendarCacheFileCalendar[];
  events: CalendarCacheFileEvent[];
}

// ---------------------------------------------------------------------------
// Разбор
// ---------------------------------------------------------------------------

export type ParsedCalendarCache =
  | { status: 'corrupt'; detail: string }
  | { status: 'unsupported-version'; version: number }
  | { status: 'ok'; data: CalendarCacheData; /** Сколько записей пропущено как битые. */ skipped: number };

export interface ParseCalendarCacheOptions {
  /** IANA-зона устройства; пустая или неизвестная — локальная зона среды. */
  timeZone: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && DATE_TIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function normalizeColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CALENDAR_COLOR;
  const trimmed = value.trim();
  if (HEX_COLOR_RE.test(trimmed)) return trimmed.toLowerCase();
  const short = SHORT_HEX_RE.exec(trimmed);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return DEFAULT_CALENDAR_COLOR;
}

function normalizeKind(value: unknown): CachedCalendarKind {
  return CALENDAR_KINDS.includes(value as CachedCalendarKind) ? (value as CachedCalendarKind) : 'other';
}

/** `id` заметки из явного `item_id` или из URL `matrixplanner://item/<id>`. */
export function linkedItemIdOf(itemId: unknown, url: unknown): ItemId | null {
  if (typeof itemId === 'string' && isUlid(canonicalId(itemId))) return canonicalId(itemId);
  if (typeof url === 'string' && url.startsWith(ITEM_URL_PREFIX)) {
    const candidate = canonicalId(url.slice(ITEM_URL_PREFIX.length).split(/[/?#]/)[0] ?? '');
    if (isUlid(candidate)) return candidate;
  }
  return null;
}

function parseCalendar(raw: unknown): CachedCalendar | null {
  if (!isRecord(raw)) return null;
  const calendarId = optionalString(raw['calendar_id']);
  if (!calendarId) return null;
  return {
    calendarId,
    title: typeof raw['title'] === 'string' ? raw['title'] : '',
    color: normalizeColor(raw['color']),
    kind: normalizeKind(raw['kind']),
    // Нет явного разрешения — только чтение (безопасное значение).
    allowsModifications: raw['allows_modifications'] === true,
  };
}

interface TimedPoint {
  floating: FloatingDateTime;
  ms: number;
}

/** Время события: со смещением — переводится в зону устройства; без смещения — плавающее. */
function parseTimedPoint(value: unknown, timeZone: string | undefined): TimedPoint | null {
  if (typeof value !== 'string') return null;
  const match = DATE_TIME_RE.exec(value);
  if (!match) return null;
  const [, date = '', hh = '', mm = '', , offset] = match;
  if (!isValidDate(date)) return null;
  const hours = Number(hh);
  const minutes = Number(mm);
  if (hours > 23 || minutes > 59) return null;
  if (offset) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return null;
    return { floating: floatingFromDate(new Date(ms), timeZone), ms };
  }
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const ms = new Date(y, m - 1, d, hours, minutes).getTime();
  return { floating: { date, time: `${hh}:${mm}` }, ms };
}

function occurrenceKeyOf(eventId: string, start: FloatingDateTime, startMs: number | null): string {
  return startMs === null ? `${eventId}@${start.date}` : `${eventId}@${new Date(startMs).toISOString()}`;
}

function parseEvent(raw: unknown, timeZone: string | undefined): CachedCalendarEvent | null {
  if (!isRecord(raw)) return null;
  const eventId = optionalString(raw['id']);
  const calendarId = optionalString(raw['calendar_id']);
  if (!eventId || !calendarId) return null;
  const allDay = raw['all_day'] === true;
  const base = {
    eventId,
    calendarId,
    title: typeof raw['title'] === 'string' ? raw['title'] : '',
    allDay,
    recurrenceText: optionalString(raw['recurrence']),
    linkedItemId: linkedItemIdOf(raw['item_id'], raw['url']),
    location: optionalString(raw['location']),
    url: optionalString(raw['url']),
    notes: optionalString(raw['notes']),
  };

  if (allDay) {
    // Допускаем и дату-время: берётся только дата.
    const startDate = typeof raw['start'] === 'string' ? raw['start'].slice(0, 10) : '';
    if (!isValidDate(startDate)) return null;
    const endRaw = typeof raw['end'] === 'string' ? raw['end'].slice(0, 10) : '';
    // `end` исключительный: пустой или не позже начала — однодневное событие.
    const endDate = isValidDate(endRaw) && compareDates(endRaw, startDate) > 0 ? endRaw : addDays(startDate, 1);
    const start = { date: startDate, time: null };
    return {
      ...base,
      occurrenceKey: occurrenceKeyOf(eventId, start, null),
      start,
      end: { date: endDate, time: null },
      startMs: null,
      endMs: null,
    };
  }

  const start = parseTimedPoint(raw['start'], timeZone);
  if (!start) return null;
  const parsedEnd = parseTimedPoint(raw['end'], timeZone);
  // Конец раньше начала или нет конца — нулевая длительность.
  const end = parsedEnd && parsedEnd.ms >= start.ms ? parsedEnd : start;
  return {
    ...base,
    occurrenceKey: occurrenceKeyOf(eventId, start.floating, start.ms),
    start: start.floating,
    end: end.floating,
    startMs: start.ms,
    endMs: end.ms,
  };
}

function parseRange(raw: unknown): DateRange | null {
  if (!isRecord(raw)) return null;
  const from = raw['from'];
  const to = raw['to'];
  if (!isValidDate(from) || !isValidDate(to) || compareDates(from, to) > 0) return null;
  return { from, to };
}

/** Разбирает содержимое `calendar-cache.json` (уже как JSON-значение). */
export function parseCalendarCache(value: unknown, options: ParseCalendarCacheOptions): ParsedCalendarCache {
  if (!isRecord(value)) return { status: 'corrupt', detail: 'not a JSON object' };
  const version = value['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { status: 'corrupt', detail: 'missing or invalid "version"' };
  }
  if (version > CALENDAR_CACHE_VERSION) return { status: 'unsupported-version', version };

  const generatedAt = value['generated_at'];
  if (!isIsoInstant(generatedAt)) return { status: 'corrupt', detail: 'missing or invalid "generated_at"' };
  const range = parseRange(value['range']);
  if (!range) return { status: 'corrupt', detail: 'missing or invalid "range"' };
  const rawCalendars = value['calendars'] ?? [];
  const rawEvents = value['events'] ?? [];
  if (!Array.isArray(rawCalendars)) return { status: 'corrupt', detail: '"calendars" is not an array' };
  if (!Array.isArray(rawEvents)) return { status: 'corrupt', detail: '"events" is not an array' };

  const timeZone = isValidTimeZone(options.timeZone) ? options.timeZone : undefined;
  let skipped = 0;

  const calendars: CachedCalendar[] = [];
  const calendarIds = new Set<string>();
  for (const raw of rawCalendars) {
    const calendar = parseCalendar(raw);
    if (!calendar || calendarIds.has(calendar.calendarId)) {
      skipped++;
      continue;
    }
    calendarIds.add(calendar.calendarId);
    calendars.push(calendar);
  }

  const events: CachedCalendarEvent[] = [];
  const occurrenceKeys = new Set<string>();
  for (const raw of rawEvents) {
    const event = parseEvent(raw, timeZone);
    if (!event || occurrenceKeys.has(event.occurrenceKey)) {
      skipped++;
      continue;
    }
    occurrenceKeys.add(event.occurrenceKey);
    events.push(event);
  }

  return {
    status: 'ok',
    skipped,
    data: {
      version,
      generatedAt,
      deviceName: optionalString(value['device_name']),
      range,
      calendars,
      events,
    },
  };
}

// ---------------------------------------------------------------------------
// Состояние, актуальность, покрытие
// ---------------------------------------------------------------------------

/** Кэш устарел: `generatedAt` старше порога (будущее время — не устарел). */
export function isCacheStale(data: CalendarCacheData, nowMs: number, staleAfterMs: number = DEFAULT_CACHE_STALE_MS): boolean {
  const generated = Date.parse(data.generatedAt);
  if (Number.isNaN(generated)) return true;
  return nowMs - generated > staleAfterMs;
}

/** Результат разбора → состояние для контракта `CalendarCacheReader`. */
export function toCacheState(parsed: ParsedCalendarCache, nowMs: number, staleAfterMs?: number): CalendarCacheState {
  if (parsed.status !== 'ok') return parsed;
  return { status: 'ok', data: parsed.data, stale: isCacheStale(parsed.data, nowMs, staleAfterMs) };
}

/**
 * Покрытие дня кэшем (ТЗ §4.4). Отсутствующий, повреждённый и кэш новой версии
 * одинаково не дают событий → `no-cache`; причину показывает `cacheNoticeKey`.
 */
export function cacheCoverage(state: CalendarCacheState, date: LocalDateString): CacheCoverage {
  if (state.status !== 'ok') return 'no-cache';
  return isDateInRange(date, state.data.range.from, state.data.range.to) ? 'covered' : 'out-of-range';
}

/** Календари, в которые можно записывать новые события. */
export function writableCalendars(calendars: readonly CachedCalendar[]): CachedCalendar[] {
  return calendars.filter((calendar) => calendar.allowsModifications);
}

/** Календарь только для чтения (или неизвестный) — событие открывается в режиме просмотра. */
export function isCalendarReadOnly(calendars: readonly CachedCalendar[], calendarId: string): boolean {
  const calendar = calendars.find((item) => item.calendarId === calendarId);
  return !calendar || !calendar.allowsModifications;
}

/**
 * Ключ i18n пояснения для дня или `null`, если пояснение не нужно.
 * `cache.notice.*` регистрируется в cache-reader.ts.
 */
export function cacheNoticeKey(state: CalendarCacheState, coverage: CacheCoverage): string | null {
  switch (state.status) {
    case 'missing':
      return 'cache.notice.noCache';
    case 'corrupt':
      return 'cache.notice.corrupt';
    case 'unsupported-version':
      return 'cache.notice.unsupportedVersion';
    case 'ok':
      return coverage === 'out-of-range' ? 'cache.notice.outOfRange' : null;
  }
}
