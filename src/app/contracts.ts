/**
 * Контракты сервисов и компонентов Matrix planner.
 *
 * Файл фиксируется задачей S1.T1 и не меняется параллельными задачами.
 * Не импортирует `obsidian`: реализации получают `App` в конструкторе,
 * а потребители видят только эти интерфейсы (удобно для тестов и DI).
 * Описание и правила использования — docs/contracts.md.
 */

import type {
  AttentionItem,
  CacheCoverage,
  CachedCalendar,
  CalendarCacheState,
  CompanionState,
  CompletionEntry,
  DateRange,
  DayItem,
  DayItemsByDate,
  DayItemsInput,
  DrawCommand,
  EventDraft,
  EventPatch,
  FontSpec,
  FrontmatterRecord,
  IntegrityReport,
  InvalidPlannerNote,
  ItemId,
  Language,
  LocalDateString,
  MarkerState,
  MatrixConfig,
  NoteDraft,
  OpResult,
  ParsedNote,
  PlannerEvent,
  PlannerItem,
  PlannerLink,
  PlannerPaths,
  PlannerSettings,
  PlannerTabId,
  QuadrantKey,
  QuickNote,
  SystemJsonName,
  Task,
  TaskDraft,
  TaskPatch,
  TextMetrics,
  TombstoneRecord,
  Unsubscribe,
  VaultPath,
  WallpaperBackground,
  WallpaperLayout,
  WallpaperLayoutInput,
  WallpaperProfile,
  WallpaperSettings,
  WallpaperStatusRecord,
  WeekStartDay,
} from '../model/types';

// ===========================================================================
// Инфраструктура: время, ID, платформа, измерение текста, уведомления
// ===========================================================================

/** Источник текущего времени. В тестах — фиксированные часы. */
export interface Clock {
  now(): Date;
  /** IANA-зона устройства (`Intl.DateTimeFormat().resolvedOptions().timeZone`). */
  timeZone(): string;
}

/** Генератор ULID. Монотонный в пределах одной миллисекунды. */
export interface IdGenerator {
  next(): ItemId;
}

/** Измерение текста для раскладки обоев (Canvas `measureText` или фиктивное в тестах). */
export interface TextMeasurer {
  measure(text: string, font: FontSpec): TextMetrics;
}

/** Сведения о платформе (обёртка над `Platform`). */
export interface PlatformInfo {
  isMobile: boolean;
  isPhone: boolean;
  isTablet: boolean;
  isIos: boolean;
  isAndroid: boolean;
  isDesktop: boolean;
}

/** Показ коротких сообщений (`Notice`). */
/** Действие-ссылка в уведомлении («Вернуть», «Открыть настройки»). */
export interface NoticeAction {
  label: string;
  run(): void;
}

export interface Notifier {
  show(message: string, timeoutMs?: number): void;
  /** Уведомление с действием; без реализации вызывающий показывает `show(message)`. */
  showAction?(message: string, action: NoticeAction, timeoutMs?: number): void;
}

/** Региональные настройки, вычисленные из настроек плагина и локали. */
export interface FormatPreferences {
  language: Language;
  weekStart: WeekStartDay;
  hour12: boolean;
}

export interface FormatPreferencesProvider {
  get(): FormatPreferences;
}

// ===========================================================================
// Хранение (S1.T3)
// ===========================================================================

/** Запрет записи при новой/повреждённой схеме или во время миграции. */
export interface WriteGuard {
  canWrite(): boolean;
  /** `null` — запись разрешена; иначе ошибка `read-only` для `OpResult`. */
  check(): { code: 'read-only'; messageKey: string } | null;
}

/** Маркер `matrix-planner.md` и проверка схемы. */
export interface MarkerService {
  getState(): MarkerState;
  /**
   * Идемпотентно создаёт маркер и папки корня (если запись разрешена) и
   * перечитывает схему. Не перезаписывает существующий `vault_id`.
   */
  ensure(): Promise<MarkerState>;
  /** Поднять/снять флаг миграции. */
  setMigrating(migrating: boolean): Promise<void>;
  onChange(listener: (state: MarkerState) => void): Unsubscribe;
}

