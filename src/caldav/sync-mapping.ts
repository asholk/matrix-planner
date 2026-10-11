/**
 * Перевод заметок-событий и задач в события iCalendar и обратно (ТЗ §5.4.1–5.4.2).
 * Чистый модуль: без `obsidian` и DOM; время и зона передаются параметрами.
 */

import type { IcsAlarm, IcsDateTime, IcsEvent } from './ics-types';
import { presetToRrule, rruleToPreset, toTimeZone, utcDateTime } from './rrule';
import { ITEM_URL_PREFIX, linkedItemIdOf } from '../calendar/cache-schema';
import { addDays, addMinutes, parseFloating, timeToMinutes } from '../model/dates';
import { DEFAULT_TASK_DURATION, isValidDuration } from '../model/duration';
import type {
  EventPatch,
  FloatingDateTime,
  ItemId,
  LocalTimeString,
  PlannerEvent,
  RemindOffset,
  RepeatRule,
  Task,
} from '../model/types';

/**
 * Длительность события задачи со временем без свойства `duration` и выполненной задачи
 * (ТЗ §5.4.1), мин. Задача с `duration` занимает в календаре свою длительность.
 */
export const TASK_EVENT_MINUTES = DEFAULT_TASK_DURATION;
export const COMPLETED_TASK_EVENT_MINUTES = 15;
export const TASK_OPEN_PREFIX = '○ ';
export const TASK_DONE_PREFIX = '✓ ';

/** Ссылка на заметку в поле URL события. */
export function itemUrl(id: ItemId): string {
  return `${ITEM_URL_PREFIX}${id}`;
}

/** id заметки Планировщика, если событие создано Планировщиком (URL `matrixplanner://item/<id>`). */
export function plannerItemIdOf(event: Pick<IcsEvent, 'url'>): ItemId | null {
  return linkedItemIdOf(null, event.url ?? null);
}

