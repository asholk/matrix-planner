/**
 * Сборка ядра этапа 1 (S1.T10): настройки → маркер → индекс → сервисы задач,
 * архива и целостности → вид «Планировщик» с вкладкой «Задачи» → значок на ленте,
 * команды и вкладка настроек. Все подписки регистрируются в `Plugin` (register/registerEvent),
 * поэтому выгрузка плагина освобождает их без отдельного кода в `onunload`.
 *
 * Вкладки «Календарь» и «Блокировка», формы события и заметки подключает этап 2 (compose-planner)
 * через `extend`: расширение получает сервисы ядра до регистрации вида, команд и настроек
 * и возвращает вкладки, баннер и дополнительные зависимости настроек.
 */

import { Notice, Platform, type App, type Plugin, type WorkspaceLeaf } from 'obsidian';
import type {
  BannerFactory,
  Clock,
  CoreServices,
  FormatPreferences,
  FormatPreferencesProvider,
  IdGenerator,
  Notifier,
  PlannerActions,
  PlannerViewOptions,
  NoteIndex,
  PlatformInfo,
  TabFactory,
  TaskService,
} from './contracts';
import type { ItemId, Language, PlannerPaths, PlannerSettings, PlannerTabId, VaultPath, WeekStartDay } from '../model/types';
import type { SettingsTabDeps } from '../settings/types';
import { getCurrentLanguage, registerDictionary, t } from '../i18n';
import { ruModel } from '../i18n/ru/model';
import { enModel } from '../i18n/en/model';
import { ruApp } from '../i18n/ru/app';
import { enApp } from '../i18n/en/app';
import { createUlidGenerator } from '../model/ids';
import { createPlannerNoteParser } from '../model/properties';
import { PluginSettingsStore } from '../settings/settings-store';
import { PlannerSettingTab } from '../settings/settings-tab';
import { MarkerWriteGuard, MigrationWriteGuard, VaultMarkerService } from '../storage/marker';
import { ObsidianNoteRepository } from '../storage/note-repository';
import { MetadataNoteIndex } from '../storage/note-index';
import { AdapterSystemJsonStore } from '../storage/system-json-store';
import { createWriteQueue } from '../storage/write-queue';
import { createPlannerPaths } from '../storage/paths';
import { VaultTaskService, clockToday } from '../tasks/task-service';
import { VaultArchiveService } from '../tasks/archive-service';
import { TaskActions } from '../tasks/task-actions';
import { openTaskForm } from '../tasks/task-form';
import { createTasksTab } from '../tasks/tasks-tab';
import { VaultIntegrityService } from '../integrity/integrity-service';
import { createAttentionPanel, createWorkspaceOpeners } from '../integrity/attention-panel';
import { createVaultMigrationDeps, needsMigration, runMigrations } from '../integrity/migrations';
import { PlannerView, VIEW_TYPE_PLANNER } from '../ui/planner-view';
import { FormSheetPresenter } from '../ui/controls/form-sheet';
import { createDatePicker } from '../ui/controls/date-picker';
import { createAddMenuOpener } from '../ui/add-menu';
import { DataJsonAttentionStateStore, PluginDataFile } from './attention-state-store';
import { registerCoreCommands } from './commands';

/** Словари, общие для нескольких модулей (`model` — подписи дат, повторов, напоминаний). */
export function registerCoreDictionaries(): void {
  registerDictionary('ru', 'model', ruModel);
  registerDictionary('en', 'model', enModel);
  registerDictionary('ru', 'app', ruApp);
  registerDictionary('en', 'app', enApp);
}

registerCoreDictionaries();

const LOG_PREFIX = '[matrix-planner]';

export function log(message: string, error?: unknown): void {
  if (error === undefined) console.error(`${LOG_PREFIX} ${message}`);
  else console.error(`${LOG_PREFIX} ${message}`, error);
}

// ---------------------------------------------------------------------------
// Инфраструктура
// ---------------------------------------------------------------------------

