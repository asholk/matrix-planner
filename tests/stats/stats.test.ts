import { describe, expect, it } from 'vitest';
import type { Task, TaskProperties } from '../../src/model/types';
import { localDateOf } from '../../src/model/dates';
import {
  buildStats,
  buildWeekSummary,
  completionRecords,
  computeStreak,
  formatCompletionMoment,
  formatDateRange,
  weekDates,
  type SummaryStrings,
} from '../../src/stats/stats';

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    kind: 'task',
    path: `Планировщик/Задачи/${overrides.id}.md`,
    title: overrides.id,
    mtime: 1,
    props: {} as TaskProperties,
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

function done(id: string, completed: string, extra: Partial<Task> = {}): Task {
  return task({ id, done: true, completed, ...extra });
}

describe('серия дней подряд', () => {
  it('считает дни подряд, заканчивая сегодня', () => {
    expect(computeStreak(['2026-10-11', '2026-10-10', '2026-10-09', '2026-10-07'], '2026-10-11')).toBe(3);
  });

  it('разрыв обрывает серию', () => {
    expect(computeStreak(['2026-10-11', '2026-10-09', '2026-10-08'], '2026-10-11')).toBe(1);
  });

  it('сегодня ничего не выполнено — серия до вчера включительно', () => {
    expect(computeStreak(['2026-10-10', '2026-10-09'], '2026-10-11')).toBe(2);
  });

  it('ни сегодня, ни вчера — серия 0', () => {
    expect(computeStreak(['2026-10-09'], '2026-10-11')).toBe(0);
    expect(computeStreak([], '2026-10-11')).toBe(0);
  });

  it('переход через месяц', () => {
    expect(computeStreak(['2026-10-01', '2026-09-30', '2026-09-29'], '2026-10-01')).toBe(3);
  });

  it('повторяющиеся задачи считаются по датам completions, архивные учитываются', () => {
    const tasks = [
      task({ id: 'daily', repeat: 'daily', completions: ['2026-10-09', '2026-10-10'] }),
      done('old', '2026-10-11T08:00', { archived: true }),
    ];
    expect(buildStats({ tasks, today: '2026-10-11', weekStart: 1 }).streak).toBe(3);
  });

  it('сутки — по зоне устройства: 23:30 по Москве — это ещё 10 октября', () => {
    // `completed` записан в локальном времени; «сегодня» берётся в зоне устройства.
    const todayMsk = localDateOf(new Date(Date.UTC(2026, 9, 10, 20, 30)), 'Europe/Moscow');
    expect(todayMsk).toBe('2026-10-10');
    expect(localDateOf(new Date(Date.UTC(2026, 9, 11, 2, 0)), 'America/New_York')).toBe('2026-10-10');
    const tasks = [done('a', '2026-10-10T23:30'), done('b', '2026-10-09T09:00')];
    expect(buildStats({ tasks, today: todayMsk, weekStart: 1 }).streak).toBe(2);
    // После полуночи по Москве (11-е, ничего не выполнено) серия ещё жива — до вчера.
    const afterMidnight = localDateOf(new Date(Date.UTC(2026, 9, 10, 21, 30)), 'Europe/Moscow');
    expect(afterMidnight).toBe('2026-10-11');
    expect(buildStats({ tasks, today: afterMidnight, weekStart: 1 }).streak).toBe(2);
  });
});

