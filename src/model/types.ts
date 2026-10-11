/**
 * Общие типы данных Matrix planner (ТЗ §3, §4).
 *
 * Файл не импортирует `obsidian` и DOM: его используют и чистая логика, и UI.
 * Свойства заметок описаны дважды:
 *  - `*Properties` — форма YAML (snake_case), как она лежит в заметке после разбора;
 *  - сама сущность (`Task`, `PlannerEvent`, `QuickNote`) — нормализованные поля camelCase
 *    для логики и UI плюс `props` с исходной формой.
 * Подробности и соглашения — docs/contracts.md.
 */

// ---------------------------------------------------------------------------
// Базовые скаляры
// ---------------------------------------------------------------------------

/** ULID (26 символов Crockford base32). Не зависит от имени файла. */
export type ItemId = string;

/** Путь в хранилище после `normalizePath()`, без ведущего `/`. */
export type VaultPath = string;

/** Локальная дата `YYYY-MM-DD`. */
export type LocalDateString = string;

/** Локальное время `HH:mm` (24 ч). */
export type LocalTimeString = string;

/** Плавающая дата-время без смещения `YYYY-MM-DDTHH:mm`. */
export type LocalDateTimeString = string;

/** Локальная дата `YYYY-MM-DD` или дата-время `YYYY-MM-DDTHH:mm` (`LocalDateString` либо `LocalDateTimeString`). */
export type LocalDateOrDateTimeString = string;

/** Настройка профиля обоев: `auto` — по размеру экрана, иначе id профиля (например `iphone-1179x2556`). */
export type WallpaperProfileSetting = string;

/** Момент времени в ISO 8601 со смещением/`Z` (служебные JSON). */
export type IsoInstantString = string;

/**
 * Плавающая дата-время: трактуется в часовом поясе устройства (ТЗ §3.2).
 * `time === null` — только дата (задача без времени, событие на весь день).
 */
export interface FloatingDateTime {
  date: LocalDateString;
  time: LocalTimeString | null;
}

/** Диапазон дат включительно с обеих сторон. */
export interface DateRange {
  from: LocalDateString;
  to: LocalDateString;
}

/** Сырые свойства заметки (frontmatter) в виде объекта. */
export type FrontmatterRecord = Record<string, unknown>;

/** Функция отписки от событий. */
export type Unsubscribe = () => void;

/** Язык интерфейса. */
export type Language = 'ru' | 'en';

// ---------------------------------------------------------------------------
// Перечисления свойств
// ---------------------------------------------------------------------------

export const QUADRANT_KEYS = ['do', 'plan', 'urgent', 'someday'] as const;
/** do — «Важно и срочно», plan — «Важно», urgent — «Срочно», someday — «Когда-нибудь». */
export type QuadrantKey = (typeof QUADRANT_KEYS)[number];

export const REPEAT_RULES = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const;
export type RepeatRule = (typeof REPEAT_RULES)[number];

export const REMIND_OFFSETS = ['none', 'at', '5m', '15m', '30m', '1h', '1d'] as const;
export type RemindOffset = (typeof REMIND_OFFSETS)[number];

