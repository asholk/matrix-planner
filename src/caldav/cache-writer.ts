/**
 * Сборка `_system/calendar-cache.json` из событий CalDAV и подписок ICS (формат —
 * docs/system-json.md, тот же, что пишет компаньон). Каждое повторение — отдельная запись,
 * время со смещением зоны устройства; плавающее время — без смещения.
 *
 * Чистый модуль: без `obsidian` и DOM.
 */

import type { IcsDateRange, IcsEvent, IcsOccurrence } from './ics-types';
import { parseIcs } from './ics';
import { expandOccurrences, groupSeries, isIanaTimeZone, rruleToPreset, zonedToEpoch, zoneOffsetMinutes } from './rrule';
import { plannerItemIdOf } from './sync-mapping';
import {
  CALENDAR_CACHE_VERSION,
  type CalendarCacheFile,
  type CalendarCacheFileCalendar,
  type CalendarCacheFileEvent,
} from '../calendar/cache-schema';
import { addDays, localDateOf } from '../model/dates';
import type { CachedCalendarKind, RepeatRule } from '../model/types';

/** Границы кэша от даты записи (ТЗ §5.4.4). */
export const CACHE_DAYS_BEFORE = 30;
export const CACHE_DAYS_AFTER = 180;

export interface CacheCalendarSource {
  calendarId: string;
  title: string;
  color: string;
  kind: CachedCalendarKind;
  allowsModifications: boolean;
  /** Тексты ресурсов `.ics` календаря. */
  resources: readonly string[];
}

export interface BuildCacheOptions {
  now: Date;
  timeZone: string;
  deviceName?: string | null;
  /** Текст повтора для показа («Каждую неделю»); `null` — повтор не сводится к пресету. */
  describeRepeat?: (repeat: RepeatRule) => string | null;
}

export function cacheRange(now: Date, timeZone: string): IcsDateRange {
  const today = localDateOf(now, timeZone);
  return { from: addDays(today, -CACHE_DAYS_BEFORE), to: addDays(today, CACHE_DAYS_AFTER) };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isFloating(event: IcsEvent): boolean {
  return !event.start.utc && !isIanaTimeZone(event.start.tzid);
}

/** Местная дата-время зоны → ISO 8601 со смещением этой зоны. */
export function zonedIso(date: string, time: string, timeZone: string): string {
  const epoch = zonedToEpoch(date, time, timeZone);
  const offset = zoneOffsetMinutes(epoch, timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${date}T${time}:00${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function occurrenceTimes(occurrence: IcsOccurrence, timeZone: string): { start: string; end: string } {
  if (occurrence.allDay) {
    const end = occurrence.end.date > occurrence.start.date ? occurrence.end.date : addDays(occurrence.start.date, 1);
    return { start: occurrence.start.date, end };
  }
  const startTime = occurrence.start.time ?? '00:00';
  const endTime = occurrence.end.time ?? '00:00';
  if (isFloating(occurrence.event)) {
    return { start: `${occurrence.start.date}T${startTime}`, end: `${occurrence.end.date}T${endTime}` };
  }
  return { start: zonedIso(occurrence.start.date, startTime, timeZone), end: zonedIso(occurrence.end.date, endTime, timeZone) };
}

function recurrenceText(master: IcsEvent, describe: BuildCacheOptions['describeRepeat']): string | null {
  if (!master.rrule && !master.rruleText) return null;
  const preset = rruleToPreset(master.rrule ?? master.rruleText ?? null, master.start.date);
  if (preset.extra || preset.repeat === 'none') return null;
  return describe?.(preset.repeat) ?? null;
}

function eventsOf(source: CacheCalendarSource, range: IcsDateRange, options: BuildCacheOptions): CalendarCacheFileEvent[] {
  const out: CalendarCacheFileEvent[] = [];
  for (const text of source.resources) {
    let parsed: IcsEvent[];
    try {
      parsed = parseIcs(text).events;
    } catch {
      continue;
    }
    for (const { master, overrides } of groupSeries(parsed)) {
      const expansion = expandOccurrences(master, range, options.timeZone, { overrides });
      const recurrence = recurrenceText(master, options.describeRepeat);
      for (const occurrence of expansion.occurrences) {
        const event = occurrence.event;
        const times = occurrenceTimes(occurrence, options.timeZone);
        const itemId = plannerItemIdOf(event) ?? plannerItemIdOf(master);
        out.push({
          id: master.uid,
          calendar_id: source.calendarId,
          title: event.summary,
          all_day: occurrence.allDay,
          start: times.start,
          end: times.end,
          recurrence,
          item_id: itemId,
          location: event.location ?? null,
          url: event.url ?? null,
          notes: event.description ?? null,
        });
      }
    }
  }
  return out;
}

/** Полный объект кэша. Повторяющиеся `calendar_id` пропускаются. */
export function buildCalendarCache(sources: readonly CacheCalendarSource[], options: BuildCacheOptions): CalendarCacheFile {
  const range = cacheRange(options.now, options.timeZone);
  const calendars: CalendarCacheFileCalendar[] = [];
  const events: CalendarCacheFileEvent[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.calendarId)) continue;
    seen.add(source.calendarId);
    calendars.push({
      calendar_id: source.calendarId,
      title: source.title,
      color: source.color,
      kind: source.kind,
      allows_modifications: source.allowsModifications,
    });
    events.push(...eventsOf(source, range, options));
  }
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    version: CALENDAR_CACHE_VERSION,
    generated_at: options.now.toISOString(),
    device_name: options.deviceName ?? null,
    time_zone: options.timeZone,
    range,
    calendars,
    events,
  };
}

/** Записи календаря из предыдущего кэша (календарь временно недоступен — данные не пропадают). */
export function carryOverCalendar(
  previous: unknown,
  calendarId: string,
): { calendar: CalendarCacheFileCalendar; events: CalendarCacheFileEvent[] } | null {
  if (typeof previous !== 'object' || previous === null) return null;
  const record = previous as Partial<CalendarCacheFile>;
  if (record.version !== CALENDAR_CACHE_VERSION || !Array.isArray(record.calendars) || !Array.isArray(record.events)) return null;
  const calendar = record.calendars.find((item) => (item as { calendar_id?: unknown })?.calendar_id === calendarId);
  if (!calendar) return null;
  const events = record.events.filter((item) => (item as { calendar_id?: unknown })?.calendar_id === calendarId);
  return { calendar, events };
}

/** Содержимое кэша без времени записи — чтобы не переписывать файл без изменений. */
export function cacheSignature(cache: Pick<CalendarCacheFile, 'range' | 'calendars' | 'events'>): string {
  return JSON.stringify([cache.range, cache.calendars, cache.events]);
}
