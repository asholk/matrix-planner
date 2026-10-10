/**
 * Служебные JSON в `<корень>/_system/` — только через `vault.adapter` (ТЗ §3.1).
 *
 * - `read` различает отсутствие и повреждение;
 * - `update` перечитывает файл в очереди, передаёт мутатору свежий объект
 *   (неизвестные поля сохраняются, если мутатор их не трогает) и не перезаписывает повреждённый файл;
 * - `calendar-cache.json` через `update`/`write` не пишется: его пишет компаньон или движок
 *   синхронизации CalDAV плагина — только через отдельный метод `writeCalendarCache`.
 */

import type { App } from 'obsidian';
import type { SystemJsonReadResult, SystemJsonStore, WriteGuard, WriteQueue } from '../app/contracts';
import { SYSTEM_FILES, type OpResult, type PlannerPaths, type SystemJsonName, type VaultPath } from '../model/types';
import { describeError, errorResult, okResult } from './note-repository';
import { parentPath } from './paths';

const MIGRATION_FILE_RE = /^migration-\d+\.json$/;
const KNOWN_FILES = new Set<string>(Object.values(SYSTEM_FILES));

/** Имя допустимого служебного файла (защита от путей вида `../x.json`). */
export function isSystemJsonName(name: string): name is SystemJsonName {
  return KNOWN_FILES.has(name) || MIGRATION_FILE_RE.test(name);
}

export function isMigrationFileName(name: string): boolean {
  return MIGRATION_FILE_RE.test(name);
}

/** Разбор текста JSON с различением повреждения. */
export function parseSystemJson(text: string): SystemJsonReadResult {
  const clean = text.replace(/^\uFEFF/, '');
  if (clean.trim() === '') return { status: 'corrupt', detail: 'empty file' };
  try {
    return { status: 'ok', value: JSON.parse(clean) as unknown };
  } catch (error) {
    return { status: 'corrupt', detail: describeError(error) };
  }
}

export function serializeSystemJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SystemJsonStoreDeps {
  getPaths(): PlannerPaths;
  queue: WriteQueue;
  guard: WriteGuard;
  /** Запрет для `migration-*.json` (по умолчанию — `guard`); см. `MigrationWriteGuard`. */
  migrationGuard?: WriteGuard;
}

/** Запись `calendar-cache.json` движком синхронизации календаря (src/caldav). */
export interface CalendarCacheFileWriter {
  writeCalendarCache(value: Record<string, unknown>): Promise<OpResult>;
}

export function canWriteCalendarCache(store: unknown): store is CalendarCacheFileWriter {
  return typeof (store as Partial<CalendarCacheFileWriter> | null)?.writeCalendarCache === 'function';
}

export class AdapterSystemJsonStore implements SystemJsonStore, CalendarCacheFileWriter {
  constructor(
    private readonly app: App,
    private readonly deps: SystemJsonStoreDeps,
  ) {}

  path(name: SystemJsonName): VaultPath {
    return this.deps.getPaths().systemFile(name);
  }

  async read(name: SystemJsonName): Promise<SystemJsonReadResult> {
    if (!isSystemJsonName(name)) return { status: 'corrupt', detail: `unknown system file: ${String(name)}` };
    return this.readPath(this.path(name));
  }

  async update(
    name: SystemJsonName,
    mutate: (current: Record<string, unknown> | null) => Record<string, unknown>,
  ): Promise<OpResult<Record<string, unknown>>> {
    const blocked = this.checkWritable<Record<string, unknown>>(name);
    if (blocked) return blocked;
    const path = this.path(name);
    return this.deps.queue.run(path, async () => {
      const recheck = this.recheck<Record<string, unknown>>(name, path);
      if (recheck) return recheck;
      const current = await this.readPath(path);
      if (current.status === 'corrupt') return errorResult<Record<string, unknown>>('invalid', current.detail);
      if (current.status === 'ok' && !isRecord(current.value)) {
        return errorResult<Record<string, unknown>>('invalid', 'not a JSON object');
      }
      const before = current.status === 'ok' ? (current.value as Record<string, unknown>) : null;
      const beforeText = before ? JSON.stringify(before) : null;
      let next: Record<string, unknown>;
      try {
        next = mutate(before);
      } catch (error) {
        return errorResult<Record<string, unknown>>('unknown', describeError(error), error);
      }
      if (!isRecord(next)) return errorResult<Record<string, unknown>>('invalid', 'mutator must return an object');
      if (beforeText !== null && JSON.stringify(next) === beforeText) return okResult(next, false);
      const written = await this.writePath(path, next);
      return written.ok ? okResult(next, true) : errorResult<Record<string, unknown>>('write-failed', written.error.detail, written.error.cause);
    });
  }

