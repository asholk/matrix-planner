/**
 * Черновик формы события (ТЗ §3.4, §4.3) — чистое состояние без `obsidian` и DOM.
 *
 * - Название обязательно; конец строго позже начала (для «Весь день» последний день
 *   не раньше первого).
 * - В форме конец события на весь день — включительный (последний день); в свойствах
 *   заметки он хранится исключительным (`end` не включается) — переводы ниже.
 * - По умолчанию начало — ближайший целый час выбранного дня, длительность 1 час.
 * - Время начала и конца хранится и при «Весь день», чтобы выключение переключателя
 *   вернуло прежние значения.
 * - Правка меняет всю серию: форма отдаёт только изменённые поля (`EventPatch`).
 */

import type { EventService } from '../app/contracts';
import type {
  EventColor,
  EventDraft,
  EventPatch,
  FloatingDateTime,
  IconName,
  ItemId,
  LocalDateString,
  LocalTimeString,
  OpResult,
  PlannerError,
  PlannerEvent,
  RepeatRule,
} from '../model/types';
import { EVENT_COLORS, REPEAT_RULES } from '../model/types';
import { addDays, addMinutes, compareFloating, diffDays, isValidDate, isValidTime, minutesToTime, timeToMinutes } from '../model/dates';
import { EVENT_DEFAULTS } from '../model/defaults';

/** Значок нового события (как в образце, кадр 11). */
export const DEFAULT_EVENT_ICON: IconName = 'star';

/** Начало по умолчанию для дня, отличного от сегодняшнего (кадр 11: 21 окт. — 09:00). */
export const OTHER_DAY_START_TIME: LocalTimeString = '09:00';

/** Значки Lucide на выбор в форме события. */
export const EVENT_ICON_OPTIONS: readonly IconName[] = [
  'star',
  'calendar',
  'briefcase',
  'users',
  'phone',
  'video',
  'map-pin',
  'plane',
  'car',
  'home',
  'utensils',
  'coffee',
  'cake',
  'gift',
  'heart',
  'stethoscope',
  'dumbbell',
  'graduation-cap',
  'book-open',
  'music',
  'film',
  'party-popper',
];

export const EVENT_REPEAT_OPTIONS: readonly RepeatRule[] = REPEAT_RULES;
export const EVENT_COLOR_OPTIONS: readonly EventColor[] = EVENT_COLORS;

const MINUTES_PER_DAY = 1440;

// ---------------------------------------------------------------------------
// Время по умолчанию и перевод конца события
// ---------------------------------------------------------------------------

/**
 * Начало и конец нового события. Для сегодняшнего дня — ближайший целый час после
 * текущего времени (ровно целый час остаётся как есть; позже 23:00 — 23:00, чтобы
 * событие осталось в выбранном дне). Для другого дня — `OTHER_DAY_START_TIME`.
 */
export function defaultEventSlot(
  now: FloatingDateTime,
  date: LocalDateString | null,
  durationMinutes: number = EVENT_DEFAULTS.durationMinutes,
): { start: FloatingDateTime & { time: LocalTimeString }; end: FloatingDateTime & { time: LocalTimeString } } {
  const day = date !== null && isValidDate(date) ? date : now.date;
  let startTime = OTHER_DAY_START_TIME;
  if (day === now.date) {
    const minutes = now.time === null ? 0 : timeToMinutes(now.time);
    const hour = Math.min(Math.ceil(minutes / 60), 23);
    startTime = minutesToTime(hour * 60);
  }
  const start = { date: day, time: startTime };
  const end = addMinutes(start, durationMinutes) as FloatingDateTime & { time: LocalTimeString };
  return { start, end };
}

/** Исключительный конец события на весь день (из свойств) → последний день для формы. */
export function inclusiveEndDate(start: LocalDateString, exclusiveEnd: LocalDateString): LocalDateString {
  const last = addDays(exclusiveEnd, -1);
  return last < start ? start : last;
}

/** Последний день из формы → исключительная дата для свойства `end`. */
export function exclusiveEndDate(inclusiveEnd: LocalDateString): LocalDateString {
  return addDays(inclusiveEnd, 1);
}

/**
 * Проверка начала и конца черновика (конец для «Весь день» — включительный).
 * `null` — всё верно; `start`/`end` — поле с ошибкой.
 */
