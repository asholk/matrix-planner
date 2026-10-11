import { describe, expect, it, vi } from 'vitest';
import { createHaptics, NATIVE_HAPTICS, TICK_PATTERNS, VIBRATE_PATTERNS, type HapticKind } from '../../src/ui/haptics';

const KINDS = Object.keys(TICK_PATTERNS) as HapticKind[];

function fakeWin(opts: { ua?: string; vibrate?: (p: unknown) => boolean; capacitor?: unknown }) {
  const clicks: number[] = [];
  const timers: Array<() => void> = [];
  const label = { isConnected: true, click: () => clicks.push(clicks.length), createEl: vi.fn() };
  const body = { createEl: vi.fn(() => label) };
  const doc = { body };
  const win = {
    navigator: { userAgent: opts.ua ?? 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32', maxTouchPoints: 0, vibrate: opts.vibrate },
    document: doc,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    Capacitor: opts.capacitor,
  };
  return { win: win as unknown as Window, clicks, timers };
}

describe('haptics', () => {
  it('у каждого действия есть шаблон для всех способов', () => {
    for (const kind of KINDS) {
      expect(NATIVE_HAPTICS[kind]).toBeDefined();
      expect(VIBRATE_PATTERNS[kind]).toBeDefined();
      expect(TICK_PATTERNS[kind].length).toBeGreaterThan(0);
    }
  });

  it('разные действия различаются ритмом (выполнение, удаление, ошибка)', () => {
    const shapes = new Set(['success', 'delete', 'error', 'tap'].map((k) => JSON.stringify(TICK_PATTERNS[k as HapticKind])));
    expect(shapes.size).toBe(4);
  });

  it('выключено в настройках — ничего не делает', () => {
    const vibrate = vi.fn(() => true);
    const { win } = fakeWin({ vibrate });
    createHaptics({ enabled: () => false, win }).play('success');
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('Android: navigator.vibrate с шаблоном действия', () => {
    const vibrate = vi.fn(() => true);
    const { win } = fakeWin({ ua: 'Mozilla/5.0 (Linux; Android 14)', vibrate });
    const h = createHaptics({ enabled: () => true, win });
    expect(h.method()).toBe('vibrate');
    h.play('delete');
    expect(vibrate).toHaveBeenCalledWith([30, 50, 30]);
  });

  it('iOS без нативного модуля: тики переключателя по ритму действия', () => {
    const { win, clicks, timers } = fakeWin({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
    const h = createHaptics({ enabled: () => true, win });
    expect(h.method()).toBe('ios-switch');
    h.play('delete');
    for (const t of timers) t();
    expect(clicks).toHaveLength(3);
  });

  it('нативный Capacitor Haptics: notification для выполнения, impact для удаления', () => {
    const notification = vi.fn();
    const impact = vi.fn();
    const { win } = fakeWin({ capacitor: { Plugins: { Haptics: { notification, impact } } } });
    const h = createHaptics({ enabled: () => true, win });
    expect(h.method()).toBe('native');
    h.play('success');
    h.play('delete');
    expect(notification).toHaveBeenCalledWith({ type: 'SUCCESS' });
    expect(impact).toHaveBeenCalledWith({ style: 'HEAVY' });
  });

  it('ошибка способа не пробрасывается', () => {
    const { win } = fakeWin({ capacitor: { Plugins: { Haptics: { impact: () => { throw new Error('x'); } } } } });
    expect(() => createHaptics({ enabled: () => true, win }).play('tap')).not.toThrow();
  });
});
