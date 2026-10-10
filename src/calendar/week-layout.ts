/**
 * Лента недели (ТЗ §4.4): 7 дней от начала недели, под днём — до 3 цветных точек,
 * серая точка заметок и галочка при выполненных задачах; сегодня выделяется.
 * Чистый модуль: без `obsidian` и DOM.
 */

import type { DateRange, DayItemsByDate, DaySummary, LocalDateString, WeekStartDay } from '../model/types';
import { addDays, parseDateParts, startOfWeek, weekday } from '../model/dates';
import { summarizeDay } from './day-items';

export interface WeekStripDay {
  date: LocalDateString;
  dayOfMonth: number;
  /** 0 — воскресенье … 6 — суббота. */
  weekday: number;
  isToday: boolean;
  isSelected: boolean;
  summary: DaySummary;
}

/** Даты недели, содержащей `date`. */
export function weekDates(date: LocalDateString, weekStart: WeekStartDay): LocalDateString[] {
  const first = startOfWeek(date, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/** Диапазон недели, содержащей `date`. */
export function weekRange(date: LocalDateString, weekStart: WeekStartDay): DateRange {
  const first = startOfWeek(date, weekStart);
  return { from: first, to: addDays(first, 6) };
}

/** Тот же день недели через `weeks` недель (прокрутка ленты). */
export function shiftWeek(date: LocalDateString, weeks: number): LocalDateString {
  return addDays(date, weeks * 7);
}

/** Дни ленты недели. `days` может не содержать дат недели — тогда сводка пустая. */
export function buildWeekStrip(params: {
  selected: LocalDateString;
  today: LocalDateString;
  weekStart: WeekStartDay;
  days: DayItemsByDate;
}): WeekStripDay[] {
  return weekDates(params.selected, params.weekStart).map((date) => ({
    date,
    dayOfMonth: parseDateParts(date)?.day ?? 0,
    weekday: weekday(date),
    isToday: date === params.today,
    isSelected: date === params.selected,
    summary: summarizeDay(params.days.get(date), date),
  }));
}
