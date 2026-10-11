/**
 * Математика кадра фона обоев (доработка 007, п.14 и мини-редактор композиции).
 * Чистый модуль: без `obsidian` и DOM.
 *
 * Кадр (`WallpaperCrop`) — центр видимой области в долях картинки и масштаб ≥ 1
 * поверх режима cover. Вид — область экрана, где кадр показан целиком
 * (размер в CSS px, пропорции профиля). Жесты пересчитываются от состояния
 * на начало жеста, поэтому фото остаётся точно под пальцем и не «плывёт».
 */

import type { WallpaperCrop } from '../model/types';

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Пределы масштаба кадра (как у черновика редактора). */
export const CROP_SCALE_MIN = 1;
export const CROP_SCALE_MAX = 4;

export const DEFAULT_CROP: Readonly<WallpaperCrop> = { centerX: 0.5, centerY: 0.5, scale: 1 };

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Масштаб cover: во сколько раз картинка растягивается, чтобы закрыть кадр целиком. */
export function coverScale(image: Size, frame: Size): number {
  if (!(image.width > 0 && image.height > 0)) return 1;
  return Math.max(frame.width / image.width, frame.height / image.height);
}

/** Размер видимой части картинки (в пикселях картинки) при масштабе кадра `scale`. */
export function visibleSize(image: Size, frame: Size, scale: number): Size {
  const k = coverScale(image, frame) * clamp(finite(scale, 1), CROP_SCALE_MIN, CROP_SCALE_MAX);
  return { width: Math.min(image.width, frame.width / k), height: Math.min(image.height, frame.height / k) };
}

/**
 * Кадр в допустимых пределах: масштаб 1–4, видимая часть не выходит за края
 * картинки (центр не ближе половины видимой области к краю).
 */
export function clampCrop(image: Size, frame: Size, crop: WallpaperCrop): WallpaperCrop {
  const scale = clamp(finite(crop.scale, 1), CROP_SCALE_MIN, CROP_SCALE_MAX);
  if (!(image.width > 0 && image.height > 0)) return { centerX: 0.5, centerY: 0.5, scale };
  const visible = visibleSize(image, frame, scale);
  const halfX = visible.width / 2 / image.width;
  const halfY = visible.height / 2 / image.height;
  return {
    centerX: clamp(finite(crop.centerX, 0.5), halfX, 1 - halfX),
    centerY: clamp(finite(crop.centerY, 0.5), halfY, 1 - halfY),
    scale,
  };
}

/** Видимая часть картинки (пиксели картинки) — для `drawImage(img, sx, sy, sw, sh, …)`. */
export function cropSourceRect(image: Size, frame: Size, crop: WallpaperCrop): { sx: number; sy: number; sw: number; sh: number } {
  const c = clampCrop(image, frame, crop);
  const visible = visibleSize(image, frame, c.scale);
  return { sx: c.centerX * image.width - visible.width / 2, sy: c.centerY * image.height - visible.height / 2, sw: visible.width, sh: visible.height };
}

/** Точка картинки (пиксели картинки) под точкой вида `point` (CSS px от левого верхнего угла вида). */
export function imagePointAt(image: Size, frame: Size, crop: WallpaperCrop, view: Size, point: Point): Point {
  const r = cropSourceRect(image, frame, crop);
  return { x: r.sx + (point.x / view.width) * r.sw, y: r.sy + (point.y / view.height) * r.sh };
}

export interface CropChange {
  crop: WallpaperCrop;
  /** Сдвиг упёрся в край картинки. */
  edge: boolean;
  /** Масштаб упёрся в предел 1× или 4×. */
  scaleLimited: boolean;
}

/**
 * Сдвиг пальцем на `delta` CSS px вида: картинка едет вместе с пальцем.
 * Пиксель вида = `visible / view` пикселей картинки (с учётом cover и масштаба).
 */
export function panCropBy(image: Size, frame: Size, crop: WallpaperCrop, view: Size, delta: Point): CropChange {
  const start = clampCrop(image, frame, crop);
  if (!(view.width > 0 && view.height > 0) || !(image.width > 0 && image.height > 0)) return { crop: start, edge: false, scaleLimited: false };
  const visible = visibleSize(image, frame, start.scale);
  const wanted = {
    centerX: start.centerX - (finite(delta.x, 0) * visible.width) / view.width / image.width,
    centerY: start.centerY - (finite(delta.y, 0) * visible.height) / view.height / image.height,
    scale: start.scale,
  };
  const next = clampCrop(image, frame, wanted);
  const edge = Math.abs(next.centerX - wanted.centerX) > 1e-9 || Math.abs(next.centerY - wanted.centerY) > 1e-9;
  return { crop: next, edge, scaleLimited: false };
}

