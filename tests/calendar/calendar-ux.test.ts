import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockElement } from '../__mocks__/obsidian';
import { setLanguageOverride } from '../../src/i18n';
import '../../src/calendar/calendar-tab';
import { buildDayList, hideItems, type CalendarLabelStrings } from '../../src/calendar/calendar-state';
import { renderDayStatus } from '../../src/calendar/day-list';
import { timelineMinuteAt } from '../../src/calendar/timeline-layout';
import { attachTimelineLongPress, TIMELINE_LONG_PRESS_MS } from '../../src/calendar/timeline-view';
import { SENT_FLASH_MS, SyncStatusLine, syncLineKind, type SyncLineStatus, type SyncStatusSource } from '../../src/calendar/sync-status-line';
import type { CalendarSourceFilter, DayAgenda, TaskDayItem } from '../../src/model/types';

const TODAY = '2026-10-10';
const STRINGS: CalendarLabelStrings = { language: 'ru', hour12: false, today: 'Сегодня', tomorrow: 'Завтра', yesterday: 'Вчера', am: 'AM', pm: 'PM' };
const ALL: CalendarSourceFilter = { tasks: true, events: true, notes: true, external: true };
const NO_TASKS: CalendarSourceFilter = { ...ALL, tasks: false };

function task(id: string): TaskDayItem {
  return {
    key: `task:${id}`,
    source: 'task',
    date: TODAY,
    title: id,
    allDay: false,
    startMinute: 600,
    endMinute: 630,
    continuesFromPrevious: false,
    continuesToNext: false,
    color: '#E5484D',
    icon: null,
    taskId: id,
    quadrant: 'do',
    priority: 'normal',
    duration: null,
    instanceDate: TODAY,
    projected: false,
    recurring: false,
    completed: false,
    overdue: false,
  };
}

function agenda(timed: TaskDayItem[] = []): DayAgenda {
  return { date: TODAY, allDay: [], timed, notes: [], coverage: 'covered' };
}

beforeEach(() => setLanguageOverride('ru'));
afterEach(() => {
  setLanguageOverride(null);
  vi.useRealTimers();
});

describe('пустой день при фильтре источников (006, §5)', () => {
  const build = (sources: CalendarSourceFilter, items: TaskDayItem[] = []) =>
    buildDayList({ agenda: agenda(items), date: TODAY, today: TODAY, strings: STRINGS, sources, cache: null });

  it('фильтр сужен и день пуст — filtered', () => {
    expect(build(NO_TASKS).filtered).toBe(true);
    expect(build(ALL).filtered).toBe(false);
    expect(build(NO_TASKS, [task('a')]).filtered).toBe(false);
  });

  it('«Нет элементов с выбранными фильтрами» и «Показать все»', () => {
    const parent = new MockElement();
    const showAll = vi.fn();
    renderDayStatus(parent as unknown as HTMLElement, build(NO_TASKS), { isMobile: true, showAllSources: showAll });
    const empty = parent.findAllByClass('mp-cal-empty-filtered')[0];
    expect(empty?.getText()).toContain('Нет элементов с выбранными фильтрами');
    const button = parent.findAllByClass('mp-cal-empty-action')[0];
    expect(button?.getText()).toBe('Показать все');
    button?.dispatch('click');
    expect(showAll).toHaveBeenCalledTimes(1);
  });

  it('без фильтров — прежний пустой день', () => {
    const parent = new MockElement();
    renderDayStatus(parent as unknown as HTMLElement, build(ALL), { isMobile: true, showAllSources: () => undefined });
    expect(parent.findAllByClass('mp-cal-empty-filtered')).toHaveLength(0);
    expect(parent.findAllByClass('mp-cal-empty')).toHaveLength(1);
  });
});

describe('скрытие элементов, ожидающих удаления (006, §12)', () => {
  it('убирает задачу по id, без совпадений возвращает тот же объект', () => {
    const days = new Map([[TODAY, agenda([task('a'), task('b')])]]);
    const hidden = hideItems(days, (id) => id === 'a');
    expect(hidden.get(TODAY)?.timed.map((item) => item.title)).toEqual(['b']);
    expect(hideItems(days, () => false)).toBe(days);
  });
});

