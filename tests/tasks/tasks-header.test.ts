import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockElement, resetMockState } from '../__mocks__/obsidian';
import type { Clock, NoteIndex, PlannerViewHost, SettingsStore, TaskService } from '../../src/app/contracts';
import type { PlannerSettings, Task, TaskProperties } from '../../src/model/types';
import { defaultMatrixConfig } from '../../src/model/defaults';
import { createDefaultSettings } from '../../src/settings/defaults';
import { setLanguageOverride } from '../../src/i18n';
import { formatTodayTitle } from '../../src/tasks/tasks-presenter';
import { TasksTab } from '../../src/tasks/tasks-tab';
import type { WeatherProvider, WeatherState } from '../../src/weather/weather-types';

describe('заголовок шапки — сегодняшняя дата', () => {
  it('ru: день недели с заглавной, без года для текущего года', () => {
    expect(formatTodayTitle('2026-10-11', 'ru', 2026)).toBe('Воскресенье, 11 октября');
    expect(formatTodayTitle('2026-03-02', 'ru', 2026)).toBe('Понедельник, 2 марта');
  });

  it('en', () => {
    expect(formatTodayTitle('2026-10-11', 'en', 2026)).toBe('Sunday, October 11');
  });

  it('год — только если не текущий', () => {
    expect(formatTodayTitle('2027-01-01', 'ru', 2026)).toBe('Пятница, 1 января 2027 г.');
    expect(formatTodayTitle('2027-01-01', 'en', 2026)).toBe('Friday, January 1, 2027');
  });
});

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

function setup(options: { tasks?: Task[]; weather?: WeatherState; city?: string; language?: 'ru' | 'en' } = {}) {
  let now = new Date(Date.UTC(2026, 9, 11, 9, 0));
  const clock: Clock = { now: () => now, timeZone: () => 'UTC' };
  const tasks = options.tasks ?? [];
  const index = {
    isReady: () => true,
    whenReady: async () => {},
    getTasks: () => tasks,
    getMatrix: () => defaultMatrixConfig('ru'),
    onChange: () => () => {},
  } as unknown as NoteIndex;
  const settingsValue: PlannerSettings = createDefaultSettings();
  settingsValue.weather.city = options.city ?? '';
  const settings = { get: () => settingsValue, onChange: () => () => {} } as unknown as SettingsStore;
  const host = {
    actions: { isAvailable: () => true, openTaskForm: () => {}, openAddMenu: () => {} },
    platform: { isAndroid: false, isMobile: false, isPhone: false, isTablet: false, isIos: false, isDesktop: true },
    setAddContext: () => {},
    getAddContext: () => ({ date: null, quadrant: null }),
    getActiveTab: () => 'tasks',
    switchTab: () => {},
    register: () => {},
  } as unknown as PlannerViewHost;
  let state: WeatherState = options.weather ?? { kind: 'off' };
  const listeners = new Set<(state: WeatherState) => void>();
  const refresh = vi.fn(async () => state);
  const weather: WeatherProvider = {
    getState: () => state,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
  };
  const openStats = vi.fn();
  const tab = new TasksTab(host, {
    index,
    tasks: {} as TaskService,
    settings,
    clock,
    format: { get: () => ({ language: options.language ?? 'ru', weekStart: 1, hour12: false }) },
    notifier: { show: () => {} },
    weather,
    openStats,
  });
  const container = new MockElement();
  tab.mount(container as unknown as HTMLElement);
  return {
    tab,
    container,
    refresh,
    openStats,
    setNow: (value: Date) => (now = value),
    setWeather: (next: WeatherState) => {
      state = next;
      for (const listener of listeners) listener(next);
    },
    one: (cls: string) => {
      const el = container.findAllByClass(cls)[0];
      if (!el) throw new Error(`нет ${cls}`);
      return el;
    },
  };
}

const READY: WeatherState = {
  kind: 'ready',
  snapshot: { fetchedAt: 0, day: '2026-10-11', latitude: 55.75, longitude: 37.62, source: 'city', units: 'celsius', temperature: 11.2, code: 3, min: 7, max: 12 },
};

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

describe('шапка вкладки «Задачи»', () => {
  it('дата вместо приветствия и погода серой строкой', () => {
    const ctx = setup({ weather: READY });
    expect(ctx.one('mp-tasks-title').getText()).toBe('Воскресенье, 11 октября');
    const line = ctx.one('mp-tasks-weather');
    expect(line.getText()).toBe('☁️ +11°, облачно · ↓7° ↑12°');
    expect(line.hasClass('is-hidden')).toBe(false);
  });

  it('en: дата и описание погоды по-английски', () => {
    setLanguageOverride('en');
    const ctx = setup({ weather: READY, language: 'en' });
    expect(ctx.one('mp-tasks-title').getText()).toBe('Sunday, October 11');
    expect(ctx.one('mp-tasks-weather').getText()).toBe('☁️ +11°, cloudy · ↓7° ↑12°');
  });

  it('погода недоступна: без города строка скрыта, с городом — «Погода недоступна»', () => {
    expect(setup({ weather: { kind: 'error' } }).one('mp-tasks-weather').hasClass('is-hidden')).toBe(true);
    expect(setup({ weather: { kind: 'no-location' } }).one('mp-tasks-weather').hasClass('is-hidden')).toBe(true);
    const withCity = setup({ weather: { kind: 'error' }, city: 'Москва, Россия' }).one('mp-tasks-weather');
    expect(withCity.getText()).toBe('Погода недоступна');
    expect(withCity.hasClass('is-hidden')).toBe(false);
  });

  it('строка обновляется по событию сервиса погоды', () => {
    const ctx = setup({ weather: { kind: 'loading' } });
    expect(ctx.one('mp-tasks-weather').hasClass('is-hidden')).toBe(true);
    ctx.setWeather(READY);
    expect(ctx.one('mp-tasks-weather').getText()).toContain('+11°');
  });

  it('показ вкладки запрашивает погоду; смена суток меняет дату', async () => {
    const ctx = setup({ weather: READY });
    ctx.tab.onShow();
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    ctx.setNow(new Date(Date.UTC(2026, 9, 12, 0, 1)));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.one('mp-tasks-title').getText()).toBe('Понедельник, 12 октября');
    ctx.tab.unmount();
  });

  it('таблетка «🔥 N»: серия и открытие статистики', () => {
    const tasks = [
      makeTask({ id: 'a', done: true, completed: '2026-10-10T10:00' }),
      makeTask({ id: 'b', done: true, completed: '2026-10-09T10:00' }),
      makeTask({ id: 'r', repeat: 'daily', completions: ['2026-10-08'] }),
    ];
    const ctx = setup({ tasks });
    const pill = ctx.one('mp-tasks-streak');
    expect(ctx.one('mp-tasks-streak-count').getText()).toBe('3');
    expect(pill.getAttribute('aria-label')).toBe('Серия: 3 дня подряд. Открыть статистику');
    pill.dispatch('click');
    expect(ctx.openStats).toHaveBeenCalledTimes(1);
  });
});