export const PRIORITIES = ['normal', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 8 цветов события (ТЗ §4.3). Значение — ключ палитры, а не CSS-цвет. */
export const EVENT_COLORS = ['blue', 'red', 'orange', 'yellow', 'green', 'teal', 'sky', 'purple'] as const;
export type EventColor = (typeof EVENT_COLORS)[number];

export const ITEM_KINDS = ['task', 'event', 'note'] as const;
/** Значение свойства `type` заметки Планировщика. */
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Имя значка Lucide (для `setIcon`). */
export type IconName = string;

// ---------------------------------------------------------------------------
// Константы хранилища (ТЗ §3.1)
// ---------------------------------------------------------------------------

/** Текущая версия схемы данных (свойство `schema` маркера). */
export const SCHEMA_VERSION = 1;
/** Минимальная версия схемы, которую плагин умеет читать (с миграцией). */
export const MIN_SUPPORTED_SCHEMA = 1;

export const MARKER_FILE_NAME = 'matrix-planner.md';
export const DEFAULT_ROOT_FOLDER = 'Планировщик';

/** Имена папок и файлов внутри корня. Фиксированы ТЗ и не локализуются. */
export const PLANNER_LAYOUT = {
  tasks: 'Задачи',
  archive: 'Архив',
  events: 'События',
  deletedEvents: 'Удалённые',
  notes: 'Заметки',
  matrixFile: 'Матрица.md',
  system: '_system',
  wallpapers: 'Обои',
} as const;

export const SYSTEM_FILES = {
  calendarCache: 'calendar-cache.json',
  tombstones: 'tombstones.json',
  companion: 'companion.json',
} as const;

/** Имя файла резервной копии миграции: `migration-<версия>.json`. */
export type MigrationFileName = `migration-${number}.json`;

/** Имя служебного JSON относительно `_system/`. */
export type SystemJsonName =
  | (typeof SYSTEM_FILES)[keyof typeof SYSTEM_FILES]
  | MigrationFileName;

/** Вычисленные пути Планировщика при текущем корне. */
export interface PlannerPaths {
  root: VaultPath;
  marker: VaultPath;
  tasks: VaultPath;
  /** Папка архива месяца: `Задачи/Архив/ГГГГ-ММ`. */
  archiveFor(month: string): VaultPath;
  archiveRoot: VaultPath;
  events: VaultPath;
  deletedEvents: VaultPath;
  notes: VaultPath;
  matrix: VaultPath;
  system: VaultPath;
  systemFile(name: SystemJsonName): VaultPath;
  wallpapers: VaultPath;
  /** `Обои/<профиль>`. */
  wallpaperProfile(profileId: string): VaultPath;
}

// ---------------------------------------------------------------------------
// Ошибки и результаты операций
// ---------------------------------------------------------------------------

export type PlannerErrorCode =
  | 'not-found' // заметка или ID не найдены
  | 'read-only' // схема новее поддерживаемой или идёт миграция
  | 'stale' // действие относится к устаревшему состоянию (например, повтор уже выполнен)
  | 'invalid' // невалидный ввод формы или свойства
  | 'outside-root' // путь вне корневой папки
  | 'write-failed' // ошибка записи файла
  | 'trash-failed' // ошибка удаления в корзину
  | 'tombstone-failed' // не удалось записать метку удаления
  | 'not-ready' // индекс ещё не построен
  | 'unsupported' // функция недоступна на платформе
  | 'unknown';

export interface PlannerError {
  code: PlannerErrorCode;
  /** Ключ i18n с пояснением для пользователя (необязательно). */
  messageKey?: string;
  /** Технические детали для консоли. */
  detail?: string;
  cause?: unknown;
}

/**
 * Результат операции записи. Операции не бросают исключения для ожидаемых сбоев.
 * `changed: false` — операция идемпотентно пропущена (например, повтор уже в `completions`).
 */
export type OpResult<T = void> =
  | { ok: true; value: T; changed: boolean }
  | { ok: false; error: PlannerError };

// ---------------------------------------------------------------------------
// Проблемы свойств
// ---------------------------------------------------------------------------

export type PropertyIssueCode =
  | 'missing' // обязательное свойство отсутствует
  | 'invalid-type' // неверный тип значения
  | 'invalid-value' // значение вне допустимого набора
  | 'invalid-date' // не разбирается как дата/дата-время
  | 'inconsistent'; // противоречие между свойствами (например, end раньше start)

export interface PropertyIssue {
  property: string;
  code: PropertyIssueCode;
  /** Исходное значение из YAML. */
  value?: unknown;
}

// ---------------------------------------------------------------------------
// Заметки Планировщика: общая часть
// ---------------------------------------------------------------------------

export interface PlannerNoteBase<K extends ItemKind, P> {
  kind: K;
  id: ItemId;
  path: VaultPath;
  /** Имя файла без `.md` — название элемента. */
  title: string;
  /** `TFile.stat.mtime` на момент индексации. */
  mtime: number;
  /** Свойства в форме YAML после разбора (невалидные значения заменены значениями по умолчанию). */
  props: P;
  /** Неизвестные свойства заметки — сохраняются при записи без изменений. */
  extra: FrontmatterRecord;
  /** Невалидные значения, обнаруженные при разборе (заметка всё равно показывается). */
  issues: PropertyIssue[];
}

// ---------------------------------------------------------------------------
// Задача (ТЗ §3.2–3.3)
// ---------------------------------------------------------------------------

/** Свойства задачи в форме YAML. */
export interface TaskProperties {
  type: 'task';
  id: ItemId;
  quadrant: QuadrantKey;
  /** `YYYY-MM-DD` или `YYYY-MM-DDTHH:mm`; `null` — без срока. */
  due: LocalDateOrDateTimeString | null;
  repeat: RepeatRule;
  /** Исходная дата серии; для неповторяющейся может быть `null`. */
  repeat_anchor: LocalDateString | null;
  remind: RemindOffset;
  priority: Priority;
  done: boolean;
  /** Дата-время выполнения неповторяющейся задачи. */
  completed: LocalDateTimeString | null;
  /** Даты выполненных повторений (повторяющаяся задача), по возрастанию, без дублей. */
  completions: LocalDateString[];
  created: LocalDateTimeString | null;
}

export interface Task extends PlannerNoteBase<'task', TaskProperties> {
  quadrant: QuadrantKey;
  /** Нормализованный `due`. */
  due: FloatingDateTime | null;
  repeat: RepeatRule;
  /** `repeat_anchor` или дата `due`, если якоря нет; `null` без срока. */
  repeatAnchor: LocalDateString | null;
  remind: RemindOffset;
  priority: Priority;
  /** Неповторяющаяся: `done`. Повторяющаяся: всегда `false` (серия не завершается выполнением). */
  done: boolean;
  completed: LocalDateTimeString | null;
  completions: readonly LocalDateString[];
  created: LocalDateTimeString | null;
  /** Задача лежит в папке архива. */
  archived: boolean;
}

/** Значения формы задачи (создание/редактирование). */
export interface TaskDraft {
  title: string;
  /** Тело заметки. */
  body: string;
  quadrant: QuadrantKey;
  due: FloatingDateTime | null;
  repeat: RepeatRule;
  remind: RemindOffset;
  priority: Priority;
}

/** Частичное изменение задачи. `body: undefined` — тело не трогать. */
export type TaskPatch = Partial<TaskDraft>;

/** Отметка «Выполнено» для фильтра (ТЗ §4.2): неповторяющаяся задача или одна дата повторения. */
export interface CompletionEntry {
  taskId: ItemId;
  /** Для повторяющейся — дата из `completions`; для обычной — дата из `completed`. */
  date: LocalDateString;
  /** Время выполнения, если известно (`completed`). */
  completedAt: LocalDateTimeString | null;
  /** Дата повторения (для `uncomplete`); `null` — неповторяющаяся. */
  instanceDate: LocalDateString | null;
}

// ---------------------------------------------------------------------------
// Событие (ТЗ §3.4)
// ---------------------------------------------------------------------------

export interface EventProperties {
  type: 'event';
  id: ItemId;
  /** Дата-время или дата (при `all_day`). */
  start: LocalDateOrDateTimeString;
  /** При `all_day` — дата, не включается (событие на 21 окт.: end 2026-10-22). */
  end: LocalDateOrDateTimeString;
  all_day: boolean;
  /** IANA-зона; `null` — плавающее время. */
  tz: string | null;
  repeat: RepeatRule;
  color: EventColor;
  icon: IconName | null;
  /** `EKCalendar.calendarIdentifier`; `null` — календарь «Планировщик». */
  calendar_id: string | null;
  url: string | null;
}

export interface PlannerEvent extends PlannerNoteBase<'event', EventProperties> {
  start: FloatingDateTime;
  /** Для `allDay` — исключительная дата конца, `time === null`. */
  end: FloatingDateTime;
  allDay: boolean;
  tz: string | null;
  repeat: RepeatRule;
  color: EventColor;
  icon: IconName | null;
  calendarId: string | null;
  url: string | null;
  /** Удалённое в «Календаре» iOS событие лежит в `События/Удалённые/`. */
  deletedInCalendar: boolean;
}

export interface EventDraft {
  title: string;
  body: string;
  icon: IconName | null;
  url: string | null;
  allDay: boolean;
  /** Для allDay — только даты; конец в форме — включительный (последний день), сервис переводит в exclusive. */
  start: FloatingDateTime;
  end: FloatingDateTime;
  repeat: RepeatRule;
  color: EventColor;
  /** `null` — «Планировщик». */
  calendarId: string | null;
  tz: string | null;
}

export type EventPatch = Partial<EventDraft>;

// ---------------------------------------------------------------------------
// Быстрая заметка (ТЗ §3.5)
// ---------------------------------------------------------------------------

export interface NoteProperties {
  type: 'note';
  id: ItemId;
  date: LocalDateString | null;
}

export interface QuickNote extends PlannerNoteBase<'note', NoteProperties> {
  date: LocalDateString | null;
}

export interface NoteDraft {
  title: string;
  body: string;
  date: LocalDateString | null;
}

/** Любая заметка Планировщика. */
export type PlannerItem = Task | PlannerEvent | QuickNote;

/**
 * Заметка с `type: task|event|note`, которую нельзя использовать:
 * нет `id`, неверный `quadrant` и т. п. Показывается в «Требуют внимания».
 */
export interface InvalidPlannerNote {
  kind: 'invalid';
  path: VaultPath;
  title: string;
  mtime: number;
  declaredType: ItemKind;
  frontmatter: FrontmatterRecord;
  issues: PropertyIssue[];
}

export type ParsedNote = PlannerItem | InvalidPlannerNote;

// ---------------------------------------------------------------------------
// Матрица (ТЗ §3.6)
// ---------------------------------------------------------------------------

/** Элемент свойства `quadrants` в `Матрица.md`. */
export interface QuadrantConfig {
  key: QuadrantKey;
  title: string;
  /** CSS-цвет `#RRGGBB`. */
  color: string;
  icon: IconName;
}

export interface MatrixProperties {
  quadrants: QuadrantConfig[];
}

export interface MatrixConfig {
  /** `null` — файла нет, используются значения по умолчанию. */
  path: VaultPath | null;
  /** Всегда 4 элемента в порядке `QUADRANT_KEYS`. */
  quadrants: readonly QuadrantConfig[];
  byKey: Readonly<Record<QuadrantKey, QuadrantConfig>>;
  issues: PropertyIssue[];
}

// ---------------------------------------------------------------------------
// Маркер и схема (ТЗ §3.1, §3.9)
// ---------------------------------------------------------------------------

export interface MarkerProperties {
  /** Путь корневой папки относительно хранилища. */
  root: string;
  schema: number;
  vault_id: string;
  /** Идёт миграция: компаньон работает только на чтение. */
  migrating: boolean;
}

export type SchemaStatus =
  | 'unknown' // маркер ещё не прочитан
  | 'ok' // схема поддерживается, запись разрешена
  | 'needs-migration' // старая схема: запись после миграции
  | 'migrating' // миграция в процессе
  | 'newer' // схема новее: только чтение, «Обновите плагин»
  | 'invalid'; // маркер повреждён: только чтение

export interface MarkerState {
  status: SchemaStatus;
  marker: MarkerProperties | null;
  issues: PropertyIssue[];
}

// ---------------------------------------------------------------------------
// Целостность (ТЗ §3.8, §4.6)
// ---------------------------------------------------------------------------

export type AttentionKind =
  | 'duplicate-id' // копия получила новый id, показываются обе
  | 'conflict-copy' // файл похож на конфликтную копию
  | 'invalid-properties'
  | 'deleted-in-calendar' // событие удалено в «Календаре» iOS
  | 'pending-deletion' // tombstone записан, но файл не удалён (или наоборот)
  | 'schema'; // проблема маркера/схемы

export interface AttentionItem {
  /** Стабильный ключ для списка. */
  key: string;
  kind: AttentionKind;
  /** Затронутые заметки: для дубликатов и копий — обе версии. */
  paths: VaultPath[];
  itemId: ItemId | null;
  /** Ключ i18n и параметры описания. */
  messageKey: string;
  messageParams?: Record<string, string | number>;
  issues?: PropertyIssue[];
}

export interface IntegrityReport {
  checkedAt: IsoInstantString;
  items: AttentionItem[];
  /** id, выданные копиям при этой проверке: путь → новый id. */
  reassignedIds: Record<VaultPath, ItemId>;
}

// ---------------------------------------------------------------------------
// Настройки (ТЗ §4.6; data.json)
// ---------------------------------------------------------------------------

export type WeekStartSetting = 'auto' | 'monday' | 'sunday';
export type TimeFormatSetting = 'auto' | '24h' | '12h';
/** 0 — воскресенье, 1 — понедельник (как `Date.getDay()`). */
export type WeekStartDay = 0 | 1;

export type ArchiveSetting = { mode: 'never' } | { mode: 'after-days'; days: number };

export type WallpaperTemplate = 'matrix' | 'calendar';
export type WallpaperPalette = 'dark' | 'light' | 'translucent';
/** Композиция обоев (доработка 007): есть ли ряд виджетов iOS под часами. */
export type WallpaperLayoutPreset = 'widgets' | 'no-widgets';

/** Кадрирование картинки фона: доли (0–1) и масштаб (≥1). */
export interface WallpaperCrop {
  /** Центр кадра по X/Y в долях исходного изображения. */
  centerX: number;
  centerY: number;
  scale: number;
}

export type WallpaperBackground =
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; from: string; to: string; angle: number }
  | { kind: 'image'; path: VaultPath; crop: WallpaperCrop };

