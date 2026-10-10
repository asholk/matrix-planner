/**
 * Записи плагина в общие служебные JSON (ТЗ §3.1, §4.5, §5.4.3):
 *  - `_system/tombstones.json` — метки удаления заметок-событий (идемпотентно по `id`);
 *  - `_system/companion.json` — только поддерево `wallpapers.<профиль>` (статус обоев);
 *    остальные поля пишет компаньон, плагин их сохраняет как есть.
 *
 * Запись — через `SystemJsonStore.update`: файл перечитывается в очереди, мутатор меняет
 * только свои ключи, повреждённый файл не перезаписывается. Формат — docs/system-json.md.
 */

import type { App, EventRef, TAbstractFile } from 'obsidian';
import type { Clock, CompanionStore, SystemJsonStore, TombstoneWriter } from '../app/contracts';
import { registerDictionary } from '../i18n';
import { enCache } from '../i18n/en/cache';
import { ruCache } from '../i18n/ru/cache';
import {
  SYSTEM_FILES,
  type CompanionState,
  type IsoInstantString,
  type ItemId,
  type OpResult,
  type SystemJsonName,
  type TombstoneRecord,
  type Unsubscribe,
  type VaultPath,
  type WallpaperStatusRecord,
} from '../model/types';
import { errorResult, okResult } from './note-repository';

registerDictionary('ru', 'cache', ruCache);
registerDictionary('en', 'cache', enCache);

/** Поддерживаемая версия `tombstones.json`. */
export const TOMBSTONES_VERSION = 1;
/** Поддерживаемая версия `companion.json`. */
export const COMPANION_VERSION = 1;

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
/** Ключи, которые нельзя использовать как имя профиля в объекте. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isIsoInstant(value: unknown): value is IsoInstantString {
  return typeof value === 'string' && ISO_INSTANT_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function isoOrNull(value: unknown): IsoInstantString | null {
  return isIsoInstant(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Версия файла новее поддерживаемой: запись запрещена, чтобы не испортить чужой формат. */
class NewerVersionError extends Error {
  constructor(readonly version: number) {
    super(`unsupported version ${version}`);
  }
}

/** Структура файла не та, что ожидается (например, `tombstones` не массив). */
class ShapeError extends Error {}

function checkVersion(current: Record<string, unknown>, supported: number): void {
  const version = current['version'];
  if (typeof version === 'number' && version > supported) throw new NewerVersionError(version);
}

/** Подписка на изменения служебного файла в хранилище. */
export function watchSystemFile(app: App, getPath: () => VaultPath, onChange: () => void): Unsubscribe {
  const vault = app.vault;
  const onFile = (file: TAbstractFile, oldPath?: string): void => {
    const path = getPath();
    if (file.path === path || oldPath === path) onChange();
  };
  const refs: EventRef[] = [
    vault.on('create', (file) => onFile(file)),
    vault.on('modify', (file) => onFile(file)),
    vault.on('delete', (file) => onFile(file)),
    vault.on('rename', (file, oldPath) => onFile(file, oldPath)),
  ];
  return () => {
    for (const ref of refs) vault.offref(ref);
  };
}

interface FailureKeys {
  code: 'tombstone-failed' | 'invalid' | 'write-failed';
  corrupt: string;
  newer: string;
}

/** Ошибка `store.update` → ошибка операции с понятным ключом i18n. */
function mapUpdateError<T>(result: Extract<OpResult<unknown>, { ok: false }>, keys: FailureKeys): OpResult<T> {
  const { error } = result;
  if (error.code === 'read-only') return { ok: false, error };
  if (error.cause instanceof NewerVersionError) {
    return errorResult<T>(keys.code === 'tombstone-failed' ? 'tombstone-failed' : 'read-only', error.detail, error.cause, keys.newer);
  }
  if (error.code === 'invalid' || error.cause instanceof ShapeError) {
    return errorResult<T>(keys.code === 'tombstone-failed' ? 'tombstone-failed' : 'invalid', error.detail, error.cause, keys.corrupt);
  }
  return errorResult<T>(keys.code === 'tombstone-failed' ? 'tombstone-failed' : 'write-failed', error.detail, error.cause);
}

// ===========================================================================
// tombstones.json
// ===========================================================================

/** Записи `tombstones.json` → нормализованные метки (битые пропускаются, дубли — самая ранняя). */
export function parseTombstones(value: unknown): TombstoneRecord[] | null {
  if (!isRecord(value)) return null;
  const raw = value['tombstones'] ?? [];
  if (!Array.isArray(raw)) return null;
  const byId = new Map<ItemId, TombstoneRecord>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = stringOrNull(entry['id']);
    if (!id || entry['kind'] !== 'event') continue;
    const deletedAt = isoOrNull(entry['deleted_at']) ?? '';
    const existing = byId.get(id);
    if (existing && (existing.deletedAt === '' || (deletedAt !== '' && Date.parse(existing.deletedAt) <= Date.parse(deletedAt)))) continue;
    byId.set(id, { id, kind: 'event', deletedAt });
  }
  return [...byId.values()];
}

