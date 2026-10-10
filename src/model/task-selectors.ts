/**
 * Выборки и сортировка задач (ТЗ §4.2). Чистые функции; текущее время — параметр.
 *
 * Сортировка в квадранте: просроченные → по дате срока по возрастанию
 * (внутри дня: высокий приоритет выше, затем задачи со временем по времени, затем без времени)
 * → без срока по дате создания. Пример: «Сегодня 17:00» → «Сегодня» → «Завтра 09:00» → без срока.
 */

import {
  QUADRANT_KEYS,
  type CompletionEntry,
  type FloatingDateTime,
  type LocalDateString,
  type QuadrantKey,
  type Task,
} from './types';
import { isPastDue, parseFloating } from './dates';

/** Поля, нужные для сортировки (фикстуры `fixtures/sorting.json` используют эту форму). */
export type SortableTask = Pick<Task, 'id' | 'title' | 'due' | 'priority' | 'created' | 'done'>;

/** Задача не выполнена и её срок прошёл. */
export function isTaskOverdue(task: Pick<Task, 'due' | 'done'>, now: FloatingDateTime): boolean {
  return !task.done && task.due !== null && isPastDue(task.due, now);
}

/** Незавершённая задача вне архива. */
export function isActiveTask(task: Pick<Task, 'done' | 'archived'>): boolean {
  return !task.done && !task.archived;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `created` для сравнения: пустое значение — в конец. */
function createdKey(created: string | null): string {
  if (!created) return '￿';
  const parsed = parseFloating(created);
  return parsed ? `${parsed.date}T${parsed.time ?? '00:00'}` : '￿';
}

/** Компаратор сортировки в квадранте. */
export function compareTasks(a: SortableTask, b: SortableTask, now: FloatingDateTime): number {
  const overdueA = isTaskOverdue(a, now);
  const overdueB = isTaskOverdue(b, now);
  if (overdueA !== overdueB) return overdueA ? -1 : 1;

  if (a.due && b.due) {
    const byDate = compareText(a.due.date, b.due.date);
    if (byDate !== 0) return byDate;
    if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
    if ((a.due.time === null) !== (b.due.time === null)) return a.due.time === null ? 1 : -1;
    if (a.due.time !== null && b.due.time !== null) {
      const byTime = compareText(a.due.time, b.due.time);
      if (byTime !== 0) return byTime;
    }
  } else if (a.due || b.due) {
    return a.due ? -1 : 1;
  }

  return compareText(createdKey(a.created), createdKey(b.created)) || compareText(a.title, b.title) || compareText(a.id, b.id);
}

/** Новый отсортированный массив. */
export function sortTasks<T extends SortableTask>(tasks: readonly T[], now: FloatingDateTime): T[] {
  return [...tasks].sort((a, b) => compareTasks(a, b, now));
}

/** Незавершённые задачи вне архива по квадрантам, отсортированные. Пустые квадранты присутствуют. */
export function groupTasksByQuadrant(tasks: readonly Task[], now: FloatingDateTime): Record<QuadrantKey, Task[]> {
  const groups = {} as Record<QuadrantKey, Task[]>;
  for (const key of QUADRANT_KEYS) groups[key] = [];
  for (const task of tasks) {
    if (isActiveTask(task)) groups[task.quadrant].push(task);
  }
  for (const key of QUADRANT_KEYS) groups[key] = sortTasks(groups[key], now);
  return groups;
}

/** Группа списка «по датам»: просроченные, затем каждая дата, затем без срока. */
export type TaskDateGroup =
  | { kind: 'overdue'; tasks: Task[] }
  | { kind: 'date'; date: LocalDateString; tasks: Task[] }
  | { kind: 'no-date'; tasks: Task[] };

export function groupTasksByDate(tasks: readonly Task[], now: FloatingDateTime): TaskDateGroup[] {
  const sorted = sortTasks(tasks.filter(isActiveTask), now);
  const overdue: Task[] = [];
  const noDate: Task[] = [];
  const byDate = new Map<LocalDateString, Task[]>();
  for (const task of sorted) {
    if (isTaskOverdue(task, now)) overdue.push(task);
    else if (!task.due) noDate.push(task);
    else {
      const list = byDate.get(task.due.date);
      if (list) list.push(task);
      else byDate.set(task.due.date, [task]);
    }
  }
  const groups: TaskDateGroup[] = [];
  if (overdue.length) groups.push({ kind: 'overdue', tasks: overdue });
  for (const date of [...byDate.keys()].sort()) groups.push({ kind: 'date', date, tasks: byDate.get(date) ?? [] });
  if (noDate.length) groups.push({ kind: 'no-date', tasks: noDate });
  return groups;
}

/**
 * Записи фильтра «Выполнено»: выполненные неповторяющиеся задачи и каждое выполненное
 * повторение (`completions`). Сначала новые.
 */
export function completionEntries(tasks: readonly Task[]): CompletionEntry[] {
  const entries: CompletionEntry[] = [];
  for (const task of tasks) {
    if (task.repeat !== 'none') {
      for (const date of task.completions) {
        entries.push({ taskId: task.id, date, completedAt: null, instanceDate: date });
      }
    } else if (task.done) {
      const completed = parseFloating(task.completed);
      const date = completed?.date ?? task.due?.date ?? parseFloating(task.created)?.date ?? null;
      if (date === null) continue;
      entries.push({ taskId: task.id, date, completedAt: completed?.time ? task.completed : null, instanceDate: null });
    }
  }
  return entries.sort(
    (a, b) =>
      compareText(b.date, a.date) ||
      compareText(b.completedAt ?? '', a.completedAt ?? '') ||
      compareText(a.taskId, b.taskId) ||
      compareText(a.instanceDate ?? '', b.instanceDate ?? ''),
  );
}

/** Счётчик «Выполнено N»: каждое выполненное повторение считается отдельно. */
export function countCompletions(tasks: readonly Task[]): number {
  let count = 0;
  for (const task of tasks) {
    if (task.repeat !== 'none') count += task.completions.length;
    else if (task.done) count++;
  }
  return count;
}
