/**
 * Статистика выполнения: серия дней подряд, выполнено за неделю, диаграмма по дням
 * недели, недавно выполненные, текстовая сводка «Итоги недели».
 * Чистый модуль: без `obsidian` и DOM; сегодняшняя дата, начало недели и тексты — параметры.
 *
 * Выполнение — запись `completionEntries`: у обычной задачи дата `completed`, у повторяющейся —
 * каждая дата из `completions`. Архивные задачи учитываются (они выполнены).
 * Даты свойств — локальные (плавающие), поэтому сутки считаются по зоне устройства.
 */

import {
  QUADRANT_KEYS,
  type ItemId,
  type LocalDateString,
  type LocalTimeString,
  type QuadrantKey,
  type Task,
  type VaultPath,
  type WeekStartDay,
} from '../model/types';
import { addDays, parseFloating, startOfWeek } from '../model/dates';
import { completionEntries } from '../model/task-selectors';

/** Сколько последних выполнений показывать. */
export const RECENT_LIMIT = 20;

export interface CompletionRecord {
  /** Уникальный ключ записи (у повторений — с датой). */
  key: string;
  taskId: ItemId;
  path: VaultPath;
  title: string;
  quadrant: QuadrantKey;
  archived: boolean;
  date: LocalDateString;
  /** Время выполнения, если известно. */
  time: LocalTimeString | null;
  /** Дата повторения; `null` — обычная задача. */
  instanceDate: LocalDateString | null;
}

/** Все выполнения, сначала новые (порядок `completionEntries`). */
export function completionRecords(tasks: readonly Task[]): CompletionRecord[] {
  const byId = new Map<ItemId, Task>();
  for (const task of tasks) if (!byId.has(task.id)) byId.set(task.id, task);
  const records: CompletionRecord[] = [];
  for (const entry of completionEntries(tasks)) {
    const task = byId.get(entry.taskId);
    if (!task) continue;
    records.push({
      key: `${task.id}@${entry.instanceDate ?? 'single'}`,
      taskId: task.id,
      path: task.path,
      title: task.title,
      quadrant: task.quadrant,
      archived: task.archived,
      date: entry.date,
      time: parseFloating(entry.completedAt)?.time ?? null,
      instanceDate: entry.instanceDate,
    });
  }
  return records;
}

/**
 * Серия: число дней подряд с хотя бы одним выполнением, заканчивая сегодня.
 * Если сегодня ещё ничего не выполнено — серия считается до вчера включительно.
 */
export function computeStreak(dates: Iterable<LocalDateString>, today: LocalDateString): number {
  const days = new Set(dates);
  let day = days.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(day)) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}

/** Семь дат текущей недели с учётом первого дня недели. */
export function weekDates(today: LocalDateString, weekStart: WeekStartDay): LocalDateString[] {
  const first = startOfWeek(today, weekStart);
  return Array.from({ length: 7 }, (_, index) => addDays(first, index));
}

export interface DayCount {
  date: LocalDateString;
  count: number;
  /** День после сегодняшнего (ещё не наступил). */
  future: boolean;
  today: boolean;
}

export interface StatsModel {
  today: LocalDateString;
  streak: number;
  /** Выполнено с начала текущей недели. */
  weekCount: number;
  /** Диаграмма: 7 дней текущей недели. */
  week: DayCount[];
  /** Выполнения недели по квадрантам. */
  weekByQuadrant: Record<QuadrantKey, number>;
  /** Последние выполнения, сначала новые. */
  recent: CompletionRecord[];
}

export interface StatsInput {
  tasks: readonly Task[];
  today: LocalDateString;
  weekStart: WeekStartDay;
  recentLimit?: number;
}

