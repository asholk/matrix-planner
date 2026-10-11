import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguageOverride } from '../../src/i18n';
import { defaultMatrixConfig } from '../../src/model/defaults';
import type { OpResult } from '../../src/model/types';
import { runTaskMenuAction, type TaskMenuDeps, type TaskMenuTarget } from '../../src/tasks/task-menu';

const OK: OpResult = { ok: true, value: undefined, changed: true };
const TARGET: TaskMenuTarget = { taskId: 'T1', path: 'Задачи/T1.md', quadrant: 'do', done: false, instanceDate: null };

function deps(over: Partial<TaskMenuDeps> = {}) {
  const tasks = {
    moveToQuadrant: vi.fn(async (): Promise<OpResult> => OK),
    postponeToTomorrow: vi.fn(async (): Promise<OpResult> => OK),
    uncomplete: vi.fn(async (): Promise<OpResult> => OK),
    delete: vi.fn(async (): Promise<OpResult> => OK),
  };
  const run = vi.fn((op: () => Promise<OpResult<unknown>>) => void op());
  const base: TaskMenuDeps = { tasks, matrix: () => defaultMatrixConfig('ru'), openNote: vi.fn(), run, ...over };
  return { tasks, run, deps: base };
}

beforeEach(() => setLanguageOverride('ru'));

describe('меню задачи: «Вернуть» и отклик (доработка 006)', () => {
  it('с runUndoable перенос в квадрант и на завтра идут через него', () => {
    const runUndoable = vi.fn();
    const haptic = vi.fn<(kind: string) => void>();
    const { run, deps: d } = deps({ runUndoable, haptic });
    runTaskMenuAction(TARGET, { kind: 'move', quadrant: 'plan' }, d);
    const first = runUndoable.mock.calls[0]?.[0] as { kind: string; quadrant: string; message: string } | undefined;
    expect(first?.kind).toBe('move');
    expect(first?.quadrant).toBe('plan');
    expect(first?.message).toContain('перенесена');
    runTaskMenuAction(TARGET, { kind: 'postpone' }, d);
    expect(runUndoable).toHaveBeenLastCalledWith({ kind: 'postpone' });
    expect(run).not.toHaveBeenCalled();
    expect(haptic.mock.calls.map((c) => c[0])).toEqual(['drop', 'drop']);
  });

  it('без runUndoable (вкладка «Календарь») — прежнее поведение', () => {
    const { run, tasks, deps: d } = deps();
    runTaskMenuAction(TARGET, { kind: 'postpone' }, d);
    expect(run).toHaveBeenCalledTimes(1);
    expect(tasks.postponeToTomorrow).toHaveBeenCalledWith('T1');
  });

  it('отклик по пункту: удалить — delete, вернуть в работу — undo, заметка — tap', () => {
    const haptic = vi.fn<(kind: string) => void>();
    const { deps: d } = deps({ haptic });
    runTaskMenuAction(TARGET, { kind: 'delete' }, d);
    runTaskMenuAction({ ...TARGET, done: true }, { kind: 'uncomplete' }, d);
    runTaskMenuAction(TARGET, { kind: 'open-note' }, d);
    expect(haptic.mock.calls.map((c) => c[0])).toEqual(['delete', 'undo', 'tap']);
  });
});