describe('неделя', () => {
  it('даты недели с понедельника и с воскресенья', () => {
    expect(weekDates('2026-10-11', 1)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    expect(weekDates('2026-10-11', 0)[0]).toBe('2026-10-11');
    expect(weekDates('2026-10-08', 0)[0]).toBe('2026-10-04');
  });

  it('выполнено с начала недели и 7 столбцов', () => {
    const tasks = [
      done('mon', '2026-10-05T10:00'),
      done('wed1', '2026-10-07T10:00', { quadrant: 'plan' }),
      done('wed2', '2026-10-07T11:00', { quadrant: 'urgent' }),
      done('prev', '2026-10-04T10:00'),
      task({ id: 'series', repeat: 'daily', completions: ['2026-10-09', '2026-10-03'], quadrant: 'someday' }),
    ];
    const model = buildStats({ tasks, today: '2026-10-09', weekStart: 1 });
    expect(model.weekCount).toBe(4);
    expect(model.week.map((day) => day.count)).toEqual([1, 0, 2, 0, 1, 0, 0]);
    expect(model.week.map((day) => day.future)).toEqual([false, false, false, false, false, true, true]);
    expect(model.week[4]?.today).toBe(true);
    expect(model.weekByQuadrant).toEqual({ do: 1, plan: 1, urgent: 1, someday: 1 });
  });

  it('неделя с воскресенья учитывает воскресенье', () => {
    const tasks = [done('sun', '2026-10-04T10:00'), done('mon', '2026-10-05T10:00')];
    expect(buildStats({ tasks, today: '2026-10-06', weekStart: 0 }).weekCount).toBe(2);
    expect(buildStats({ tasks, today: '2026-10-06', weekStart: 1 }).weekCount).toBe(1);
  });
});

describe('недавно выполненные', () => {
  it('сначала новые, не больше 20, с временем и архивом', () => {
    const tasks: Task[] = [];
    for (let i = 1; i <= 25; i++) tasks.push(done(`t${i}`, `2026-10-${String(i).padStart(2, '0')}T09:${String(i).padStart(2, '0')}`));
    tasks.push(done('arch', '2026-10-26T19:08', { archived: true }));
    const model = buildStats({ tasks, today: '2026-10-26', weekStart: 1 });
    expect(model.recent).toHaveLength(20);
    expect(model.recent[0]).toMatchObject({ taskId: 'arch', archived: true, date: '2026-10-26', time: '19:08' });
    expect(model.recent[1]?.taskId).toBe('t25');
  });

  it('повторяющаяся задача — запись на каждую дату без времени', () => {
    const records = completionRecords([task({ id: 'r', repeat: 'weekly', completions: ['2026-10-01', '2026-10-08'] })]);
    expect(records.map((record) => [record.key, record.date, record.time])).toEqual([
      ['r@2026-10-08', '2026-10-08', null],
      ['r@2026-10-01', '2026-10-01', null],
    ]);
  });

  it('подпись даты-времени', () => {
    expect(formatCompletionMoment('2026-10-10', '19:08', 'ru', false)).toBe('10 окт. 2026 г., 19:08');
    expect(formatCompletionMoment('2026-10-10', null, 'ru', false)).toBe('10 окт. 2026 г.');
    expect(formatCompletionMoment('2026-10-10', '19:08', 'en', true)).toBe('Oct 10, 2026, 7:08 PM');
  });
});

describe('итоги недели', () => {
  it('собирает текст из модели', () => {
    const tasks = [done('a', '2026-10-06T10:00'), done('b', '2026-10-07T10:00', { quadrant: 'plan' })];
    const model = buildStats({ tasks, today: '2026-10-07', weekStart: 1 });
    const strings: SummaryStrings = {
      header: (range, doneText, streak) => `Итоги недели ${range}: выполнено ${doneText}, серия ${streak}`,
      tasks: (count) => `${count} задачи`,
      days: (count) => `${count} дня`,
      quadrantsLabel: 'по квадрантам',
      daysLabel: 'по дням',
      quadrantTitle: (key) => key,
      weekday: (date) => date.slice(8),
      range: (from, to) => formatDateRange(from, to, 'ru'),
    };
    expect(buildWeekSummary(model, strings)).toBe(
      'Итоги недели 5–11 окт.: выполнено 2 задачи, серия 2 дня; по квадрантам: do — 1, plan — 1, urgent — 0, someday — 0; по дням: 05 0, 06 1, 07 1, 08 0, 09 0, 10 0, 11 0.',
    );
  });
});
