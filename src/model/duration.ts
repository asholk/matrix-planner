/**
 * Длительность задачи (свойство `duration`, минуты): проверка и подписи.
 * Диапазон времени «18:00–19:30» — `formatDueTimeLabel` (`model/dates.ts`).
 * Чистый модуль: без `obsidian` и DOM; тексты единиц передаёт вызывающий (словарь i18n).
 */

/** Допустимая длительность задачи, мин (включительно). */
export const MIN_TASK_DURATION = 5;
export const MAX_TASK_DURATION = 1440;

/** Длительность задачи со временем, если свойство не задано (как в «Календаре» iOS), мин. */
export const DEFAULT_TASK_DURATION = 30;

/** Варианты выбора в форме задачи, мин. */
export const DURATION_PRESETS: readonly number[] = [15, 30, 45, 60, 90, 120];

/** Целое число минут в допустимом диапазоне. */
export function isValidDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_TASK_DURATION && value <= MAX_TASK_DURATION;
}

/**
 * Значение свойства `duration` из YAML: число или строка из цифр.
 * `undefined` — свойство пусто; `null` — значение невалидно.
 */
export function parseDurationValue(value: unknown): number | null | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined;
  const number = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return isValidDuration(number) ? number : null;
}

/** Длительность, которой задача занимает время: заданная или по умолчанию. */
export function effectiveDuration(duration: number | null | undefined): number {
  return isValidDuration(duration) ? duration : DEFAULT_TASK_DURATION;
}

/** Шаблоны единиц: `{n}` — число (`15 мин`, `1,5 ч`). */
export interface DurationLabelStrings {
  minutes: string;
  hours: string;
  /** Десятичный разделитель (`,` в ru, `.` в en). */
  decimal: string;
}

function fill(template: string, n: string): string {
  return template.replace('{n}', n);
}

/**
 * Подпись длительности: меньше часа — минуты, кратно получасу — часы с половиной
 * («1 ч», «1,5 ч»), иначе часы и минуты («1 ч 15 мин»).
 */
export function formatDuration(minutes: number, strings: DurationLabelStrings): string {
  if (minutes < 60) return fill(strings.minutes, String(minutes));
  if (minutes % 30 === 0) {
    const hours = minutes / 60;
    const text = Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace('.', strings.decimal);
    return fill(strings.hours, text);
  }
  const rest = minutes % 60;
  return `${fill(strings.hours, String(Math.floor(minutes / 60)))} ${fill(strings.minutes, String(rest))}`;
}
