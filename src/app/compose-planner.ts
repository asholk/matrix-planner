/**
 * Сборка этапа 2 (S2.T9) поверх ядра: кэш календаря, tombstones и компаньон →
 * события и заметки → элементы дня → обои (сервис, трекер статуса, запуск быстрых команд) →
 * вкладки «Календарь» и «Блокировка», баннер, обработчик `obsidian://planner`,
 * команды этапа 2 и дополнительные части настроек.
 *
 * Подключается к `composeCore` как расширение (`composeApp`). Все подписки
 * регистрируются в `Plugin`, поэтому выгрузка плагина освобождает их без кода в `onunload`.
 */

import { Setting, type ObsidianProtocolData, type Plugin, type TAbstractFile } from 'obsidian';
import type {
  CoreServices,
  PlannerActions,
  PlannerServices,
  SettingsSection,
  WallpaperRenderer,
} from './contracts';
import { SYSTEM_FILES, type PlannerSettings } from '../model/types';
import { registerDictionary, t } from '../i18n';
import { ruCache } from '../i18n/ru/cache';
import { enCache } from '../i18n/en/cache';
import { ruCalendar } from '../i18n/ru/calendar';
import { enCalendar } from '../i18n/en/calendar';
import { ruCalendarModel } from '../i18n/ru/calendar-model';
import { enCalendarModel } from '../i18n/en/calendar-model';
import { ruEvents } from '../i18n/ru/events';
import { enEvents } from '../i18n/en/events';
import { ruNotes } from '../i18n/ru/notes';
import { enNotes } from '../i18n/en/notes';
import { ruProtocol } from '../i18n/ru/protocol';
import { enProtocol } from '../i18n/en/protocol';
import { ruLockscreen } from '../i18n/ru/lockscreen';
import { enLockscreen } from '../i18n/en/lockscreen';
import { ruWallpaperLayout } from '../i18n/ru/wallpaper-layout';
import { enWallpaperLayout } from '../i18n/en/wallpaper-layout';
import { ruWallpaperRender } from '../i18n/ru/wallpaper-render';
import { enWallpaperRender } from '../i18n/en/wallpaper-render';
import { ruCaldav } from '../i18n/ru/caldav';
import { enCaldav } from '../i18n/en/caldav';
import { CalDavClient } from '../caldav/client';
import { createObsidianHttp } from '../caldav/http';
import { createLocalJsonStore, hostOf, LocalPasswordStore, syncStateKey } from '../caldav/credentials';
import { CalendarSyncEngine, CalendarSyncScheduler, resourceKey } from '../caldav/sync-engine';
import { calendarSyncSection } from '../caldav/settings-section';
import { canWriteCalendarCache } from '../storage/system-json-store';
import { SystemCalendarCacheReader } from '../calendar/cache-reader';
import { PlannerDayItemsProvider } from '../calendar/day-items';
import { createCalendarTab } from '../calendar/calendar-tab';
import { SystemCompanionStore, SystemTombstoneWriter } from '../storage/system-records';
import { VaultEventService } from '../events/event-service';
import { openEventForm } from '../events/event-form';
import { VaultNoteService } from '../notes/note-service';
import { openNoteForm } from '../notes/note-form';
import { PlannerProtocolHandler } from '../protocol/handler';
import { createLinkBuilder } from '../protocol/links';
import { PROTOCOL_ACTION } from '../protocol/parameters';
import { XCallbackShortcutLauncher, type UrlOpener } from '../protocol/shortcut-launcher';
import { PlannerWallpaperStatusTracker } from '../protocol/wallpaper-status';
import { BackgroundImageCache, backgroundAffectedBy, createVaultImageReader } from '../wallpaper/background';
import { CanvasWallpaperRenderer, createDomCanvasFactory } from '../wallpaper/canvas-renderer';
import { WALLPAPER_LAYOUT_MODULE } from '../wallpaper/layout';
import { createLockscreenTab } from '../wallpaper/lockscreen-tab';
import { WallpaperOutputRepository } from '../wallpaper/output-repository';
import { KNOWN_PROFILES, type ScreenInfo } from '../wallpaper/profiles';
import { PlannerWallpaperService } from '../wallpaper/render-service';
import { createUpdateBanner } from '../wallpaper/update-banner';
import { createVaultImagePicker } from '../wallpaper/wallpaper-editor';
import { SETTINGS_SECTION_ORDER } from '../settings/settings-tab';
import { registerCalendarSyncCommand, registerPlannerCommands } from './commands';
import { composeCore, type CoreContext, type CoreExtension, type CoreHandle, type CoreOverrides } from './compose-core';

