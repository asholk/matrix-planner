import { describe, expect, it } from 'vitest';
import fixtures from '../../fixtures/sorting.json';
import {
  completionEntries,
  countCompletions,
  groupTasksByDate,
  groupTasksByQuadrant,
  isTaskOverdue,
  sortTasks,
  type SortableTask,
} from '../../src/model/task-selectors';
import { parseFloating } from '../../src/model/dates';
import type { FloatingDateTime, Priority, Task, TaskProperties } from '../../src/model/types';

interface FixtureTask { id: string; title: string; due: string | null; priority: string; created: string | null; done: boolean }

function at(value: string): FloatingDateTime {
  const parsed = parseFloating(value);
  if (!parsed) throw new Error(`bad fixture date ${value}`);
  return parsed;
}

function sortable(t: FixtureTask): SortableTask {
  return { id: t.id, title: t.title, due: t.due ? at(t.due) : null, priority: t.priority as Priority, created: t.created, done: t.done };
}

const NOW = at('2026-10-10T12:00');

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  const props = {} as TaskProperties;
  return {
    kind: 'task',
    path: `Планировщик/Задачи/${overrides.id}.md`,
    title: overrides.id,
    mtime: 1,
    props,
    extra: {},
    issues: [],
    quadrant: 'do',
    due: null,
    repeat: 'none',
    repeatAnchor: null,
    remind: 'none',
    priority: 'normal',
    done: false,
    completed: null,
    completions: [],
    created: '2026-10-01T10:00',
    archived: false,
    ...overrides,
  };
}

describe('sorting fixtures', () => {
  for (const c of fixtures.sorting as Array<{ name: string; now: string; tasks: FixtureTask[]; expected: string[] }>) {
    it(c.name, () => {
      expect(sortTasks(c.tasks.map(sortable), at(c.now)).map((t) => t.id)).toEqual(c.expected);
    });
  }

  for (const c of fixtures.overdue as Array<{ name: string; due: string | null; now: string; done: boolean; expected: boolean }>) {
    it(`overdue: ${c.name}`, () => {
      expect(isTaskOverdue({ due: c.due ? at(c.due) : null, done: c.done }, at(c.now))).toBe(c.expected);
    });
  }
});

describe('grouping', () => {
  const tasks = [
    makeTask({ id: 'a', quadrant: 'do', due: at('2026-10-10T17:00') }),
    makeTask({ id: 'b', quadrant: 'do', due: at('2026-10-09') }),
    makeTask({ id: 'c', quadrant: 'plan' }),
    makeTask({ id: 'd', quadrant: 'plan', done: true, completed: '2026-10-09T08:15' }),
    makeTask({ id: 'e', quadrant: 'urgent', due: at('2026-10-12'), archived: true }),
    makeTask({ id: 'f', quadrant: 'urgent', due: at('2026-10-11T09:00') }),
  ];

  it('groups active tasks by quadrant, empty quadrants included', () => {
    const groups = groupTasksByQuadrant(tasks, NOW);
    expect(groups.do.map((t) => t.id)).toEqual(['b', 'a']);
    expect(groups.plan.map((t) => t.id)).toEqual(['c']);
    expect(groups.urgent.map((t) => t.id)).toEqual(['f']);
    expect(groups.someday).toEqual([]);
  });

  it('groups by date: overdue, dates, no date', () => {
    const groups = groupTasksByDate(tasks, NOW);
    expect(groups.map((g) => (g.kind === 'date' ? g.date : g.kind))).toEqual(['overdue', '2026-10-10', '2026-10-11', 'no-date']);
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(['b']);
  });
});

describe('completions', () => {
  const tasks = [
    makeTask({ id: 'single', done: true, completed: '2026-10-09T08:15' }),
    makeTask({ id: 'daily', repeat: 'daily', due: at('2026-10-11'), completions: ['2026-10-08', '2026-10-10'] }),
    makeTask({ id: 'open' }),
  ];

  it('lists each completed occurrence separately, newest first', () => {
    expect(completionEntries(tasks)).toEqual([
      { taskId: 'daily', date: '2026-10-10', completedAt: null, instanceDate: '2026-10-10' },
      { taskId: 'single', date: '2026-10-09', completedAt: '2026-10-09T08:15', instanceDate: null },
      { taskId: 'daily', date: '2026-10-08', completedAt: null, instanceDate: '2026-10-08' },
    ]);
  });

  it('counts completions of a series', () => {
    expect(countCompletions(tasks)).toBe(3);
  });

  it('keeps history after the repeat rule is changed to never', () => {
    const changed = [makeTask({ id: 'was-daily', repeat: 'none', due: at('2026-10-11'), completions: ['2026-10-08'] })];
    expect(completionEntries(changed)).toEqual([
      { taskId: 'was-daily', date: '2026-10-08', completedAt: null, instanceDate: '2026-10-08' },
    ]);
    expect(countCompletions(changed)).toBe(1);
    const doneToo = [{ ...changed[0], done: true, completed: '2026-10-11T09:00' }];
    expect(completionEntries(doneToo).map((e) => e.instanceDate)).toEqual([null, '2026-10-08']);
    expect(countCompletions(doneToo)).toBe(2);
  });
});
