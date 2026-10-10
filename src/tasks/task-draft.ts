/**
 * Черновик формы задачи (ТЗ §4.3) — чистое состояние без `obsidian` и DOM.
 *
 * - Название обязательно (после обрезки пробелов).
 * - Время, повтор и напоминание доступны только при выбранной дате; очистка даты
 *   сбрасывает их. Доступны все пять вариантов повтора и все напоминания.
 * - Квадрант по умолчанию — из контекста («+» квадранта), иначе «Важно и срочно».
 * - При редактировании форма отдаёт только изменённые поля (`TaskPatch`); якорь серии
 *   при смене даты или правила переносит `planDraftUpdate` (model/task-rules).
 * - `TaskDraftController` защищает от повторного нажатия «Готово».
 */

import type { TaskService } from '../app/contracts';
import type {
  FloatingDateTime,
  ItemId,
  LocalDateString,
  LocalTimeString,
  OpResult,
  PlannerError,
  Priority,
  QuadrantKey,
  RemindOffset,
  RepeatRule,
  Task,
  TaskDraft,
  TaskPatch,
  TaskProperties,
} from '../model/types';
import { QUADRANT_KEYS, REMIND_OFFSETS, REPEAT_RULES } from '../model/types';
import { addDays, formatFloating, isValidDate, isValidTime } from '../model/dates';
import { TASK_DEFAULTS } from '../model/defaults';
import { normalizeDraftSchedule, planDraftUpdate, type TaskRuleOutcome } from '../model/task-rules';

/** Время, которое подставляет «Добавить время». */
export const DEFAULT_TASK_TIME: LocalTimeString = '09:00';

/** Варианты меню «Повтор» и «Напоминание» в порядке показа. */
export const REPEAT_OPTIONS: readonly RepeatRule[] = REPEAT_RULES;
export const REMIND_OPTIONS: readonly RemindOffset[] = REMIND_OFFSETS;

export type QuickDateKey = 'today' | 'tomorrow' | 'nextWeek';

export interface TaskDraftState {
  mode: 'create' | 'edit';
  /** id редактируемой задачи. */
  taskId: ItemId | null;
  title: string;
  body: string;
  /** Тело загружено (при редактировании до загрузки тело не меняется). */
  bodyLoaded: boolean;
  quadrant: QuadrantKey;
  date: LocalDateString | null;
  time: LocalTimeString | null;
  repeat: RepeatRule;
  remind: RemindOffset;
  priority: Priority;
  /** Значения задачи при открытии формы (только редактирование). */
  initial: TaskDraft | null;
}

export interface CreateDraftContext {
  quadrant?: QuadrantKey | null;
  date?: LocalDateString | null;
}

function isQuadrant(value: unknown): value is QuadrantKey {
  return typeof value === 'string' && (QUADRANT_KEYS as readonly string[]).includes(value);
}

/** Пустой черновик новой задачи с подстановкой квадранта и дня из контекста. */
export function createDraftState(context: CreateDraftContext = {}): TaskDraftState {
  const date = isValidDate(context.date) ? context.date : null;
  return {
    mode: 'create',
    taskId: null,
    title: '',
    body: '',
    bodyLoaded: true,
    quadrant: isQuadrant(context.quadrant) ? context.quadrant : TASK_DEFAULTS.quadrant,
    date,
    time: null,
    repeat: TASK_DEFAULTS.repeat,
    remind: TASK_DEFAULTS.remind,
    priority: TASK_DEFAULTS.priority,
    initial: null,
  };
}

/** Черновик редактирования. `body: null` — тело ещё не загружено. */
export function draftFromTask(task: Pick<Task, 'id' | 'title' | 'quadrant' | 'due' | 'repeat' | 'remind' | 'priority'>, body: string | null): TaskDraftState {
  // Задача без срока с повтором (ручная правка свойств) нормализуется так же, как при сохранении.
  const initial: TaskDraft = normalizeDraftSchedule({
    title: task.title,
    body: body ?? '',
    quadrant: task.quadrant,
    due: task.due ? { date: task.due.date, time: task.due.time } : null,
    repeat: task.repeat,
    remind: task.remind,
    priority: task.priority,
  });
  return {
    mode: 'edit',
    taskId: task.id,
    title: initial.title,
    body: initial.body,
    bodyLoaded: body !== null,
    quadrant: initial.quadrant,
    date: initial.due?.date ?? null,
    time: initial.due?.time ?? null,
    repeat: initial.repeat,
    remind: initial.remind,
    priority: initial.priority,
    initial,
  };
}