export const systemClock: Clock = {
  now: () => new Date(),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export const noticeNotifier: Notifier = {
  show: (message, timeoutMs) => {
    new Notice(message, timeoutMs);
  },
};

export function readPlatform(): PlatformInfo {
  return {
    isMobile: Platform.isMobile,
    isPhone: Platform.isPhone,
    isTablet: Platform.isTablet,
    isIos: Platform.isIosApp,
    isAndroid: Platform.isAndroidApp,
    isDesktop: Platform.isDesktop,
  };
}

function systemLocale(language: Language): string {
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return nav?.language || language;
}

/** Первый день недели локали: `Intl.Locale` weekInfo, иначе — понедельник (кроме en-US). */
export function localeWeekStart(locale: string): WeekStartDay {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info && typeof info.firstDay === 'number') return info.firstDay === 7 ? 0 : 1;
  } catch {
    // Неизвестная локаль — запасной вариант ниже.
  }
  return /^en-(us|ca)\b/i.test(locale) ? 0 : 1;
}

/** 12-часовой формат по умолчанию для локали. */
export function localeHour12(locale: string): boolean {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 ?? false;
  } catch {
    return false;
  }
}

/** Язык, начало недели и формат времени из настроек (`auto` — по локали устройства). */
export function resolveFormatPreferences(settings: Pick<PlannerSettings, 'weekStart' | 'timeFormat'>, language: Language, locale: string): FormatPreferences {
  const weekStart: WeekStartDay = settings.weekStart === 'monday' ? 1 : settings.weekStart === 'sunday' ? 0 : localeWeekStart(locale);
  const hour12 = settings.timeFormat === '12h' ? true : settings.timeFormat === '24h' ? false : localeHour12(locale);
  return { language, weekStart, hour12 };
}

// ---------------------------------------------------------------------------
// Правки задач с напоминанием (баннер «Напоминание будет запланировано…»)
// ---------------------------------------------------------------------------

/** Время последней локальной правки задачи с напоминанием — только в памяти. */
export class ReminderEditTracker {
  private last: number | null = null;

  constructor(private readonly clock: Pick<Clock, 'now'>) {}

  mark(): void {
    this.last = this.clock.now().getTime();
  }

  get(): number | null {
    return this.last;
  }
}

/**
 * Обёртка сервиса задач: после удачной правки задачи с напоминанием отмечает время.
 * Напоминания планирует компаньон, поэтому до его обновления настройки показывают баннер.
 */
export function trackReminderEdits(tasks: TaskService, index: Pick<NoteIndex, 'getById'>, tracker: ReminderEditTracker): TaskService {
  const hasReminder = (id: ItemId): boolean => {
    const item = index.getById(id);
    return item?.kind === 'task' && item.remind !== 'none' && item.due !== null;
  };
  /** Отметить, если до операции у задачи было напоминание и операция удалась. */
  const wrap = async <T extends { ok: boolean }>(id: ItemId, run: () => Promise<T>): Promise<T> => {
    const had = hasReminder(id);
    const result = await run();
    if (had && result.ok) tracker.mark();
    return result;
  };
  return {
    create: async (draft) => {
      const result = await tasks.create(draft);
      if (result.ok && draft.remind !== 'none' && draft.due !== null) tracker.mark();
      return result;
    },
    update: async (id, patch) => {
      const had = hasReminder(id);
      const result = await tasks.update(id, patch);
      const now = patch.remind !== undefined ? patch.remind !== 'none' : had;
      // Включение, правка или выключение напоминания — компаньону нужно перепланировать.
      if (result.ok && (had || now)) tracker.mark();
      return result;
    },
    complete: (id, instanceDate) => wrap(id, () => tasks.complete(id, instanceDate)),
    uncomplete: (id, instanceDate) => wrap(id, () => tasks.uncomplete(id, instanceDate)),
    moveToQuadrant: (id, quadrant) => tasks.moveToQuadrant(id, quadrant),
    reschedule: (id, date) => wrap(id, () => tasks.reschedule(id, date)),
    postponeToTomorrow: (id) => wrap(id, () => tasks.postponeToTomorrow(id)),
    delete: (id) => wrap(id, () => tasks.delete(id)),
    getCompletions: () => tasks.getCompletions(),
  };
}

