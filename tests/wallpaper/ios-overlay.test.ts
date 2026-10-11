import { describe, expect, it } from 'vitest';
import { iosDateText, iosTimeText } from '../../src/wallpaper/ios-overlay';
import { layoutCardBoxes } from '../../src/wallpaper/composition';
import { defaultProfile } from '../../src/wallpaper/profiles';

// Суббота, 10 октября 2026, 13:03 в Москве.
const NOW = new Date(Date.UTC(2026, 9, 10, 10, 3));

describe('макет экрана блокировки iOS', () => {
  it('дата как в iOS: «Сб 10 окт.» / «Sat Oct 10»', () => {
    expect(iosDateText(NOW, 'Europe/Moscow', 'ru')).toBe('Сб 10 окт.');
    expect(iosDateText(NOW, 'Europe/Moscow', 'en')).toBe('Sat Oct 10');
  });

  it('часы без AM/PM', () => {
    expect(iosTimeText(NOW, 'Europe/Moscow', false)).toBe('13:03');
    expect(iosTimeText(NOW, 'Europe/Moscow', true)).toBe('1:03');
  });
});

describe('карточки для макета кадрировщика', () => {
  it('матрица: лента недели и 4 квадранта; без виджетов — выше', () => {
    const profile = defaultProfile();
    const base = { template: 'matrix' as const, palette: 'dark' as const, tasksPerQuadrant: 3 as const };
    const widgets = layoutCardBoxes({ ...base, layoutPreset: 'widgets' }, profile, '2026-10-10');
    const low = layoutCardBoxes({ ...base, layoutPreset: 'no-widgets' }, profile, '2026-10-10');
    expect(widgets).toHaveLength(5);
    expect(widgets[0].y / profile.height).toBeGreaterThan(0.3);
    expect(low[0].y).toBeLessThan(widgets[0].y);
  });

  it('календарь: прогресс года и месяц', () => {
    const boxes = layoutCardBoxes({ template: 'calendar', palette: 'light', tasksPerQuadrant: 2 }, defaultProfile(), '2026-08-15');
    expect(boxes).toHaveLength(2);
  });
});
