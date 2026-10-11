import { describe, expect, it } from 'vitest';
import { computeCoverRect } from '../../src/wallpaper/background';
import {
  clampCrop,
  coverScale,
  cropSourceRect,
  fitView,
  imagePointAt,
  isDefaultCrop,
  panCropBy,
  pinchCrop,
  visibleSize,
  wheelZoomFactor,
  zoomCropAt,
} from '../../src/wallpaper/crop-math';

const FRAME = { width: 1179, height: 2556 };
/** Альбомное фото 4032 × 3024: по высоте экрана помещается целиком, по ширине — малая часть. */
const LANDSCAPE = { width: 4032, height: 3024 };
/** Вид на экране редактора (CSS px) с пропорциями профиля. */
const VIEW = { width: 300, height: 650.4 };

const close = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits);

describe('cover-кадр', () => {
  it('масштаб cover — по стороне, которой не хватает', () => {
    close(coverScale(LANDSCAPE, FRAME), 2556 / 3024);
    close(coverScale({ width: 1000, height: 5000 }, FRAME), 1179 / 1000);
  });

  it('видимая часть: при 1× по высоте — всё фото, при 2× — половина', () => {
    const v1 = visibleSize(LANDSCAPE, FRAME, 1);
    close(v1.height, 3024);
    close(v1.width, (1179 * 3024) / 2556);
    const v2 = visibleSize(LANDSCAPE, FRAME, 2);
    close(v2.height, 1512);
  });

  it('совпадает с computeCoverRect рендерера', () => {
    for (const crop of [
      { centerX: 0.5, centerY: 0.5, scale: 1 },
      { centerX: 0.1, centerY: 0.9, scale: 2.5 },
      { centerX: 0.8, centerY: 0.3, scale: 4 },
    ]) {
      const a = cropSourceRect(LANDSCAPE, FRAME, crop);
      const b = computeCoverRect(LANDSCAPE.width, LANDSCAPE.height, FRAME.width, FRAME.height, crop);
      close(a.sx, b.sx, 4);
      close(a.sy, b.sy, 4);
      close(a.sw, b.sw, 4);
      close(a.sh, b.sh, 4);
    }
  });
});

describe('ограничения', () => {
  it('масштаб 1–4×, центр — так, чтобы кадр не выходил за края', () => {
    expect(clampCrop(LANDSCAPE, FRAME, { centerX: 0.5, centerY: 0.5, scale: 9 }).scale).toBe(4);
    expect(clampCrop(LANDSCAPE, FRAME, { centerX: 0.5, centerY: 0.5, scale: 0.2 }).scale).toBe(1);
    const c = clampCrop(LANDSCAPE, FRAME, { centerX: 0, centerY: 0, scale: 1 });
    const v = visibleSize(LANDSCAPE, FRAME, 1);
    close(c.centerX, v.width / 2 / LANDSCAPE.width);
    // При 1× по вертикали видно всё фото — центр по Y только 0,5.
    close(c.centerY, 0.5);
    expect(clampCrop(LANDSCAPE, FRAME, { centerX: Number.NaN, centerY: 0.5, scale: Number.NaN })).toMatchObject({ centerX: 0.5, scale: 1 });
  });
});

describe('сдвиг пальцем: фото точно под пальцем', () => {
  it('точка фото под пальцем остаётся под ним после сдвига', () => {
    const start = { centerX: 0.5, centerY: 0.5, scale: 1.5 };
    const finger = { x: 120, y: 300 };
    const under = imagePointAt(LANDSCAPE, FRAME, start, VIEW, finger);
    const delta = { x: 40, y: -25 };
    const moved = panCropBy(LANDSCAPE, FRAME, start, VIEW, delta);
    expect(moved.edge).toBe(false);
    const after = imagePointAt(LANDSCAPE, FRAME, moved.crop, VIEW, { x: finger.x + delta.x, y: finger.y + delta.y });
    close(after.x, under.x, 4);
    close(after.y, under.y, 4);
  });

  it('учитывает фактический масштаб cover: тот же жест на большем фото — тот же сдвиг на экране', () => {
    const big = { width: LANDSCAPE.width * 2, height: LANDSCAPE.height * 2 };
    const a = panCropBy(LANDSCAPE, FRAME, { centerX: 0.5, centerY: 0.5, scale: 1 }, VIEW, { x: 30, y: 0 });
    const b = panCropBy(big, FRAME, { centerX: 0.5, centerY: 0.5, scale: 1 }, VIEW, { x: 30, y: 0 });
    close(a.crop.centerX, b.crop.centerX);
  });

  it('упирается в край картинки', () => {
    const r = panCropBy(LANDSCAPE, FRAME, { centerX: 0.5, centerY: 0.5, scale: 1 }, VIEW, { x: 5000, y: 0 });
    expect(r.edge).toBe(true);
    const v = visibleSize(LANDSCAPE, FRAME, 1);
    close(r.crop.centerX, v.width / 2 / LANDSCAPE.width);
    // Вертикальный сдвиг при 1× невозможен (фото по высоте целиком).
    const y = panCropBy(LANDSCAPE, FRAME, { centerX: 0.5, centerY: 0.5, scale: 1 }, VIEW, { x: 0, y: 100 });
    expect(y.edge).toBe(true);
    close(y.crop.centerY, 0.5);
  });
});

