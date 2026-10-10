/**
 * Повторения событий-заметок и разбиение интервалов по дням (ТЗ §3.4, §4.4).
 *
 * Чистый модуль: без `obsidian` и DOM. Зона устройства передаётся параметром.
 *
 * Правила:
 * - all-day: `start`/`end` — даты, `end` не включается; длительность в днях сохраняется у каждого повторения;
 * - со временем без `tz`: плавающее время, длительность считается по «настенным» часам;
 * - со временем и `tz`: начало и конец повторения трактуются в зоне события и переводятся в зону устройства.
 *   Несуществующее местное время (переход на летнее) сдвигается вперёд на величину перехода,
 *   неоднозначное (переход на зимнее) — более раннее из двух мгновений (как `Temporal` `compatible`);
 * - повторения считаются от даты `start` по правилам `model/recurrence`.
 */

import type { DateRange, FloatingDateTime, LocalDateString, LocalTimeString, PlannerEvent } from '../model/types';
import {
  addDays,
  addMinutes,
  diffDays,
  floatingFromDate,
  isValidTime,
  isValidTimeZone,
  parseDateParts,
  timeToMinutes,
} from '../model/dates';
import { occurrencesInRange } from '../model/recurrence';

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Интервал в местном времени устройства. Для `allDay` — даты, `end` исключительная. */
export interface TimeSpan {
  start: FloatingDateTime;
  end: FloatingDateTime;
  allDay: boolean;
}

/** Одно повторение события. */
export interface EventOccurrence {
  /** Начало повторения в терминах самого события (дата серии и время из заметки). */
  occurrenceStart: FloatingDateTime;
  /** Интервал в зоне устройства. */
  span: TimeSpan;
}

/** Часть интервала, попадающая в один день. */
export interface DayPiece {
  date: LocalDateString;
  allDay: boolean;
  startMinute: number | null;
  endMinute: number | null;
  continuesFromPrevious: boolean;
  continuesToNext: boolean;
}

// ---------------------------------------------------------------------------
// Часовые пояса
// ---------------------------------------------------------------------------

function wallClockMs(date: LocalDateString, time: LocalTimeString): number {
  const p = parseDateParts(date);
  if (!p) throw new RangeError(`Invalid date: ${date}`);
  const minutes = timeToMinutes(time);
  return Date.UTC(p.year, p.month - 1, p.day, Math.floor(minutes / 60), minutes % 60);
}

/** Смещение зоны (мс) в момент `ms`: местное «настенное» время минус UTC. */
function zoneOffsetAt(ms: number, timeZone: string): number {
  const floored = ms - (((ms % MS_PER_MINUTE) + MS_PER_MINUTE) % MS_PER_MINUTE);
  const local = floatingFromDate(new Date(floored), timeZone);
  return wallClockMs(local.date, local.time) - floored;
}

/**
 * Местная дата-время в зоне `timeZone` → мгновение (мс).
 * Пропущенное время сдвигается вперёд, неоднозначное — раннее мгновение.
 */
export function zonedDateTimeToInstant(date: LocalDateString, time: LocalTimeString, timeZone: string): number {
  const wall = wallClockMs(date, time);
  const before = zoneOffsetAt(wall - MS_PER_DAY, timeZone);
  const after = zoneOffsetAt(wall + MS_PER_DAY, timeZone);
  const candidates = [wall - before, wall - after].filter((ms) => {
    const local = floatingFromDate(new Date(ms), timeZone);
    return local.date === date && local.time === time;
  });
  if (candidates.length > 0) return Math.min(...candidates);
  // Пропущенное время: смещение до перехода сдвигает время вперёд на величину перехода.
  return wall - before;
}

/**
 * Перевод местного времени из зоны события в зону устройства. Без перевода, если зоны невалидны.
 * При совпадающих зонах перевод тоже идёт через мгновение: несуществующее время сдвигается.
 */
export function convertZonedTime(
  value: { date: LocalDateString; time: LocalTimeString },
  fromZone: string | null,
  deviceZone: string,
): FloatingDateTime & { time: LocalTimeString } {
  if (!fromZone || !isValidTimeZone(fromZone) || !isValidTimeZone(deviceZone)) {
    return { date: value.date, time: value.time };
  }
  const instant = zonedDateTimeToInstant(value.date, value.time, fromZone);
  return floatingFromDate(new Date(instant), deviceZone);
}

// ---------------------------------------------------------------------------
// Повторения события
// ---------------------------------------------------------------------------

type EventShape = Pick<PlannerEvent, 'start' | 'end' | 'allDay' | 'tz' | 'repeat'>;

function safeTime(time: LocalTimeString | null): LocalTimeString {
  return time !== null && isValidTime(time) ? time : '00:00';
}

/**
 * Повторения события, интервалы которых пересекают `range` (в зоне устройства).
 * Повторения, начавшиеся до `range.from` и продолжающиеся в нём, включаются.
 */
