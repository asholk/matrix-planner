/**
 * Служебные JSON в `<корень>/_system/` — только через `vault.adapter` (ТЗ §3.1).
 *
 * - `read` различает отсутствие и повреждение;
 * - `update` перечитывает файл в очереди, передаёт мутатору свежий объект
 *   (неизвестные поля сохраняются, если мутатор их не трогает) и не перезаписывает повреждённый файл;
 * - `calendar-cache.json` пишет только компаньон: запись запрещена.
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
  const clean = text.replace(/^﻿/, '');
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

export class AdapterSystemJsonStore implements SystemJsonStore {
  constructor(
    private readonly app: App,
    private readonly deps: SystemJsonStoreDeps,
  ) {}

  path(name: SystemJsonName): VaultPath {
    return this.deps.getPaths().systemFile(name);
  }

  async read(name: SystemJsonName): Promise<SystemJsonReadResult> {
    if (!isSystemJsonName(name)) return { status: 'corrupt', detail: `unknown system file: ${name}` };
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
    return this.deps.queue.run(path, () => this.writePath(path, value));
  }

  // -------------------------------------------------------------------------

  private checkWritable<T>(name: SystemJsonName): OpResult<T> | null {
    if (!isSystemJsonName(name)) return errorResult<T>('invalid', `unknown system file: ${name}`);
    if (name === SYSTEM_FILES.calendarCache) return errorResult<T>('read-only', 'calendar cache is written by the companion only');
    const guard = isMigrationFileName(name) ? (this.deps.migrationGuard ?? this.deps.guard) : this.deps.guard;
    const blocked = guard.check();
    return blocked ? errorResult<T>('read-only', undefined, undefined, blocked.messageKey) : null;
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