/**
 * Словари модулей этапа 2. Модули регистрируют свои словари и сами (при импорте);
 * повторная регистрация заменяет таблицу модуля, поэтому вызов идемпотентен.
 */
export function registerPlannerDictionaries(): void {
  const pairs: Array<[string, Parameters<typeof registerDictionary>[2], Parameters<typeof registerDictionary>[2]]> = [
    ['cache', ruCache, enCache],
    ['calendar', ruCalendar, enCalendar],
    ['calendar-model', ruCalendarModel, enCalendarModel],
    ['events', ruEvents, enEvents],
    ['notes', ruNotes, enNotes],
    ['protocol', ruProtocol, enProtocol],
    ['lockscreen', ruLockscreen, enLockscreen],
    [WALLPAPER_LAYOUT_MODULE, ruWallpaperLayout, enWallpaperLayout],
    ['wallpaperRender', ruWallpaperRender, enWallpaperRender],
    ['caldav', ruCaldav, enCaldav],
  ];
  for (const [module, ru, en] of pairs) {
    registerDictionary('ru', module, ru);
    registerDictionary('en', module, en);
  }
}

registerPlannerDictionaries();

/** Подмены для тестов. */
export interface PlannerOverrides {
  /** Renderer обоев (в тестах — без canvas). */
  renderer?: WallpaperRenderer;
  /** Открытие внешней ссылки `shortcuts://` (по умолчанию `window.open`). */
  openUrl?: UrlOpener;
  /** Размер экрана для автопрофиля обоев. */
  getScreen?(): ScreenInfo | null;
}

export interface PlannerHandle {
  services: PlannerServices;
  protocol: PlannerProtocolHandler;
  /** Первое чтение кэша календаря и компаньона завершено, индекс готов. */
  started: Promise<void>;
  /** Синхронизация с «Календарём» iOS (CalDAV). */
  calendarSync: CalendarSyncEngine;
}

export interface PlannerExtension extends CoreExtension {
  planner: PlannerHandle;
}

/** Изменения настроек, которые меняют картинку обоев. */
function wallpaperInputsChanged(next: Readonly<PlannerSettings>, previous: Readonly<PlannerSettings>): boolean {
  return (
    JSON.stringify(next.wallpaper) !== JSON.stringify(previous.wallpaper) ||
    JSON.stringify(next.visibleCalendars) !== JSON.stringify(previous.visibleCalendars) ||
    next.weekStart !== previous.weekStart ||
    next.timeFormat !== previous.timeFormat ||
    next.rootFolder !== previous.rootFolder
  );
}

/** Подсказка про «Другие типы файлов» Obsidian Sync (рядом с разделом «Компаньон»). */
export function syncWarningSection(): SettingsSection {
  return {
    order: SETTINGS_SECTION_ORDER.companion,
    render: (containerEl) => {
      new Setting(containerEl).setName(t('app.settings.sync.name')).setDesc(t('app.settings.sync.desc'));
    },
  };
}

