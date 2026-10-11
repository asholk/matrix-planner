/**
 * Шаблон «Календарь» (ТЗ §4.5, кадр 16): прогресс года и сетка месяца с событиями.
 * Размеры — в точках макета, умножаются на `ctx.unit`. Чистый модуль.
 */

import type { LocalDateString, WallpaperLayoutInput } from '../model/types';
import { addDays, daysInMonth, diffDays, formatDateParts, isLeapYear, parseDateParts, startOfWeek, weekday } from '../model/dates';
import { BLOCK_GAP_PT, emitCard, emitPill, emitText, wallpaperDayItems } from './matrix-layout';
import type { Box, LayoutContext, TemplateLayout } from './types';

const YEAR = { pad: 14, titleH: 20, gap: 8, barH: 6, captionH: 14 } as const;
const MONTH = { pad: 12, titleH: 20, titleGap: 8, weekdayH: 14, weekdayGap: 4, cellH: 42, padBottom: 6, pillH: 10, pillGap: 2 } as const;

export interface YearProgress {
  year: number;
  /** Целый процент прошедших дней (вниз). */
  percent: number;
  /** Доля 0–1 для полосы. */
  fraction: number;
  daysLeft: number;
}

/** Прогресс года: 10.10.2026 → 77 %, осталось 83 дня (день даты не считается прошедшим). */
export function yearProgress(date: LocalDateString): YearProgress {
  const parts = parseDateParts(date);
  const year = parts ? parts.year : 1970;
  const total = isLeapYear(year) ? 366 : 365;
  const passed = parts ? diffDays(formatDateParts({ year, month: 1, day: 1 }), date) : 0;
  return { year, percent: Math.floor((passed * 100) / total), fraction: passed / total, daysLeft: total - passed };
}

export interface MonthGrid {
  year: number;
  month: number;
  /** Первый день сетки (начало недели). */
  start: LocalDateString;
  weeks: number;
}

/** Сетка месяца на 4–6 недель с учётом начала недели. */
export function monthGrid(date: LocalDateString, weekStart: 0 | 1): MonthGrid {
  const parts = parseDateParts(date) ?? { year: 1970, month: 1, day: 1 };
  const first = formatDateParts({ year: parts.year, month: parts.month, day: 1 });
  const last = formatDateParts({ year: parts.year, month: parts.month, day: daysInMonth(parts.year, parts.month) });
  const start = startOfWeek(first, weekStart);
  return { year: parts.year, month: parts.month, start, weeks: Math.ceil((diffDays(start, last) + 1) / 7) };
}

function yearCardHeight(): number {
  return YEAR.pad * 2 + YEAR.titleH + YEAR.gap + YEAR.barH + YEAR.gap + YEAR.captionH;
}

function monthCardHeight(weeks: number): number {
  return MONTH.pad + MONTH.titleH + MONTH.titleGap + MONTH.weekdayH + MONTH.weekdayGap + weeks * MONTH.cellH + MONTH.padBottom;
}

function drawYearCard(ctx: LayoutContext, box: Box): void {
  const { palette, strings } = ctx;
  const u = ctx.unit;
  emitCard(ctx, box);
  const progress = yearProgress(ctx.input.date);
  const left = box.x + YEAR.pad * u;
  const right = box.x + box.w - YEAR.pad * u;
  const innerW = right - left;

  const titleCy = box.y + (YEAR.pad + YEAR.titleH / 2) * u;
  const titleFont = ctx.font(16, 700);
  const percentWidth = emitText(ctx, `${progress.percent}%`, right, titleCy, { font: titleFont, color: palette.text, align: 'right' });
  emitText(ctx, String(progress.year), left, titleCy, { font: titleFont, color: palette.text, maxWidth: innerW - percentWidth - 8 * u });

  const barY = box.y + (YEAR.pad + YEAR.titleH + YEAR.gap) * u;
  const barH = YEAR.barH * u;
  ctx.commands.push({ op: 'rect', x: left, y: barY, w: innerW, h: barH, radius: barH / 2, fill: palette.track });
  if (progress.fraction > 0) {
    ctx.commands.push({ op: 'rect', x: left, y: barY, w: Math.max(barH, innerW * progress.fraction), h: barH, radius: barH / 2, fill: palette.text });
  }

  const captionCy = barY + barH + (YEAR.gap + YEAR.captionH / 2) * u;
  const captionFont = ctx.font(11, 500);
  let leftMax = innerW;
  if (strings.daysLeft) {
    const daysText = strings.daysLeft(progress.daysLeft);
    const width = emitText(ctx, daysText, right, captionCy, { font: captionFont, color: palette.secondary, align: 'right', maxWidth: innerW / 2 });
    leftMax = innerW - width - 8 * u;
  }
  emitText(ctx, strings.yearProgress(progress.percent), left, captionCy, { font: captionFont, color: palette.secondary, maxWidth: Math.max(0, leftMax) });
}

