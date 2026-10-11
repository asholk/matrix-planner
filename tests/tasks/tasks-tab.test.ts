import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, MockElement, resetMockState } from '../__mocks__/obsidian';
import type { Clock, NoteIndex, PlannerViewHost, SettingsStore, TaskService } from '../../src/app/contracts';
import type { FloatingDateTime, OpResult, PlannerSettings, Task, TaskProperties } from '../../src/model/types';
import { defaultMatrixConfig } from '../../src/model/defaults';
import { parseFloating } from '../../src/model/dates';
import { setLanguageOverride } from '../../src/i18n';
import { sharedPendingDeletes } from '../../src/app/pending-deletes';
import { COMPLETE_ANIMATION_MS, TASKS_REFRESH_INTERVAL_MS, TasksTab } from '../../src/tasks/tasks-tab';

function at(value: string): FloatingDateTime {
  const parsed = parseFloating(value);
  if (!parsed) throw new Error(`bad date ${value}`);
  return parsed;
}

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

const OK: OpResult = { ok: true, value: undefined, changed: true };

interface SetupOptions {
  layout?: 'grid' | 'list';
  grouping?: 'quadrant' | 'date';
}

function setup(initial: Task[], opts: SetupOptions = {}) {
  let tasks = initial;
  let now = new Date(Date.UTC(2026, 9, 10, 9, 0));
  const clock: Clock = { now: () => now, timeZone: () => 'UTC' };
  const index = {
    isReady: () => true,
    whenReady: async () => {},
    getTasks: () => tasks,
    getById: (id: string) => tasks.find((task) => task.id === id),
    getMatrix: () => defaultMatrixConfig('ru'),
    onChange: () => () => {},
  } as unknown as NoteIndex;
  const complete = vi.fn(async (_id: string, _instanceDate?: string): Promise<OpResult> => OK);
  const uncomplete = vi.fn(async (_id: string, _instanceDate?: string): Promise<OpResult> => OK);
  const reschedule = vi.fn(async (_id: string, _date: string): Promise<OpResult> => OK);
  const update = vi.fn(async (): Promise<OpResult> => OK);
  const service = { complete, uncomplete, reschedule, update } as unknown as TaskService;
  const settings = {
    get: () => ({ ui: { tasksLayout: opts.layout ?? 'grid', tasksListGrouping: opts.grouping ?? 'quadrant' } }) as unknown as PlannerSettings,
    onChange: () => () => {},
  } as unknown as SettingsStore;
  const openTaskForm = vi.fn();
  const host = {
    actions: { isAvailable: () => true, openTaskForm, openAddMenu: () => {} },
    platform: { isAndroid: false, isMobile: false, isPhone: false, isTablet: false, isIos: false, isDesktop: true },
    setAddContext: () => {},
    getAddContext: () => ({ date: null, quadrant: null }),
    getActiveTab: () => 'tasks',
    switchTab: () => {},
    register: () => {},
  } as unknown as PlannerViewHost;
  const haptics: string[] = [];
  const actions: Array<{ message: string; label: string; run: () => void }> = [];
  const shown: string[] = [];
  const tab = new TasksTab(host, {
    index,
    tasks: service,
    settings,
    clock,
    format: { get: () => ({ language: 'ru', weekStart: 1, hour12: false }) },
    notifier: {
      show: (message: string) => shown.push(message),
      showAction: (message: string, action: { label: string; run: () => void }) => actions.push({ message, ...action }),
    },
    haptics: { play: (kind) => haptics.push(kind) },
  });
  const container = new MockElement();
  return {
    tab,
    container,
    complete,
    uncomplete,
    reschedule,
    haptics,
    actions,
    shown,
    openTaskForm,
    mount: () => tab.mount(container as unknown as HTMLElement),
    setTasks: (next: Task[]) => (tasks = next),
    setNow: (next: Date) => (now = next),
  };
}

function cardOf(container: MockElement, id: string): MockElement {
  const card = container.findAllByClass('mp-task-card').find((el) => el.getAttribute('data-task-id') === id);
  if (!card) throw new Error(`нет карточки ${id}`);
  return card;
}

function clickCheck(container: MockElement, id: string): void {
  const check = cardOf(container, id).findAllByClass('mp-task-check')[0];
  if (!check) throw new Error(`нет кружка у ${id}`);
  check.dispatch('click');
}

beforeEach(() => {
  resetMockState();
  setLanguageOverride('ru');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('document', undefined);
  setLanguageOverride(null);
});