export function scheduleError(draft: Pick<EventDraft, 'allDay' | 'start' | 'end'>): 'start' | 'end' | null {
  const { start, end } = draft;
  if (!start || !isValidDate(start.date)) return 'start';
  if (!end || !isValidDate(end.date)) return 'end';
  if (draft.allDay) return end.date < start.date ? 'end' : null;
  if (start.time === null || !isValidTime(start.time)) return 'start';
  if (end.time === null || !isValidTime(end.time)) return 'end';
  return compareFloating(end, start) > 0 ? null : 'end';
}

/** Значения формы из события (конец на весь день становится включительным). */
export function eventToDraft(event: Pick<PlannerEvent, 'title' | 'icon' | 'url' | 'allDay' | 'start' | 'end' | 'repeat' | 'color' | 'calendarId' | 'tz'>, body: string): EventDraft {
  const start: FloatingDateTime = event.allDay ? { date: event.start.date, time: null } : { ...event.start };
  const end: FloatingDateTime = event.allDay
    ? { date: inclusiveEndDate(event.start.date, event.end.date), time: null }
    : { ...event.end };
  return {
    title: event.title,
    body,
    icon: event.icon,
    url: event.url,
    allDay: event.allDay,
    start,
    end,
    repeat: event.repeat,
    color: event.color,
    calendarId: event.calendarId,
    tz: event.tz,
  };
}

// ---------------------------------------------------------------------------
// Состояние формы
// ---------------------------------------------------------------------------

export interface EventDraftState {
  mode: 'create' | 'edit';
  eventId: ItemId | null;
  title: string;
  body: string;
  /** Тело загружено (при редактировании до загрузки тело не меняется). */
  bodyLoaded: boolean;
  url: string;
  icon: IconName | null;
  allDay: boolean;
  startDate: LocalDateString;
  startTime: LocalTimeString;
  /** Для «Весь день» — последний день (включительно). */
  endDate: LocalDateString;
  endTime: LocalTimeString;
  repeat: RepeatRule;
  color: EventColor;
  calendarId: string | null;
  tz: string | null;
  /** Значения события при открытии формы (только редактирование). */
  initial: EventDraft | null;
}

export interface CreateEventDraftContext {
  /** Текущее местное время. */
  now: FloatingDateTime;
  /** Выбранный день (из календаря); `null` — сегодня. */
  date?: LocalDateString | null;
  /** Календарь по умолчанию (уже проверенный на право записи). */
  calendarId?: string | null;
}

export function createEventDraftState(context: CreateEventDraftContext): EventDraftState {
  const slot = defaultEventSlot(context.now, context.date ?? null);
  return {
    mode: 'create',
    eventId: null,
    title: '',
    body: '',
    bodyLoaded: true,
    url: '',
    icon: DEFAULT_EVENT_ICON,
    allDay: false,
    startDate: slot.start.date,
    startTime: slot.start.time,
    endDate: slot.end.date,
    endTime: slot.end.time,
    repeat: EVENT_DEFAULTS.repeat,
    color: EVENT_DEFAULTS.color,
    calendarId: context.calendarId ?? null,
    tz: null,
    initial: null,
  };
}

/** Черновик редактирования. `body: null` — тело ещё не загружено. */
export function draftStateFromEvent(event: PlannerEvent, body: string | null, now: FloatingDateTime): EventDraftState {
  const initial = eventToDraft(event, body ?? '');
  // Для события на весь день время берётся по умолчанию — пригодится при выключении «Весь день».
  const slot = defaultEventSlot(now, initial.start.date);
  return {
    mode: 'edit',
    eventId: event.id,
    title: initial.title,
    body: initial.body,
    bodyLoaded: body !== null,
    url: initial.url ?? '',
    icon: initial.icon,
    allDay: initial.allDay,
    startDate: initial.start.date,
    startTime: initial.start.time ?? slot.start.time,
    endDate: initial.end.date,
    endTime: initial.end.time ?? slot.end.time,
    repeat: initial.repeat,
    color: initial.color,
    calendarId: initial.calendarId,
    tz: initial.tz,
    initial,
  };
}

export function setLoadedBody(state: EventDraftState, body: string): EventDraftState {
  if (state.bodyLoaded) return state;
  return { ...state, body, bodyLoaded: true, initial: state.initial ? { ...state.initial, body } : null };
}

export function setTitle(state: EventDraftState, title: string): EventDraftState {
  return { ...state, title };
}

