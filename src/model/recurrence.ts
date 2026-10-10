/**
 * Правила повтора (ТЗ §3.3) — пресеты, не RRULE.
 *
 * Повторения серии нумеруются от якоря (`repeat_anchor`): индекс 0 — сам якорь.
 * - daily: якорь + n дней; weekly: якорь + 7n дней;
 * - monthly: то же число, что в якоре; если его нет в месяце — последний день месяца
 *   (31 янв. → 28/29 февр. → 31 марта → 30 апр.);
 * - yearly: та же дата; 29 февраля в невисокосный год → 28 февраля.
 * Следующее повторение всегда считается от якоря, а не от предыдущего повторения,
 * поэтому 31-е число не «съезжает» на 28-е.
 */

import type { DateRange, LocalDateString, RepeatRule } from './types';
import { daysInMonth, diffDays, addDays, parseDateParts, formatDateParts, toDayNumber, fromDayNumber } from './dates';

export function isRecurring(rule: RepeatRule): boolean {
  return rule !== 'none';
}

function anchorParts(anchor: LocalDateString) {
  const parts = parseDateParts(anchor);
  if (!parts) throw new RangeError(`Invalid repeat anchor: ${anchor}`);
  return parts;
}

/** Повторение с индексом `index` (≥ 0). Для `none` — только индекс 0 (сам якорь). */
export function occurrenceAt(rule: RepeatRule, anchor: LocalDateString, index: number): LocalDateString {
  if (index < 0 || !Number.isInteger(index)) throw new RangeError(`Invalid occurrence index: ${index}`);
  switch (rule) {
    case 'none':
      if (index !== 0) throw new RangeError('Non-recurring rule has a single occurrence');
      return anchor;
    case 'daily':
      return addDays(anchor, index);
    case 'weekly':
      return addDays(anchor, index * 7);
    case 'monthly': {
      const a = anchorParts(anchor);
      const total = a.year * 12 + (a.month - 1) + index;
      const year = Math.floor(total / 12);
      const month = total - year * 12 + 1;
      return formatDateParts({ year, month, day: Math.min(a.day, daysInMonth(year, month)) });
    }
    case 'yearly': {
      const a = anchorParts(anchor);
      const year = a.year + index;
      return formatDateParts({ year, month: a.month, day: Math.min(a.day, daysInMonth(year, a.month)) });
    }
  }
}

/** Индекс первого повторения, которое не раньше `date` (оценка + уточнение). */
function firstIndexOnOrAfter(rule: RepeatRule, anchor: LocalDateString, date: LocalDateString): number {
  if (date <= anchor) return 0;
  switch (rule) {
    case 'none':
      return -1;
    case 'daily':
      return diffDays(anchor, date);
    case 'weekly':
      return Math.ceil(diffDays(anchor, date) / 7);
    case 'monthly': {
      const a = anchorParts(anchor);
      const d = anchorParts(date);
      let index = Math.max(0, (d.year - a.year) * 12 + (d.month - a.month));
      while (occurrenceAt(rule, anchor, index) < date) index++;
      return index;
    }
    case 'yearly': {
      const a = anchorParts(anchor);
      const d = anchorParts(date);
      let index = Math.max(0, d.year - a.year);
      while (occurrenceAt(rule, anchor, index) < date) index++;
      return index;
    }
  }
}

/** Первое повторение не раньше `date`; для `none` — якорь, если он не раньше `date`, иначе `null`. */
export function occurrenceOnOrAfter(rule: RepeatRule, anchor: LocalDateString, date: LocalDateString): LocalDateString | null {
  const index = firstIndexOnOrAfter(rule, anchor, date);
  return index < 0 ? null : occurrenceAt(rule, anchor, index);
}

/** Первое повторение строго после `date`. */
export function occurrenceAfter(rule: RepeatRule, anchor: LocalDateString, date: LocalDateString): LocalDateString | null {
  return occurrenceOnOrAfter(rule, anchor, fromDayNumber(toDayNumber(date) + 1));
}

/** Является ли `date` повторением серии. */
export function isOccurrence(rule: RepeatRule, anchor: LocalDateString, date: LocalDateString): boolean {
  return occurrenceOnOrAfter(rule, anchor, date) === date;
}

/**
 * Первое повторение строго после `after`, которого нет в `skip` (например, уже выполненные).
 * `null` — для `none` или если за `maxSteps` подходящее не найдено.
 */
export function nextPendingOccurrence(
  rule: RepeatRule,
  anchor: LocalDateString,
  after: LocalDateString,
  skip: readonly LocalDateString[] = [],
  maxSteps = 10000,
): LocalDateString | null {
  if (!isRecurring(rule)) return null;
  const skipSet = new Set(skip);
  let index = firstIndexOnOrAfter(rule, anchor, fromDayNumber(toDayNumber(after) + 1));
  for (let step = 0; step < maxSteps; step++, index++) {
    const candidate = occurrenceAt(rule, anchor, index);
    if (!skipSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Повторения серии в диапазоне включительно, не раньше `notBefore` (обычно текущий `due`).
 * Для `none` — якорь, если он в диапазоне.
 */
export function occurrencesInRange(
  rule: RepeatRule,
  anchor: LocalDateString,
  range: DateRange,
  options: { notBefore?: LocalDateString; limit?: number } = {},
): LocalDateString[] {
  const limit = options.limit ?? 1000;
  const from = options.notBefore && options.notBefore > range.from ? options.notBefore : range.from;
  const result: LocalDateString[] = [];
  if (from > range.to) return result;
  if (!isRecurring(rule)) {
    if (anchor >= from && anchor <= range.to) result.push(anchor);
    return result;
  }
  let index = firstIndexOnOrAfter(rule, anchor, from);
  while (result.length < limit) {
    const date = occurrenceAt(rule, anchor, index++);
    if (date > range.to) break;
    result.push(date);
  }
  return result;
}

/** Первые `count` повторений от якоря (для фикстур и предпросмотра). */
export function firstOccurrences(rule: RepeatRule, anchor: LocalDateString, count: number): LocalDateString[] {
  if (!isRecurring(rule)) return count > 0 ? [anchor] : [];
  const result: LocalDateString[] = [];
  for (let i = 0; i < count; i++) result.push(occurrenceAt(rule, anchor, i));
  return result;
}
