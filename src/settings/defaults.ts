/**
 * Значения настроек по умолчанию и миграции формата data.json (ТЗ §4.6).
 * Чистый модуль: не импортирует `obsidian`.
 */

import { DEFAULT_ROOT_FOLDER } from '../model/types';
import type { PlannerSettings, WallpaperSettings } from './types';

/** Текущая версия формата настроек (`PlannerSettings.version`). */
export const SETTINGS_VERSION = 1;

/** Время напоминания для задач без времени. */
export const DEFAULT_REMINDER_TIME = '09:00';

/** Пределы «Через N дней» для переноса в архив. */
export const ARCHIVE_DAYS_MIN = 1;
export const ARCHIVE_DAYS_MAX = 3650;
/** Значение N, подставляемое при выборе «Через N дней». */
export const DEFAULT_ARCHIVE_DAYS = 30;

/** Название поставляемой команды 1 (ТЗ §5.5). */
export const DEFAULT_SHORTCUT_NAME = 'Обои Планировщика';

export function createDefaultWallpaperSettings(): WallpaperSettings {
  return {
    template: 'matrix',
    palette: 'dark',
    background: { kind: 'solid', color: '#1C1C1E' },
    profile: 'auto',
    shortcutName: DEFAULT_SHORTCUT_NAME,
    tasksPerQuadrant: 3,
    weekStart: 'auto',
    calendarIds: null,
  };
}

/** Новый объект настроек по умолчанию (каждый вызов — независимая копия). */
export function createDefaultSettings(): PlannerSettings {
  return {
    version: SETTINGS_VERSION,
    rootFolder: DEFAULT_ROOT_FOLDER,
    // Автоматический перенос выключен: пользователь включает его сам.
    archive: { mode: 'never' },
    reminderTimeForDateOnly: DEFAULT_REMINDER_TIME,
    weekStart: 'auto',
    timeFormat: 'auto',
    showTasksInIosCalendar: true,
    writeCompletedTasksToCalendar: false,
    defaultEventCalendarId: null,
    visibleCalendars: { planner: true, birthdays: true, calendarIds: [] },
    wallpaper: createDefaultWallpaperSettings(),
    ui: {
      lastTab: 'tasks',
      tasksLayout: 'grid',
      tasksListGrouping: 'quadrant',
      calendarMode: 'list',
      calendarSources: { tasks: true, events: true, notes: true, external: true },
    },
  };
}

/** Миграция сырых данных версии `from` к версии `from + 1`. */
type SettingsMigration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * Миграции по исходной версии. Пока формат один (версия 1) — список пуст;
 * новые версии добавляют сюда шаг, не меняя остальной код.
 */
const MIGRATIONS: Readonly<Record<number, SettingsMigration>> = {};

/**
 * Приводит сырые данные к текущей версии формата. Данные без версии считаются версией 1.
 * Данные более новой версии не трогаются: неизвестные поля сохранит нормализация.
 */
export function migrateSettings(data: Record<string, unknown>): Record<string, unknown> {
  const raw = data.version;
  let version = typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 1;
  let current = data;
  while (version < SETTINGS_VERSION) {
    const step = MIGRATIONS[version];
    if (step) current = step(current);
    version += 1;
  }
  return current;
}
