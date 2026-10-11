import { describe, expect, it } from 'vitest';
import fixtures from '../../fixtures/recurrence.json';
import {
  applyTaskPatch,
  newTaskProperties,
  planComplete,
  planDraftUpdate,
  planMoveToQuadrant,
  planPostponeToTomorrow,
  planReschedule,
  planUncomplete,
  type TaskRuleInput,
  type TaskRuleOutcome,
} from '../../src/model/task-rules';
import { parseFloating } from '../../src/model/dates';
import type { FloatingDateTime, TaskProperties } from '../../src/model/types';

interface RuleCase {
  name: string;
  task: TaskRuleInput;
  instanceDate: string | null;
  now?: string;
  expected: TaskRuleOutcome;
}

function at(value: string): FloatingDateTime {
  const parsed = parseFloating(value);
  if (!parsed) throw new Error(`bad fixture date ${value}`);
  return parsed;
}

const NOW = at('2026-10-10T13:20');

function task(overrides: Partial<TaskProperties> = {}): TaskProperties {
  return {
    type: 'task',
    id: '01JA7Q3K8Z6Y2V5N4M0C1B2D3E',
    quadrant: 'do',
    due: null,
    repeat: 'none',
    repeat_anchor: null,
    remind: 'none',
    priority: 'normal',
    duration: null,
    done: false,
    completed: null,
    completions: [],
    created: '2026-10-01T10:00',
    ...overrides,
  };
}

describe('task rules fixtures', () => {
  for (const c of fixtures.complete as unknown as RuleCase[]) {
    it(`complete: ${c.name}`, () => {
      expect(planComplete(c.task, { instanceDate: c.instanceDate, now: at(c.now as string) })).toEqual(c.expected);
    });
  }
  for (const c of fixtures.uncomplete as unknown as RuleCase[]) {
    it(`uncomplete: ${c.name}`, () => {
      expect(planUncomplete(c.task, { instanceDate: c.instanceDate })).toEqual(c.expected);
    });
  }
});

describe('completion idempotency', () => {
  it('completing the same occurrence twice gives one mark', () => {
    const initial = task({ due: '2026-10-10T08:00', repeat: 'daily', repeat_anchor: '2026-10-01' });
    const first = planComplete(initial, { instanceDate: '2026-10-10', now: NOW });
    expect(first.kind).toBe('change');
    if (first.kind !== 'change') return;
    const after = applyTaskPatch(initial, first.patch);
    expect(after.completions).toEqual(['2026-10-10']);
    expect(after.due).toBe('2026-10-11T08:00');
    expect(planComplete(after, { instanceDate: '2026-10-10', now: NOW })).toEqual({ kind: 'skip' });
  });

  it('complete then uncomplete restores the task', () => {
    const initial = task({ due: '2026-10-10T08:00', repeat: 'daily', repeat_anchor: '2026-10-01' });
    const done = planComplete(initial, { now: NOW });
    if (done.kind !== 'change') throw new Error('expected change');
    const completed = applyTaskPatch(initial, done.patch);
    const undo = planUncomplete(completed, { instanceDate: '2026-10-10' });
    if (undo.kind !== 'change') throw new Error('expected change');
    const restored = applyTaskPatch(completed, undo.patch);
    expect(restored.due).toBe('2026-10-10T08:00');
    expect(restored.completions).toEqual([]);
  });

  it('history occurrence can be uncompleted after repeat changed to never', () => {
    const t = task({ due: '2026-10-11', repeat: 'none', completions: ['2026-10-08', '2026-10-09'] });
    expect(planUncomplete(t, { instanceDate: '2026-10-08' })).toEqual({
      kind: 'change',
      patch: { completions: ['2026-10-09'] },
    });
    expect(planUncomplete(t, { instanceDate: '2026-10-01' })).toEqual({ kind: 'skip' });
  });

  it('monthly series keeps the 31st through February', () => {
    let current = task({ due: '2026-01-31', repeat: 'monthly' });
    const dues: string[] = [];
    for (const day of ['2026-01-31', '2026-02-28', '2026-03-31']) {
      const outcome = planComplete(current, { now: at(`${day}T09:00`) });
      if (outcome.kind !== 'change') throw new Error('expected change');
      current = applyTaskPatch(current, outcome.patch);
      dues.push(current.due as string);
    }
    expect(dues).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    expect(current.repeat_anchor).toBe('2026-01-31');
  });
});

