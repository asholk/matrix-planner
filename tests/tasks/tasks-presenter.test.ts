import { describe, expect, it } from 'vitest';
import {
  buildTaskMenu,
  buildTasksView,
  cardAriaLabel,
  countDone,
  errorMessageKey,
  greetingFor,
  quadrantColorOverrides,
  type CardLabelStrings,
  type TaskLabelFormat,
  type TasksViewInput,
} from '../../src/tasks/tasks-presenter';
import { buildMatrixConfig, defaultMatrixConfig, defaultQuadrants } from '../../src/model/defaults';
import { createDateLabelStrings, formatDueLabel, parseFloating } from '../../src/model/dates';
import type { FloatingDateTime, Task, TaskProperties } from '../../src/model/types';

function at(value: string): FloatingDateTime {
  const parsed = parseFloating(value);
  if (!parsed) throw new Error(`bad date ${value}`);
  return parsed;
}

const NOW = at('2026-10-10T13:30');

const RU_DATES: Record<string, string> = {
  'model.dates.today': 'Сегодня',
  'model.dates.tomorrow': 'Завтра',
  'model.dates.yesterday': 'Вчера',
  'model.dates.dayMonth': '{day} {month}',
  'model.dates.dayMonthYear': '{day} {month} {year}',
  'model.dates.dateTime': '{date} {time}',
  'model.dates.am': 'AM',
  'model.dates.pm': 'PM',
  'model.dates.monthsShort.m10': 'окт.',
};
const STRINGS = createDateLabelStrings((key) => RU_DATES[key] ?? key);

const FORMAT: TaskLabelFormat = {
  due: (due, today) => formatDueLabel(due, today, STRINGS),
  completed: (date, time) => (time ? `${date} ${time}` : date),
};