export function expandEventOccurrences(
  event: EventShape,
  range: DateRange,
  deviceTimeZone: string,
  options: { limit?: number } = {},
): EventOccurrence[] {
  if (range.from > range.to) return [];
  const limit = options.limit ?? 1000;
  const result: EventOccurrence[] = [];

  if (event.allDay) {
    const spanDays = Math.max(1, diffDays(event.start.date, event.end.date));
    const dates = occurrencesInRange(event.repeat, event.start.date, { from: addDays(range.from, -(spanDays - 1)), to: range.to }, { limit });
    for (const date of dates) {
      result.push({
        occurrenceStart: { date, time: null },
        span: { start: { date, time: null }, end: { date: addDays(date, spanDays), time: null }, allDay: true },
      });
    }
    return result;
  }

  const startTime = safeTime(event.start.time);
  const endTime = safeTime(event.end.time);
  const endDayOffset = diffDays(event.start.date, event.end.date);
  const wallDuration = Math.max(0, endDayOffset * MINUTES_PER_DAY + timeToMinutes(endTime) - timeToMinutes(startTime));
  // Запас на длительность и на сдвиг даты при переводе зоны.
  const margin = Math.ceil(wallDuration / MINUTES_PER_DAY) + 1;
  const dates = occurrencesInRange(event.repeat, event.start.date, { from: addDays(range.from, -margin), to: addDays(range.to, 1) }, { limit });
  // Через мгновение и при совпадении зон: иначе пропущенное при переходе время показывалось бы как есть.
  const zoned = event.tz !== null && isValidTimeZone(event.tz) && isValidTimeZone(deviceTimeZone);

  for (const date of dates) {
    let span: TimeSpan;
    if (zoned) {
      const tz = event.tz as string;
      const startMs = zonedDateTimeToInstant(date, startTime, tz);
      const endMs = Math.max(startMs, zonedDateTimeToInstant(addDays(date, endDayOffset), endTime, tz));
      span = {
        start: floatingFromDate(new Date(startMs), deviceTimeZone),
        end: floatingFromDate(new Date(endMs), deviceTimeZone),
        allDay: false,
      };
    } else {
      const start = { date, time: startTime };
      span = { start, end: addMinutes(start, wallDuration), allDay: false };
    }
    if (spanIntersects(span, range)) result.push({ occurrenceStart: { date, time: startTime }, span });
  }
  return result;
}

/** Первый и последний день интервала (как у частей `splitSpanByDays`). */
export function spanDayBounds(span: TimeSpan): { first: LocalDateString; last: LocalDateString } {
  if (span.allDay) {
    const days = Math.max(1, diffDays(span.start.date, span.end.date));
    return { first: span.start.date, last: addDays(span.start.date, days - 1) };
  }
  const { startDate, endDate } = normalizeTimed(span);
  return { first: startDate, last: endDate };
}

/** Пересекает ли интервал диапазон дат (включительно). */
export function spanIntersects(span: TimeSpan, range: DateRange): boolean {
  const { first, last } = spanDayBounds(span);
  return first <= range.to && last >= range.from;
}

// ---------------------------------------------------------------------------
// Разбиение по дням
// ---------------------------------------------------------------------------

/** Начало и конец интервала со временем: конец не раньше начала, конец в 00:00 — минута 1440 предыдущего дня. */
function normalizeTimed(span: TimeSpan): { startDate: LocalDateString; startMinute: number; endDate: LocalDateString; endMinute: number } {
  const startDate = span.start.date;
  const startMinute = timeToMinutes(safeTime(span.start.time));
  let endDate = span.end.date;
  let endMinute = timeToMinutes(safeTime(span.end.time));
  if (endDate < startDate || (endDate === startDate && endMinute < startMinute)) {
    endDate = startDate;
    endMinute = startMinute;
  }
  if (endDate !== startDate && endMinute === 0) {
    endDate = addDays(endDate, -1);
    endMinute = MINUTES_PER_DAY;
  }
  return { startDate, startMinute, endDate, endMinute };
}

/**
 * Делит интервал на части по дням.
 * - all-day: каждый день от `start` до `end − 1`;
 * - со временем: конец ровно в 00:00 не создаёт часть на следующий день;
 *   полностью занятые промежуточные дни многодневного события попадают в «Весь день».
 * `clip` ограничивает части диапазоном до разбиения (признаки продолжения сохраняются),
 * чтобы очень длинный интервал не разворачивался по всем дням.
 */
export function splitSpanByDays(span: TimeSpan, clip?: DateRange): DayPiece[] {
  const pieces: DayPiece[] = [];
  const { first, last } = spanDayBounds(span);
  const total = diffDays(first, last);
  const fromIndex = clip ? Math.max(0, diffDays(first, clip.from)) : 0;
  const toIndex = clip ? Math.min(total, diffDays(first, clip.to)) : total;
  if (fromIndex > toIndex) return pieces;

  if (span.allDay) {
    for (let i = fromIndex; i <= toIndex; i++) {
      pieces.push({
        date: addDays(first, i),
        allDay: true,
        startMinute: null,
        endMinute: null,
        continuesFromPrevious: i > 0,
        continuesToNext: i < total,
      });
    }
    return pieces;
  }

  const { startMinute, endMinute } = normalizeTimed(span);
  if (total === 0) {
    return [{ date: first, allDay: false, startMinute, endMinute, continuesFromPrevious: false, continuesToNext: false }];
  }
  for (let i = fromIndex; i <= toIndex; i++) {
    const from = i === 0 ? startMinute : 0;
    const to = i === total ? endMinute : MINUTES_PER_DAY;
    const fullDay = from === 0 && to === MINUTES_PER_DAY;
    pieces.push({
      date: addDays(first, i),
      allDay: fullDay,
      startMinute: fullDay ? null : from,
      endMinute: fullDay ? null : to,
      continuesFromPrevious: i > 0,
      continuesToNext: i < total,
    });
  }
  return pieces;
}
