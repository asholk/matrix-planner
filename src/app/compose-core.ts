/**
 * Сборка ядра этапа 1 (S1.T10): настройки → маркер → индекс → сервисы задач,
 * архива и целостности → вид «Планировщик» с вкладкой «Задачи» → значок на ленте,
 * команды и вкладка настроек. Все подписки регистрируются в `Plugin` (register/registerEvent),
 * поэтому выгрузка плагина освобождает их без отдельного кода в `onunload`.
 *
 * Вкладки «Календарь» и «Блокировка», формы события и заметки подключает этап 2 (compose-planner).
 */

import { Notice, Platform, type App, type Plugin, type WorkspaceLeaf } from 'obsidian';
import type {
  Clock,
  CoreServices,
  FormatPreferences,
  FormatPreferencesProvider,
  IdGenerator,
  Notifier,
  PlannerActions,
  PlannerViewOptions,
  PlatformInfo,
} from './contracts';
import type { Language, PlannerPaths, PlannerSettings, PlannerTabId, VaultPath, WeekStartDay } from '../model/types';
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
import { VaultTaskService } from '../tasks/task-service';
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

function log(message: string, error?: unknown): void {
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
// Сборка
// ---------------------------------------------------------------------------

/** Подмены для тестов. */
export interface CoreOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  notifier?: Notifier;
  platform?: PlatformInfo;
}

export interface CoreHandle {
  services: CoreServices;
  taskActions: TaskActions;
  actions: PlannerActions;
  /** Открыть вид (существующий лист или новый) и вернуть его. */
  activateView(): Promise<PlannerView | null>;
  /** Завершение запуска: маркер, миграции, индекс, автоархив, проверка целостности. */
  ready: Promise<void>;
}

export async function composeCore(plugin: Plugin, overrides: CoreOverrides = {}): Promise<CoreHandle> {
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
  const tasks = new VaultTaskService({ repository, index, clock, ids });
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

  const tasksTab = createTasksTab({ index, tasks, settings, clock, format, notifier });
  const viewOptions = (): PlannerViewOptions => ({
    tabs: { tasks: tasksTab },
    banner: null,
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
        void autoArchive().catch((error: unknown) => log('Auto archive failed', error));
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
        await autoArchive();
        if (unloaded) return;
        await integrity.check();
      };
      run()
        .catch((error: unknown) => log('Startup failed', error))
        .finally(resolve);
    });
  });

  return { services, taskActions, actions, activateView, ready };
}
