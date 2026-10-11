/**
 * Шаблон «Матрица» (ТЗ §4.5, кадры 17–18): лента недели и четыре квадранта.
 * Размеры — в точках макета, умножаются на `ctx.unit`. Чистый модуль.
 */

import type { DayAgenda, DayItem, FontSpec, LocalDateString, QuadrantKey, Task } from '../model/types';
import { addDays, startOfWeek, weekday } from '../model/dates';
import { formatChecklistProgress } from '../model/checklist';
import { textWidth, truncateText, wrapText } from './text-layout';
import type { Box, LayoutContext, TemplateLayout } from './types';

// Геометрия (точки макета).
export const CARD_RADIUS_PT = 16;
export const BLOCK_GAP_PT = 10;

const WEEK = {
  pad: 8,
  labelH: 12,
  numberH: 22,
  gap: 4,
  pillH: 13,
  pillGap: 2,
  maxPills: 2,
  moreH: 11,
  padBottom: 5,
} as const;

const QUAD = {
  pad: 12,
  headerH: 20,
  headerGap: 6,
  rowH: 21,
  /** Высота карточки рассчитана на 3 строки и при 2 задачах (как на образце). */
  minRows: 3,
  padBottom: 8,
  iconSize: 14,
  badgeR: 10,
  circleR: 6,
} as const;

/** Порядок квадрантов в сетке 2×2. */
const GRID: readonly (readonly [QuadrantKey, QuadrantKey])[] = [
  ['do', 'plan'],
  ['urgent', 'someday'],
];

// ---------------------------------------------------------------------------
// Общие помощники (используются и шаблоном «Календарь»)
// ---------------------------------------------------------------------------

/** Элементы дня для обоев: без заметок и выполненных задач; сначала «Весь день». */
export function wallpaperDayItems(agenda: DayAgenda | undefined): DayItem[] {
  if (!agenda) return [];
  return [...agenda.allDay, ...agenda.timed].filter(
    (item) => item.source !== 'note' && !(item.source === 'task' && item.completed),
  );
}

export function emitCard(ctx: LayoutContext, box: Box): void {
  ctx.commands.push({
    op: 'rect',
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    radius: CARD_RADIUS_PT * ctx.unit,
    fill: ctx.palette.card,
    backdrop: 'blur',
  });
}

export interface TextOptions {
  font: FontSpec;
  color: string;
  align?: 'left' | 'center' | 'right';
  /** Предельная ширина; длинный текст обрезается с многоточием. */
  maxWidth?: number;
}

/** Текст с базовой линией по середине `cy`. Возвращает фактическую ширину. */
export function emitText(ctx: LayoutContext, text: string, x: number, cy: number, options: TextOptions): number {
  const value = options.maxWidth === undefined ? text : truncateText(text, options.maxWidth, options.font, ctx.measurer);
  if (value === '') return 0;
  ctx.commands.push({
    op: 'text',
    x,
    y: cy,
    text: value,
    font: options.font,
    color: options.color,
    align: options.align ?? 'left',
    baseline: 'middle',
  });
  return textWidth(value, options.font, ctx.measurer);
}

/** Плашка события или задачи цвета календаря/квадранта. */
export function emitPill(ctx: LayoutContext, item: DayItem, box: Box, fontPt: number): void {
  const u = ctx.unit;
  const solid = item.source !== 'task' && item.allDay;
  const colors = ctx.pill(item.color, solid);
  ctx.commands.push({ op: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, radius: 3 * u, fill: colors.fill });
  const cy = box.y + box.h / 2;
  let textX = box.x + 3 * u;
  if (!solid && item.source === 'task') {
    const r = Math.min(2.6 * u, box.h / 4);
    ctx.commands.push({ op: 'circle', cx: box.x + 2 * u + r, cy, r, fill: null, stroke: colors.marker, lineWidth: Math.max(1, 0.9 * u) });
    textX = box.x + 4 * u + 2 * r;
  } else if (!solid) {
    ctx.commands.push({ op: 'rect', x: box.x + 1.5 * u, y: box.y + 2 * u, w: 2 * u, h: box.h - 4 * u, radius: u, fill: colors.marker });
    textX = box.x + 5.5 * u;
  }
  emitText(ctx, item.title, textX, cy, {
    font: ctx.font(fontPt, 500),
    color: colors.text,
    maxWidth: Math.max(0, box.x + box.w - 1.5 * u - textX),
  });
}

