/**
 * Общая очередь отложенных удалений (доработка 006, §12): удаление из формы задачи или события
 * сразу скрывает элемент, а в корзину он уходит через 5 с, если не нажато «Вернуть».
 * Обёртка над `DeferredDeletes` с подпиской на изменения (вкладки перерисовываются).
 */

import type { NoticeAction, Notifier, PendingDeletes } from './contracts';
import type { ItemId, OpResult, Unsubscribe } from '../model/types';
import type { HapticKind } from '../ui/haptics';
import { DeferredDeletes, UNDO_DELETE_MS, windowTimers, type DeferredTimers } from '../tasks/deferred-delete';

export class ObservableDeferredDeletes implements PendingDeletes {
  private readonly inner: DeferredDeletes;
  private readonly listeners = new Set<() => void>();

  constructor(timers: DeferredTimers = windowTimers) {
    this.inner = new DeferredDeletes(timers);
  }

  schedule(id: ItemId, run: () => void, delayMs: number = UNDO_DELETE_MS): void {
    this.inner.schedule(
      id,
      () => {
        run();
        this.emit();
      },
      delayMs,
    );
    this.emit();
  }

  undo(id: ItemId): boolean {
    const undone = this.inner.undo(id);
    if (undone) this.emit();
    return undone;
  }

  has(id: ItemId): boolean {
    return this.inner.has(id);
  }

  get size(): number {
    return this.inner.size;
  }

  flush(): void {
    if (this.inner.size === 0) return;
    this.inner.flush();
    this.emit();
  }

  onChange(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[matrix-planner] pending delete listener failed', error);
      }
    }
  }
}

export interface DeleteWithUndoDeps {
  pending: PendingDeletes;
  notifier: Pick<Notifier, 'show' | 'showAction'>;
  haptic?(kind: HapticKind): void;
}

export interface DeleteWithUndoRequest {
  id: ItemId;
  /** Удаление (через 5 с, если не отменено). */
  remove(): Promise<OpResult<unknown>>;
  /** «Задача удалена». */
  message: string;
  /** «Вернуть». */
  undoLabel: string;
  /** Текст ошибки удаления. */
  errorMessage(result: Extract<OpResult<unknown>, { ok: false }>): string;
  delayMs?: number;
}

/**
 * Удаление с «Вернуть»: элемент скрывается сразу (очередь), уведомление «… · Вернуть» висит
 * `delayMs`, затем удаление. Ошибка удаления — уведомление и отклик `error`.
 */
export function deleteWithUndo(deps: DeleteWithUndoDeps, request: DeleteWithUndoRequest): void {
  const delayMs = request.delayMs ?? UNDO_DELETE_MS;
  deps.haptic?.('delete');
  deps.pending.schedule(
    request.id,
    () => {
      void request
        .remove()
        .then((result) => {
          if (result.ok) return;
          deps.haptic?.('error');
          deps.notifier.show(request.errorMessage(result));
        })
        .catch((error: unknown) => {
          console.error('[matrix-planner] deferred delete failed', error);
          deps.haptic?.('error');
        });
    },
    delayMs,
  );
  const action: NoticeAction = {
    label: request.undoLabel,
    run: () => {
      if (deps.pending.undo(request.id)) deps.haptic?.('undo');
    },
  };
  if (deps.notifier.showAction) deps.notifier.showAction(request.message, action, delayMs);
  else deps.notifier.show(request.message);
}

let shared: ObservableDeferredDeletes | null = null;

/** Общий экземпляр очереди (если сборка не передала свою — `CoreServices.pendingDeletes`). */
export function sharedPendingDeletes(): ObservableDeferredDeletes {
  shared ??= new ObservableDeferredDeletes();
  return shared;
}
