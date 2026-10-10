/**
 * Операции событий-заметок (ТЗ §3.4, §4.3, §5.4.3): создание, правка всей серии,
 * удаление через метку в `tombstones.json` и корзину, список календарей для записи.
 *
 * Конец события на весь день в черновике — включительный; в свойствах заметки он
 * хранится исключительным (`end` не включается). Свойства меняются внутри
 * `processFrontMatter` по фактическому содержимому заметки, после записи сервис ждёт,
 * пока индекс увидит изменение.
 *
 * Удаление: сначала метка (только по ней основное устройство удалит событие из
 * «Календаря» iOS), затем корзина. Сбой любого этапа возвращается с этапом в `detail`;
 * повторный вызов завершает операцию (метка идемпотентна, «не найдено» при переносе в
 * корзину считается завершением).
 */

import type {
  CalendarCacheReader,
  CalendarOption,
  DeleteEventStage,
  EventService,
  IdGenerator,
  NoteIndex,
  NoteRepository,
  TombstoneWriter,
} from '../app/contracts';
import {
  EVENT_COLORS,
  REPEAT_RULES,
  type EventDraft,
  type EventPatch,
  type EventProperties,
  type FloatingDateTime,
  type ItemId,
  type OpResult,
  type ParsedNote,
  type PlannerEvent,
  type VaultPath,
} from '../model/types';
import { addDays, formatFloating, isValidDate, isValidTime, isValidTimeZone } from '../model/dates';
import { applyFrontmatterPatch, eventToFrontmatter, parseEvent } from '../model/properties';
import { errorResult, okResult } from '../storage/note-repository';
import { registerDictionary, t } from '../i18n';
import { ruEvents } from '../i18n/ru/events';
import { enEvents } from '../i18n/en/events';
import { eventToDraft, exclusiveEndDate, scheduleError } from './event-draft';

export function registerEventDictionaries(): void {
  registerDictionary('ru', 'events', ruEvents);
  registerDictionary('en', 'events', enEvents);
}
registerEventDictionaries();

/** Цвет календаря «Планировщик» в списке выбора (переменная темы). */
export const PLANNER_CALENDAR_COLOR = 'var(--interactive-accent)';

export interface EventServiceDeps {
  repository: NoteRepository;
  index: NoteIndex;
  ids: IdGenerator;
  /** Календари из `calendar-cache.json` (только чтение). */
  calendars: Pick<CalendarCacheReader, 'getCalendars'>;
  tombstones: TombstoneWriter;
  /** Название календаря «Планировщик» (по умолчанию из словаря). */
  plannerCalendarTitle?: () => string;
  /** Сколько ждать обновления индекса после записи (мс). */
  waitTimeoutMs?: number;
}

const DEFAULT_WAIT_MS = 2000;

const SCHEDULE_FIELDS = ['allDay', 'start', 'end'] as const satisfies readonly (keyof EventDraft)[];

type EventPropertiesPatch = Partial<Omit<EventProperties, 'type' | 'id'>>;