/** Полноценная метка удаления события с этим id (как её принимает `parseTombstones`). */
function isTombstoneFor(entry: unknown, id: ItemId): boolean {
  return isRecord(entry) && entry['id'] === id && entry['kind'] === 'event';
}

export interface SystemRecordsDeps {
  store: Pick<SystemJsonStore, 'read' | 'update' | 'path'>;
  clock: Clock;
  /** Имя устройства для поля `device_name` (необязательно). */
  deviceName?: () => string | null;
}

export class SystemTombstoneWriter implements TombstoneWriter {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SystemRecordsDeps) {}

  /** Подписка на изменения меток (своя запись или изменение файла через `watch`). */
  onChange(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Оповещает подписчиков при изменении `tombstones.json` в хранилище. Отписку регистрирует вызывающий. */
  watch(app: App): Unsubscribe {
    return watchSystemFile(app, () => this.deps.store.path(SYSTEM_FILES.tombstones), () => this.emit());
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[matrix-planner] tombstones listener failed', error);
      }
    }
  }

  async add(id: ItemId, kind: 'event'): Promise<OpResult> {
    if (typeof id !== 'string' || id.trim() === '') return errorResult('invalid', 'empty tombstone id');
    const deletedAt = this.deps.clock.now().toISOString();
    const deviceName = this.deps.deviceName?.() ?? null;
    const result = await this.deps.store.update(SYSTEM_FILES.tombstones, (current) => {
      const base = current ?? { version: TOMBSTONES_VERSION, tombstones: [] };
      checkVersion(base, TOMBSTONES_VERSION);
      const raw = base['tombstones'] ?? [];
      if (!Array.isArray(raw)) throw new ShapeError('"tombstones" is not an array');
      const list: readonly unknown[] = raw;
      const same = list.filter((entry) => isRecord(entry) && entry['id'] === id);
      // Полноценная метка с этим id уже есть (своя или другого устройства) — ничего не меняем.
      if (same.some((entry) => isTombstoneFor(entry, id))) return base;
      // Запись с этим id есть, но не метка события: компаньон её не учтёт, а молча
      // дописывать вторую запись нельзя — удаление останавливается до корзины.
      if (same.length > 0) throw new ShapeError(`tombstone "${id}" is damaged`);
      const entry: Record<string, unknown> = { id, kind, deleted_at: deletedAt };
      if (deviceName) entry['device_name'] = deviceName;
      // Новый объект: исходный не меняется, иначе store не увидит изменения.
      return { ...base, tombstones: [...list, entry] };
    });
    if (!result.ok) {
      return mapUpdateError<void>(result, {
        code: 'tombstone-failed',
        corrupt: 'cache.errors.tombstonesCorrupt',
        newer: 'cache.errors.tombstonesNewer',
      });
    }
    if (result.changed) this.emit();
    return okResult(undefined, result.changed);
  }

  async list(): Promise<OpResult<readonly TombstoneRecord[]>> {
    const read = await this.deps.store.read(SYSTEM_FILES.tombstones);
    if (read.status === 'missing') return okResult<readonly TombstoneRecord[]>([], false);
    if (read.status === 'corrupt') {
      return errorResult<readonly TombstoneRecord[]>('invalid', read.detail, undefined, 'cache.errors.tombstonesCorrupt');
    }
    const records = parseTombstones(read.value);
    if (!records) {
      return errorResult<readonly TombstoneRecord[]>('invalid', 'unexpected tombstones structure', undefined, 'cache.errors.tombstonesCorrupt');
    }
    return okResult<readonly TombstoneRecord[]>(records, false);
  }

  async has(id: ItemId): Promise<boolean> {
    const listed = await this.list();
    return listed.ok && listed.value.some((record) => record.id === id);
  }
}

// ===========================================================================
// companion.json
// ===========================================================================

type WallpaperStatusPatch = Partial<Omit<WallpaperStatusRecord, 'profileId'>>;

/** Поле нормализованной записи → ключ в файле. */
const WALLPAPER_FIELDS: ReadonlyArray<[keyof WallpaperStatusPatch, string]> = [
  ['savedAt', 'saved_at'],
  ['launchedAt', 'launched_at'],
  ['confirmedAt', 'confirmed_at'],
  ['failedAt', 'failed_at'],
  ['deviceName', 'device_name'],
];

function isValidProfileId(profileId: unknown): profileId is string {
  return typeof profileId === 'string' && profileId.trim() !== '' && !RESERVED_KEYS.has(profileId);
}

function parseWallpaperStatus(profileId: string, raw: Record<string, unknown>): WallpaperStatusRecord {
  return {
    profileId,
    savedAt: isoOrNull(raw['saved_at']),
    launchedAt: isoOrNull(raw['launched_at']),
    confirmedAt: isoOrNull(raw['confirmed_at']),
    failedAt: isoOrNull(raw['failed_at']),
    deviceName: stringOrNull(raw['device_name']),
  };
}