  async write(name: SystemJsonName, value: Record<string, unknown>): Promise<OpResult> {
    const blocked = this.checkWritable<void>(name);
    if (blocked) return blocked;
    if (!isRecord(value)) return errorResult('invalid', 'value must be an object');
    const path = this.path(name);
    return this.deps.queue.run(path, async () => this.recheck<void>(name, path) ?? this.writePath(path, value));
  }

  /**
   * Явное исключение из запрета: кэш календаря целиком пишет движок синхронизации CalDAV.
   * Запрет схемы (`guard`) действует; файл более новой версии не перезаписывается.
   */
  async writeCalendarCache(value: Record<string, unknown>): Promise<OpResult> {
    if (!isRecord(value)) return errorResult('invalid', 'value must be an object');
    const name = SYSTEM_FILES.calendarCache;
    const path = this.path(name);
    const check = (): OpResult | null => {
      const blocked = this.deps.guard.check();
      if (blocked) return errorResult('read-only', undefined, undefined, blocked.messageKey);
      return this.path(name) !== path ? errorResult('outside-root', path) : null;
    };
    const early = check();
    if (early) return early;
    return this.deps.queue.run(path, async () => {
      const recheck = check();
      if (recheck) return recheck;
      const current = await this.readPath(path);
      if (current.status === 'ok' && isRecord(current.value)) {
        const version = current.value.version;
        const own = value.version;
        if (typeof version === 'number' && typeof own === 'number' && version > own) {
          return errorResult('read-only', 'calendar cache has a newer version');
        }
      }
      return this.writePath(path, value);
    });
  }

  // -------------------------------------------------------------------------

  private checkWritable<T>(name: SystemJsonName): OpResult<T> | null {
    if (!isSystemJsonName(name)) return errorResult<T>('invalid', `unknown system file: ${String(name)}`);
    if (name === SYSTEM_FILES.calendarCache) return errorResult<T>('read-only', 'calendar cache is written by writeCalendarCache only');
    const guard = isMigrationFileName(name) ? (this.deps.migrationGuard ?? this.deps.guard) : this.deps.guard;
    const blocked = guard.check();
    return blocked ? errorResult<T>('read-only', undefined, undefined, blocked.messageKey) : null;
  }

  /** Повторная проверка внутри очереди: запрет мог появиться, а корень — смениться, пока задание ждало. */
  private recheck<T>(name: SystemJsonName, path: VaultPath): OpResult<T> | null {
    const blocked = this.checkWritable<T>(name);
    if (blocked) return blocked;
    if (this.path(name) !== path) return errorResult<T>('outside-root', path);
    return null;
  }

  private async readPath(path: VaultPath): Promise<SystemJsonReadResult> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(path))) return { status: 'missing' };
      return parseSystemJson(await adapter.read(path));
    } catch (error) {
      return { status: 'corrupt', detail: `read error: ${describeError(error)}` };
    }
  }

  private async writePath(path: VaultPath, value: Record<string, unknown>): Promise<OpResult> {
    const adapter = this.app.vault.adapter;
    try {
      const folder = parentPath(path);
      if (folder !== '' && !(await adapter.exists(folder))) await adapter.mkdir(folder);
      await adapter.write(path, serializeSystemJson(value));
      return okResult(undefined, true);
    } catch (error) {
      return errorResult('write-failed', describeError(error), error);
    }
  }
}
