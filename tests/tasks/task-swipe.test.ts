import { describe, expect, it } from 'vitest';
import { DEFAULT_SWIPE_OPTIONS, SwipeGesture, swipeActionFor } from '../../src/tasks/task-swipe';

const WIDTH = 300;

function start(g: SwipeGesture, over: Partial<{ right: boolean; left: boolean }> = {}): void {
  g.down({ x: 100, y: 100, width: WIDTH, right: true, left: true, ...over });
}

describe('swipeActionFor: пороги', () => {
  it('порог действия 35–40 % ширины', () => {
    expect(DEFAULT_SWIPE_OPTIONS.threshold).toBeGreaterThanOrEqual(0.35);
    expect(DEFAULT_SWIPE_OPTIONS.threshold).toBeLessThanOrEqual(0.4);
  });

  it('вправо — выполнить, влево — на завтра, длинный влево — удалить', () => {
    expect(swipeActionFor(0.3 * WIDTH, WIDTH)).toBeNull();
    expect(swipeActionFor(0.4 * WIDTH, WIDTH)).toBe('complete');
    expect(swipeActionFor(-0.3 * WIDTH, WIDTH)).toBeNull();
    expect(swipeActionFor(-0.45 * WIDTH, WIDTH)).toBe('postpone');
    expect(swipeActionFor(-0.75 * WIDTH, WIDTH)).toBe('delete');
    expect(swipeActionFor(0.9 * WIDTH, WIDTH)).toBe('complete');
    expect(swipeActionFor(10, 0)).toBeNull();
  });
});

describe('SwipeGesture', () => {
  it('горизонтальный сдвиг захватывает жест, за порогом — отклик, отпускание — действие', () => {
    const g = new SwipeGesture();
    start(g);
    expect(g.move(105, 101)).toEqual({ type: 'none' });
    expect(g.move(115, 102)).toEqual({ type: 'start' });
    expect(g.isSwiping()).toBe(true);
    expect(g.move(150, 103)).toEqual({ type: 'move', offset: 50, action: null, crossed: false });
    expect(g.move(230, 103)).toEqual({ type: 'move', offset: 130, action: 'complete', crossed: true });
    expect(g.move(240, 103)).toEqual({ type: 'move', offset: 140, action: 'complete', crossed: false });
    expect(g.up()).toEqual({ type: 'commit', action: 'complete', offset: 140 });
    expect(g.getPhase()).toBe('idle');
  });

  it('влево: «На завтра», дальше — «Удалить» (каждая смена действия — отклик)', () => {
    const g = new SwipeGesture();
    start(g);
    g.move(85, 100);
    expect(g.move(100 - 0.45 * WIDTH, 100)).toMatchObject({ type: 'move', action: 'postpone', crossed: true });
    expect(g.move(100 - 0.8 * WIDTH, 100)).toMatchObject({ type: 'move', action: 'delete', crossed: true });
    expect(g.up()).toMatchObject({ type: 'commit', action: 'delete' });
  });

  it('отпускание до порога — карточка возвращается без действия', () => {
    const g = new SwipeGesture();
    start(g);
    g.move(120, 100);
    g.move(160, 100);
    expect(g.up()).toEqual({ type: 'cancel', wasSwiping: true });
  });

  it('вертикальный сдвиг — прокрутка: свайп отменён', () => {
    const g = new SwipeGesture();
    start(g);
    expect(g.move(104, 115)).toEqual({ type: 'cancel', wasSwiping: false });
    expect(g.move(200, 115)).toEqual({ type: 'none' });
    expect(g.up()).toEqual({ type: 'none' });
  });

  it('диагональ ближе к вертикали не захватывается', () => {
    const g = new SwipeGesture();
    start(g);
    expect(g.move(111, 110)).toEqual({ type: 'none' });
  });

  it('запрещённое направление не начинает свайп', () => {
    const g = new SwipeGesture();
    start(g, { right: false });
    expect(g.move(120, 100)).toEqual({ type: 'cancel', wasSwiping: false });
  });

  it('сдвиг ограничен шириной карточки и не уходит в запрещённую сторону', () => {
    const g = new SwipeGesture();
    start(g, { left: false });
    g.move(115, 100);
    expect(g.move(100 + 2 * WIDTH, 100)).toMatchObject({ offset: WIDTH });
    expect(g.move(20, 100)).toMatchObject({ offset: 0, action: null });
  });

  it('cancel (pointercancel, перерисовка) во время свайпа возвращает карточку', () => {
    const g = new SwipeGesture();
    start(g);
    g.move(120, 100);
    expect(g.cancel()).toEqual({ type: 'cancel', wasSwiping: true });
    expect(g.cancel()).toEqual({ type: 'none' });
  });
});
