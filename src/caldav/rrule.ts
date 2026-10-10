/**
 * RRULE (RFC 5545 §3.3.10): разбор, запись, разворот повторений и пресеты плагина.
 * Здесь же — перевод времени между зонами через `Intl` (нужен и разбору ICS).
 *
 * Чистый модуль: без `obsidian` и DOM.
 *
 * Разворот: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (с номером
 * для MONTHLY/YEARLY), BYMONTHDAY (в т. ч. отрицательные), BYMONTH, BYSETPOS, WKST,
 * EXDATE, переопределения RECURRENCE-ID. Время суток повторения = время DTSTART
 * в зоне серии (BYHOUR/BYMINUTE не поддерживаются — тогда только DTSTART).
 */

import type { RepeatRule } from '../model/types';
import { addDays, daysInMonth, diffDays, parseDateParts, weekday as weekdayOf } from '../model/dates';
import type {
  IcsDate,
  IcsDateRange,
  IcsDateTime,
  IcsEvent,
  IcsExpansion,
  IcsOccurrence,
  IcsTime,
  Rrule,
  RruleByDay,
  RruleFreq,
  Weekday,
} from './ics-types';

/** Лимит повторений на один диапазон. */
export const MAX_OCCURRENCES = 1000;
/** Предохранитель перебора периодов (дней для DAILY ≈ 270 лет). */
const MAX_PERIODS = 100000;

export const WEEKDAYS: readonly Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQS: readonly RruleFreq[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const UNSUPPORTED_PARTS = ['BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYYEARDAY', 'BYWEEKNO', 'RSCALE', 'SKIP'];

const pad2 = (n: number) => String(n).padStart(2, '0');
const pad4 = (n: number) => String(n).padStart(4, '0');

// ---------------------------------------------------------------------------
// Часовые пояса (Intl)
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Известна ли `Intl` такая IANA-зона. */
export function isIanaTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    zoneFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Зона устройства. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallParts(epoch: number, timeZone: string): WallParts {
  const parts: Record<string, string> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(epoch))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Смещение зоны от UTC в минутах в момент `epoch`. */
export function zoneOffsetMinutes(epoch: number, timeZone: string): number {
  const w = wallParts(epoch, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(epoch / 1000) * 1000) / 60000);
}

function naiveEpoch(date: IcsDate, time: IcsTime | null): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = (time ?? '00:00').split(':').map(Number) as [number, number];
  return Date.UTC(y, mo - 1, d, h, mi);
}

/**
 * Местное время зоны → момент. Неоднозначное (осенний перевод) — первое из двух;
 * несуществующее (весенний перевод) — по смещению до перевода (02:30 → 03:30), как в RFC 5545.
 */
export function zonedToEpoch(date: IcsDate, time: IcsTime | null, timeZone: string): number {
  const naive = naiveEpoch(date, time);
  const offA = zoneOffsetMinutes(naive, timeZone);
  const tA = naive - offA * 60000;
  const offB = zoneOffsetMinutes(tA, timeZone);
  const tB = naive - offB * 60000;
  const validA = zoneOffsetMinutes(tA, timeZone) === offA;
  const validB = zoneOffsetMinutes(tB, timeZone) === offB;
  if (validA && validB) return Math.min(tA, tB);
  if (validA) return tA;
  if (validB) return tB;
  return Math.max(tA, tB);
}

/** Момент → местные дата и время зоны. */
export function epochToZoned(epoch: number, timeZone: string): { date: IcsDate; time: IcsTime } {
  const w = wallParts(epoch, timeZone);
  return { date: `${pad4(w.year)}-${pad2(w.month)}-${pad2(w.day)}`, time: `${pad2(w.hour)}:${pad2(w.minute)}` };
}