export interface WallpaperSettings {
  template: WallpaperTemplate;
  palette: WallpaperPalette;
  background: WallpaperBackground;
  /** `auto` — по размеру экрана; иначе id профиля (например `iphone-1179x2556`). */
  profile: WallpaperProfileSetting;
  /** Название быстрой команды для установки обоев. */
  shortcutName: string;
  tasksPerQuadrant: 2 | 3;
  weekStart: WeekStartSetting;
  /** Календари на обоях; `null` — как в «Показываемых календарях». */
  calendarIds: string[] | null;
  /** Виджеты под часами: есть (контент с ~31 % высоты) / нет (~27 %). Нет поля — `widgets`. */
  layoutPreset?: WallpaperLayoutPreset;
}

/** Специальные элементы списка «Показываемые календари». */
export interface VisibleCalendarsSetting {
  /**
   * «Планировщик»: события-заметки без `calendar_id` и календарь для записи синхронизации
   * на сервере (вместе с его наличием в `calendarIds`, см. `isEventCalendarVisible`).
   */
  planner: boolean;
  /** Календари с `kind: 'birthdays'` из кэша. */
  birthdays: boolean;
  /** Прочие календари из кэша по `calendar_id`. */
  calendarIds: string[];
}

export type CalendarSyncProvider = 'icloud' | 'caldav';

