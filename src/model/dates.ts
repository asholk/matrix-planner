/**
 * Даты и плавающее время (ТЗ §3.2): чистые функции без `obsidian` и DOM.
 *
 * Календарная арифметика — на номерах дней (без `Date` и часовых поясов), поэтому
 * результат одинаков на любом устройстве и совпадает с будущей реализацией на Swift.
 * Текущее время передаётся параметром (`FloatingDateTime`), см. `floatingFromDate`.
 */

import type {
  FloatingDateTime,
  LocalDateString,
  LocalDateTimeString,
  LocalTimeString,
} from './types';

// ---------------------------------------------------------------------------
// Разбор и форматирование
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
/** Дата, затем необязательное время (`T` или пробел), секунды, доли и смещение (смещение игнорируется). */
const FLOATING_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function pad4(value: number): string {
  return String(value).padStart(4, '0');
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Число дней в месяце (`month` 1–12). */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export interface DateParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
}

/** Разбирает строгую `YYYY-MM-DD`; несуществующая дата (31 апреля) — `null`. */
export function parseDateParts(value: string): DateParts | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function formatDateParts(parts: DateParts): LocalDateString {
  return `${pad4(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function isValidDate(value: unknown): value is LocalDateString {
  return typeof value === 'string' && parseDateParts(value) !== null;
}

export function isValidTime(value: unknown): value is LocalTimeString {
  if (typeof value !== 'string') return false;
  const m = TIME_RE.exec(value);
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

/**
 * Разбирает значение свойства «Дата» / «Дата и время».
 * Принимает `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm[:ss]`, пробел вместо `T`; смещение отбрасывается
 * (время плавающее). `Date` (если YAML-парсер вернул timestamp) читается по UTC-полям,
 * так как такие парсеры трактуют время без смещения как UTC.
 */
export function parseFloating(value: unknown): FloatingDateTime | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const date = formatDateParts({
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
    });
    const h = value.getUTCHours();
    const min = value.getUTCMinutes();
    return { date, time: h === 0 && min === 0 && value.getUTCSeconds() === 0 ? null : `${pad2(h)}:${pad2(min)}` };
  }
  if (typeof value !== 'string') return null;
  const m = FLOATING_RE.exec(value.trim());
  if (!m) return null;
  const date = m[1];
  if (!parseDateParts(date)) return null;
  if (m[2] === undefined) return { date, time: null };
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  const seconds = m[4] === undefined ? 0 : Number(m[4]);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return { date, time: `${pad2(hours)}:${pad2(minutes)}` };
}

/** Только дата: дата-время сводится к дате. */
export function parseLocalDate(value: unknown): LocalDateString | null {
  return parseFloating(value)?.date ?? null;
}

/** `YYYY-MM-DD` или `YYYY-MM-DDTHH:mm` — форма для YAML. */
export function formatFloating(value: FloatingDateTime): LocalDateTimeString {
  return value.time === null ? value.date : `${value.date}T${value.time}`;
}

export function floating(date: LocalDateString, time: LocalTimeString | null = null): FloatingDateTime {
  return { date, time };
}

// ---------------------------------------------------------------------------
// Арифметика дат (номер дня от 1970-01-01, алгоритм days_from_civil)
// ---------------------------------------------------------------------------

export function dayNumberFromParts(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function partsFromDayNumber(dayNumber: number): DateParts {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function requireParts(date: LocalDateString): DateParts {
  const parts = parseDateParts(date);
  if (!parts) throw new RangeError(`Invalid date: ${date}`);
  return parts;
}

export function toDayNumber(date: LocalDateString): number {
  const p = requireParts(date);
  return dayNumberFromParts(p.year, p.month, p.day);
}

export function fromDayNumber(dayNumber: number): LocalDateString {
  return formatDateParts(partsFromDayNumber(dayNumber));
}

export function addDays(date: LocalDateString, days: number): LocalDateString {
  return fromDayNumber(toDayNumber(date) + days);
}

/** `to − from` в днях. */
export function diffDays(from: LocalDateString, to: LocalDateString): number {
  return toDayNumber(to) - toDayNumber(from);
}

/** День недели: 0 — воскресенье … 6 — суббота (как `Date.getDay()`). */
export function weekday(date: LocalDateString): number {
  // 1970-01-01 — четверг (4).
  return (((toDayNumber(date) + 4) % 7) + 7) % 7;
}

/** Начало недели, содержащей `date`; `weekStart` 0 — воскресенье, 1 — понедельник. */
export function startOfWeek(date: LocalDateString, weekStart: 0 | 1): LocalDateString {
  const shift = (weekday(date) - weekStart + 7) % 7;
  return addDays(date, -shift);
}

/**
 * Сдвиг на `months` месяцев с привязкой к дню `anchorDay` (по умолчанию день `date`):
 * если такого дня нет в месяце — последний день месяца.
 */
export function addMonthsClamped(date: LocalDateString, months: number, anchorDay?: number): LocalDateString {
  const p = requireParts(date);
  const total = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  const day = Math.min(anchorDay ?? p.day, daysInMonth(year, month));
  return formatDateParts({ year, month, day });
}

/** Сравнение строк дат (лексикографическое корректно для `YYYY-MM-DD`). */
export function compareDates(a: LocalDateString, b: LocalDateString): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxDate(a: LocalDateString, b: LocalDateString): LocalDateString {
  return a >= b ? a : b;
}

export function isDateInRange(date: LocalDateString, from: LocalDateString, to: LocalDateString): boolean {
  return date >= from && date <= to;
}

/** Все даты диапазона включительно. */
export function datesInRange(from: LocalDateString, to: LocalDateString): LocalDateString[] {
  const result: LocalDateString[] = [];
  const start = toDayNumber(from);
  const end = toDayNumber(to);
  for (let n = start; n <= end; n++) result.push(fromDayNumber(n));
  return result;
}

// ---------------------------------------------------------------------------
// Время
// ---------------------------------------------------------------------------

export function timeToMinutes(time: LocalTimeString): number {
  const m = TIME_RE.exec(time);
  if (!m) throw new RangeError(`Invalid time: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Минуты 0–1439 → `HH:mm` (значения вне суток сворачиваются). */
export function minutesToTime(minutes: number): LocalTimeString {
  const normalized = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

/** Сдвиг дата-времени на минуты с переходом через полночь. Для даты без времени считается 00:00. */
export function addMinutes(value: FloatingDateTime, minutes: number): FloatingDateTime {
  const total = toDayNumber(value.date) * 1440 + (value.time === null ? 0 : timeToMinutes(value.time)) + minutes;
  const day = Math.floor(total / 1440);
  return { date: fromDayNumber(day), time: minutesToTime(total - day * 1440) };
}

/**
 * Сравнение плавающих дата-времени. Дата без времени считается началом дня
 * (раньше любой дата-времени того же дня).
 */
export function compareFloating(a: FloatingDateTime, b: FloatingDateTime): number {
  const byDate = compareDates(a.date, b.date);
  if (byDate !== 0) return byDate;
  if (a.time === b.time) return 0;
  if (a.time === null) return -1;
  if (b.time === null) return 1;
  return a.time < b.time ? -1 : 1;
}

/**
 * Срок прошёл: дата без времени — если день уже прошёл; со временем — если наступило время.
 * `now` — текущее местное время устройства (см. `floatingFromDate`).
 */
export function isPastDue(due: FloatingDateTime, now: FloatingDateTime): boolean {
  if (due.date !== now.date) return due.date < now.date;
  if (due.time === null || now.time === null) return false;
  return due.time < now.time;
}

// ---------------------------------------------------------------------------
// Перевод момента времени в плавающее время
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Проверка IANA-зоны средствами `Intl`. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    zonedFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Момент времени → местная дата-время. Без `timeZone` — зона устройства (локальные поля `Date`),
 * с `timeZone` — указанная IANA-зона (учитывает DST).
 */
export function floatingFromDate(moment: Date, timeZone?: string): FloatingDateTime & { time: LocalTimeString } {
  if (!timeZone) {
    return {
      date: formatDateParts({ year: moment.getFullYear(), month: moment.getMonth() + 1, day: moment.getDate() }),
      time: `${pad2(moment.getHours())}:${pad2(moment.getMinutes())}`,
    };
  }
  const parts: Record<string, string> = {};
  for (const part of zonedFormatter(timeZone).formatToParts(moment)) parts[part.type] = part.value;
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${pad2(hour)}:${parts.minute}`,
  };
}

/** Местная дата момента времени. */
export function localDateOf(moment: Date, timeZone?: string): LocalDateString {
  return floatingFromDate(moment, timeZone).date;
}

/** `YYYY-MM-DDTHH:mm` для свойств `created`/`completed`. */
export function localDateTimeOf(moment: Date, timeZone?: string): LocalDateTimeString {
  return formatFloating(floatingFromDate(moment, timeZone));
}

// ---------------------------------------------------------------------------
// Относительные подписи («Сегодня 17:00», «Завтра 12:30», «16 окт. 15:00», «Вчера»)
// ---------------------------------------------------------------------------

/** Локализованные строки подписей (из словаря `model`, см. `createDateLabelStrings`). */
export interface DateLabelStrings {
  today: string;
  tomorrow: string;
  yesterday: string;
  /** 12 коротких названий месяцев в форме для «16 окт.». */
  monthsShort: readonly string[];
  /** Шаблон `{day}`/`{month}` для даты текущего года. */
  dayMonth: string;
  /** Шаблон `{day}`/`{month}`/`{year}` для даты другого года. */
  dayMonthYear: string;
  /** Шаблон `{date}`/`{time}` для даты со временем. */
  dateTime: string;
  am: string;
  pm: string;
}

/** Ключи словаря `model` (регистрируется как модуль `model`). */
export const DATE_LABEL_KEYS = {
  today: 'model.dates.today',
  tomorrow: 'model.dates.tomorrow',
  yesterday: 'model.dates.yesterday',
  dayMonth: 'model.dates.dayMonth',
  dayMonthYear: 'model.dates.dayMonthYear',
  dateTime: 'model.dates.dateTime',
  am: 'model.dates.am',
  pm: 'model.dates.pm',
  /** `model.dates.monthsShort.m1` … `m12`. */
  monthPrefix: 'model.dates.monthsShort.m',
} as const;

/** Собирает строки подписей через переданную функцию перевода (например, `t` из `src/i18n`). */
export function createDateLabelStrings(translate: (key: string) => string): DateLabelStrings {
  const monthsShort: string[] = [];
  for (let i = 1; i <= 12; i++) monthsShort.push(translate(`${DATE_LABEL_KEYS.monthPrefix}${i}`));
  return {
    today: translate(DATE_LABEL_KEYS.today),
    tomorrow: translate(DATE_LABEL_KEYS.tomorrow),
    yesterday: translate(DATE_LABEL_KEYS.yesterday),
    monthsShort,
    dayMonth: translate(DATE_LABEL_KEYS.dayMonth),
    dayMonthYear: translate(DATE_LABEL_KEYS.dayMonthYear),
    dateTime: translate(DATE_LABEL_KEYS.dateTime),
    am: translate(DATE_LABEL_KEYS.am),
    pm: translate(DATE_LABEL_KEYS.pm),
  };
}

function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] === undefined ? match : String(params[name]),
  );
}

/** `17:00` или `5:00 PM`. */
export function formatTimeLabel(time: LocalTimeString, hour12: boolean, strings: Pick<DateLabelStrings, 'am' | 'pm'>): string {
  if (!hour12) return time;
  const minutes = timeToMinutes(time);
  const h24 = Math.floor(minutes / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${pad2(minutes % 60)} ${h24 < 12 ? strings.am : strings.pm}`;
}

export type RelativeDay = 'yesterday' | 'today' | 'tomorrow';

export function relativeDay(date: LocalDateString, today: LocalDateString): RelativeDay | null {
  const diff = diffDays(today, date);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return null;
}

/** «Сегодня», «Завтра», «Вчера», «16 окт.», «16 окт. 2027». */
export function formatDateLabel(date: LocalDateString, today: LocalDateString, strings: DateLabelStrings): string {
  const rel = relativeDay(date, today);
  if (rel) return strings[rel];
  const p = requireParts(date);
  const month = strings.monthsShort[p.month - 1] ?? String(p.month);
  const sameYear = p.year === requireParts(today).year;
  return fill(sameYear ? strings.dayMonth : strings.dayMonthYear, { day: p.day, month, year: p.year });
}

export interface DueLabelOptions {
  hour12?: boolean;
  /** Длительность задачи, мин: время показывается диапазоном «18:00–19:30». */
  duration?: number | null;
}

/**
 * Время срока: начало или диапазон «18:00–19:30» при длительности (конец — по модулю суток).
 */
export function formatDueTimeLabel(
  time: LocalTimeString,
  duration: number | null | undefined,
  hour12: boolean,
  strings: Pick<DateLabelStrings, 'am' | 'pm'>,
): string {
  const start = formatTimeLabel(time, hour12, strings);
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration <= 0) return start;
  const end = minutesToTime((timeToMinutes(time) + duration) % 1440);
  return `${start}–${formatTimeLabel(end, hour12, strings)}`;
}

/** Подпись срока задачи: «Сегодня 17:00», «Сегодня 18:00–19:30», «16 окт. 15:00», «Вчера». */
export function formatDueLabel(
  due: FloatingDateTime,
  today: LocalDateString,
  strings: DateLabelStrings,
  options: DueLabelOptions = {},
): string {
  const date = formatDateLabel(due.date, today, strings);
  if (due.time === null) return date;
  return fill(strings.dateTime, { date, time: formatDueTimeLabel(due.time, options.duration, options.hour12 ?? false, strings) });
}
