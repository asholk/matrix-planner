import { describe, it, expect } from 'vitest';
import { buildDayItems } from '../../src/calendar/day-items';
import { layoutMonth, layoutMonthWeek, monthGridDates, monthGridRange } from '../../src/calendar/month-layout';
import { layoutTimeline } from '../../src/calendar/timeline-layout';
import { buildWeekStrip, shiftWeek, weekDates, weekRange } from '../../src/calendar/week-layout';
import { defaultMatrixConfig } from '../../src/model/defaults';
import type { DayItem, DayItemsInput, PlannerEvent, QuickNote, Task } from '../../src/model/types';

const matrix = defaultMatrixConfig('ru');

function event(id: string, start: string, end: string, over: Partial<PlannerEvent> = {}): PlannerEvent {
  const [sd, st] = start.split('T');
  const [ed, et] = end.split('T');
  const allDay = st === undefined;
  return {
    kind: 'event',
    id,
    path: `События/${id}.md`,
    title: id,
    mtime: 0,
    props: {} as PlannerEvent['props'],
    extra: {},
    issues: [],
    start: { date: sd, time: st ?? null },
    end: { date: ed, time: et ?? null },
    allDay,
    tz: null,
    repeat: 'none',
    color: 'blue',
    icon: null,
    calendarId: null,
    url: null,
    deletedInCalendar: false,
    ...over,
  };
}

function task(id: string, date: string, done = false): Task {
  return {
    kind: 'task',
    id,
    path: `Задачи/${id}.md`,
    title: id,
    mtime: 0,
    props: {} as Task['props'],
    extra: {},
    issues: [],
    quadrant: 'urgent',
    due: { date, time: null },
    repeat: 'none',
    repeatAnchor: date,
    remind: 'none',
    priority: 'normal',
    done,
    completed: null,
    completions: [],
    created: null,
    archived: false,
  };
}

function note(id: string, date: string): QuickNote {
  return { kind: 'note', id, path: `Заметки/${id}.md`, title: id, mtime: 0, props: {} as QuickNote['props'], extra: {}, issues: [], date };
}

function build(over: Partial<DayItemsInput>) {
  return buildDayItems({
    range: { from: '2026-09-28', to: '2026-11-08' },
    today: '2026-10-10',
    timeZone: 'UTC',
    tasks: [],
    events: [],
    notes: [],
    cache: { status: 'missing' },
    matrix,
    sources: { tasks: true, events: true, notes: true, external: true },
    visibleCalendars: { planner: true, birthdays: true, calendarIds: [] },
    includeCompleted: true,
    ...over,
  });
}

function timedItem(key: string, start: number, end: number): DayItem {
  return {
    key,
    source: 'note',
    noteId: key,
    date: '2026-10-10',
    title: key,
    allDay: false,
    startMinute: start,
    endMinute: end,
    continuesFromPrevious: false,
    continuesToNext: false,
    color: '#000',
    icon: null,
  };
}

describe('week-layout', () => {
  it('неделя с понедельника и с воскресенья', () => {
    expect(weekDates('2026-10-10', 1)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    expect(weekRange('2026-10-10', 0)).toEqual({ from: '2026-10-04', to: '2026-10-10' });
    expect(shiftWeek('2026-10-10', -1)).toBe('2026-10-03');
  });

  it('точки, серая точка заметок, галочка выполненных, сегодня и выбранный день', () => {
    const days = build({
      events: [event('e', '2026-10-06T10:00', '2026-10-06T11:00', { color: 'red' })],
      tasks: [task('t', '2026-10-06'), task('done', '2026-10-07', true)],
      notes: [note('n', '2026-10-08')],
    });
    const strip = buildWeekStrip({ selected: '2026-10-07', today: '2026-10-10', weekStart: 1, days });
    expect(strip).toHaveLength(7);
    const tue = strip[1];
    expect(tue.summary.dots).toEqual([matrix.byKey.urgent.color, '#FF3B30']);
    expect(strip[2]).toMatchObject({ isSelected: true, summary: { hasCompletedTasks: true, dots: [] } });
    expect(strip[3].summary).toMatchObject({ hasNotes: true, dots: [], count: 0 });
    expect(strip[5]).toMatchObject({ date: '2026-10-10', isToday: true, dayOfMonth: 10, weekday: 6 });
  });
});

describe('timeline-layout', () => {
  it('неперекрывающиеся элементы — одна колонка', () => {
    const blocks = layoutTimeline([timedItem('a', 540, 600), timedItem('b', 600, 660)]);
    expect(blocks.map((b) => [b.item.key, b.column, b.columns])).toEqual([
      ['a', 0, 1],
      ['b', 0, 1],
    ]);
  });

  it('перекрывающиеся интервалы делятся на колонки, освободившаяся колонка переиспользуется', () => {
    const blocks = layoutTimeline([timedItem('a', 540, 660), timedItem('b', 570, 600), timedItem('c', 600, 630), timedItem('d', 720, 780)]);
    const byKey = Object.fromEntries(blocks.map((b) => [b.item.key, b]));
    expect(byKey.a).toMatchObject({ column: 0, columns: 2 });
    expect(byKey.b).toMatchObject({ column: 1, columns: 2 });
    expect(byKey.c).toMatchObject({ column: 1, columns: 2 });
    expect(byKey.d).toMatchObject({ column: 0, columns: 1 });
  });

  it('три одновременных события — три колонки; нулевая длительность растягивается до минимума', () => {
    const blocks = layoutTimeline([timedItem('a', 600, 600), timedItem('b', 600, 660), timedItem('c', 605, 620)]);
    expect(blocks.every((b) => b.columns === 3)).toBe(true);
    expect(blocks.find((b) => b.item.key === 'a')).toMatchObject({ startMinute: 600, endMinute: 615 });
  });

  it('элемент в конце суток не выходит за 1440, элементы без времени пропускаются', () => {
    const late = timedItem('late', 1435, 1440);
    const noTime = { ...timedItem('x', 0, 0), startMinute: null, endMinute: null };
    const blocks = layoutTimeline([late, noTime]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startMinute: 1425, endMinute: 1440 });
  });
});

