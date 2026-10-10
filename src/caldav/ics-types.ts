/**
 * Типы iCalendar (RFC 5545) для синхронизации с CalDAV (iCloud) и подписок ICS.
 *
 * Чистый модуль: без `obsidian` и DOM.
 */

/** `YYYY-MM-DD`. */
export type IcsDate = string;
/** `HH:MM` (секунды отбрасываются). */
export type IcsTime = string;

/**
 * Дата-время в том виде, в каком оно записано в файле.
 *  - `time: null` — весь день (VALUE=DATE);
 *  - `utc: true` — `...Z`, `date`/`time` в UTC;
 *  - `tzid` — IANA-зона (нестандартные TZID сопоставляются с IANA при разборе);
 *  - ни `utc`, ни `tzid` — плавающее время (местное время любого устройства).
 */
export interface IcsDateTime {
  date: IcsDate;
  time: IcsTime | null;
  tzid?: string | null;
  utc: boolean;
}

export type RruleFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type Weekday = 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';

/** Элемент BYDAY: `MO`, `2MO`, `-1FR`. */
export interface RruleByDay {
  day: Weekday;
  /** Номер в месяце/году; `null` — каждый такой день. */
  n: number | null;
}

export interface Rrule {
  freq: RruleFreq;
  interval: number;
  count?: number;
  until?: IcsDateTime;
  byDay?: RruleByDay[];
  byMonthDay?: number[];
  byMonth?: number[];
  bySetPos?: number[];
  wkst?: Weekday;
  /** Части, которые не поддерживаются разворотом (BYHOUR, BYWEEKNO, …): ключ → значение. */
  unsupported?: Record<string, string>;
}

/** Параметры и значение свойства (значение — как в файле, с экранированием). */
export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsAlarm {
  /** Минуты до начала события (отрицательное — после начала). */
  triggerMinutesBefore: number;
  action?: string;
  description?: string;
}

export type IcsEventStatus = 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED';

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  start: IcsDateTime;
  /** Конец (исключительный). Если в файле был DURATION — вычисляется. */
  end: IcsDateTime;
  /** Исходный DURATION, если конец задан им. */
  duration?: string;
  allDay: boolean;
  rrule?: Rrule;
  /** Исходный текст RRULE (сохраняется, даже если правило не разобрано). */
  rruleText?: string;
  exdates: IcsDateTime[];
  recurrenceId?: IcsDateTime;
  /** Известные значения — `IcsEventStatus`; прочие сохраняются как есть. */
  status?: IcsEventStatus | (string & Record<never, never>);
  lastModified?: IcsDateTime;
  created?: IcsDateTime;
  dtstamp?: IcsDateTime;
  sequence?: number;
  alarms: IcsAlarm[];
  categories?: string[];
  /** Прочие свойства события — переносятся без изменений при сериализации. */
  extra: IcsProperty[];
}

export interface IcsTimezone {
  /** TZID как в файле. */
  tzid: string;
  /** Сопоставленная IANA-зона или `null` (тогда время считается плавающим). */
  iana: string | null;
}

export interface IcsCalendar {
  events: IcsEvent[];
  /** X-WR-CALNAME. */
  name?: string;
  /** X-APPLE-CALENDAR-COLOR, нормализованный к `#rrggbb`. */
  color?: string;
  prodId?: string;
  method?: string;
  /** VTIMEZONE по TZID. */
  timezones: Record<string, IcsTimezone>;
}

/** Диапазон дат включительно. */
export interface IcsDateRange {
  from: IcsDate;
  to: IcsDate;
}

/** Повторение события, переведённое в целевую зону. */
export interface IcsOccurrence {
  /** Событие-источник: основное или переопределение (RECURRENCE-ID). */
  event: IcsEvent;
  /** Ключ исходного повторения (`YYYY-MM-DDTHH:MM` в зоне серии) — для переопределений и EXDATE. */
  recurrenceKey: string;
  allDay: boolean;
  /** В целевой зоне; для «весь день» `time: null`. */
  start: { date: IcsDate; time: IcsTime | null };
  /** Исключительный конец в целевой зоне. */
  end: { date: IcsDate; time: IcsTime | null };
  isOverride: boolean;
}

export interface IcsExpansion {
  occurrences: IcsOccurrence[];
  /** Достигнут лимит повторений на диапазон. */
  truncated: boolean;
  /** В RRULE есть неподдерживаемые части — развёрнуто только начало серии. */
  unsupported: boolean;
}
