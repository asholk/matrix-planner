/**
 * Хранение настроек в data.json плагина (`loadData`/`saveData`).
 *
 * Нормализация: известные поля проверяются и при ошибке заменяются запасным значением
 * (по умолчанию или предыдущим), неизвестные поля — и на верхнем уровне, и во вложенных
 * объектах — сохраняются как есть. Валидация — без `obsidian`, чтобы её можно было тестировать.
 */

import { MARKER_FILE_NAME, PLANNER_LAYOUT } from '../model/types';
import type {
  ArchiveSetting,
  CalendarSourceFilter,
  LocalTimeString,
  PlannerSettings,
  Unsubscribe,
  VisibleCalendarsSetting,
  WallpaperBackground,
  WallpaperSettings,
} from '../model/types';
import type { SettingsStore } from '../app/contracts';
import {
  ARCHIVE_DAYS_MAX,
  ARCHIVE_DAYS_MIN,
  SETTINGS_VERSION,
  createDefaultSettings,
  migrateSettings,
} from './defaults';
import type { RootFolderValidation, SettingsDataSource } from './types';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && !result.includes(item)) result.push(item);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Валидаторы отдельных значений (экспортируются для вкладки настроек)
// ---------------------------------------------------------------------------

/** Символы, недопустимые в именах папок на разных ОС и ломающие ссылки Obsidian. */
const INVALID_FOLDER_CHARS = /[\\:*?"<>|#^[\]]/g;

/**
 * Проверяет и нормализует корневую папку: обрезает пробелы и `/` по краям,
 * склеивает повторные `/`, запрещает пустое значение, `.`/`..`, скрытые папки
 * (их не синхронизирует Obsidian Sync), служебные имена и недопустимые символы.
 */
export function validateRootFolder(input: unknown): RootFolderValidation {
  if (typeof input !== 'string') return { ok: false, error: 'empty' };
  const segments = input
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return { ok: false, error: 'empty' };
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return { ok: false, error: 'dot-segment' };
    if (segment.startsWith('.')) return { ok: false, error: 'hidden' };
    const bad = segment.match(INVALID_FOLDER_CHARS);
    if (bad) return { ok: false, error: 'invalid-chars', chars: [...new Set(bad)].join(' ') };
    if ([...segment].some((char) => char.charCodeAt(0) < 0x20)) return { ok: false, error: 'invalid-chars', chars: '' };
  }
  const value = segments.join('/');
  // Корень не может совпадать с маркером или со служебной папкой.
  if (value === MARKER_FILE_NAME || segments[segments.length - 1] === PLANNER_LAYOUT.system) {
    return { ok: false, error: 'reserved' };
  }
  return { ok: true, value };
}

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** `H:mm`/`HH:mm` → `HH:mm`; `null`, если время некорректно. */
export function normalizeTime(input: unknown): LocalTimeString | null {
  if (typeof input !== 'string') return null;
  const match = TIME_PATTERN.exec(input.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

/** Число дней архива: целое в пределах `ARCHIVE_DAYS_MIN…MAX`, иначе `null`. */
export function normalizeArchiveDays(input: unknown): number | null {
  const value = typeof input === 'string' && input.trim() !== '' ? Number(input.trim()) : input;
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= ARCHIVE_DAYS_MIN && value <= ARCHIVE_DAYS_MAX ? value : null;
}

/** Название быстрой команды: непустая строка без переводов строк. */
export function normalizeShortcutName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.replace(/[\r\n\t]+/g, ' ').trim();
  return value.length > 0 ? value : null;
}

/** Профиль обоев: `auto` или id, пригодный как имя папки (`iphone-1179x2556`). */
export function normalizeProfileId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (value === 'auto') return value;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function pickFinite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

// ---------------------------------------------------------------------------
// Нормализация групп
// ---------------------------------------------------------------------------

function normalizeArchive(raw: unknown, fallback: ArchiveSetting): ArchiveSetting {
  if (!isRecord(raw)) return { ...fallback };
  const { mode, days, ...extra } = raw;
  if (mode === 'never') return { ...extra, mode: 'never' };
  if (mode === 'after-days') {
    const valid = normalizeArchiveDays(days);
    if (valid !== null) return { ...extra, mode: 'after-days', days: valid };
  }
  return { ...fallback };
}

function normalizeVisibleCalendars(raw: unknown, fallback: VisibleCalendarsSetting): VisibleCalendarsSetting {
  const source = asRecord(raw);
  return {
    ...source,
    planner: pickBoolean(source.planner, fallback.planner),
    birthdays: pickBoolean(source.birthdays, fallback.birthdays),
    calendarIds: pickStringList(source.calendarIds, fallback.calendarIds),
  };
}

function normalizeBackground(raw: unknown, fallback: WallpaperBackground): WallpaperBackground {
  if (!isRecord(raw)) return structuredClone(fallback);
  switch (raw.kind) {
    case 'solid':
      if (typeof raw.color === 'string' && COLOR_PATTERN.test(raw.color)) {
        return { ...raw, kind: 'solid', color: raw.color };
      }
      break;
    case 'gradient':
      if (typeof raw.from === 'string' && typeof raw.to === 'string' && COLOR_PATTERN.test(raw.from) && COLOR_PATTERN.test(raw.to)) {
        return { ...raw, kind: 'gradient', from: raw.from, to: raw.to, angle: pickFinite(raw.angle, 180, -360, 360) };
      }
      break;
    case 'image':
      if (typeof raw.path === 'string' && raw.path.trim().length > 0) {
        const crop = asRecord(raw.crop);
        return {
          ...raw,
          kind: 'image',
          path: raw.path,
          crop: {
            ...crop,
            centerX: pickFinite(crop.centerX, 0.5, 0, 1),
            centerY: pickFinite(crop.centerY, 0.5, 0, 1),
            scale: pickFinite(crop.scale, 1, 1, 100),
          },
        };
      }
      break;
    default:
      break;
  }
  return structuredClone(fallback);
}

function normalizeWallpaper(raw: unknown, fallback: WallpaperSettings): WallpaperSettings {
  const source = asRecord(raw);
  const tasksPerQuadrant = source.tasksPerQuadrant === 2 || source.tasksPerQuadrant === 3 ? source.tasksPerQuadrant : fallback.tasksPerQuadrant;
  const calendarIds =
    source.calendarIds === null
      ? null
      : Array.isArray(source.calendarIds)
        ? pickStringList(source.calendarIds, [])
        : fallback.calendarIds === null
          ? null
          : [...fallback.calendarIds];
  return {
    ...source,
    template: pickEnum(source.template, ['matrix', 'calendar'] as const, fallback.template),
    palette: pickEnum(source.palette, ['dark', 'light', 'translucent'] as const, fallback.palette),
    background: normalizeBackground(source.background, fallback.background),
    profile: normalizeProfileId(source.profile) ?? fallback.profile,
    shortcutName: normalizeShortcutName(source.shortcutName) ?? fallback.shortcutName,
    tasksPerQuadrant,
    weekStart: pickEnum(source.weekStart, ['auto', 'monday', 'sunday'] as const, fallback.weekStart),
    calendarIds,
  };
}

function normalizeSources(raw: unknown, fallback: CalendarSourceFilter): CalendarSourceFilter {
  const source = asRecord(raw);
  return {
    ...source,
    tasks: pickBoolean(source.tasks, fallback.tasks),
    events: pickBoolean(source.events, fallback.events),
    notes: pickBoolean(source.notes, fallback.notes),
    external: pickBoolean(source.external, fallback.external),
  };
}

function normalizeUi(raw: unknown, fallback: PlannerSettings['ui']): PlannerSettings['ui'] {
  const source = asRecord(raw);
  return {
    ...source,
    lastTab: pickEnum(source.lastTab, ['tasks', 'calendar', 'lockscreen'] as const, fallback.lastTab),
    tasksLayout: pickEnum(source.tasksLayout, ['grid', 'list'] as const, fallback.tasksLayout),
    tasksListGrouping: pickEnum(source.tasksListGrouping, ['quadrant', 'date'] as const, fallback.tasksListGrouping),
    calendarMode: pickEnum(source.calendarMode, ['list', 'timeline', 'month'] as const, fallback.calendarMode),
    calendarSources: normalizeSources(source.calendarSources, fallback.calendarSources),
  };
}

/**
 * Сырые данные → корректные настройки. Неизвестные поля сохраняются;
 * некорректные известные поля заменяются значениями из `fallback`.
 */
export function normalizeSettings(raw: unknown, fallback: PlannerSettings = createDefaultSettings()): PlannerSettings {
  const source = migrateSettings(asRecord(raw));
  const rawVersion = source.version;
  // Данные более новой версии не понижаются, чтобы новая версия плагина не мигрировала их повторно.
  const version = typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion > SETTINGS_VERSION ? rawVersion : SETTINGS_VERSION;
  const root = validateRootFolder(source.rootFolder);
  const defaultCalendar = source.defaultEventCalendarId;
  return {
    ...source,
    version,
    rootFolder: root.ok ? root.value : fallback.rootFolder,
    archive: normalizeArchive(source.archive, fallback.archive),
    reminderTimeForDateOnly: normalizeTime(source.reminderTimeForDateOnly) ?? fallback.reminderTimeForDateOnly,
    weekStart: pickEnum(source.weekStart, ['auto', 'monday', 'sunday'] as const, fallback.weekStart),
    timeFormat: pickEnum(source.timeFormat, ['auto', '24h', '12h'] as const, fallback.timeFormat),
    showTasksInIosCalendar: pickBoolean(source.showTasksInIosCalendar, fallback.showTasksInIosCalendar),
    writeCompletedTasksToCalendar: pickBoolean(source.writeCompletedTasksToCalendar, fallback.writeCompletedTasksToCalendar),
    defaultEventCalendarId:
      defaultCalendar === null || (typeof defaultCalendar === 'string' && defaultCalendar.length > 0)
        ? defaultCalendar
        : fallback.defaultEventCalendarId,
    visibleCalendars: normalizeVisibleCalendars(source.visibleCalendars, fallback.visibleCalendars),
    wallpaper: normalizeWallpaper(source.wallpaper, fallback.wallpaper),
    ui: normalizeUi(source.ui, fallback.ui),
  };
}

// ---------------------------------------------------------------------------
// Хранилище
// ---------------------------------------------------------------------------

type SettingsListener = (settings: Readonly<PlannerSettings>, previous: Readonly<PlannerSettings>) => void;

export class PluginSettingsStore implements SettingsStore {
  private current: PlannerSettings = createDefaultSettings();
  private readonly listeners = new Set<SettingsListener>();
  /** Цепочка записей: изменения применяются и сохраняются по очереди. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly source: SettingsDataSource) {}

  get(): Readonly<PlannerSettings> {
    return this.current;
  }

  async load(): Promise<void> {
    let raw: unknown = null;
    try {
      raw = await this.source.loadData();
    } catch (error) {
      console.error('[matrix-planner] Не удалось прочитать data.json', error);
    }
    const previous = this.current;
    this.current = normalizeSettings(raw);
    this.emit(this.current, previous);
  }

  update(mutate: (draft: PlannerSettings) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const previous = this.current;
      const draft = structuredClone(previous);
      mutate(draft);
      // Некорректные значения откатываются к предыдущим, а не к значениям по умолчанию.
      const next = normalizeSettings(draft, previous);
      await this.source.saveData(next);
      this.current = next;
      this.emit(next, previous);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  onChange(listener: SettingsListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(settings: PlannerSettings, previous: PlannerSettings): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(settings, previous);
      } catch (error) {
        console.error('[matrix-planner] Ошибка обработчика настроек', error);
      }
    }
  }
}