export interface CreateNoteRequest {
  /** Папка (внутри корня). Создаётся при отсутствии. */
  folder: VaultPath;
  /** Желаемое название; недопустимые символы заменяются, при совпадении — ` (2)`. */
  title: string;
  frontmatter: FrontmatterRecord;
  body: string;
}

export interface FolderListing {
  files: VaultPath[];
  folders: VaultPath[];
}

/**
 * Доступ к заметкам и файлам Планировщика. Все пути проходят `normalizePath()`
 * и проверку «внутри корня» (иначе `outside-root`). Пишущие методы проверяют `WriteGuard`.
 * Свойства — `processFrontMatter`, тело — `vault.process` (активная заметка — через Editor API).
 */
export interface NoteRepository {
  readonly paths: PlannerPaths;
  exists(path: VaultPath): boolean;
  /** Создаёт заметку, возвращает итоговый путь. */
  create(request: CreateNoteRequest): Promise<OpResult<VaultPath>>;
  /** Точечно меняет свойства; неизвестные свойства и тело не трогаются. */
  updateFrontmatter(path: VaultPath, mutate: (frontmatter: FrontmatterRecord) => void): Promise<OpResult>;
  readBody(path: VaultPath): Promise<OpResult<string>>;
  /** Меняет тело (без frontmatter). */
  updateBody(path: VaultPath, transform: (body: string) => string): Promise<OpResult>;
  /** Переименование с той же папкой; коллизии — ` (2)`. Возвращает новый путь. */
  rename(path: VaultPath, newTitle: string): Promise<OpResult<VaultPath>>;
  /** Перенос в другую папку внутри корня. Возвращает новый путь. */
  move(path: VaultPath, folder: VaultPath): Promise<OpResult<VaultPath>>;
  /** Удаление только через `fileManager.trashFile`. */
  trash(path: VaultPath): Promise<OpResult>;
  ensureFolder(path: VaultPath): Promise<OpResult>;
  listFolder(path: VaultPath): Promise<OpResult<FolderListing>>;
  readBinary(path: VaultPath): Promise<OpResult<ArrayBuffer>>;
  /** `createBinary` или `modifyBinary`. */
  writeBinary(path: VaultPath, data: ArrayBuffer): Promise<OpResult>;
}

/** Разбор свойств заметки (реализация — model/properties, S1.T2). */
export interface PlannerNoteParser {
  /** `null` — заметка не относится к Планировщику (нет `type: task|event|note`). */
  parse(input: { path: VaultPath; title: string; mtime: number; frontmatter: FrontmatterRecord | null; archived: boolean; deletedInCalendar: boolean }): ParsedNote | null;
  parseMatrix(path: VaultPath | null, frontmatter: FrontmatterRecord | null): MatrixConfig;
}

export interface IndexChange {
  /** `reset` — полная перестройка (смена корня, первичная индексация). */
  kind: 'reset' | 'upsert' | 'remove' | 'matrix';
  paths: VaultPath[];
  ids: ItemId[];
}

/**
 * Инкрементальный индекс заметок Планировщика внутри корня.
 * Обновляется по `metadataCache.changed`, `vault.rename/delete`; после записи
 * не считается обновлённым до события `changed` (см. `waitFor`).
 */
