/**
 * Раскладка временной шкалы дня (ТЗ §4.4): перекрывающиеся интервалы делятся на колонки.
 * Чистый модуль: без `obsidian` и DOM; результат — в минутах, перевод в пиксели делает UI.
 *
 * Алгоритм: элементы сортируются по началу (длинные раньше), группируются в кластеры
 * транзитивно перекрывающихся интервалов; внутри кластера каждый элемент занимает первую
 * свободную колонку, число колонок кластера — максимум занятых.
 */

import type { DayItem } from '../model/types';

export const MINUTES_PER_DAY = 1440;
/** Минимальная видимая длительность (короткие и нулевые события). */
export const DEFAULT_MIN_DURATION = 15;

export interface TimelineBlock {
  item: DayItem;
  /** Видимые границы (минуты от начала дня). */
  startMinute: number;
  endMinute: number;
  /** Колонка (0…columns−1) и число колонок в группе перекрытия. */
  column: number;
  columns: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Раскладывает элементы со временем; элементы без `startMinute` пропускаются. */
export function layoutTimeline(items: readonly DayItem[], options: { minDurationMinutes?: number } = {}): TimelineBlock[] {
  const minDuration = Math.max(1, options.minDurationMinutes ?? DEFAULT_MIN_DURATION);
  const blocks: TimelineBlock[] = items
    .filter((item) => item.startMinute !== null)
    .map((item) => {
      let start = clamp(item.startMinute as number, 0, MINUTES_PER_DAY);
      let end = clamp(Math.max(item.endMinute ?? start, start + minDuration), 0, MINUTES_PER_DAY);
      if (end - start < minDuration) start = Math.max(0, end - minDuration);
      return { item, startMinute: start, endMinute: end, column: 0, columns: 1 };
    })
    .sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute || a.item.key.localeCompare(b.item.key));

  let cluster: TimelineBlock[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const block of cluster) block.columns = columnEnds.length;
    cluster = [];
    columnEnds = [];
  };

  for (const block of blocks) {
    if (block.startMinute >= clusterEnd) flush();
    let column = columnEnds.findIndex((end) => end <= block.startMinute);
    if (column < 0) {
      column = columnEnds.length;
      columnEnds.push(block.endMinute);
    } else {
      columnEnds[column] = block.endMinute;
    }
    block.column = column;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.endMinute);
  }
  flush();
  return blocks;
}
