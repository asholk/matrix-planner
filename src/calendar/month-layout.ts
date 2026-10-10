/**
 * Вид «Месяц» (ТЗ §4.4): сетка из 4–6 недель с плашками и «+N» при переполнении.
 * Чистый модуль: без `obsidian` и DOM.
 *
 * Плашки строятся по строкам-неделям: части многодневного события в соседних днях
 * объединяются в одну плашку (по ключу без даты), затем плашки раскладываются по дорожкам.
 * Если в дне больше элементов, чем `maxBars`, видны `maxBars − 1` дорожек, а остальное — «+N».
 * Заметки плашками не показываются (серая точка `hasNotes`).
 */

import type { DateRange, DayItem, DayItemsByDate, LocalDateString, WeekStartDay } from '../model/types';
import { addDays, daysInMonth, diffDays, formatDateParts, parseDateParts, startOfWeek } from '../model/dates';
import { itemSpanKey } from './day-items';

export const DEFAULT_MAX_BARS = 3;

export interface MonthCell {
  date: LocalDateString;
  dayOfMonth: number;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  hasNotes: boolean;
  /** Скрытые элементы («+N»); 0 — переполнения нет. */
  more: number;
}

export interface MonthBar {
  /** Первая часть элемента в этой неделе. */
  item: DayItem;
  spanKey: string;
  /** Колонка начала (0–6) и число дней. */
  startCol: number;
  span: number;
  lane: number;
  /** Продолжается из прошлой недели / в следующую (или из соседнего дня вне недели). */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface MonthWeekRow {
  dates: LocalDateString[];
  cells: MonthCell[];
  /** Только видимые плашки. */
  bars: MonthBar[];
}

export interface MonthLayout {
  year: number;
  month: number;
  range: DateRange;
  weeks: MonthWeekRow[];
}

/** Даты сетки месяца: от начала недели с 1-м числом до конца недели с последним; 4–6 строк. */
export function monthGridDates(year: number, month: number, weekStart: WeekStartDay): LocalDateString[][] {
  const first = formatDateParts({ year, month, day: 1 });
  const last = formatDateParts({ year, month, day: daysInMonth(year, month) });
  const gridStart = startOfWeek(first, weekStart);
  const weeks = Math.ceil((diffDays(gridStart, last) + 1) / 7);
  return Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(gridStart, w * 7 + d)));
}

/** Диапазон дат сетки месяца (для запроса элементов). */
export function monthGridRange(year: number, month: number, weekStart: WeekStartDay): DateRange {
  const weeks = monthGridDates(year, month, weekStart);
  return { from: weeks[0][0], to: weeks[weeks.length - 1][6] };
}

interface Segment {
  item: DayItem;
  spanKey: string;
  startCol: number;
  endCol: number;
  order: number;
  lastItem: DayItem;
  lane: number;
}

/** Раскладка одной недели. */
export function layoutMonthWeek(
  dates: readonly LocalDateString[],
  days: DayItemsByDate,
  options: { maxBars?: number; month?: number; today?: LocalDateString; selected?: LocalDateString } = {},
): MonthWeekRow {
  const maxBars = Math.max(1, options.maxBars ?? DEFAULT_MAX_BARS);
  const segments: Segment[] = [];
  let open = new Map<string, Segment>();

  dates.forEach((date, col) => {
    const agenda = days.get(date);
    const items = agenda ? [...agenda.allDay, ...agenda.timed] : [];
    const next = new Map<string, Segment>();
    items.forEach((item, index) => {
      const key = itemSpanKey(item);
      const previous = open.get(key);
      if (previous && previous.endCol === col - 1 && item.continuesFromPrevious) {
        previous.endCol = col;
        previous.lastItem = item;
        next.set(key, previous);
        return;
      }
      const segment: Segment = { item, spanKey: key, startCol: col, endCol: col, order: index, lastItem: item, lane: -1 };
      segments.push(segment);
      next.set(key, segment);
    });
    open = next;
  });

  segments.sort(
    (a, b) => a.startCol - b.startCol || b.endCol - b.startCol - (a.endCol - a.startCol) || a.order - b.order,
  );
  const lanes: boolean[][] = [];
  for (const segment of segments) {
    let lane = 0;
    for (; ; lane++) {
      const row = lanes[lane] ?? (lanes[lane] = new Array<boolean>(7).fill(false));
      let free = true;
      for (let c = segment.startCol; c <= segment.endCol; c++) if (row[c]) free = false;
      if (free) {
        for (let c = segment.startCol; c <= segment.endCol; c++) row[c] = true;
        break;
      }
    }
    segment.lane = lane;
  }

  // Предел дорожек по колонкам: при переполнении одна дорожка уходит под «+N».
  const totals = dates.map((_, col) => segments.filter((s) => s.startCol <= col && s.endCol >= col).length);
  const limits = totals.map((total) => (total > maxBars ? maxBars - 1 : maxBars));
  const visible = (s: Segment) => {
    for (let c = s.startCol; c <= s.endCol; c++) if (s.lane >= limits[c]) return false;
    return true;
  };

  const cells: MonthCell[] = dates.map((date, col) => {
    const parts = parseDateParts(date);
    const hidden = segments.filter((s) => s.startCol <= col && s.endCol >= col && !visible(s)).length;
    return {
      date,
      dayOfMonth: parts?.day ?? 0,
      inMonth: options.month === undefined || parts?.month === options.month,
      isToday: date === options.today,
      isSelected: date === options.selected,
      hasNotes: (days.get(date)?.notes.length ?? 0) > 0,
      more: hidden,
    };
  });

  const bars: MonthBar[] = segments
    .filter(visible)
    .sort((a, b) => a.lane - b.lane || a.startCol - b.startCol)
    .map((s) => ({
      item: s.item,
      spanKey: s.spanKey,
      startCol: s.startCol,
      span: s.endCol - s.startCol + 1,
      lane: s.lane,
      continuesBefore: s.item.continuesFromPrevious,
      continuesAfter: s.lastItem.continuesToNext,
    }));

  return { dates: [...dates], cells, bars };
}

/** Раскладка месяца: 4–6 недель с плашками и «+N». */
export function layoutMonth(params: {
  year: number;
  month: number;
  weekStart: WeekStartDay;
  days: DayItemsByDate;
  today?: LocalDateString;
  selected?: LocalDateString;
  maxBars?: number;
}): MonthLayout {
  const grid = monthGridDates(params.year, params.month, params.weekStart);
  return {
    year: params.year,
    month: params.month,
    range: { from: grid[0][0], to: grid[grid.length - 1][6] },
    weeks: grid.map((dates) =>
      layoutMonthWeek(dates, params.days, {
        maxBars: params.maxBars,
        month: params.month,
        today: params.today,
        selected: params.selected,
      }),
    ),
  };
}