export interface NoteIndex {
  isReady(): boolean;
  /** Резолвится после `metadataCache.resolved` и первичной индексации. */
  whenReady(): Promise<void>;
  getTasks(): readonly Task[];
  getEvents(): readonly PlannerEvent[];
  getNotes(): readonly QuickNote[];
  getInvalid(): readonly InvalidPlannerNote[];
  getMatrix(): MatrixConfig;
  /** Первая по пути заметка с этим id (дубликаты — `getAllById`). */
  getById(id: ItemId): PlannerItem | undefined;
  getAllById(id: ItemId): readonly PlannerItem[];
  getByPath(path: VaultPath): PlannerItem | InvalidPlannerNote | undefined;
  onChange(listener: (change: IndexChange) => void): Unsubscribe;
  /**
   * Ждёт, пока индекс увидит заметку по пути и `predicate` вернёт true
   * (после записи и события `changed`). По таймауту — последнее известное состояние или `null`.
   */
  waitFor(path: VaultPath, predicate?: (item: ParsedNote) => boolean, timeoutMs?: number): Promise<ParsedNote | null>;
  /** Полная перестройка (смена корня). */
  rebuild(): Promise<void>;
}

export type SystemJsonReadResult =
  | { status: 'missing' }
  | { status: 'corrupt'; detail: string }
  | { status: 'ok'; value: unknown };

/**
 * Служебные JSON в `_system/` — только через `vault.adapter`.
 * Записи сериализуются локальной очередью; `update` перечитывает файл перед изменением
 * и сохраняет неизвестные поля (ответственность мутатора — менять только свои ключи).
 */
export interface SystemJsonStore {
  path(name: SystemJsonName): VaultPath;
  read(name: SystemJsonName): Promise<SystemJsonReadResult>;
  /**
   * `current` — разобранный объект или `null`, если файла нет. Повреждённый файл не перезаписывается:
   * ошибка `invalid`. Запись `calendar-cache.json` запрещена (ошибка `read-only`).
   */
  update(name: SystemJsonName, mutate: (current: Record<string, unknown> | null) => Record<string, unknown>): Promise<OpResult<Record<string, unknown>>>;
  write(name: SystemJsonName, value: Record<string, unknown>): Promise<OpResult>;
}

/** Очередь последовательных записей по ключу (путь файла). */
export interface WriteQueue {
  run<T>(key: string, job: () => Promise<T>): Promise<T>;
}

// ===========================================================================
// Настройки (S1.T5)
// ===========================================================================

export interface SettingsStore {
  get(): Readonly<PlannerSettings>;
  /** Загружает data.json, дополняет значениями по умолчанию, сохраняет неизвестные поля. */
  load(): Promise<void>;
  /** Изменяет копию настроек и сохраняет. Слушатели вызываются после сохранения. */
  update(mutate: (draft: PlannerSettings) => void): Promise<void>;
  onChange(listener: (settings: Readonly<PlannerSettings>, previous: Readonly<PlannerSettings>) => void): Unsubscribe;
}

/** Дополнительная секция экрана настроек (календари, компаньон, данные — подключаются позже). */
export interface SettingsSection {
  /** Порядок: 0 общие, 10 календарь, 20 экран блокировки, 30 компаньон, 40 данные. */
  order: number;
  render(containerEl: HTMLElement): void;
  /** Освобождение подписок при скрытии вкладки настроек. */
  dispose?(): void;
}

// ===========================================================================
// Задачи (S1.T6)
// ===========================================================================

export interface TaskService {
  create(draft: TaskDraft): Promise<OpResult<Task | null>>;
  /** Название меняет имя файла (id сохраняется). */
  update(id: ItemId, patch: TaskPatch): Promise<OpResult>;
  /**
   * Выполнить задачу. Для повторяющейся `instanceDate` — дата повторения
   * (по умолчанию текущий `due`); если дата уже в `completions` — `changed: false`.
   * Если `instanceDate` не совпадает с ожидаемым состоянием — `stale`.
   */
  complete(id: ItemId, instanceDate?: LocalDateString): Promise<OpResult>;
  /** Вернуть в работу (ТЗ §3.3: дата убирается из `completions`, `due` может вернуться). */
  uncomplete(id: ItemId, instanceDate?: LocalDateString): Promise<OpResult>;
  moveToQuadrant(id: ItemId, quadrant: QuadrantKey): Promise<OpResult>;
  /** Перенести срок на дату (время сохраняется). */
  reschedule(id: ItemId, date: LocalDateString): Promise<OpResult>;
  /** Перенести на завтра относительно `Clock`. */
  postponeToTomorrow(id: ItemId): Promise<OpResult>;
  /** Удаление в корзину. */
  delete(id: ItemId): Promise<OpResult>;
  /** Записи фильтра «Выполнено». */
  getCompletions(): readonly CompletionEntry[];
}