function drawMonthCard(ctx: LayoutContext, box: Box, grid: MonthGrid): void {
  const { input, palette, strings } = ctx;
  const u = ctx.unit;
  emitCard(ctx, box);
  const left = box.x + MONTH.pad * u;
  const right = box.x + box.w - MONTH.pad * u;
  const colW = (right - left) / 7;

  const titleCy = box.y + (MONTH.pad + MONTH.titleH / 2) * u;
  const monthName = strings.monthNames[grid.month - 1] ?? String(grid.month);
  emitText(ctx, `${monthName} ${grid.year}`, left, titleCy, { font: ctx.font(15, 700), color: palette.text, maxWidth: right - left });

  const weekdayCy = box.y + (MONTH.pad + MONTH.titleH + MONTH.titleGap + MONTH.weekdayH / 2) * u;
  for (let i = 0; i < 7; i++) {
    const label = strings.weekdayShort[weekday(addDays(grid.start, i))] ?? '';
    emitText(ctx, label, left + colW * (i + 0.5), weekdayCy, {
      font: ctx.font(9.5, 600),
      color: palette.secondary,
      align: 'center',
      maxWidth: colW - 2 * u,
    });
  }

  const gridTop = box.y + (MONTH.pad + MONTH.titleH + MONTH.titleGap + MONTH.weekdayH + MONTH.weekdayGap) * u;
  const monthPrefix = `${grid.year}-${String(grid.month).padStart(2, '0')}-`;
  let hidden = 0;
  for (let index = 0; index < grid.weeks * 7; index++) {
    const date = addDays(grid.start, index);
    const row = Math.floor(index / 7);
    const col = index % 7;
    const cellX = left + col * colW;
    const cellTop = gridTop + row * MONTH.cellH * u;
    const cx = cellX + colW / 2;
    const numberCy = cellTop + 9 * u;
    const inMonth = date.startsWith(monthPrefix);
    const selected = !input.expired && date === input.date;
    if (selected) ctx.commands.push({ op: 'circle', cx, cy: numberCy, r: 9 * u, fill: palette.text, stroke: null, lineWidth: 0 });
    emitText(ctx, String(Number(date.slice(8, 10))), cx, numberCy, {
      font: ctx.font(11, selected ? 700 : 600),
      color: selected ? palette.cardEffective : inMonth ? palette.text : palette.secondary,
      align: 'center',
    });
    if (!inMonth) continue;

    const items = wallpaperDayItems(input.days.get(date));
    if (items.length === 0) continue;
    // Две плашки; если больше — одна плашка и «+N».
    const visible = items.length > 2 ? 1 : items.length;
    const pillsTop = cellTop + 20 * u;
    const pillW = colW - 2 * u;
    for (let j = 0; j < visible; j++) {
      emitPill(ctx, items[j], { x: cellX + u, y: pillsTop + j * (MONTH.pillH + MONTH.pillGap) * u, w: pillW, h: MONTH.pillH * u }, 7.5);
    }
    const rest = items.length - visible;
    if (rest > 0) {
      hidden += rest;
      const moreCy = pillsTop + (MONTH.pillH + MONTH.pillGap + MONTH.pillH / 2) * u;
      emitText(ctx, strings.moreItems(rest), cx, moreCy, { font: ctx.font(7.5, 600), color: palette.secondary, align: 'center', maxWidth: colW });
    }
  }
  if (hidden > 0) ctx.overflow.month = (ctx.overflow.month ?? 0) + hidden;
}

export const calendarTemplate: TemplateLayout = {
  naturalHeight(input: WallpaperLayoutInput) {
    return yearCardHeight() + BLOCK_GAP_PT + monthCardHeight(monthGrid(input.date, input.weekStart).weeks);
  },
  draw(ctx, area) {
    const u = ctx.unit;
    const yearH = yearCardHeight() * u;
    drawYearCard(ctx, { x: area.x, y: area.y, w: area.w, h: yearH });
    const grid = monthGrid(ctx.input.date, ctx.input.weekStart);
    drawMonthCard(ctx, { x: area.x, y: area.y + yearH + BLOCK_GAP_PT * u, w: area.w, h: monthCardHeight(grid.weeks) * u }, grid);
  },
};

