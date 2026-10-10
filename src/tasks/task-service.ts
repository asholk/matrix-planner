/**
 * Операции задач (ТЗ §3.2–3.3, §3.7, §4.2): создание, правка, выполнение, возврат,
 * перенос срока и квадранта, удаление в корзину.
 *
 * Правила изменения — чистые функции `model/task-rules.ts`. Сервис применяет их внутри
 * `processFrontMatter` к фактическому содержимому заметки, а не к снимку индекса: индекс
 * обновляется только после `metadataCache.changed`, поэтому повторное или устаревшее действие
 * сверяется с тем, что реально лежит в файле. После записи сервис ждёт, пока индекс увидит
 * изменение (`NoteIndex.waitFor` с предикатом).
 */

import type { Clock, IdGenerator, NoteIndex, NoteRepository, TaskService } from '../app/contracts';
import {
  PRIORITIES,
  QUADRANT_KEYS,
  REMIND_OFFSETS,
  REPEAT_RULES,
  type CompletionEntry,
  type FloatingDateTime,
  type FrontmatterRecord,
  type ItemId,
  type LocalDateString,
  type OpResult,
  type ParsedNote,
  type QuadrantKey,
  type Task,
  type TaskDraft,
  type TaskPatch,
  type TaskProperties,
  type VaultPath,
} from '../model/types';
import { floatingFromDate, isValidDate, isValidTime, localDateOf } from '../model/dates';
import { applyFrontmatterPatch, parseTask, taskToFrontmatter } from '../model/properties';
import {
  newTaskProperties,
  planComplete,
  planDraftUpdate,
  planMoveToQuadrant,
  planPostponeToTomorrow,
  planReschedule,
  planUncomplete,
  type TaskPropertiesPatch,
  type TaskRuleOutcome,
} from '../model/task-rules';
import { completionEntries } from '../model/task-selectors';
import { errorResult, okResult } from '../storage/note-repository';
import { registerDictionary } from '../i18n';
import { ruTaskActions } from '../i18n/ru/task-actions';
import { enTaskActions } from '../i18n/en/task-actions';

/** Словари модуля задач (общие для сервиса, архива и действий). */
export function registerTaskDictionaries(): void {
  registerDictionary('ru', 'taskActions', ruTaskActions);
  registerDictionary('en', 'taskActions', enTaskActions);
}
registerTaskDictionaries();

export interface TaskServiceDeps {
  repository: NoteRepository;
  index: NoteIndex;
  clock: Clock;
  ids: IdGenerator;
  /** Сколько ждать обновления индекса после записи (мс). */
  waitTimeoutMs?: number;
}

const DEFAULT_WAIT_MS = 2000;

/** Поля черновика, которые хранятся в свойствах (название — имя файла, тело — текст). */
const PROPERTY_FIELDS = ['quadrant', 'due', 'repeat', 'remind', 'priority'] as const satisfies readonly (keyof TaskDraft)[];

/** Почему правило не применено, кроме причин из `task-rules`. */
type ApplyOutcome = TaskRuleOutcome | { kind: 'mismatch' };

// ---------------------------------------------------------------------------
// Общие помощники (используются и архивом)
// ---------------------------------------------------------------------------

/** Текущее местное время по часам сервиса. */
export function clockNow(clock: Clock): FloatingDateTime & { time: string } {
  return floatingFromDate(clock.now(), clock.timeZone());
}

export function clockToday(clock: Clock): LocalDateString {
  return localDateOf(clock.now(), clock.timeZone());
}

/** Находит задачу в индексе; ошибки `not-ready`/`not-found`. */
export function findTask(index: NoteIndex, id: ItemId): OpResult<Task> {
  if (!index.isReady()) return errorResult('not-ready');
  const item = index.getById(id);
  if (!item || item.kind !== 'task') return errorResult('not-found', id);
  return okResult(item, false);
}