describe('выполнение повторяющейся задачи', () => {
  it('выполняется показанное повторение, даже если срок сдвинулся во время анимации', async () => {
    const series = makeTask({ id: 'series', due: at('2026-10-10T08:00'), repeat: 'daily', repeatAnchor: '2026-10-01' });
    const ctx = setup([series]);
    ctx.mount();
    ctx.tab.onShow();
    clickCheck(ctx.container, 'series');
    // Другое устройство выполнило 10-е: срок уже 11-е.
    ctx.setTasks([{ ...series, due: at('2026-10-11T08:00'), completions: ['2026-10-10'] }]);
    await vi.advanceTimersByTimeAsync(COMPLETE_ANIMATION_MS);
    expect(ctx.complete).toHaveBeenCalledWith('series', '2026-10-10');
    ctx.tab.unmount();
  });

  it('разовая задача выполняется без даты повторения', async () => {
    const ctx = setup([makeTask({ id: 'single', due: at('2026-10-10T08:00') })]);
    ctx.mount();
    ctx.tab.onShow();
    clickCheck(ctx.container, 'single');
    await vi.advanceTimersByTimeAsync(COMPLETE_ANIMATION_MS);
    expect(ctx.complete).toHaveBeenCalledWith('single', undefined);
    ctx.tab.unmount();
  });
});

describe('обновление по времени', () => {
  it('срок наступил — карточка становится просроченной без внешних событий', async () => {
    const ctx = setup([makeTask({ id: 'soon', due: at('2026-10-10T09:30') })]);
    ctx.mount();
    ctx.tab.onShow();
    expect(cardOf(ctx.container, 'soon').hasClass('is-overdue')).toBe(false);
    ctx.setNow(new Date(Date.UTC(2026, 9, 10, 9, 31)));
    await vi.advanceTimersByTimeAsync(TASKS_REFRESH_INTERVAL_MS);
    // Отрисовка отложена на один тик.
    await vi.advanceTimersByTimeAsync(1);
    expect(cardOf(ctx.container, 'soon').hasClass('is-overdue')).toBe(true);
    ctx.tab.unmount();
  });

  it('таймер работает только пока вкладка показана и снимается при unmount', () => {
    const ctx = setup([]);
    ctx.mount();
    const base = vi.getTimerCount();
    ctx.tab.onShow();
    expect(vi.getTimerCount()).toBe(base + 1);
    ctx.tab.onHide();
    expect(vi.getTimerCount()).toBe(base);
    ctx.tab.onShow();
    ctx.tab.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('возврат из фона после полуночи сразу перерисовывает; обработчик снимается при unmount', async () => {
    let listeners: Array<() => void> = [];
    let visibility = 'visible';
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (_type: string, cb: () => void) => listeners.push(cb),
      removeEventListener: (_type: string, cb: () => void) => (listeners = listeners.filter((l) => l !== cb)),
    });
    const ctx = setup([makeTask({ id: 'tomorrow', due: at('2026-10-11') })]);
    ctx.mount();
    ctx.tab.onShow();
    expect(listeners).toHaveLength(1);
    const before = cardOf(ctx.container, 'tomorrow').findAllByClass('mp-task-due')[0]?.getText();

    visibility = 'hidden';
    for (const listener of listeners) listener();
    // В фоне таймер остановлен.
    expect(vi.getTimerCount()).toBe(0);

    ctx.setNow(new Date(Date.UTC(2026, 9, 11, 7, 0)));
    visibility = 'visible';
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    const after = cardOf(ctx.container, 'tomorrow').findAllByClass('mp-task-due')[0]?.getText();
    expect(after).not.toBe(before);
    expect(vi.getTimerCount()).toBe(1);

    ctx.tab.unmount();
    expect(listeners).toHaveLength(0);
  });
});