describe('month-layout', () => {
  it('сетка месяца 4–6 недель', () => {
    // Февраль 2027 начинается в понедельник: ровно 4 недели.
    expect(monthGridDates(2027, 2, 1)).toHaveLength(4);
    // Октябрь 2026 (1-е — четверг) с понедельника: 5 недель.
    expect(monthGridDates(2026, 10, 1)).toHaveLength(5);
    // Август 2026 (1-е — суббота) с понедельника: 6 недель.
    expect(monthGridDates(2026, 8, 1)).toHaveLength(6);
    expect(monthGridRange(2026, 10, 1)).toEqual({ from: '2026-09-28', to: '2026-11-01' });
    expect(monthGridRange(2026, 10, 0)).toEqual({ from: '2026-09-27', to: '2026-10-31' });
  });

  it('«+N» при переполнении дня', () => {
    const days = build({
      events: ['a', 'b', 'c', 'd', 'e'].map((id, i) => event(id, `2026-10-14T1${i}:00`, `2026-10-14T1${i}:30`)),
    });
    const layout = layoutMonth({ year: 2026, month: 10, weekStart: 1, days, today: '2026-10-10', maxBars: 3 });
    const week = layout.weeks.find((w) => w.dates.includes('2026-10-14'))!;
    const cell = week.cells.find((c) => c.date === '2026-10-14')!;
    expect(cell.more).toBe(3);
    expect(week.bars.filter((b) => b.startCol === 2).map((b) => b.item.title)).toEqual(['a', 'b']);
  });

  it('без переполнения «+N» нет; заметки — флаг, а не плашка; дни вне месяца отмечены', () => {
    const days = build({
      events: ['a', 'b', 'c'].map((id, i) => event(id, `2026-10-14T1${i}:00`, `2026-10-14T1${i}:30`)),
      notes: [note('n', '2026-10-14')],
    });
    const layout = layoutMonth({ year: 2026, month: 10, weekStart: 1, days, maxBars: 3 });
    const week = layout.weeks.find((w) => w.dates.includes('2026-10-14'))!;
    const cell = week.cells.find((c) => c.date === '2026-10-14')!;
    expect(cell).toMatchObject({ more: 0, hasNotes: true });
    expect(week.bars).toHaveLength(3);
    expect(layout.weeks[0].cells[0]).toMatchObject({ date: '2026-09-28', inMonth: false });
  });

  it('многодневное событие — одна плашка в неделе, перенос на следующую неделю', () => {
    // 10–13 окт. включительно (all-day, end исключительный 14-е); неделя с понедельника: 10–11 и 12–13.
    const days = build({ events: [event('trip', '2026-10-10', '2026-10-14')] });
    const layout = layoutMonth({ year: 2026, month: 10, weekStart: 1, days });
    const first = layout.weeks.find((w) => w.dates.includes('2026-10-10'))!;
    const second = layout.weeks.find((w) => w.dates.includes('2026-10-12'))!;
    expect(first.bars).toEqual([expect.objectContaining({ startCol: 5, span: 2, lane: 0, continuesBefore: false, continuesAfter: true })]);
    expect(second.bars).toEqual([expect.objectContaining({ startCol: 0, span: 2, lane: 0, continuesBefore: true, continuesAfter: false })]);
  });

  it('плашки многодневных событий занимают одну дорожку во всех днях', () => {
    const days = build({
      events: [event('long', '2026-10-12', '2026-10-15'), event('single', '2026-10-13T09:00', '2026-10-13T10:00')],
    });
    const week = layoutMonthWeek(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'], days, { maxBars: 3 });
    expect(week.bars.find((b) => b.item.title === 'long')).toMatchObject({ lane: 0, span: 3 });
    expect(week.bars.find((b) => b.item.title === 'single')).toMatchObject({ lane: 1, startCol: 1, span: 1 });
  });
});