export function setBody(state: EventDraftState, body: string): EventDraftState {
  return state.bodyLoaded ? { ...state, body } : state;
}

export function setUrl(state: EventDraftState, url: string): EventDraftState {
  return { ...state, url };
}

export function setIconName(state: EventDraftState, icon: IconName | null): EventDraftState {
  return { ...state, icon: icon === null || icon.trim() === '' ? null : icon };
}

export function setColor(state: EventDraftState, color: EventColor): EventDraftState {
  return EVENT_COLOR_OPTIONS.includes(color) ? { ...state, color } : state;
}

export function setRepeat(state: EventDraftState, repeat: RepeatRule): EventDraftState {
  return EVENT_REPEAT_OPTIONS.includes(repeat) ? { ...state, repeat } : state;
}

export function setCalendar(state: EventDraftState, calendarId: string | null): EventDraftState {
  return { ...state, calendarId };
}

function startOf(state: EventDraftState): FloatingDateTime {
  return { date: state.startDate, time: state.startTime };
}

function endOf(state: EventDraftState): FloatingDateTime {
  return { date: state.endDate, time: state.endTime };
}

/** Длительность события со временем в минутах (может быть ≤ 0 при ошибке ввода). */
function durationMinutes(state: EventDraftState): number {
  return (
    diffDays(state.startDate, state.endDate) * MINUTES_PER_DAY + timeToMinutes(state.endTime) - timeToMinutes(state.startTime)
  );
}

/**
 * «Весь день». Включение: последний день — день окончания (конец ровно в 00:00 следующего
 * дня не добавляет день). Выключение: если конец не позже начала — длительность 1 час.
 */
export function setAllDay(state: EventDraftState, allDay: boolean): EventDraftState {
  if (state.allDay === allDay) return state;
  if (allDay) {
    let endDate = state.endDate;
    if (state.endTime === '00:00' && endDate > state.startDate) endDate = addDays(endDate, -1);
    if (endDate < state.startDate) endDate = state.startDate;
    return { ...state, allDay: true, endDate };
  }
  const next = { ...state, allDay: false };
  if (durationMinutes(next) <= 0) {
    const end = addMinutes(startOf(next), EVENT_DEFAULTS.durationMinutes);
    return { ...next, endDate: end.date, endTime: end.time ?? next.endTime };
  }
  return next;
}

/** Смена начала сохраняет длительность события (конец сдвигается вместе с началом). */
export function setStart(state: EventDraftState, date: LocalDateString, time: LocalTimeString = state.startTime): EventDraftState {
  if (!isValidDate(date) || !isValidTime(time)) return state;
  if (state.allDay) {
    const days = Math.max(0, diffDays(state.startDate, state.endDate));
    return { ...state, startDate: date, startTime: time, endDate: addDays(date, days) };
  }
  const duration = durationMinutes(state);
  const keep = duration > 0 ? duration : EVENT_DEFAULTS.durationMinutes;
  const end = addMinutes({ date, time }, keep);
  return { ...state, startDate: date, startTime: time, endDate: end.date, endTime: end.time ?? state.endTime };
}

/** Конец задаётся как есть; ошибку «конец раньше начала» показывает проверка. */
export function setEnd(state: EventDraftState, date: LocalDateString, time: LocalTimeString = state.endTime): EventDraftState {
  if (!isValidDate(date) || !isValidTime(time)) return state;
  return { ...state, endDate: date, endTime: time };
}

// ---------------------------------------------------------------------------
// Проверка и результат
// ---------------------------------------------------------------------------

export type EventFieldError = 'required' | 'invalid' | 'before-start';

/** Код ошибки «поле обязательно» (не текст интерфейса: текст берётся из словаря). */
const REQUIRED_ERROR: EventFieldError = 'required';

export interface EventDraftValidation {
  valid: boolean;
  errors: Partial<Record<'title' | 'start' | 'end', EventFieldError>>;
}

