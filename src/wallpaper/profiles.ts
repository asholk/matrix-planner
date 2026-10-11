/**
 * Профили устройств и безопасные зоны обоев (ТЗ §4.5). Чистый модуль.
 * Размер — `screen × devicePixelRatio` в портретной ориентации; профиль — имя папки в `Обои/`.
 */

import type { WallpaperLayoutPreset, WallpaperProfile, WallpaperProfileSetting } from '../model/types';

/**
 * Верх контента при ряде виджетов под часами: 0–31 % высоты — дата, часы, виджеты iOS
 * (как в LockDay: лента недели начинается на ~31 %).
 */
export const SAFE_TOP = 0.31;
/** Без виджетов под часами контент поднимается на высоту ряда виджетов: ~27 %. */
export const WIDGETS_ROW = 0.04;
/** Предпочтительный низ контента: ниже ~70 % — уведомления iOS. */
export const NOTIFICATIONS_TOP = 0.7;
/** Абсолютный предел контента: 84–100 % — фонарик, камера, полоска «Домой». */
export const SAFE_BOTTOM = 0.84;

/** Допуск сравнения размеров при округлении `screen × dpr`. */
const SIZE_TOLERANCE = 2;

function iphone(width: number, height: number, label: string): WallpaperProfile {
  return { id: `iphone-${width}x${height}`, label, width, height, safeTop: SAFE_TOP, safeBottom: SAFE_BOTTOM };
}

/** Известные профили iPhone (уникальные разрешения). */
export const KNOWN_PROFILES: readonly WallpaperProfile[] = [
  iphone(750, 1334, 'iPhone SE, 8'),
  iphone(828, 1792, 'iPhone 11, XR'),
  iphone(1125, 2436, 'iPhone 11 Pro, XS, X'),
  iphone(1242, 2688, 'iPhone 11 Pro Max, XS Max'),
  iphone(1080, 2340, 'iPhone 13 mini, 12 mini'),
  iphone(1170, 2532, 'iPhone 14, 13, 13 Pro, 12, 12 Pro'),
  iphone(1284, 2778, 'iPhone 14 Plus, 13 Pro Max, 12 Pro Max'),
  iphone(1179, 2556, 'iPhone 16, 15, 15 Pro, 14 Pro'),
  iphone(1290, 2796, 'iPhone 16 Plus, 15 Plus, 15 Pro Max, 14 Pro Max'),
  iphone(1206, 2622, 'iPhone 17, 16 Pro'),
  iphone(1320, 2868, 'iPhone 17 Pro Max, 16 Pro Max'),
];

/** Профиль по умолчанию, если размер экрана неизвестен (iPhone 15 Pro). */
export const DEFAULT_PROFILE_ID = 'iphone-1179x2556';

export function getProfileById(id: string): WallpaperProfile | null {
  return KNOWN_PROFILES.find((p) => p.id === id) ?? null;
}

export function defaultProfile(): WallpaperProfile {
  // Профиль по умолчанию всегда есть в списке.
  return getProfileById(DEFAULT_PROFILE_ID) as WallpaperProfile;
}

/** Размер в пикселях устройства, портретная ориентация. */
export function screenPixelSize(screenWidth: number, screenHeight: number, devicePixelRatio: number): {
  width: number;
  height: number;
} {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const a = Math.round(screenWidth * dpr);
  const b = Math.round(screenHeight * dpr);
  return { width: Math.min(a, b), height: Math.max(a, b) };
}

/** Профиль произвольного размера (Android, iPad, компьютер). */
export function customProfile(width: number, height: number): WallpaperProfile {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return { id: `screen-${w}x${h}`, label: `${w} × ${h}`, width: w, height: h, safeTop: SAFE_TOP, safeBottom: SAFE_BOTTOM };
}

/** Известный профиль с размером в пределах допуска или `null`. */
export function findProfileBySize(width: number, height: number): WallpaperProfile | null {
  return (
    KNOWN_PROFILES.find(
      (p) => Math.abs(p.width - width) <= SIZE_TOLERANCE && Math.abs(p.height - height) <= SIZE_TOLERANCE,
    ) ?? null
  );
}

export interface ScreenInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

/** Автоматический профиль по `screen × devicePixelRatio`. */
export function detectProfile(screen: ScreenInfo | null): WallpaperProfile {
  if (!screen || !(screen.width > 0) || !(screen.height > 0)) return defaultProfile();
  const size = screenPixelSize(screen.width, screen.height, screen.devicePixelRatio);
  return findProfileBySize(size.width, size.height) ?? customProfile(size.width, size.height);
}

/** Разбирает id вида `iphone-1179x2556` / `screen-1080x2400`. */
export function parseProfileId(id: string): WallpaperProfile | null {
  const known = getProfileById(id);
  if (known) return known;
  const match = /^[a-z][a-z0-9]*-(\d{2,5})x(\d{2,5})$/.exec(id);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width >= height) return null;
  return { ...customProfile(width, height), id };
}

export interface ResolveProfileOptions {
  /**
   * Телефон или планшет. На компьютере размер монитора бессмыслен для экрана
   * блокировки, поэтому `auto` даёт профиль по умолчанию (iPhone 15 Pro).
   * По умолчанию `true`.
   */
  mobile?: boolean;
}

/** Профиль по настройке: `auto` — по экрану (на компьютере — по умолчанию), иначе выбранный вручную (неизвестный id → авто). */
export function resolveProfile(
  setting: WallpaperProfileSetting,
  screen: ScreenInfo | null,
  options: ResolveProfileOptions = {},
): WallpaperProfile {
  if (setting !== 'auto') {
    const manual = parseProfileId(setting);
    if (manual) return manual;
  }
  if (options.mobile === false) return defaultProfile();
  return detectProfile(screen);
}

/** Область контента в пикселях. */
export interface ContentBand {
  /** Верх контента (под часами и виджетами). */
  top: number;
  /** Предпочтительный низ: зона уведомлений iOS свободна. */
  softBottom: number;
  /** Абсолютный предел (фонарик и камера). */
  bottom: number;
}

/**
 * Область контента между безопасными зонами. `no-widgets` поднимает верх на
 * высоту ряда виджетов; предпочтительный низ — верх зоны уведомлений.
 */
export function contentBand(profile: WallpaperProfile, preset: WallpaperLayoutPreset = 'widgets'): ContentBand {
  const safeTop = Math.max(0, clamp01(profile.safeTop) - (preset === 'no-widgets' ? WIDGETS_ROW : 0));
  const safeBottom = Math.max(safeTop, clamp01(profile.safeBottom));
  const soft = Math.min(safeBottom, Math.max(safeTop, NOTIFICATIONS_TOP));
  const top = Math.ceil(profile.height * safeTop);
  const bottom = Math.max(top, Math.floor(profile.height * safeBottom));
  return { top, softBottom: Math.min(bottom, Math.max(top, Math.floor(profile.height * soft))), bottom };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
