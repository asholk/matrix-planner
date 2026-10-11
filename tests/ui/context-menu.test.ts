import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu } from '../__mocks__/obsidian';
import { MENU_DEBOUNCE_MS, attachContextMenu, isMenuKey, isTouchContextMenu, showMenuAt } from '../../src/ui/controls/context-menu';

type Listener = (event: unknown) => void;

/** Минимальный EventTarget: элемент и его документ. */
class FakeTarget {
  private readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }
  dispatch(type: string, event: Record<string, unknown> = {}): { prevented: boolean } {
    const state = { prevented: false };
    const full = { type, preventDefault: () => (state.prevented = true), stopPropagation: () => undefined, ...event };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(full);
    return state;
  }
  count(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

class FakeElement extends FakeTarget {
  readonly doc = new FakeTarget();
}

function control(isControl: boolean) {
  return { closest: (selector: string) => (isControl && selector === '.mp-cal-check' ? {} : null) };
}

function press(el: FakeElement, over: Record<string, unknown> = {}) {
  el.dispatch('pointerdown', { pointerType: 'touch', pointerId: 1, button: 0, clientX: 10, clientY: 10, timeStamp: 0, target: control(false), ...over });
}

describe('attachContextMenu', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
  });
  afterEach(() => vi.useRealTimers());

  function setup(options: Record<string, unknown> = {}) {
    const el = new FakeElement();
    const open = vi.fn();
    const binding = attachContextMenu(el as unknown as HTMLElement, open, { controlSelector: '.mp-cal-check', now: () => now, ...options });
    return { el, open, binding };
  }

  it('долгое нажатие 500 мс открывает меню у элемента и подавляет следующий click', () => {
    const { el, open, binding } = setup();
    press(el);
    vi.advanceTimersByTime(499);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledWith(el);
    // Слушатели документа сняты сразу после меню.
    expect(el.doc.count('pointermove')).toBe(0);
    expect(binding.consumeClick()).toBe(true);
    expect(binding.consumeClick()).toBe(false);
  });

  it('отклик haptic — синхронно при открытии меню; следующий touchend отменяется (иначе click закроет меню)', () => {
    const haptic = vi.fn();
    const { el, open } = setup({ haptic });
    press(el);
    vi.advanceTimersByTime(500);
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(el.doc.dispatch('touchend', { cancelable: true }).prevented).toBe(true);
    // Только один раз.
    expect(el.doc.dispatch('touchend', { cancelable: true }).prevented).toBe(false);
  });

  it('сдвиг пальца до срабатывания — прокрутка: меню нет, click не подавляется', () => {
    const { el, open, binding } = setup();
    press(el);
    el.doc.dispatch('pointermove', { pointerId: 1, clientX: 10, clientY: 40, timeStamp: 100 });
    vi.advanceTimersByTime(600);
    expect(open).not.toHaveBeenCalled();
    expect(binding.consumeClick()).toBe(false);
  });

  it('прокрутка панели, pointercancel и Escape отменяют долгое нажатие', () => {
    const { el, open } = setup();
    press(el);
    el.doc.dispatch('scroll');
    press(el);
    el.doc.dispatch('pointercancel', { pointerId: 1 });
    press(el);
    el.doc.dispatch('keydown', { key: 'Escape' });
    vi.advanceTimersByTime(1000);
    expect(open).not.toHaveBeenCalled();
  });

  it('отпущенный до 500 мс палец — обычное нажатие', () => {
    const { el, open, binding } = setup();
    press(el);
    el.doc.dispatch('pointerup', { pointerId: 1, clientX: 10, clientY: 10, timeStamp: 120 });
    vi.advanceTimersByTime(1000);
    expect(open).not.toHaveBeenCalled();
    expect(binding.consumeClick()).toBe(false);
  });

  it('нажатие на кружок выполнения и мышь долгое нажатие не начинают', () => {
    const { el, open } = setup();
    press(el, { target: control(true) });
    press(el, { pointerType: 'mouse' });
    vi.advanceTimersByTime(1000);
    expect(open).not.toHaveBeenCalled();
  });

  it('правая кнопка мыши: меню у указателя, системное меню отменено', () => {
    const { el, open } = setup();
    const state = el.dispatch('contextmenu', { clientX: 5, clientY: 6 });
    expect(state.prevented).toBe(true);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ type: 'contextmenu', clientX: 5 }));
  });

  it('Shift+F10 и клавиша ContextMenu открывают меню у элемента клавиатуры', () => {
    const keyTarget = new FakeTarget();
    const { el, open } = setup({ keyTarget });
    expect(keyTarget.dispatch('keydown', { key: 'F10', shiftKey: true }).prevented).toBe(true);
    now += MENU_DEBOUNCE_MS;
    keyTarget.dispatch('keydown', { key: 'ContextMenu', shiftKey: false });
    keyTarget.dispatch('keydown', { key: 'F10', shiftKey: false });
    el.dispatch('keydown', { key: 'ContextMenu' });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith(keyTarget);
  });

  it('долгое нажатие и следом contextmenu (Android) — одно меню', () => {
    const { el, open } = setup();
    press(el);
    vi.advanceTimersByTime(500);
    now += 50;
    el.dispatch('contextmenu', { clientX: 1, clientY: 1 });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('dispose снимает обработчики и таймер', () => {
    const { el, open, binding } = setup();
    press(el);
    binding.dispose();
    vi.advanceTimersByTime(1000);
    el.dispatch('contextmenu');
    expect(open).not.toHaveBeenCalled();
    expect(el.count('pointerdown')).toBe(0);
    expect(el.doc.count('pointermove')).toBe(0);
  });
});

describe('isMenuKey и showMenuAt', () => {
  it('клавиши меню', () => {
    expect(isMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
    expect(isMenuKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('меню у элемента — под его прямоугольником', () => {
    const menu = new Menu();
    const at = vi.spyOn(menu, 'showAtPosition');
    const anchor = { getBoundingClientRect: () => ({ left: 12, bottom: 34 }), doc: {} };
    showMenuAt(menu as never, anchor as unknown as HTMLElement);
    expect(at).toHaveBeenCalledWith({ x: 12, y: 34 }, anchor.doc);
  });
});

describe('isTouchContextMenu', () => {
  it('contextmenu от пальца или пера', () => {
    expect(isTouchContextMenu({ pointerType: 'touch' })).toBe(true);
    expect(isTouchContextMenu({ pointerType: 'pen' })).toBe(true);
    expect(isTouchContextMenu({ sourceCapabilities: { firesTouchEvents: true } })).toBe(true);
  });

  it('правая кнопка мыши и клавиатура — не касание', () => {
    expect(isTouchContextMenu({ pointerType: 'mouse' })).toBe(false);
    expect(isTouchContextMenu({ sourceCapabilities: { firesTouchEvents: false } })).toBe(false);
    expect(isTouchContextMenu({})).toBe(false);
    expect(isTouchContextMenu(null)).toBe(false);
  });
});
