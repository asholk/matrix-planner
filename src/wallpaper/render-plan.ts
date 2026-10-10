/**
 * План пакета обоев (ТЗ §4.5): семь дат сегодня…сегодня+6, имена файлов,
 * диапазон данных и вход раскладки на каждую дату. Чистый модуль: без `obsidian` и DOM.
 */

import {
  addDays,
  daysInMonth,
  formatDateParts,
  formatDueLabel,
  formatTimeLabel,
  isValidDate,
  parseDateParts,
  type DateLabelStrings,
} from '../model/dates';
import { groupTasksByQuadrant } from '../model/task-selectors';
import type {
  DateRange,
  DayItemsByDate,
  FloatingDateTime,
  LocalDateString,
  MatrixConfig,
  Task,
  WallpaperLayoutInput,
  WallpaperProfile,
  WallpaperSettings,
  WeekStartDay,
  WeekStartSetting,
} from '../model/types';
import type { WallpaperLayoutStrings } from './types';

/** Число дат в пакете (сегодня и шесть следующих). */
export const WALLPAPER_DAYS = 7;
/** Файл на сегодня, который берёт быстрая команда при отсутствии датированного. */
export const LOCK_FILE_NAME = 'lock.png';

const LOCK_DATED_RE = /^lock-(\d{4}-\d{2}-\d{2})\.png$/;

/** Даты пакета: сегодня…сегодня+6 (через границы месяца и года). */
export function planRenderDates(today: LocalDateString, count = WALLPAPER_DAYS): LocalDateString[] {
  const dates: LocalDateString[] = [];
  for (let i = 0; i < count; i++) dates.push(addDays(today, i));
  return dates;
}

/** `lock-ГГГГ-ММ-ДД.png`. */
export function datedFileName(date: LocalDateString): string {
  return `lock-${date}.png`;
}

/** Дата из имени `lock-ГГГГ-ММ-ДД.png` (без папки) или `null` для чужих файлов. */
export function parseDatedFileName(name: string): LocalDateString | null {
  const match = LOCK_DATED_RE.exec(name);
  return match && isValidDate(match[1]) ? match[1] : null;
}

function firstOfMonth(date: LocalDateString): LocalDateString {
  const p = parseDateParts(date);
  return p ? formatDateParts({ ...p, day: 1 }) : date;
}

function lastOfMonth(date: LocalDateString): LocalDateString {
  const p = parseDateParts(date);
  return p ? formatDateParts({ ...p, day: daysInMonth(p.year, p.month) }) : date;
}

/**
 * Диапазон данных, покрывающий всё, что рисуют шаблоны на любую дату пакета:
 * неделю выбранной даты (матрица) и сетку месяца с соседними днями (календарь).
 */
export function renderDataRange(dates: readonly LocalDateString[]): DateRange {
  const first = dates[0];
  const last = dates[dates.length - 1] ?? first;
  // Сетка месяца начинается не раньше чем за 6 дней до 1-го и кончается не позже чем через 6 дней после последнего.
  return { from: addDays(firstOfMonth(first), -6), to: addDays(lastOfMonth(last), 6) };
}

/** Начало недели обоев: своё значение или общее (`auto`). */
export function resolveWallpaperWeekStart(setting: WeekStartSetting, fallback: WeekStartDay): WeekStartDay {
  if (setting === 'monday') return 1;
  if (setting === 'sunday') return 0;
  return fallback;
}

/**
 * Подпись срока на обоях относительно даты обоев: задача на этот день со временем —
 * только время; иначе «Завтра 12:30», «16 окт.» и т. п.
 */
export function formatWallpaperDue(
  due: FloatingDateTime,
  relativeTo: LocalDateString,
  labels: DateLabelStrings,
  hour12: boolean,
): string {
  if (due.date === relativeTo && due.time !== null) return formatTimeLabel(due.time, hour12, labels);
  return formatDueLabel(due, relativeTo, labels, { hour12 });
}

/**
 * «Сейчас» для даты обоев: на сегодня — текущее время, на будущие даты — начало дня
 * (задачи со сроком раньше этой даты считаются просроченными на тот день).
 */
export function nowForDate(date: LocalDateString, today: LocalDateString, now: FloatingDateTime): FloatingDateTime {
  return date === today ? now : { date, time: '00:00' };
}

export interface LayoutInputSource {
  date: LocalDateString;
  today: LocalDateString;
  /** Текущий момент в зоне устройства. */
  now: FloatingDateTime;
  settings: WallpaperSettings;
  profile: WallpaperProfile;
  /** Общее начало недели (для `wallpaper.weekStart: auto`). */
  weekStart: WeekStartDay;
  hour12: boolean;
  matrix: MatrixConfig;
  tasks: readonly Task[];
  days: DayItemsByDate;
  strings: WallpaperLayoutStrings;
}

/** Вход раскладки на одну дату пакета. */
export function createLayoutInput(source: LayoutInputSource): WallpaperLayoutInput {
  const { settings } = source;
  return {
    template: settings.template,
    palette: settings.palette,
    profile: source.profile,
    date: source.date,
    weekStart: resolveWallpaperWeekStart(settings.weekStart, source.weekStart),
    hour12: source.hour12,
    tasksPerQuadrant: settings.tasksPerQuadrant,
    matrix: source.matrix,
    tasksByQuadrant: groupTasksByQuadrant(source.tasks, nowForDate(source.date, source.today, source.now)),
    days: source.days,
    strings: source.strings,
  };
}
