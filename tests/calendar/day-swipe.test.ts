import { describe, expect, it } from 'vitest';
import { DayWheel, DaySwipeGesture, dayKeyStep, shouldCommit, stepForOffset } from '../../src/calendar/day-swipe';
import { moveSelection, initCalendarState, visibleRange } from '../../src/calendar/calendar-state';

const WIDTH = 400;

function begin(x = 200, y = 300, time = 0): DaySwipeGesture {
  const gesture = new DaySwipeGesture();
  gesture.down({ x, y, time, width: WIDTH });
  return gesture;
}

describe('day swipe: direction', () => {
  it('locks horizontally after 10 px and follows the finger', () => {
    const gesture = begin();
    expect(gesture.move(195, 301, 10)).toEqual({ type: 'none' });
    expect(gesture.move(185, 302, 20)).toEqual({ type: 'start' });
    expect(gesture.isSwiping()).toBe(true);
    expect(gesture.move(150, 305, 40)).toMatchObject({ type: 'move', offset: -50, armed: false, crossed: false });
  });

  it('vertical movement cancels the swipe (list scroll)', () => {
    const gesture = begin();
    expect(gesture.move(203, 315, 20)).toEqual({ type: 'cancel', wasSwiping: false });
    expect(gesture.getPhase()).toBe('cancelled');
    // Дальнейшее горизонтальное движение уже не свайп.
    expect(gesture.move(50, 320, 60)).toEqual({ type: 'none' });
    expect(gesture.up(80)).toEqual({ type: 'none' });
  });

  it('diagonal movement (not clearly horizontal) is treated as scroll', () => {
    const gesture = begin();
    expect(gesture.move(188, 311, 20)).toEqual({ type: 'cancel', wasSwiping: false });
  });

  it('holding still past the long-press delay cancels (menu, new event)', () => {
    const gesture = begin();
    expect(gesture.move(202, 301, 300)).toEqual({ type: 'none' });
    expect(gesture.move(203, 301, 500)).toEqual({ type: 'cancel', wasSwiping: false });
    expect(gesture.move(100, 301, 600)).toEqual({ type: 'none' });
  });

  it('slow start after the long-press delay is not a swipe', () => {
    const gesture = begin();
    expect(gesture.move(150, 300, 600)).toEqual({ type: 'cancel', wasSwiping: false });
  });

  it('offset is clamped to the width', () => {
    const gesture = begin(390);
    gesture.move(370, 300, 10);
    expect(gesture.move(-200, 300, 30)).toMatchObject({ offset: -WIDTH });
  });
});