describe('reschedule and quadrant', () => {
  it('keeps time and series anchor', () => {
    const t = task({ due: '2026-10-10T09:00', repeat: 'weekly', repeat_anchor: '2026-10-03' });
    expect(planReschedule(t, '2026-10-12')).toEqual({ kind: 'change', patch: { due: '2026-10-12T09:00' } });
  });

  it('fixes empty anchor before moving a recurring task', () => {
    const t = task({ due: '2026-01-31', repeat: 'monthly' });
    expect(planReschedule(t, '2026-02-02')).toEqual({
      kind: 'change',
      patch: { due: '2026-02-02', repeat_anchor: '2026-01-31' },
    });
  });

  it('never moves a recurring task onto a completed occurrence', () => {
    const t = task({
      due: '2026-10-12T09:00',
      repeat: 'daily',
      repeat_anchor: '2026-10-01',
      completions: ['2026-10-10', '2026-10-11'],
    });
    const outcome = planReschedule(t, '2026-10-10');
    expect(outcome).toEqual({ kind: 'skip' });
    const later = task({ ...t, due: '2026-10-15T09:00' });
    const moved = planReschedule(later, '2026-10-10');
    expect(moved).toEqual({ kind: 'change', patch: { due: '2026-10-12T09:00' } });
    // После переноса выполнение срока действительно отмечает повторение.
    const next = applyTaskPatch(later, (moved as { patch: object }).patch);
    expect(planComplete(next, { now: NOW }).kind).toBe('change');
  });

  it('postpones to tomorrow relative to today', () => {
    const t = task({ due: '2026-10-05T18:00' });
    expect(planPostponeToTomorrow(t, '2026-10-10')).toEqual({ kind: 'change', patch: { due: '2026-10-11T18:00' } });
  });

  it('skips no-op changes', () => {
    expect(planReschedule(task({ due: '2026-10-11' }), '2026-10-11')).toEqual({ kind: 'skip' });
    expect(planMoveToQuadrant(task({ quadrant: 'plan' }), 'plan')).toEqual({ kind: 'skip' });
    expect(planMoveToQuadrant(task({ quadrant: 'plan' }), 'urgent')).toEqual({ kind: 'change', patch: { quadrant: 'urgent' } });
  });
});

describe('task form', () => {
  it('creates properties with anchor for recurring task', () => {
    const props = newTaskProperties(
      { quadrant: 'plan', due: { date: '2026-10-31', time: '09:00' }, repeat: 'monthly', remind: '15m', priority: 'high', duration: null },
      { id: 'ID', now: NOW },
    );
    expect(props).toMatchObject({
      type: 'task',
      id: 'ID',
      due: '2026-10-31T09:00',
      repeat: 'monthly',
      repeat_anchor: '2026-10-31',
      remind: '15m',
      done: false,
      completions: [],
      created: '2026-10-10T13:20',
    });
  });

  it('drops repeat and reminder without due', () => {
    const props = newTaskProperties(
      { quadrant: 'do', due: null, repeat: 'daily', remind: 'at', priority: 'normal', duration: null },
      { id: 'ID', now: NOW },
    );
    expect(props).toMatchObject({ due: null, repeat: 'none', remind: 'none', repeat_anchor: null });
  });

  it('moves anchor when due date changes in the form', () => {
    const t = task({ due: '2026-10-10T09:00', repeat: 'weekly', repeat_anchor: '2026-10-03' });
    expect(planDraftUpdate(t, { due: { date: '2026-10-13', time: '09:00' } })).toEqual({
      kind: 'change',
      patch: { due: '2026-10-13T09:00', repeat_anchor: '2026-10-13' },
    });
  });

  it('keeps anchor when only time changes', () => {
    const t = task({ due: '2026-02-28T09:00', repeat: 'monthly', repeat_anchor: '2026-01-31' });
    expect(planDraftUpdate(t, { due: { date: '2026-02-28', time: '10:00' } })).toEqual({
      kind: 'change',
      patch: { due: '2026-02-28T10:00' },
    });
  });

  it('clearing due clears repeat, reminder and anchor', () => {
    const t = task({ due: '2026-10-10', repeat: 'daily', repeat_anchor: '2026-10-01', remind: 'at' });
    expect(planDraftUpdate(t, { due: null })).toEqual({
      kind: 'change',
      patch: { due: null, repeat: 'none', remind: 'none', repeat_anchor: null },
    });
  });

  it('form due on a completed occurrence moves to the next pending one', () => {
    const t = task({
      due: '2026-10-19T09:00',
      repeat: 'weekly',
      repeat_anchor: '2026-09-28',
      completions: ['2026-10-05'],
    });
    const outcome = planDraftUpdate(t, { due: { date: '2026-10-05', time: '09:00' } });
    expect(outcome).toEqual({
      kind: 'change',
      patch: { due: '2026-10-12T09:00', repeat_anchor: '2026-10-05' },
    });
    const next = applyTaskPatch(t, (outcome as { patch: object }).patch);
    expect(planComplete(next, { now: NOW }).kind).toBe('change');
  });

  it('no changes is a skip', () => {
    const t = task({ due: '2026-10-10', priority: 'high' });
    expect(planDraftUpdate(t, { priority: 'high', title: 'x' })).toEqual({ kind: 'skip' });
  });
});
