/**
 * План пакета обоев (ТЗ §4.5): семь дат сегодня…сегодня+6, имена файлов,
 * диапазон данных и вход раскладки на каждую дату. Чистый модуль: без `obsidian` и DOM.
 */

import {
  addDays,
  daysInMonth,
  formatDateParts,
  formatDueLabel,
  formatDueTimeLabel,
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
/** Файл на день отрисовки (совместимость со старыми командами: новая берёт `lock-expired.png`). */
export const LOCK_FILE_NAME = 'lock.png';
/** Запасной файл после последней даты пакета: «Обои устарели — откройте Obsidian». */
export const EXPIRED_FILE_NAME = 'lock-expired.png';
/**
 * Версия шаблонов обоев в отпечатке пакета: увеличивать при изменении рисования,
 * чтобы прежние PNG с тем же входом были перерисованы.
 */
export const WALLPAPER_TEMPLATE_VERSION = 2;

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
  duration: number | null = null,
): string {
  if (due.date === relativeTo && due.time !== null) return formatDueTimeLabel(due.time, duration, hour12, labels);
  return formatDueLabel(due, relativeTo, labels, { hour12, duration });
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

/** Дата запасного файла `lock-expired.png`: первый день после пакета. */
export function expiredDate(dates: readonly LocalDateString[]): LocalDateString {
  const last = dates[dates.length - 1];
  return addDays(last, 1);
}

/** Вход раскладки на одну дату пакета (`expired` — шаблон «Обои устарели»). */
export function createLayoutInput(source: LayoutInputSource & { expired?: boolean }): WallpaperLayoutInput {
  const { settings } = source;
  const input: WallpaperLayoutInput = {
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
    layoutPreset: settings.layoutPreset,
  };
  if (source.expired) input.expired = true;
  return input;
}

// ---------------------------------------------------------------------------
// Отпечаток пакета (п. 12 доработки 007)
// ---------------------------------------------------------------------------

/** Сериализация с упорядоченными ключами; `Map`/`Set` — как массивы, функции пропускаются. */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' ? undefined : v;
    if (seen.has(v)) return '[cycle]';
    seen.add(v);
    try {
      if (v instanceof Map) return [...v.entries()].map(([k, item]) => [walk(k), walk(item)]);
      if (v instanceof Set) return [...v.values()].map(walk);
      if (Array.isArray(v)) return v.map((item) => walk(item) ?? null);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) {
        const item = walk((v as Record<string, unknown>)[key]);
        if (item !== undefined) out[key] = item;
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return JSON.stringify(walk(value)) ?? '';
}

/** Два независимых FNV-1a (32 бита) → 16 шестнадцатеричных знаков. */
export function hashString(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Отпечаток данных пакета: `v<версия шаблона>-<дата>-<хеш входа>`. */
export function packFingerprint(today: LocalDateString, input: unknown): string {
  return `v${WALLPAPER_TEMPLATE_VERSION}-${today}-${hashString(stableStringify(input))}`;
}

/** Байты двух PNG совпадают (тогда файл не переписывается). */
export function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
