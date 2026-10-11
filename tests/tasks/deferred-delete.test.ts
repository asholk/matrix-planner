import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeferredDeletes, UNDO_DELETE_MS, type DeferredTimers } from '../../src/tasks/deferred-delete';

const timers: DeferredTimers = {
  set: (run, delayMs) => setTimeout(run, delayMs) as unknown as number,
  clear: (handle) => clearTimeout(handle),
};

describe('DeferredDeletes — удаление с «Вернуть»', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('удаление выполняется через 5 с, пока ждёт — задача скрыта', () => {
    const deletes = new DeferredDeletes(timers);
    const run = vi.fn();
    deletes.schedule('t1', run);
    expect(UNDO_DELETE_MS).toBe(5000);
    expect(deletes.has('t1')).toBe(true);
    vi.advanceTimersByTime(UNDO_DELETE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(deletes.has('t1')).toBe(false);
  });

  it('«Вернуть» отменяет удаление', () => {
    const deletes = new DeferredDeletes(timers);
    const run = vi.fn();
    deletes.schedule('t1', run);
    expect(deletes.undo('t1')).toBe(true);
    vi.advanceTimersByTime(UNDO_DELETE_MS * 2);
    expect(run).not.toHaveBeenCalled();
    expect(deletes.has('t1')).toBe(false);
    // Повторная отмена и отмена после удаления — без эффекта.
    expect(deletes.undo('t1')).toBe(false);
  });

  it('после выполнения «Вернуть» уже ничего не отменяет', () => {
    const deletes = new DeferredDeletes(timers);
    const run = vi.fn();
    deletes.schedule('t1', run, 100);
    vi.advanceTimersByTime(100);
    expect(deletes.undo('t1')).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('flush выполняет ожидающие сразу (закрытие вида) и один раз', () => {
    const deletes = new DeferredDeletes(timers);
    const a = vi.fn();
    const b = vi.fn();
    deletes.schedule('a', a);
    deletes.schedule('b', b);
    expect(deletes.size).toBe(2);
    deletes.flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(deletes.size).toBe(0);
    vi.advanceTimersByTime(UNDO_DELETE_MS);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('повторное планирование того же id заменяет прежнее', () => {
    const deletes = new DeferredDeletes(timers);
    const first = vi.fn();
    const second = vi.fn();
    deletes.schedule('t1', first);
    deletes.schedule('t1', second);
    vi.advanceTimersByTime(UNDO_DELETE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