/** Короткий стабильный хеш (FNV-1a, 32 бит) — для сравнения версий, не для защиты. */
export function hashOf(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Тело заметки ↔ DESCRIPTION: без `\r` и пробелов по краям. */
export function normalizeBody(body: string | null | undefined): string {
  return (body ?? '').replace(/\r\n?/g, '\n').trim();
}

// ---------------------------------------------------------------------------
// Заметки-события (двусторонне)
// ---------------------------------------------------------------------------

/** Синхронизируемые поля заметки-события. Для «весь день» `end` — исключительная дата. */
export interface EventFields {
  title: string;
  allDay: boolean;
  start: FloatingDateTime;
  end: FloatingDateTime;
  tz: string | null;
  repeat: RepeatRule;
  body: string;
}

export function eventFieldsOf(event: PlannerEvent, body: string): EventFields {
  return {
    title: event.title,
    allDay: event.allDay,
    start: { date: event.start.date, time: event.allDay ? null : event.start.time },
    end: { date: event.end.date, time: event.allDay ? null : event.end.time },
    tz: event.tz,
    repeat: event.repeat,
    body: normalizeBody(body),
  };
}

export function eventFieldsHash(fields: EventFields): string {
  return hashOf(['event', fields.title, fields.allDay, fields.start, fields.end, fields.tz, fields.repeat, fields.body]);
}

function dateOnly(date: string): IcsDateTime {
  return { date, time: null, tzid: null, utc: false };
}

function zoned(value: FloatingDateTime, zone: string): IcsDateTime {
  return { date: value.date, time: value.time, tzid: zone, utc: false };
}

/** Основное событие ресурса: без RECURRENCE-ID, предпочтительно с UID = id. */
export function masterOf(events: readonly IcsEvent[], uid?: string): IcsEvent | null {
  const masters = events.filter((event) => !event.recurrenceId);
  return masters.find((event) => event.uid === uid) ?? masters[0] ?? null;
}

/**
 * Заметка → событие. Поля, которых нет в заметке (место, напоминания, свойства iOS),
 * переносятся из `base` (текущая версия на сервере). Время без зоны пишется в зоне устройства.
 */
export function eventToIcs(id: ItemId, fields: EventFields, base: IcsEvent | null, now: Date, deviceZone: string): IcsEvent {
  const zone = fields.tz ?? deviceZone;
  const start = fields.allDay ? dateOnly(fields.start.date) : zoned(fields.start, zone);
  let end: IcsDateTime;
  if (fields.allDay) end = dateOnly(fields.end.date > fields.start.date ? fields.end.date : addDays(fields.start.date, 1));
  else end = zoned(fields.end.time === null ? fields.start : fields.end, zone);

  // Повтор: пресет заметки; нестандартное правило iOS сохраняется, пока в заметке нет пресета.
  let rrule = presetToRrule(fields.repeat, fields.start.date) ?? undefined;
  let rruleText: string | undefined;
  if (!rrule && base && (base.rrule || base.rruleText) && rruleToPreset(base.rrule ?? base.rruleText, base.start.date).extra) {
    rrule = base.rrule;
    rruleText = base.rruleText;
  }

  const event: IcsEvent = {
    ...(base ?? { exdates: [], alarms: [], extra: [] }),
    uid: id,
    summary: fields.title,
    start,
    end,
    allDay: fields.allDay,
    url: itemUrl(id),
    exdates: base && rrule ? base.exdates : [],
    lastModified: utcDateTime(now.getTime()),
    sequence: base ? (base.sequence ?? 0) + 1 : 0,
  };
  delete event.duration;
  delete event.recurrenceId;
  if (rrule) event.rrule = rrule;
  else delete event.rrule;
  if (rruleText) event.rruleText = rruleText;
  else delete event.rruleText;
  if (fields.body) event.description = fields.body;
  else delete event.description;
  if (!base) event.created = utcDateTime(now.getTime());
  return event;
}

/**
 * Событие с сервера → поля заметки. Время переводится в зону заметки (или устройства);
 * повтор, не сводимый к пресету, не меняет повтор заметки.
 */
export function fieldsFromServer(server: IcsEvent, current: EventFields, deviceZone: string): EventFields {
  const allDay = server.allDay || server.start.time === null;
  const zone = current.tz ?? deviceZone;
  let start: FloatingDateTime;
  let end: FloatingDateTime;
  if (allDay) {
    start = { date: server.start.date, time: null };
    const endDate = server.end.date > server.start.date ? server.end.date : addDays(server.start.date, 1);
    end = { date: endDate, time: null };
  } else {
    start = toTimeZone(server.start, zone);
    end = server.end.time === null ? start : toTimeZone(server.end, zone);
  }
  const preset = rruleToPreset(server.rrule ?? server.rruleText ?? null, server.start.date);
  return {
    title: server.summary,
    allDay,
    start,
    end,
    tz: current.tz,
    repeat: preset.extra ? current.repeat : preset.repeat,
    body: normalizeBody(server.description),
  };
}

/** Патч формы события из изменившихся полей (конец «весь день» в черновике — включительный). */
export function fieldsToPatch(next: EventFields, current: EventFields): EventPatch | null {
  const patch: EventPatch = {};
  if (next.title.trim() !== '' && next.title !== current.title) patch.title = next.title;
  const scheduleChanged =
    next.allDay !== current.allDay ||
    JSON.stringify(next.start) !== JSON.stringify(current.start) ||
    JSON.stringify(next.end) !== JSON.stringify(current.end);
  if (scheduleChanged) {
    patch.allDay = next.allDay;
    patch.start = next.start;
    patch.end = next.allDay ? { date: addDays(next.end.date, -1), time: null } : next.end;
  }
  if (next.repeat !== current.repeat) patch.repeat = next.repeat;
  if (next.body !== current.body) patch.body = next.body;
  return Object.keys(patch).length > 0 ? patch : null;
}

// ---------------------------------------------------------------------------
// Задачи (односторонне)
// ---------------------------------------------------------------------------

export interface TaskIcsOptions {
  completedTasksToCalendar: boolean;
  /** Время напоминания для задачи без времени (`HH:mm`). */
  reminderTimeForDateOnly: LocalTimeString;
  deviceZone: string;
}

const REMIND_MINUTES: Record<Exclude<RemindOffset, 'none'>, number> = {
  at: 0,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '1d': 1440,
};

/** Задача попадает в календарь: есть срок, не в архиве; выполненная — только по настройке. */
export function isTaskSyncable(task: Task, completedTasksToCalendar: boolean): boolean {
  if (task.archived || task.due === null) return false;
  if (task.repeat === 'none' && task.done) return completedTasksToCalendar;
  return true;
}

/** Напоминание задачи → VALARM. Для задачи без времени — относительно полуночи дня. */
export function taskAlarm(remind: RemindOffset, allDay: boolean, reminderTime: LocalTimeString, title: string): IcsAlarm | null {
  if (remind === 'none') return null;
  const offset = REMIND_MINUTES[remind];
  const before = allDay ? offset - timeToMinutes(reminderTime) : offset;
  return { triggerMinutesBefore: before, action: 'DISPLAY', description: title };
}

/** Длительность события задачи со временем: `duration` или 30 мин. */
export function taskEventMinutes(task: Pick<Task, 'duration'>): number {
  return isValidDuration(task.duration) ? task.duration : TASK_EVENT_MINUTES;
}

/**
 * Задача → событие без DTSTAMP/LAST-MODIFIED (их добавляет вызывающий), чтобы хеш был стабильным.
 * `null` — задача не попадает в календарь.
 */
export function taskToIcs(task: Task, options: TaskIcsOptions): IcsEvent | null {
  if (!isTaskSyncable(task, options.completedTasksToCalendar) || task.due === null) return null;
  const done = task.repeat === 'none' && task.done;
  const title = task.title;
  const event: IcsEvent = {
    uid: task.id,
    summary: `${done ? TASK_DONE_PREFIX : TASK_OPEN_PREFIX}${title}`,
    start: dateOnly(task.due.date),
    end: dateOnly(addDays(task.due.date, 1)),
    allDay: true,
    url: itemUrl(task.id),
    exdates: [],
    alarms: [],
    extra: [],
  };
  const completed = done ? parseFloating(task.completed) : null;
  if (completed && completed.time !== null) {
    // Выполненная задача — событие на 15 минут в момент выполнения.
    event.allDay = false;
    event.start = zoned(completed, options.deviceZone);
    event.end = zoned(addMinutes(completed, COMPLETED_TASK_EVENT_MINUTES), options.deviceZone);
  } else if (task.due.time !== null) {
    event.allDay = false;
    event.start = zoned(task.due, options.deviceZone);
    event.end = zoned(addMinutes(task.due, taskEventMinutes(task)), options.deviceZone);
  }
  if (task.repeat !== 'none') {
    const rrule = presetToRrule(task.repeat, task.repeatAnchor ?? task.due.date);
    if (rrule) event.rrule = rrule;
  }
  if (!done) {
    const alarm = taskAlarm(task.remind, event.allDay, options.reminderTimeForDateOnly, title);
    if (alarm) event.alarms = [alarm];
  }
  return event;
}