export interface ArchiveService {
  /** Переносит выполненные одиночные задачи старше N дней. Возвращает число перенесённых. */
  runAuto(): Promise<OpResult<number>>;
  archive(id: ItemId): Promise<OpResult>;
  restore(id: ItemId): Promise<OpResult>;
}

// ===========================================================================
// События и заметки (S2.T2)
// ===========================================================================

/** Вариант выбора календаря в форме события. */
export interface CalendarOption {
  /** `null` — «Планировщик». */
  calendarId: string | null;
  title: string;
  color: string;
}

export type DeleteEventStage = 'tombstone' | 'trash';

export interface EventService {
  create(draft: EventDraft): Promise<OpResult<PlannerEvent | null>>;
  /** Меняет всю серию. */
  update(id: ItemId, patch: EventPatch): Promise<OpResult>;
  /**
   * Сначала tombstone, затем корзина. При сбое ошибка содержит этап в `detail`
   * (`tombstone`/`trash`); повторный вызов завершает операцию.
   */
  delete(id: ItemId): Promise<OpResult>;
  /** «Планировщик» + календари кэша с `allowsModifications`. */
  getWritableCalendars(): readonly CalendarOption[];
}

export interface NoteService {
  create(draft: NoteDraft): Promise<OpResult<VaultPath>>;
  update(id: ItemId, patch: Partial<NoteDraft>): Promise<OpResult>;
  delete(id: ItemId): Promise<OpResult>;
}

// ===========================================================================
// Служебные данные календаря и компаньона (S2.T1)
// ===========================================================================

/** Только чтение `calendar-cache.json`. Никогда не записывает. */
export interface CalendarCacheReader {
  getState(): CalendarCacheState;
  /** Перечитывает файл (по изменению в хранилище или вручную). */
  refresh(): Promise<CalendarCacheState>;
  coverage(date: LocalDateString): CacheCoverage;
  getCalendars(): readonly CachedCalendar[];
  onChange(listener: (state: CalendarCacheState) => void): Unsubscribe;
}

export interface TombstoneWriter {
  /** Идемпотентно: повторный id не дублируется. Объединяет с записями других устройств. */
  add(id: ItemId, kind: 'event'): Promise<OpResult>;
  list(): Promise<OpResult<readonly TombstoneRecord[]>>;
  has(id: ItemId): Promise<boolean>;
}

/** Чтение `companion.json` и изменение только полей статуса обоев. */
export interface CompanionStore {
  read(): Promise<CompanionState>;
  getState(): CompanionState;
  updateWallpaperStatus(profileId: string, patch: Partial<Omit<WallpaperStatusRecord, 'profileId'>>): Promise<OpResult>;
  onChange(listener: (state: CompanionState) => void): Unsubscribe;
}

// ===========================================================================
// Календарная логика (S2.T3, чистые функции)
// ===========================================================================

/** Сигнатура сборки элементов дней (реализация — calendar/day-items.ts). */
export type DayItemsBuilder = (input: DayItemsInput) => DayItemsByDate;

export interface DayItemsOptions {
  includeCompleted?: boolean;
  forWallpaper?: boolean;
  /**
   * Только с `forWallpaper`: календари обоев вместо `settings.wallpaper.calendarIds`
   * (`null` — как в календаре). Нужен предпросмотру черновика редактора.
   */
  calendarIds?: readonly string[] | null;
}