// ---------------------------------------------------------------------------
// Лента недели
// ---------------------------------------------------------------------------

export function weekStripHeight(): number {
  return (
    WEEK.pad + WEEK.labelH + WEEK.numberH + WEEK.gap + WEEK.maxPills * WEEK.pillH + (WEEK.maxPills - 1) * WEEK.pillGap + WEEK.moreH + WEEK.padBottom
  );
}

function drawWeekStrip(ctx: LayoutContext, box: Box): void {
  const { input, strings, palette } = ctx;
  const u = ctx.unit;
  emitCard(ctx, box);
  const start = startOfWeek(input.date, input.weekStart);
  const innerX = box.x + WEEK.pad * u;
  const colW = (box.w - 2 * WEEK.pad * u) / 7;
  const labelCy = box.y + (WEEK.pad + WEEK.labelH / 2) * u;
  const numberCy = box.y + (WEEK.pad + WEEK.labelH + WEEK.numberH / 2) * u;
  const pillsTop = box.y + (WEEK.pad + WEEK.labelH + WEEK.numberH + WEEK.gap) * u;
  let hidden = 0;

  for (let i = 0; i < 7; i++) {
    const date: LocalDateString = addDays(start, i);
    const cx = innerX + colW * (i + 0.5);
    const label = strings.weekdayShort[weekday(date)] ?? '';
    emitText(ctx, label, cx, labelCy, { font: ctx.font(9, 600), color: palette.secondary, align: 'center', maxWidth: colW - 2 * u });

    const day = String(Number(date.slice(8, 10)));
    // Устаревшие обои: «сегодня» уже не тот день — без выделения.
    const selected = !input.expired && date === input.date;
    if (selected) {
      ctx.commands.push({ op: 'circle', cx, cy: numberCy, r: 10 * u, fill: palette.text, stroke: null, lineWidth: 0 });
    }
    emitText(ctx, day, cx, numberCy, { font: ctx.font(13, 600), color: selected ? palette.cardEffective : palette.text, align: 'center' });

    const items = wallpaperDayItems(input.days.get(date));
    const shown = items.slice(0, WEEK.maxPills);
    shown.forEach((item, j) => {
      const pill: Box = {
        x: cx - colW / 2 + 1.5 * u,
        y: pillsTop + j * (WEEK.pillH + WEEK.pillGap) * u,
        w: colW - 3 * u,
        h: WEEK.pillH * u,
      };
      emitPill(ctx, item, pill, 8);
    });
    const rest = items.length - shown.length;
    if (rest > 0) {
      hidden += rest;
      const moreCy = pillsTop + (WEEK.maxPills * WEEK.pillH + (WEEK.maxPills - 1) * WEEK.pillGap + WEEK.moreH / 2) * u;
      emitText(ctx, strings.moreItems(rest), cx, moreCy, { font: ctx.font(8, 500), color: palette.secondary, align: 'center', maxWidth: colW });
    }
  }
  if (hidden > 0) ctx.overflow.week = (ctx.overflow.week ?? 0) + hidden;
}

// ---------------------------------------------------------------------------
// Квадранты
// ---------------------------------------------------------------------------

export function quadrantHeight(tasksPerQuadrant: number): number {
  const rows = Math.max(QUAD.minRows, tasksPerQuadrant);
  return QUAD.pad + QUAD.headerH + QUAD.headerGap + rows * QUAD.rowH + QUAD.padBottom;
}