describe('выполнение с зачёркиванием (доработка 005, §1)', () => {
  it('карточка анимируется ~600 мс, запись — после анимации', async () => {
    const ctx = setup([makeTask({ id: 'cook' })]);
    ctx.mount();
    ctx.tab.onShow();
    clickCheck(ctx.container, 'cook');
    const card = cardOf(ctx.container, 'cook');
    expect(card.hasClass('is-completing')).toBe(true);
    expect(card.findAllByClass('mp-task-check')[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(COMPLETE_ANIMATION_MS).toBeGreaterThanOrEqual(500);
    expect(COMPLETE_ANIMATION_MS).toBeLessThanOrEqual(1000);
    await vi.advanceTimersByTimeAsync(COMPLETE_ANIMATION_MS - 1);
    expect(ctx.complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.complete).toHaveBeenCalledWith('cook', undefined);
    ctx.tab.unmount();
  });

  it('ошибка записи возвращает карточку в исходный вид', async () => {
    const ctx = setup([makeTask({ id: 'cook' })]);
    ctx.complete.mockResolvedValueOnce({ ok: false, error: { code: 'write-failed' } } as unknown as OpResult);
    ctx.mount();
    ctx.tab.onShow();
    clickCheck(ctx.container, 'cook');
    await vi.advanceTimersByTimeAsync(COMPLETE_ANIMATION_MS);
    expect(cardOf(ctx.container, 'cook').hasClass('is-completing')).toBe(false);
    ctx.tab.unmount();
  });

  it('название — строчный элемент внутри (линия зачёркивания по каждой строке)', () => {
    const ctx = setup([makeTask({ id: 'cook', title: 'Кулинария' })]);
    ctx.mount();
    const text = cardOf(ctx.container, 'cook').findAllByClass('mp-task-title-text')[0];
    expect(text?.getText()).toBe('Кулинария');
    ctx.tab.unmount();
  });
});

describe('маркер перетаскивания и меню (доработка 005, §4)', () => {
  it('маркера перетаскивания на карточке нет', () => {
    const ctx = setup([makeTask({ id: 'a' })]);
    ctx.mount();
    expect(cardOf(ctx.container, 'a').findAllByClass('mp-task-handle')).toHaveLength(0);
    ctx.tab.unmount();
  });

  it('contextmenu от пальца не открывает меню, правая кнопка мыши — открывает', () => {
    const ctx = setup([makeTask({ id: 'a' })]);
    ctx.mount();
    Menu.lastShown = null;
    const card = cardOf(ctx.container, 'a');
    card.dispatch('contextmenu', { type: 'contextmenu', pointerType: 'touch', clientX: 10, clientY: 10, preventDefault: () => {}, stopPropagation: () => {} });
    expect(Menu.lastShown).toBeNull();
    card.dispatch('contextmenu', { type: 'contextmenu', pointerType: 'mouse', clientX: 10, clientY: 10, preventDefault: () => {}, stopPropagation: () => {} });
    expect(Menu.lastShown).not.toBeNull();
    ctx.tab.unmount();
  });

  it('скрытая кнопка «Действия» для диктора открывает меню', () => {
    const ctx = setup([makeTask({ id: 'a' })]);
    ctx.mount();
    Menu.lastShown = null;
    cardOf(ctx.container, 'a').findAllByClass('mp-task-more')[0]?.dispatch('click');
    expect(Menu.lastShown).not.toBeNull();
    ctx.tab.unmount();
  });
});

describe('пустой квадрант (доработка 005, §5)', () => {
  it('«Нажмите, чтобы добавить» открывает форму новой задачи в этом квадранте', () => {
    const ctx = setup([makeTask({ id: 'a', quadrant: 'plan' })]);
    ctx.mount();
    const doQuadrant = ctx.container.findAllByClass('mp-quadrant').find((el) => el.getAttribute('data-quadrant') === 'do');
    const add = doQuadrant?.findAllByClass('mp-tasks-empty-add')[0];
    expect(add).toBeDefined();
    expect(add?.findAllByClass('mp-tasks-empty-label')[0]?.getText()).toBe('Нажмите, чтобы добавить');
    expect(add?.findAllByClass('mp-tasks-empty-icon')[0]?.getAttribute('data-icon')).toBe('circle-plus');
    add?.dispatch('click');
    expect(ctx.openTaskForm).toHaveBeenCalledWith({ mode: 'create', quadrant: 'do', date: null });
    // В квадранте с задачей подсказки нет.
    const plan = ctx.container.findAllByClass('mp-quadrant').find((el) => el.getAttribute('data-quadrant') === 'plan');
    expect(plan?.findAllByClass('mp-tasks-empty-add')).toHaveLength(0);
    ctx.tab.unmount();
  });

  it('в режиме «Выполнено» — прежний текст без кнопки', () => {
    const ctx = setup([]);
    ctx.mount();
    ctx.container.findAllByClass('mp-tasks-done-filter')[0]?.dispatch('click');
    expect(ctx.container.findAllByClass('mp-tasks-empty-add')).toHaveLength(0);
    expect(ctx.container.findAllByClass('mp-tasks-empty')[0]?.getText()).toContain('Здесь пока нет выполненных задач');
    ctx.tab.unmount();
  });
});

describe('«Вернуть» и отклик (доработка 006)', () => {
  it('выполнение кружком: отклик success сразу, уведомление «Задача выполнена · Вернуть» после записи', async () => {
    const series = makeTask({ id: 'series', due: at('2026-10-10T08:00'), repeat: 'daily', repeatAnchor: '2026-10-01' });
    const ctx = setup([series]);
    ctx.mount();
    ctx.tab.onShow();
    clickCheck(ctx.container, 'series');
    expect(ctx.haptics).toEqual(['success']);
    await vi.advanceTimersByTimeAsync(COMPLETE_ANIMATION_MS);
    expect(ctx.actions).toHaveLength(1);
    expect(ctx.actions[0]?.message).toBe('Задача выполнена');
    expect(ctx.actions[0]?.label).toBe('Вернуть');
    ctx.actions[0]?.run();
    await vi.advanceTimersByTimeAsync(0);
    // Возвращается именно выполненное повторение.
    expect(ctx.uncomplete).toHaveBeenCalledWith('series', '2026-10-10');
    expect(ctx.haptics).toEqual(['success', 'undo']);
    ctx.tab.unmount();
  });

  it('без изменений (уже выполнено) — уведомления нет; ошибка — отклик error', async () => {
    const ctx = setup([makeTask({ id: 'a' }), makeTask({ id: 'b' })]);
    ctx.complete.mockResolvedValueOnce({ ok: true, value: undefined, changed: false });
    ctx.complete.mockResolvedValueOnce({ ok: false, error: { code: 'write-failed' } });
    ctx.mount();
    ctx.tab.onShow();
    clickCheck(ctx.container, 'a');
    await vi.advanceTimersByTimeAsync(COMPLETE_ANIMATION_MS);
    clickCheck(ctx.container, 'b');
    await vi.advanceTimersByTimeAsync(COMPLETE_ANIMATION_MS);
    expect(ctx.actions).toHaveLength(0);
    expect(ctx.haptics).toEqual(['success', 'success', 'error']);
    expect(ctx.shown).toHaveLength(1);
    ctx.tab.unmount();
  });

  it('переключение «Выполнено» и «Сетка / Список» — отклик select', () => {
    const ctx = setup([makeTask({ id: 'a' })]);
    ctx.mount();
    ctx.container.findAllByClass('mp-tasks-done-filter')[0]?.dispatch('click');
    expect(ctx.haptics).toEqual(['select']);
    ctx.tab.unmount();
  });
});

describe('«Перенести всё на сегодня» (доработка 006, §7)', () => {
  it('кнопка в «Просрочено» переносит все просроченные с сохранением времени, одно уведомление и «Вернуть»', async () => {
    const ctx = setup(
      [
        makeTask({ id: 'late1', due: at('2026-10-08T10:30') }),
        makeTask({ id: 'late2', due: at('2026-10-09'), quadrant: 'plan' }),
        makeTask({ id: 'future', due: at('2026-10-12') }),
      ],
      { layout: 'list', grouping: 'date' },
    );
    ctx.mount();
    ctx.tab.onShow();
    const buttons = ctx.container.findAllByClass('mp-tasks-reschedule-all');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getText()).toBe('Перенести всё на сегодня');
    buttons[0]?.dispatch('click');
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.reschedule.mock.calls).toEqual([
      ['late1', '2026-10-10'],
      ['late2', '2026-10-10'],
    ]);
    expect(ctx.actions).toHaveLength(1);
    expect(ctx.actions[0]?.message).toBe('Перенесено 2');
    ctx.reschedule.mockClear();
    ctx.actions[0]?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.reschedule.mock.calls).toEqual([
      ['late1', '2026-10-08'],
      ['late2', '2026-10-09'],
    ]);
    expect(ctx.haptics).toEqual(['drop', 'undo']);
    ctx.tab.unmount();
  });

  it('в сетке и без просроченных кнопки нет', () => {
    const grid = setup([makeTask({ id: 'late', due: at('2026-10-08') })]);
    grid.mount();
    expect(grid.container.findAllByClass('mp-tasks-reschedule-all')).toHaveLength(0);
    grid.tab.unmount();
    const list = setup([makeTask({ id: 'ok', due: at('2026-10-12') })], { layout: 'list', grouping: 'date' });
    list.mount();
    expect(list.container.findAllByClass('mp-tasks-reschedule-all')).toHaveLength(0);
    list.tab.unmount();
  });

  it('в режиме «Список» карточки помечены для свайпа, в сетке — нет', () => {
    const list = setup([makeTask({ id: 'a' })], { layout: 'list', grouping: 'quadrant' });
    list.mount();
    expect(cardOf(list.container, 'a').hasClass('is-swipeable')).toBe(true);
    list.tab.unmount();
    const grid = setup([makeTask({ id: 'a' })]);
    grid.mount();
    expect(cardOf(grid.container, 'a').hasClass('is-swipeable')).toBe(false);
    grid.tab.unmount();
  });
});

describe('общая очередь удалений (удаление из формы)', () => {
  it('задача в очереди сразу скрыта, «Вернуть» — снова видна', async () => {
    const ctx = setup([makeTask({ id: 'a' }), makeTask({ id: 'b' })]);
    ctx.mount();
    ctx.tab.onShow();
    const queue = sharedPendingDeletes();
    queue.schedule('a', () => {}, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.container.findAllByClass('mp-task-card').map((el) => el.getAttribute('data-task-id'))).toEqual(['b']);
    queue.undo('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.container.findAllByClass('mp-task-card')).toHaveLength(2);
    ctx.tab.unmount();
  });
});
