import { describe, expect, it } from 'vitest';
import {
  CardGesture,
  TASK_DRAG_GESTURE_OPTIONS,
  deleteZoneRect,
  dropZoneAt,
  isHighlightedZone,
  resolveDrop,
  startDrag,
  updateDrag,
  type DropZone,
  type PointerDown,
} from '../../src/tasks/task-drag';

const OPTIONS = { longPressMs: 500, moveTolerance: 10, dragThreshold: 6 };

function down(overrides: Partial<PointerDown> = {}): PointerDown {
  return { x: 100, y: 100, time: 0, pointerType: 'mouse', button: 0, onControl: false, ...overrides };
}

// Сетка 2 × 2: do | plan / urgent | someday.
const ZONES: DropZone[] = [
  { quadrant: 'do', rect: { left: 0, top: 0, right: 200, bottom: 300 } },
  { quadrant: 'plan', rect: { left: 210, top: 0, right: 410, bottom: 300 } },
  { quadrant: 'urgent', rect: { left: 0, top: 310, right: 200, bottom: 610 } },
  { quadrant: 'someday', rect: { left: 210, top: 310, right: 410, bottom: 610 } },
];

describe('перенос мышью (компьютер)', () => {
  it('сдвиг больше порога начинает перетаскивание, отпускание — drop', () => {
    const g = new CardGesture(OPTIONS);
    expect(g.down(down())).toEqual({ type: 'none' });
    expect(g.move({ x: 103, y: 100, time: 10 })).toEqual({ type: 'none' });
    expect(g.move({ x: 120, y: 100, time: 20 })).toEqual({ type: 'drag-start', x: 120, y: 100, byLongPress: false });
    expect(g.isDragging()).toBe(true);
    expect(g.move({ x: 300, y: 100, time: 30 })).toEqual({ type: 'drag-move', x: 300, y: 100 });
    expect(g.up({ x: 300, y: 100, time: 40 })).toEqual({ type: 'drop', x: 300, y: 100 });
    expect(g.getPhase()).toBe('idle');
  });

  it('после перетаскивания click подавляется один раз', () => {
    const g = new CardGesture(OPTIONS);
    g.down(down());
    g.move({ x: 130, y: 100, time: 10 });
    g.up({ x: 130, y: 100, time: 20 });
    expect(g.consumesClick()).toBe(true);
    expect(g.consumesClick()).toBe(false);
  });

  it('простое нажатие без сдвига не подавляет click', () => {
    const g = new CardGesture(OPTIONS);
    g.down(down());
    expect(g.up({ x: 101, y: 100, time: 50 })).toEqual({ type: 'none' });
    expect(g.consumesClick()).toBe(false);
  });

  it('правая кнопка и нажатие на кружок не начинают жест', () => {
    const g = new CardGesture(OPTIONS);
    g.down(down({ button: 2 }));
    expect(g.getPhase()).toBe('idle');
    g.down(down({ onControl: true }));
    expect(g.move({ x: 200, y: 200, time: 10 })).toEqual({ type: 'none' });
  });

  it('мышь не вызывает меню по удержанию', () => {
    const g = new CardGesture(OPTIONS);
    g.down(down());
    expect(g.timeout(1000)).toEqual({ type: 'none' });
  });

  it('отмена во время перетаскивания возвращает карточку', () => {
    const g = new CardGesture(OPTIONS);
    g.down(down());
    g.move({ x: 150, y: 100, time: 10 });
    expect(g.cancel()).toEqual({ type: 'cancel', wasDragging: true });
    expect(g.cancel()).toEqual({ type: 'none' });
  });
});