/** Подписка ICS (только чтение). */
export interface IcsSubscriptionSetting {
  name: string;
  url: string;
  /** CSS-цвет `#RRGGBB`. */
  color: string;
}

/**
 * Настройки синхронизации календаря. Пароль здесь не хранится (data.json синхронизируется):
 * он лежит в `app.secretStorage` или в локальном хранилище устройства.
 */
export interface CalendarSyncSettings {
  enabled: boolean;
  provider: CalendarSyncProvider;
  /** Адрес сервера для `caldav`; для iCloud не используется. */
  serverUrl: string;
  /** Apple ID или имя пользователя. */
  username: string;
  /** Календарь для событий и задач; `null` — найти или создать «Планировщик». */
  writeCalendarHref: string | null;
  /** Показываемые календари; пустой список — все календари с событиями. */
  readCalendarHrefs: string[];
  tasksToCalendar: boolean;
  completedTasksToCalendar: boolean;
  intervalMinutes: number;
  icsSubscriptions: IcsSubscriptionSetting[];
}

/** Единицы температуры погоды. */
export type WeatherUnits = 'celsius' | 'fahrenheit';

/** Погода в шапке «Задач» (Open-Meteo). Координаты — найденного города; без них — геолокация. */
export interface WeatherSettings {
  enabled: boolean;
  /** Найденное название («Москва, Россия»); пусто — геолокация устройства. */
  city: string;
  latitude: number | null;
  longitude: number | null;
  units: WeatherUnits;
}