function makeTask(overrides: Partial<Task> & { id: string }): Task {
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

function input(tasks: Task[], overrides: Partial<TasksViewInput> = {}): TasksViewInput {
  return {
    tasks,
    matrix: defaultMatrixConfig('ru'),
    now: NOW,
    mode: 'active',
    layout: 'grid',
    grouping: 'quadrant',
    format: FORMAT,
    ...overrides,
  };
}

// Задачи из кадра 01.
const FRAME_TASKS: Task[] = [
  makeTask({ id: 'dance', title: 'Танцы', quadrant: 'do', due: at('2026-10-10T11:00') }),
  makeTask({ id: 'cook', title: 'Кулинария', quadrant: 'do', due: at('2026-10-11T12:30') }),
  makeTask({ id: 'dentist', title: 'Стоматолог Лукерья', quadrant: 'plan', due: at('2026-10-16T15:00'), priority: 'high' }),
  makeTask({ id: 'hrum', title: 'Хрум чудо-юдо', quadrant: 'urgent', due: at('2026-10-10T17:00'), priority: 'high' }),
  makeTask({ id: 'avito', title: 'Забрать Авито на почте', quadrant: 'urgent', created: '2026-10-02T10:00' }),
  makeTask({ id: 'doc', title: 'Оформить документ', quadrant: 'someday', priority: 'high', created: '2026-10-01T09:00' }),
  makeTask({ id: 'tax', title: 'Оплатить налоги', quadrant: 'someday', created: '2026-10-03T09:00' }),
];

describe('дата показанного повторения', () => {
  it('активная повторяющаяся карточка несёт дату срока, разовая — null', () => {
    const view = buildTasksView(
      input([
        makeTask({ id: 'series', quadrant: 'do', due: at('2026-10-10T08:00'), repeat: 'daily', repeatAnchor: '2026-10-01' }),
        makeTask({ id: 'single', quadrant: 'do', due: at('2026-10-10T09:00') }),
      ]),
    );
    const cards = view.quadrants[0]?.cards ?? [];
    expect(cards.find((c) => c.taskId === 'series')?.instanceDate).toBe('2026-10-10');
    expect(cards.find((c) => c.taskId === 'single')?.instanceDate).toBeNull();
  });
});

describe('приветствие', () => {
  it('утро, день, вечер', () => {
    expect(greetingFor(5)).toBe('morning');
    expect(greetingFor(11)).toBe('morning');
    expect(greetingFor(12)).toBe('afternoon');
    expect(greetingFor(17)).toBe('afternoon');
    expect(greetingFor(18)).toBe('evening');
    expect(greetingFor(23)).toBe('evening');
    expect(greetingFor(2)).toBe('evening');
  });
});

describe('группировка по квадрантам', () => {
  it('сетка кадра 01: счётчики и порядок', () => {
    const view = buildTasksView(input(FRAME_TASKS));
    expect(view.quadrants.map((q) => q.key)).toEqual(['do', 'plan', 'urgent', 'someday']);
    expect(view.quadrants.map((q) => q.count)).toEqual([2, 1, 2, 2]);
    expect(view.quadrants[0]?.cards.map((c) => c.title)).toEqual(['Танцы', 'Кулинария']);
    expect(view.quadrants[2]?.cards.map((c) => c.taskId)).toEqual(['hrum', 'avito']);
    expect(view.quadrants[3]?.cards.map((c) => c.taskId)).toEqual(['doc', 'tax']);
  });

  it('карточка: срок, просрочка, flag, repeat', () => {
    const view = buildTasksView(input(FRAME_TASKS));
    const dance = view.quadrants[0]?.cards[0];
    expect(dance?.dueLabel).toBe('Сегодня 11:00');
    expect(dance?.overdue).toBe(true);
    const cook = view.quadrants[0]?.cards[1];
    expect(cook?.dueLabel).toBe('Завтра 12:30');
    expect(cook?.overdue).toBe(false);
    const dentist = view.quadrants[1]?.cards[0];
    expect(dentist?.dueLabel).toBe('16 окт. 15:00');
    expect(dentist?.highPriority).toBe(true);
    expect(dentist?.recurring).toBe(false);
    expect(view.quadrants[3]?.cards[1]?.dueLabel).toBeNull();

    const repeating = buildTasksView(input([makeTask({ id: 'r', repeat: 'daily', due: at('2026-10-11') })]));
    expect(repeating.quadrants[0]?.cards[0]?.recurring).toBe(true);
  });

  it('пустые квадранты присутствуют', () => {
    const view = buildTasksView(input([makeTask({ id: 'a', quadrant: 'plan' })]));
    expect(view.quadrants).toHaveLength(4);
    expect(view.quadrants.filter((q) => q.count === 0).map((q) => q.key)).toEqual(['do', 'urgent', 'someday']);
    expect(view.empty).toBe(false);
    expect(buildTasksView(input([])).empty).toBe(true);
  });

  it('выполненные и архивные не попадают в активный режим', () => {
    const view = buildTasksView(
      input([
        makeTask({ id: 'a' }),
        makeTask({ id: 'b', done: true, completed: '2026-10-09T10:00' }),
        makeTask({ id: 'c', archived: true }),
      ]),
    );
    expect(view.quadrants[0]?.cards.map((c) => c.taskId)).toEqual(['a']);
  });

  it('названия, значки и цвета берутся из матрицы', () => {
    const quadrants = defaultQuadrants('ru').map((q) => (q.key === 'plan' ? { ...q, title: 'Учёба', icon: 'book', color: '#00AA55' } : q));
    const view = buildTasksView(input([], { matrix: buildMatrixConfig('Планировщик/Матрица.md', quadrants) }));
    expect(view.quadrants[1]).toMatchObject({ title: 'Учёба', icon: 'book', color: '#00AA55' });
  });
});

describe('списки', () => {
  it('по датам: просроченные, даты, без срока', () => {
    const view = buildTasksView(input(FRAME_TASKS, { layout: 'list', grouping: 'date' }));
    expect(view.dates.map((d) => d.kind)).toEqual(['overdue', 'date', 'date', 'date', 'no-date']);
    expect(view.dates[0]?.cards.map((c) => c.taskId)).toEqual(['dance']);
    expect(view.dates[1]).toMatchObject({ date: '2026-10-10' });
    expect(view.dates[1]?.cards.map((c) => c.taskId)).toEqual(['hrum']);
    expect(view.dates[2]?.date).toBe('2026-10-11');
    expect(view.dates[3]?.date).toBe('2026-10-16');
    expect(view.dates[4]?.cards.map((c) => c.taskId).sort()).toEqual(['avito', 'doc', 'tax']);
  });

  it('по квадрантам: группы как в сетке, даты не считаются', () => {
    const view = buildTasksView(input(FRAME_TASKS, { layout: 'list', grouping: 'quadrant' }));
    expect(view.quadrants.map((q) => q.count)).toEqual([2, 1, 2, 2]);
    expect(view.dates).toEqual([]);
  });
});

describe('«Выполнено»', () => {
  const doneTasks: Task[] = [
    makeTask({ id: 'single', quadrant: 'do', done: true, completed: '2026-10-10T13:31' }),
    makeTask({ id: 'old', quadrant: 'urgent', done: true, completed: '2026-10-08T23:29' }),
    makeTask({ id: 'series', quadrant: 'plan', repeat: 'daily', due: at('2026-10-11'), completions: ['2026-10-08', '2026-10-09', '2026-10-10'] }),
    makeTask({ id: 'archived', done: true, completed: '2026-09-01T10:00', archived: true }),
    makeTask({ id: 'open', quadrant: 'someday' }),
  ];

  it('число завершений серии: каждое повторение отдельно, архив не считается', () => {
    expect(countDone(doneTasks)).toBe(5);
    expect(buildTasksView(input(doneTasks)).doneCount).toBe(5);
  });

  it('карточки по квадрантам с датой выполнения, новые сверху', () => {
    const view = buildTasksView(input(doneTasks, { mode: 'done' }));
    expect(view.quadrants.map((q) => q.count)).toEqual([1, 3, 1, 0]);
    const single = view.quadrants[0]?.cards[0];
    expect(single).toMatchObject({ done: true, completedLabel: '2026-10-10 13:31', instanceDate: null, dueLabel: null });
    const series = view.quadrants[1]?.cards ?? [];
    expect(series.map((c) => c.instanceDate)).toEqual(['2026-10-10', '2026-10-09', '2026-10-08']);
    expect(new Set(series.map((c) => c.key)).size).toBe(3);
    expect(view.quadrants[3]?.cards).toEqual([]);
  });

  it('список по датам выполнения', () => {
    const view = buildTasksView(input(doneTasks, { mode: 'done', layout: 'list', grouping: 'date' }));
    expect(view.dates.map((d) => d.date)).toEqual(['2026-10-10', '2026-10-09', '2026-10-08']);
    expect(view.dates[0]?.cards.map((c) => c.taskId).sort()).toEqual(['series', 'single']);
  });

  it('пустой режим «Выполнено»', () => {
    const view = buildTasksView(input([makeTask({ id: 'a' })], { mode: 'done' }));
    expect(view.empty).toBe(true);
    expect(view.doneCount).toBe(0);
  });
});

describe('меню карточки', () => {
  const matrix = defaultMatrixConfig('ru');

  it('активная задача: открыть, перенос в 3 других квадранта, на завтра, удалить', () => {
    const items = buildTaskMenu({ quadrant: 'do', done: false }, matrix);
    expect(items.map((i) => i.action.kind)).toEqual(['open-note', 'move', 'move', 'move', 'postpone', 'delete']);
    const moves = items.filter((i) => i.action.kind === 'move').map((i) => (i.action.kind === 'move' ? i.action.quadrant : null));
    expect(moves).toEqual(['plan', 'urgent', 'someday']);
    expect(items[1]?.labelParams).toEqual({ quadrant: 'Важно' });
    expect(items.at(-1)?.warning).toBe(true);
  });

  it('выполненная задача: открыть, вернуть в работу, удалить', () => {
    const items = buildTaskMenu({ quadrant: 'plan', done: true }, matrix);
    expect(items.map((i) => i.action.kind)).toEqual(['open-note', 'uncomplete', 'delete']);
  });
});

describe('цвета матрицы', () => {
  it('переопределяются только изменённые корректные цвета', () => {
    const quadrants = defaultQuadrants('ru').map((q) => {
      if (q.key === 'do') return { ...q, color: '#E5484D' };
      if (q.key === 'plan') return { ...q, color: '#112233' };
      if (q.key === 'urgent') return { ...q, color: 'red; background: url(x)' };
      return q;
    });
    const vars = quadrantColorOverrides(buildMatrixConfig(null, quadrants));
    expect(Object.keys(vars).sort()).toEqual(['--mp-q-plan', '--mp-q-plan-bg']);
    expect(vars['--mp-q-plan']).toBe('#112233');
    expect(vars['--mp-q-plan-bg']).toContain('#112233');
  });

  it('матрица по умолчанию не переопределяет ничего', () => {
    expect(quadrantColorOverrides(defaultMatrixConfig('ru'))).toEqual({});
  });
});

describe('ошибки и подписи', () => {
  it('ключ ошибки: собственный или по коду', () => {
    expect(errorMessageKey({ code: 'read-only' })).toBe('common.errors.readOnly');
    expect(errorMessageKey({ code: 'stale', messageKey: 'tasks.custom' })).toBe('tasks.custom');
  });

  it('подпись диктора', () => {
    const strings: CardLabelStrings = {
      label: (title) => `Задача «${title}»`,
      quadrant: (q) => `квадрант «${q}»`,
      highPriority: 'высокий приоритет',
      repeat: 'повторяется',
      overdue: 'просрочена',
      noDue: 'без срока',
      notDone: 'не выполнена',
      done: 'выполнена',
    };
    const view = buildTasksView(input([makeTask({ id: 'x', title: 'Стоматолог', due: at('2026-10-11T09:00') })]));
    const card = view.quadrants[0]?.cards[0];
    if (!card) throw new Error('no card');
    expect(cardAriaLabel(card, 'Важно и срочно', strings)).toBe('Задача «Стоматолог», Завтра 09:00, квадрант «Важно и срочно», не выполнена');
  });
});
