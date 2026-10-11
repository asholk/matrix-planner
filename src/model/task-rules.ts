/**
 * Правила изменения задачи (ТЗ §3.2–3.3): выполнение, отмена, перенос, правка из формы.
 *
 * Функции работают с YAML-формой свойств (`TaskProperties`) и возвращают точечное
 * изменение (`TaskPropertiesPatch`), которое сервис применяет через `processFrontMatter`
 * (`applyFrontmatterPatch`). Вход и выход — те же поля, что в заметке, поэтому общий набор
 * фикстур (`fixtures/recurrence.json`) подходит и для компаньона на Swift.
 */

import type {
  FloatingDateTime,
  ItemId,
  LocalDateString,
  LocalDateTimeString,
  QuadrantKey,
  TaskDraft,
  TaskPatch,
  TaskProperties,
} from './types';
import { addDays, formatFloating, maxDate, parseFloating } from './dates';
import { isOccurrence, isRecurring, nextPendingOccurrence } from './recurrence';
import { isValidDuration } from './duration';

/** Поля задачи, которые читают правила. */
export type TaskRuleInput = Pick<TaskProperties, 'due' | 'repeat' | 'repeat_anchor' | 'done' | 'completed' | 'completions'>;

/** Изменение свойств задачи (только изменяемые ключи). */
export type TaskPropertiesPatch = Partial<Omit<TaskProperties, 'type' | 'id'>>;

/** Почему действие не соответствует текущему состоянию задачи. */
export type TaskStaleReason =
  | 'no-due' // повторяющаяся задача без срока
  | 'instance-mismatch' // дата не совпадает со сроком неповторяющейся задачи
  | 'instance-passed' // повторение раньше текущего срока уже пропущено
  | 'not-occurrence'; // дата не является повторением серии

export type TaskRuleOutcome =
  | { kind: 'change'; patch: TaskPropertiesPatch }
  /** Идемпотентный пропуск: состояние уже такое (`OpResult.changed: false`). */
  | { kind: 'skip' }
  | { kind: 'stale'; reason: TaskStaleReason };

const SKIP: TaskRuleOutcome = { kind: 'skip' };

function stale(reason: TaskStaleReason): TaskRuleOutcome {
  return { kind: 'stale', reason };
}

function withDate(due: FloatingDateTime | null, date: LocalDateString): string {
  return formatFloating({ date, time: due?.time ?? null });
}

function sortedUnique(dates: Iterable<LocalDateString>): LocalDateString[] {
  return [...new Set(dates)].sort();
}

// ---------------------------------------------------------------------------
// Выполнение и отмена
// ---------------------------------------------------------------------------

export interface CompleteOptions {
  /** Дата повторения; по умолчанию — дата текущего `due`. */
  instanceDate?: LocalDateString | null;
  /** Текущее местное время (дата выполнения и `completed`). */
  now: FloatingDateTime;
}

/**
 * Выполнить задачу.
 * - Неповторяющаяся: `done: true`, `completed` = `now`; уже выполнена — пропуск.
 * - Повторяющаяся, повторение D: D уже в `completions` — пропуск; иначе D добавляется в
 *   `completions`. Если D — текущий срок, `due` переносится на первое невыполненное повторение
 *   строго после max(D, дата выполнения): пропущенные повторения не создаются. Время сохраняется.
 *   Если D — будущее повторение, `due` не меняется. Пустой `repeat_anchor` фиксируется,
 *   чтобы перенос 31-го числа и 29 февраля не терял исходную дату.
 */
export function planComplete(task: TaskRuleInput, options: CompleteOptions): TaskRuleOutcome {
  const due = parseFloating(task.due);
  const instance = options.instanceDate ?? null;

  if (!isRecurring(task.repeat) || !due) {
    if (task.repeat !== 'none' && !due) return stale('no-due');
    if (task.done) return SKIP;
    if (instance !== null && due && instance !== due.date) return stale('instance-mismatch');
    return { kind: 'change', patch: { done: true, completed: completedStamp(options.now) } };
  }

  const date = instance ?? due.date;
  if (task.completions.includes(date)) return SKIP;
  const anchor = task.repeat_anchor ?? due.date;
  if (date < due.date) return stale('instance-passed');
  if (date > due.date && !isOccurrence(task.repeat, anchor, date)) return stale('not-occurrence');

  const completions = sortedUnique([...task.completions, date]);
  const patch: TaskPropertiesPatch = { completions };
  if (date === due.date) {
    const next = nextPendingOccurrence(task.repeat, anchor, maxDate(date, options.now.date), completions);
    if (next) patch.due = withDate(due, next);
  }
  if (task.repeat_anchor === null) patch.repeat_anchor = anchor;
  if (task.done) patch.done = false;
  return { kind: 'change', patch };
}