function drawQuadrant(ctx: LayoutContext, key: QuadrantKey, box: Box): void {
  const { input, strings, palette } = ctx;
  const u = ctx.unit;
  const config = input.matrix.byKey[key];
  const color = config?.color ?? palette.secondary;
  const accent = ctx.accent(color);
  const title = config?.title?.trim() || strings.quadrantTitles[key];
  const tasks: readonly Task[] = input.tasksByQuadrant[key] ?? [];
  emitCard(ctx, box);

  const left = box.x + QUAD.pad * u;
  const right = box.x + box.w - QUAD.pad * u;
  const headerCy = box.y + (QUAD.pad + QUAD.headerH / 2) * u;

  // Заголовок: значок Lucide, название, счётчик в круге.
  const iconSize = QUAD.iconSize * u;
  let titleX = left;
  if (config?.icon) {
    ctx.commands.push({ op: 'icon', name: config.icon, x: left, y: headerCy - iconSize / 2, size: iconSize, color: accent });
    titleX = left + iconSize + 6 * u;
  }
  const badgeR = QUAD.badgeR * u;
  const badgeCx = right - badgeR;
  ctx.commands.push({ op: 'circle', cx: badgeCx, cy: headerCy, r: badgeR, fill: ctx.pill(color, true).fill, stroke: null, lineWidth: 0 });
  emitText(ctx, String(tasks.length), badgeCx, headerCy, {
    font: ctx.font(tasks.length > 99 ? 8 : 11, 700),
    color: ctx.onFill(color),
    align: 'center',
    maxWidth: badgeR * 2,
  });
  emitText(ctx, title, titleX, headerCy, {
    font: ctx.font(13, 700),
    color: accent,
    maxWidth: Math.max(0, badgeCx - badgeR - 6 * u - titleX),
  });

  const rowsTop = box.y + (QUAD.pad + QUAD.headerH + QUAD.headerGap) * u;
  if (tasks.length === 0) {
    const font = ctx.font(11.5, 400);
    const lines = wrapText(strings.emptyQuadrant, right - left, font, ctx.measurer, 2);
    lines.forEach((line, i) => emitText(ctx, line, left, rowsTop + (i + 0.5) * QUAD.rowH * u, { font, color: palette.secondary }));
    return;
  }

  const shown = tasks.slice(0, input.tasksPerQuadrant);
  shown.forEach((task, i) => {
    const cy = rowsTop + (i + 0.5) * QUAD.rowH * u;
    const r = QUAD.circleR * u;
    ctx.commands.push({ op: 'circle', cx: left + r, cy, r, fill: null, stroke: accent, lineWidth: 1.5 * u });
    const titleLeft = left + 2 * r + 7 * u;
    let titleRight = right;
    if (task.due) {
      const dueFont = ctx.font(11, 600);
      const dueText = input.expired && strings.formatDueDate ? strings.formatDueDate(task.due) : strings.formatDue(task.due, input.date, task.duration);
      const dueWidth = emitText(ctx, dueText, right, cy, {
        font: dueFont,
        color: accent,
        align: 'right',
        maxWidth: (right - titleLeft) * 0.6,
      });
      if (dueWidth > 0) titleRight = right - dueWidth - 6 * u;
    }
    // Чек-лист (доработка 008): «2/5» мелким шрифтом сразу после названия.
    const progress = task.checklist ? formatChecklistProgress(task.checklist) : '';
    const progressFont = ctx.font(10, 500);
    const progressGap = 4 * u;
    const progressWidth = progress ? textWidth(progress, progressFont, ctx.measurer) : 0;
    const available = Math.max(0, titleRight - titleLeft);
    // Подпись прогресса помещается, только если для названия остаётся хотя бы половина строки.
    const showProgress = progressWidth > 0 && progressWidth + progressGap <= available / 2;
    const titleWidth = emitText(ctx, task.title, titleLeft, cy, {
      font: ctx.font(12.5, 500),
      color: palette.text,
      maxWidth: showProgress ? available - progressWidth - progressGap : available,
    });
    if (showProgress) {
      emitText(ctx, progress, titleLeft + titleWidth + progressGap, cy, { font: progressFont, color: palette.secondary });
    }
  });
  const rest = tasks.length - shown.length;
  if (rest > 0) ctx.overflow[key] = rest;
}

// ---------------------------------------------------------------------------
// Шаблон
// ---------------------------------------------------------------------------

export const matrixTemplate: TemplateLayout = {
  naturalHeight(input) {
    return weekStripHeight() + BLOCK_GAP_PT + 2 * quadrantHeight(input.tasksPerQuadrant) + BLOCK_GAP_PT;
  },
  draw(ctx, area) {
    const u = ctx.unit;
    const weekH = weekStripHeight() * u;
    drawWeekStrip(ctx, { x: area.x, y: area.y, w: area.w, h: weekH });
    const gap = BLOCK_GAP_PT * u;
    const quadH = quadrantHeight(ctx.input.tasksPerQuadrant) * u;
    const quadW = (area.w - gap) / 2;
    GRID.forEach((row, r) => {
      row.forEach((key, c) => {
        drawQuadrant(ctx, key, { x: area.x + c * (quadW + gap), y: area.y + weekH + gap + r * (quadH + gap), w: quadW, h: quadH });
      });
    });
  },
};