export async function composePlanner(ctx: CoreContext, overrides: PlannerOverrides = {}): Promise<PlannerExtension> {
  const { plugin, app, actions } = ctx;
  const core: CoreServices = ctx.services;
  const { clock, notifier, settings, index, repository, systemJson, sheets, platform } = core;

  // --- Служебные данные календаря и компаньона ---
  const calendarCache = new SystemCalendarCacheReader({ store: systemJson, clock });
  const tombstones = new SystemTombstoneWriter({ store: systemJson, clock });
  const companion = new SystemCompanionStore({ store: systemJson });
  plugin.register(calendarCache.watch(app));
  plugin.register(companion.watch(app));
  plugin.register(tombstones.watch(app));

  // --- События, заметки, элементы дня ---
  const events = new VaultEventService({
    repository,
    index,
    ids: core.ids,
    calendars: calendarCache,
    tombstones,
    // Календарь для записи синхронизации CalDAV и есть «Планировщик» — без второго пункта в форме.
    isPlannerCalendar: (calendarId) => {
      const sync = settings.get().calendarSync;
      return sync.enabled && sync.writeCalendarHref !== null && resourceKey(sync.writeCalendarHref) === resourceKey(calendarId);
    },
  });
  const notes = new VaultNoteService({ repository, index, ids: core.ids });
  const dayItems = new PlannerDayItemsProvider({ index, settings, cache: calendarCache, clock, tombstones });
  plugin.register(() => dayItems.dispose());

  // --- Ссылки и быстрые команды ---
  const links = createLinkBuilder(() => app.vault.getName());
  const shortcuts = new XCallbackShortcutLauncher({ links, platform, clock, open: overrides.openUrl });

  // --- Обои: сервис и трекер ссылаются друг на друга — цикл разорван лямбдами ---
  const images = new BackgroundImageCache(createVaultImageReader(app.vault));
  const renderer: WallpaperRenderer =
    overrides.renderer ?? new CanvasWallpaperRenderer({ canvases: createDomCanvasFactory(), images });
  // Трекер обращается к сервису только из лямбд (вызов — после сборки).
  const wallpaperStatus: PlannerWallpaperStatusTracker = new PlannerWallpaperStatusTracker({
    wallpaper: {
      renderAll: () => wallpaper.renderAll(),
      resolveProfile: (draft) => wallpaper.resolveProfile(draft),
    },
    companion,
    launcher: shortcuts,
    platform,
    clock,
    notifier,
    format: core.format,
    getShortcutName: () => settings.get().wallpaper.shortcutName,
  });
  const wallpaper: PlannerWallpaperService = new PlannerWallpaperService({
    settings,
    index,
    dayItems,
    output: new WallpaperOutputRepository(repository),
    renderer,
    clock,
    format: core.format,
    getDataRevision: () => wallpaperStatus.getDataRevision(),
    getScreen: overrides.getScreen ? () => overrides.getScreen?.() ?? null : undefined,
  });

  const services: PlannerServices = {
    ...core,
    calendarCache,
    tombstones,
    companion,
    events,
    notes,
    dayItems,
    wallpaper,
    wallpaperStatus,
    links,
    shortcuts,
  };

  // --- Действия: формы события и заметки, открытие элементов ---
  const openNoteInEditor = (path: string): Promise<void> => actions.openNote(path);
  const plannerActions: Pick<PlannerActions, 'openEventForm' | 'openNoteForm' | 'openItem' | 'isAvailable'> = {
    openEventForm: (request) => {
      openEventForm(services, request);
    },
    openNoteForm: (request) => {
      openNoteForm({ ...services, notes, openNote: openNoteInEditor }, request);
    },
    openItem: async (id) => {
      const item = index.getById(id);
      if (!item) {
        notifier.show(t('common.errors.notFound'));
        return;
      }
      switch (item.kind) {
        case 'task':
          actions.openTaskForm({ mode: 'edit', id });
          return;
        case 'event':
          actions.openEventForm({ mode: 'edit', id });
          return;
        case 'note':
          await openNoteInEditor(item.path);
          return;
      }
    },
    isAvailable: () => true,
  };
  Object.assign(actions, plannerActions);

  // --- Обработчик ссылок obsidian://planner ---
  const protocol = new PlannerProtocolHandler({ index, actions, notifier, wallpaperStatus });
  plugin.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params: ObsidianProtocolData) => {
    void protocol.handle({ ...params });
  });
  plugin.register(() => protocol.dispose());

  // --- Команды этапа 2 ---
  registerPlannerCommands(plugin, { actions, wallpaperStatus });

  // --- Синхронизация с «Календарём» iOS (CalDAV, подписки ICS) ---
  const http = createObsidianHttp();
  const credentialHost = hostOf(app);
  const passwords = new LocalPasswordStore(credentialHost);
  const syncEngine = new CalendarSyncEngine({
    settings,
    index,
    events,
    repository,
    tombstones,
    cache: {
      read: () => systemJson.read(SYSTEM_FILES.calendarCache),
      write: (value) =>
        canWriteCalendarCache(systemJson)
          ? systemJson.writeCalendarCache(value)
          : Promise.resolve({ ok: false, error: { code: 'read-only', detail: 'calendar cache writer unavailable' } }),
    },
    passwords,
    state: createLocalJsonStore(credentialHost, () => syncStateKey(core.marker.getState().marker?.vault_id ?? null)),
    clock,
    notifier,
    createClient: (credentials) => new CalDavClient(credentials, { http, xmlParser: new DOMParser() }),
    onCacheWritten: () => {
      void calendarCache.refresh().catch((error: unknown) => ctx.log('Cannot read calendar cache', error));
    },
    log: (message, error) => ctx.log(message, error),
  });
  const syncScheduler = new CalendarSyncScheduler({
    engine: syncEngine,
    isEnabled: () => settings.get().calendarSync.enabled && !ctx.isUnloaded(),
    intervalMs: () => settings.get().calendarSync.intervalMinutes * 60_000,
    now: () => Date.now(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  });
  plugin.register(() => syncScheduler.dispose());
  // Интервал проверяется раз в минуту: смена настройки не требует перерегистрации таймера.
  plugin.registerInterval(window.setInterval(() => syncScheduler.tick(), 60_000));
  registerCalendarSyncCommand(plugin, {
    syncNow: () => void syncEngine.syncNow({ manual: true }),
    pendingDeletions: () => syncEngine.getPendingDeletions(),
    confirmDeletions: () => void syncEngine.confirmPendingDeletions(),
  });

  // --- Изменения данных → «Есть изменения» в баннере ---
  // До первой индексации и чтения кэша изменения не считаются: это загрузка, а не правка.
  let tracking = false;
  const markDataChanged = (): void => {
    if (tracking && !ctx.isUnloaded()) wallpaperStatus.markDataChanged();
  };
  plugin.register(
    index.onChange(() => {
      markDataChanged();
      if (tracking) syncScheduler.schedule();
    }),
  );
  plugin.register(calendarCache.onChange(() => markDataChanged()));
  // Новая метка удаления (своя или с другого устройства) меняет состав обоев.
  plugin.register(
    tombstones.onChange(() => {
      void dayItems.refreshTombstones();
      markDataChanged();
      if (tracking) syncScheduler.schedule();
    }),
  );
  // Файл фона изменён, удалён или переименован — сбросить кэш картинки и пометить обои устаревшими.
  const onBackgroundFile = (file: TAbstractFile, oldPath?: string): void => {
    if (!backgroundAffectedBy(settings.get().wallpaper.background, file.path, oldPath)) return;
    images.invalidate();
    markDataChanged();
  };
  plugin.registerEvent(app.vault.on('modify', (file) => onBackgroundFile(file)));
  plugin.registerEvent(app.vault.on('delete', (file) => onBackgroundFile(file)));
  plugin.registerEvent(app.vault.on('rename', (file, oldPath) => onBackgroundFile(file, oldPath)));
  plugin.register(
    settings.onChange((next, previous) => {
      if (next.rootFolder !== previous.rootFolder) {
        // Служебные файлы нового корня.
        void calendarCache.refresh().catch((error: unknown) => ctx.log('Cannot read calendar cache', error));
        void companion.read().catch((error: unknown) => ctx.log('Cannot read companion state', error));
      }
      if (wallpaperInputsChanged(next, previous)) markDataChanged();
      if (tracking && JSON.stringify(next.calendarSync) !== JSON.stringify(previous.calendarSync)) syncScheduler.schedule();
    }),
  );

  const started = new Promise<void>((resolve) => {
    app.workspace.onLayoutReady(() => {
      const run = async (): Promise<void> => {
        await Promise.all([
          calendarCache.refresh().catch((error: unknown) => ctx.log('Cannot read calendar cache', error)),
          companion.read().catch((error: unknown) => ctx.log('Cannot read companion state', error)),
        ]);
        await index.whenReady();
      };
      run()
        .catch((error: unknown) => ctx.log('Planner startup failed', error))
        .finally(() => {
          tracking = !ctx.isUnloaded();
          resolve();
          // Первая синхронизация календаря — после готовности индекса.
          if (tracking && settings.get().calendarSync.enabled) void syncScheduler.run();
        });
    });
  });

  // --- Вкладки, баннер, настройки ---
  const pickImage = createVaultImagePicker(app, notifier, () => repository.paths.wallpapers);
  const calendarTab = createCalendarTab({
    dayItems,
    settings,
    clock,
    format: core.format,
    notifier,
    tasks: core.tasks,
    cache: calendarCache,
    index,
    datePicker: core.datePicker,
  });
  const lockscreenTab = createLockscreenTab({
    app,
    settings,
    wallpaper,
    status: wallpaperStatus,
    sheets,
    clock,
    format: core.format,
    notifier,
    calendars: calendarCache,
    pickImage,
    companion,
    dayItems,
  });
  const banner = createUpdateBanner({
    status: wallpaperStatus,
    sheets,
    getHelpContext: () => ({ profileId: wallpaper.resolveProfile().id, shortcutName: settings.get().wallpaper.shortcutName }),
  });

  return {
    tabs: { calendar: calendarTab, lockscreen: lockscreenTab },
    banner,
    settings: {
      calendars: calendarCache,
      companion,
      wallpaperProfiles: {
        list: () => KNOWN_PROFILES,
        resolveAuto: () => wallpaper.resolveProfile({ ...settings.get().wallpaper, profile: 'auto' }),
      },
      sections: [
        syncWarningSection(),
        calendarSyncSection({ app, settings, engine: syncEngine, passwords, notifier }),
      ],
    },
    planner: { services, protocol, started, calendarSync: syncEngine },
  };
}

export type AppOverrides = CoreOverrides & PlannerOverrides;

export type AppHandle = CoreHandle<PlannerExtension>;

/** Полная сборка плагина: ядро + этап 2. */
export function composeApp(plugin: Plugin, overrides: AppOverrides = {}): Promise<AppHandle> {
  return composeCore(plugin, overrides, (ctx) => composePlanner(ctx, overrides));
}
