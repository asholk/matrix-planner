/**
 * Архив выполненных задач (ТЗ §3.1, §4.6): `Задачи/Архив/ГГГГ-ММ/`.
 *
 * В архив попадают только выполненные неповторяющиеся задачи (серия не завершается
 * выполнением). Месяц папки — по дате выполнения. Перенос — `NoteRepository.move`
 * (`renameFile`), id и свойства не меняются. Автоперенос — по настройке
 * «никогда / через N дней». Возврат из архива возвращает задачу в работу.
 */

import type { ArchiveService, Clock, NoteIndex, NoteRepository, SettingsStore, TaskService } from '../app/contracts';
import type { ItemId, LocalDateString, OpResult, PlannerError, Task, VaultPath } from '../model/types';
import { diffDays, localDateOf, parseFloating } from '../model/dates';
import { parseTask } from '../model/properties';
import { errorResult, okResult } from '../storage/note-repository';
import { clockToday, findTask, taskMatches } from './task-service';

export interface ArchiveServiceDeps {
  repository: NoteRepository;
  index: NoteIndex;
  clock: Clock;
  settings: Pick<SettingsStore, 'get'>;
  /** Возврат из архива выполняется как «Вернуть в работу». */
  tasks: Pick<TaskService, 'uncomplete'>;
  waitTimeoutMs?: number;
}

const DEFAULT_WAIT_MS = 2000;

/** Задачу можно перенести в архив: выполнена, не повторяется, ещё не в архиве. */
export function isArchivable(task: Pick<Task, 'repeat' | 'done' | 'archived'>): boolean {
  return task.repeat === 'none' && task.done && !task.archived;
}

/** Дата выполнения: `completed`, иначе дата изменения файла; `null` — неизвестна. */
export function completionDateOf(task: Pick<Task, 'completed' | 'mtime'>, timeZone?: string): LocalDateString | null {
  const completed = parseFloating(task.completed);
  if (completed) return completed.date;
  return task.mtime > 0 ? localDateOf(new Date(task.mtime), timeZone) : null;
}

/** Задачи для автопереноса: выполнены не меньше `days` дней назад. */
export function selectForAutoArchive(tasks: readonly Task[], today: LocalDateString, days: number, timeZone?: string): Task[] {
  return tasks.filter((task) => {
    if (!isArchivable(task)) return false;
    const date = completionDateOf(task, timeZone);
    return date !== null && diffDays(date, today) >= days;
  });
}

export class VaultArchiveService implements ArchiveService {
  constructor(private readonly deps: ArchiveServiceDeps) {}

  async runAuto(): Promise<OpResult<number>> {
    const setting = this.deps.settings.get().archive;
    if (setting.mode === 'never') return okResult(0, false);
    if (!this.deps.index.isReady()) return errorResult('not-ready');
    const days = Math.max(0, Math.floor(setting.days));
    const timeZone = this.deps.clock.timeZone();
    const candidates = selectForAutoArchive(this.deps.index.getTasks(), clockToday(this.deps.clock), days, timeZone);

    let moved = 0;
    let firstError: PlannerError | null = null;
    for (const task of candidates) {
      // Список мог устареть, пока шли переносы: проверяем свойства в файле.
      const result = await this.moveToArchive(task, (actual) => selectForAutoArchive([actual], clockToday(this.deps.clock), days, timeZone).length > 0);
      if (result.ok) {
        if (result.changed) moved += 1;
        continue;
      }
      firstError ??= result.error;
      // Запись запрещена — остальные попытки бессмысленны.
      if (result.error.code === 'read-only') break;
    }
    if (firstError && moved === 0) return { ok: false, error: firstError };
    return okResult(moved, moved > 0);
  }

  async archive(id: ItemId): Promise<OpResult> {
    const found = findTask(this.deps.index, id);
    if (!found.ok) return found;
    const task = found.value;
    if (task.archived) return okResult(undefined, false);
    if (!isArchivable(task)) return errorResult('invalid', 'not-archivable', undefined, 'taskActions.errors.notArchivable');
    return this.moveToArchive(task, isArchivable);
  }

  async restore(id: ItemId): Promise<OpResult> {
    const found = findTask(this.deps.index, id);
    if (!found.ok) return found;
    const task = found.value;
    if (!task.archived) return okResult(undefined, false);
    // Возврат из архива = возврат в работу: иначе выполненная задача снова уйдёт в архив
    // при следующем автопереносе. `uncomplete` сам переносит задачу из архива в «Задачи».
    return this.deps.tasks.uncomplete(id);
  }

  /**
   * Переносит задачу, если её актуальные свойства (в файле) ещё подходят: индекс мог
   * отстать от «Вернуть в работу». Если выполнение отменили уже во время переноса,
   * задача возвращается в «Задачи» — как это делает `uncomplete` для архивной задачи.
   */
  private async moveToArchive(task: Task, stillFits: (actual: Task) => boolean): Promise<OpResult> {
    const before = await this.readActual(task, task.path);
    if (!before.ok) return before;
    if (!before.value || !stillFits(before.value)) return okResult(undefined, false);

    const timeZone = this.deps.clock.timeZone();
    const date = completionDateOf(before.value, timeZone) ?? clockToday(this.deps.clock);
    const folder = this.deps.repository.paths.archiveFor(date.slice(0, 7));
    const moved = await this.deps.repository.move(task.path, folder);
    if (!moved.ok) return moved;
    if (!moved.changed) return okResult(undefined, false);

    const after = await this.readActual(task, moved.value);
    if (after.ok && after.value && !after.value.done) {
      const back = await this.deps.repository.move(moved.value, this.deps.repository.paths.tasks);
      if (!back.ok) return back;
      if (back.changed) await this.waitFor(back.value, task.id, (current) => !current.archived);
      return okResult(undefined, false);
    }
    await this.wait(moved.value, task.id);
    return okResult(undefined, true);
  }

  /**
   * Свойства задачи прямо из файла (чтение в очереди записей по пути, без изменений).
   * `null` — по пути уже другая заметка или не задача.
   */
  private async readActual(task: Task, path: VaultPath): Promise<OpResult<Task | null>> {
    let actual: Task | null = null;
    const read = await this.deps.repository.updateFrontmatter(path, (frontmatter) => {
      const parsed = parseTask({
        path,
        title: task.title,
        mtime: task.mtime,
        frontmatter: { ...frontmatter },
        archived: false,
        deletedInCalendar: false,
      });
      actual = parsed.kind === 'task' && parsed.id === task.id ? parsed : null;
    });
    if (!read.ok) return read;
    return okResult(actual, false);
  }

  private async wait(path: string, id: ItemId): Promise<void> {
    await this.waitFor(path, id, (task) => task.archived);
  }

  private async waitFor(path: string, id: ItemId, extra: (task: Task) => boolean): Promise<void> {
    await this.deps.index.waitFor(path, taskMatches(id, undefined, extra), this.deps.waitTimeoutMs ?? DEFAULT_WAIT_MS);
  }
}
