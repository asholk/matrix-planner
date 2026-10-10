/**
 * Дедупликация событий кэша «Календаря» iOS с заметками Планировщика (ТЗ §4.4, §5.4.2).
 *
 * - Событие кэша со ссылкой `matrixplanner://item/<id>` на известную заметку (событие или задачу,
 *   выгруженную в календарь «Планировщик») второй раз не показывается.
 * - Ссылка на неизвестный id (заметка ещё не проиндексирована или удалена) — событие остаётся внешним,
 *   чтобы ничего не пропадало молча.
 * - Повторы одной записи кэша (одинаковый `occurrenceKey`) схлопываются.
 * - Для повторяющегося события-заметки свежий кэш — источник истины о повторениях внутри своего диапазона:
 *   удалённое в «Календаре» iOS повторение не показывается, изменённое показывается по данным кэша.
 *   Кэш считается свежим для заметки, если он записан после её последнего изменения.
 */

import type { CalendarCacheData, CachedCalendarEvent, ItemId, PlannerEvent } from '../model/types';

export interface PartitionedCacheEvents {
  /** Внешние события (без связи с известной заметкой), без дублей. */
  external: CachedCalendarEvent[];
  /** Повторения в кэше, связанные с событиями-заметками: id заметки → повторения. */
  linkedToEvents: Map<ItemId, CachedCalendarEvent[]>;
  /** Сколько записей кэша скрыто как связанные с заметками. */
  hiddenLinked: number;
}

/** Делит события кэша на внешние и связанные с заметками. */
export function partitionCacheEvents(
  events: readonly CachedCalendarEvent[],
  knownItemIds: ReadonlySet<ItemId>,
  eventItemIds: ReadonlySet<ItemId>,
): PartitionedCacheEvents {
  const external: CachedCalendarEvent[] = [];
  const linkedToEvents = new Map<ItemId, CachedCalendarEvent[]>();
  const seen = new Set<string>();
  let hiddenLinked = 0;
  for (const event of events) {
    if (seen.has(event.occurrenceKey)) continue;
    seen.add(event.occurrenceKey);
    const linked = event.linkedItemId;
    if (linked !== null && knownItemIds.has(linked)) {
      hiddenLinked++;
      if (eventItemIds.has(linked)) {
        const list = linkedToEvents.get(linked);
        if (list) list.push(event);
        else linkedToEvents.set(linked, [event]);
      }
      continue;
    }
    external.push(event);
  }
  return { external, linkedToEvents, hiddenLinked };
}

/** Кэш записан после последнего изменения заметки (нечитаемое время записи — не свежий). */
export function isCacheFreshFor(item: Pick<PlannerEvent, 'mtime'>, cache: Pick<CalendarCacheData, 'generatedAt'>): boolean {
  const generated = Date.parse(cache.generatedAt);
  if (Number.isNaN(generated)) return false;
  return generated >= item.mtime;
}

/**
 * Брать ли повторения события-заметки из кэша внутри диапазона кэша.
 * Только для повторяющихся событий, у которых в кэше есть связанные повторения и кэш свежий.
 */
export function shouldUseCacheOccurrences(
  event: Pick<PlannerEvent, 'repeat' | 'mtime'>,
  linked: readonly CachedCalendarEvent[] | undefined,
  cache: Pick<CalendarCacheData, 'generatedAt'>,
): boolean {
  return event.repeat !== 'none' && linked !== undefined && linked.length > 0 && isCacheFreshFor(event, cache);
}

/** Убирает элементы с повторяющимся ключом, сохраняя первый. */
export function uniqueByKey<T extends { key: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    result.push(item);
  }
  return result;
}
