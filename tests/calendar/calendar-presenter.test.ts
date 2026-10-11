import { describe, it, expect } from 'vitest';
import { metaParts } from '../../src/calendar/day-list';
import { setLanguageOverride } from '../../src/i18n';
import '../../src/calendar/calendar-tab';
import {
  buildDayList,
  buildRow,
  buildWeekCells,
  colorCss,
  dayHeading,
  initialScrollMinute,
  itemAction,
  minuteLabel,
  monthYearTitle,
  noticeKeyFor,
  taskToggleRequest,
  timelineGeometry,
  type CalendarLabelStrings,
} from '../../src/calendar/calendar-state';
import { EVENT_COLOR_CSS, NOTE_DOT_COLOR } from '../../src/calendar/day-items';
import type {
  CalendarCacheState,
  CalendarSourceFilter,
  DayAgenda,
  EventDayItem,
  ExternalDayItem,
  NoteDayItem,
  TaskDayItem,
} from '../../src/model/types';

const TODAY = '2026-10-10';

const STRINGS: CalendarLabelStrings = {
  language: 'ru',
  hour12: false,
  today: 'Сегодня',
  tomorrow: 'Завтра',
  yesterday: 'Вчера',
  am: 'AM',
  pm: 'PM',
};

const ALL_SOURCES: CalendarSourceFilter = { tasks: true, events: true, notes: true, external: true };

function task(over: Partial<TaskDayItem> = {}): TaskDayItem {
  const date = over.date ?? TODAY;
  return {
    key: `task:T1:${date}@${date}`,
    source: 'task',
    date,
    title: 'Танцы',
    allDay: false,
    startMinute: 13 * 60 + 31,
    endMinute: 14 * 60 + 1,
    continuesFromPrevious: false,
    continuesToNext: false,
    color: '#E5484D',
    icon: null,
    taskId: 'T1',
    quadrant: 'do',
    priority: 'normal',
    duration: null,
    instanceDate: date,
    projected: false,
    recurring: false,
    completed: false,
    overdue: false,
    ...over,
  };
}

function event(over: Partial<EventDayItem> = {}): EventDayItem {
  const date = over.date ?? TODAY;
  return {
    key: `event:E1:${date}T09:00@${date}`,
    source: 'event',
    date,
    title: 'Концерт',
    allDay: false,
    startMinute: 9 * 60,
    endMinute: 10 * 60,
    continuesFromPrevious: false,
    continuesToNext: false,
    color: EVENT_COLOR_CSS.blue,
    icon: 'star',
    eventId: 'E1',
    calendarId: null,
    recurring: false,
    occurrenceStart: { date, time: '09:00' },
    ...over,
  };
}

function external(over: Partial<ExternalDayItem> = {}): ExternalDayItem {
  const date = over.date ?? TODAY;
  return {
    key: `external:X1@${date}@${date}`,
    source: 'external',
    date,
    title: 'Др Лёли',
    allDay: true,
    startMinute: null,
    endMinute: null,
    continuesFromPrevious: false,
    continuesToNext: false,
    color: '#34C7FF',
    icon: null,
    calendarId: 'birthdays',
    occurrenceKey: 'X1@2026-10-10',
    eventId: 'X1',
    readOnly: true,
    ...over,
  };
}

function note(over: Partial<NoteDayItem> = {}): NoteDayItem {
  const date = over.date ?? TODAY;
  return {
    key: `note:N1@${date}`,
    source: 'note',
    date,
    title: 'Идеи',
    allDay: false,
    startMinute: null,
    endMinute: null,
    continuesFromPrevious: false,
    continuesToNext: false,
    color: NOTE_DOT_COLOR,
    icon: null,
    noteId: 'N1',
    ...over,
  };
}

function agenda(date: string, parts: Partial<DayAgenda> = {}): DayAgenda {
  return { date, allDay: [], timed: [], notes: [], coverage: 'covered', ...parts };
}

function okCache(from = '2026-09-10', to = '2027-04-08'): CalendarCacheState {
  return {
    status: 'ok',
    stale: false,
    data: { version: 1, generatedAt: '2026-10-10T08:00:00Z', deviceName: null, range: { from, to }, calendars: [], events: [] },
  };
}