function epochToUtc(epoch: number): { date: IcsDate; time: IcsTime } {
  const d = new Date(epoch);
  return {
    date: `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    time: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
  };
}

/**
 * Момент для даты-времени ICS. Плавающее время считается в `floatingZone`
 * (без неё — `null`); «весь день» — полночь.
 */
export function toEpoch(dt: IcsDateTime, floatingZone?: string | null): number | null {
  if (dt.utc) return naiveEpoch(dt.date, dt.time);
  if (dt.tzid && isIanaTimeZone(dt.tzid)) return zonedToEpoch(dt.date, dt.time, dt.tzid);
  if (floatingZone && isIanaTimeZone(floatingZone)) return zonedToEpoch(dt.date, dt.time, floatingZone);
  return null;
}

/**
 * Дата-время ICS → местные дата и время зоны `timeZone` (обычно зоны устройства).
 * «Весь день» и плавающее время не переводятся.
 */
export function toTimeZone(dt: IcsDateTime, timeZone: string): { date: IcsDate; time: IcsTime | null } {
  if (dt.time === null) return { date: dt.date, time: null };
  if (!dt.utc && !dt.tzid) return { date: dt.date, time: dt.time };
  const epoch = toEpoch(dt);
  if (epoch === null) return { date: dt.date, time: dt.time };
  return epochToZoned(epoch, timeZone);
}

/** Момент → дата-время ICS в UTC. */
export function utcDateTime(epoch: number): IcsDateTime {
  return { ...epochToUtc(epoch), tzid: null, utc: true };
}

// ---------------------------------------------------------------------------
// Значения DATE / DATE-TIME
// ---------------------------------------------------------------------------

const DATE_VALUE_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;

/** `20261011` / `20261011T100000` / `20261011T070000Z` → IcsDateTime. */
export function parseDateTimeValue(value: string, tzid: string | null = null): IcsDateTime | null {
  const m = DATE_VALUE_RE.exec(value.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!parseDateParts(date)) return null;
  if (m[4] === undefined) return { date, time: null, tzid: null, utc: false };
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (hour > 23 || minute > 59) return null;
  const utc = m[7] === 'Z';
  return { date, time: `${m[4]}:${m[5]}`, tzid: utc ? null : tzid, utc };
}

/** IcsDateTime → `20261011` / `20261011T100000` / `...Z` (без TZID). */
export function formatDateTimeValue(dt: IcsDateTime): string {
  const date = dt.date.replace(/-/g, '');
  if (dt.time === null) return date;
  return `${date}T${dt.time.replace(':', '')}00${dt.utc ? 'Z' : ''}`;
}

// ---------------------------------------------------------------------------
// Разбор и запись RRULE
// ---------------------------------------------------------------------------

function parseIntList(value: string, min: number, max: number, allowNegative: boolean): number[] | null {
  const result: number[] = [];
  for (const item of value.split(',')) {
    if (!/^[+-]?\d{1,3}$/.test(item)) return null;
    const n = Number(item);
    const abs = Math.abs(n);
    if (abs < min || abs > max || (n < 0 && !allowNegative)) return null;
    result.push(n);
  }
  return result;
}

/** `FREQ=WEEKLY;BYDAY=MO,WE` (можно с префиксом `RRULE:`) → Rrule; `null` — неподдерживаемая частота или ошибка. */
export function parseRrule(text: string): Rrule | null {
  const body = text.trim().replace(/^RRULE:/i, '');
  if (!body) return null;
  const parts: Record<string, string> = {};
  for (const item of body.split(';')) {
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq <= 0) return null;
    parts[item.slice(0, eq).toUpperCase()] = item.slice(eq + 1).toUpperCase();
  }
  const freq = parts.FREQ as RruleFreq | undefined;
  if (!freq || !FREQS.includes(freq)) return null;
  const rule: Rrule = { freq, interval: 1 };
  for (const [key, value] of Object.entries(parts)) {
    switch (key) {
      case 'FREQ':
        break;
      case 'INTERVAL': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) return null;
        rule.interval = n;
        break;
      }
      case 'COUNT': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) return null;
        rule.count = n;
        break;
      }
      case 'UNTIL': {
        const until = parseDateTimeValue(value);
        if (!until) return null;
        rule.until = until;
        break;
      }
      case 'BYDAY': {
        const list: RruleByDay[] = [];
        for (const item of value.split(',')) {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
          if (!m) return null;
          const n = m[1] === undefined ? null : Number(m[1]);
          if (n !== null && (n === 0 || Math.abs(n) > 53)) return null;
          list.push({ day: m[2] as Weekday, n });
        }
        rule.byDay = list;
        break;
      }
      case 'BYMONTHDAY': {
        const list = parseIntList(value, 1, 31, true);
        if (!list) return null;
        rule.byMonthDay = list;
        break;
      }
      case 'BYMONTH': {
        const list = parseIntList(value, 1, 12, false);
        if (!list) return null;
        rule.byMonth = list;
        break;
      }
      case 'BYSETPOS': {
        const list = parseIntList(value, 1, 366, true);
        if (!list) return null;
        rule.bySetPos = list;
        break;
      }
      case 'WKST':
        if (!WEEKDAYS.includes(value as Weekday)) return null;
        rule.wkst = value as Weekday;
        break;
      default:
        if (UNSUPPORTED_PARTS.includes(key)) (rule.unsupported ??= {})[key] = value;
        // Неизвестные X-части игнорируются.
        break;
    }
  }
  if (rule.count !== undefined && rule.until !== undefined) delete rule.count;
  return rule;
}

/**
 * Rrule → `FREQ=…` (без `RRULE:`). UNTIL с TZID переводится в UTC, как требует RFC 5545.
 */
export function serializeRrule(rule: Rrule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until) {
    let until = rule.until;
    if (until.time !== null && !until.utc && until.tzid) {
      const epoch = toEpoch(until);
      if (epoch !== null) until = utcDateTime(epoch);
    }
    parts.push(`UNTIL=${formatDateTimeValue(until)}`);
  }
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.map((d) => `${d.n ?? ''}${d.day}`).join(',')}`);
  if (rule.bySetPos?.length) parts.push(`BYSETPOS=${rule.bySetPos.join(',')}`);
  for (const [key, value] of Object.entries(rule.unsupported ?? {})) parts.push(`${key}=${value}`);
  if (rule.wkst) parts.push(`WKST=${rule.wkst}`);
  return parts.join(';');
}

