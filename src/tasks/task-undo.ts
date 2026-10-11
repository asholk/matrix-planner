/**
 * «Вернуть» после действий с задачей (доработка 006, §5, §7): обратная операция для выполнения,
 * переноса в квадрант, «Перенести на завтра» и массового переноса просроченных на сегодня.
 * Чистый модуль: без DOM и `obsidian`; уведомление показывает вызывающий (`Notifier.showAction`).
 */

import type { TaskService } from '../app/contracts';
import type { FloatingDateTime, ItemId, LocalDateString, OpResult, QuadrantKey } from '../model/types';

type Op = () => Promise<OpResult<unknown>>;

export type UndoTasks = Pick<TaskService, 'uncomplete' | 'moveToQuadrant' | 'reschedule' | 'update'>;

/** Отмена выполнения: для повторяющейся — именно выполненное повторение. */
export function undoComplete(tasks: UndoTasks, id: ItemId, instanceDate: LocalDateString | null): Op {
  return () => tasks.uncomplete(id, instanceDate ?? undefined);
}

/** Отмена переноса в квадрант: вернуть прежний. */
export function undoMove(tasks: UndoTasks, id: ItemId, from: QuadrantKey): Op {
  return () => tasks.moveToQuadrant(id, from);
}

/**
 * Отмена переноса срока: прежняя дата (время сохраняется) или снова без срока.
 * Якорь серии перенос не меняет, поэтому для повторяющейся достаточно вернуть дату.
 */
export function undoReschedule(tasks: UndoTasks, id: ItemId, previousDue: FloatingDateTime | null): Op {
  if (!previousDue) return () => tasks.update(id, { due: null });
  return () => tasks.reschedule(id, previousDue.date);
}

export interface BulkItem {
  id: ItemId;
  due: FloatingDateTime | null;
}

export interface BulkResult {
  /** Сколько задач изменено. */
  changed: BulkItem[];
  /** Первая ошибка (остальные задачи всё равно обработаны). */
  error: OpResult<unknown> | null;
}

/** Перенести задачи на дату по одной (время сохраняется); итог — изменённые и первая ошибка. */
export async function rescheduleAll(tasks: Pick<TaskService, 'reschedule'>, items: readonly BulkItem[], date: LocalDateString): Promise<BulkResult> {
  const changed: BulkItem[] = [];
  let error: OpResult<unknown> | null = null;
  for (const item of items) {
    try {
      const result = await tasks.reschedule(item.id, date);
      if (!result.ok) error ??= result;
      else if (result.changed) changed.push(item);
    } catch (cause) {
      error ??= { ok: false, error: { code: 'unknown', detail: String(cause), cause } };
    }
  }
  return { changed, error };
}

/** Отмена массового переноса: каждой задаче — прежний срок. */
export function undoRescheduleAll(tasks: UndoTasks, items: readonly BulkItem[]): Op {
  return async () => {
    let last: OpResult<unknown> = { ok: true, value: undefined, changed: false };
    for (const item of items) {
      const result = await undoReschedule(tasks, item.id, item.due)();
      if (!result.ok) return result;
      last = result.changed ? result : last;
    }
    return last;
  };
}