/** Предикат ожидания: заметка — задача с этим id и (необязательно) нужными свойствами. */
export function taskMatches(id: ItemId, patch?: TaskPropertiesPatch, extra?: (task: Task) => boolean) {
  return (item: ParsedNote): boolean => {
    if (item.kind !== 'task' || item.id !== id) return false;
    if (extra && !extra(item)) return false;
    if (!patch) return true;
    const props = item.props as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (JSON.stringify(props[key] ?? null) !== JSON.stringify(value)) return false;
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Проверка черновика
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isValidDue(due: FloatingDateTime | null): boolean {
  if (due === null) return true;
  return isValidDate(due.date) && (due.time === null || isValidTime(due.time));
}

/** Возвращает имя невалидного поля или `null`. */
export function invalidDraftField(patch: TaskPatch, requireTitle: boolean): keyof TaskDraft | null {
  if (patch.title !== undefined || requireTitle) {
    if (typeof patch.title !== 'string' || patch.title.trim() === '') return 'title';
  }
  if (patch.body !== undefined && typeof patch.body !== 'string') return 'body';
  if (patch.quadrant !== undefined && !isOneOf(QUADRANT_KEYS, patch.quadrant)) return 'quadrant';
  if (patch.due !== undefined && !isValidDue(patch.due)) return 'due';
  if (patch.repeat !== undefined && !isOneOf(REPEAT_RULES, patch.repeat)) return 'repeat';
  if (patch.remind !== undefined && !isOneOf(REMIND_OFFSETS, patch.remind)) return 'remind';
  if (patch.priority !== undefined && !isOneOf(PRIORITIES, patch.priority)) return 'priority';
  return null;
}

// ---------------------------------------------------------------------------
// Сервис
// ---------------------------------------------------------------------------

export class VaultTaskService implements TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  async create(draft: TaskDraft): Promise<OpResult<Task | null>> {
    const invalid = invalidDraftField(draft, true);
    if (invalid) return errorResult('invalid', invalid);
    const id = this.deps.ids.next();
    const props = newTaskProperties(draft, { id, now: clockNow(this.deps.clock) });
    const created = await this.deps.repository.create({
      folder: this.deps.repository.paths.tasks,
      title: draft.title.trim(),
      frontmatter: taskToFrontmatter(props),
      body: draft.body ?? '',
    });
    if (!created.ok) return created;
    const item = await this.wait(created.value, taskMatches(id));
    return okResult(item && item.kind === 'task' ? item : null, true);
  }

  async update(id: ItemId, patch: TaskPatch): Promise<OpResult> {
    const invalid = invalidDraftField(patch, false);
    if (invalid) return errorResult('invalid', invalid);
    const found = findTask(this.deps.index, id);
    if (!found.ok) return found;
    const task = found.value;
    let path = task.path;
    let changed = false;
    let written: TaskPropertiesPatch | undefined;

    // Свойства: перенос якоря и сброс повтора/напоминания без срока — в planDraftUpdate.
    if (PROPERTY_FIELDS.some((key) => patch[key] !== undefined)) {
      const props = await this.applyRule(task, (current) => planDraftUpdate(current, patch));
      if (!props.ok) return props;
      if (props.value) {
        changed = true;
        written = props.value;
      }
    }

    if (patch.body !== undefined) {
      const body = patch.body;
      const result = await this.deps.repository.updateBody(path, () => body);
      if (!result.ok) return result;
      changed = changed || result.changed;
    }

    const title = patch.title?.trim();
    if (title !== undefined && title !== task.title) {
      // Переименование — последним: id в свойствах не меняется.
      const renamed = await this.deps.repository.rename(path, title);
      if (!renamed.ok) return renamed;
      path = renamed.value;
      changed = changed || renamed.changed;
    }

    if (changed) await this.wait(path, taskMatches(id, written));
    return okResult(undefined, changed);
  }

  async complete(id: ItemId, instanceDate?: LocalDateString): Promise<OpResult> {
    if (instanceDate !== undefined && !isValidDate(instanceDate)) return errorResult('invalid', 'instanceDate');
    const now = clockNow(this.deps.clock);
    return this.run(id, (current) => planComplete(current, { instanceDate: instanceDate ?? null, now }));
  }

  async uncomplete(id: ItemId, instanceDate?: LocalDateString): Promise<OpResult> {
    if (instanceDate !== undefined && !isValidDate(instanceDate)) return errorResult('invalid', 'instanceDate');
    const found = findTask(this.deps.index, id);
    if (!found.ok) return found;
    const task = found.value;
    const result = await this.runOn(task, (current) => planUncomplete(current, { instanceDate: instanceDate ?? null }));
    if (!result.ok || !task.archived || task.repeat !== 'none') return result;
    // Невыполненной задаче не место в архиве: возвращаем её в «Задачи».
    const moved = await this.deps.repository.move(task.path, this.deps.repository.paths.tasks);
    if (!moved.ok) return moved;
    if (moved.changed) await this.wait(moved.value, taskMatches(id, undefined, (t) => !t.archived));
    return okResult(undefined, result.changed || moved.changed);
  }

  async moveToQuadrant(id: ItemId, quadrant: QuadrantKey): Promise<OpResult> {
    if (!isOneOf(QUADRANT_KEYS, quadrant)) return errorResult('invalid', 'quadrant');
    return this.run(id, (current) => planMoveToQuadrant(current, quadrant));
  }

  async reschedule(id: ItemId, date: LocalDateString): Promise<OpResult> {
    if (!isValidDate(date)) return errorResult('invalid', 'date');
    // Разовый перенос: якорь серии не меняется (см. planReschedule).
    return this.run(id, (current) => planReschedule(current, date));
  }

  async postponeToTomorrow(id: ItemId): Promise<OpResult> {
    const today = clockToday(this.deps.clock);
    return this.run(id, (current) => planPostponeToTomorrow(current, today));
  }

  async delete(id: ItemId): Promise<OpResult> {
    const found = findTask(this.deps.index, id);
    if (!found.ok) return found;
    return this.deps.repository.trash(found.value.path);
  }

  getCompletions(): readonly CompletionEntry[] {
    return completionEntries(this.deps.index.getTasks());
  }

  // -------------------------------------------------------------------------

  private async run(id: ItemId, rule: (current: TaskProperties) => TaskRuleOutcome): Promise<OpResult> {
    const found = findTask(this.deps.index, id);
    if (!found.ok) return found;
    return this.runOn(found.value, rule);
  }

  private async runOn(task: Task, rule: (current: TaskProperties) => TaskRuleOutcome): Promise<OpResult> {
    const result = await this.applyRule(task, rule);
    if (!result.ok) return result;
    if (!result.value) return okResult(undefined, false);
    await this.wait(task.path, taskMatches(task.id, result.value));
    return okResult(undefined, true);
  }

  /**
   * Применяет правило к фактическим свойствам заметки. Значение — записанное изменение
   * или `null` (идемпотентный пропуск). Ожидание индекса — на вызывающей стороне.
   */
  private async applyRule(
    task: Task,
    rule: (current: TaskProperties) => TaskRuleOutcome,
  ): Promise<OpResult<TaskPropertiesPatch | null>> {
    const box: { outcome: ApplyOutcome | null } = { outcome: null };
    const written = await this.deps.repository.updateFrontmatter(task.path, (frontmatter) => {
      const current = parseCurrent(task, frontmatter);
      if (!current) {
        box.outcome = { kind: 'mismatch' };
        return;
      }
      const outcome = rule(current);
      box.outcome = outcome;
      if (outcome.kind === 'change') applyFrontmatterPatch<TaskProperties>(frontmatter, outcome.patch);
    });
    if (!written.ok) return written;
    const outcome = box.outcome;
    if (outcome === null) return errorResult('unknown', 'frontmatter callback was not called');
    switch (outcome.kind) {
      case 'mismatch':
        return errorResult('stale', 'id-mismatch');
      case 'stale':
        return errorResult('stale', outcome.reason);
      case 'skip':
        return okResult(null, false);
      case 'change':
        return okResult(outcome.patch, true);
    }
  }

  private async wait(path: VaultPath, predicate: (item: ParsedNote) => boolean): Promise<ParsedNote | null> {
    const item = await this.deps.index.waitFor(path, predicate, this.deps.waitTimeoutMs ?? DEFAULT_WAIT_MS);
    return item && predicate(item) ? item : null;
  }
}

/** Разбирает фактический frontmatter; `null` — заметка больше не та задача. */
function parseCurrent(task: Task, frontmatter: FrontmatterRecord): TaskProperties | null {
  const parsed = parseTask({
    path: task.path,
    title: task.title,
    mtime: task.mtime,
    frontmatter,
    archived: task.archived,
    deletedInCalendar: false,
  });
  if (parsed.kind !== 'task' || parsed.id !== task.id) return null;
  return parsed.props;
}