/** Источник данных для календаря и обоев, собранный из индекса, настроек и кэша. */
export interface DayItemsProvider {
  /** Элементы дней диапазона с текущими фильтрами источников. */
  getDays(range: DateRange, options?: DayItemsOptions): DayItemsByDate;
  onChange(listener: () => void): Unsubscribe;
  /** Дождаться загрузки вспомогательных данных (меток удаления) перед снимком — например, для обоев. */
  prepare?(): Promise<void>;
}

// ===========================================================================
// Целостность (S1.T9)
// ===========================================================================

export interface IntegrityService {
  check(): Promise<OpResult<IntegrityReport>>;
  getLastReport(): IntegrityReport | null;
  /** «Оставить эту версию» — убрать пометку, ничего не удаляя. */
  keepVersion(item: AttentionItem, path: VaultPath): Promise<OpResult>;
  onChange(listener: (report: IntegrityReport | null) => void): Unsubscribe;
}

// ===========================================================================
// Обои (S2.T4 раскладка, S2.T7 рендер, S2.T8 редактор)
// ===========================================================================

/** Чистая раскладка шаблона → команды рисования. */
export type WallpaperLayoutFn = (input: WallpaperLayoutInput, measurer: TextMeasurer) => WallpaperLayout;

/** Фон, подготовленный к рисованию (картинка уже загружена renderer'ом). */
export interface WallpaperRenderRequest {
  layout: WallpaperLayout;
  background: WallpaperBackground;
}

/** Тонкий Canvas 2D renderer: команды → PNG. */
export interface WallpaperRenderer {
  render(request: WallpaperRenderRequest): Promise<ArrayBuffer>;
  /** Отрисовка в существующий canvas (предпросмотр редактора). */
  renderTo(canvas: HTMLCanvasElement, request: WallpaperRenderRequest): Promise<void>;
  /** Измеритель текста, согласованный с renderer'ом. */
  readonly measurer: TextMeasurer;
  /** Освободить кэши (картинка фона, значки) после пакета. */
  releaseResources?(): void;
}

export interface WallpaperRenderFailure {
  date: LocalDateString;
  detail: string;
}

export interface WallpaperRenderResult {
  profile: WallpaperProfile;
  /** Сохранённые файлы `lock-ГГГГ-ММ-ДД.png`. */
  written: VaultPath[];
  failed: WallpaperRenderFailure[];
  /** `lock.png` обновлён (при неудаче остаётся прежний). */
  lockUpdated: boolean;
  /** Ревизия данных, на которой выполнен рендер (для «есть изменения»). */
  dataRevision: number;
  /** Отпечаток данных пакета (хеш входа рендера); хранится в `companion.json`. */
  fingerprint?: string;
  /** Отпечаток совпал с сохранённым и файлы на месте: рендер и запись пропущены. */
  unchanged?: boolean;
}

/** Параметры пакета обоев. */
export interface WallpaperRenderOptions {
  /** Отпечаток сохранённого пакета: при совпадении и наличии файлов рендер пропускается. */
  knownFingerprint?: string | null;
}

export interface WallpaperService {
  /** Профиль по настройкам или размеру экрана. */
  resolveProfile(settings?: WallpaperSettings): WallpaperProfile;
  /** Пакет на 7 дат (сегодня…+6) + `lock.png`; очистка старых своих файлов профиля. */
  renderAll(options?: WallpaperRenderOptions): Promise<OpResult<WallpaperRenderResult>>;
  /** Предпросмотр по черновику настроек на дату. */
  renderPreview(canvas: HTMLCanvasElement, draft: WallpaperSettings, date: LocalDateString): Promise<void>;
  /** Путь последнего `lock.png` текущего профиля или `null`. */
  getCurrentImagePath(): VaultPath | null;
}

