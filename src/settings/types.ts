/**
 * Типы модуля настроек. `PlannerSettings` и связанные типы описаны в model/types.ts
 * и здесь только реэкспортируются; модуль добавляет свои вспомогательные типы.
 */

import type {
  CalendarCacheReader,
  Clock,
  CompanionStore,
  FormatPreferencesProvider,
  IntegrityService,
  Notifier,
  SettingsSection,
  SettingsStore,
} from '../app/contracts';
import type { VaultPath, WallpaperProfile } from '../model/types';

export type {
  ArchiveSetting,
  CalendarMode,
  CalendarSourceFilter,
  PlannerSettings,
  PlannerTabId,
  TasksLayout,
  TasksListGrouping,
  TimeFormatSetting,
  VisibleCalendarsSetting,
  WallpaperBackground,
  WallpaperCrop,
  WallpaperPalette,
  WallpaperSettings,
  WallpaperTemplate,
  WeekStartSetting,
} from '../model/types';
export type { SettingsSection, SettingsStore } from '../app/contracts';

/** Источник data.json (подходит сам `Plugin`). */
export interface SettingsDataSource {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export type RootFolderError = 'empty' | 'dot-segment' | 'hidden' | 'invalid-chars' | 'reserved';

export type RootFolderValidation =
  | { ok: true; value: string }
  | { ok: false; error: RootFolderError; chars?: string };

/** Профили обоев для выпадающего списка (реализация — wallpaper/profiles, S2.T4). */
export interface WallpaperProfileProvider {
  list(): readonly WallpaperProfile[];
  /** Профиль, который выбрал бы режим «Автоматически» на этом устройстве. */
  resolveAuto?(): WallpaperProfile | null;
}

/** Панель «Требуют внимания» из модуля целостности (S1.T9). */
export interface AttentionPanelHandle {
  dispose(): void;
}

export type AttentionPanelFactory = (containerEl: HTMLElement) => AttentionPanelHandle | void;

/**
 * Зависимости вкладки настроек. Всё, кроме `store`, необязательно: недостающие сервисы
 * подключаются интеграционными задачами, а соответствующие части экрана упрощаются.
 */
export interface SettingsTabDeps {
  store: SettingsStore;
  clock?: Clock;
  notifier?: Notifier;
  /** Вычисленные язык, начало недели и формат времени (для подписи «Сейчас: …»). */
  format?: FormatPreferencesProvider;
  /** Календари из кэша компаньона: выбор календаря и показываемые календари. */
  calendars?: Pick<CalendarCacheReader, 'getCalendars' | 'onChange'>;
  wallpaperProfiles?: WallpaperProfileProvider;
  /** Состояние `_system/companion.json`. */
  companion?: Pick<CompanionStore, 'getState' | 'onChange'>;
  /** Открыть приложение-компаньон. Без него кнопка не показывается. */
  openCompanion?: () => void;
  /** Время последней правки задачи с напоминанием (мс) — для баннера о планировании. */
  lastReminderEditAt?: () => number | null;
  integrity?: Pick<IntegrityService, 'check' | 'getLastReport' | 'onChange'>;
  /** Готовая панель «Требуют внимания»; без неё показывается простой список. */
  attentionPanel?: AttentionPanelFactory;
  /** Открыть заметку из простого списка «Требуют внимания». */
  openNote?: (path: VaultPath) => void;
  /** Дополнительные разделы (порядок — `SettingsSection.order`). */
  sections?: readonly SettingsSection[];
}
