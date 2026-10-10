/**
 * Возобновляемые миграции схемы (ТЗ §3.9).
 *
 * Порядок шага `N-1 → N`:
 * 1. флаг `migrating: true` в маркере (компаньон переходит в режим только чтения);
 * 2. резервная копия изменяемых свойств в `_system/migration-N.json` — до изменения заметок;
 * 3. точечные правки свойств (`processFrontMatter`) через репозиторий с `MigrationWriteGuard`;
 * 4. `status: done` в резервной копии, затем `schema: N` в маркере;
 * 5. после всех шагов — `migrating: false`.
 *
 * Прерывание на любом шаге оставляет флаг `migrating`; повторный запуск продолжает с той же версии.
 * Уже записанные значения «до» в резервной копии не перезаписываются.
 * При более новой или повреждённой схеме ничего не пишется.
 *
 * Список миграций пуст: схема 1 — первая версия. Миграции старых версий не придумываются.
 */

import { TFile, TFolder, type App } from 'obsidian';
import type { Clock, MarkerService, NoteRepository, SystemJsonStore, WriteGuard, WriteQueue } from '../app/contracts';
import {
  SCHEMA_VERSION,
  type FrontmatterRecord,
  type MarkerState,
  type MigrationFileName,
  type OpResult,
  type PlannerPaths,
  type VaultPath,
} from '../model/types';
import { MigrationWriteGuard, parseFrontmatterText } from '../storage/marker';
import { describeError, errorResult, ObsidianNoteRepository, okResult } from '../storage/note-repository';
import { isUnder, MARKER_PATH } from '../storage/paths';
import { AdapterSystemJsonStore } from '../storage/system-json-store';

// ---------------------------------------------------------------------------
// Описание миграций
// ---------------------------------------------------------------------------

export interface NoteSnapshot {
  path: VaultPath;
  frontmatter: FrontmatterRecord;
}

/** Новые значения свойств; `undefined` — удалить свойство. */
export type PropertyChanges = Record<string, unknown>;

export interface Migration {
  /** Версия схемы после шага; шаг применяется к данным версии `to - 1`. */
  to: number;
  /**
   * Изменения свойств заметки; `null` — заметку не менять.
   * Должна быть идемпотентной: для уже изменённой заметки возвращает `null` или те же значения.
   */
  plan(note: NoteSnapshot): PropertyChanges | null;
}

/** Миграции плагина. Пусто: других версий схемы ещё не было. */
export const MIGRATIONS: readonly Migration[] = [];

export function migrationFileName(version: number): MigrationFileName {
  return `migration-${version}.json`;
}

/** Нужно ли запускать миграцию (старая схема или прерванная миграция). */
export function needsMigration(state: MarkerState): boolean {
  return state.status === 'needs-migration' || state.status === 'migrating';
}

// ---------------------------------------------------------------------------
// Резервная копия
// ---------------------------------------------------------------------------

export interface BackupNoteEntry {
  /** Значения изменяемых свойств до миграции. */
  before: Record<string, unknown>;
  /** Изменяемые свойства, которых до миграции не было. */
  missing: string[];
  done: boolean;
}

export interface MigrationBackup {
  version: number;
  from: number;
  status: 'in-progress' | 'done';
  startedAt: string;
  finishedAt: string | null;
  notes: Record<VaultPath, BackupNoteEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBackupNotes(raw: unknown): Record<VaultPath, BackupNoteEntry> {
  const notes: Record<VaultPath, BackupNoteEntry> = {};
  if (!isRecord(raw)) return notes;
  for (const [path, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    notes[path] = {
      before: isRecord(entry['before']) ? { ...entry['before'] } : {},
      missing: Array.isArray(entry['missing']) ? entry['missing'].filter((k): k is string => typeof k === 'string') : [],
      done: entry['done'] === true,
    };
  }
  return notes;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Только реально меняющиеся свойства. */
export function effectiveChanges(frontmatter: FrontmatterRecord, changes: PropertyChanges): PropertyChanges {
  const result: PropertyChanges = {};
  for (const [key, value] of Object.entries(changes)) {
    const present = Object.prototype.hasOwnProperty.call(frontmatter, key);
    if (value === undefined ? present : !present || !sameValue(frontmatter[key], value)) result[key] = value;
  }
  return result;
}

/** Дополняет запись резервной копии ключами, которых в ней ещё нет (старые значения не трогаются). */
function recordBefore(entry: BackupNoteEntry | undefined, frontmatter: FrontmatterRecord, keys: readonly string[]): BackupNoteEntry {
  const next: BackupNoteEntry = entry
    ? { before: { ...entry.before }, missing: [...entry.missing], done: false }
    : { before: {}, missing: [], done: false };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(next.before, key) || next.missing.includes(key)) continue;
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) next.before[key] = JSON.parse(JSON.stringify(frontmatter[key] ?? null)) as unknown;
    else next.missing.push(key);
  }
  return next;
}