// ---------------------------------------------------------------------------
// Генерация дат серии
// ---------------------------------------------------------------------------

function ymd(date: IcsDate): { year: number; month: number; day: number } {
  const p = parseDateParts(date);
  if (!p) throw new RangeError(`Invalid date: ${date}`);
  return p;
}

function makeDate(year: number, month: number, day: number): IcsDate {
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

/** Дни месяца по BYMONTHDAY (отрицательные — с конца), только существующие. */
function monthDays(year: number, month: number, byMonthDay: readonly number[]): number[] {
  const dim = daysInMonth(year, month);
  const days: number[] = [];
  for (const n of byMonthDay) {
    const day = n > 0 ? n : dim + n + 1;
    if (day >= 1 && day <= dim) days.push(day);
  }
  return days;
}

/** Даты по BYDAY внутри [first, last] (номер `n` — внутри этого отрезка). */
function byDayInSpan(first: IcsDate, last: IcsDate, byDay: readonly RruleByDay[]): IcsDate[] {
  const length = diffDays(first, last) + 1;
  const firstWeekday = weekdayOf(first);
  const result: IcsDate[] = [];
  for (const entry of byDay) {
    const target = WEEKDAYS.indexOf(entry.day);
    const offset = (target - firstWeekday + 7) % 7;
    const all: IcsDate[] = [];
    for (let i = offset; i < length; i += 7) all.push(addDays(first, i));
    if (entry.n === null) result.push(...all);
    else {
      const index = entry.n > 0 ? entry.n - 1 : all.length + entry.n;
      const pick = all[index];
      if (index >= 0 && pick) result.push(pick);
    }
  }
  return result;
}

function matchesWeekday(date: IcsDate, byDay: readonly RruleByDay[]): boolean {
  const day = WEEKDAYS[weekdayOf(date)];
  return byDay.some((entry) => entry.day === day);
}

/** Даты одного периода (без фильтра по DTSTART), отсортированные и без повторов. */
function periodDates(rule: Rrule, start: IcsDate, index: number): { first: IcsDate; dates: IcsDate[] } {
  const s = ymd(start);
  let first: IcsDate;
  let dates: IcsDate[] = [];
  switch (rule.freq) {
    case 'DAILY': {
      first = addDays(start, index * rule.interval);
      dates = [first];
      if (rule.byMonthDay) {
        const p = ymd(first);
        if (!monthDays(p.year, p.month, rule.byMonthDay).includes(p.day)) dates = [];
      }
      if (rule.byDay && !matchesWeekday(first, rule.byDay)) dates = [];
      break;
    }
    case 'WEEKLY': {
      const wkst = WEEKDAYS.indexOf(rule.wkst ?? 'MO');
      const weekStart = addDays(start, -((weekdayOf(start) - wkst + 7) % 7));
      first = addDays(weekStart, index * 7 * rule.interval);
      if (rule.byDay?.length) dates = byDayInSpan(first, addDays(first, 6), rule.byDay.map((d) => ({ day: d.day, n: null })));
      else dates = [addDays(first, (weekdayOf(start) - wkst + 7) % 7)];
      break;
    }
    case 'MONTHLY': {
      const total = s.year * 12 + (s.month - 1) + index * rule.interval;
      const year = Math.floor(total / 12);
      const month = total - year * 12 + 1;
      first = makeDate(year, month, 1);
      const last = makeDate(year, month, daysInMonth(year, month));
      if (rule.byMonthDay?.length) {
        dates = monthDays(year, month, rule.byMonthDay).map((d) => makeDate(year, month, d));
        if (rule.byDay?.length) dates = dates.filter((d) => matchesWeekday(d, rule.byDay!));
      } else if (rule.byDay?.length) dates = byDayInSpan(first, last, rule.byDay);
      else if (s.day <= daysInMonth(year, month)) dates = [makeDate(year, month, s.day)];
      break;
    }
    case 'YEARLY': {
      const year = s.year + index * rule.interval;
      first = makeDate(year, 1, 1);
      if (rule.byMonth?.length) {
        for (const month of rule.byMonth) {
          const mFirst = makeDate(year, month, 1);
          const mLast = makeDate(year, month, daysInMonth(year, month));
          if (rule.byMonthDay?.length) {
            let list = monthDays(year, month, rule.byMonthDay).map((d) => makeDate(year, month, d));
            if (rule.byDay?.length) list = list.filter((d) => matchesWeekday(d, rule.byDay!));
            dates.push(...list);
          } else if (rule.byDay?.length) dates.push(...byDayInSpan(mFirst, mLast, rule.byDay));
          else if (s.day <= daysInMonth(year, month)) dates.push(makeDate(year, month, s.day));
        }
      } else if (rule.byMonthDay?.length) {
        for (let month = 1; month <= 12; month++) {
          let list = monthDays(year, month, rule.byMonthDay).map((d) => makeDate(year, month, d));
          if (rule.byDay?.length) list = list.filter((d) => matchesWeekday(d, rule.byDay!));
          dates.push(...list);
        }
      } else if (rule.byDay?.length) dates = byDayInSpan(first, makeDate(year, 12, 31), rule.byDay);
      else if (s.day <= daysInMonth(year, s.month)) dates = [makeDate(year, s.month, s.day)];
      break;
    }
  }
  if (rule.byMonth?.length && rule.freq !== 'YEARLY') {
    dates = dates.filter((d) => rule.byMonth!.includes(ymd(d).month));
  }
  dates = [...new Set(dates)].sort();
  if (rule.bySetPos?.length && dates.length) {
    const picked: IcsDate[] = [];
    for (const pos of rule.bySetPos) {
      const pick = dates[pos > 0 ? pos - 1 : dates.length + pos];
      if (pick) picked.push(pick);
    }
    dates = [...new Set(picked)].sort();
  }
  return { first, dates };
}

/**
 * Даты повторений серии с `start` (включая сам `start`) до `stopDate` включительно.
 * `untilDate` — последняя допустимая дата, `accept` — дополнительная проверка (UNTIL со временем).
 */
export function seriesDates(
  rule: Rrule,
  start: IcsDate,
  stopDate: IcsDate,
  accept: (date: IcsDate) => boolean = () => true,
  maxDates = Number.POSITIVE_INFINITY,
): IcsDate[] {
  if (!accept(start)) return [];
  const result: IcsDate[] = [start];
  let produced = 1;
  if (rule.count === 1) return result;
  outer: for (let index = 0; index < MAX_PERIODS; index++) {
    const { first, dates } = periodDates(rule, start, index);
    if (first > stopDate) break;
    for (const date of dates) {
      if (date <= start) continue;
      if (date > stopDate || !accept(date)) break outer;
      result.push(date);
      produced++;
      if ((rule.count !== undefined && produced >= rule.count) || result.length >= maxDates) break outer;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Разворот события
// ---------------------------------------------------------------------------

export interface ExpandOptions {
  /** Переопределения повторений (события с тем же UID и RECURRENCE-ID). */
  overrides?: readonly IcsEvent[];
  /** Лимит повторений на диапазон (по умолчанию 1000). */
  maxOccurrences?: number;
}

function addMinutesWall(date: IcsDate, time: IcsTime, minutes: number): { date: IcsDate; time: IcsTime } {
  const total = naiveEpoch(date, time) + minutes * 60000;
  return epochToUtc(total);
}

/** Зона серии: IANA из DTSTART, `UTC` для `...Z`, `null` — плавающее время или «весь день». */
function seriesZoneOf(event: IcsEvent): string | null {
  if (event.allDay || event.start.time === null) return null;
  if (event.start.utc) return 'UTC';
  return isIanaTimeZone(event.start.tzid) ? event.start.tzid : null;
}

/** Ключ повторения в зоне серии: `YYYY-MM-DD` для «весь день», иначе `YYYY-MM-DDTHH:MM`. */
export function recurrenceKey(dt: IcsDateTime, series: IcsEvent, floatingZone: string): string {
  if (series.allDay || series.start.time === null || dt.time === null) return dt.date;
  const wall = `${dt.date}T${dt.time}`;
  // Плавающее значение сравнивается как есть.
  if (!dt.utc && !dt.tzid) return wall;
  const target = seriesZoneOf(series) ?? floatingZone;
  if (target === 'UTC' ? dt.utc : !dt.utc && dt.tzid === target) return wall;
  const epoch = toEpoch(dt);
  if (epoch === null) return wall;
  const w = epochToZoned(epoch, target);
  return `${w.date}T${w.time}`;
}

interface Placed {
  start: { date: IcsDate; time: IcsTime | null };
  end: { date: IcsDate; time: IcsTime | null };
}

/** Размещение одного экземпляра (локальная дата начала в зоне серии) в целевой зоне. */
function placeInstance(event: IcsEvent, date: IcsDate, timeZone: string): Placed {
  if (event.allDay || event.start.time === null) {
    const days = Math.max(1, event.end.time === null ? diffDays(event.start.date, event.end.date) : 1);
    return { start: { date, time: null }, end: { date: addDays(date, days), time: null } };
  }
  const zone = seriesZoneOf(event);
  const startEpoch = toEpoch(event.start, timeZone);
  const endEpoch = toEpoch(event.end.time === null ? { ...event.end, time: '00:00' } : event.end, timeZone);
  const minutes = startEpoch !== null && endEpoch !== null ? Math.max(0, Math.round((endEpoch - startEpoch) / 60000)) : 0;
  if (!zone) {
    const end = addMinutesWall(date, event.start.time, minutes);
    return { start: { date, time: event.start.time }, end };
  }
  const epoch = zonedToEpoch(date, event.start.time, zone);
  return { start: epochToZoned(epoch, timeZone), end: epochToZoned(epoch + minutes * 60000, timeZone) };
}

function overlaps(placed: Placed, range: IcsDateRange, allDay: boolean): boolean {
  if (placed.start.date > range.to) return false;
  let lastDay = placed.end.date;
  if (allDay) lastDay = addDays(placed.end.date, -1);
  else if (placed.end.time === '00:00' && placed.end.date > placed.start.date) lastDay = addDays(placed.end.date, -1);
  if (lastDay < placed.start.date) lastDay = placed.start.date;
  return lastDay >= range.from;
}

function sortKey(o: IcsOccurrence): string {
  return `${o.start.date}T${o.start.time ?? ''}`;
}

/**
 * Повторения события в диапазоне дат (включительно) в зоне `timeZone`.
 * Учитываются EXDATE, переопределения (заменяют экземпляр, могут переносить его в диапазон
 * или из него), STATUS:CANCELLED. Не более `maxOccurrences` (1000) — тогда `truncated`.
 */
export function expandOccurrences(
  event: IcsEvent,
  range: IcsDateRange,
  timeZone: string,
  options: ExpandOptions = {},
): IcsExpansion {
  const max = options.maxOccurrences ?? MAX_OCCURRENCES;
  const occurrences: IcsOccurrence[] = [];
  let truncated = false;
  if (event.status === 'CANCELLED') return { occurrences, truncated, unsupported: false };

  const rule = event.rrule;
  const unsupported = !!rule && !!rule.unsupported && Object.keys(rule.unsupported).length > 0;
  const allDay = event.allDay || event.start.time === null;
  const zone = seriesZoneOf(event);

  const exKeys = new Set<string>();
  const exDates = new Set<string>();
  for (const ex of event.exdates) {
    if (!allDay && ex.time === null) exDates.add(ex.date);
    else exKeys.add(recurrenceKey(ex, event, timeZone));
  }
  const overrides = new Map<string, IcsEvent>();
  for (const o of options.overrides ?? []) {
    if (o.recurrenceId) overrides.set(recurrenceKey(o.recurrenceId, event, timeZone), o);
  }

  const keyOf = (date: IcsDate) => (allDay ? date : `${date}T${event.start.time}`);
  // Начало серии в её зоне — даты экземпляров считаются в ней.
  const startDate = event.start.date;

  let dates: IcsDate[];
  if (!rule || unsupported) dates = [startDate];
  else {
    let accept: (date: IcsDate) => boolean = () => true;
    if (rule.until) {
      const until = rule.until;
      if (allDay || until.time === null) {
        const untilDate = until.date;
        accept = (date) => (allDay ? date <= untilDate : keyOf(date) <= `${untilDate}T23:59`);
      } else {
        const untilKey = recurrenceKey(until, event, timeZone);
        accept = (date) => keyOf(date) <= untilKey;
      }
    }
    // Запас на сдвиг зоны и длительность экземпляра.
    const stopDate = addDays(range.to, 2);
    dates = seriesDates(rule, startDate, stopDate, accept);
  }

  for (const date of dates) {
    const key = keyOf(date);
    if (exKeys.has(key) || exDates.has(date) || overrides.has(key)) continue;
    const placed = placeInstance(event, date, timeZone);
    if (!overlaps(placed, range, allDay)) continue;
    occurrences.push({ event, recurrenceKey: key, allDay, start: placed.start, end: placed.end, isOverride: false });
    if (occurrences.length > max) break;
  }

  for (const [key, o] of overrides) {
    if (o.status === 'CANCELLED' || exKeys.has(key)) continue;
    const oAllDay = o.allDay || o.start.time === null;
    const placed = placeInstance(o, o.start.date, timeZone);
    if (!oAllDay && (o.start.utc || o.start.tzid)) {
      // Переопределение могло быть записано в другой зоне.
      const s = toTimeZone(o.start, timeZone);
      const e = toTimeZone(o.end, timeZone);
      placed.start = s;
      placed.end = e;
    }
    if (!overlaps(placed, range, oAllDay)) continue;
    occurrences.push({ event: o, recurrenceKey: key, allDay: oAllDay, start: placed.start, end: placed.end, isOverride: true });
  }

  occurrences.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  if (occurrences.length > max) {
    occurrences.length = max;
    truncated = true;
  }
  return { occurrences, truncated, unsupported };
}

/** Группировка событий календаря: основное событие + его переопределения по UID. */
export function groupSeries(events: readonly IcsEvent[]): { master: IcsEvent; overrides: IcsEvent[] }[] {
  const byUid = new Map<string, { master: IcsEvent | null; overrides: IcsEvent[] }>();
  for (const e of events) {
    let group = byUid.get(e.uid);
    if (!group) byUid.set(e.uid, (group = { master: null, overrides: [] }));
    if (e.recurrenceId) group.overrides.push(e);
    else group.master = e;
  }
  const result: { master: IcsEvent; overrides: IcsEvent[] }[] = [];
  for (const group of byUid.values()) {
    if (group.master) result.push({ master: group.master, overrides: group.overrides });
    // Переопределения без основного события (приглашение на один экземпляр) — как отдельные события.
    else for (const o of group.overrides) result.push({ master: { ...o, recurrenceId: undefined, rrule: undefined }, overrides: [] });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Пресеты плагина ↔ RRULE
// ---------------------------------------------------------------------------

/**
 * Пресет плагина → RRULE. Семантика пресетов (model/recurrence): месячный повтор на 29–31
 * число в коротком месяце переходит на последний день; 29 февраля — на 28 февраля.
 * Для таких якорей используется BYMONTHDAY + BYSETPOS=-1 (или BYMONTHDAY=-1 для 31-го).
 */
export function presetToRrule(repeat: RepeatRule, anchor: IcsDate): Rrule | null {
  const a = ymd(anchor);
  switch (repeat) {
    case 'none':
      return null;
    case 'daily':
      return { freq: 'DAILY', interval: 1 };
    case 'weekly':
      return { freq: 'WEEKLY', interval: 1 };
    case 'monthly':
      if (a.day <= 28) return { freq: 'MONTHLY', interval: 1 };
      if (a.day === 31) return { freq: 'MONTHLY', interval: 1, byMonthDay: [-1] };
      return { freq: 'MONTHLY', interval: 1, byMonthDay: range(28, a.day), bySetPos: [-1] };
    case 'yearly':
      if (a.month === 2 && a.day === 29) return { freq: 'YEARLY', interval: 1, byMonth: [2], byMonthDay: [-1] };
      return { freq: 'YEARLY', interval: 1 };
  }
}

function range(from: number, to: number): number[] {
  const list: number[] = [];
  for (let n = from; n <= to; n++) list.push(n);
  return list;
}

function sameSet(a: readonly number[] | undefined, b: readonly number[]): boolean {
  if (!a || a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((n) => set.has(n));
}

export interface PresetFromRrule {
  repeat: RepeatRule;
  /** Якорь повтора (дата начала серии) или `null` для `none`. */
  anchor: IcsDate | null;
  /** Исходный RRULE, если он не сводится к пресету. */
  extra: { rrule: string } | null;
}

/**
 * RRULE → пресет плагина, если правило эквивалентно пресету с якорем `start`;
 * иначе `none` и исходный RRULE в `extra`.
 */
export function rruleToPreset(rrule: Rrule | string | null | undefined, start: IcsDate): PresetFromRrule {
  if (rrule === null || rrule === undefined || rrule === '') return { repeat: 'none', anchor: null, extra: null };
  const text = typeof rrule === 'string' ? rrule.trim().replace(/^RRULE:/i, '') : serializeRrule(rrule);
  const rule = typeof rrule === 'string' ? parseRrule(rrule) : rrule;
  const none: PresetFromRrule = { repeat: 'none', anchor: null, extra: { rrule: text } };
  if (!rule) return none;
  if (rule.interval !== 1 || rule.count !== undefined || rule.until !== undefined) return none;
  if (rule.unsupported && Object.keys(rule.unsupported).length) return none;
  const a = ymd(start);
  const wd = WEEKDAYS[weekdayOf(start)];
  const has = {
    byDay: !!rule.byDay?.length,
    byMonthDay: !!rule.byMonthDay?.length,
    byMonth: !!rule.byMonth?.length,
    bySetPos: !!rule.bySetPos?.length,
  };
  const noParts = !has.byDay && !has.byMonthDay && !has.byMonth && !has.bySetPos;
  const ok = (repeat: RepeatRule): PresetFromRrule => ({ repeat, anchor: start, extra: null });
  switch (rule.freq) {
    case 'DAILY':
      return noParts ? ok('daily') : none;
    case 'WEEKLY': {
      if (noParts) return ok('weekly');
      const single = rule.byDay?.length === 1 && rule.byDay[0]!.day === wd && rule.byDay[0]!.n === null;
      return single && !has.byMonthDay && !has.byMonth && !has.bySetPos ? ok('weekly') : none;
    }
    case 'MONTHLY': {
      if (has.byDay || has.byMonth) return none;
      if (a.day <= 28) {
        if (noParts) return ok('monthly');
        if (sameSet(rule.byMonthDay, [a.day]) && !has.bySetPos) return ok('monthly');
        return none;
      }
      if (a.day === 31 && sameSet(rule.byMonthDay, [-1]) && !has.bySetPos) return ok('monthly');
      if (sameSet(rule.byMonthDay, range(28, a.day)) && sameSet(rule.bySetPos, [-1])) return ok('monthly');
      return none;
    }
    case 'YEARLY': {
      if (has.byDay) return none;
      const feb29 = a.month === 2 && a.day === 29;
      if (!feb29) {
        if (noParts) return ok('yearly');
        const monthOk = !has.byMonth || sameSet(rule.byMonth, [a.month]);
        const dayOk = !has.byMonthDay || sameSet(rule.byMonthDay, [a.day]);
        return monthOk && dayOk && !has.bySetPos ? ok('yearly') : none;
      }
      if (!sameSet(rule.byMonth, [2])) return none;
      if (sameSet(rule.byMonthDay, [-1]) && !has.bySetPos) return ok('yearly');
      if (sameSet(rule.byMonthDay, [28, 29]) && sameSet(rule.bySetPos, [-1])) return ok('yearly');
      return none;
    }
  }
}