export type PlannerTabId = 'tasks' | 'calendar' | 'lockscreen' | 'settings';
export type TasksLayout = 'grid' | 'list';
export type TasksListGrouping = 'quadrant' | 'date';
export type CalendarMode = 'list' | 'timeline' | 'month';

/** Источники календаря во вкладке (фильтр «Выбор источников»). */
export interface CalendarSourceFilter {
  tasks: boolean;
  events: boolean;
  notes: boolean;
  /** Внешние календари из кэша. */
  external: boolean;
}

export interface PlannerSettings {
  /** Версия формата настроек. */
  version: number;
  // Общие
  rootFolder: string;
  archive: ArchiveSetting;
  /** Время «в момент события» для задач без времени. */
  reminderTimeForDateOnly: LocalTimeString;
  // Календарь
  weekStart: WeekStartSetting;
  timeFormat: TimeFormatSetting;
  showTasksInIosCalendar: boolean;
  writeCompletedTasksToCalendar: boolean;
  /** Календарь для новых событий; `null` — «Планировщик». */
  defaultEventCalendarId: string | null;
  visibleCalendars: VisibleCalendarsSetting;
  // Экран блокировки
  wallpaper: WallpaperSettings;
  /** Синхронизация с «Календарём» iOS через CalDAV (iCloud или другой сервер) и подписки ICS. */
  calendarSync: CalendarSyncSettings;
  /** Погода в шапке вкладки «Задачи». */
  weather: WeatherSettings;
  /** Тактильный отклик (вибрация) на действия. */
  haptics: boolean;
  // Состояние интерфейса (не показывается в настройках)
  ui: {
    lastTab: PlannerTabId;
    tasksLayout: TasksLayout;
    tasksListGrouping: TasksListGrouping;
    calendarMode: CalendarMode;
    calendarSources: CalendarSourceFilter;
  };
}