describe('лента недели: точки, галочка, заметки', () => {
  it('до трёх разных цветных точек, галочка выполненных и серая точка заметок', () => {
    const day = agenda('2026-10-09', {
      allDay: [task({ date: '2026-10-09', key: 'a', color: '#111111' }), task({ date: '2026-10-09', key: 'done', completed: true })],
      timed: [
        event({ date: '2026-10-09', key: 'b', color: EVENT_COLOR_CSS.red }),
        event({ date: '2026-10-09', key: 'c', color: EVENT_COLOR_CSS.green }),
        event({ date: '2026-10-09', key: 'd', color: EVENT_COLOR_CSS.purple }),
      ],
      notes: [note({ date: '2026-10-09' })],
    });
    const cells = buildWeekCells({ selected: TODAY, today: TODAY, weekStart: 1, days: new Map([[day.date, day]]), language: 'ru' });
    expect(cells).toHaveLength(7);
    const friday = cells.find((cell) => cell.date === '2026-10-09');
    expect(friday?.dots).toEqual(['#111111', 'var(--mp-event-red)', 'var(--mp-event-green)']);
    expect(friday?.hasCompleted).toBe(true);
    expect(friday?.hasNotes).toBe(true);
  });

  it('сегодня и выбранный день отмечены; день без данных — без точек', () => {
    const cells = buildWeekCells({ selected: '2026-10-07', today: TODAY, weekStart: 1, days: new Map(), language: 'ru' });
    expect(cells.map((cell) => cell.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    expect(cells.find((cell) => cell.isToday)?.date).toBe(TODAY);
    expect(cells.find((cell) => cell.isSelected)?.date).toBe('2026-10-07');
    expect(cells.every((cell) => cell.dots.length === 0 && !cell.hasNotes && !cell.hasCompleted)).toBe(true);
    expect(cells[0].dayOfMonth).toBe(5);
  });

  it('цвет палитры события становится переменной темы, прочие цвета остаются', () => {
    expect(colorCss(EVENT_COLOR_CSS.teal)).toBe('var(--mp-event-teal)');
    expect(colorCss(EVENT_COLOR_CSS.blue.toLowerCase())).toBe('var(--mp-event-blue)');
    expect(colorCss('#123456')).toBe('#123456');
  });
});

describe('список дня: заголовок и блоки', () => {
  it('«Сегодня 10 октября», число элементов и порядок блоков', () => {
    const model = buildDayList({
      agenda: agenda(TODAY, { allDay: [external()], timed: [event(), task()], notes: [note()] }),
      date: TODAY,
      today: TODAY,
      strings: STRINGS,
      sources: ALL_SOURCES,
      cache: okCache(),
    });
    expect(model.heading).toEqual({ title: 'Сегодня', date: '10 октября' });
    expect(model.count).toBe(4);
    expect(model.allDay.map((row) => row.source)).toEqual(['external']);
    expect(model.timed.map((row) => row.source)).toEqual(['event', 'task']);
    expect(model.notes.map((row) => row.source)).toEqual(['note']);
    expect(model.empty).toBe(false);
    expect(model.noticeKey).toBeNull();
  });

  it('другой день — день недели строчными', () => {
    expect(dayHeading('2026-10-21', TODAY, STRINGS)).toEqual({ title: 'среда', date: '21 октября' });
    expect(dayHeading('2026-10-11', TODAY, STRINGS).title).toBe('Завтра');
    expect(dayHeading('2026-10-21', TODAY, { ...STRINGS, language: 'en' })).toEqual({ title: 'Wednesday', date: 'October 21' });
  });

  it('заголовок месяца без «г.»', () => {
    expect(monthYearTitle('ru', 2026, 10)).toBe('Октябрь 2026');
    expect(monthYearTitle('en', 2026, 10)).toBe('October 2026');
  });

  it('время слева, диапазон события, формат 12 ч и конец суток', () => {
    expect(buildRow(task(), STRINGS).timeLabel).toBe('13:31');
    expect(buildRow(task(), STRINGS).rangeLabel).toBeNull();
    expect(buildRow(event(), STRINGS).rangeLabel).toBe('09:00–10:00');
    expect(buildRow(event(), { ...STRINGS, hour12: true }).rangeLabel).toBe('9:00 AM–10:00 AM');
    expect(minuteLabel(1440, STRINGS)).toBe('24:00');
    const allDay = buildRow(external(), STRINGS);
    expect(allDay.timeLabel).toBeNull();
    expect(allDay.readOnly).toBe(true);
  });

  it('цвет события — переменная `--mp-event-<цвет>`', () => {
    expect(buildRow(event({ color: EVENT_COLOR_CSS.orange }), STRINGS).color).toBe('var(--mp-event-orange)');
    expect(buildRow(task(), STRINGS).color).toBe('#E5484D');
  });
});

describe('пустой день отдельно от покрытия кэша', () => {
  const base = { date: TODAY, today: TODAY, strings: STRINGS, sources: ALL_SOURCES };

  it('покрытый пустой день — только «Здесь пока ничего нет»', () => {
    const model = buildDayList({ ...base, agenda: agenda(TODAY), cache: okCache() });
    expect(model.empty).toBe(true);
    expect(model.noticeKey).toBeNull();
  });

  it('день вне диапазона кэша — сообщение о загрузке вместо пустого дня', () => {
    const model = buildDayList({ ...base, agenda: agenda(TODAY, { coverage: 'out-of-range' }), cache: okCache('2026-11-01', '2027-01-01') });
    expect(model.noticeKey).toBe('cache.notice.outOfRange');
    expect(model.empty).toBe(false);
  });

  it('вне диапазона, но есть локальные элементы — сообщение и элементы', () => {
    const model = buildDayList({ ...base, agenda: agenda(TODAY, { coverage: 'out-of-range', timed: [task()] }), cache: okCache('2026-11-01', '2027-01-01') });
    expect(model.noticeKey).toBe('cache.notice.outOfRange');
    expect(model.timed).toHaveLength(1);
    expect(model.empty).toBe(false);
  });

  it('без кэша — «Подключите компаньон» и пустой день одновременно', () => {
    const model = buildDayList({ ...base, agenda: agenda(TODAY, { coverage: 'no-cache' }), cache: { status: 'missing' } });
    expect(model.noticeKey).toBe('cache.notice.noCache');
    expect(model.empty).toBe(true);
  });

  it('повреждённый кэш и новая версия различаются', () => {
    expect(noticeKeyFor('no-cache', ALL_SOURCES, { status: 'corrupt', detail: 'x' })).toBe('cache.notice.corrupt');
    expect(noticeKeyFor('no-cache', ALL_SOURCES, { status: 'unsupported-version', version: 9 })).toBe('cache.notice.unsupportedVersion');
  });

  it('без состояния кэша используется ключ покрытия модели', () => {
    expect(noticeKeyFor('out-of-range', ALL_SOURCES, null)).toBe('calendar-model.coverage.outOfRange');
    expect(noticeKeyFor('covered', ALL_SOURCES, null)).toBeNull();
  });

  it('источник «Календарь iOS» скрыт — сообщения о покрытии нет, пустой день показывается', () => {
    const sources = { ...ALL_SOURCES, external: false };
    const model = buildDayList({ ...base, sources, agenda: agenda(TODAY, { coverage: 'out-of-range' }), cache: okCache('2026-11-01', '2027-01-01') });
    expect(model.noticeKey).toBeNull();
    expect(model.empty).toBe(true);
  });

  it('нет данных дня — пустая повестка с покрытием из состояния кэша', () => {
    const model = buildDayList({ ...base, agenda: undefined, cache: okCache('2026-11-01', '2027-01-01') });
    expect(model.coverage).toBe('out-of-range');
    expect(model.empty).toBe(false);
  });
});

describe('нажатие на элемент и выполнение', () => {
  it('задача → форма задачи, событие-заметка → форма события, внешнее → просмотр, заметка → заметка', () => {
    expect(itemAction(task())).toEqual({ kind: 'task', taskId: 'T1' });
    expect(itemAction(event())).toEqual({ kind: 'event', eventId: 'E1' });
    expect(itemAction(external())).toEqual({ kind: 'external', occurrenceKey: 'X1@2026-10-10' });
    expect(itemAction(note())).toEqual({ kind: 'note', noteId: 'N1' });
  });

  it('кружок: повторяющейся задаче передаётся дата повторения, обычной — нет', () => {
    expect(taskToggleRequest(task())).toEqual({ op: 'complete', taskId: 'T1', instanceDate: undefined });
    expect(taskToggleRequest(task({ recurring: true, instanceDate: '2026-10-17', projected: true }))).toEqual({
      op: 'complete',
      taskId: 'T1',
      instanceDate: '2026-10-17',
    });
    expect(taskToggleRequest(task({ completed: true })).op).toBe('uncomplete');
  });

  it('кружок есть только у задач', () => {
    expect(buildRow(task(), STRINGS).checkable).toBe(true);
    expect(buildRow(event(), STRINGS).checkable).toBe(false);
    expect(buildRow(note(), STRINGS).checkable).toBe(false);
  });

  it('у вычисленного будущего повторения кружка нет — выполняется только текущее', () => {
    expect(buildRow(task({ recurring: true, instanceDate: '2026-10-17', date: '2026-10-17', projected: true }), STRINGS).checkable).toBe(false);
    expect(buildRow(task({ recurring: true, projected: false }), STRINGS).checkable).toBe(true);
  });
});

describe('временная шкала', () => {
  it('положение блока в процентах суток и колонки', () => {
    expect(timelineGeometry({ startMinute: 720, endMinute: 780, column: 1, columns: 2 })).toEqual({ top: 50, height: (60 / 1440) * 100, left: 50, width: 50 });
  });

  it('начальная прокрутка: сейчас, иначе первое событие, иначе 8:00', () => {
    expect(initialScrollMinute([{ startMinute: 600 }], 780)).toBe(750);
    expect(initialScrollMinute([{ startMinute: 600 }, { startMinute: 540 }], null)).toBe(510);
    expect(initialScrollMinute([], null)).toBe(450);
  });
});

describe('подпись строки списка дня (референс LockDay)', () => {
  const ctx = {
    quadrantTitle: () => 'Важно и срочно',
    quadrantIcon: () => 'flame',
    calendarTitle: (row: { source: string; calendarId: string | null }) =>
      row.calendarId === 'C1' ? 'Calendar' : row.source === 'task' || row.source === 'event' ? 'Планировщик' : null,
  };

  it('задача: значок и название квадранта · календарь «Планировщик»', () => {
    setLanguageOverride('ru');
    expect(metaParts(buildRow(task(), STRINGS), ctx)).toEqual([
      { text: 'Важно и срочно', icon: 'flame' },
      { text: 'Планировщик', icon: 'calendar' },
    ]);
    setLanguageOverride(null);
  });

  it('задача с длительностью: время диапазоном перед квадрантом', () => {
    const row = buildRow(task({ startMinute: 18 * 60, endMinute: 19 * 60 + 30, duration: 90 }), STRINGS);
    expect(row.timeLabel).toBe('18:00');
    expect(row.rangeLabel).toBe('18:00–19:30');
    expect(metaParts(row, ctx)).toEqual([
      { text: '18:00–19:30', icon: 'clock' },
      { text: 'Важно и срочно', icon: 'flame' },
      { text: 'Планировщик', icon: 'calendar' },
    ]);
  });

  it('событие: значок календаря и время · название календаря', () => {
    expect(metaParts(buildRow(event({ calendarId: 'C1' }), STRINGS), ctx)).toEqual([
      { text: '09:00–10:00', icon: 'calendar' },
      { text: 'Calendar', icon: null },
    ]);
  });

  it('событие на весь день без времени: значок у названия календаря', () => {
    expect(metaParts(buildRow(event({ allDay: true, startMinute: null, endMinute: null }), STRINGS), ctx)).toEqual([
      { text: 'Планировщик', icon: 'calendar' },
    ]);
  });
});
