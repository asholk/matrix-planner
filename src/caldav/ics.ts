/**
 * iCalendar (RFC 5545): разбор и запись VCALENDAR/VEVENT для CalDAV (iCloud) и подписок ICS.
 *
 * Чистый модуль: без `obsidian` и DOM; текущее время передаётся параметром.
 *
 * Время в событиях хранится как в файле (зона серии), с TZID, сопоставленным с IANA:
 * так разворот повторений корректен при переходах на летнее время. Перевод в зону
 * устройства — `toTimeZone()` / `expandOccurrences()` (rrule.ts).
 */

import { addDays } from '../model/dates';
import type { IcsAlarm, IcsCalendar, IcsDateTime, IcsEvent, IcsProperty, IcsTimezone } from './ics-types';
import {
  WEEKDAYS,
  epochToZoned,
  formatDateTimeValue,
  isIanaTimeZone,
  parseDateTimeValue,
  parseRrule,
  serializeRrule,
  toEpoch,
  zoneOffsetMinutes,
  zonedToEpoch,
} from './rrule';

export { deviceTimeZone, toTimeZone, toEpoch } from './rrule';

export const ICS_PRODID = '-//Matrix planner//Obsidian//RU';
const CRLF = '\r\n';
const MAX_LINE_OCTETS = 75;

const pad2 = (n: number) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// Строки содержимого
// ---------------------------------------------------------------------------

/** Разворот свёрнутых строк (CRLF/LF/CR + пробел или таб). */
export function unfoldLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

/** `NAME;P1=v;P2="a:b":value` → свойство; `null` — строка без двоеточия. */
export function parseContentLine(line: string): IcsProperty | null {
  let i = 0;
  while (i < line.length && line[i] !== ';' && line[i] !== ':') i++;
  if (i >= line.length) return null;
  const name = line.slice(0, i).trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  while (line[i] === ';') {
    i++;
    const eq = line.indexOf('=', i);
    if (eq < 0) return null;
    const key = line.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    const values: string[] = [];
    for (;;) {
      let value = '';
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return null;
        value = line.slice(i + 1, close);
        i = close + 1;
      } else {
        while (i < line.length && line[i] !== ';' && line[i] !== ':' && line[i] !== ',') value += line[i++];
      }
      values.push(value);
      if (line[i] === ',') i++;
      else break;
    }
    params[key] = values.join(',');
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

/** Снятие экранирования TEXT: `\\n`, `\\N`, `\\\\`, `\\;`, `\\,`. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

/** Экранирование TEXT. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Список TEXT через неэкранированные запятые. */
function splitTextList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else current += ch;
  }
  items.push(current);
  return items.map(unescapeText).filter((item) => item.length > 0);
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Свёртка строки по 75 октетам UTF-8 (символы не разрываются). */
export function foldLine(line: string): string {
  const chunks: string[] = [];
  let current = '';
  let octets = 0;
  let limit = MAX_LINE_OCTETS;
  for (const ch of line) {
    const size = utf8Length(ch.codePointAt(0)!);
    if (octets + size > limit) {
      chunks.push(current);
      current = '';
      octets = 0;
      limit = MAX_LINE_OCTETS - 1; // ведущий пробел занимает октет
    }
    current += ch;
    octets += size;
  }
  chunks.push(current);
  return chunks.join(`${CRLF} `);
}