/** Задержка автоархива после изменений индекса (синхронизация присылает пачки). */
export const AUTO_ARCHIVE_DEBOUNCE_MS = 3000;
/** Как часто проверять смену дня. */
export const DAY_CHECK_INTERVAL_MS = 60_000;

/**
 * Запуски автоархива без наложения: пока идёт запуск, новые запросы сливаются
 * в один повтор после него. `schedule` — отложенный запуск (сбрасывает таймер).
 */
export class AutoArchiveRunner {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly run: () => Promise<void>,
    private readonly delayMs = AUTO_ARCHIVE_DEBOUNCE_MS,
  ) {}

  trigger(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const running = (async () => {
      try {
        do {
          this.again = false;
          await this.run();
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
      }
    })();
    this.running = running;
    return running;
  }

  schedule(): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.trigger();
    }, this.delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

/** Подмены для тестов. */
export interface CoreOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  notifier?: Notifier;
  platform?: PlatformInfo;
}

/** То, что ядро передаёт расширению (этап 2) до регистрации вида, команд и настроек. */
export interface CoreContext {
  plugin: Plugin;
  app: App;
  services: CoreServices;
  taskActions: TaskActions;
  /** Изменяемый объект действий: расширение подменяет формы и `isAvailable`. */
  actions: PlannerActions;
  activateView(): Promise<PlannerView | null>;
  /** Время последней правки задачи с напоминанием (мс) или `null`. */
  lastReminderEditAt(): number | null;
  /** Плагин выгружен — отложенные операции не выполнять. */
  isUnloaded(): boolean;
  log(message: string, error?: unknown): void;
}

/** Что расширение добавляет к виду и настройкам. */
export interface CoreExtension {
  tabs?: Partial<Record<PlannerTabId, TabFactory>>;
  banner?: BannerFactory | null;
  /** Дополнительные зависимости вкладки настроек (календари, профили, компаньон, разделы). */
  settings?: Partial<Omit<SettingsTabDeps, 'store'>>;
}

export type CoreExtender<E extends CoreExtension> = (context: CoreContext) => E | Promise<E>;

export interface CoreHandle<E extends CoreExtension = CoreExtension> {
  services: CoreServices;
  taskActions: TaskActions;
  actions: PlannerActions;
  /** Открыть вид (существующий лист или новый) и вернуть его. */
  activateView(): Promise<PlannerView | null>;
  /** Завершение запуска: маркер, миграции, индекс, автоархив, проверка целостности. */
  ready: Promise<void>;
  /** Результат `extend` или `null`, если расширения нет. */
  extension: E | null;
}

