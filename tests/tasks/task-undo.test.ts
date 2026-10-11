import { describe, expect, it, vi } from 'vitest';
import type { OpResult } from '../../src/model/types';
import { rescheduleAll, undoComplete, undoMove, undoReschedule, undoRescheduleAll, type UndoTasks } from '../../src/tasks/task-undo';

const OK: OpResult = { ok: true, value: undefined, changed: true };
const SAME: OpResult = { ok: true, value: undefined, changed: false };

function tasks() {
  return {
    uncomplete: vi.fn(async (): Promise<OpResult> => OK),
    moveToQuadrant: vi.fn(async (): Promise<OpResult> => OK),
    reschedule: vi.fn(async (): Promise<OpResult> => OK),
    update: vi.fn(async (): Promise<OpResult> => OK),
  };
}

const as = (t: ReturnType<typeof tasks>): UndoTasks => t;

describe('«Вернуть» после действий с задачей', () => {
  it('выполнение повторяющейся — возвращается именно выполненное повторение', async () => {
    const t = tasks();
    await undoComplete(as(t), 'T1', '2026-10-11')();
    expect(t.uncomplete).toHaveBeenCalledWith('T1', '2026-10-11');
    await undoComplete(as(t), 'T2', null)();
    expect(t.uncomplete).toHaveBeenLastCalledWith('T2', undefined);
  });

  it('перенос в квадрант — прежний квадрант', async () => {
    const t = tasks();
    await undoMove(as(t), 'T1', 'urgent')();
    expect(t.moveToQuadrant).toHaveBeenCalledWith('T1', 'urgent');
  });

  it('«На завтра» — прежняя дата (время сохраняет сервис) или снова без срока', async () => {
    const t = tasks();
    await undoReschedule(as(t), 'T1', { date: '2026-10-09', time: '10:30' })();
    expect(t.reschedule).toHaveBeenCalledWith('T1', '2026-10-09');
    await undoReschedule(as(t), 'T2', null)();
    expect(t.update).toHaveBeenCalledWith('T2', { due: null });
  });
});

describe('«Перенести всё на сегодня»', () => {
  it('переносит по одной, считает изменённые и запоминает первую ошибку', async () => {
    const reschedule = vi
      .fn<(id: string, date: string) => Promise<OpResult>>()
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(SAME)
      .mockResolvedValueOnce({ ok: false, error: { code: 'write-failed' } })
      .mockResolvedValueOnce(OK);
    const items = [
      { id: 'A', due: { date: '2026-10-09', time: '10:30' } },
      { id: 'B', due: { date: '2026-10-11', time: null } },
      { id: 'C', due: { date: '2026-10-01', time: null } },
      { id: 'D', due: { date: '2026-10-08', time: null } },
    ];
    const result = await rescheduleAll({ reschedule }, items, '2026-10-11');
    expect(reschedule).toHaveBeenCalledTimes(4);
    expect(reschedule).toHaveBeenCalledWith('A', '2026-10-11');
    expect(result.changed.map((item) => item.id)).toEqual(['A', 'D']);
    expect(result.error).toMatchObject({ ok: false, error: { code: 'write-failed' } });
  });

  it('исключение сервиса не прерывает перенос остальных', async () => {
    const reschedule = vi
      .fn<(id: string, date: string) => Promise<OpResult>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(OK);
    const result = await rescheduleAll(
      { reschedule },
      [
        { id: 'A', due: null },
        { id: 'B', due: null },
      ],
      '2026-10-11',
    );
    expect(result.changed.map((item) => item.id)).toEqual(['B']);
    expect(result.error).toMatchObject({ ok: false, error: { code: 'unknown' } });
  });

  it('«Вернуть» восстанавливает каждой задаче прежний срок', async () => {
    const t = tasks();
    const res = await undoRescheduleAll(as(t), [
      { id: 'A', due: { date: '2026-10-09', time: '10:30' } },
      { id: 'B', due: { date: '2026-10-08', time: null } },
    ])();
    expect(res.ok).toBe(true);
    expect(t.reschedule.mock.calls).toEqual([
      ['A', '2026-10-09'],
      ['B', '2026-10-08'],
    ]);
  });

  it('ошибка отмены останавливает и возвращается', async () => {
    const t = tasks();
    t.reschedule.mockResolvedValueOnce({ ok: false, error: { code: 'stale' } });
    const res = await undoRescheduleAll(as(t), [
      { id: 'A', due: { date: '2026-10-09', time: null } },
      { id: 'B', due: { date: '2026-10-08', time: null } },
    ])();
    expect(res.ok).toBe(false);
    expect(t.reschedule).toHaveBeenCalledTimes(1);
  });
});