// ---------------------------------------------------------------------------
// Проверка и перевод черновика в свойства
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isFloating(value: unknown): value is FloatingDateTime {
  if (typeof value !== 'object' || value === null) return false;
  const { date, time } = value as FloatingDateTime;
  return isValidDate(date) && (time === null || isValidTime(time));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Имя невалидного поля (типы и наборы значений) или `null`. Согласованность начала и конца — отдельно. */
export function invalidEventField(patch: EventPatch, requireAll: boolean): keyof EventDraft | null {
  const need = (key: keyof EventDraft): boolean => requireAll || patch[key] !== undefined;
  if (need('title') && (typeof patch.title !== 'string' || patch.title.trim() === '')) return 'title';
  if (patch.body !== undefined && typeof patch.body !== 'string') return 'body';
  if (need('allDay') && typeof patch.allDay !== 'boolean') return 'allDay';
  if (need('start') && !isFloating(patch.start)) return 'start';
  if (need('end') && !isFloating(patch.end)) return 'end';
  if (need('repeat') && !isOneOf(REPEAT_RULES, patch.repeat)) return 'repeat';
  if (need('color') && !isOneOf(EVENT_COLORS, patch.color)) return 'color';
  if (patch.icon !== undefined && !isNullableString(patch.icon)) return 'icon';
  if (patch.url !== undefined && !isNullableString(patch.url)) return 'url';
  if (patch.calendarId !== undefined && !isNullableString(patch.calendarId)) return 'calendarId';
  if (patch.tz !== undefined && patch.tz !== null && (typeof patch.tz !== 'string' || !isValidTimeZone(patch.tz))) return 'tz';
  return null;
}

/**
 * Приводит начало/конец к виду черновика: при «Весь день» остаются только даты
 * (конец ровно в 00:00 следующего дня не добавляет день).
 */
export function normalizeSchedule(schedule: Pick<EventDraft, 'allDay' | 'start' | 'end'>): Pick<EventDraft, 'allDay' | 'start' | 'end'> {
  if (!schedule.allDay) return schedule;
  let endDate = schedule.end.date;
  if (schedule.end.time === '00:00' && schedule.start.time !== null && endDate > schedule.start.date) endDate = addDays(endDate, -1);
  return { allDay: true, start: { date: schedule.start.date, time: null }, end: { date: endDate, time: null } };
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Свойства начала и конца для записи (конец на весь день — исключительный). */
export function scheduleToProperties(schedule: Pick<EventDraft, 'allDay' | 'start' | 'end'>): Pick<EventProperties, 'start' | 'end' | 'all_day'> {
  if (schedule.allDay) {
    return { start: schedule.start.date, end: exclusiveEndDate(schedule.end.date), all_day: true };
  }
  return { start: formatFloating(schedule.start), end: formatFloating(schedule.end), all_day: false };
}

/** Свойства новой заметки-события в порядке ТЗ. */
export function eventDraftToProperties(draft: EventDraft, id: ItemId): EventProperties {
  return {
    type: 'event',
    id,
    ...scheduleToProperties(normalizeSchedule(draft)),
    tz: draft.tz ?? null,
    repeat: draft.repeat,
    color: draft.color,
    icon: emptyToNull(draft.icon),
    calendar_id: emptyToNull(draft.calendarId),
    url: emptyToNull(draft.url),
  };
}

/** Предикат ожидания: заметка — событие с этим id и (необязательно) записанными свойствами. */
function eventMatches(id: ItemId, patch?: EventPropertiesPatch) {
  return (item: ParsedNote): boolean => {
    if (item.kind !== 'event' || item.id !== id) return false;
    if (!patch) return true;
    const props = item.props as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (JSON.stringify(props[key] ?? null) !== JSON.stringify(value)) return false;
    }
    return true;
  };
}

function stageError(stage: DeleteEventStage, cause: unknown): OpResult {
  return stage === 'tombstone'
    ? errorResult('tombstone-failed', stage, cause, 'events.errors.deleteTombstone')
    : errorResult('trash-failed', stage, cause, 'events.errors.deleteTrash');
}

// ---------------------------------------------------------------------------
// Сервис
// ---------------------------------------------------------------------------

export class VaultEventService implements EventService {
  constructor(private readonly deps: EventServiceDeps) {}

  getWritableCalendars(): readonly CalendarOption[] {
    const planner: CalendarOption = {
      calendarId: null,
      title: this.deps.plannerCalendarTitle?.() ?? t('common.viewTitle'),
      color: PLANNER_CALENDAR_COLOR,
    };
    const cached = this.deps.calendars
      .getCalendars()
      .filter((calendar) => calendar.allowsModifications)
      .map((calendar): CalendarOption => ({ calendarId: calendar.calendarId, title: calendar.title, color: calendar.color }));
    return [planner, ...cached];
  }

  /** «Планировщик» доступен всегда; календарь кэша — только с `allows_modifications`. */
  isWritableCalendar(calendarId: string | null): boolean {
    return this.getWritableCalendars().some((option) => option.calendarId === calendarId);
  }

  async create(draft: EventDraft): Promise<OpResult<PlannerEvent | null>> {
    const invalid = invalidEventField(draft, true);
    if (invalid) return errorResult('invalid', invalid);
    const schedule = normalizeSchedule(draft);
    const problem = scheduleError(schedule);
    if (problem) return errorResult('invalid', problem, undefined, problem === 'end' ? 'events.endBeforeStart' : undefined);
    const calendarId = emptyToNull(draft.calendarId);
    if (!this.isWritableCalendar(calendarId)) {
      return errorResult('invalid', 'calendarId', undefined, 'events.errors.calendarNotWritable');
    }
    const id = this.deps.ids.next();
    const props = eventDraftToProperties({ ...draft, ...schedule, calendarId }, id);
    const created = await this.deps.repository.create({
      folder: this.deps.repository.paths.events,
      title: draft.title.trim(),
      frontmatter: eventToFrontmatter(props),
      body: draft.body ?? '',
    });
    if (!created.ok) return created;
    const item = await this.wait(created.value, eventMatches(id));
    return okResult(item && item.kind === 'event' ? item : null, true);
  }

  async update(id: ItemId, patch: EventPatch): Promise<OpResult> {
    const invalid = invalidEventField(patch, false);
    if (invalid) return errorResult('invalid', invalid);
    const found = this.find(id);
    if (!found.ok) return found;
    const event = found.value;
    const props = this.propertiesPatch(event, patch);
    if (!props.ok) return props;

    let path = event.path;
    let changed = false;
    const written = props.value;
    if (Object.keys(written).length > 0) {
      const box: { mismatch: boolean | null } = { mismatch: null };
      const result = await this.deps.repository.updateFrontmatter(path, (frontmatter) => {
        const current = parseEvent({
          path: event.path,
          title: event.title,
          mtime: event.mtime,
          frontmatter,
          archived: false,
          deletedInCalendar: event.deletedInCalendar,
        });
        box.mismatch = current.kind !== 'event' || current.id !== id;
        if (!box.mismatch) applyFrontmatterPatch<EventProperties>(frontmatter, written);
      });
      if (!result.ok) return result;
      if (box.mismatch === null) return errorResult('unknown', 'frontmatter callback was not called');
      if (box.mismatch) return errorResult('stale', 'id-mismatch');
      changed = result.changed;
    }

    if (patch.body !== undefined) {
      const body = patch.body;
      const result = await this.deps.repository.updateBody(path, () => body);
      if (!result.ok) return result;
      changed = changed || result.changed;
    }

    const title = patch.title?.trim();
    if (title !== undefined && title !== event.title) {
      // Переименование — последним: id в свойствах не меняется.
      const renamed = await this.deps.repository.rename(path, title);
      if (!renamed.ok) return renamed;
      path = renamed.value;
      changed = changed || renamed.changed;
    }

    if (changed) await this.wait(path, eventMatches(id, written));
    return okResult(undefined, changed);
  }

  async delete(id: ItemId): Promise<OpResult> {
    if (!this.deps.index.isReady()) return errorResult('not-ready');
    const event = this.findEvent(id);
    if (!event) {
      // Заметки уже нет: если метка записана, удаление завершено ранее.
      const marked = await this.safeHas(id);
      return marked ? okResult(undefined, false) : errorResult('not-found', id, undefined, 'events.errors.notFound');
    }

    let tombstone: OpResult;
    try {
      tombstone = await this.deps.tombstones.add(id, 'event');
    } catch (error) {
      return stageError('tombstone', error);
    }
    if (!tombstone.ok) return stageError('tombstone', tombstone.error);

    let trashed: OpResult;
    try {
      trashed = await this.deps.repository.trash(event.path);
    } catch (error) {
      return stageError('trash', error);
    }
    // «Не найдено» — заметку уже удалили (другое устройство или прошлый вызов).
    if (!trashed.ok && trashed.error.code !== 'not-found') return stageError('trash', trashed.error);
    return okResult(undefined, true);
  }

  // -------------------------------------------------------------------------

  private findEvent(id: ItemId): PlannerEvent | null {
    const item = this.deps.index.getById(id);
    return item && item.kind === 'event' ? item : null;
  }

  private find(id: ItemId): OpResult<PlannerEvent> {
    if (!this.deps.index.isReady()) return errorResult('not-ready');
    const event = this.findEvent(id);
    return event ? okResult(event, false) : errorResult('not-found', id, undefined, 'events.errors.notFound');
  }

  private async safeHas(id: ItemId): Promise<boolean> {
    try {
      return await this.deps.tombstones.has(id);
    } catch {
      return false;
    }
  }

  /** Изменения свойств по патчу формы с проверкой начала/конца и календаря. */
  private propertiesPatch(event: PlannerEvent, patch: EventPatch): OpResult<EventPropertiesPatch> {
    const out: EventPropertiesPatch = {};
    if (SCHEDULE_FIELDS.some((key) => patch[key] !== undefined)) {
      const current = eventToDraft(event, '');
      const schedule = normalizeSchedule({
        allDay: patch.allDay ?? current.allDay,
        start: patch.start ?? current.start,
        end: patch.end ?? current.end,
      });
      const problem = scheduleError(schedule);
      if (problem) return errorResult('invalid', problem, undefined, problem === 'end' ? 'events.endBeforeStart' : undefined);
      Object.assign(out, scheduleToProperties(schedule));
    }
    if (patch.calendarId !== undefined) {
      const calendarId = emptyToNull(patch.calendarId);
      // Прежний календарь можно оставить, даже если он больше не разрешает запись.
      if (calendarId !== event.calendarId && !this.isWritableCalendar(calendarId)) {
        return errorResult('invalid', 'calendarId', undefined, 'events.errors.calendarNotWritable');
      }
      out.calendar_id = calendarId;
    }
    if (patch.repeat !== undefined) out.repeat = patch.repeat;
    if (patch.color !== undefined) out.color = patch.color;
    if (patch.icon !== undefined) out.icon = emptyToNull(patch.icon);
    if (patch.url !== undefined) out.url = emptyToNull(patch.url);
    if (patch.tz !== undefined) out.tz = patch.tz;
    return okResult(out, false);
  }

  private async wait(path: VaultPath, predicate: (item: ParsedNote) => boolean): Promise<ParsedNote | null> {
    const item = await this.deps.index.waitFor(path, predicate, this.deps.waitTimeoutMs ?? DEFAULT_WAIT_MS);
    return item && predicate(item) ? item : null;
  }
}
