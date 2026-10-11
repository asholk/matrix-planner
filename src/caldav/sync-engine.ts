/**
 * Синхронизация с «Календарём» iOS через CalDAV (iCloud или другой сервер) — ТЗ §5.4,
 * роль «основного устройства» компаньона выполняет плагин.
 *
 * - Заметки-события — двусторонне: UID = id заметки, ресурс `<календарь>/<id>.ics`.
 *   Изменилась только заметка → PUT (If-Match); только событие (etag) → свойства заметки;
 *   обе → побеждает заметка. Последняя синхронизированная версия (хеш полей, etag) хранится
 *   локально на устройстве, не в хранилище.
 * - Задачи со сроком — односторонне в календарь для записи (○/✓, VALARM, RRULE).
 * - Удаление — только по меткам `tombstones.json`; событие Планировщика, удалённое на сервере
 *   (подтверждено 404), → заметка в «События/Удалённые/». Ошибка сети, неполная выборка или
 *   событие вне диапазона удалением не считаются. Чужие события не меняются и не удаляются.
 * - Кэш `_system/calendar-cache.json` в формате компаньона (вместе с подписками ICS).
 */

import type { CalDavClient } from './client';
import type {
  CalDavCalendar,
  CalDavCredentials,
  CalDavDiscovery,
  CalDavEventResource,
  CalDavPutOptions,
  CalDavResult,
  CalDavTimeRange,
} from './client-types';
import type { IcsDateRange, IcsEvent } from './ics-types';
import type { LocalJsonStore, PasswordStore } from './credentials';
import { parseIcs, serializeCalendar } from './ics';
import { zonedToEpoch } from './rrule';
import {
  buildCalendarCache,
  cacheRange,
  cacheSignature,
  carryOverCalendar,
  type CacheCalendarSource,
} from './cache-writer';
import {
  eventFieldsHash,
  eventFieldsOf,
  eventToIcs,
  fieldsFromServer,
  fieldsToPatch,
  hashOf,
  masterOf,
  plannerItemIdOf,
  taskToIcs,
  type EventFields,
} from './sync-mapping';
import type {
  Clock,
  EventService,
  NoteIndex,
  NoteRepository,
  Notifier,
  SettingsStore,
  SystemJsonReadResult,
  TombstoneWriter,
} from '../app/contracts';
import type { CalendarSyncSettings, ItemId, OpResult, PlannerEvent, RepeatRule, Task } from '../model/types';
import type { CalendarCacheFile } from '../calendar/cache-schema';
import { addDays } from '../model/dates';
import { ICLOUD_CALDAV_URL } from '../settings/defaults';
import { registerDictionary, t, tPlural } from '../i18n';
import { ruCaldav } from '../i18n/ru/caldav';
import { enCaldav } from '../i18n/en/caldav';

registerDictionary('ru', 'caldav', ruCaldav);
registerDictionary('en', 'caldav', enCaldav);

/** Методы клиента, нужные движку (в тестах — фейковый сервер в памяти). */
export type CalDavApi = Pick<
  CalDavClient,
  'discover' | 'listEvents' | 'getEvent' | 'putEvent' | 'deleteEvent' | 'makeCalendar' | 'fetchIcsSubscription'
>;

export type SyncErrorKind = 'auth' | 'network' | 'server' | 'cache' | 'not-configured';

export interface CalendarSyncStatus {
  running: boolean;
  /** Время последней успешной синхронизации (ISO). */
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  error: { kind: SyncErrorKind; detail: string } | null;
  /**
   * Событий по меткам удаления ждут подтверждения (ТЗ §5.4.3: больше
   * `MASS_DELETE_THRESHOLD` за один проход). 0 — подтверждение не нужно.
   */
  pendingDeletions: number;
  /** Время последней успешной адресной отправки изменений (ISO). */
  lastPushAt: string | null;
  /** Идёт адресная отправка изменений (строка «Отправка…» во вкладке «Календарь»). */
  pushing?: boolean;
}

export interface SyncStats {
  created: number;
  updated: number;
  pulled: number;
  deleted: number;
  movedToDeleted: number;
}

export type SyncOutcome =
  | { status: 'ok'; stats: SyncStats; cacheWritten: boolean }
  | { status: 'skipped'; reason: 'disabled' | 'not-ready' }
  | { status: 'error'; kind: SyncErrorKind; detail: string };

/** Адресная отправка изменённых элементов (без полной выборки календарей). */
export type PushOutcome =
  | { status: 'ok'; pushed: number; failed: number }
  | { status: 'skipped'; reason: 'disabled' | 'not-ready' | 'empty' }
  | { status: 'error'; kind: SyncErrorKind; detail: string };

export type ConnectionTestResult =
  /** `enabled` — синхронизация была выключена и включена этой проверкой. */
  | { ok: true; calendars: readonly CalDavCalendar[]; enabled: boolean }
  | { ok: false; kind: SyncErrorKind; detail: string };

export interface CacheFileStore {
  read(): Promise<SystemJsonReadResult>;
  write(value: Record<string, unknown>): Promise<OpResult>;
}

export interface CalendarSyncEngineDeps {
  settings: Pick<SettingsStore, 'get' | 'update'>;
  index: Pick<NoteIndex, 'isReady' | 'getTasks' | 'getEvents'>;
  events: Pick<EventService, 'update'>;
  repository: Pick<NoteRepository, 'readBody' | 'move' | 'paths'>;
  tombstones: Pick<TombstoneWriter, 'list'>;
  cache: CacheFileStore;
  passwords: Pick<PasswordStore, 'getPassword'>;
  /** Локальное состояние синхронизации (на устройстве). */
  state: LocalJsonStore;
  clock: Clock;
  notifier: Notifier;
  createClient(credentials: CalDavCredentials): CalDavApi;
  /** Кэш записан — перечитать его читателем. */
  onCacheWritten?(): void;
  deviceName?(): string | null;
  describeRepeat?: (repeat: RepeatRule) => string | null;
  log?(message: string, error?: unknown): void;
}

/** Больше стольких событий за один проход по меткам удаления — только после подтверждения. */
export const MASS_DELETE_THRESHOLD = 3;
/** Обнаружение (список календарей) без ручного запуска обновляется не чаще (мс). */
const DISCOVERY_TTL_MS = 30 * 60 * 1000;

/** Названия календаря Планировщика, по которым он находится на сервере. */
const PLANNER_CALENDAR_NAMES = ['Планировщик', 'Planner'];
const PLANNER_CALENDAR_COLOR = '#007AFF';
const DEFAULT_CALENDAR_COLOR = '#8e8e93';
/** Кэш без изменений не переписывается чаще (мс). */
const CACHE_REWRITE_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Локальное состояние
// ---------------------------------------------------------------------------

interface ItemSyncState {
  kind: 'event' | 'task';
  href: string;
  etag: string;
  hash: string;
}

interface SyncStateData {
  version: 1;
  account: string;
  items: Record<ItemId, ItemSyncState>;
  /** Метки удаления, по которым события уже удалены с сервера. */
  tombstonesDone: ItemId[];
  lastSyncAt: string | null;
  /** Последняя адресная отправка (для состояния в настройках). */
  lastPushAt: string | null;
  /**
   * Календари (calendar_id кэша), уже попадавшие в кэш с этого устройства. Новый календарь
   * один раз включается в «Показываемые календари» вкладки «Календарь».
   */
  knownCalendars: string[];
}