export function buildStats(input: StatsInput): StatsModel {
  const { today } = input;
  const records = completionRecords(input.tasks);
  const dates = weekDates(today, input.weekStart);
  const first = dates[0] ?? today;
  const last = dates[6] ?? today;
  const counts = new Map<LocalDateString, number>();
  const weekByQuadrant = {} as Record<QuadrantKey, number>;
  for (const key of QUADRANT_KEYS) weekByQuadrant[key] = 0;
  let weekCount = 0;
  for (const record of records) {
    counts.set(record.date, (counts.get(record.date) ?? 0) + 1);
    // «С начала недели»: будущие даты (повторение, выполненное заранее) тоже в пределах недели.
    if (record.date >= first && record.date <= last) {
      weekCount++;
      weekByQuadrant[record.quadrant]++;
    }
  }
  return {
    today,
    streak: computeStreak(counts.keys(), today),
    weekCount,
    week: dates.map((date) => ({ date, count: counts.get(date) ?? 0, future: date > today, today: date === today })),
    weekByQuadrant,
    recent: records.slice(0, input.recentLimit ?? RECENT_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// Итоги недели
// ---------------------------------------------------------------------------

export interface SummaryStrings {
  /** «Итоги недели {range}: выполнено {done}, серия {streak}». */
  header(range: string, done: string, streak: string): string;
  /** «{count} задач» с нужной формой. */
  tasks(count: number): string;
  /** «{count} дня» с нужной формой. */
  days(count: number): string;
  quadrantsLabel: string;
  daysLabel: string;
  quadrantTitle(key: QuadrantKey): string;
  /** Короткое название дня недели («Пн»). */
  weekday(date: LocalDateString): string;
  /** Диапазон дат недели («6–12 окт.»). */
  range(from: LocalDateString, to: LocalDateString): string;
}

/** «Итоги недели 6–12 окт.: выполнено 16 задач, серия 4 дня; по квадрантам: …; по дням: …». */
export function buildWeekSummary(model: StatsModel, strings: SummaryStrings): string {
  const first = model.week[0]?.date ?? model.today;
  const last = model.week[model.week.length - 1]?.date ?? model.today;
  const header = strings.header(strings.range(first, last), strings.tasks(model.weekCount), strings.days(model.streak));
  const quadrants = QUADRANT_KEYS.map((key) => `${strings.quadrantTitle(key)} — ${model.weekByQuadrant[key]}`).join(', ');
  const days = model.week.map((day) => `${strings.weekday(day.date)} ${day.count}`).join(', ');
  return `${header}; ${strings.quadrantsLabel}: ${quadrants}; ${strings.daysLabel}: ${days}.`;
}

// ---------------------------------------------------------------------------
// Подписи дат (Intl на языке интерфейса; даты локальные — форматируются как UTC)
// ---------------------------------------------------------------------------

function utcDate(date: LocalDateString, time: LocalTimeString | null = null): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hours, minutes] = (time ?? '12:00').split(':').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hours ?? 12, minutes ?? 0));
}

/** «10 окт. 2026 г., 19:08» / «Oct 10, 2026, 7:08 PM»; без времени — только дата. */
export function formatCompletionMoment(date: LocalDateString, time: LocalTimeString | null, language: string, hour12: boolean): string {
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
  if (time !== null) Object.assign(options, { hour: 'numeric', minute: '2-digit', hour12 });
  return new Intl.DateTimeFormat(language, options).format(utcDate(date, time));
}

/** Название дня недели: `narrow` — «П», `short` — «пн», `long` — «понедельник». */
export function weekdayName(date: LocalDateString, language: string, style: 'narrow' | 'short' | 'long'): string {
  return new Intl.DateTimeFormat(language, { weekday: style, timeZone: 'UTC' }).format(utcDate(date));
}

/** «11 октября» / «October 11». */
export function formatDayMonth(date: LocalDateString, language: string): string {
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utcDate(date));
}

/** «6–12 окт.» / «Oct 6 – 12». */
export function formatDateRange(from: LocalDateString, to: LocalDateString, language: string): string {
  const format = new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  try {
    return format.formatRange(utcDate(from), utcDate(to));
  } catch {
    return `${format.format(utcDate(from))} – ${format.format(utcDate(to))}`;
  }
}

/** Первая буква заглавная (дни недели в русском — строчные). */
export function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}