/** Состояние баннера «Обновить экран блокировки» (ТЗ §4.5). */
export type WallpaperBannerState =
  | { kind: 'idle' }
  | { kind: 'dirty' } // «Есть изменения…»
  | { kind: 'rendering' }
  | { kind: 'saved'; at: string } // PNG сохранены (desktop/Android — финальное состояние)
  | { kind: 'launched'; at: string } // команда запущена, подтверждения нет
  | { kind: 'ready'; at: string } // PNG готовы, жест истёк или подготовлены в фоне: «Установить»
  | { kind: 'cancelled'; at: string } // x-cancel: изменения не перенесены, без ошибки
  | { kind: 'confirmed'; at: string } // x-success
  | { kind: 'failed'; reason: 'render' | 'shortcut' | 'callback-error'; message?: string | null };

/** Тексты баннера по состоянию (S2.T5 `describeBanner`). */
export interface BannerDescription {
  text: string;
  /** Подпись действия баннера («Обновить экран блокировки» / «Сохранить обои»). */
  actionLabel: string;
  /** Показать действие «Как настроить» (ошибка быстрой команды). */
  helpLabel: string | null;
  /** Баннер требует внимания (есть несохранённые изменения или ошибка). */
  attention: boolean;
}

/** Отслеживание изменений данных и статуса обоев для баннера. */
export interface WallpaperStatusTracker {
  getState(): WallpaperBannerState;
  /** Тексты баннера для текущего состояния. */
  describe(): BannerDescription;
  /** Строка статуса карточки «Текущий» (по `companion.json`). */
  getStatusText(): string;
  /** PNG соответствуют текущей ревизии данных. */
  isFresh(): boolean;
  /** Действие баннера: iPhone/iPad — «Обновить экран блокировки», иначе — «Сохранить обои». */
  getActionKind(): 'update' | 'save';
  /** Текущая ревизия данных (растёт при изменении задач/событий). */
  getDataRevision(): number;
  markDataChanged(): void;
  /** Нажатие баннера: рендер → (iOS) запуск быстрой команды. */
  run(): Promise<void>;
  onWallpaperCallback(result: 'done' | 'failed' | 'cancelled'): Promise<void>;
  onChange(listener: (state: WallpaperBannerState) => void): Unsubscribe;
}

/** Запуск «Быстрых команд» по x-callback-url (только по жесту пользователя). */
export interface ShortcutLauncher {
  launch(shortcutName: string): { ok: true } | { ok: false; reason: 'unsupported' | 'recently-launched' };
}

// ===========================================================================
// Протокол obsidian://planner (S2.T5)
// ===========================================================================

export type ParsedLinkResult =
  | { ok: true; link: PlannerLink }
  | { ok: false; messageKey: string };

export interface ProtocolHandler {
  /** Параметры из `registerObsidianProtocolHandler`. До `resolved` обработка откладывается. */
  handle(params: Record<string, string>): Promise<void>;
}

export interface LinkBuilder {
  build(link: PlannerLink): string;
  /** `shortcuts://x-callback-url/run-shortcut?...` c `x-success`/`x-error` на planner. */
  shortcutRunUrl(shortcutName: string): string;
}

// ===========================================================================
// Интерфейс: вид «Планировщик», вкладки, формы, баннер (S1.T4 и далее)
// ===========================================================================

/** Контекст кнопки «+» и подстановки в формы. */
export interface AddContext {
  date: LocalDateString | null;
  quadrant: QuadrantKey | null;
}

export type TaskFormRequest =
  | { mode: 'create'; quadrant?: QuadrantKey | null; date?: LocalDateString | null }
  | { mode: 'edit'; id: ItemId };

export type EventFormRequest =
  /** `time` — начало нового события (долгое нажатие на временной шкале), длительность — 1 ч. */
  | { mode: 'create'; date?: LocalDateString | null; time?: import('../model/types').LocalTimeString | null }
  | { mode: 'edit'; id: ItemId }
  /** Внешнее событие из кэша — просмотр. */
  | { mode: 'view-external'; occurrenceKey: string };

export type NoteFormRequest =
  | { mode: 'create'; date?: LocalDateString | null }
  | { mode: 'edit'; id: ItemId };

