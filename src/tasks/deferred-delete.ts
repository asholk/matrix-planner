/**
 * Отложенное удаление с отменой (доработка 005, §4): задача, брошенная в зону удаления, сразу
 * пропадает с экрана, а в корзину уходит через `delayMs`, если пользователь не нажал «Вернуть».
 * Чистый модуль: таймеры внедряются (тесты — поддельные).
 */

import type { ItemId } from '../model/types';

/** Окно отмены удаления, мс. */
export const UNDO_DELETE_MS = 5000;

export interface DeferredTimers {
  set(run: () => void, delayMs: number): number;
  clear(handle: number): void;
}

export const windowTimers: DeferredTimers = {
  set: (run, delayMs) => window.setTimeout(run, delayMs),
  clear: (handle) => window.clearTimeout(handle),
};

interface Pending {
  timer: number;
  run: () => void;
}

export class DeferredDeletes {
  private readonly pending = new Map<ItemId, Pending>();

  constructor(private readonly timers: DeferredTimers = windowTimers) {}

  /** Запланировать удаление. Повторный вызов для того же id заменяет прежний. */
  schedule(id: ItemId, run: () => void, delayMs: number = UNDO_DELETE_MS): void {
    this.cancel(id);
    const timer = this.timers.set(() => {
      this.pending.delete(id);
      run();
    }, delayMs);
    this.pending.set(id, { timer, run });
  }

  /** Отменить удаление («Вернуть»). `true` — удаление ещё не выполнено и отменено. */
  undo(id: ItemId): boolean {
    return this.cancel(id);
  }

  has(id: ItemId): boolean {
    return this.pending.has(id);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Выполнить все ожидающие удаления сейчас (закрытие вкладки, выгрузка плагина). */
  flush(): void {
    const entries = [...this.pending.values()];
    for (const entry of entries) this.timers.clear(entry.timer);
    this.pending.clear();
    for (const entry of entries) entry.run();
  }

  private cancel(id: ItemId): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.timers.clear(entry.timer);
    this.pending.delete(id);
    return true;
  }
}