function emptyState(account: string): SyncStateData {
  return { version: 1, account, items: {}, tombstonesDone: [], lastSyncAt: null, lastPushAt: null, knownCalendars: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseState(raw: unknown, account: string): SyncStateData {
  if (!isRecord(raw) || raw.version !== 1 || raw.account !== account || !isRecord(raw.items)) return emptyState(account);
  const items: Record<ItemId, ItemSyncState> = {};
  for (const [id, value] of Object.entries(raw.items)) {
    if (!isRecord(value)) continue;
    const { kind, href, etag, hash } = value;
    if ((kind === 'event' || kind === 'task') && typeof href === 'string' && typeof etag === 'string' && typeof hash === 'string') {
      items[id] = { kind, href, etag, hash };
    }
  }
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  return {
    version: 1,
    account,
    items,
    tombstonesDone: strings(raw.tombstonesDone),
    lastSyncAt: typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : null,
    lastPushAt: typeof raw.lastPushAt === 'string' ? raw.lastPushAt : null,
    knownCalendars: strings(raw.knownCalendars),
  };
}

// ---------------------------------------------------------------------------
// Адреса ресурсов
// ---------------------------------------------------------------------------

/** Ключ сравнения адресов: путь без схемы и хоста, декодированный, без `/` в конце. */
export function resourceKey(href: string): string {
  let path = href;
  try {
    path = new URL(href).pathname;
  } catch {
    // относительный адрес
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // оставить как есть
  }
  return path.replace(/\/+$/, '');
}

function parentOf(href: string): string {
  const trimmed = href.replace(/\/+$/, '');
  return trimmed.slice(0, trimmed.lastIndexOf('/') + 1);
}

function ensureSlash(href: string): string {
  return href.endsWith('/') ? href : `${href}/`;
}

/** Адрес ресурса элемента в календаре. */
export function itemHref(calendarHref: string, id: ItemId): string {
  return `${ensureSlash(calendarHref)}${encodeURIComponent(id)}.ics`;
}

function etagOf(resource: CalDavEventResource): string {
  return resource.etag ?? `ics:${hashOf(resource.ics)}`;
}

function accountKey(settings: CalendarSyncSettings): string {
  return `${settings.provider}|${serverUrlOf(settings)}|${settings.username.trim().toLowerCase()}`;
}

export function serverUrlOf(settings: CalendarSyncSettings): string {
  return settings.provider === 'icloud' ? ICLOUD_CALDAV_URL : settings.serverUrl.trim();
}

// ---------------------------------------------------------------------------
// Прерывание прохода (вход, сеть)
// ---------------------------------------------------------------------------

class SyncAbort extends Error {
  constructor(
    readonly kind: SyncErrorKind,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/** Ошибки входа и сети прерывают проход целиком: ничего не удаляется и кэш не пишется. */
function check<T>(result: CalDavResult<T>): CalDavResult<T> {
  if (!result.ok && (result.error.code === 'auth' || result.error.code === 'network')) {
    throw new SyncAbort(result.error.code, result.error.message);
  }
  return result;
}

type ServerLookup =
  | { state: 'found'; resource: CalDavEventResource }
  | { state: 'missing'; confirmed: boolean }
  | { state: 'unknown' };

interface RunContext {
  client: CalDavApi;
  now: Date;
  zone: string;
  range: IcsDateRange;
  timeRange: CalDavTimeRange;
  calendars: Map<string, CalDavCalendar>;
  /** Ресурсы календаря по ключу адреса; `null` — выборка не удалась (неполные данные). */
  listings: Map<string, Map<string, CalDavEventResource> | null>;
  state: SyncStateData;
  stats: SyncStats;
  /** Запуск вручную (команда, кнопка): уведомления показываются повторно. */
  manual: boolean;
  /**
   * Адресная отправка: календари не выбираются целиком, неизменённые (по хешу) элементы
   * пропускаются без запросов, новые записываются сразу (If-None-Match).
   */
  targeted: boolean;
  /** Записи, не принятые сервером (не конфликт). */
  failed: number;
}

interface FullRequest {
  manual: boolean;
  promise: Promise<SyncOutcome>;
  resolve(outcome: SyncOutcome): void;
}

// ---------------------------------------------------------------------------
// Движок
// ---------------------------------------------------------------------------

export class CalendarSyncEngine {
  /** Очередь проходов: полный проход и адресные отправки выполняются по одному. */
  private draining = false;
  /** Запрошенный, ещё не начатый полный проход (запрос во время прохода — ещё один проход). */
  private fullRequest: FullRequest | null = null;
  private readonly pushQueue = new Set<ItemId>();
  private pushWaiters: Array<(outcome: PushOutcome) => void> = [];
  /** Уведомление о недоступности сети при отправке уже показано (до успешной отправки). */
  private pushNetworkNotified = false;
  private discovery: { account: string; value: CalDavDiscovery; at: number } | null = null;
  /** id меток, удаление событий по которым подтвердил пользователь. */
  private approvedDeletions = new Set<ItemId>();
  /** id меток, ждущих подтверждения (последний проход). */
  private blockedDeletions: ItemId[] = [];
  /** Ключ набора, о котором уже показано уведомление. */
  private blockedNoticeKey = '';
  private status: CalendarSyncStatus | null = null;
  private readonly listeners = new Set<(status: CalendarSyncStatus) => void>();
  /** Уведомление о неверном пароле уже показано (до первой успешной синхронизации). */
  private authNotified = false;

  constructor(private readonly deps: CalendarSyncEngineDeps) {}

  getStatus(): CalendarSyncStatus {
    if (!this.status) {
      const raw = this.deps.state.load();
      const lastSyncAt = isRecord(raw) && typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : null;
      const lastPushAt = isRecord(raw) && typeof raw.lastPushAt === 'string' ? raw.lastPushAt : null;
      this.status = { running: false, lastSyncAt, lastAttemptAt: null, error: null, pendingDeletions: 0, lastPushAt };
    }
    return this.status;
  }

  onStatusChange(listener: (status: CalendarSyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Календари последнего обнаружения (для настроек). */
  getKnownCalendars(): readonly CalDavCalendar[] {
    const settings = this.deps.settings.get().calendarSync;
    return this.discovery && this.discovery.account === accountKey(settings) ? this.discovery.value.calendars : [];
  }

  isRunning(): boolean {
    return this.draining;
  }

  /** Синхронизация включена и заданы учётные данные. */
  isConfigured(): boolean {
    const settings = this.deps.settings.get().calendarSync;
    return settings.enabled && this.clientFor(settings) !== null;
  }

  /** Сколько событий ждут подтверждения удаления (ТЗ §5.4.3). */
  getPendingDeletions(): number {
    return this.blockedDeletions.length;
  }

  /** Подтвердить удаление событий, ожидающих подтверждения, и сразу синхронизировать. */
  confirmPendingDeletions(): Promise<SyncOutcome> | null {
    if (this.blockedDeletions.length === 0) return null;
    for (const id of this.blockedDeletions) this.approvedDeletions.add(id);
    return this.syncNow({ manual: true });
  }

  /**
   * Полный проход синхронизации. Вызовы до начала прохода объединяются; вызов во время
   * прохода не теряется — после текущего выполняется ещё один проход.
   */
  syncNow(options: { manual?: boolean } = {}): Promise<SyncOutcome> {
    let request = this.fullRequest;
    if (!request) {
      let resolve: (outcome: SyncOutcome) => void = () => {};
      const promise = new Promise<SyncOutcome>((done) => {
        resolve = done;
      });
      request = { manual: false, promise, resolve };
      this.fullRequest = request;
    }
    request.manual = request.manual || !!options.manual;
    this.kick();
    return request.promise;
  }

  /**
   * Адресная отправка изменённых элементов (события, задачи, удаление по меткам): только
   * PUT/DELETE по локальному состоянию, без выборки календарей. Выполняется раньше
   * ожидающего полного прохода.
   */
  pushItems(ids: Iterable<ItemId>): Promise<PushOutcome> {
    for (const id of ids) this.pushQueue.add(id);
    const promise = new Promise<PushOutcome>((resolve) => this.pushWaiters.push(resolve));
    this.kick();
    return promise;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    // Запуск — в микрозадаче: синхронные вызовы подряд попадают в один проход.
    void Promise.resolve().then(() => this.drain());
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        if (this.pushQueue.size > 0) {
          const ids = [...this.pushQueue];
          this.pushQueue.clear();
          const waiters = this.pushWaiters.splice(0);
          const outcome = await this.guard(() => this.pushOnce(ids));
          for (const resolve of waiters) resolve(outcome);
        } else if (this.fullRequest) {
          const request = this.fullRequest;
          this.fullRequest = null;
          request.resolve(await this.guard(() => this.runOnce(request.manual)));
        } else {
          for (const resolve of this.pushWaiters.splice(0)) resolve({ status: 'skipped', reason: 'empty' });
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async guard<T extends SyncOutcome | PushOutcome>(run: () => Promise<T>): Promise<T | { status: 'error'; kind: 'server'; detail: string }> {
    try {
      return await run();
    } catch (error) {
      this.log('Calendar sync failed', error);
      this.setStatus({ running: false, pushing: false });
      return { status: 'error', kind: 'server', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Обнаружение заново (кнопка «Проверить подключение»). */
  async testConnection(): Promise<ConnectionTestResult> {
    const settings = this.deps.settings.get().calendarSync;
    const client = this.clientFor(settings);
    if (!client) return { ok: false, kind: 'not-configured', detail: 'credentials missing' };
    let discovery: CalDavDiscovery;
    try {
      discovery = await this.discover(client, accountKey(settings), true);
    } catch (error) {
      if (error instanceof SyncAbort) return { ok: false, kind: error.kind, detail: error.detail };
      return { ok: false, kind: 'server', detail: String(error) };
    }
    // Вход удался — синхронизация включается сама: без этого события не уходят в календарь.
    const enabled = !this.deps.settings.get().calendarSync.enabled;
    if (enabled) {
      try {
        await this.deps.settings.update((draft) => {
          draft.calendarSync.enabled = true;
        });
      } catch (error) {
        this.log('Cannot enable calendar sync', error);
        return { ok: true, calendars: discovery.calendars, enabled: false };
      }
      this.deps.notifier.show(t(this.icloud() ? 'caldav.notices.enabled' : 'caldav.notices.enabledCaldav'));
      void this.syncNow();
    }
    return { ok: true, calendars: discovery.calendars, enabled };
  }

  /** Создать календарь «Планировщик» и выбрать его для записи. */
  async createPlannerCalendar(): Promise<CalDavCalendar | null> {
    const settings = this.deps.settings.get().calendarSync;
    const client = this.clientFor(settings);
    if (!client) return null;
    try {
      const discovery = await this.discover(client, accountKey(settings), false);
      return await this.makePlannerCalendar(client, discovery);
    } catch (error) {
      this.log('Cannot create calendar', error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Проход
  // -------------------------------------------------------------------------

  private async runOnce(manual: boolean): Promise<SyncOutcome> {
    const settings = this.deps.settings.get().calendarSync;
    if (!settings.enabled) {
      if (manual) this.deps.notifier.show(t('caldav.notices.disabled'));
      return { status: 'skipped', reason: 'disabled' };
    }
    if (!this.deps.index.isReady()) return { status: 'skipped', reason: 'not-ready' };

    const startedAt = this.deps.clock.now();
    this.setStatus({ running: true, lastAttemptAt: startedAt.toISOString() });
    const client = this.clientFor(settings);
    if (!client && settings.icsSubscriptions.length === 0) {
      return this.finish({ status: 'error', kind: 'not-configured', detail: 'credentials missing' }, manual);
    }

    const account = accountKey(settings);
    const state = parseState(this.deps.state.load(), account);
    const zone = this.deps.clock.timeZone();
    const range = cacheRange(startedAt, zone);
    const ctx: RunContext = {
      client: client ?? this.deps.createClient({ serverUrl: '', username: '', password: '' }),
      now: startedAt,
      zone,
      range,
      timeRange: {
        start: new Date(zonedToEpoch(range.from, '00:00', zone)),
        end: new Date(zonedToEpoch(addDays(range.to, 1), '00:00', zone)),
      },
      calendars: new Map(),
      listings: new Map(),
      state,
      stats: { created: 0, updated: 0, pulled: 0, deleted: 0, movedToDeleted: 0 },
      manual,
      targeted: false,
      failed: 0,
    };

    let outcome: SyncOutcome;
    try {
      const sources: CacheCalendarSource[] = [];
      const missing: string[] = [];
      if (client) await this.syncCalDav(ctx, settings, account, sources, missing, manual);
      await this.collectSubscriptions(ctx, settings, sources, missing);
      await this.showNewCalendars(ctx, sources);
      const written = await this.writeCache(ctx, sources, missing);
      if (!written.ok) {
        outcome = { status: 'error', kind: 'cache', detail: written.error.detail ?? written.error.code };
      } else {
        state.lastSyncAt = startedAt.toISOString();
        outcome = { status: 'ok', stats: ctx.stats, cacheWritten: written.value };
      }
    } catch (error) {
      if (error instanceof SyncAbort) {
        if (error.kind === 'auth') this.discovery = null;
        outcome = { status: 'error', kind: error.kind, detail: error.detail };
      } else {
        this.log('Calendar sync failed', error);
        outcome = { status: 'error', kind: 'server', detail: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      // Состояние сохраняется и после прерывания: выполненные запросы не повторяются вслепую.
      this.deps.state.save(state);
    }
    return this.finish(outcome, manual);
  }

  // -------------------------------------------------------------------------
  // Адресная отправка
  // -------------------------------------------------------------------------

  private async pushOnce(ids: ItemId[]): Promise<PushOutcome> {
    const settings = this.deps.settings.get().calendarSync;
    if (!settings.enabled) return { status: 'skipped', reason: 'disabled' };
    // До готовности индекса изменения отправит стартовый полный проход.
    if (!this.deps.index.isReady()) return { status: 'skipped', reason: 'not-ready' };
    const client = this.clientFor(settings);
    if (!client) return this.finishPush({ status: 'error', kind: 'not-configured', detail: 'credentials missing' });
    this.setStatus({ pushing: true });

    const account = accountKey(settings);
    const state = parseState(this.deps.state.load(), account);
    const now = this.deps.clock.now();
    const zone = this.deps.clock.timeZone();
    const ctx: RunContext = {
      client,
      now,
      zone,
      range: cacheRange(now, zone),
      timeRange: { start: now, end: now },
      calendars: new Map(),
      listings: new Map(),
      state,
      stats: { created: 0, updated: 0, pulled: 0, deleted: 0, movedToDeleted: 0 },
      manual: false,
      targeted: true,
      failed: 0,
    };

    let outcome: PushOutcome;
    try {
      // Список календарей — из кэша сессии (без срока годности), иначе обнаружение.
      let discovery = this.discovery?.account === account ? this.discovery.value : await this.discover(client, account, false);
      let writeCalendar = await this.resolveWriteCalendar(client, discovery, settings);
      if (settings.writeCalendarHref && (!writeCalendar || resourceKey(writeCalendar.href) !== resourceKey(settings.writeCalendarHref))) {
        discovery = await this.discover(client, account, true);
        writeCalendar = await this.resolveWriteCalendar(client, discovery, settings);
      }
      for (const calendar of discovery.calendars) ctx.calendars.set(resourceKey(calendar.href), calendar);

      const tombstoned = await this.pushDeletions(ctx, ids);
      const events = new Map(this.deps.index.getEvents().map((event) => [event.id, event]));
      const tasks = new Map(this.deps.index.getTasks().map((task) => [task.id, task]));
      const taskOptions = {
        completedTasksToCalendar: settings.completedTasksToCalendar,
        reminderTimeForDateOnly: this.deps.settings.get().reminderTimeForDateOnly,
        deviceZone: zone,
      };
      for (const id of ids) {
        if (tombstoned.has(id)) continue;
        const event = events.get(id);
        if (event) {
          if (event.deletedInCalendar) continue;
          const calendar = this.targetCalendar(ctx, event, writeCalendar);
          if (!calendar) continue;
          const body = await this.deps.repository.readBody(event.path);
          if (body.ok) await this.syncEvent(ctx, event, eventFieldsOf(event, body.value), calendar);
          continue;
        }
        const task = tasks.get(id);
        if (task && !writeCalendar) continue;
        const known = state.items[id];
        const synced = known && known.kind === 'task' ? known : null;
        const desired = task && writeCalendar && settings.tasksToCalendar ? taskToIcs(task, taskOptions) : null;
        if (task && writeCalendar && desired) await this.syncTask(ctx, task, desired, synced, writeCalendar);
        // Задача удалена, выполнена или без срока — убрать её событие (только синхронизированное отсюда).
        else if (synced && (await this.remove(ctx, synced.href))) delete state.items[id];
      }
      outcome = { status: 'ok', pushed: ctx.stats.created + ctx.stats.updated + ctx.stats.deleted, failed: ctx.failed };
    } catch (error) {
      if (!(error instanceof SyncAbort)) throw error;
      if (error.kind === 'auth') this.discovery = null;
      outcome = { status: 'error', kind: error.kind, detail: error.detail };
    } finally {
      if (ctx.stats.created + ctx.stats.updated + ctx.stats.deleted > 0) state.lastPushAt = now.toISOString();
      this.deps.state.save(state);
    }
    return this.finishPush(outcome);
  }

  /**
   * Удаление по меткам для отправляемых id. Удаляется только то, что синхронизировано с этого
   * устройства (адрес известен); остальное и превышение порога `MASS_DELETE_THRESHOLD` —
   * полному проходу (с подтверждением). Возвращает id всех меток событий.
   */
  private async pushDeletions(ctx: RunContext, ids: readonly ItemId[]): Promise<Set<ItemId>> {
    const listed = await this.deps.tombstones.list();
    const all = new Set<ItemId>();
    if (!listed.ok) return all;
    for (const record of listed.value) if (record.kind === 'event') all.add(record.id);
    const state = ctx.state;
    const done = new Set(state.tombstonesDone);
    const requested = ids.filter((id) => all.has(id) && !done.has(id) && state.items[id] !== undefined);
    if (requested.length === 0) return all;
    const unapproved = [...all].filter((id) => !done.has(id) && state.items[id] !== undefined && !this.approvedDeletions.has(id));
    if (unapproved.length > MASS_DELETE_THRESHOLD) return all;
    for (const id of requested) {
      const href = state.items[id]?.href;
      if (!href || !(await this.remove(ctx, href))) continue;
      delete state.items[id];
      state.tombstonesDone.push(id);
      this.approvedDeletions.delete(id);
    }
    return all;
  }

  private finishPush(outcome: PushOutcome): PushOutcome {
    if (this.getStatus().pushing) this.setStatus({ pushing: false });
    if (outcome.status === 'ok') {
      this.pushNetworkNotified = false;
      this.authNotified = false;
      const patch: Partial<CalendarSyncStatus> = {};
      if (outcome.pushed > 0) patch.lastPushAt = this.deps.clock.now().toISOString();
      const error = this.getStatus().error;
      // Отправка удалась — ошибки входа и сети больше не актуальны.
      if (error && (error.kind === 'auth' || error.kind === 'network' || error.kind === 'not-configured')) patch.error = null;
      if (Object.keys(patch).length > 0) this.setStatus(patch);
      return outcome;
    }
    if (outcome.status !== 'error') return outcome;
    this.setStatus({ error: { kind: outcome.kind, detail: outcome.detail } });
    if (outcome.kind === 'auth') {
      if (!this.authNotified) this.deps.notifier.show(t(this.icloud() ? 'caldav.notices.auth' : 'caldav.notices.authCaldav'));
      this.authNotified = true;
    } else if (outcome.kind === 'network') {
      if (!this.pushNetworkNotified) this.deps.notifier.show(t('caldav.notices.pushNetwork'));
      this.pushNetworkNotified = true;
    } else if (outcome.kind !== 'not-configured') {
      this.log(`Calendar push: ${outcome.kind}`, outcome.detail);
    }
    return outcome;
  }

  private finish(outcome: SyncOutcome, manual: boolean): SyncOutcome {
    const now = this.deps.clock.now().toISOString();
    if (outcome.status === 'ok') {
      this.authNotified = false;
      this.setStatus({ running: false, lastSyncAt: now, error: null, pendingDeletions: this.blockedDeletions.length });
      // Об ожидающем подтверждения удалении уже сказано отдельным уведомлением.
      if (manual && this.blockedDeletions.length === 0) this.deps.notifier.show(t('caldav.notices.synced'));
      return outcome;
    }
    if (outcome.status === 'error') {
      this.setStatus({ running: false, error: { kind: outcome.kind, detail: outcome.detail }, pendingDeletions: this.blockedDeletions.length });
      if (outcome.kind === 'auth') {
        if (manual || !this.authNotified) this.deps.notifier.show(t(this.icloud() ? 'caldav.notices.auth' : 'caldav.notices.authCaldav'));
        this.authNotified = true;
      } else if (manual) {
        const notConfigured = this.icloud() ? 'notConfigured' : 'notConfiguredCaldav';
        const key = outcome.kind === 'network' ? 'network' : outcome.kind === 'not-configured' ? notConfigured : 'failed';
        this.deps.notifier.show(t(`caldav.notices.${key}`));
      }
      if (outcome.kind !== 'network') this.log(`Calendar sync: ${outcome.kind}`, outcome.detail);
      return outcome;
    }
    this.setStatus({ running: false });
    return outcome;
  }

  private icloud(): boolean {
    return this.deps.settings.get().calendarSync.provider === 'icloud';
  }

  private setStatus(patch: Partial<CalendarSyncStatus>): void {
    this.status = { ...this.getStatus(), ...patch };
    const snapshot = this.status;
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.log('Sync status listener failed', error);
      }
    }
  }

  private clientFor(settings: CalendarSyncSettings): CalDavApi | null {
    const username = settings.username.trim();
    const serverUrl = serverUrlOf(settings);
    const password = this.deps.passwords.getPassword();
    if (!username || !serverUrl || !password) return null;
    return this.deps.createClient({ serverUrl, username, password });
  }

  private async discover(client: CalDavApi, account: string, force: boolean): Promise<CalDavDiscovery> {
    const cached = this.discovery;
    const fresh = cached !== null && cached.account === account && this.deps.clock.now().getTime() - cached.at < DISCOVERY_TTL_MS;
    if (!force && cached && fresh) return cached.value;
    const result = check(await client.discover());
    if (!result.ok) throw new SyncAbort('server', result.error.message);
    this.discovery = { account, value: result.value, at: this.deps.clock.now().getTime() };
    return result.value;
  }

  // -------------------------------------------------------------------------
  // CalDAV
  // -------------------------------------------------------------------------

  private async syncCalDav(
    ctx: RunContext,
    settings: CalendarSyncSettings,
    account: string,
    sources: CacheCalendarSource[],
    missing: string[],
    manual: boolean,
  ): Promise<void> {
    // Ручной запуск обновляет список календарей: новые и удалённые на сервере календари
    // видны сразу, без перезапуска плагина или «Проверить подключение».
    let discovery = await this.discover(ctx.client, account, manual);
    let writeCalendar = await this.resolveWriteCalendar(ctx.client, discovery, settings);
    if (settings.writeCalendarHref && (!writeCalendar || resourceKey(writeCalendar.href) !== resourceKey(settings.writeCalendarHref))) {
      // Выбранного календаря нет в обнаружении сессии — обнаружить заново.
      discovery = await this.discover(ctx.client, account, true);
      writeCalendar = await this.resolveWriteCalendar(ctx.client, discovery, settings);
    }
    for (const calendar of discovery.calendars) ctx.calendars.set(resourceKey(calendar.href), calendar);

    const readKeys = new Set(settings.readCalendarHrefs.map(resourceKey));
    const readCalendars = readKeys.size === 0 ? discovery.calendars : discovery.calendars.filter((c) => readKeys.has(resourceKey(c.href)));

    // Выборки нужны до удаления по меткам: по ним находятся события Планировщика.
    if (writeCalendar) await this.listing(ctx, writeCalendar.href);
    for (const calendar of readCalendars) await this.listing(ctx, calendar.href);

    const tombstoned = await this.processTombstones(ctx, writeCalendar);
    await this.syncEvents(ctx, writeCalendar, tombstoned);
    if (writeCalendar) await this.syncTasks(ctx, settings, writeCalendar);

    for (const calendar of readCalendars) {
      const listing = ctx.listings.get(resourceKey(calendar.href));
      if (!listing) {
        missing.push(calendar.href);
        continue;
      }
      sources.push({
        calendarId: calendar.href,
        title: calendar.displayName,
        color: calendar.color ?? DEFAULT_CALENDAR_COLOR,
        kind: 'caldav',
        allowsModifications: calendar.allowsModifications,
        resources: [...listing.values()].map((resource) => resource.ics),
      });
    }
  }

  /** Календарь для записи: выбранный, найденный по названию или созданный. */
  private async resolveWriteCalendar(
    client: CalDavApi,
    discovery: CalDavDiscovery,
    settings: CalendarSyncSettings,
  ): Promise<CalDavCalendar | null> {
    if (settings.writeCalendarHref) {
      const key = resourceKey(settings.writeCalendarHref);
      const chosen = discovery.calendars.find((calendar) => resourceKey(calendar.href) === key);
      if (chosen) return chosen.allowsModifications ? chosen : null;
    }
    const named = discovery.calendars.find(
      (calendar) => calendar.allowsModifications && PLANNER_CALENDAR_NAMES.includes(calendar.displayName.trim()),
    );
    if (named) {
      await this.rememberWriteCalendar(named.href);
      return named;
    }
    return this.makePlannerCalendar(client, discovery);
  }

  private async makePlannerCalendar(client: CalDavApi, discovery: CalDavDiscovery): Promise<CalDavCalendar | null> {
    const name = t('caldav.plannerCalendar');
    const created = check(await client.makeCalendar(discovery.homeHref, name, PLANNER_CALENDAR_COLOR));
    if (!created.ok) {
      this.log('Cannot create planner calendar', created.error.message);
      this.deps.notifier.show(t('caldav.notices.calendarCreateFailed', { name }));
      return null;
    }
    discovery.calendars.push(created.value);
    await this.rememberWriteCalendar(created.value.href);
    this.deps.notifier.show(t('caldav.notices.calendarCreated', { name }));
    return created.value;
  }

  private async rememberWriteCalendar(href: string): Promise<void> {
    if (this.deps.settings.get().calendarSync.writeCalendarHref === href) return;
    try {
      await this.deps.settings.update((draft) => {
        draft.calendarSync.writeCalendarHref = href;
      });
    } catch (error) {
      this.log('Cannot save calendar choice', error);
    }
  }

  private async listing(ctx: RunContext, calendarHref: string): Promise<Map<string, CalDavEventResource> | null> {
    // Адресная отправка не выбирает календари: ресурс читается GET по адресу.
    if (ctx.targeted) return null;
    const key = resourceKey(calendarHref);
    if (ctx.listings.has(key)) return ctx.listings.get(key) ?? null;
    const result = check(await ctx.client.listEvents(calendarHref, ctx.timeRange));
    let map: Map<string, CalDavEventResource> | null = null;
    if (result.ok) {
      map = new Map();
      for (const resource of result.value) map.set(resourceKey(resource.href), resource);
    } else {
      this.log(`Cannot list calendar ${calendarHref}`, result.error.message);
      // Календарь удалён на сервере — в следующем проходе обнаружить заново.
      if (result.error.code === 'not-found') this.discovery = null;
    }
    ctx.listings.set(key, map);
    return map;
  }

  /** Ресурс по адресу: из выборки, иначе GET (если он должен существовать или выборка неполная). */
  private async lookup(ctx: RunContext, href: string, expected: boolean): Promise<ServerLookup> {
    // Адресная отправка: нового элемента на сервере нет (иначе PUT получит 412 и перечитает).
    if (ctx.targeted && !expected) return { state: 'missing', confirmed: false };
    const listing = await this.listing(ctx, parentOf(href));
    const found = listing?.get(resourceKey(href));
    if (found) return { state: 'found', resource: found };
    if (listing && !expected) return { state: 'missing', confirmed: false };
    const result = check(await ctx.client.getEvent(href));
    if (result.ok) {
      listing?.set(resourceKey(href), result.value);
      return { state: 'found', resource: result.value };
    }
    return result.error.code === 'not-found' ? { state: 'missing', confirmed: true } : { state: 'unknown' };
  }

  private async put(
    ctx: RunContext,
    href: string,
    ics: string,
    options: CalDavPutOptions,
  ): Promise<{ ok: true; etag: string } | { ok: false; conflict: boolean }> {
    const result = check(await ctx.client.putEvent(href, ics, options));
    if (!result.ok) {
      if (result.error.code !== 'conflict') {
        ctx.failed++;
        this.log(`Cannot write ${href}`, result.error.message);
      }
      return { ok: false, conflict: result.error.code === 'conflict' };
    }
    let resource: CalDavEventResource = { href: result.value.href, ics };
    if (result.value.etag) resource.etag = result.value.etag;
    else {
      const fresh = check(await ctx.client.getEvent(href));
      if (fresh.ok) resource = fresh.value;
    }
    const listing = ctx.listings.get(resourceKey(parentOf(href)));
    listing?.set(resourceKey(href), resource);
    return { ok: true, etag: etagOf(resource) };
  }

  private async remove(ctx: RunContext, href: string): Promise<boolean> {
    const result = check(await ctx.client.deleteEvent(href));
    if (!result.ok) {
      this.log(`Cannot delete ${href}`, result.error.message);
      return false;
    }
    ctx.listings.get(resourceKey(parentOf(href)))?.delete(resourceKey(href));
    ctx.stats.deleted++;
    return true;
  }

  // -------------------------------------------------------------------------
  // Удаление по меткам
  // -------------------------------------------------------------------------

  /**
   * Удаление по меткам. Возвращает id всех меток (события с меткой не синхронизируются).
   * Больше `MASS_DELETE_THRESHOLD` неподтверждённых удалений за проход — ничего из них не
   * удаляется, пока пользователь не подтвердит (ТЗ §5.4.3).
   */
  private async processTombstones(ctx: RunContext, writeCalendar: CalDavCalendar | null): Promise<Set<ItemId>> {
    const listed = await this.deps.tombstones.list();
    const ids = new Set<ItemId>();
    if (!listed.ok) return ids;
    for (const record of listed.value) if (record.kind === 'event') ids.add(record.id);
    const state = ctx.state;
    state.tombstonesDone = state.tombstonesDone.filter((id) => ids.has(id));
    const done = new Set(state.tombstonesDone);
    const pending = [...ids].filter((id) => !done.has(id));
    for (const id of [...this.approvedDeletions]) if (!ids.has(id) || done.has(id)) this.approvedDeletions.delete(id);

    // События Планировщика в загруженных календарях по id заметки.
    const owned = new Map<ItemId, string[]>();
    for (const listing of ctx.listings.values()) {
      if (!listing) continue;
      for (const resource of listing.values()) {
        for (const id of plannerIdsOf(resource.ics)) {
          const list = owned.get(id);
          if (list) list.push(resource.href);
          else owned.set(id, [resource.href]);
        }
      }
    }

    const targets = new Map<ItemId, Map<string, string>>();
    for (const id of pending) {
      const hrefs = new Map<string, string>();
      const add = (href: string | undefined): void => {
        if (href) hrefs.set(resourceKey(href), href);
      };
      add(state.items[id]?.href);
      if (writeCalendar) add(itemHref(writeCalendar.href, id));
      for (const href of owned.get(id) ?? []) add(href);
      targets.set(id, hrefs);
    }

    // Подтверждение нужно только для событий, которые есть (или могут быть) на сервере.
    const onServer = pending.filter((id) => [...(targets.get(id)?.values() ?? [])].some((href) => this.mayExist(ctx, href)));
    const unapproved = onServer.filter((id) => !this.approvedDeletions.has(id));
    const blocked = new Set(unapproved.length > MASS_DELETE_THRESHOLD ? unapproved : []);
    this.setBlockedDeletions([...blocked], ctx);

    for (const id of pending) {
      if (blocked.has(id)) continue;
      let ok = true;
      for (const href of targets.get(id)?.values() ?? []) ok = (await this.remove(ctx, href)) && ok;
      if (ok) {
        delete state.items[id];
        state.tombstonesDone.push(id);
        this.approvedDeletions.delete(id);
      }
    }
    return ids;
  }

  /** Ресурс есть в выборке календаря или выборки нет (неизвестно — считается существующим). */
  private mayExist(ctx: RunContext, href: string): boolean {
    const listing = ctx.listings.get(resourceKey(parentOf(href)));
    return listing ? listing.has(resourceKey(href)) : true;
  }

  private setBlockedDeletions(ids: ItemId[], ctx: RunContext): void {
    this.blockedDeletions = ids;
    const key = [...ids].sort().join(',');
    if (ids.length > 0 && (key !== this.blockedNoticeKey || ctx.manual)) {
      this.deps.notifier.show(tPlural('caldav.notices.confirmDeletion', ids.length));
    }
    this.blockedNoticeKey = key;
  }

  // -------------------------------------------------------------------------
  // Заметки-события
  // -------------------------------------------------------------------------

  private targetCalendar(ctx: RunContext, event: PlannerEvent, writeCalendar: CalDavCalendar | null): CalDavCalendar | null {
    if (event.calendarId === null) return writeCalendar;
    const calendar = ctx.calendars.get(resourceKey(event.calendarId));
    return calendar && calendar.allowsModifications ? calendar : null;
  }

  private async syncEvents(ctx: RunContext, writeCalendar: CalDavCalendar | null, tombstoned: ReadonlySet<ItemId>): Promise<void> {
    for (const event of this.deps.index.getEvents()) {
      if (event.deletedInCalendar || tombstoned.has(event.id)) continue;
      const calendar = this.targetCalendar(ctx, event, writeCalendar);
      // Календарь не найден или только для чтения — событие не синхронизируется.
      if (!calendar) continue;
      const body = await this.deps.repository.readBody(event.path);
      if (!body.ok) continue;
      await this.syncEvent(ctx, event, eventFieldsOf(event, body.value), calendar);
    }
  }

  private async syncEvent(ctx: RunContext, event: PlannerEvent, fields: EventFields, calendar: CalDavCalendar): Promise<void> {
    const id = event.id;
    const hash = eventFieldsHash(fields);
    const known = ctx.state.items[id];
    const synced = known && known.kind === 'event' ? known : null;
    const sameCalendar = synced !== null && resourceKey(parentOf(synced.href)) === resourceKey(calendar.href);
    const href = synced && sameCalendar ? synced.href : itemHref(calendar.href, id);
    // Адресная отправка: заметка не менялась с последней синхронизации — запросов нет.
    if (ctx.targeted && synced && sameCalendar && synced.hash === hash) return;

    if (synced && !sameCalendar) {
      // Календарь заметки сменился: записать в новый, затем удалить из прежнего.
      const target = await this.lookup(ctx, href, false);
      if (target.state === 'unknown') return;
      const pushed = await this.pushEvent(ctx, id, fields, hash, href, target.state === 'found' ? target.resource : null);
      if (pushed) await this.remove(ctx, synced.href);
      return;
    }

    const server = await this.lookup(ctx, href, synced !== null);
    if (server.state === 'unknown') return;
    if (server.state === 'missing') {
      if (synced && server.confirmed) {
        await this.deletedOnServer(ctx, event);
        return;
      }
      await this.pushEvent(ctx, id, fields, hash, href, null);
      return;
    }

    const resource = server.resource;
    const master = masterOf(safeParse(resource.ics), id);
    if (!master) {
      await this.pushEvent(ctx, id, fields, hash, href, resource);
      return;
    }
    const serverFields = fieldsFromServer(master, fields, ctx.zone);
    if (serverFields.title.trim() === '') serverFields.title = fields.title;
    if (!synced) {
      // Связь потеряна (другое устройство, сброс состояния): совпадает — запомнить, иначе побеждает заметка.
      if (eventFieldsHash(serverFields) === hash) {
        ctx.state.items[id] = { kind: 'event', href, etag: etagOf(resource), hash };
        return;
      }
      await this.pushEvent(ctx, id, fields, hash, href, resource);
      return;
    }
    const noteChanged = synced.hash !== hash;
    const serverChanged = synced.etag !== etagOf(resource);
    if (noteChanged) {
      // Изменилась заметка (или обе стороны) — побеждает заметка.
      await this.pushEvent(ctx, id, fields, hash, href, resource);
      return;
    }
    if (!serverChanged) return;
    const patch = fieldsToPatch(serverFields, fields);
    if (patch) {
      const updated = await this.deps.events.update(id, patch);
      if (!updated.ok) {
        this.log(`Cannot update event note ${id}`, updated.error);
        return;
      }
      ctx.stats.pulled++;
    }
    ctx.state.items[id] = { kind: 'event', href, etag: etagOf(resource), hash: eventFieldsHash(serverFields) };
  }

  /** PUT заметки поверх версии сервера; при 412 — перечитать и повторить (побеждает заметка). */
  private async pushEvent(
    ctx: RunContext,
    id: ItemId,
    fields: EventFields,
    hash: string,
    href: string,
    current: CalDavEventResource | null,
  ): Promise<boolean> {
    let resource = current;
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = resource ? safeParse(resource.ics) : [];
      const base = masterOf(existing, id);
      const overrides = existing.filter((event) => event.recurrenceId && event.uid === (base?.uid ?? id));
      const next = eventToIcs(id, fields, base, ctx.now, ctx.zone);
      const ics = serializeCalendar([next, ...overrides.map((event) => ({ ...event, uid: id }))], { now: ctx.now });
      const options: CalDavPutOptions = resource ? (resource.etag ? { etag: resource.etag } : {}) : { create: true };
      const result = await this.put(ctx, href, ics, options);
      if (result.ok) {
        ctx.state.items[id] = { kind: 'event', href, etag: result.etag, hash };
        if (resource) ctx.stats.updated++;
        else ctx.stats.created++;
        return true;
      }
      if (!result.conflict) return false;
      const fresh = check(await ctx.client.getEvent(href));
      if (fresh.ok) resource = fresh.value;
      else if (fresh.error.code === 'not-found') resource = null;
      else return false;
    }
    return false;
  }

  /** Событие удалено в «Календаре» iOS → заметка в «События/Удалённые/» (не в корзину). */
  private async deletedOnServer(ctx: RunContext, event: PlannerEvent): Promise<void> {
    const moved = await this.deps.repository.move(event.path, this.deps.repository.paths.deletedEvents);
    if (!moved.ok) {
      this.log(`Cannot move deleted event ${event.id}`, moved.error);
      return;
    }
    delete ctx.state.items[event.id];
    ctx.stats.movedToDeleted++;
  }

  // -------------------------------------------------------------------------
  // Задачи (односторонне)
  // -------------------------------------------------------------------------

  private async syncTasks(ctx: RunContext, settings: CalendarSyncSettings, writeCalendar: CalDavCalendar): Promise<void> {
    const tasks = this.deps.index.getTasks();
    const options = {
      completedTasksToCalendar: settings.completedTasksToCalendar,
      reminderTimeForDateOnly: this.deps.settings.get().reminderTimeForDateOnly,
      deviceZone: ctx.zone,
    };
    for (const task of tasks) {
      const known = ctx.state.items[task.id];
      const synced = known && known.kind === 'task' ? known : null;
      const desired = settings.tasksToCalendar ? taskToIcs(task, options) : null;
      if (!desired) {
        if (synced && (await this.remove(ctx, synced.href))) delete ctx.state.items[task.id];
        continue;
      }
      await this.syncTask(ctx, task, desired, synced, writeCalendar);
    }
    // Задачи, которых больше нет в индексе (удалены): только синхронизированные с этого устройства.
    const present = new Set(tasks.map((task) => task.id));
    for (const [id, item] of Object.entries(ctx.state.items)) {
      if (item.kind !== 'task' || present.has(id)) continue;
      if (await this.remove(ctx, item.href)) delete ctx.state.items[id];
    }
  }

  private async syncTask(
    ctx: RunContext,
    task: Task,
    desired: IcsEvent,
    synced: ItemSyncState | null,
    writeCalendar: CalDavCalendar,
  ): Promise<void> {
    const hash = hashOf(['task', desired]);
    const sameCalendar = synced !== null && resourceKey(parentOf(synced.href)) === resourceKey(writeCalendar.href);
    const href = synced && sameCalendar ? synced.href : itemHref(writeCalendar.href, task.id);
    if (ctx.targeted && synced && sameCalendar && synced.hash === hash) return;
    const server = await this.lookup(ctx, href, synced !== null && sameCalendar);
    if (server.state === 'unknown') return;
    let resource = server.state === 'found' ? server.resource : null;
    if (synced && sameCalendar && resource && synced.hash === hash && synced.etag === etagOf(resource)) return;

    // Правки задачи в «Календаре» iOS не принимаются: событие перезаписывается.
    const ics = serializeCalendar([desired], { now: ctx.now });
    for (let attempt = 0; attempt < 3; attempt++) {
      const options: CalDavPutOptions = resource ? (resource.etag ? { etag: resource.etag } : {}) : { create: true };
      const result = await this.put(ctx, href, ics, options);
      if (result.ok) {
        ctx.state.items[task.id] = { kind: 'task', href, etag: result.etag, hash };
        if (resource) ctx.stats.updated++;
        else ctx.stats.created++;
        if (synced && !sameCalendar) await this.remove(ctx, synced.href);
        return;
      }
      if (!result.conflict) return;
      const fresh = check(await ctx.client.getEvent(href));
      if (fresh.ok) resource = fresh.value;
      else if (fresh.error.code === 'not-found') resource = null;
      else return;
    }
  }

  // -------------------------------------------------------------------------
  // Подписки ICS и кэш
  // -------------------------------------------------------------------------

  private async collectSubscriptions(
    ctx: RunContext,
    settings: CalendarSyncSettings,
    sources: CacheCalendarSource[],
    missing: string[],
  ): Promise<void> {
    for (const subscription of settings.icsSubscriptions) {
      const calendarId = `ics:${subscription.url}`;
      let result: CalDavResult<string>;
      try {
        result = await ctx.client.fetchIcsSubscription(subscription.url);
      } catch (error) {
        result = { ok: false, error: { code: 'network', message: String(error) } };
      }
      if (!result.ok) {
        // Подписка недоступна — её события остаются из прежнего кэша.
        if (result.error.code !== 'network') this.log(`Cannot fetch subscription ${subscription.url}`, result.error.message);
        missing.push(calendarId);
        continue;
      }
      const name = subscription.name.trim() || parseIcsName(result.value) || subscription.url;
      sources.push({
        calendarId,
        title: name,
        color: subscription.color || DEFAULT_CALENDAR_COLOR,
        kind: 'subscription',
        allowsModifications: false,
        resources: [result.value],
      });
    }
  }

  /**
   * Календарь впервые попал в кэш (выбран для показа в «Календаре iOS» или добавлена подписка)
   * — включить его в «Показываемые календари», иначе его события не видны во вкладке
   * «Календарь». Выключенный пользователем календарь повторно не включается.
   */
  private async showNewCalendars(ctx: RunContext, sources: readonly CacheCalendarSource[]): Promise<void> {
    const known = new Set(ctx.state.knownCalendars);
    const fresh = sources.map((source) => source.calendarId).filter((id) => !known.has(id));
    if (fresh.length === 0) return;
    try {
      await this.deps.settings.update((draft) => {
        const ids = new Set(draft.visibleCalendars.calendarIds);
        for (const id of fresh) ids.add(id);
        draft.visibleCalendars.calendarIds = [...ids];
      });
      ctx.state.knownCalendars = [...known, ...fresh];
    } catch (error) {
      this.log('Cannot update visible calendars', error);
    }
  }

  /** Запись кэша; `value: false` — без изменений, файл не переписан. */
  private async writeCache(ctx: RunContext, sources: CacheCalendarSource[], missing: string[]): Promise<OpResult<boolean>> {
    const previousRead = await this.deps.cache.read();
    const previous = previousRead.status === 'ok' ? previousRead.value : null;
    const cache: CalendarCacheFile = buildCalendarCache(sources, {
      now: ctx.now,
      timeZone: ctx.zone,
      deviceName: this.deps.deviceName?.() ?? null,
      describeRepeat: this.deps.describeRepeat ?? describeRepeat,
    });
    for (const calendarId of missing) {
      const carried = carryOverCalendar(previous, calendarId);
      if (!carried) continue;
      cache.calendars.push(carried.calendar);
      cache.events.push(...carried.events);
    }
    if (isRecord(previous) && previous.version === cache.version && typeof previous.generated_at === 'string') {
      const age = ctx.now.getTime() - Date.parse(previous.generated_at);
      const same = cacheSignature(previous as unknown as CalendarCacheFile) === cacheSignature(cache);
      if (same && age >= 0 && age < CACHE_REWRITE_MS) return { ok: true, value: false, changed: false };
    }
    const written = await this.deps.cache.write(cache as unknown as Record<string, unknown>);
    if (!written.ok) return written;
    this.deps.onCacheWritten?.();
    return { ok: true, value: true, changed: true };
  }

  private log(message: string, error?: unknown): void {
    if (this.deps.log) this.deps.log(message, error);
    else console.warn(`[matrix-planner] ${message}`, error ?? '');
  }
}

function safeParse(ics: string): IcsEvent[] {
  try {
    return parseIcs(ics).events;
  } catch {
    return [];
  }
}

function parseIcsName(ics: string): string | null {
  try {
    return parseIcs(ics).name?.trim() || null;
  } catch {
    return null;
  }
}

/** id заметок Планировщика в ресурсе (по URL `matrixplanner://item/<id>`). */
function plannerIdsOf(ics: string): ItemId[] {
  const ids = new Set<ItemId>();
  for (const event of safeParse(ics)) {
    const id = plannerItemIdOf(event);
    if (id) ids.add(id);
  }
  return [...ids];
}

function describeRepeat(repeat: RepeatRule): string | null {
  return repeat === 'none' ? null : t(`model.repeat.${repeat}`);
}

// ---------------------------------------------------------------------------
// Планировщик запусков
// ---------------------------------------------------------------------------

export interface CalendarSyncSchedulerDeps {
  engine: Pick<CalendarSyncEngine, 'syncNow' | 'pushItems'>;
  isEnabled(): boolean;
  intervalMs(): number;
  now(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** Задержка полного прохода после изменения данных (по умолчанию 10 с). */
  debounceMs?: number;
  /** Задержка адресной отправки изменённых элементов (по умолчанию 1 с). */
  pushDelayMs?: number;
}

export const SYNC_DEBOUNCE_MS = 10_000;
export const PUSH_DELAY_MS = 1_000;

/**
 * Запуск синхронизации. Изменённые элементы отправляются адресно через ~1 с (на iPhone
 * Obsidian уходит в фон почти сразу, и таймеры замирают); полный проход — через 10 с после
 * изменений, по интервалу и вручную. `flush` отправляет ожидающее немедленно (уход в фон).
 */
export class CalendarSyncScheduler {
  private timer: number | null = null;
  private pushTimer: number | null = null;
  private readonly pendingIds = new Set<ItemId>();
  private lastRunAt = 0;
  private disposed = false;

  constructor(private readonly deps: CalendarSyncSchedulerDeps) {}

  /** Изменились данные — полный проход после паузы (повторные изменения откладывают запуск). */
  schedule(): void {
    if (this.disposed || !this.deps.isEnabled()) return;
    this.cancel();
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.deps.debounceMs ?? SYNC_DEBOUNCE_MS);
  }

  /** Изменились элементы — адресная отправка через `pushDelayMs` от первого изменения. */
  push(ids: Iterable<ItemId>): void {
    if (this.disposed || !this.deps.isEnabled()) return;
    for (const id of ids) this.pendingIds.add(id);
    if (this.pendingIds.size === 0 || this.pushTimer !== null) return;
    this.pushTimer = this.deps.setTimeout(() => {
      this.pushTimer = null;
      void this.flush();
    }, this.deps.pushDelayMs ?? PUSH_DELAY_MS);
  }

  /** Отправить ожидающие изменения сейчас (уход приложения в фон). */
  flush(): Promise<PushOutcome> | null {
    this.cancelPush();
    if (this.disposed || this.pendingIds.size === 0) return null;
    const ids = [...this.pendingIds];
    this.pendingIds.clear();
    if (!this.deps.isEnabled()) return null;
    return this.deps.engine.pushItems(ids);
  }

  /** Проверка интервала (вызывается периодически и при возврате приложения). */
  tick(): void {
    if (this.disposed || !this.deps.isEnabled()) return;
    if (this.deps.now() - this.lastRunAt >= this.deps.intervalMs()) void this.run();
  }

  async run(): Promise<SyncOutcome | null> {
    if (this.disposed) return null;
    this.cancel();
    this.lastRunAt = this.deps.now();
    return this.deps.engine.syncNow();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.cancelPush();
    this.pendingIds.clear();
  }

  private cancel(): void {
    if (this.timer !== null) {
      this.deps.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private cancelPush(): void {
    if (this.pushTimer !== null) {
      this.deps.clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
  }
}