export function validateEventDraft(state: EventDraftState): EventDraftValidation {
  const errors: EventDraftValidation['errors'] = {};
  if (state.title.trim() === '') errors.title = REQUIRED_ERROR;
  const problem = scheduleError(toEventDraft(state));
  if (problem === 'start') errors.start = 'invalid';
  else if (problem === 'end') errors.end = isValidDate(state.endDate) && isValidTime(state.endTime) ? 'before-start' : 'invalid';
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Значения для `EventService.create` (конец на весь день — включительный). */
export function toEventDraft(state: EventDraftState): EventDraft {
  const url = state.url.trim();
  return {
    title: state.title.trim(),
    body: state.body,
    icon: state.icon,
    url: url === '' ? null : url,
    allDay: state.allDay,
    start: state.allDay ? { date: state.startDate, time: null } : startOf(state),
    end: state.allDay ? { date: state.endDate, time: null } : endOf(state),
    repeat: state.repeat,
    color: state.color,
    calendarId: state.calendarId,
    tz: state.tz,
  };
}

function sameMoment(a: FloatingDateTime, b: FloatingDateTime): boolean {
  return a.date === b.date && a.time === b.time;
}

/** Изменённые поля для `EventService.update`. Начало, конец и «Весь день» передаются вместе. */
export function toEventPatch(state: EventDraftState): EventPatch {
  const next = toEventDraft(state);
  const initial = state.initial;
  if (!initial) return next;
  const patch: EventPatch = {};
  if (next.title !== initial.title) patch.title = next.title;
  if (state.bodyLoaded && next.body !== initial.body) patch.body = next.body;
  if (next.icon !== initial.icon) patch.icon = next.icon;
  if (next.url !== initial.url) patch.url = next.url;
  if (next.allDay !== initial.allDay || !sameMoment(next.start, initial.start) || !sameMoment(next.end, initial.end)) {
    patch.allDay = next.allDay;
    patch.start = next.start;
    patch.end = next.end;
  }
  if (next.repeat !== initial.repeat) patch.repeat = next.repeat;
  if (next.color !== initial.color) patch.color = next.color;
  if (next.calendarId !== initial.calendarId) patch.calendarId = next.calendarId;
  if (next.tz !== initial.tz) patch.tz = next.tz;
  return patch;
}

export function isPatchEmpty(patch: EventPatch): boolean {
  return Object.values(patch).every((value) => value === undefined);
}

// ---------------------------------------------------------------------------
// Сохранение
// ---------------------------------------------------------------------------

export type EventSubmitResult =
  | { ok: true; changed: boolean; event: PlannerEvent | null }
  | { ok: false; reason: 'invalid' | 'busy' }
  | { ok: false; reason: 'error'; error: PlannerError };

/**
 * Держит состояние формы и сохраняет его через контракт `EventService`.
 * Пока сохранение идёт или после успешного сохранения повторный `submit` не вызывает сервис.
 */
export class EventDraftController {
  private state: EventDraftState;
  private inFlight = false;
  private saved = false;
  private readonly listeners = new Set<(state: EventDraftState) => void>();

  constructor(
    initial: EventDraftState,
    private readonly events: Pick<EventService, 'create' | 'update'>,
  ) {
    this.state = initial;
  }

  get(): EventDraftState {
    return this.state;
  }

  isBusy(): boolean {
    return this.inFlight;
  }

  isSaved(): boolean {
    return this.saved;
  }

  canSubmit(): boolean {
    return !this.inFlight && !this.saved && validateEventDraft(this.state).valid;
  }

  update(change: (state: EventDraftState) => EventDraftState): void {
    const next = change(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  onChange(listener: (state: EventDraftState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async submit(): Promise<EventSubmitResult> {
    if (this.inFlight || this.saved) return { ok: false, reason: 'busy' };
    if (!validateEventDraft(this.state).valid) return { ok: false, reason: 'invalid' };
    this.inFlight = true;
    try {
      const result = await this.save();
      if (result.ok) this.saved = true;
      return result;
    } catch (error) {
      return { ok: false, reason: 'error', error: { code: 'unknown', detail: String(error), cause: error } };
    } finally {
      this.inFlight = false;
    }
  }

  private async save(): Promise<EventSubmitResult> {
    const state = this.state;
    if (state.mode === 'create' || state.eventId === null) {
      return fromOp(await this.events.create(toEventDraft(state)), (value) => value);
    }
    const patch = toEventPatch(state);
    if (isPatchEmpty(patch)) return { ok: true, changed: false, event: null };
    return fromOp(await this.events.update(state.eventId, patch), () => null);
  }
}

function fromOp<T>(result: OpResult<T>, event: (value: T) => PlannerEvent | null): EventSubmitResult {
  if (!result.ok) return { ok: false, reason: 'error', error: result.error };
  return { ok: true, changed: result.changed, event: event(result.value) };
}
