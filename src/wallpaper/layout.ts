/**
 * Раскладка обоев (ТЗ §4.5): выбор шаблона, масштаб под профиль и безопасные зоны,
 * палитры и контраст текста (WCAG, ≥ 4,5:1). Чистый модуль: без `obsidian` и DOM.
 */

import type { TextMeasurer, WallpaperLayoutFn } from '../app/contracts';
import type {
  FloatingDateTime,
  FontSpec,
  LocalDateString,
  QuadrantKey,
  WallpaperLayout,
  WallpaperLayoutInput,
  WallpaperPalette,
} from '../model/types';
import { QUADRANT_KEYS } from '../model/types';
import { contentBand } from './profiles';
import { calendarTemplate } from './calendar-layout';
import { BLOCK_GAP_PT, emitCard, emitText, matrixTemplate } from './matrix-layout';
import type {
  Box,
  LayoutContext,
  PaletteSpec,
  PillColors,
  ResolvedPalette,
  Rgba,
  TemplateLayout,
  WallpaperLayoutStrings,
} from './types';

/** Минимальный контраст текста (WCAG AA для обычного текста). */
export const MIN_TEXT_CONTRAST = 4.5;

/** Ширина макета в точках (логическая ширина iPhone); масштаб — `profile.width / 390`. */
export const BASE_WIDTH_PT = 390;
/** Боковые поля и предельная ширина содержимого в точках. */
export const SIDE_MARGIN_PT = 16;
export const MAX_CONTENT_WIDTH_PT = 430;
/** Отступ содержимого от верхней безопасной зоны. */
export const TOP_GAP_PT = 6;

// ---------------------------------------------------------------------------
// Цвета
// ---------------------------------------------------------------------------

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** Разбор `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`; иначе `null`. */
export function parseColor(value: string): Rgba | null {
  const s = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = Array.from(h).map((c) => parseInt(c + c, 16));
      return { r, g, b, a: a === undefined ? 1 : a / 255 };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (fn) {
    let a = 1;
    if (fn[4] !== undefined) a = fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
    return { r: clampByte(+fn[1]), g: clampByte(+fn[2]), b: clampByte(+fn[3]), a: Math.min(1, Math.max(0, a)) };
  }
  return null;
}