describe('масштаб от точки', () => {
  it('точка под курсором остаётся на месте', () => {
    const start = { centerX: 0.5, centerY: 0.5, scale: 1.2 };
    const anchor = { x: 200, y: 260 };
    const before = imagePointAt(LANDSCAPE, FRAME, start, VIEW, anchor);
    const r = zoomCropAt(LANDSCAPE, FRAME, start, VIEW, 1.5, anchor);
    expect(r.scaleLimited).toBe(false);
    close(r.crop.scale, 1.8);
    const after = imagePointAt(LANDSCAPE, FRAME, r.crop, VIEW, anchor);
    close(after.x, before.x, 4);
    close(after.y, before.y, 4);
  });

  it('предел 4× и 1× — scaleLimited', () => {
    const up = zoomCropAt(LANDSCAPE, FRAME, { centerX: 0.5, centerY: 0.5, scale: 3.5 }, VIEW, 2, { x: 150, y: 325 });
    expect(up.crop.scale).toBe(4);
    expect(up.scaleLimited).toBe(true);
    const down = zoomCropAt(LANDSCAPE, FRAME, { centerX: 0.5, centerY: 0.5, scale: 1 }, VIEW, 0.5, { x: 150, y: 325 });
    expect(down.crop.scale).toBe(1);
    expect(down.scaleLimited).toBe(true);
  });

  it('щипок: точка между пальцами следует за пальцами', () => {
    const start = { centerX: 0.5, centerY: 0.5, scale: 1 };
    const s = { center: { x: 150, y: 300 }, distance: 100 };
    const now = { center: { x: 170, y: 280 }, distance: 180 };
    const before = imagePointAt(LANDSCAPE, FRAME, start, VIEW, s.center);
    const r = pinchCrop(LANDSCAPE, FRAME, start, VIEW, s, now);
    close(r.crop.scale, 1.8);
    const after = imagePointAt(LANDSCAPE, FRAME, r.crop, VIEW, now.center);
    close(after.x, before.x, 3);
    close(after.y, before.y, 3);
  });

  it('колесо: вверх — приблизить, Ctrl+колесо — мельче шаг', () => {
    expect(wheelZoomFactor(-100, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, false)).toBeLessThan(1);
    expect(wheelZoomFactor(-10, true)).toBeGreaterThan(wheelZoomFactor(-10, false));
    expect(wheelZoomFactor(-3, false, 1)).toBeCloseTo(wheelZoomFactor(-48, false));
  });
});

describe('вспомогательное', () => {
  it('вид вписывается в область с пропорциями профиля', () => {
    expect(fitView(FRAME, { width: 393, height: 600 })).toEqual({ width: 276, height: 600 });
    expect(fitView(FRAME, { width: 200, height: 2000 })).toEqual({ width: 200, height: 433 });
    expect(fitView(FRAME, { width: 0, height: 100 })).toEqual({ width: 0, height: 0 });
  });

  it('кадр по умолчанию', () => {
    expect(isDefaultCrop({ centerX: 0.5, centerY: 0.5, scale: 1 })).toBe(true);
    expect(isDefaultCrop({ centerX: 0.5, centerY: 0.5, scale: 1.1 })).toBe(false);
  });
});
