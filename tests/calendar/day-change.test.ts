import { describe, expect, it, vi } from 'vitest';
import { DAY_CHECK_INTERVAL_MS, DayChangeWatcher } from '../../src/calendar/calendar-tab';
import { initCalendarState, refreshToday } from '../../src/calendar/calendar-state';

function setup() {
  let today = '2026-10-10';
  let tick: (() => void) | null = null;
  const handlers = new Map<string, () => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: vi.fn((type: string, handler: () => void) => handlers.set(type, handler)),
    removeEventListener: vi.fn((type: string) => handlers.delete(type)),
  };
  const onCheck = vi.fn();
  const clearInterval = vi.fn(() => {
    tick = null;
  });
  const watcher = new DayChangeWatcher({
    today: () => today,
    onCheck,
    setInterval: (callback, ms) => {
      expect(ms).toBe(DAY_CHECK_INTERVAL_MS);
      tick = callback;
      return 1;
    },
    clearInterval,
    doc: doc,
  });
  return {
    watcher,
    onCheck,
    clearInterval,
    doc,
    handlers,
    setToday: (next: string) => {
      today = next;
    },
    tick: () => tick?.(),
    hasTimer: () => tick !== null,
  };
}

describe('DayChangeWatcher', () => {
  it('таймер раз в минуту, пока вкладка показана, сообщает о смене суток', () => {
    const ctx = setup();
    ctx.watcher.start();
    ctx.tick();
    expect(ctx.onCheck).not.toHaveBeenCalled();
    ctx.setToday('2026-10-11');
    ctx.tick();
    expect(ctx.onCheck).toHaveBeenCalledWith(true);
    ctx.watcher.stop();
    expect(ctx.hasTimer()).toBe(false);
  });

  it('возвращение из фона проверяет день; dispose снимает обработчик и таймер', () => {
    const ctx = setup();
    ctx.watcher.attach();
    ctx.watcher.start();
    ctx.setToday('2026-10-11');
    ctx.handlers.get('visibilitychange')?.();
    expect(ctx.onCheck).toHaveBeenCalledWith(true);
    ctx.watcher.dispose();
    expect(ctx.doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(ctx.clearInterval).toHaveBeenCalled();
  });

  it('выбранный «сегодня» переходит на новый день, иной выбранный день сохраняется', () => {
    const state = initCalendarState('2026-10-10', 'list');
    expect(refreshToday(state, '2026-10-11')).toMatchObject({ today: '2026-10-11', selected: '2026-10-11' });
    const other = { ...state, selected: '2026-10-05' };
    expect(refreshToday(other, '2026-10-11')).toMatchObject({ today: '2026-10-11', selected: '2026-10-05' });
  });
});