/** Содержимое `companion.json` → `CompanionState` (неизвестные поля игнорируются). */
export function parseCompanion(value: unknown): CompanionState {
  if (!isRecord(value)) return { status: 'corrupt', detail: 'not a JSON object' };
  const wallpapers: Record<string, WallpaperStatusRecord> = {};
  const rawWallpapers = value['wallpapers'];
  if (isRecord(rawWallpapers)) {
    for (const [profileId, raw] of Object.entries(rawWallpapers)) {
      if (isValidProfileId(profileId) && isRecord(raw)) wallpapers[profileId] = parseWallpaperStatus(profileId, raw);
    }
  }
  return {
    status: 'ok',
    primaryDevice: stringOrNull(value['primary_device']),
    lastUpdate: isoOrNull(value['last_update']),
    wallpapers,
  };
}

/** Проверка патча: время — ISO 8601 со смещением или `null`, имя устройства — строка или `null`. */
function validatePatch(patch: WallpaperStatusPatch): string | null {
  for (const [field] of WALLPAPER_FIELDS) {
    const value = patch[field];
    if (value === undefined || value === null) continue;
    if (field === 'deviceName') {
      if (typeof value !== 'string') return `${field} must be a string`;
    } else if (!isIsoInstant(value)) {
      return `${field} must be an ISO 8601 instant`;
    }
  }
  return null;
}

export class SystemCompanionStore implements CompanionStore {
  private state: CompanionState = { status: 'missing' };
  private signature = 'missing';
  private readonly listeners = new Set<(state: CompanionState) => void>();
  /** Номер последней начатой операции и номер операции, чьё состояние применено. */
  private ticket = 0;
  private appliedTicket = 0;

  constructor(private readonly deps: Pick<SystemRecordsDeps, 'store'>) {}

  /** Чтение, начатое до более нового применённого состояния (запись, другое чтение), отбрасывается. */
  async read(): Promise<CompanionState> {
    const ticket = ++this.ticket;
    const read = await this.deps.store.read(SYSTEM_FILES.companion);
    if (ticket < this.appliedTicket) return this.state;
    this.appliedTicket = ticket;
    if (read.status === 'ok') this.setState(parseCompanion(read.value), `ok:${JSON.stringify(read.value)}`);
    else if (read.status === 'corrupt') this.setState(read, `corrupt:${read.detail}`);
    else this.setState(read, 'missing');
    return this.state;
  }

  getState(): CompanionState {
    return this.state;
  }

  /**
   * Меняет только переданные поля `wallpapers.<profileId>`; `undefined` — не трогать,
   * `null` — очистить. Остальные поля файла и профиля сохраняются.
   */
  async updateWallpaperStatus(profileId: string, patch: WallpaperStatusPatch): Promise<OpResult> {
    if (!isValidProfileId(profileId)) return errorResult('invalid', `invalid profile id: ${String(profileId)}`);
    const invalid = validatePatch(patch);
    if (invalid) return errorResult('invalid', invalid);

    const result = await this.deps.store.update(SYSTEM_FILES.companion, (current) => {
      const base = current ?? { version: COMPANION_VERSION };
      checkVersion(base, COMPANION_VERSION);
      const wallpapers = base['wallpapers'] ?? {};
      if (!isRecord(wallpapers)) throw new ShapeError('"wallpapers" is not an object');
      const previous = wallpapers[profileId];
      const record: Record<string, unknown> = isRecord(previous) ? { ...previous } : {};
      for (const [field, key] of WALLPAPER_FIELDS) {
        const value = patch[field];
        if (value !== undefined) record[key] = value;
      }
      return { ...base, wallpapers: { ...wallpapers, [profileId]: record } };
    });
    if (!result.ok) {
      return mapUpdateError<void>(result, {
        code: 'invalid',
        corrupt: 'cache.errors.companionCorrupt',
        newer: 'cache.errors.companionNewer',
      });
    }
    // Номер — по завершении записи: чтения, начатые раньше, не перезапишут результат.
    this.appliedTicket = ++this.ticket;
    this.setState(parseCompanion(result.value), `ok:${JSON.stringify(result.value)}`);
    return okResult(undefined, result.changed);
  }

  onChange(listener: (state: CompanionState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Перечитывает файл при его изменении в хранилище. Отписку регистрирует вызывающий. */
  watch(app: App): Unsubscribe {
    return watchSystemFile(app, () => this.path(SYSTEM_FILES.companion), () => void this.read());
  }

  private path(name: SystemJsonName): VaultPath {
    return this.deps.store.path(name);
  }

  private setState(next: CompanionState, signature: string): void {
    if (signature === this.signature) return;
    this.signature = signature;
    this.state = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (error) {
        console.error('[matrix-planner] companion listener failed', error);
      }
    }
  }
}