function applyChanges(frontmatter: FrontmatterRecord, changes: PropertyChanges): void {
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete frontmatter[key];
    else frontmatter[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Исполнитель
// ---------------------------------------------------------------------------

export interface MigrationDeps {
  marker: Pick<MarkerService, 'getState' | 'setMigrating'>;
  /** Записывает `schema` в маркер. */
  writeSchema(version: number): Promise<void>;
  /** `MigrationWriteGuard`: запись разрешена при `ok`/`needs-migration`/`migrating`. */
  guard: WriteGuard;
  /** Экземпляр репозитория с `MigrationWriteGuard`. */
  repository: Pick<NoteRepository, 'updateFrontmatter'>;
  /** Хранилище служебных JSON с `migrationGuard`. */
  systemJson: Pick<SystemJsonStore, 'read' | 'update'>;
  /** Заметки корня с актуальными свойствами (из файла, а не из кэша). */
  listNotes(): Promise<NoteSnapshot[]>;
  clock: Clock;
  /** По умолчанию `MIGRATIONS` и `SCHEMA_VERSION`; в тестах — тестовая миграция. */
  migrations?: readonly Migration[];
  targetVersion?: number;
  log?(message: string, error?: unknown): void;
}

export interface MigrationOutcome {
  from: number;
  to: number;
  /** Заметок изменено за этот запуск. */
  changedNotes: number;
}

export async function runMigrations(deps: MigrationDeps): Promise<OpResult<MigrationOutcome>> {
  const state = deps.marker.getState();
  const marker = state.marker;
  if (!marker || state.status === 'invalid' || state.status === 'unknown') {
    return errorResult<MigrationOutcome>('read-only', `marker status: ${state.status}`, undefined, 'storage.readOnly.invalid');
  }
  const target = deps.targetVersion ?? SCHEMA_VERSION;
  const from = marker.schema;
  // Новая схема: только чтение, ничего не пишем.
  if (from > target || state.status === 'newer') {
    return errorResult<MigrationOutcome>('read-only', `schema ${from} is newer than ${target}`, undefined, 'storage.readOnly.newer');
  }
  const blocked = deps.guard.check();
  if (blocked) return errorResult<MigrationOutcome>('read-only', `guard: ${state.status}`, undefined, blocked.messageKey);
  if (from === target && !marker.migrating) return okResult({ from, to: target, changedNotes: 0 }, false);

  const steps = [...(deps.migrations ?? MIGRATIONS)].filter((m) => m.to > from && m.to <= target).sort((a, b) => a.to - b.to);
  for (let version = from + 1, i = 0; version <= target; version += 1, i += 1) {
    if (steps[i]?.to !== version) {
      return errorResult<MigrationOutcome>('unsupported', `no migration to schema ${version}`);
    }
  }

  try {
    if (!marker.migrating) await deps.marker.setMigrating(true);
  } catch (error) {
    return errorResult<MigrationOutcome>('write-failed', describeError(error), error);
  }

  let changedNotes = 0;
  let current = from;
  for (const step of steps) {
    const result = await applyStep(deps, step, current);
    // Флаг `migrating` остаётся: следующий запуск продолжит этот шаг.
    if (!result.ok) return { ok: false, error: result.error };
    changedNotes += result.value;
    try {
      await deps.writeSchema(step.to);
    } catch (error) {
      return errorResult<MigrationOutcome>('write-failed', describeError(error), error);
    }
    current = step.to;
  }

  try {
    await deps.marker.setMigrating(false);
  } catch (error) {
    return errorResult<MigrationOutcome>('write-failed', describeError(error), error);
  }
  return okResult({ from, to: current, changedNotes }, true);
}

async function applyStep(deps: MigrationDeps, step: Migration, from: number): Promise<OpResult<number>> {
  const name = migrationFileName(step.to);
  const read = await deps.systemJson.read(name);
  // Повреждённую резервную копию не перезаписываем: в ней могут быть исходные значения.
  if (read.status === 'corrupt') return { ok: false, error: { code: 'invalid', detail: `${name}: ${read.detail}` } };
  const existing = read.status === 'ok' && isRecord(read.value) ? read.value : null;
  if (existing?.['status'] === 'done') return { ok: true, value: 0, changed: false };

  const notes = readBackupNotes(existing?.['notes']);
  const snapshots = await deps.listNotes();

  // Фаза 1: план и резервная копия — до любых изменений заметок.
  const plans: Array<{ path: VaultPath; changes: PropertyChanges }> = [];
  for (const snapshot of snapshots) {
    if (notes[snapshot.path]?.done) continue;
    let planned: PropertyChanges | null;
    try {
      planned = step.plan(snapshot);
    } catch (error) {
      return { ok: false, error: { code: 'unknown', detail: `${snapshot.path}: ${describeError(error)}`, cause: error } };
    }
    if (!planned) continue;
    const changes = effectiveChanges(snapshot.frontmatter, planned);
    const keys = Object.keys(changes);
    if (keys.length === 0) continue;
    notes[snapshot.path] = recordBefore(notes[snapshot.path], snapshot.frontmatter, keys);
    plans.push({ path: snapshot.path, changes });
  }

  const startedAt = typeof existing?.['startedAt'] === 'string' ? existing['startedAt'] : deps.clock.now().toISOString();
  const backup = await deps.systemJson.update(name, (current) => ({
    ...(current ?? {}),
    version: step.to,
    from,
    status: 'in-progress',
    startedAt,
    finishedAt: null,
    notes,
  }));
  if (!backup.ok) return { ok: false, error: backup.error };

  // Фаза 2: точечные правки свойств.
  let changed = 0;
  for (const plan of plans) {
    const result = await deps.repository.updateFrontmatter(plan.path, (frontmatter) => applyChanges(frontmatter, plan.changes));
    if (!result.ok) return { ok: false, error: result.error };
    if (result.changed) changed += 1;
    const entry = notes[plan.path];
    if (entry) entry.done = true;
  }

  const finished = await deps.systemJson.update(name, (current) => ({
    ...(current ?? {}),
    status: 'done',
    finishedAt: deps.clock.now().toISOString(),
    notes,
  }));
  if (!finished.ok) return { ok: false, error: finished.error };
  return { ok: true, value: changed, changed: changed > 0 };
}

// ---------------------------------------------------------------------------
// Подключение к хранилищу
// ---------------------------------------------------------------------------

export interface VaultMigrationOptions {
  getPaths(): PlannerPaths;
  queue: WriteQueue;
  marker: Pick<MarkerService, 'getState' | 'setMigrating'>;
  clock: Clock;
  migrations?: readonly Migration[];
  targetVersion?: number;
  log?(message: string, error?: unknown): void;
}

/**
 * Зависимости миграции на реальном хранилище: второй экземпляр репозитория
 * и хранилище служебных JSON с `MigrationWriteGuard` (обычный запрет при
 * `needs-migration`/`migrating` запись блокирует).
 */
export function createVaultMigrationDeps(app: App, options: VaultMigrationOptions): MigrationDeps {
  const guard = new MigrationWriteGuard(options.marker);
  const repository = new ObsidianNoteRepository(app, { getPaths: options.getPaths, guard, queue: options.queue });
  const systemJson = new AdapterSystemJsonStore(app, { getPaths: options.getPaths, queue: options.queue, guard, migrationGuard: guard });
  return {
    marker: options.marker,
    guard,
    repository,
    systemJson,
    clock: options.clock,
    migrations: options.migrations,
    targetVersion: options.targetVersion,
    log: options.log,
    writeSchema: (version) =>
      options.queue.run(MARKER_PATH, async () => {
        const file = app.vault.getFileByPath(MARKER_PATH);
        if (!file) throw new Error('Marker not found');
        await app.fileManager.processFrontMatter(file, (frontmatter: FrontmatterRecord) => {
          frontmatter['schema'] = version;
        });
      }),
    listNotes: () => listVaultNotes(app, options.getPaths(), options.log),
  };
}

/** Заметки корня (без `_system` и обоев) со свойствами, прочитанными из файла. */
export async function listVaultNotes(app: App, paths: PlannerPaths, log?: (message: string, error?: unknown) => void): Promise<NoteSnapshot[]> {
  const root = app.vault.getFolderByPath(paths.root);
  if (!root) return [];
  const files: TFile[] = [];
  const stack: TFolder[] = [root];
  while (stack.length > 0) {
    const folder = stack.pop() as TFolder;
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        if (!isUnder(child.path, paths.system) && !isUnder(child.path, paths.wallpapers)) stack.push(child);
      } else if (child instanceof TFile && child.extension === 'md') {
        files.push(child);
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const result: NoteSnapshot[] = [];
  for (const file of files) {
    try {
      const frontmatter = parseFrontmatterText(await app.vault.read(file));
      if (frontmatter) result.push({ path: file.path, frontmatter });
    } catch (error) {
      log?.(`Matrix planner: cannot read ${file.path} for migration`, error);
    }
  }
  return result;
}