// ---------------------------------------------------------------------------
// Служебные JSON (ТЗ §5.4.3–5.4.4; формат файлов — docs/system-json.md, S2.T1)
// ---------------------------------------------------------------------------

/** Тип календаря из EventKit (по `EKCalendarType`/источнику). */
export type CachedCalendarKind = 'local' | 'caldav' | 'exchange' | 'subscription' | 'birthdays' | 'other';

/** Нормализованный календарь из `calendar-cache.json`. */
export interface CachedCalendar {
  calendarId: string;
  title: string;
  /** CSS-цвет `#RRGGBB`. */
  color: string;
  kind: CachedCalendarKind;
  /** `allows_modifications` — можно выбрать для нового события. */
  allowsModifications: boolean;
}

/**
 * Нормализованное повторение события из кэша (каждое повторение — отдельная запись).
 * Время уже переведено в часовой пояс устройства читателем кэша.
 */
export interface CachedCalendarEvent {
  /** `calendarItemIdentifier` EventKit (общий для серии). */
  eventId: string;
  /** Уникальный ключ повторения: `eventId` + начало повторения. */
  occurrenceKey: string;
  calendarId: string;
  title: string;
  allDay: boolean;
  /** Для allDay — даты, `end` исключительная. */
  start: FloatingDateTime;
  end: FloatingDateTime;
  /** Абсолютное время (мс) для событий со временем; `null` для allDay. */
  startMs: number | null;
  endMs: number | null;
  /** Повтор как текст из EventKit (только для показа). */
  recurrenceText: string | null;
  /** `id` заметки-события из `matrixplanner://item/<id>`; `null` — внешнее событие. */
  linkedItemId: ItemId | null;
  location: string | null;
  url: string | null;
  notes: string | null;
}

export interface CalendarCacheData {
  version: number;
  generatedAt: IsoInstantString;
  /** Устройство, записавшее кэш. */
  deviceName: string | null;
  /** Покрытие кэша, включительно (по умолчанию −30…+180 дней). */
  range: DateRange;
  calendars: readonly CachedCalendar[];
  events: readonly CachedCalendarEvent[];
}

/** Состояние кэша календаря: отсутствие, повреждение, новая версия различаются. */
export type CalendarCacheState =
  | { status: 'missing' }
  | { status: 'corrupt'; detail: string }
  | { status: 'unsupported-version'; version: number }
  | { status: 'ok'; data: CalendarCacheData; /** Старше порога актуальности. */ stale: boolean };

/** Покрытие дня кэшем (ТЗ §4.4). */
export type CacheCoverage = 'no-cache' | 'out-of-range' | 'covered';

/** Запись `tombstones.json`. */
export interface TombstoneRecord {
  id: ItemId;
  kind: 'event';
  deletedAt: IsoInstantString;
}