export async function composeCore<E extends CoreExtension = CoreExtension>(
  plugin: Plugin,
  overrides: CoreOverrides = {},
  extend?: CoreExtender<E>,
): Promise<CoreHandle<E>> {
  const app: App = plugin.app;
  let unloaded = false;
  plugin.register(() => {
    unloaded = true;
  });

  // --- Настройки (data.json общий с состоянием «Требуют внимания») ---
  const dataFile = new PluginDataFile(plugin);
  const settings = new PluginSettingsStore(dataFile.settingsSource());
  await settings.load();

  // --- Инфраструктура ---
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? createUlidGenerator();
  const notifier = overrides.notifier ?? noticeNotifier;
  const platform = overrides.platform ?? readPlatform();
  const format: FormatPreferencesProvider = {
    get: () => {
      const language = getCurrentLanguage();
      return resolveFormatPreferences(settings.get(), language, systemLocale(language));
    },
  };

  // --- Хранение ---
  let cachedPaths: { root: string; paths: PlannerPaths } | null = null;
  const getPaths = (): PlannerPaths => {
    const root = settings.get().rootFolder;
    if (!cachedPaths || cachedPaths.root !== root) cachedPaths = { root, paths: createPlannerPaths(root) };
    return cachedPaths.paths;
  };
  const queue = createWriteQueue();
  const marker = new VaultMarkerService(app, { getPaths, ids, queue, log });
  const guard = new MarkerWriteGuard(marker);
  const repository = new ObsidianNoteRepository(app, { getPaths, guard, queue });
  const systemJson = new AdapterSystemJsonStore(app, { getPaths, queue, guard, migrationGuard: new MigrationWriteGuard(marker) });
  const parser = createPlannerNoteParser({ language: () => format.get().language });
  const index = new MetadataNoteIndex(app, { parser, getPaths, log });

  // --- Сервисы ---
  const reminderEdits = new ReminderEditTracker(clock);
  const tasks = trackReminderEdits(new VaultTaskService({ repository, index, clock, ids }), index, reminderEdits);
  const archive = new VaultArchiveService({ repository, index, clock, settings, tasks });
  const taskActions = new TaskActions({ tasks, archive, notifier });
  const integrity = new VaultIntegrityService({
    index,
    repository,
    guard,
    ids,
    clock,
    marker,
    state: new DataJsonAttentionStateStore(dataFile),
    log,
  });
  const sheets = new FormSheetPresenter(app, platform);

  const services: CoreServices = {
    clock,
    ids,
    platform,
    notifier,
    format,
    settings,
    guard,
    marker,
    repository,
    index,
    systemJson,
    tasks,
    archive,
    integrity,
    sheets,
    datePicker: createDatePicker,
  };

  // --- Вид и действия ---
  const activateView = async (): Promise<PlannerView | null> => {
    const workspace = app.workspace;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_PLANNER)[0] ?? null;
    if (!leaf) {
      // На телефоне вид занимает область заметки, иначе — новая вкладка.
      leaf = workspace.getLeaf(platform.isPhone ? false : 'tab');
      await leaf.setViewState({ type: VIEW_TYPE_PLANNER, active: true });
    }
    await workspace.revealLeaf(leaf);
    if (typeof leaf.loadIfDeferred === 'function') await leaf.loadIfDeferred();
    return leaf.view instanceof PlannerView ? leaf.view : null;
  };

  const openNote = async (path: VaultPath, options: { newLeaf?: boolean } = {}): Promise<void> => {
    const file = app.vault.getFileByPath(path);
    if (!file) {
      notifier.show(t('common.errors.notFound'));
      return;
    }
    await app.workspace.getLeaf(options.newLeaf ? 'tab' : false).openFile(file);
  };

  const unsupported = (): void => notifier.show(t('common.errors.unsupported'));

  const actions: PlannerActions = {
    openTaskForm: (request) => {
      openTaskForm(services, request);
    },
    // Формы события и заметки — этап 2; до подключения `isAvailable` возвращает false.
    openEventForm: unsupported,
    openNoteForm: unsupported,
    openAddMenu: createAddMenuOpener(app, platform, () => actions),
    openNote,
    openItem: async (id) => {
      const item = index.getById(id);
      if (!item) {
        notifier.show(t('common.errors.notFound'));
        return;
      }
      if (item.kind === 'task') actions.openTaskForm({ mode: 'edit', id });
      else await openNote(item.path);
    },
    showTab: async (tab, options) => {
      const view = await activateView();
      if (!view) {
        notifier.show(t('app.notices.viewUnavailable'));
        return;
      }
      view.showTab(tab, options ?? {});
    },
    isAvailable: (feature) => feature === 'task',
  };

  // --- Расширение (этап 2): формы, вкладки, баннер, сервисы календаря и обоев ---
  const extension: E | null = extend
    ? await extend({
        plugin,
        app,
        services,
        taskActions,
        actions,
        activateView,
        lastReminderEditAt: () => reminderEdits.get(),
        isUnloaded: () => unloaded,
        log,
      })
    : null;

  const tasksTab = createTasksTab({ index, tasks, settings, clock, format, notifier });
  const viewOptions = (): PlannerViewOptions => ({
    tabs: { ...(extension?.tabs ?? {}), tasks: tasksTab },
    banner: extension?.banner ?? null,
    actions,
    platform,
    initialTab: settings.get().ui.lastTab,
    onTabChange: (tab: PlannerTabId) => {
      if (settings.get().ui.lastTab === tab) return;
      settings
        .update((draft) => {
          draft.ui.lastTab = tab;
        })
        .catch((error: unknown) => log('Cannot save last tab', error));
    },
  });
  plugin.registerView(VIEW_TYPE_PLANNER, (leaf) => new PlannerView(leaf, viewOptions()));

  plugin.addRibbonIcon('layout-grid', t('app.ribbon.open'), () => {
    void actions.showTab('tasks');
  });

  registerCoreCommands(plugin, { app, actions, taskActions, index, integrity, notifier });

  plugin.addSettingTab(
    new PlannerSettingTab(app, plugin, {
      store: settings,
      clock,
      notifier,
      format,
      integrity,
      attentionPanel: createAttentionPanel({ integrity, ...createWorkspaceOpeners(app), notifier }),
      openNote: (path) => void openNote(path),
      lastReminderEditAt: () => reminderEdits.get(),
      ...(extension?.settings ?? {}),
    }),
  );

  // --- Подписки ---
  plugin.register(marker.watch());
  plugin.register(() => index.stop());
  index.start();

  /** Автоархив после готовности индекса (при запуске и смене настройки). */
  const autoArchive = async (): Promise<void> => {
    await index.whenReady();
    if (unloaded) return;
    await taskActions.runAutoArchive();
  };

  // Фоновые запуски: смена дня, возврат в приложение, изменения индекса (синхронизация).
  // Только после первого запуска при старте; при запрете записи — пропуск (без повторных ошибок).
  let started = false;
  const archiveRunner = new AutoArchiveRunner(async () => {
    if (unloaded || !started || guard.check() || settings.get().archive.mode === 'never') return;
    await autoArchive().catch((error: unknown) => log('Auto archive failed', error));
  });
  plugin.register(() => archiveRunner.stop());
  plugin.register(index.onChange(() => archiveRunner.schedule()));
  let lastDay = clockToday(clock);
  plugin.registerInterval(
    window.setInterval(() => {
      const today = clockToday(clock);
      if (today === lastDay) return;
      lastDay = today;
      void archiveRunner.trigger();
    }, DAY_CHECK_INTERVAL_MS),
  );
  if (typeof document !== 'undefined') {
    plugin.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') void archiveRunner.trigger();
    });
  }

  /** Создать маркер/папки и при старой схеме выполнить миграцию. */
  const prepareStorage = async (): Promise<void> => {
    await marker.ensure();
    if (unloaded || !needsMigration(marker.getState())) return;
    const outcome = await runMigrations(createVaultMigrationDeps(app, { getPaths, queue, marker, clock, log }));
    if (!outcome.ok) {
      log('Migration failed', outcome.error);
      notifier.show(t('app.notices.migrationFailed'));
      return;
    }
    if (!unloaded) await marker.ensure();
  };

  // Смена корня: маркер и папки, затем перестройка индекса. Цепочка — чтобы смены не перекрывались.
  let rootChain: Promise<void> = Promise.resolve();
  plugin.register(
    settings.onChange((next, previous) => {
      if (next.rootFolder !== previous.rootFolder) {
        rootChain = rootChain
          .then(async () => {
            if (unloaded) return;
            await prepareStorage();
            if (unloaded) return;
            await index.rebuild();
            if (!unloaded) await integrity.check();
          })
          .catch((error: unknown) => log('Cannot switch root folder', error));
      }
      if (JSON.stringify(next.archive) !== JSON.stringify(previous.archive)) {
        // До первого запуска при старте — сразу, как раньше; дальше — через общий запуск без наложений.
        if (started && !guard.check()) void archiveRunner.trigger();
        else void autoArchive().catch((error: unknown) => log('Auto archive failed', error));
      }
    }),
  );

  // Запуск после загрузки раскладки: до неё хранилище может быть ещё не прочитано,
  // и маркер посчитался бы отсутствующим. До `ensure()` запись запрещена (`unknown`).
  const ready = new Promise<void>((resolve) => {
    app.workspace.onLayoutReady(() => {
      const run = async (): Promise<void> => {
        if (unloaded) return;
        await prepareStorage();
        if (unloaded) return;
        try {
          await autoArchive();
        } finally {
          started = true;
        }
        if (unloaded) return;
        await integrity.check();
      };
      run()
        .catch((error: unknown) => log('Startup failed', error))
        .finally(resolve);
    });
  });

  return { services, taskActions, actions, activateView, ready, extension };
}