describe('перенос долгим нажатием (вкладка «Задачи», доработка 005)', () => {
  it('долгое нажатие пальцем поднимает карточку, перемещение — drag-move, отпускание — drop', () => {
    const g = new CardGesture(TASK_DRAG_GESTURE_OPTIONS);
    expect(g.down(down({ pointerType: 'touch' }))).toEqual({ type: 'schedule-long-press', delayMs: 500 });
    expect(g.move({ x: 103, y: 104, time: 200 })).toEqual({ type: 'none' });
    expect(g.timeout(500)).toEqual({ type: 'drag-start', x: 103, y: 104, byLongPress: true });
    expect(g.isDragging()).toBe(true);
    expect(g.move({ x: 300, y: 400, time: 700 })).toEqual({ type: 'drag-move', x: 300, y: 400 });
    expect(g.up({ x: 300, y: 400, time: 800 })).toEqual({ type: 'drop', x: 300, y: 400 });
    // Отпускание после перетаскивания не открывает форму.
    expect(g.consumesClick()).toBe(true);
  });

  it('меню по долгому нажатию не открывается', () => {
    const g = new CardGesture(TASK_DRAG_GESTURE_OPTIONS);
    g.down(down({ pointerType: 'touch' }));
    expect(g.timeout(500).type).toBe('drag-start');
    expect(g.getPhase()).not.toBe('menu');
  });

  it('сдвиг больше 8 px до срабатывания — прокрутка: жест отменён, перетаскивания нет', () => {
    const g = new CardGesture(TASK_DRAG_GESTURE_OPTIONS);
    g.down(down({ pointerType: 'touch' }));
    expect(g.move({ x: 100, y: 108, time: 50 })).toEqual({ type: 'none' });
    expect(g.move({ x: 100, y: 109, time: 60 })).toEqual({ type: 'cancel', wasDragging: false });
    expect(g.timeout(600)).toEqual({ type: 'none' });
    expect(g.consumesClick()).toBe(false);
  });

  it('короткое касание — обычное нажатие (форма)', () => {
    const g = new CardGesture(TASK_DRAG_GESTURE_OPTIONS);
    g.down(down({ pointerType: 'touch' }));
    expect(g.up({ x: 100, y: 100, time: 150 })).toEqual({ type: 'none' });
    expect(g.timeout(600)).toEqual({ type: 'none' });
    expect(g.consumesClick()).toBe(false);
  });

  it('отмена указателя во время перетаскивания возвращает карточку', () => {
    const g = new CardGesture(TASK_DRAG_GESTURE_OPTIONS);
    g.down(down({ pointerType: 'pen' }));
    g.timeout(500);
    expect(g.isTouchActive()).toBe(true);
    expect(g.cancel()).toEqual({ type: 'cancel', wasDragging: true });
    expect(g.isTouchActive()).toBe(false);
  });

  it('кружок выполнения жест не начинает', () => {
    const g = new CardGesture(TASK_DRAG_GESTURE_OPTIONS);
    expect(g.down(down({ pointerType: 'touch', onControl: true }))).toEqual({ type: 'none' });
    expect(g.timeout(600)).toEqual({ type: 'none' });
  });

  it('мышь тянет сразу после сдвига, как раньше', () => {
    const g = new CardGesture(TASK_DRAG_GESTURE_OPTIONS);
    expect(g.down(down())).toEqual({ type: 'none' });
    expect(g.move({ x: 110, y: 100, time: 10 })).toEqual({ type: 'drag-start', x: 110, y: 100, byLongPress: false });
  });
});

describe('меню по долгому нажатию (режим по умолчанию — строки «Календаря»)', () => {
  it('касание планирует таймер, по нему — меню', () => {
    const g = new CardGesture(OPTIONS);
    expect(g.down(down({ pointerType: 'touch' }))).toEqual({ type: 'schedule-long-press', delayMs: 500 });
    expect(g.move({ x: 104, y: 103, time: 200 })).toEqual({ type: 'none' });
    expect(g.timeout(500)).toEqual({ type: 'long-press' });
    expect(g.getPhase()).toBe('menu');
    expect(g.up({ x: 104, y: 103, time: 900 })).toEqual({ type: 'none' });
    // Отпускание после меню не открывает форму.
    expect(g.consumesClick()).toBe(true);
  });

  it('ранний таймер игнорируется', () => {
    const g = new CardGesture(OPTIONS);
    g.down(down({ pointerType: 'touch', time: 1000 }));
    expect(g.timeout(1200)).toEqual({ type: 'none' });
    expect(g.timeout(1500)).toEqual({ type: 'long-press' });
  });

  it('короткое касание — обычное нажатие', () => {
    const g = new CardGesture(OPTIONS);
    g.down(down({ pointerType: 'touch' }));
    g.up({ x: 100, y: 100, time: 120 });
    expect(g.timeout(600)).toEqual({ type: 'none' });
    expect(g.consumesClick()).toBe(false);
  });

  it('перо ведёт себя как касание', () => {
    const g = new CardGesture(OPTIONS);
    expect(g.down(down({ pointerType: 'pen' })).type).toBe('schedule-long-press');
  });
});