/** Тело загружено после открытия формы (если пользователь ещё не начал его менять). */
export function setLoadedBody(state: TaskDraftState, body: string): TaskDraftState {
  if (state.bodyLoaded) return state;
  return {
    ...state,
    body,
    bodyLoaded: true,
    initial: state.initial ? { ...state.initial, body } : null,
  };
}

// ---------------------------------------------------------------------------
// Изменение полей
// ---------------------------------------------------------------------------

export function setTitle(state: TaskDraftState, title: string): TaskDraftState {
  return { ...state, title };
}

export function setBody(state: TaskDraftState, body: string): TaskDraftState {
  return state.bodyLoaded ? { ...state, body } : state;
}

export function setQuadrant(state: TaskDraftState, quadrant: QuadrantKey): TaskDraftState {
  return isQuadrant(quadrant) ? { ...state, quadrant } : state;
}

export function setPriority(state: TaskDraftState, high: boolean): TaskDraftState {
  return { ...state, priority: high ? 'high' : 'normal' };
}

/**
 * Дата срока. Очистка убирает время, повтор и напоминание.
 * Первая выбранная дата включает напоминание «В момент события» (как в образце, кадр 03).
 */
export function setDate(state: TaskDraftState, date: LocalDateString | null): TaskDraftState {
  if (date === null) return { ...state, date: null, time: null, repeat: 'none', remind: 'none' };
  if (!isValidDate(date)) return state;
  const remind = state.date === null && state.remind === 'none' ? 'at' : state.remind;
  return { ...state, date, remind };
}

export function quickDate(key: QuickDateKey, today: LocalDateString): LocalDateString {
  switch (key) {
    case 'today':
      return today;
    case 'tomorrow':
      return addDays(today, 1);
    case 'nextWeek':
      return addDays(today, 7);
  }
}

export function applyQuickDate(state: TaskDraftState, key: QuickDateKey, today: LocalDateString): TaskDraftState {
  return setDate(state, quickDate(key, today));
}

/** Время доступно только при дате; `null` — без времени. Невалидное значение игнорируется. */
export function setTime(state: TaskDraftState, time: LocalTimeString | null): TaskDraftState {
  if (state.date === null) return state;
  if (time === null) return { ...state, time: null };
  return isValidTime(time) ? { ...state, time } : state;
}

/** «Добавить время». */
export function addTime(state: TaskDraftState, time: LocalTimeString = DEFAULT_TASK_TIME): TaskDraftState {
  return state.time === null ? setTime(state, time) : state;
}

export function setRepeat(state: TaskDraftState, repeat: RepeatRule): TaskDraftState {
  if (state.date === null || !REPEAT_OPTIONS.includes(repeat)) return state;
  return { ...state, repeat };
}

export function setRemind(state: TaskDraftState, remind: RemindOffset): TaskDraftState {
  if (state.date === null || !REMIND_OPTIONS.includes(remind)) return state;
  return { ...state, remind };
}

// ---------------------------------------------------------------------------
// Доступность, проверка, результат
// ---------------------------------------------------------------------------

export interface FieldAvailability {
  time: boolean;
  repeat: boolean;
  remind: boolean;
}

export function fieldAvailability(state: TaskDraftState): FieldAvailability {
  const hasDate = state.date !== null;
  return { time: hasDate, repeat: hasDate, remind: hasDate };
}

export type DraftFieldError = 'required' | 'invalid';

/** Код ошибки «поле обязательно» (не текст интерфейса: текст берётся из словаря). */
const REQUIRED_ERROR: DraftFieldError = 'required';

export interface DraftValidation {
  valid: boolean;
  errors: Partial<Record<'title' | 'date' | 'time', DraftFieldError>>;
}

export function validateDraft(state: TaskDraftState): DraftValidation {
  const errors: DraftValidation['errors'] = {};
  if (state.title.trim() === '') errors.title = REQUIRED_ERROR;
  if (state.date !== null && !isValidDate(state.date)) errors.date = 'invalid';
  if (state.time !== null && (state.date === null || !isValidTime(state.time))) errors.time = 'invalid';
  return { valid: Object.keys(errors).length === 0, errors };
}