/** Статус обоев по профилю (поля `companion.json`). Разные события — разные поля. */
export interface WallpaperStatusRecord {
  profileId: string;
  /** PNG сохранены плагином. */
  savedAt: IsoInstantString | null;
  /** Быстрая команда запускалась (по нажатию). */
  launchedAt: IsoInstantString | null;
  /** Подтверждено `x-success`/намерением. */
  confirmedAt: IsoInstantString | null;
  /** Получен `x-error`. */
  failedAt: IsoInstantString | null;
  /** Устройство, обновившее статус. */
  deviceName: string | null;
  /** Пользователь отменил команду (`x-cancel`). */
  cancelledAt?: IsoInstantString | null;
  /** Текст ошибки быстрой команды (`errorMessage` из `x-error`). */
  errorMessage?: string | null;
  /** Запуск, подтверждение которого ожидается (`runId` из ссылки). */
  runId?: string | null;
  /** Отпечаток данных сохранённого пакета PNG (хеш входа рендера). */
  fingerprint?: string | null;
}

export type CompanionState =
  | { status: 'missing' }
  | { status: 'corrupt'; detail: string }
  | {
      status: 'ok';
      primaryDevice: string | null;
      lastUpdate: IsoInstantString | null;
      wallpapers: Readonly<Record<string, WallpaperStatusRecord>>;
    };

// ---------------------------------------------------------------------------
// Элементы дня: общий вход календаря и обоев (ТЗ §4.4, §4.5)
// ---------------------------------------------------------------------------

export type DayItemSource = 'task' | 'event' | 'note' | 'external';

interface DayItemBase {
  /** Стабильный уникальный ключ в пределах дня (для DOM и дедупликации). */
  key: string;
  source: DayItemSource;
  /** День показа. */
  date: LocalDateString;
  title: string;
  /** Блок «Весь день» (задачи без времени, события на весь день). */
  allDay: boolean;
  /** Минуты от начала `date` (0–1440); `null` для allDay и заметок. */
  startMinute: number | null;
  endMinute: number | null;
  /** Многодневное событие: продолжение с предыдущего дня / на следующий. */
  continuesFromPrevious: boolean;
  continuesToNext: boolean;
  /** CSS-цвет точки/плашки. */
  color: string;
  icon: IconName | null;
}

export interface TaskDayItem extends DayItemBase {
  source: 'task';
  taskId: ItemId;
  quadrant: QuadrantKey;
  priority: Priority;
  /** Дата повторения (для выполнения из календаря); для обычной — дата `due`. */
  instanceDate: LocalDateString;
  /** Вычисленное будущее повторение, а не текущий `due`. */
  projected: boolean;
  recurring: boolean;
  completed: boolean;
  overdue: boolean;
}

export interface EventDayItem extends DayItemBase {
  source: 'event';
  eventId: ItemId;
  calendarId: string | null;
  recurring: boolean;
  /** Начало конкретного повторения. */
  occurrenceStart: FloatingDateTime;
}

export interface ExternalDayItem extends DayItemBase {
  source: 'external';
  calendarId: string;
  occurrenceKey: string;
  eventId: string;
  /** Календарь только для чтения — открывается в режиме просмотра. */
  readOnly: boolean;
}

export interface NoteDayItem extends DayItemBase {
  source: 'note';
  noteId: ItemId;
}

export type DayItem = TaskDayItem | EventDayItem | ExternalDayItem | NoteDayItem;

/** Элементы одного дня, уже разложенные по блокам ТЗ §4.4. */
export interface DayAgenda {
  date: LocalDateString;
  allDay: DayItem[];
  timed: DayItem[];
  notes: NoteDayItem[];
  coverage: CacheCoverage;
}

/** Сводка дня для ленты недели и месяца. */
export interface DaySummary {
  date: LocalDateString;
  /** До 3 цветов точек (без заметок). */
  dots: string[];
  /** Есть заметки (серая точка). */
  hasNotes: boolean;
  /** Есть выполненные задачи (галочка). */
  hasCompletedTasks: boolean;
  /** Число элементов без заметок. */
  count: number;
}

export interface DayItemsInput {
  range: DateRange;
  today: LocalDateString;
  /** Часовой пояс устройства (IANA) — для событий с `tz`. */
  timeZone: string;
  tasks: readonly Task[];
  events: readonly PlannerEvent[];
  notes: readonly QuickNote[];
  cache: CalendarCacheState;
  matrix: MatrixConfig;
  sources: CalendarSourceFilter;
  visibleCalendars: VisibleCalendarsSetting;
  /**
   * `calendar_id` календаря кэша, который и есть «Планировщик» на сервере (календарь для
   * записи синхронизации CalDAV). Он и флаг «Планировщик» — один календарь для видимости.
   */
  plannerCalendarId?: string | null;
  /** Показывать выполненные задачи/повторения. */
  includeCompleted: boolean;
}

