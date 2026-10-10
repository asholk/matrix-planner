import { describe, expect, it } from 'vitest';
import { bottomOverlap, probePoints, type RectLike } from '../../src/ui/dock-insets';

const view: RectLike = { top: 0, bottom: 800, left: 0, right: 400 };

describe('перекрытие нижней части вида', () => {
  it('без препятствий — 0', () => {
    expect(bottomOverlap(view, [])).toBe(0);
  });

  it('плавающая панель навигации поднимает док на расстояние от её верха до низа вида', () => {
    // Панель шириной 70% посередине, над safe-area (34 px).
    const navbar = { top: 700, bottom: 766, left: 60, right: 340 };
    expect(bottomOverlap(view, [navbar])).toBe(100);
  });

  it('берётся наибольшее перекрытие, дробные значения округляются вверх', () => {
    expect(bottomOverlap(view, [{ top: 750.4, bottom: 800, left: 0, right: 400 }, { top: 720, bottom: 760, left: 0, right: 100 }])).toBe(80);
    expect(bottomOverlap(view, [{ top: 750.4, bottom: 800, left: 0, right: 400 }])).toBe(50);
  });

  it('не учитывает элементы вне вида, в верхней половине и слишком высокие', () => {
    expect(bottomOverlap(view, [{ top: 700, bottom: 760, left: 420, right: 600 }])).toBe(0);
    expect(bottomOverlap(view, [{ top: 820, bottom: 880, left: 0, right: 400 }])).toBe(0);
    expect(bottomOverlap(view, [{ top: 10, bottom: 60, left: 0, right: 400 }])).toBe(0);
    // Боковая панель на всю высоту — не нижняя панель.
    expect(bottomOverlap(view, [{ top: 0, bottom: 800, left: 300, right: 400 }])).toBe(0);
  });

  it('вид нулевой высоты (скрыт) — 0', () => {
    expect(bottomOverlap({ top: 0, bottom: 0, left: 0, right: 400 }, [{ top: 0, bottom: 10, left: 0, right: 400 }])).toBe(0);
  });

  it('точки пробы — три колонки у нижнего края вверх до заданной глубины', () => {
    const points = probePoints(view, 26, 12);
    expect(points.map((p) => p.x)).toEqual([100, 100, 100, 200, 200, 200, 300, 300, 300]);
    expect(points.slice(0, 3).map((p) => p.y)).toEqual([798, 786, 774]);
    expect(probePoints({ top: 0, bottom: 0, left: 0, right: 0 }, 20, 10)).toEqual([]);
  });
});