/**
 * Масштаб в `factor` раз относительно точки вида `anchor` (точка между пальцами
 * или курсор): точка картинки под ней остаётся на месте (если не мешают края).
 */
export function zoomCropAt(image: Size, frame: Size, crop: WallpaperCrop, view: Size, factor: number, anchor: Point): CropChange {
  const start = clampCrop(image, frame, crop);
  if (!(view.width > 0 && view.height > 0) || !(image.width > 0 && image.height > 0)) return { crop: start, edge: false, scaleLimited: false };
  const wantedScale = start.scale * (Number.isFinite(factor) && factor > 0 ? factor : 1);
  const scale = clamp(wantedScale, CROP_SCALE_MIN, CROP_SCALE_MAX);
  const scaleLimited = Math.abs(scale - wantedScale) > 1e-9;
  const fixed = imagePointAt(image, frame, start, view, anchor);
  const visible = visibleSize(image, frame, scale);
  const sx = fixed.x - (anchor.x / view.width) * visible.width;
  const sy = fixed.y - (anchor.y / view.height) * visible.height;
  const wanted = { centerX: (sx + visible.width / 2) / image.width, centerY: (sy + visible.height / 2) / image.height, scale };
  const next = clampCrop(image, frame, wanted);
  const edge = Math.abs(next.centerX - wanted.centerX) > 1e-9 || Math.abs(next.centerY - wanted.centerY) > 1e-9;
  return { crop: next, edge, scaleLimited };
}

/**
 * Щипок двумя пальцами: от кадра на начало жеста — масштаб `distance/startDistance`
 * от исходной точки между пальцами, затем сдвиг вслед за этой точкой.
 * Точка картинки, бывшая между пальцами, остаётся между ними.
 */
export function pinchCrop(
  image: Size,
  frame: Size,
  startCrop: WallpaperCrop,
  view: Size,
  start: { center: Point; distance: number },
  current: { center: Point; distance: number },
): CropChange {
  const factor = start.distance > 0 && current.distance > 0 ? current.distance / start.distance : 1;
  const zoomed = zoomCropAt(image, frame, startCrop, view, factor, start.center);
  const panned = panCropBy(image, frame, zoomed.crop, view, { x: current.center.x - start.center.x, y: current.center.y - start.center.y });
  return { crop: panned.crop, edge: zoomed.edge || panned.edge, scaleLimited: zoomed.scaleLimited };
}

/** Колесо мыши: Ctrl+колесо (щипок на трекпаде) — мельче шаг, обычное колесо — крупнее. */
export function wheelZoomFactor(deltaY: number, ctrlKey: boolean, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const k = ctrlKey ? 0.01 : 0.0015;
  return Math.exp(-clamp(finite(pixels, 0), -400, 400) * k);
}

/** Кадр по умолчанию: вписать по центру без увеличения. */
export function isDefaultCrop(crop: WallpaperCrop): boolean {
  return Math.abs(crop.scale - 1) < 1e-4 && Math.abs(crop.centerX - 0.5) < 1e-4 && Math.abs(crop.centerY - 0.5) < 1e-4;
}

/** Одинаковые кадры с точностью до округления черновика. */
export function sameCrop(a: WallpaperCrop, b: WallpaperCrop): boolean {
  return Math.abs(a.scale - b.scale) < 1e-4 && Math.abs(a.centerX - b.centerX) < 1e-4 && Math.abs(a.centerY - b.centerY) < 1e-4;
}

/** Размер вида с пропорциями `frame`, вписанный в `box`. */
export function fitView(frame: Size, box: Size): Size {
  if (!(frame.width > 0 && frame.height > 0) || !(box.width > 0 && box.height > 0)) return { width: 0, height: 0 };
  const k = Math.min(box.width / frame.width, box.height / frame.height);
  return { width: Math.floor(frame.width * k), height: Math.floor(frame.height * k) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