export interface UncompleteOptions {
  /** Дата повторения; по умолчанию — последняя дата из `completions`. */
  instanceDate?: LocalDateString | null;
}

/**
 * Вернуть в работу.
 * - Неповторяющаяся: `done: false`, `completed: null`; не выполнена — пропуск.
 *   Дата из истории `completions` (повтор сменён на «Никогда») убирается из истории.
 * - Повторяющаяся: D убирается из `completions` (нет — пропуск); `due` возвращается на D,
 *   если D раньше текущего срока (время срока сохраняется).
 */
export function planUncomplete(task: TaskRuleInput, options: UncompleteOptions = {}): TaskRuleOutcome {
  if (!isRecurring(task.repeat)) {
    // История повторений остаётся после смены правила на «Никогда» — её можно отменить.
    const instance = options.instanceDate ?? null;
    if (instance !== null && task.completions.includes(instance)) {
      return { kind: 'change', patch: { completions: task.completions.filter((d) => d !== instance) } };
    }
    if (!task.done) return SKIP;
    return { kind: 'change', patch: { done: false, completed: null } };
  }
  const date = options.instanceDate ?? task.completions[task.completions.length - 1] ?? null;
  if (date === null || !task.completions.includes(date)) return SKIP;
  const patch: TaskPropertiesPatch = { completions: task.completions.filter((d) => d !== date) };
  const due = parseFloating(task.due);
  if (!due || date < due.date) patch.due = withDate(due, date);
  return { kind: 'change', patch };
}

// ---------------------------------------------------------------------------
// Перенос и квадрант
// ---------------------------------------------------------------------------

/**
 * Инвариант повторяющейся задачи: `due` — невыполненное повторение. Если `date` уже есть
 * в `completions`, берётся ближайшее невыполненное повторение серии после неё.
 */
function pendingOnOrAfter(
  rule: TaskRuleInput['repeat'],
  anchor: LocalDateString,
  date: LocalDateString,
  completions: readonly LocalDateString[],
): LocalDateString | null {
  if (!isRecurring(rule) || !completions.includes(date)) return date;
  return nextPendingOccurrence(rule, anchor, date, completions);
}

/**
 * Перенести срок на дату (меню, перетаскивание в календаре). Время сохраняется.
 * Якорь серии не меняется — перенос разовый; пустой якорь фиксируется старой датой срока.
 * Повторяющаяся задача не переносится на уже выполненное повторение — срок встаёт
 * на ближайшее невыполненное повторение после этой даты.
 */
export function planReschedule(task: TaskRuleInput, date: LocalDateString): TaskRuleOutcome {
  const due = parseFloating(task.due);
  const anchor = task.repeat_anchor ?? due?.date ?? date;
  const target = pendingOnOrAfter(task.repeat, anchor, date, task.completions);
  if (target === null) return stale('not-occurrence');
  if (due && due.date === target) return SKIP;
  const patch: TaskPropertiesPatch = { due: withDate(due, target) };
  if (isRecurring(task.repeat) && task.repeat_anchor === null && due) patch.repeat_anchor = due.date;
  return { kind: 'change', patch };
}

/** «Перенести на завтра» — относительно сегодняшнего дня, а не срока. */
export function planPostponeToTomorrow(task: TaskRuleInput, today: LocalDateString): TaskRuleOutcome {
  return planReschedule(task, addDays(today, 1));
}

export function planMoveToQuadrant(task: Pick<TaskProperties, 'quadrant'>, quadrant: QuadrantKey): TaskRuleOutcome {
  return task.quadrant === quadrant ? SKIP : { kind: 'change', patch: { quadrant } };
}