function toHex(c: Rgba): string {
  const h = (n: number): string => clampByte(n).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

/** Непрозрачный результат наложения `top` поверх `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** Смешение цветов: `amount` — доля `a` (0–1). Результат непрозрачный, `#RRGGBB`. */
export function mixColors(a: string, b: string, amount: number): string {
  const ca = parseColor(a) ?? { r: 0, g: 0, b: 0, a: 1 };
  const cb = parseColor(b) ?? { r: 0, g: 0, b: 0, a: 1 };
  return toHex({
    r: ca.r * amount + cb.r * (1 - amount),
    g: ca.g * amount + cb.g * (1 - amount),
    b: ca.b * amount + cb.b * (1 - amount),
    a: 1,
  });
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Относительная яркость WCAG 2.x. */
export function relativeLuminance(color: Rgba): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * Контраст WCAG (1–21). Полупрозрачный `foreground` накладывается на `background`,
 * полупрозрачный `background` — на чёрный (передавайте уже скомпонованный фон).
 */
export function contrastRatio(foreground: string, background: string): number {
  const bgRaw = parseColor(background) ?? { r: 0, g: 0, b: 0, a: 1 };
  const bg = composite(bgRaw, { r: 0, g: 0, b: 0, a: 1 });
  const fgRaw = parseColor(foreground) ?? { r: 0, g: 0, b: 0, a: 1 };
  const fg = composite(fgRaw, bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Подбирает цвет, близкий к `color`, с контрастом не ниже `min` на `background`:
 * смешивает с белым или чёрным (в сторону большего контраста).
 */
export function ensureContrast(color: string, background: string, min = MIN_TEXT_CONTRAST): string {
  const base = parseColor(color);
  if (!base) return bestOnFill(background);
  const opaque = toHex(composite(base, parseColor(background) ?? { r: 0, g: 0, b: 0, a: 1 }));
  if (contrastRatio(opaque, background) >= min) return opaque;
  const target = contrastRatio('#FFFFFF', background) >= contrastRatio('#000000', background) ? '#FFFFFF' : '#000000';
  for (let step = 1; step <= 20; step++) {
    const candidate = mixColors(target, opaque, step / 20);
    if (contrastRatio(candidate, background) >= min) return candidate;
  }
  return target;
}

/** Белый или чёрный — что контрастнее на заливке. */
export function bestOnFill(fill: string): string {
  return contrastRatio('#FFFFFF', fill) >= contrastRatio('#000000', fill) ? '#FFFFFF' : '#000000';
}

// ---------------------------------------------------------------------------
// Палитры (тёмная, светлая, полупрозрачная)
// ---------------------------------------------------------------------------

export const PALETTE_SPECS: Readonly<Record<WallpaperPalette, PaletteSpec>> = {
  // Худшая подложка для светлого текста — белый фон под карточкой.
  dark: { id: 'dark', card: 'rgba(22, 22, 24, 0.82)', worstBackdrop: '#FFFFFF', text: '#FFFFFF', secondary: '#AEAEB2' },
  light: { id: 'light', card: 'rgba(255, 255, 255, 0.86)', worstBackdrop: '#000000', text: '#1C1C1E', secondary: '#5C5C61' },
  // Минимальная непрозрачность, при которой белый текст даёт 4,5:1 даже над белым фоном.
  translucent: {
    id: 'translucent',
    card: 'rgba(0, 0, 0, 0.56)',
    worstBackdrop: '#FFFFFF',
    text: '#FFFFFF',
    secondary: '#D1D1D6',
  },
};

/** Палитра с цветами текста, гарантирующими контраст на карточке над любым фоном. */
export function resolvePalette(id: WallpaperPalette): ResolvedPalette {
  const spec = PALETTE_SPECS[id] ?? PALETTE_SPECS.dark;
  const card = parseColor(spec.card) ?? { r: 0, g: 0, b: 0, a: 1 };
  const backdrop = parseColor(spec.worstBackdrop) ?? { r: 255, g: 255, b: 255, a: 1 };
  const cardEffective = toHex(composite(card, backdrop));
  const text = ensureContrast(spec.text, cardEffective);
  return {
    id: spec.id,
    card: spec.card,
    cardEffective,
    text,
    secondary: ensureContrast(spec.secondary, cardEffective),
    track: mixColors(text, cardEffective, 0.22),
  };
}

// ---------------------------------------------------------------------------
// Контекст и выбор шаблона
// ---------------------------------------------------------------------------

const TEMPLATES: Readonly<Record<WallpaperLayoutInput['template'], TemplateLayout>> = {
  matrix: matrixTemplate,
  calendar: calendarTemplate,
};

/** Контекст отрисовки (экспортируется для тестов контраста). */
export function createLayoutContext(
  input: WallpaperLayoutInput,
  measurer: TextMeasurer,
  unit: number,
  palette: ResolvedPalette,
): LayoutContext {
  const accentCache = new Map<string, string>();
  const accent = (color: string): string => {
    let value = accentCache.get(color);
    if (value === undefined) {
      value = ensureContrast(parseColor(color) ? color : palette.secondary, palette.cardEffective);
      accentCache.set(color, value);
    }
    return value;
  };
  const pill = (color: string, solid: boolean): PillColors => {
    const base = parseColor(color) ? toHex(composite(parseColor(color) as Rgba, parseColor(palette.cardEffective) as Rgba)) : palette.secondary;
    if (solid) {
      const text = ensureContrast(bestOnFill(base), base);
      return { fill: base, text, marker: text };
    }
    const fill = mixColors(base, palette.cardEffective, palette.id === 'light' ? 0.18 : 0.3);
    return { fill, text: ensureContrast(palette.text, fill), marker: ensureContrast(base, fill, 3) };
  };
  return {
    input,
    strings: input.strings,
    measurer,
    unit,
    palette,
    commands: [],
    overflow: {},
    font: (sizePt: number, weight: FontSpec['weight'] = 400): FontSpec => ({
      size: Math.max(1, Math.round(sizePt * unit * 10) / 10),
      weight,
      family: null,
    }),
    accent,
    pill,
    onFill: (color: string) => {
      const base = parseColor(color) ? toHex(composite(parseColor(color) as Rgba, parseColor(palette.cardEffective) as Rgba)) : palette.secondary;
      return ensureContrast(bestOnFill(base), base);
    },
  };
}

/**
 * Наименьшая доля базового масштаба, до которой содержимое сжимается, чтобы
 * не заходить в зону уведомлений (ниже — содержимое опускается до абсолютного предела).
 */
export const MIN_SOFT_SCALE = 0.75;
/** Высота плашки «Обои устарели» в точках макета. */
export const EXPIRED_NOTICE_PT = 30;

/** Полная высота содержимого в точках: шаблон, плашка «устарели» и отступ сверху. */
export function contentHeightPt(input: WallpaperLayoutInput, template: TemplateLayout, widthPt: number): number {
  const notice = input.expired ? EXPIRED_NOTICE_PT + BLOCK_GAP_PT : 0;
  return template.naturalHeight(input, widthPt) + notice + TOP_GAP_PT;
}

function contentWidthPt(profileWidth: number, unit: number): number {
  return Math.min(profileWidth / unit - 2 * SIDE_MARGIN_PT, MAX_CONTENT_WIDTH_PT);
}

/** Наибольший масштаб (не больше `base`), при котором содержимое помещается в `available` пикселей. */
function fitUnit(input: WallpaperLayoutInput, template: TemplateLayout, base: number, available: number): number {
  let unit = base;
  for (let pass = 0; pass < 3; pass++) {
    const heightPt = contentHeightPt(input, template, contentWidthPt(input.profile.width, unit));
    if (heightPt * unit <= available) break;
    unit = available / heightPt;
  }
  return unit;
}

/**
 * Масштаб и область (доработка 007, композиция как в LockDay): ширина профиля → 390 точек,
 * верх — под часами (и виджетами), низ — не ниже начала зоны уведомлений (~70 %).
 * Если не помещается даже при сжатии до `MIN_SOFT_SCALE`, содержимое опускается
 * до абсолютного предела (84 %) и при необходимости сжимается дальше.
 */
export function computeScale(input: WallpaperLayoutInput, template: TemplateLayout): {
  unit: number;
  area: Box;
} {
  const { profile } = input;
  const band = contentBand(profile, input.layoutPreset ?? 'widgets');
  const base = profile.width / BASE_WIDTH_PT;
  const soft = fitUnit(input, template, base, Math.max(1, band.softBottom - band.top));
  let unit = soft;
  if (soft < base * MIN_SOFT_SCALE) {
    const hard = fitUnit(input, template, base, Math.max(1, band.bottom - band.top));
    unit = Math.max(soft, Math.min(base * MIN_SOFT_SCALE, hard));
  }
  const w = contentWidthPt(profile.width, unit) * unit;
  return {
    unit,
    area: { x: (profile.width - w) / 2, y: band.top + TOP_GAP_PT * unit, w, h: band.bottom - band.top - TOP_GAP_PT * unit },
  };
}

/** Плашка «Обои устарели — откройте Obsidian» над шаблоном. */
function drawExpiredNotice(ctx: LayoutContext, box: Box): void {
  const u = ctx.unit;
  emitCard(ctx, box);
  const color = ctx.accent('#FFD60A');
  const iconSize = 14 * u;
  const cy = box.y + box.h / 2;
  const text = ctx.strings.expiredNotice ?? 'Wallpaper is out of date — open Obsidian';
  const font = ctx.font(12.5, 600);
  const textW = Math.min(box.w - 24 * u - iconSize - 6 * u, ctx.measurer.measure(text, font).width);
  const startX = box.x + (box.w - (iconSize + 6 * u + textW)) / 2;
  ctx.commands.push({ op: 'icon', name: 'alert-triangle', x: startX, y: cy - iconSize / 2, size: iconSize, color });
  emitText(ctx, text, startX + iconSize + 6 * u, cy, { font, color, maxWidth: Math.max(0, textW + 1) });
}

/** Чистая раскладка шаблона → команды рисования. */
export const layoutWallpaper: WallpaperLayoutFn = (input: WallpaperLayoutInput, measurer: TextMeasurer): WallpaperLayout => {
  const template = TEMPLATES[input.template] ?? matrixTemplate;
  const { unit, area } = computeScale(input, template);
  const ctx = createLayoutContext(input, measurer, unit, resolvePalette(input.palette));
  let templateArea = area;
  if (input.expired) {
    const noticeH = EXPIRED_NOTICE_PT * unit;
    drawExpiredNotice(ctx, { x: area.x, y: area.y, w: area.w, h: noticeH });
    const shift = noticeH + BLOCK_GAP_PT * unit;
    templateArea = { ...area, y: area.y + shift, h: area.h - shift };
  }
  template.draw(ctx, templateArea);
  return { width: input.profile.width, height: input.profile.height, commands: ctx.commands, overflow: ctx.overflow };
};

// ---------------------------------------------------------------------------
// Локализованные строки
// ---------------------------------------------------------------------------

/** Префикс ключей словаря `wallpaperLayout` (`src/i18n/{ru,en}/wallpaper-layout.ts`). */
export const WALLPAPER_LAYOUT_MODULE = 'wallpaperLayout';

export interface WallpaperStringsDeps {
  translate(key: string, params?: Record<string, string | number>): string;
  translatePlural(key: string, count: number): string;
  /** Подпись срока, например через `formatDueLabel` из `src/model/dates.ts`. */
  formatDue: (due: FloatingDateTime, relativeTo: LocalDateString, duration?: number | null) => string;
}

/** Собирает строки раскладки через переданные функции перевода (`t`, `tPlural`); названия квадрантов — `common.quadrants`. */
export function createWallpaperStrings(deps: WallpaperStringsDeps): WallpaperLayoutStrings {
  const k = (key: string): string => `${WALLPAPER_LAYOUT_MODULE}.${key}`;
  const quadrantTitles = {} as Record<QuadrantKey, string>;
  for (const key of QUADRANT_KEYS) quadrantTitles[key] = deps.translate(`common.quadrants.${key}`);
  const weekdayShort: string[] = [];
  for (let i = 0; i < 7; i++) weekdayShort.push(deps.translate(k(`weekdayShort.d${i}`)));
  const monthNames: string[] = [];
  for (let i = 1; i <= 12; i++) monthNames.push(deps.translate(k(`monthNames.m${i}`)));
  const monthShort: string[] = [];
  for (let i = 1; i <= 12; i++) monthShort.push(deps.translate(k(`monthShort.m${i}`)));
  return {
    quadrantTitles,
    weekdayShort,
    monthNames,
    emptyQuadrant: deps.translate(k('emptyQuadrant')),
    formatDue: deps.formatDue,
    yearProgress: (percent: number) => deps.translate(k('yearProgress'), { percent }),
    moreItems: (count: number) => deps.translate(k('moreItems'), { count }),
    daysLeft: (count: number) => deps.translatePlural(k('daysLeft'), count),
    expiredNotice: deps.translate(k('expired')),
    formatDueDate: (due: FloatingDateTime) => {
      const month = monthShort[Number(due.date.slice(5, 7)) - 1] ?? due.date.slice(5, 7);
      return deps.translate(k('dueDate'), { day: Number(due.date.slice(8, 10)), month });
    },
  };
}
