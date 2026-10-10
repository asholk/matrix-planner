import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockElement, resetMockState } from '../__mocks__/obsidian';
import type { Clock, NoteIndex, PlannerViewHost, SettingsStore, TaskService } from '../../src/app/contracts';
import type { FloatingDateTime, OpResult, PlannerSettings, Task, TaskProperties } from '../../src/model/types';
import { defaultMatrixConfig } from '../../src/model/defaults';
import { parseFloating } from '../../src/model/dates';
import { setLanguageOverride } from '../../src/i18n';
import { TASKS_REFRESH_INTERVAL_MS, TasksTab } from '../../src/tasks/tasks-tab';

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

function setup(initial: Task[]) {
  let tasks = initial;
  let now = new Date(Date.UTC(2026, 9, 10, 9, 0));
  const clock: Clock = { now: () => now, timeZone: () => 'UTC' };
  const index = {
    isReady: () => true,
    whenReady: async () => {},
    getTasks: () => tasks,
    getMatrix: () => defaultMatrixConfig('ru'),
    onChange: () => () => {},
  } as unknown as NoteIndex;
  const complete = vi.fn(async (_id: string, _instanceDate?: string) => OK);
  const service = { complete, uncomplete: vi.fn(async () => OK) } as unknown as TaskService;
  const settings = {
    get: () => ({ ui: { tasksLayout: 'grid', tasksListGrouping: 'quadrant' } }) as unknown as PlannerSettings,
    onChange: () => () => {},
  } as unknown as SettingsStore;
  const host = {
    actions: { isAvailable: () => true, openTaskForm: () => {}, openAddMenu: () => {} },
    platform: { isAndroid: false, isMobile: false, isPhone: false, isTablet: false, isIos: false, isDesktop: true },
    setAddContext: () => {},
    getAddContext: () => ({ date: null, quadrant: null }),
    getActiveTab: () => 'tasks',
    switchTab: () => {},
    register: () => {},
  } as unknown as PlannerViewHost;
  const tab = new TasksTab(host, {
    index,
    tasks: service,
    settings,
    clock,
    format: { get: () => ({ language: 'ru', weekStart: 1, hour12: false }) },
    notifier: { show: () => {} },
  });
  const container = new MockElement();
  return {
    tab,
    container,
    complete,
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
    await vi.advanceTimersByTimeAsync(260);
    expect(ctx.complete).toHaveBeenCalledWith('series', '2026-10-10');
    ctx.tab.unmount();
  });

  it('разовая задача выполняется без даты повторения', async () => {
    const ctx = setup([makeTask({ id: 'single', due: at('2026-10-10T08:00') })]);
    ctx.mount();
    ctx.tab.onShow();
    clickCheck(ctx.container, 'single');
    await vi.advanceTimersByTimeAsync(260);
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