describe('day swipe: threshold and velocity', () => {
  it('crossing 25 % of the width arms the swipe once (haptic)', () => {
    const gesture = begin();
    gesture.move(180, 300, 10);
    expect(gesture.move(110, 300, 100)).toMatchObject({ armed: false, crossed: false });
    expect(gesture.move(99, 300, 120)).toMatchObject({ armed: true, crossed: true });
    expect(gesture.move(90, 300, 140)).toMatchObject({ armed: true, crossed: false });
    expect(gesture.move(150, 300, 200)).toMatchObject({ armed: false, crossed: true });
  });

  it('slow swipe past the threshold: left — next day', () => {
    const gesture = begin();
    gesture.move(185, 300, 50);
    gesture.move(140, 300, 400);
    gesture.move(80, 300, 800);
    expect(gesture.up(1000)).toEqual({ type: 'commit', step: 1, offset: -120 });
  });

  it('slow swipe past the threshold: right — previous day', () => {
    const gesture = begin();
    gesture.move(215, 300, 50);
    gesture.move(320, 300, 800);
    expect(gesture.up(900)).toEqual({ type: 'commit', step: -1, offset: 120 });
  });

  it('slow short swipe springs back', () => {
    const gesture = begin();
    gesture.move(215, 300, 50);
    gesture.move(260, 300, 600);
    expect(gesture.up(800)).toEqual({ type: 'cancel', wasSwiping: true });
  });

  it('fast flick below the threshold changes the day', () => {
    const gesture = begin();
    gesture.move(188, 300, 10);
    gesture.move(170, 300, 30);
    gesture.move(150, 300, 50);
    expect(gesture.up(55)).toEqual({ type: 'commit', step: 1, offset: -50 });
  });

  it('flick back towards the start does not commit', () => {
    const gesture = begin();
    gesture.move(185, 300, 20);
    gesture.move(120, 300, 400);
    // Быстрый возврат пальца к началу: сдвиг ещё влево, скорость — вправо.
    gesture.move(140, 300, 420);
    gesture.move(165, 300, 440);
    expect(gesture.up(445)).toEqual({ type: 'cancel', wasSwiping: true });
  });

  it('pointercancel while swiping returns the content', () => {
    const gesture = begin();
    gesture.move(185, 300, 20);
    expect(gesture.cancel()).toEqual({ type: 'cancel', wasSwiping: true });
    expect(gesture.cancel()).toEqual({ type: 'none' });
  });

  it('tap without movement is not a swipe', () => {
    const gesture = begin();
    expect(gesture.up(80)).toEqual({ type: 'none' });
  });

  it('shouldCommit and stepForOffset', () => {
    expect(shouldCommit(-100, 0, WIDTH)).toBe(true);
    expect(shouldCommit(-99, 0, WIDTH)).toBe(false);
    expect(shouldCommit(-40, -0.8, WIDTH)).toBe(true);
    expect(shouldCommit(-20, -2, WIDTH)).toBe(false);
    expect(shouldCommit(40, -0.8, WIDTH)).toBe(false);
    expect(shouldCommit(100, 0, 0)).toBe(false);
    expect(stepForOffset(-5)).toBe(1);
    expect(stepForOffset(5)).toBe(-1);
  });

  it('zero width never starts', () => {
    const gesture = new DaySwipeGesture();
    gesture.down({ x: 0, y: 0, time: 0, width: 0 });
    expect(gesture.move(-50, 0, 10)).toEqual({ type: 'none' });
  });
});

describe('day wheel and keys', () => {
  it('one trackpad gesture changes at most one day', () => {
    const wheel = new DayWheel();
    expect(wheel.push(30, 0)).toBe(0);
    expect(wheel.push(40, 16)).toBe(1);
    // Инерция того же жеста.
    expect(wheel.push(80, 32)).toBe(0);
    expect(wheel.push(80, 200)).toBe(0);
    // Пауза — новый жест.
    expect(wheel.push(-70, 600)).toBe(-1);
  });

  it('small horizontal jitter does not change the day', () => {
    const wheel = new DayWheel();
    expect(wheel.push(10, 0)).toBe(0);
    expect(wheel.push(10, 500)).toBe(0);
    expect(wheel.push(10, 1000)).toBe(0);
  });

  it('isHorizontal', () => {
    expect(DayWheel.isHorizontal(10, 3)).toBe(true);
    expect(DayWheel.isHorizontal(3, 10)).toBe(false);
    expect(DayWheel.isHorizontal(5, 5)).toBe(false);
  });

  it('arrow keys without modifiers', () => {
    expect(dayKeyStep({ key: 'ArrowLeft' })).toBe(-1);
    expect(dayKeyStep({ key: 'ArrowRight' })).toBe(1);
    expect(dayKeyStep({ key: 'ArrowRight', shiftKey: true })).toBe(0);
    expect(dayKeyStep({ key: 'ArrowUp' })).toBe(0);
  });
});

describe('day step and the week strip', () => {
  it('stepping over the week boundary moves the visible week', () => {
    // 2026-10-11 — воскресенье; неделя с понедельника.
    const state = initCalendarState('2026-10-11', 'list');
    const next = moveSelection(state, 1);
    expect(next.selected).toBe('2026-10-12');
    expect(visibleRange(state, 1).from).toBe('2026-10-05');
    expect(visibleRange(next, 1).from).toBe('2026-10-12');
    expect(moveSelection(next, -1).selected).toBe('2026-10-11');
  });
});
