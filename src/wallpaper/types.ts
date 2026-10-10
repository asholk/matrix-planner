/**
 * Внутренние типы раскладки обоев (S2.T4). Общие типы (`WallpaperLayoutInput`,
 * `DrawCommand`, `WallpaperProfile`) — в `src/model/types.ts`.
 */

import type { TextMeasurer } from '../app/contracts';
import type {
  DrawCommand,
  FontSpec,
  WallpaperLayoutInput,
  WallpaperPalette,
  WallpaperStrings,
} from '../model/types';

/** Цвет RGBA: каналы 0–255, альфа 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Описание палитры до проверки контраста. */
export interface PaletteSpec {
  id: WallpaperPalette;
  /** Фон карточек (может быть полупрозрачным). */
  card: string;
  /** Подложка, худшая для контраста (через неё просвечивает карточка). */
  worstBackdrop: string;
  text: string;
  secondary: string;
}

/** Палитра после расчёта: все цвета текста дают контраст ≥ 4,5:1 с `cardEffective`. */
export interface ResolvedPalette {
  id: WallpaperPalette;
  card: string;
  /** Непрозрачный цвет карточки поверх худшей подложки — база для расчёта контраста. */
  cardEffective: string;
  text: string;
  secondary: string;
  /** Дорожка прогресс-бара и разделители (не текст). */
  track: string;
}

/** Цвета плашки события/задачи. */
export interface PillColors {
  fill: string;
  text: string;
  /** Цвет кружка задачи или полоски события. */
  marker: string;
}

/**
 * Дополнительные строки, которых нет в общем `WallpaperStrings`.
 * Необязательные: без них раскладка использует запасной вариант.
 */
export interface WallpaperStringsExtra {
  /** «Осталось 83 дня». */
  daysLeft?(count: number): string;
}

export type WallpaperLayoutStrings = WallpaperStrings & WallpaperStringsExtra;

/** Прямоугольник в пикселях холста. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Контекст отрисовки шаблона: единица масштаба, палитра и накопитель команд. */
export interface LayoutContext {
  input: WallpaperLayoutInput;
  strings: WallpaperLayoutStrings;
  measurer: TextMeasurer;
  /** Пикселей холста на одну точку макета. */
  unit: number;
  palette: ResolvedPalette;
  commands: DrawCommand[];
  overflow: Record<string, number>;
  /** Шрифт размером `sizePt` точек макета. */
  font(sizePt: number, weight?: FontSpec['weight']): FontSpec;
  /** Цвет акцентного текста (заголовок квадранта, срок), читаемый на карточке. */
  accent(color: string): string;
  /** Цвета плашки: `solid` — залитая цветом (событие на весь день). */
  pill(color: string, solid: boolean): PillColors;
  /** Чёрный или белый текст поверх заливки `color`. */
  onFill(color: string): string;
}

/** Шаблон: высота в точках макета и отрисовка в область. */
export interface TemplateLayout {
  /** Естественная высота содержимого в точках при ширине `widthPt`. */
  naturalHeight(input: WallpaperLayoutInput, widthPt: number): number;
  draw(ctx: LayoutContext, area: Box): void;
}
