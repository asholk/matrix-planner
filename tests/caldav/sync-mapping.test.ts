import { describe, expect, it } from 'vitest';
import { COMPLETED_TASK_EVENT_MINUTES, TASK_EVENT_MINUTES, taskEventMinutes, taskToIcs } from '../../src/caldav/sync-mapping';
import type { Task } from '../../src/model/types';

const OPTIONS = { completedTasksToCalendar: true, reminderTimeForDateOnly: '09:00', deviceZone: 'Europe/Moscow' };

function task(over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: '01J00000000000000000000001',
    path: 'Задачи/Танцы.md',
    title: 'Танцы',
    mtime: 0,
    props: {} as Task['props'],
    extra: {},
    issues: [],
    quadrant: 'do',
    due: { date: '2026-10-12', time: '18:00' },
    repeat: 'none',
    repeatAnchor: '2026-10-12',
    remind: 'none',
    priority: 'normal',
    duration: null,
    done: false,
    completed: null,
    completions: [],
    created: null,
    archived: false,
    ...over,
  };
}

describe('задача → событие: длительность (DTEND)', () => {
  it('без длительности — 30 мин', () => {
    expect(TASK_EVENT_MINUTES).toBe(30);
    const event = taskToIcs(task(), OPTIONS)!;
    expect(event.start).toMatchObject({ date: '2026-10-12', time: '18:00', tzid: 'Europe/Moscow' });
    expect(event.end).toMatchObject({ date: '2026-10-12', time: '18:30', tzid: 'Europe/Moscow' });
  });

  it('с длительностью — начало + duration, в том числе через полночь', () => {
    expect(taskToIcs(task({ duration: 90 }), OPTIONS)!.end).toMatchObject({ date: '2026-10-12', time: '19:30' });
    const late = taskToIcs(task({ due: { date: '2026-10-12', time: '23:30' }, duration: 120 }), OPTIONS)!;
    expect(late.end).toMatchObject({ date: '2026-10-13', time: '01:30' });
    expect(taskEventMinutes({ duration: 45 })).toBe(45);
    expect(taskEventMinutes({ duration: null })).toBe(30);
  });

  it('повторяющаяся серия — та же длительность у каждого повторения', () => {
    const event = taskToIcs(task({ repeat: 'weekly', duration: 60 }), OPTIONS)!;
    expect(event.rrule?.freq).toBe('WEEKLY');
    expect(event.end).toMatchObject({ date: '2026-10-12', time: '19:00' });
  });

  it('без времени — весь день, длительность не влияет', () => {
    const event = taskToIcs(task({ due: { date: '2026-10-12', time: null }, duration: 90 }), OPTIONS)!;
    expect(event.allDay).toBe(true);
    expect(event.end).toMatchObject({ date: '2026-10-13' });
  });

  it('выполненная задача — по-прежнему 15 мин в момент выполнения', () => {
    const event = taskToIcs(task({ done: true, completed: '2026-10-12T20:00', duration: 90 }), OPTIONS)!;
    expect(COMPLETED_TASK_EVENT_MINUTES).toBe(15);
    expect(event.start).toMatchObject({ time: '20:00' });
    expect(event.end).toMatchObject({ time: '20:15' });
  });
});
