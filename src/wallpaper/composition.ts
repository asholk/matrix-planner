/**
 * Композиция обоев для макетов поверх фото (кадрировщик): где лягут карточки
 * при текущих шаблоне, профиле и композиции. Геометрия карточек не зависит от
 * задач и событий, поэтому раскладка строится на пустых данных. Чистый модуль.
 */

import type { TextMeasurer } from '../app/contracts';
import { defaultMatrixConfig } from '../model/defaults';
import type { LocalDateString, WallpaperLayoutInput, WallpaperProfile, WallpaperSettings, WeekStartDay } from '../model/types';
import { layoutWallpaper } from './layout';
import type { Box } from './types';

/** Приблизительное измерение текста: для геометрии карточек текст не важен. */
const APPROX_MEASURER: TextMeasurer = {
  measure: (text, font) => ({ width: Array.from(text).length * font.size * 0.55, ascent: font.size * 0.8, descent: font.size * 0.2 }),
};

export interface CardBox extends Box {
  radius: number;
}

/** Прямоугольники карточек (пиксели профиля) для шаблона и композиции из настроек. */
export function layoutCardBoxes(
  settings: Pick<WallpaperSettings, 'template' | 'palette' | 'tasksPerQuadrant' | 'layoutPreset'>,
  profile: WallpaperProfile,
  date: LocalDateString,
  weekStart: WeekStartDay = 1,
): CardBox[] {
  const input: WallpaperLayoutInput = {
    template: settings.template,
    palette: settings.palette,
    profile,
    date,
    weekStart,
    hour12: false,
    tasksPerQuadrant: settings.tasksPerQuadrant,
    matrix: defaultMatrixConfig('ru'),
    tasksByQuadrant: { do: [], plan: [], urgent: [], someday: [] },
    days: new Map(),
    strings: {
      quadrantTitles: { do: '', plan: '', urgent: '', someday: '' },
      weekdayShort: ['', '', '', '', '', '', ''],
      monthNames: Array.from({ length: 12 }, () => ''),
      emptyQuadrant: '',
      formatDue: () => '',
      yearProgress: () => '',
      moreItems: () => '',
    },
    layoutPreset: settings.layoutPreset ?? 'widgets',
  };
  const layout = layoutWallpaper(input, APPROX_MEASURER);
  const boxes: CardBox[] = [];
  for (const command of layout.commands) {
    if (command.op === 'rect' && command.backdrop === 'blur') boxes.push({ x: command.x, y: command.y, w: command.w, h: command.h, radius: command.radius });
  }
  return boxes;
}