// ---------------------------------------------------------------------------
// Форма задачи
// ---------------------------------------------------------------------------

/**
 * Нормализует поля формы: без срока нет повтора и напоминания (ТЗ §4.3).
 */
export function normalizeDraftSchedule<T extends Pick<TaskDraft, 'due' | 'repeat' | 'remind'>>(draft: T): T {
  if (draft.due) return draft;
  return { ...draft, repeat: 'none', remind: 'none' };
}

/** Свойства новой задачи из формы. */
export function newTaskProperties(
  draft: Omit<TaskDraft, 'title' | 'body'>,
  context: { id: ItemId; now: FloatingDateTime },
): TaskProperties {
  const d = normalizeDraftSchedule(draft);
  return {
    type: 'task',
    id: context.id,
    quadrant: d.quadrant,
    due: d.due ? formatFloating(d.due) : null,
    repeat: d.repeat,
    repeat_anchor: d.due && d.repeat !== 'none' ? d.due.date : null,
    remind: d.remind,
    priority: d.priority,
    duration: isValidDuration(d.duration) ? d.duration : null,
    done: false,
    completed: null,
    completions: [],
    created: formatFloating(withClockTime(context.now)),
  };
}

function withClockTime(now: FloatingDateTime): FloatingDateTime {
  return now.time === null ? { date: now.date, time: '00:00' } : now;
}

/**
 * Изменение свойств из формы редактирования (название и тело меняет сервис).
 * Якорь серии: при смене даты срока или правила повтора становится датой нового срока;
 * без повтора — `null`. `completions` сохраняются как история.
 */
export function planDraftUpdate(
  task: TaskRuleInput & Pick<TaskProperties, 'quadrant' | 'remind' | 'priority'> & Partial<Pick<TaskProperties, 'duration'>>,
  patch: TaskPatch,
): TaskRuleOutcome {
  const currentDue = parseFloating(task.due);
  const next = normalizeDraftSchedule({
    due: patch.due !== undefined ? patch.due : currentDue,
    repeat: patch.repeat ?? task.repeat,
    remind: patch.remind ?? task.remind,
  });
  const out: TaskPropertiesPatch = {};

  if (patch.quadrant !== undefined && patch.quadrant !== task.quadrant) out.quadrant = patch.quadrant;
  if (patch.priority !== undefined && patch.priority !== task.priority) out.priority = patch.priority;
  // Длительность — общая для серии; задаётся и без времени (сохраняется до появления времени).
  if (patch.duration !== undefined) {
    const duration = isValidDuration(patch.duration) ? patch.duration : null;
    if (duration !== (task.duration ?? null)) out.duration = duration;
  }

  let anchor: LocalDateString | null;
  if (next.repeat === 'none' || !next.due) anchor = null;
  else if (next.repeat !== task.repeat || next.due.date !== currentDue?.date) anchor = next.due.date;
  else anchor = task.repeat_anchor ?? next.due.date;
  if (anchor !== task.repeat_anchor) out.repeat_anchor = anchor;

  // Срок повторяющейся задачи не может быть уже выполненным повторением.
  let nextDueValue = next.due;
  if (nextDueValue && anchor !== null) {
    const pending = pendingOnOrAfter(next.repeat, anchor, nextDueValue.date, task.completions);
    if (pending === null) return stale('not-occurrence');
    nextDueValue = { date: pending, time: nextDueValue.time };
  }
  const nextDue = nextDueValue ? formatFloating(nextDueValue) : null;
  if (nextDue !== task.due) out.due = nextDue;
  if (next.repeat !== task.repeat) out.repeat = next.repeat;
  if (next.remind !== task.remind) out.remind = next.remind;

  return Object.keys(out).length === 0 ? SKIP : { kind: 'change', patch: out };
}

/** Применяет изменение к копии свойств (для оптимистичного показа и тестов). */
export function applyTaskPatch<T extends TaskRuleInput>(task: T, patch: TaskPropertiesPatch): T {
  const result: Record<string, unknown> = { ...task };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
  }
  return result as T;
}

/** Дата-время выполнения как строка `completed`. */
export function completedStamp(now: FloatingDateTime): LocalDateTimeString {
  return formatFloating(withClockTime(now));
}