function formatParamValue(value: string): string {
  return /[:;,]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

function formatProperty(prop: IcsProperty): string {
  let line = prop.name;
  for (const [key, value] of Object.entries(prop.params)) line += `;${key}=${formatParamValue(value)}`;
  return `${line}:${prop.value}`;
}

// ---------------------------------------------------------------------------
// Дерево компонентов
// ---------------------------------------------------------------------------

interface Component {
  name: string;
  props: IcsProperty[];
  children: Component[];
}

function parseComponents(text: string): Component[] {
  const root: Component = { name: '', props: [], children: [] };
  const stack: Component[] = [root];
  for (const line of unfoldLines(text)) {
    const prop = parseContentLine(line);
    if (!prop) continue;
    const top = stack[stack.length - 1];
    if (prop.name === 'BEGIN') {
      const child: Component = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(child);
      stack.push(child);
    } else if (prop.name === 'END') {
      const name = prop.value.trim().toUpperCase();
      // Закрываем до совпадающего компонента (терпимо к незакрытым вложенным).
      const index = stack.map((c) => c.name).lastIndexOf(name);
      if (index > 0) stack.length = index;
    } else top.props.push(prop);
  }
  return root.children;
}

function prop(component: Component, name: string): IcsProperty | undefined {
  return component.props.find((p) => p.name === name);
}

// ---------------------------------------------------------------------------
// Часовые пояса: TZID → IANA
// ---------------------------------------------------------------------------

/** Windows-имена зон (Outlook/Exchange) → IANA. */
const WINDOWS_ZONES: Record<string, string> = {
  'Russian Standard Time': 'Europe/Moscow',
  'Russia Time Zone 3': 'Europe/Samara',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Volgograd Standard Time': 'Europe/Volgograd',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Saratov Standard Time': 'Europe/Saratov',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Omsk Standard Time': 'Asia/Omsk',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'Altai Standard Time': 'Asia/Barnaul',
  'Tomsk Standard Time': 'Asia/Tomsk',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Transbaikal Standard Time': 'Asia/Chita',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Sakhalin Standard Time': 'Asia/Sakhalin',
  'Magadan Standard Time': 'Asia/Magadan',
  'Russia Time Zone 10': 'Asia/Srednekolymsk',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'Belarus Standard Time': 'Europe/Minsk',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Central Asia Standard Time': 'Asia/Almaty',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
};

/**
 * TZID → IANA: сам TZID, X-LIC-LOCATION из VTIMEZONE, Windows-имя, путь вида
 * `/mozilla.org/…/Europe/Moscow`, «(UTC+03:00) …» (только целые часы); иначе `null`.
 */
export function resolveTimeZoneId(tzid: string, licLocation?: string | null): string | null {
  const id = tzid.trim().replace(/^"|"$/g, '');
  if (!id) return null;
  if (id.includes('/') && isIanaTimeZone(id) && !id.startsWith('/')) return id;
  if (licLocation && isIanaTimeZone(licLocation.trim())) return licLocation.trim();
  const windows = WINDOWS_ZONES[id];
  if (windows) return windows;
  const segments = id.split('/').filter(Boolean);
  for (let n = Math.min(3, segments.length); n >= 1; n--) {
    const candidate = segments.slice(-n).join('/');
    if ((n > 1 || candidate === 'UTC') && isIanaTimeZone(candidate)) return candidate;
  }
  if (isIanaTimeZone(id)) return id;
  const offset = /^\(?(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?\)?/i.exec(id);
  if (offset) {
    if (offset[3] && offset[3] !== '00') return null;
    const hours = Number(offset[2]);
    if (hours === 0) return 'UTC';
    // В Etc/GMT знак обратный.
    return `Etc/GMT${offset[1] === '+' ? '-' : '+'}${hours}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Разбор
// ---------------------------------------------------------------------------

interface ParsedDuration {
  days: number;
  seconds: number;
  sign: 1 | -1;
}

/** `-PT15M`, `P1D`, `P1W`, `PT1H30M` → длительность; `null` — ошибка. */
export function parseDuration(value: string): ParsedDuration | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim().toUpperCase());
  if (!m || value.trim().toUpperCase().replace(/^[+-]/, '') === 'P') return null;
  return {
    sign: m[1] === '-' ? -1 : 1,
    days: Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0),
    seconds: Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0),
  };
}

function durationMinutes(d: ParsedDuration): number {
  return d.sign * (d.days * 1440 + Math.floor(d.seconds / 60));
}

/** Конец события по началу и DURATION (дни — по стене, часы — абсолютно). */
function addDuration(start: IcsDateTime, d: ParsedDuration): IcsDateTime {
  const days = d.sign * d.days;
  const minutes = d.sign * Math.floor(d.seconds / 60);
  if (start.time === null) return { ...start, date: addDays(start.date, days + Math.trunc(minutes / 1440)) };
  const date = addDays(start.date, days);
  if (start.tzid && !start.utc && isIanaTimeZone(start.tzid)) {
    const epoch = zonedToEpoch(date, start.time, start.tzid) + minutes * 60000;
    return { ...start, ...epochToZoned(epoch, start.tzid) };
  }
  const [h, mi] = start.time.split(':').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(1970, 0, 1, h, mi) + minutes * 60000);
  const dayShift = Math.floor((shifted.getTime() - Date.UTC(1970, 0, 1)) / 86400000);
  return {
    ...start,
    date: addDays(date, dayShift),
    time: `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`,
  };
}

type ZoneMap = Record<string, IcsTimezone>;

function readDateTime(p: IcsProperty, zones: ZoneMap): IcsDateTime | null {
  return readDateTimeValue(p.value, p.params, zones);
}

function readDateTimeValue(value: string, params: Record<string, string>, zones: ZoneMap): IcsDateTime | null {
  const rawTzid = params.TZID;
  let tzid: string | null = null;
  if (rawTzid) tzid = zones[rawTzid]?.iana ?? resolveTimeZoneId(rawTzid);
  const dt = parseDateTimeValue(value, tzid);
  if (!dt) return null;
  if (params.VALUE?.toUpperCase() === 'DATE' && dt.time !== null) return { date: dt.date, time: null, tzid: null, utc: false };
  return dt;
}

function readAlarm(component: Component, start: IcsDateTime, end: IcsDateTime): IcsAlarm | null {
  const action = prop(component, 'ACTION')?.value.trim().toUpperCase();
  // iOS пишет «пустые» напоминания с ACTION:NONE.
  if (action === 'NONE') return null;
  const trigger = prop(component, 'TRIGGER');
  if (!trigger) return null;
  let minutesBefore: number;
  if (trigger.params.VALUE?.toUpperCase() === 'DATE-TIME') {
    const at = parseDateTimeValue(trigger.value);
    const startEpoch = toEpoch(start);
    const atEpoch = at ? toEpoch(at) : null;
    if (startEpoch === null || atEpoch === null) return null;
    minutesBefore = Math.round((startEpoch - atEpoch) / 60000);
  } else {
    const d = parseDuration(trigger.value);
    if (!d) return null;
    const offset = durationMinutes(d);
    if (trigger.params.RELATED?.toUpperCase() === 'END') {
      const s = toEpoch(start, 'UTC');
      const e = toEpoch(end, 'UTC');
      const length = s !== null && e !== null ? Math.round((e - s) / 60000) : 0;
      minutesBefore = -(length + offset);
    } else minutesBefore = -offset;
  }
  const alarm: IcsAlarm = { triggerMinutesBefore: minutesBefore === 0 ? 0 : minutesBefore };
  if (action) alarm.action = action;
  const description = prop(component, 'DESCRIPTION');
  if (description) alarm.description = unescapeText(description.value);
  return alarm;
}

const HANDLED = new Set([
  'UID', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'EXDATE',
  'RECURRENCE-ID', 'STATUS', 'LAST-MODIFIED', 'CREATED', 'DTSTAMP', 'SEQUENCE', 'CATEGORIES',
]);

function readEvent(component: Component, zones: ZoneMap): IcsEvent | null {
  const dtstart = prop(component, 'DTSTART');
  const start = dtstart ? readDateTime(dtstart, zones) : null;
  if (!start) return null;
  const allDay = start.time === null;
  const summaryProp = prop(component, 'SUMMARY');
  const summary = summaryProp ? unescapeText(summaryProp.value) : '';
  const uid = prop(component, 'UID')?.value.trim() || `${formatDateTimeValue(start)}-${summary}`;

  let end: IcsDateTime | null = null;
  let duration: string | undefined;
  const dtend = prop(component, 'DTEND');
  if (dtend) end = readDateTime(dtend, zones);
  if (!end) {
    const durationProp = prop(component, 'DURATION');
    const parsed = durationProp ? parseDuration(durationProp.value) : null;
    if (parsed && durationProp) {
      duration = durationProp.value.trim();
      end = addDuration(start, parsed);
    }
  }
  if (!end) end = allDay ? { ...start, date: addDays(start.date, 1) } : { ...start };
  if (allDay && end.time !== null) end = { date: end.date, time: null, tzid: null, utc: false };
  if (allDay && end.date <= start.date) end = { ...end, date: addDays(start.date, 1) };

  const event: IcsEvent = { uid, summary, start, end, allDay, exdates: [], alarms: [], extra: [] };
  if (duration) event.duration = duration;
  let rruleSeen = false;
  for (const p of component.props) {
    switch (p.name) {
      case 'DESCRIPTION':
        event.description = unescapeText(p.value);
        break;
      case 'LOCATION':
        event.location = unescapeText(p.value);
        break;
      case 'URL':
        event.url = p.value.trim();
        break;
      case 'RRULE':
        if (rruleSeen) {
          event.extra.push(p);
          break;
        }
        rruleSeen = true;
        event.rruleText = p.value.trim();
        {
          const rule = parseRrule(p.value);
          if (rule) event.rrule = rule;
        }
        break;
      case 'EXDATE':
        for (const value of p.value.split(',')) {
          const dt = readDateTimeValue(value, p.params, zones);
          if (dt) event.exdates.push(dt);
        }
        break;
      case 'RECURRENCE-ID': {
        const dt = readDateTime(p, zones);
        if (dt) event.recurrenceId = dt;
        break;
      }
      case 'STATUS':
        event.status = p.value.trim().toUpperCase();
        break;
      case 'LAST-MODIFIED': {
        const dt = readDateTime(p, zones);
        if (dt) event.lastModified = dt;
        break;
      }
      case 'CREATED': {
        const dt = readDateTime(p, zones);
        if (dt) event.created = dt;
        break;
      }
      case 'DTSTAMP': {
        const dt = readDateTime(p, zones);
        if (dt) event.dtstamp = dt;
        break;
      }
      case 'SEQUENCE': {
        const n = Number(p.value.trim());
        if (Number.isInteger(n)) event.sequence = n;
        break;
      }
      case 'CATEGORIES':
        event.categories = [...(event.categories ?? []), ...splitTextList(p.value)];
        break;
      default:
        if (!HANDLED.has(p.name)) event.extra.push(p);
    }
  }
  for (const child of component.children) {
    if (child.name !== 'VALARM') continue;
    const alarm = readAlarm(child, start, end);
    if (alarm) event.alarms.push(alarm);
  }
  return event;
}

function normalizeColor(value: string): string | undefined {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim());
  if (m) return `#${m[1].toLowerCase()}`;
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value.trim());
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return undefined;
}

/** Разбор текста ICS (один или несколько VCALENDAR; VEVENT без VCALENDAR тоже читаются). */
export function parseIcs(text: string): IcsCalendar {
  const roots = parseComponents(text);
  const calendar: IcsCalendar = { events: [], timezones: {} };
  const calendars = roots.filter((c) => c.name === 'VCALENDAR');
  const containers: Component[] = calendars.length ? calendars : [{ name: 'VCALENDAR', props: [], children: roots }];
  for (const cal of containers) {
    for (const tz of cal.children.filter((c) => c.name === 'VTIMEZONE')) {
      const tzid = prop(tz, 'TZID')?.value.trim();
      if (!tzid) continue;
      calendar.timezones[tzid] = { tzid, iana: resolveTimeZoneId(tzid, prop(tz, 'X-LIC-LOCATION')?.value) };
    }
  }
  for (const cal of containers) {
    const name = prop(cal, 'X-WR-CALNAME');
    if (name && calendar.name === undefined) calendar.name = unescapeText(name.value);
    const color = prop(cal, 'X-APPLE-CALENDAR-COLOR');
    if (color && calendar.color === undefined) {
      const normalized = normalizeColor(color.value);
      if (normalized) calendar.color = normalized;
    }
    const prodId = prop(cal, 'PRODID');
    if (prodId && calendar.prodId === undefined) calendar.prodId = prodId.value;
    const method = prop(cal, 'METHOD');
    if (method && calendar.method === undefined) calendar.method = method.value.trim().toUpperCase();
    for (const child of cal.children) {
      if (child.name !== 'VEVENT') continue;
      const event = readEvent(child, calendar.timezones);
      if (event) calendar.events.push(event);
    }
  }
  return calendar;
}

// ---------------------------------------------------------------------------
// Минимальный VTIMEZONE через Intl
// ---------------------------------------------------------------------------

interface Transition {
  epoch: number;
  from: number;
  to: number;
}

function transitionsInYear(timeZone: string, year: number): Transition[] {
  const result: Transition[] = [];
  const day = 86400000;
  let t = Date.UTC(year, 0, 1);
  const stop = Date.UTC(year + 1, 0, 1);
  let offset = zoneOffsetMinutes(t, timeZone);
  while (t < stop) {
    const next = t + day;
    const nextOffset = zoneOffsetMinutes(next, timeZone);
    if (nextOffset !== offset) {
      let lo = t;
      let hi = next;
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
        if (zoneOffsetMinutes(mid, timeZone) === offset) lo = mid;
        else hi = mid;
      }
      result.push({ epoch: hi, from: offset, to: nextOffset });
      offset = nextOffset;
    }
    t = next;
  }
  return result;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

function wallValue(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}00`;
}

/** n-й (или последний при n = -1) день недели месяца. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (n > 0) return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  const last = new Date(Date.UTC(year, month - 1, dim)).getUTCDay();
  return dim - ((last - weekday + 7) % 7);
}

/**
 * Минимальный VTIMEZONE для IANA-зоны по правилам года `year` (переходы находятся через Intl).
 * Два перехода в году → STANDARD/DAYLIGHT с ежегодным RRULE (BYMONTH + BYDAY), начиная с 1970;
 * без переходов — одно STANDARD.
 */
export function buildVtimezone(timeZone: string, year: number): string[] {
  const lines = ['BEGIN:VTIMEZONE', `TZID:${timeZone}`, `X-LIC-LOCATION:${timeZone}`];
  const transitions = transitionsInYear(timeZone, year);
  if (transitions.length === 0) {
    const offset = formatOffset(zoneOffsetMinutes(Date.UTC(year, 0, 1), timeZone));
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, 'END:STANDARD');
  } else if (transitions.length === 2) {
    for (const tr of transitions) {
      const local = tr.epoch + tr.from * 60000;
      const d = new Date(local);
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const dim = new Date(Date.UTC(d.getUTCFullYear(), month, 0)).getUTCDate();
      const n = day + 7 > dim ? -1 : Math.ceil(day / 7);
      const weekday = d.getUTCDay();
      const startDay = nthWeekday(1970, month, weekday, n);
      const kind = tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD';
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:1970${pad2(month)}${pad2(startDay)}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}00`,
        `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${n}${WEEKDAYS[weekday]}`,
        `TZOFFSETFROM:${formatOffset(tr.from)}`,
        `TZOFFSETTO:${formatOffset(tr.to)}`,
        `END:${kind}`,
      );
    }
  } else {
    // Нерегулярные переходы (смена правил зоны): точные даты года без RRULE.
    const first = transitions[0];
    lines.push(
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${formatOffset(first.from)}`,
      `TZOFFSETTO:${formatOffset(first.from)}`,
      'END:STANDARD',
    );
    for (const tr of transitions) {
      const kind = tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD';
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${wallValue(tr.epoch + tr.from * 60000)}`,
        `TZOFFSETFROM:${formatOffset(tr.from)}`,
        `TZOFFSETTO:${formatOffset(tr.to)}`,
        `END:${kind}`,
      );
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

export interface SerializeOptions {
  /** Текущий момент (DTSTAMP). */
  now: Date;
  /** Добавлять VTIMEZONE для TZID (по умолчанию да — RFC 5545 §3.6.5 требует его). */
  includeTimezones?: boolean;
  /** X-WR-CALNAME (для экспорта файла). */
  calendarName?: string;
  method?: string;
}

function dateTimeLine(name: string, dt: IcsDateTime): string {
  const value = formatDateTimeValue(dt);
  if (dt.time === null) return `${name};VALUE=DATE:${value}`;
  if (dt.utc) return `${name}:${value}`;
  if (dt.tzid) return `${name};TZID=${formatParamValue(dt.tzid)}:${value}`;
  return `${name}:${value}`;
}

function utcStamp(now: Date): string {
  return `${wallValue(now.getTime()).slice(0, 13)}${pad2(now.getUTCSeconds())}Z`;
}

function alarmLines(alarm: IcsAlarm, summary: string): string[] {
  const minutes = -alarm.triggerMinutesBefore;
  const abs = Math.abs(minutes);
  const sign = minutes < 0 ? '-' : '';
  let trigger: string;
  if (abs === 0) trigger = 'PT0S';
  else if (abs % 1440 === 0) trigger = `${sign}P${abs / 1440}D`;
  else if (abs % 60 === 0) trigger = `${sign}PT${abs / 60}H`;
  else trigger = `${sign}PT${abs}M`;
  const action = alarm.action && alarm.action !== 'NONE' ? alarm.action : 'DISPLAY';
  const lines = ['BEGIN:VALARM', `ACTION:${action}`, `TRIGGER:${trigger}`];
  if (action === 'DISPLAY' || action === 'EMAIL') lines.push(`DESCRIPTION:${escapeText(alarm.description ?? (summary || 'Reminder'))}`);
  lines.push('END:VALARM');
  return lines;
}

function eventLines(event: IcsEvent, now: Date): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${utcStamp(now)}`];
  if (event.created) lines.push(dateTimeLine('CREATED', event.created));
  if (event.lastModified) lines.push(dateTimeLine('LAST-MODIFIED', event.lastModified));
  if (event.sequence !== undefined) lines.push(`SEQUENCE:${event.sequence}`);
  const allDay = event.allDay || event.start.time === null;
  const start = allDay ? { date: event.start.date, time: null, tzid: null, utc: false } : event.start;
  let end = event.end;
  if (allDay) {
    const endDate = end.date > start.date ? end.date : addDays(start.date, 1);
    end = { date: endDate, time: null, tzid: null, utc: false };
  }
  lines.push(dateTimeLine('DTSTART', start), dateTimeLine('DTEND', end));
  if (event.recurrenceId) lines.push(dateTimeLine('RECURRENCE-ID', event.recurrenceId));
  if (event.rrule) lines.push(`RRULE:${serializeRrule(event.rrule)}`);
  else if (event.rruleText) lines.push(`RRULE:${event.rruleText}`);
  for (const ex of event.exdates) lines.push(dateTimeLine('EXDATE', allDay ? { ...ex, time: null, tzid: null, utc: false } : ex));
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.url) lines.push(`URL;VALUE=URI:${event.url}`);
  if (event.status) lines.push(`STATUS:${event.status}`);
  if (event.categories?.length) lines.push(`CATEGORIES:${event.categories.map(escapeText).join(',')}`);
  for (const p of event.extra) lines.push(formatProperty(p));
  for (const alarm of event.alarms) lines.push(...alarmLines(alarm, event.summary));
  lines.push('END:VEVENT');
  return lines;
}

function usedZones(events: readonly IcsEvent[]): Map<string, number> {
  const zones = new Map<string, number>();
  const add = (dt: IcsDateTime | undefined) => {
    if (!dt || dt.utc || dt.time === null || !dt.tzid || !isIanaTimeZone(dt.tzid) || dt.tzid === 'UTC') return;
    const year = Number(dt.date.slice(0, 4));
    const known = zones.get(dt.tzid);
    if (known === undefined || year < known) zones.set(dt.tzid, year);
  };
  for (const e of events) {
    add(e.start);
    add(e.end);
    add(e.recurrenceId);
    e.exdates.forEach(add);
  }
  return zones;
}

/**
 * Полный VCALENDAR с событиями (основное + переопределения одного UID — в одном ресурсе CalDAV).
 * CRLF, свёртка по 75 октетам UTF-8, экранирование, DTSTAMP, VTIMEZONE для каждого TZID.
 */
export function serializeCalendar(events: readonly IcsEvent[], options: SerializeOptions): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${ICS_PRODID}`, 'CALSCALE:GREGORIAN'];
  if (options.method) lines.push(`METHOD:${options.method}`);
  if (options.calendarName) lines.push(`X-WR-CALNAME:${escapeText(options.calendarName)}`);
  if (options.includeTimezones !== false) {
    for (const [zone, year] of usedZones(events)) lines.push(...buildVtimezone(zone, year));
  }
  for (const event of events) lines.push(...eventLines(event, options.now));
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** Одно событие → полный VCALENDAR. */
export function serializeEvent(event: IcsEvent, options: SerializeOptions): string {
  return serializeCalendar([event], options);
}