describe('цели переноса', () => {
  it('квадрант под точкой', () => {
    expect(dropZoneAt(ZONES, 50, 50)).toBe('do');
    expect(dropZoneAt(ZONES, 300, 400)).toBe('someday');
    expect(dropZoneAt(ZONES, 205, 50)).toBeNull();
  });

  it('перенос в другой квадрант', () => {
    let session = startDrag('t1', 'do');
    session = updateDrag(session, ZONES, 50, 50);
    expect(isHighlightedZone(session, 'do')).toBe(false);
    expect(resolveDrop(session)).toBeNull();
    session = updateDrag(session, ZONES, 300, 50);
    expect(isHighlightedZone(session, 'plan')).toBe(true);
    expect(resolveDrop(session)).toEqual({ kind: 'move', taskId: 't1', quadrant: 'plan' });
  });

  it('отпускание вне квадрантов ничего не меняет', () => {
    const session = updateDrag(startDrag('t1', 'urgent'), ZONES, 1000, 1000);
    expect(session.over).toBeNull();
    expect(resolveDrop(session)).toBeNull();
  });

  it('без изменения зоны возвращается тот же объект', () => {
    const a = updateDrag(startDrag('t1', 'do'), ZONES, 300, 50);
    expect(updateDrag(a, ZONES, 310, 60)).toBe(a);
  });
});

describe('зона удаления', () => {
  const DELETE: { left: number; top: number; right: number; bottom: number } = { left: 100, top: 700, right: 300, bottom: 750 };

  it('отпускание над зоной — удаление; зона важнее квадранта под ней', () => {
    const zones: DropZone[] = [...ZONES, { quadrant: 'urgent', rect: { left: 0, top: 650, right: 400, bottom: 800 } }];
    let session = updateDrag(startDrag('t1', 'do'), zones, 200, 720, DELETE);
    expect(session.overDelete).toBe(true);
    expect(session.over).toBeNull();
    expect(isHighlightedZone(session, 'urgent')).toBe(false);
    expect(resolveDrop(session)).toEqual({ kind: 'delete', taskId: 't1' });
    // Ушли с зоны — снова перенос.
    session = updateDrag(session, zones, 300, 50, DELETE);
    expect(session.overDelete).toBe(false);
    expect(resolveDrop(session)).toEqual({ kind: 'move', taskId: 't1', quadrant: 'plan' });
  });

  it('без зоны удаления (null) — прежнее поведение', () => {
    const session = updateDrag(startDrag('t1', 'do'), ZONES, 200, 720, null);
    expect(session.overDelete).toBe(false);
    expect(resolveDrop(session)).toBeNull();
  });

  it('зона по центру вида на высоте «+» и не заходит на «+» (телефон 393 px)', () => {
    const view = { left: 0, top: 0, right: 393, bottom: 852 };
    const fab = { left: 321, top: 650, right: 377, bottom: 706 };
    const rect = deleteZoneRect(view, fab, { width: 300, height: 52, gap: 12 });
    expect(rect.right).toBeLessThanOrEqual(fab.left - 12);
    expect(rect.left).toBeGreaterThanOrEqual(12);
    expect((rect.top + rect.bottom) / 2).toBe(678);
    expect(rect.bottom - rect.top).toBe(52);
  });

  it('на широком виде зона по центру и шириной не больше заданной', () => {
    const view = { left: 0, top: 0, right: 1200, bottom: 800 };
    const fab = { left: 1130, top: 700, right: 1186, bottom: 756 };
    const rect = deleteZoneRect(view, fab, { width: 300, height: 52, gap: 12 });
    expect(rect.right - rect.left).toBe(300);
    expect((rect.left + rect.right) / 2).toBe(600);
  });

  it('без «+» — у нижнего края вида', () => {
    const rect = deleteZoneRect({ left: 0, top: 0, right: 400, bottom: 800 }, null, { width: 300, height: 50, gap: 10 });
    expect(rect).toEqual({ left: 50, right: 350, top: 740, bottom: 790 });
  });
});