/** Действия, доступные вкладкам, меню и командам. Реализация — сборка (compose-*). */
export interface PlannerActions {
  openTaskForm(request: TaskFormRequest): void;
  /** Без реализации до этапа 2: `isAvailable('event')` → false. */
  openEventForm(request: EventFormRequest): void;
  openNoteForm(request: NoteFormRequest): void;
  /** Меню «Добавить» (лист на мобильных, меню на компьютере). */
  openAddMenu(context: AddContext, anchor?: MouseEvent | HTMLElement): void;
  /** Открыть заметку в редакторе. */
  openNote(path: VaultPath, options?: { newLeaf?: boolean }): Promise<void>;
  /** Открыть элемент по id (задача → форма, заметка → редактор, событие → форма/просмотр). */
  openItem(id: ItemId): Promise<void>;
  /** Открыть «Задачи»/«Календарь»/«Блокировка» в существующем виде. */
  showTab(tab: PlannerTabId, options?: { date?: LocalDateString }): Promise<void>;
  /** Открыть раздел плагина в настройках Obsidian (доработка 008: вкладки «Настройки» в виде нет). */
  openSettings(): void;
  /** Какие формы подключены. */
  isAvailable(feature: 'task' | 'event' | 'note' | 'wallpaper'): boolean;
}

/** Хост вида: оболочка, через которую вкладки взаимодействуют с видом. */
export interface PlannerViewHost {
  readonly actions: PlannerActions;
  readonly platform: PlatformInfo;
  getActiveTab(): PlannerTabId;
  switchTab(tab: PlannerTabId): void;
  /** Вкладка сообщает текущий контекст «+» (выбранный день/квадрант). */
  setAddContext(context: AddContext): void;
  getAddContext(): AddContext;
  /** Регистрирует очистку при закрытии вида. */
  register(cleanup: () => void): void;
}

/** Вкладка вида. `mount` может вызываться повторно после `unmount`. */
export interface TabController {
  readonly id: PlannerTabId;
  mount(containerEl: HTMLElement): void;
  /** Освобождает DOM-обработчики и подписки. */
  unmount(): void;
  /** Вкладка стала видимой (после `mount` или переключения). */
  onShow?(): void;
  onHide?(): void;
  /** Внешний запрос (ссылка/команда), например выбрать дату в календаре. */
  focus?(options: { date?: LocalDateString }): void;
}

export type TabFactory = (host: PlannerViewHost) => TabController;

/** Баннер над панелью вкладок (S2.T8). */
export interface BannerController {
  mount(containerEl: HTMLElement): void;
  unmount(): void;
}

export type BannerFactory = (host: PlannerViewHost) => BannerController;

/** Состав вида, передаваемый сборкой. Отсутствующая вкладка показывается как недоступная. */
export interface PlannerViewOptions {
  tabs: Partial<Record<PlannerTabId, TabFactory>>;
  banner: BannerFactory | null;
  actions: PlannerActions;
  platform: PlatformInfo;
  initialTab: PlannerTabId;
  /**
   * С этой ширины вида «Задачи» и «Календарь» стоят рядом.
   * `null` — выключено; не задано — 900 px (ТЗ §7.1).
   */
  splitMinWidth?: number | null;
  /** Сохранение последней вкладки. */
  onTabChange?(tab: PlannerTabId): void;
}

/** Нижний лист / модальная форма (S1.T4 form-sheet). */
export interface SheetOptions {
  title: string;
  /** Текст кнопки подтверждения («Готово»); `null` — без кнопки. */
  submitLabel: string | null;
  /** На iPhone — лист во весь экран. */
  fullScreenOnPhone: boolean;
  /** Дополнительный класс окна листа (оформление конкретного листа). */
  cls?: string;
  /** Кнопка справа в шапке вместо «Готово» (при `submitLabel: null`), например «Итоги». */
  headerAction?: SheetHeaderAction;
  render(contentEl: HTMLElement, handle: SheetHandle): void;
  /** Возврат `false` оставляет лист открытым (ошибка сохранения). */
  onSubmit?(): Promise<boolean> | boolean;
  onClose?(): void;
  /**
   * Форма изменена (доработка 006, §6): закрытие свайпом, крестиком, Esc или касанием вне листа
   * сначала спрашивает «Сбросить изменения?». Нет функции или `false` — лист закрывается сразу.
   */
  isDirty?(): boolean;
  /** Тактильный отклик листа (вопрос «Сбросить изменения?» — `warning`). */
  haptic?(kind: import('../ui/haptics').HapticKind): void;
}