export function draftDue(state: TaskDraftState): FloatingDateTime | null {
  return state.date === null ? null : { date: state.date, time: state.time };
}

/** Значения для `TaskService.create`. */
export function toTaskDraft(state: TaskDraftState): TaskDraft {
  return normalizeDraftSchedule({
    title: state.title.trim(),
    body: state.body,
    quadrant: state.quadrant,
    due: draftDue(state),
    repeat: state.repeat,
    remind: state.remind,
    priority: state.priority,
  });
}

function sameDue(a: FloatingDateTime | null, b: FloatingDateTime | null): boolean {
  if (a === null || b === null) return a === b;
  return formatFloating(a) === formatFloating(b);
}

/** Изменённые поля для `TaskService.update`; пустой объект — ничего не менялось. */
export function toTaskPatch(state: TaskDraftState): TaskPatch {
  const next = toTaskDraft(state);
  const initial = state.initial;
  if (!initial) return next;
  const patch: TaskPatch = {};
  if (next.title !== initial.title) patch.title = next.title;
  if (state.bodyLoaded && next.body !== initial.body) patch.body = next.body;
  if (next.quadrant !== initial.quadrant) patch.quadrant = next.quadrant;
  if (next.priority !== initial.priority) patch.priority = next.priority;
  if (!sameDue(next.due, initial.due)) patch.due = next.due;
  if (next.repeat !== initial.repeat) patch.repeat = next.repeat;
  if (next.remind !== initial.remind) patch.remind = next.remind;
  return patch;
}

export function isPatchEmpty(patch: TaskPatch): boolean {
  return Object.values(patch).every((value) => value === undefined);
}

/** Как изменятся свойства задачи (включая якорь серии) после сохранения формы. */
export function previewPropertiesChange(
  state: TaskDraftState,
  props: Pick<TaskProperties, 'due' | 'repeat' | 'repeat_anchor' | 'done' | 'completed' | 'completions' | 'quadrant' | 'remind' | 'priority'>,
): TaskRuleOutcome {
  return planDraftUpdate(props, toTaskPatch(state));
}

// ---------------------------------------------------------------------------
// Сохранение
// ---------------------------------------------------------------------------

export type DraftSubmitResult =
  | { ok: true; changed: boolean; task: Task | null }
  | { ok: false; reason: 'invalid' | 'busy' }
  | { ok: false; reason: 'error'; error: PlannerError };

/**
 * Держит состояние формы и сохраняет его через контракт `TaskService`.
 * Пока сохранение идёт или после успешного сохранения повторный `submit` не вызывает сервис.
 */
export class TaskDraftController {
  private state: TaskDraftState;
  private inFlight = false;
  private saved = false;
  private readonly listeners = new Set<(state: TaskDraftState) => void>();

  constructor(
    initial: TaskDraftState,
    private readonly tasks: Pick<TaskService, 'create' | 'update'>,
  ) {
    this.state = initial;
  }

  get(): TaskDraftState {
    return this.state;
  }

  isBusy(): boolean {
    return this.inFlight;
  }

  isSaved(): boolean {
    return this.saved;
  }

  canSubmit(): boolean {
    return !this.inFlight && !this.saved && validateDraft(this.state).valid;
  }

  update(change: (state: TaskDraftState) => TaskDraftState): void {
    const next = change(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  onChange(listener: (state: TaskDraftState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async submit(): Promise<DraftSubmitResult> {
    if (this.inFlight || this.saved) return { ok: false, reason: 'busy' };
    if (!validateDraft(this.state).valid) return { ok: false, reason: 'invalid' };
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

  private async save(): Promise<DraftSubmitResult> {
    const state = this.state;
    if (state.mode === 'create' || state.taskId === null) {
      return fromOp(await this.tasks.create(toTaskDraft(state)), (value) => value);
    }
    const patch = toTaskPatch(state);
    if (isPatchEmpty(patch)) return { ok: true, changed: false, task: null };
    return fromOp(await this.tasks.update(state.taskId, patch), () => null);
  }
}

function fromOp<T>(result: OpResult<T>, task: (value: T) => Task | null): DraftSubmitResult {
  if (!result.ok) return { ok: false, reason: 'error', error: result.error };
  return { ok: true, changed: result.changed, task: task(result.value) };
}