/** Результат сборки: ключ — дата. Дни без элементов тоже присутствуют. */
export type DayItemsByDate = ReadonlyMap<LocalDateString, DayAgenda>;

// ---------------------------------------------------------------------------
// Ссылки obsidian://planner (ТЗ §4.8)
// ---------------------------------------------------------------------------

export type PlannerLink =
  | { action: 'view'; view: PlannerTabId }
  | { action: 'new-task'; quadrant: QuadrantKey | null; date: LocalDateString | null }
  | { action: 'open'; id: ItemId }
  | { action: 'wallpaper-done' }
  | { action: 'wallpaper-failed' }
  | { action: 'wallpaper-cancelled' };

// ---------------------------------------------------------------------------
// Обои: профиль и раскладка (ТЗ §4.5)
// ---------------------------------------------------------------------------

export interface WallpaperProfile {
  /** Имя папки: `iphone-1179x2556`. */
  id: string;
  label: string;
  width: number;
  height: number;
  /** Безопасные зоны в долях высоты: контент между `safeTop` и `safeBottom`. */
  safeTop: number;
  safeBottom: number;
}

export interface FontSpec {
  /** Пиксели холста. */
  size: number;
  weight: 400 | 500 | 600 | 700;
  /** `null` — системный шрифт. */
  family: string | null;
}

export interface TextMetrics {
  width: number;
  ascent: number;
  descent: number;
}

/** Команда рисования для тонкого Canvas 2D renderer. Координаты — пиксели холста. */
export type DrawCommand =
  | {
      op: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      radius: number;
      fill: string;
      stroke?: string;
      lineWidth?: number;
      /** Карточка: на фото-фоне под заливкой рисуется матовое стекло (размытый фон). */
      backdrop?: 'blur';
    }
  | { op: 'circle'; cx: number; cy: number; r: number; fill: string | null; stroke: string | null; lineWidth: number }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; lineWidth: number }
  | {
      op: 'text';
      x: number;
      y: number;
      text: string;
      font: FontSpec;
      color: string;
      align: 'left' | 'center' | 'right';
      baseline: 'top' | 'middle' | 'alphabetic' | 'bottom';
      /** Зачёркнутый текст. */
      strike?: boolean;
    }
  | { op: 'icon'; name: IconName; x: number; y: number; size: number; color: string };

export interface WallpaperLayout {
  width: number;
  height: number;
  commands: DrawCommand[];
  /** Сколько элементов не поместилось (по блокам), для предупреждений. */
  overflow: Record<string, number>;
}

/** Строки, которые раскладка не вычисляет сама (локализованные подписи). */
export interface WallpaperStrings {
  quadrantTitles: Readonly<Record<QuadrantKey, string>>;
  weekdayShort: readonly string[]; // 7 элементов, начиная с воскресенья
  monthNames: readonly string[]; // 12 элементов
  emptyQuadrant: string;
  /** Относительная подпись срока задачи («Сегодня 17:00»). */
  formatDue(due: FloatingDateTime, relativeTo: LocalDateString): string;
  /** «Прогресс года: 78 %» и т. п. */
  yearProgress(percent: number): string;
  moreItems(count: number): string;
}

export interface WallpaperLayoutInput {
  template: WallpaperTemplate;
  palette: WallpaperPalette;
  profile: WallpaperProfile;
  /** Дата, на которую рисуются обои (выделенный день). */
  date: LocalDateString;
  weekStart: WeekStartDay;
  hour12: boolean;
  tasksPerQuadrant: 2 | 3;
  matrix: MatrixConfig;
  /** Незавершённые задачи по квадрантам, уже отсортированные. */
  tasksByQuadrant: Readonly<Record<QuadrantKey, readonly Task[]>>;
  /** Элементы дней для недели/месяца (заметки исключаются раскладкой). */
  days: DayItemsByDate;
  strings: WallpaperStrings;
  /** Композиция: виджеты под часами есть/нет; нет поля — `widgets`. */
  layoutPreset?: WallpaperLayoutPreset;
  /**
   * Запасные обои «устарели» (доработка 007, п.5): без выделенного дня и относительных
   * сроков, сверху плашка «Обои устарели — откройте Obsidian».
   */
  expired?: boolean;
}