export interface SheetHeaderAction {
  icon: string;
  label: string;
  onClick(evt: MouseEvent): void;
}

export interface SheetHandle {
  setSubmitEnabled(enabled: boolean): void;
  setBusy(busy: boolean): void;
  /** Закрыть без вопроса (после сохранения или удаления). */
  close(): void;
  /** «Готово» из формы (Enter в названии); недоступная кнопка — без действия. */
  submit?(): void;
  /** Закрыть как пользователь: изменённая форма спрашивает «Сбросить изменения?». `true` — закрыт. */
  requestClose?(): Promise<boolean>;
}

export interface SheetPresenter {
  open(options: SheetOptions): SheetHandle;
}

/** Выбор даты (S1.T4 date-picker). */
export interface DatePickerOptions {
  value: LocalDateString | null;
  today: LocalDateString;
  weekStart: WeekStartDay;
  language: Language;
  onChange(value: LocalDateString | null): void;
  /** Показывать «Сегодня», «Завтра», «Через неделю» и очистку. */
  quickOptions: boolean;
}

export interface DatePickerHandle {
  setValue(value: LocalDateString | null): void;
  destroy(): void;
}

export type DatePickerFactory = (containerEl: HTMLElement, options: DatePickerOptions) => DatePickerHandle;

// ===========================================================================
// Состав сервисов (собираются в compose-core / compose-planner)
// ===========================================================================

export interface CoreServices {
  clock: Clock;
  ids: IdGenerator;
  platform: PlatformInfo;
  notifier: Notifier;
  format: FormatPreferencesProvider;
  settings: SettingsStore;
  guard: WriteGuard;
  marker: MarkerService;
  repository: NoteRepository;
  index: NoteIndex;
  systemJson: SystemJsonStore;
  tasks: TaskService;
  archive: ArchiveService;
  integrity: IntegrityService;
  sheets: SheetPresenter;
  datePicker: DatePickerFactory;
  /** Тактильный отклик (src/ui/haptics.ts); необязателен — в тестах и на платформах без отклика отсутствует. */
  haptics?: { play(kind: import('../ui/haptics').HapticKind): void };
  /**
   * Общая очередь отложенных удалений с «Вернуть» (доработка 006, §12): удалённый из формы
   * элемент сразу скрывается во вкладках, а удаляется через 5 с. Необязательна.
   */
  pendingDeletes?: PendingDeletes;
}

/** Отложенные удаления (реализация — `DeferredDeletes` + подписка). */
export interface PendingDeletes {
  schedule(id: ItemId, run: () => void, delayMs?: number): void;
  /** «Вернуть»: `true` — удаление ещё не выполнено и отменено. */
  undo(id: ItemId): boolean;
  has(id: ItemId): boolean;
  /** Выполнить ожидающие удаления сейчас (выгрузка плагина). */
  flush(): void;
  onChange(listener: () => void): Unsubscribe;
}

export interface PlannerServices extends CoreServices {
  calendarCache: CalendarCacheReader;
  tombstones: TombstoneWriter;
  companion: CompanionStore;
  events: EventService;
  notes: NoteService;
  dayItems: DayItemsProvider;
  wallpaper: WallpaperService;
  wallpaperStatus: WallpaperStatusTracker;
  links: LinkBuilder;
  shortcuts: ShortcutLauncher;
}

/** Реэкспорт часто нужных типов для удобства потребителей контрактов. */
export type { DayItem, DrawCommand };