describe('долгое нажатие на шкале (006, §13)', () => {
  it('минута: округление до 15 мин, не позже 23:45', () => {
    const hour = 60;
    expect(timelineMinuteAt(14 * hour + 7, 24 * hour)).toBe(14 * 60);
    expect(timelineMinuteAt(14 * hour + 8, 24 * hour)).toBe(14 * 60 + 15);
    expect(timelineMinuteAt(-20, 24 * hour)).toBe(0);
    expect(timelineMinuteAt(24 * hour, 24 * hour)).toBe(23 * 60 + 45);
    expect(timelineMinuteAt(10, 0)).toBe(0);
  });

  function setup() {
    vi.useFakeTimers();
    const scroller = new MockElement();
    const grid = scroller.createDiv();
    grid.getBoundingClientRect = () => ({ left: 0, top: 100, right: 300, bottom: 100 + 1440, width: 300, height: 1440, x: 0, y: 100 });
    const onLongPress = vi.fn();
    attachTimelineLongPress(scroller as unknown as HTMLElement, grid as unknown as HTMLElement, onLongPress);
    const down = (y: number, target: unknown = grid) => grid.dispatch('pointerdown', { button: 0, clientX: 10, clientY: y, target });
    return { scroller, grid, onLongPress, down };
  }

  it('удержание на пустом месте — минута начала', () => {
    const { onLongPress, down } = setup();
    down(100 + 9 * 60 + 55);
    vi.advanceTimersByTime(TIMELINE_LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledWith(10 * 60);
  });

  it('прокрутка, сдвиг пальца и отпускание отменяют', () => {
    const { scroller, grid, onLongPress, down } = setup();
    down(400);
    scroller.dispatch('scroll');
    vi.advanceTimersByTime(TIMELINE_LONG_PRESS_MS);
    down(400);
    grid.dispatch('pointermove', { clientX: 10, clientY: 420 });
    vi.advanceTimersByTime(TIMELINE_LONG_PRESS_MS);
    down(400);
    grid.dispatch('pointerup', {});
    vi.advanceTimersByTime(TIMELINE_LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('нажатие на блок элемента не создаёт событие', () => {
    const { onLongPress, down } = setup();
    down(400, { closest: (selector: string) => (selector === '.mp-cal-timeline-block' ? {} : null) });
    vi.advanceTimersByTime(TIMELINE_LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});

describe('строка статуса синхронизации (006, §7)', () => {
  const status = (over: Partial<SyncLineStatus> = {}): SyncLineStatus => ({ running: false, pushing: false, error: null, lastPushAt: null, ...over });

  it('что показать', () => {
    const base = { enabled: true, retrying: false, sentFlash: false };
    expect(syncLineKind({ ...base, status: status() })).toBeNull();
    expect(syncLineKind({ ...base, enabled: false, status: status({ pushing: true }) })).toBeNull();
    expect(syncLineKind({ ...base, status: status({ pushing: true }) })).toBe('sending');
    expect(syncLineKind({ ...base, status: status({ error: { kind: 'network' } }) })).toBe('offline');
    expect(syncLineKind({ ...base, status: status({ error: { kind: 'auth' } }) })).toBe('auth');
    expect(syncLineKind({ ...base, status: status({ error: { kind: 'server' } }) })).toBeNull();
    expect(syncLineKind({ ...base, sentFlash: true, status: status() })).toBe('sent');
    expect(syncLineKind({ ...base, retrying: true, status: status({ running: true, error: { kind: 'network' } }) })).toBe('sending');
  });

  function source(initial: SyncLineStatus) {
    let current = initial;
    const listeners = new Set<(s: SyncLineStatus) => void>();
    let retryResult = Promise.resolve(true);
    const retry = vi.fn(() => retryResult);
    const src: SyncStatusSource = {
      getStatus: () => current,
      onStatusChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isEnabled: () => true,
      provider: () => 'icloud',
      retry,
    };
    const emit = (next: SyncLineStatus) => {
      current = next;
      for (const listener of listeners) listener(next);
    };
    return { src, emit, retry, setRetry: (p: Promise<boolean>) => (retryResult = p) };
  }

  it('«Отправка…» → «Отправлено в «Календарь» iOS» на 3 с → скрыта', () => {
    vi.useFakeTimers();
    const { src, emit } = source(status());
    const el = new MockElement();
    const line = new SyncStatusLine({ source: src, openSettings: () => undefined });
    line.mount(el as unknown as HTMLElement);
    expect((el as unknown as { hidden: boolean }).hidden).toBe(true);
    emit(status({ pushing: true }));
    expect(el.getText()).toContain('Отправка…');
    emit(status({ pushing: false, lastPushAt: '2026-10-10T10:00:00Z' }));
    expect(el.getText()).toContain('Отправлено в «Календарь» iOS');
    vi.advanceTimersByTime(SENT_FLASH_MS);
    expect(line.kind()).toBeNull();
    expect((el as unknown as { hidden: boolean }).hidden).toBe(true);
  });

  it('нет связи — «Повторить» запускает синхронизацию, успех — «Отправлено…»', async () => {
    vi.useFakeTimers();
    const { src, emit, retry: retrySpy } = source(status({ error: { kind: 'network' } }));
    const haptic = vi.fn();
    const el = new MockElement();
    const line = new SyncStatusLine({ source: src, openSettings: () => undefined, haptic });
    line.mount(el as unknown as HTMLElement);
    expect(el.getText()).toContain('Не отправлено: нет связи');
    const retry = el.findAllByClass('mp-cal-sync-action')[0];
    expect(retry?.getText()).toBe('Повторить');
    retry?.dispatch('click');
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledWith('tap');
    emit(status({ running: false, error: null }));
    await vi.waitFor(() => expect(line.kind()).toBe('sent'));
  });

  it('ошибка входа — «Ошибка входа в iCloud · Настройки»', () => {
    const { src } = source(status({ error: { kind: 'auth' } }));
    const openSettings = vi.fn();
    const el = new MockElement();
    new SyncStatusLine({ source: src, openSettings }).mount(el as unknown as HTMLElement);
    expect(el.getText()).toContain('Ошибка входа в iCloud');
    el.findAllByClass('mp-cal-sync-action')[0]?.dispatch('click');
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});

describe('вкладка «Календарь»: выполнение с «Вернуть» и вибрация (006, §2, §10)', () => {
  async function setupTab() {
    const { CalendarTab } = await import('../../src/calendar/calendar-tab');
    const { createDefaultSettings } = await import('../../src/settings/defaults');
    const settings = createDefaultSettings();
    settings.ui.calendarMode = 'list';
    const haptics: string[] = [];
    const actions: Array<{ message: string; label: string; run(): void }> = [];
    const tasks = {
      complete: vi.fn(async () => ({ ok: true as const, changed: true, value: undefined })),
      uncomplete: vi.fn(async () => ({ ok: true as const, changed: true, value: undefined })),
      moveToQuadrant: vi.fn(),
      postponeToTomorrow: vi.fn(),
      delete: vi.fn(),
    };
    const host = {
      platform: { isMobile: true, isPhone: true, isAndroid: false, isIos: true, isTablet: false, isDesktop: false },
      actions: { isAvailable: () => true, openEventForm: vi.fn(), openTaskForm: vi.fn(), openItem: vi.fn(), openNote: vi.fn() },
      setAddContext: () => undefined,
      getAddContext: () => ({ date: null, quadrant: null }),
      switchTab: vi.fn(),
      register: () => undefined,
    };
    const clock = { now: () => new Date('2026-10-10T09:00:00Z'), timeZone: () => 'Europe/Moscow' };
    const tab = new CalendarTab(host as never, {
      dayItems: { getDays: () => new Map([[TODAY, agenda([task('a')])]]), onChange: () => () => undefined },
      settings: { get: () => settings, update: async () => undefined, onChange: () => () => undefined } as never,
      clock,
      format: { get: () => ({ language: 'ru', weekStart: 1, hour12: false }) } as never,
      notifier: { show: () => undefined, showAction: (message: string, action: { label: string; run(): void }) => actions.push({ message, ...action }) },
      tasks: tasks,
      haptic: (kind) => haptics.push(kind),
    });
    const container = new MockElement();
    tab.mount(container as unknown as HTMLElement);
    return { tab, container, haptics, actions, tasks, host };
  }

  it('кружок выполнения — success и «Задача выполнена · Вернуть»; «Вернуть» снимает выполнение', async () => {
    vi.useFakeTimers();
    const { container, haptics, actions, tasks } = await setupTab();
    const check = container.findAllByClass('mp-cal-check')[0];
    if (!check) throw new Error('нет кружка выполнения');
    check.dispatch('click', { stopPropagation: () => undefined });
    expect(haptics).toContain('success');
    await vi.advanceTimersByTimeAsync(300);
    expect(tasks.complete).toHaveBeenCalledWith('a', undefined);
    expect(actions[0]).toMatchObject({ message: 'Задача выполнена', label: 'Вернуть' });
    actions[0]?.run();
    expect(haptics.at(-1)).toBe('undo');
    await vi.waitFor(() => expect(tasks.uncomplete).toHaveBeenCalledWith('a', undefined));
  });

  it('смена режима — select', async () => {
    const { container, haptics } = await setupTab();
    const segments = container.findAllByClass('mp-segment');
    segments[1]?.dispatch('click');
    expect(haptics).toContain('select');
  });
});
