import { describe, it, expect, vi } from 'vitest';
import {
  buildDayItems,
  cacheCoverageFor,
  coverageMessageKey,
  EVENT_COLOR_CSS,
  NOTE_DOT_COLOR,
  PlannerDayItemsProvider,
  summarizeDay,
  wallpaperFilters,
} from '../../src/calendar/day-items';
import { defaultMatrixConfig } from '../../src/model/defaults';
import type {
  CachedCalendar,
  CachedCalendarEvent,
  CalendarCacheState,
  DayAgenda,
  DayItem,
  DayItemsInput,
  PlannerEvent,
  PlannerSettings,
  QuickNote,
  Task,
} from '../../src/model/types';

const matrix = defaultMatrixConfig('ru');

function task(over: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    kind: 'task',
    path: `Задачи/${over.id}.md`,
    title: over.id,
    mtime: 0,
    props: {} as Task['props'],
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
    created: null,
    archived: false,
    ...over,
  };
}

function event(over: Partial<PlannerEvent> & Pick<PlannerEvent, 'id' | 'start' | 'end'>): PlannerEvent {
  return {
    kind: 'event',
    path: `События/${over.id}.md`,
    title: over.id,
    mtime: 0,
    props: {} as PlannerEvent['props'],
    extra: {},
    issues: [],
    allDay: false,
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

function note(id: string, date: string | null): QuickNote {
  return { kind: 'note', id, path: `Заметки/${id}.md`, title: id, mtime: 0, props: {} as QuickNote['props'], extra: {}, issues: [], date };
}

const work: CachedCalendar = { calendarId: 'work', title: 'Работа', color: '#112233', kind: 'caldav', allowsModifications: true };
const bdays: CachedCalendar = { calendarId: 'bd', title: 'Дни рождения', color: '#445566', kind: 'birthdays', allowsModifications: false };

function cached(over: Partial<CachedCalendarEvent> & Pick<CachedCalendarEvent, 'occurrenceKey' | 'start' | 'end'>): CachedCalendarEvent {
  return {
    eventId: over.occurrenceKey.split('|')[0],
    calendarId: 'work',
    title: over.occurrenceKey,
    allDay: false,
    startMs: null,
    endMs: null,
    recurrenceText: null,
    linkedItemId: null,
    location: null,
    url: null,
    notes: null,
    ...over,
  };
}

function cacheState(events: CachedCalendarEvent[], over: { from?: string; to?: string; generatedAt?: string } = {}): CalendarCacheState {
  return {
    status: 'ok',
    stale: false,
    data: {
      version: 1,
      generatedAt: over.generatedAt ?? '2026-10-10T10:00:00Z',
      deviceName: 'iPhone',
      range: { from: over.from ?? '2026-09-10', to: over.to ?? '2027-04-08' },
      calendars: [work, bdays],
      events,
    },
  };
}

function input(over: Partial<DayItemsInput> = {}): DayItemsInput {
  return {
    range: { from: '2026-10-10', to: '2026-10-16' },
    today: '2026-10-10',
    timeZone: 'Europe/Moscow',
    tasks: [],
    events: [],
    notes: [],
    cache: { status: 'missing' },
    matrix,
    sources: { tasks: true, events: true, notes: true, external: true },
    visibleCalendars: { planner: true, birthdays: true, calendarIds: ['work'] },
    includeCompleted: true,
    ...over,
  };
}

function all(agenda: DayAgenda | undefined): DayItem[] {
  return agenda ? [...agenda.allDay, ...agenda.timed, ...agenda.notes] : [];
}

describe('buildDayItems: структура', () => {
  it('содержит все дни диапазона, включая пустые', () => {
    const days = buildDayItems(input());
    expect([...days.keys()]).toEqual(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
    expect(all(days.get('2026-10-12'))).toEqual([]);
  });

  it('порядок блоков: «Весь день», по времени, «Заметки»', () => {
    const days = buildDayItems(
      input({
        tasks: [task({ id: 'noTime', due: { date: '2026-10-10', time: null } }), task({ id: 'at9', due: { date: '2026-10-10', time: '09:00' } })],
        events: [event({ id: 'ev8', start: { date: '2026-10-10', time: '08:00' }, end: { date: '2026-10-10', time: '08:30' } })],
        notes: [note('n1', '2026-10-10')],
      }),
    );
    const day = days.get('2026-10-10')!;
    expect(day.allDay.map((i) => i.title)).toEqual(['noTime']);
    expect(day.timed.map((i) => i.title)).toEqual(['ev8', 'at9']);
    expect(day.notes.map((i) => i.title)).toEqual(['n1']);
    expect(day.notes[0].color).toBe(NOTE_DOT_COLOR);
  });

  it('фильтр источников отключает задачи, события, заметки и внешние', () => {
    const days = buildDayItems(
      input({
        sources: { tasks: false, events: false, notes: false, external: false },
        tasks: [task({ id: 't', due: { date: '2026-10-10', time: null } })],
        events: [event({ id: 'e', start: { date: '2026-10-10', time: '08:00' }, end: { date: '2026-10-10', time: '09:00' } })],
        notes: [note('n', '2026-10-10')],
        cache: cacheState([cached({ occurrenceKey: 'x|1', start: { date: '2026-10-10', time: '10:00' }, end: { date: '2026-10-10', time: '11:00' } })]),
      }),
    );
    expect(all(days.get('2026-10-10'))).toEqual([]);
  });
});

describe('buildDayItems: задачи', () => {
  it('повторяющаяся задача: текущий due и вычисленные будущие повторения', () => {
    const days = buildDayItems(
      input({ tasks: [task({ id: 'r', repeat: 'daily', repeatAnchor: '2026-10-01', due: { date: '2026-10-12', time: '07:30' } })] }),
    );
    expect(all(days.get('2026-10-11'))).toEqual([]);
    const current = days.get('2026-10-12')!.timed[0];
    expect(current).toMatchObject({ source: 'task', projected: false, recurring: true, instanceDate: '2026-10-12', startMinute: 450, endMinute: 480 });
    const next = days.get('2026-10-13')!.timed[0];
    expect(next).toMatchObject({ projected: true, instanceDate: '2026-10-13' });
  });

  it('выполненные повторения из completions показываются как выполненные; без includeCompleted — скрыты', () => {
    const t = task({ id: 'r', repeat: 'daily', repeatAnchor: '2026-10-01', due: { date: '2026-10-12', time: null }, completions: ['2026-10-10', '2026-10-11'] });
    const days = buildDayItems(input({ tasks: [t] }));
    expect(days.get('2026-10-10')!.allDay[0]).toMatchObject({ completed: true, overdue: false });
    expect(summarizeDay(days.get('2026-10-10')).hasCompletedTasks).toBe(true);
    const hidden = buildDayItems(input({ tasks: [t], includeCompleted: false }));
    expect(all(hidden.get('2026-10-10'))).toEqual([]);
    expect(all(hidden.get('2026-10-12'))).toHaveLength(1);
  });

  it('просроченная задача отмечена overdue, цвет — цвет квадранта', () => {
    const days = buildDayItems(
      input({ range: { from: '2026-10-09', to: '2026-10-10' }, tasks: [task({ id: 'late', quadrant: 'plan', due: { date: '2026-10-09', time: null } })] }),
    );
    const item = days.get('2026-10-09')!.allDay[0];
    expect(item).toMatchObject({ overdue: true, color: matrix.byKey.plan.color });
  });

  it('выполненная обычная задача: completed, в сводке — галочка, а не точка', () => {
    const days = buildDayItems(input({ tasks: [task({ id: 'done', done: true, due: { date: '2026-10-10', time: null } })] }));
    const summary = summarizeDay(days.get('2026-10-10'));
    expect(summary).toMatchObject({ hasCompletedTasks: true, dots: [], count: 1 });
  });

  it('задача без срока не попадает в календарь', () => {
    const days = buildDayItems(input({ tasks: [task({ id: 'nodue' })] }));
    expect([...days.values()].every((d) => all(d).length === 0)).toBe(true);
  });
});

describe('buildDayItems: события', () => {
  it('all-day с невключаемым end: событие на 1 день', () => {
    const days = buildDayItems(
      input({ events: [event({ id: 'a', allDay: true, start: { date: '2026-10-11', time: null }, end: { date: '2026-10-12', time: null } })] }),
    );
    expect(days.get('2026-10-11')!.allDay).toHaveLength(1);
    expect(all(days.get('2026-10-12'))).toEqual([]);
  });

  it('многодневное событие со временем: части по дням, промежуточный день — «Весь день»', () => {
    const days = buildDayItems(
      input({ events: [event({ id: 'trip', color: 'green', start: { date: '2026-10-11', time: '20:00' }, end: { date: '2026-10-13', time: '10:00' } })] }),
    );
    expect(days.get('2026-10-11')!.timed[0]).toMatchObject({ startMinute: 1200, endMinute: 1440, continuesToNext: true, continuesFromPrevious: false });
    expect(days.get('2026-10-12')!.allDay[0]).toMatchObject({ allDay: true, continuesFromPrevious: true, continuesToNext: true });
    expect(days.get('2026-10-13')!.timed[0]).toMatchObject({ startMinute: 0, endMinute: 600, continuesFromPrevious: true, continuesToNext: false });
    expect(days.get('2026-10-11')!.timed[0].color).toBe(EVENT_COLOR_CSS.green);
  });

  it('еженедельное событие, начатое до диапазона', () => {
    const days = buildDayItems(
      input({ events: [event({ id: 'w', repeat: 'weekly', start: { date: '2026-09-01', time: '10:00' }, end: { date: '2026-09-01', time: '11:00' } })] }),
    );
    expect(days.get('2026-10-13')!.timed[0]).toMatchObject({
      source: 'event',
      recurring: true,
      occurrenceStart: { date: '2026-10-13', time: '10:00' },
    });
  });

  it('событие с tz переводится в зону устройства', () => {
    const days = buildDayItems(
      input({
        timeZone: 'Europe/Moscow',
        events: [event({ id: 'ny', tz: 'America/New_York', start: { date: '2026-10-12', time: '09:00' }, end: { date: '2026-10-12', time: '10:00' } })],
      }),
    );
    // Нью-Йорк EDT (UTC−4) 09:00 = 13:00 UTC = 16:00 Москва (UTC+3).
    expect(days.get('2026-10-12')!.timed[0]).toMatchObject({ startMinute: 960, endMinute: 1020 });
  });

  it('событие, удалённое в «Календаре» iOS, и скрытый календарь не показываются', () => {
    const days = buildDayItems(
      input({
        visibleCalendars: { planner: false, birthdays: true, calendarIds: ['work'] },
        events: [
          event({ id: 'del', deletedInCalendar: true, calendarId: 'work', start: { date: '2026-10-10', time: '10:00' }, end: { date: '2026-10-10', time: '11:00' } }),
          event({ id: 'planner', start: { date: '2026-10-10', time: '10:00' }, end: { date: '2026-10-10', time: '11:00' } }),
          event({ id: 'work', calendarId: 'work', start: { date: '2026-10-10', time: '12:00' }, end: { date: '2026-10-10', time: '13:00' } }),
        ],
      }),
    );
    expect(all(days.get('2026-10-10')).map((i) => i.title)).toEqual(['work']);
  });
});

describe('buildDayItems: кэш календаря', () => {
  it('событие кэша, связанное с заметкой-событием, не дублируется', () => {
    const ev = event({ id: 'E1', start: { date: '2026-10-10', time: '10:00' }, end: { date: '2026-10-10', time: '11:00' } });
    const days = buildDayItems(
      input({
        events: [ev],
        cache: cacheState([
          cached({ occurrenceKey: 'ek|1', linkedItemId: 'E1', start: { date: '2026-10-10', time: '10:00' }, end: { date: '2026-10-10', time: '11:00' } }),
          cached({ occurrenceKey: 'other|1', start: { date: '2026-10-10', time: '12:00' }, end: { date: '2026-10-10', time: '13:00' } }),
        ]),
      }),
    );
    const items = all(days.get('2026-10-10'));
    expect(items.map((i) => i.source)).toEqual(['event', 'external']);
    expect(items[1]).toMatchObject({ color: work.color, readOnly: false });
  });

  it('копия задачи в календаре «Планировщик» скрыта, ссылка на неизвестную заметку — показывается', () => {
    const days = buildDayItems(
      input({
        tasks: [task({ id: 'T1', due: { date: '2026-10-10', time: null } })],
        cache: cacheState([
          cached({ occurrenceKey: 'tk|1', linkedItemId: 'T1', allDay: true, start: { date: '2026-10-10', time: null }, end: { date: '2026-10-11', time: null } }),
          cached({ occurrenceKey: 'gone|1', linkedItemId: 'UNKNOWN', start: { date: '2026-10-10', time: '09:00' }, end: { date: '2026-10-10', time: '10:00' } }),
        ]),
      }),
    );
    expect(all(days.get('2026-10-10')).map((i) => i.source).sort()).toEqual(['external', 'task']);
  });

  it('исключённое в iOS повторение серии не показывается внутри диапазона свежего кэша', () => {
    const ev = event({ id: 'S', mtime: Date.parse('2026-10-01T00:00:00Z'), repeat: 'daily', start: { date: '2026-10-01', time: '09:00' }, end: { date: '2026-10-01', time: '09:30' } });
    const linked = ['2026-10-10', '2026-10-12'].map((date) =>
      cached({ occurrenceKey: `s|${date}`, linkedItemId: 'S', start: { date, time: '09:00' }, end: { date, time: '09:30' } }),
    );
    // Изменённое в iOS повторение 13-го — на 15:00.
    linked.push(cached({ occurrenceKey: 's|2026-10-13', linkedItemId: 'S', start: { date: '2026-10-13', time: '15:00' }, end: { date: '2026-10-13', time: '16:00' } }));
    const days = buildDayItems(input({ events: [ev], cache: cacheState(linked, { to: '2026-10-13' }) }));
    expect(days.get('2026-10-10')!.timed).toHaveLength(1);
    expect(days.get('2026-10-11')!.timed).toHaveLength(0);
    expect(days.get('2026-10-13')!.timed[0]).toMatchObject({ source: 'event', startMinute: 900 });
    // За пределами кэша — вычисленные повторения.
    expect(days.get('2026-10-14')!.timed[0]).toMatchObject({ startMinute: 540 });
  });

  it('устаревший для заметки кэш не отменяет вычисленные повторения', () => {
    const ev = event({ id: 'S', mtime: Date.parse('2026-10-10T12:00:00Z'), repeat: 'daily', start: { date: '2026-10-01', time: '09:00' }, end: { date: '2026-10-01', time: '09:30' } });
    const linked = [cached({ occurrenceKey: 's|1', linkedItemId: 'S', start: { date: '2026-10-10', time: '08:00' }, end: { date: '2026-10-10', time: '08:30' } })];
    const days = buildDayItems(input({ events: [ev], cache: cacheState(linked) }));
    expect(days.get('2026-10-11')!.timed).toHaveLength(1);
    expect(days.get('2026-10-10')!.timed[0]).toMatchObject({ startMinute: 540 });
  });

  it('многодневное all-day событие кэша и дни рождения (только просмотр)', () => {
    const days = buildDayItems(
      input({
        cache: cacheState([
          cached({ occurrenceKey: 'vac|1', allDay: true, start: { date: '2026-10-09', time: null }, end: { date: '2026-10-12', time: null } }),
          cached({ occurrenceKey: 'bd|1', calendarId: 'bd', allDay: true, start: { date: '2026-10-10', time: null }, end: { date: '2026-10-11', time: null } }),
        ]),
      }),
    );
    const day10 = days.get('2026-10-10')!.allDay;
    expect(day10).toHaveLength(2);
    expect(day10.find((i) => i.key.includes('vac|1'))).toMatchObject({ continuesFromPrevious: true, continuesToNext: true });
    expect(day10.find((i) => i.key.includes('bd|1'))).toMatchObject({ readOnly: true, color: bdays.color });
    expect(days.get('2026-10-11')!.allDay).toHaveLength(1);
    expect(days.get('2026-10-12')!.allDay).toHaveLength(0);
  });

  it('календари вне «Показываемых» и дни рождения при выключенном флаге скрыты', () => {
    const days = buildDayItems(
      input({
        visibleCalendars: { planner: true, birthdays: false, calendarIds: [] },
        cache: cacheState([
          cached({ occurrenceKey: 'w|1', start: { date: '2026-10-10', time: '10:00' }, end: { date: '2026-10-10', time: '11:00' } }),
          cached({ occurrenceKey: 'bd|1', calendarId: 'bd', allDay: true, start: { date: '2026-10-10', time: null }, end: { date: '2026-10-11', time: null } }),
        ]),
      }),
    );
    expect(all(days.get('2026-10-10'))).toEqual([]);
  });

  it('покрытие: нет кэша → no-cache, вне диапазона → out-of-range', () => {
    expect(cacheCoverageFor({ status: 'missing' }, '2026-10-10')).toBe('no-cache');
    expect(cacheCoverageFor({ status: 'corrupt', detail: 'x' }, '2026-10-10')).toBe('no-cache');
    const state = cacheState([], { from: '2026-10-01', to: '2026-10-12' });
    expect(cacheCoverageFor(state, '2026-10-12')).toBe('covered');
    expect(cacheCoverageFor(state, '2026-10-13')).toBe('out-of-range');
    const days = buildDayItems(input({ cache: state }));
    expect(days.get('2026-10-12')!.coverage).toBe('covered');
    expect(days.get('2026-10-13')!.coverage).toBe('out-of-range');
    expect(coverageMessageKey('covered')).toBeNull();
    expect(coverageMessageKey('no-cache')).toBe('calendar-model.coverage.noCache');
  });
});

describe('summarizeDay', () => {
  it('до 3 разных цветов, заметки — серая точка, count без заметок', () => {
    const colors: PlannerEvent['color'][] = ['red', 'green', 'red', 'blue', 'purple'];
    const days = buildDayItems(
      input({
        events: colors.map((color, i) =>
          event({ id: `e${i}`, color, start: { date: '2026-10-10', time: `1${i}:00` }, end: { date: '2026-10-10', time: `1${i}:30` } }),
        ),
        notes: [note('n', '2026-10-10')],
      }),
    );
    const summary = summarizeDay(days.get('2026-10-10'));
    expect(summary.dots).toEqual([EVENT_COLOR_CSS.red, EVENT_COLOR_CSS.green, EVENT_COLOR_CSS.blue]);
    expect(summary).toMatchObject({ hasNotes: true, count: 5 });
  });

  it('пустая сводка для отсутствующего дня', () => {
    expect(summarizeDay(undefined, '2026-10-10')).toEqual({ date: '2026-10-10', dots: [], hasNotes: false, hasCompletedTasks: false, count: 0 });
  });
});

describe('PlannerDayItemsProvider', () => {
  function settings(): PlannerSettings {
    return {
      visibleCalendars: { planner: true, birthdays: true, calendarIds: ['work'] },
      wallpaper: { calendarIds: null },
      ui: { calendarSources: { tasks: true, events: true, notes: true, external: true } },
    } as unknown as PlannerSettings;
  }

  function setup(current: PlannerSettings = settings()) {
    const offs = { index: vi.fn(), settings: vi.fn(), cache: vi.fn() };
    const listeners: Array<() => void> = [];
    const build = vi.fn(buildDayItems);
    const provider = new PlannerDayItemsProvider({
      index: {
        getTasks: () => [],
        getEvents: () => [],
        getNotes: () => [note('n', '2026-10-10')],
        getMatrix: () => matrix,
        onChange: (l) => (listeners.push(() => l({ kind: 'upsert', paths: [], ids: [] })), offs.index),
      },
      settings: { get: () => current, onChange: (l) => (listeners.push(() => l(current, current)), offs.settings) },
      cache: { getState: () => ({ status: 'missing' }), onChange: (l) => (listeners.push(() => l({ status: 'missing' })), offs.cache) },
      clock: { now: () => new Date('2026-10-09T22:30:00Z'), timeZone: () => 'Europe/Moscow' },
      build,
    });
    return { provider, offs, listeners, build };
  }

  it('сегодня — в зоне устройства; для обоев заметки исключены', () => {
    const { provider, build } = setup();
    const days = provider.getDays({ from: '2026-10-10', to: '2026-10-10' });
    expect(build.mock.calls[0][0].today).toBe('2026-10-10');
    expect(days.get('2026-10-10')!.notes).toHaveLength(1);
    const wall = provider.getDays({ from: '2026-10-10', to: '2026-10-10' }, { forWallpaper: true });
    expect(wall.get('2026-10-10')!.notes).toHaveLength(0);
    expect(build.mock.calls[1][0].includeCompleted).toBe(false);
  });

  it('подписка на источники — с первым слушателем, отписка — с последним', () => {
    const { provider, offs, listeners } = setup();
    const listener = vi.fn();
    const off = provider.onChange(listener);
    expect(listeners).toHaveLength(3);
    listeners[0]();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    expect(offs.index).toHaveBeenCalledTimes(1);
    expect(offs.settings).toHaveBeenCalledTimes(1);
    expect(offs.cache).toHaveBeenCalledTimes(1);
  });

  it('wallpaperFilters: явный список календарей обоев заменяет «Показываемые»', () => {
    const s = settings();
    (s.wallpaper as { calendarIds: string[] | null }).calendarIds = ['bd'];
    expect(wallpaperFilters(s).visibleCalendars).toEqual({ planner: true, birthdays: false, calendarIds: ['bd'] });
    expect(wallpaperFilters(s).sources.notes).toBe(false);
  });
});

describe('финальные исправления', () => {
  it('кэшированное повторение, начавшееся до начала кэша и продолжающееся в нём, не теряется', () => {
    const ev = event({ id: 'N', mtime: Date.parse('2026-10-01T00:00:00Z'), repeat: 'daily', start: { date: '2026-10-01', time: '22:00' }, end: { date: '2026-10-02', time: '02:00' } });
    const linked = [
      // Повторение 9-го изменено в iOS: заканчивается в 03:00.
      cached({ occurrenceKey: 'n|09', linkedItemId: 'N', start: { date: '2026-10-09', time: '22:00' }, end: { date: '2026-10-10', time: '03:00' } }),
      cached({ occurrenceKey: 'n|10', linkedItemId: 'N', start: { date: '2026-10-10', time: '22:00' }, end: { date: '2026-10-11', time: '02:00' } }),
    ];
    const days = buildDayItems(input({ range: { from: '2026-10-10', to: '2026-10-10' }, events: [ev], cache: cacheState(linked, { from: '2026-10-10', to: '2026-10-12' }) }));
    const timed = days.get('2026-10-10')!.timed;
    expect(timed.map((i) => [i.startMinute, i.endMinute])).toEqual([
      [0, 180],
      [1320, 1440],
    ]);
  });

  it('изменённое в iOS повторение берёт название из кэша, цвет и значок — заметки', () => {
    const ev = event({ id: 'S', title: 'Йога', color: 'green', icon: 'star', mtime: Date.parse('2026-10-01T00:00:00Z'), repeat: 'daily', start: { date: '2026-10-01', time: '09:00' }, end: { date: '2026-10-01', time: '09:30' } });
    const linked = [
      cached({ occurrenceKey: 's|10', linkedItemId: 'S', title: 'Йога в парке', start: { date: '2026-10-10', time: '15:00' }, end: { date: '2026-10-10', time: '16:00' } }),
    ];
    const days = buildDayItems(input({ range: { from: '2026-10-10', to: '2026-10-10' }, events: [ev], cache: cacheState(linked, { to: '2026-10-10' }) }));
    expect(days.get('2026-10-10')!.timed[0]).toMatchObject({ source: 'event', title: 'Йога в парке', color: EVENT_COLOR_CSS.green, icon: 'star', startMinute: 900 });
  });

  it('событие с концом 9999-12-31 не разворачивается по всем дням', () => {
    const ev = event({ id: 'L', allDay: true, start: { date: '2026-01-01', time: null }, end: { date: '9999-12-31', time: null } });
    const ext = cached({ occurrenceKey: 'l|1', allDay: true, start: { date: '2026-01-01', time: null }, end: { date: '9999-12-31', time: null } });
    const started = Date.now();
    const days = buildDayItems(input({ events: [ev], cache: cacheState([ext]) }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(days.get('2026-10-10')!.allDay.map((i) => [i.source, i.continuesFromPrevious, i.continuesToNext])).toEqual([
      ['event', true, true],
      ['external', true, true],
    ]);
  });

  describe('PlannerDayItemsProvider: метки удаления', () => {
    const linkedEvent = cached({ occurrenceKey: 'ek|1', linkedItemId: 'GONE', start: { date: '2026-10-10', time: '10:00' }, end: { date: '2026-10-10', time: '11:00' } });
    const cache = cacheState([linkedEvent]);

    function make(tombstoneIds: string[]) {
      let ids = tombstoneIds;
      const tombstoneListeners: Array<() => void> = [];
      const provider = new PlannerDayItemsProvider({
        index: { getTasks: () => [], getEvents: () => [], getNotes: () => [], getMatrix: () => matrix, onChange: () => () => {} },
        settings: {
          get: () =>
            ({
              visibleCalendars: { planner: true, birthdays: true, calendarIds: ['work'] },
              wallpaper: { calendarIds: null },
              ui: { calendarSources: { tasks: true, events: true, notes: true, external: true } },
            }) as unknown as PlannerSettings,
          onChange: () => () => {},
        },
        cache: { getState: () => cache, onChange: () => () => {} },
        clock: { now: () => new Date('2026-10-10T08:00:00Z'), timeZone: () => 'Europe/Moscow' },
        tombstones: {
          list: async () => ({ ok: true as const, value: ids.map((id) => ({ id, kind: 'event' as const, deletedAt: '2026-10-10T07:00:00Z' })), changed: false }),
          onChange: (l) => {
            tombstoneListeners.push(l);
            return () => {};
          },
        },
      });
      return {
        provider,
        setIds: (next: string[]) => {
          ids = next;
          for (const l of tombstoneListeners) l();
        },
      };
    }

    const day = (provider: PlannerDayItemsProvider) => all(provider.getDays({ from: '2026-10-10', to: '2026-10-10' }).get('2026-10-10'));

    it('запись кэша, связанная с удалённой заметкой, не возвращается как внешнее событие', async () => {
      const { provider } = make(['GONE']);
      await provider.refreshTombstones();
      expect(day(provider)).toHaveLength(0);
    });

    it('без метки запись остаётся внешней; новая метка — оповещение и скрытие', async () => {
      const { provider, setIds } = make([]);
      const listener = vi.fn();
      provider.onChange(listener);
      await provider.refreshTombstones();
      expect(day(provider).map((i) => i.source)).toEqual(['external']);
      setIds(['GONE']);
      await vi.waitFor(() => expect(listener).toHaveBeenCalled());
      expect(day(provider)).toHaveLength(0);
    });

    it('prepare() загружает метки до первого снимка (обои)', async () => {
      const { provider } = make(['GONE']);
      await provider.prepare();
      expect(day(provider)).toHaveLength(0);
    });
  });

  it('метка со строчным ULID скрывает событие кэша с прописным ID', async () => {
    const ulid = '01JA7Q3K8Z6Y2V5N4M0C1B2D3E';
    const ext = cached({ occurrenceKey: 'ek|2', linkedItemId: ulid, start: { date: '2026-10-10', time: '10:00' }, end: { date: '2026-10-10', time: '11:00' } });
    const provider = new PlannerDayItemsProvider({
      index: { getTasks: () => [], getEvents: () => [], getNotes: () => [], getMatrix: () => matrix, onChange: () => () => {} },
      settings: {
        get: () =>
          ({
            visibleCalendars: { planner: true, birthdays: true, calendarIds: ['work'] },
            wallpaper: { calendarIds: null },
            ui: { calendarSources: { tasks: true, events: true, notes: true, external: true } },
          }) as unknown as PlannerSettings,
        onChange: () => () => {},
      },
      cache: { getState: () => cacheState([ext]), onChange: () => () => {} },
      clock: { now: () => new Date('2026-10-10T08:00:00Z'), timeZone: () => 'Europe/Moscow' },
      tombstones: {
        list: () => ({ ok: true as const, value: [{ id: ulid.toLowerCase(), kind: 'event' as const, deletedAt: '2026-10-10T07:00:00Z' }], changed: false }),
      },
    });
    await provider.prepare();
    expect(all(provider.getDays({ from: '2026-10-10', to: '2026-10-10' }).get('2026-10-10'))).toHaveLength(0);
  });
});
