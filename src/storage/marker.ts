/**
 * Маркер `matrix-planner.md` в корне хранилища (ТЗ §3.1, §3.9): создание, чтение схемы,
 * флаг миграции и запрет записи (`WriteGuard`) при новой/повреждённой схеме.
 *
 * Маркер читается из текста файла, а не из `metadataCache`: кэш после записи
 * обновляется не сразу.
 */

import { parseYaml, TFolder, type App, type EventRef, type TAbstractFile } from 'obsidian';
import type { IdGenerator, MarkerService, WriteGuard, WriteQueue } from '../app/contracts';
import {
  MIN_SUPPORTED_SCHEMA,
  SCHEMA_VERSION,
  type FrontmatterRecord,
  type MarkerProperties,
  type MarkerState,
  type PlannerPaths,
  type PropertyIssue,
  type SchemaStatus,
  type Unsubscribe,
} from '../model/types';
import { t } from '../i18n';
import { buildNoteText, describeError, splitFrontmatterText } from './note-repository';
import { MARKER_PATH, joinPath, normalizeVaultPath } from './paths';

// ---------------------------------------------------------------------------
// Чистый разбор маркера
// ---------------------------------------------------------------------------

/**
 * Разбирает свойства маркера. `frontmatter === null` — свойства отсутствуют или YAML повреждён.
 * Недостающие `root`/`vault_id`/`migrating` — проблемы, но не повреждение (их исправляет `ensure`).
 */
export function evaluateMarker(frontmatter: FrontmatterRecord | null): MarkerState {
  if (!frontmatter) {
    return { status: 'invalid', marker: null, issues: [{ property: 'schema', code: 'missing' }] };
  }
  const issues: PropertyIssue[] = [];
  const schemaValue = frontmatter['schema'];
  const schema = typeof schemaValue === 'string' && /^\d+$/.test(schemaValue.trim()) ? Number(schemaValue) : schemaValue;
  if (schemaValue === undefined || schemaValue === null) {
    return { status: 'invalid', marker: null, issues: [{ property: 'schema', code: 'missing' }] };
  }
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 0) {
    return { status: 'invalid', marker: null, issues: [{ property: 'schema', code: 'invalid-type', value: schemaValue }] };
  }

  const rootValue = frontmatter['root'];
  let root = '';
  if (typeof rootValue === 'string' && rootValue.trim() !== '') root = normalizeVaultPath(rootValue.trim());
  else issues.push({ property: 'root', code: rootValue === undefined ? 'missing' : 'invalid-type', value: rootValue });

  const vaultIdValue = frontmatter['vault_id'];
  let vaultId = '';
  if (typeof vaultIdValue === 'string' && vaultIdValue.trim() !== '') vaultId = vaultIdValue.trim();
  else issues.push({ property: 'vault_id', code: vaultIdValue === undefined ? 'missing' : 'invalid-type', value: vaultIdValue });

  const migratingValue = frontmatter['migrating'];
  let migrating = false;
  if (typeof migratingValue === 'boolean') migrating = migratingValue;
  else if (migratingValue !== undefined && migratingValue !== null) {
    issues.push({ property: 'migrating', code: 'invalid-type', value: migratingValue });
  }

  const marker: MarkerProperties = { root, schema, vault_id: vaultId, migrating };
  return { status: schemaStatus(schema, migrating), marker, issues };
}

/** Статус схемы по номеру версии и флагу миграции. Новая схема важнее флага. */
export function schemaStatus(schema: number, migrating: boolean): SchemaStatus {
  if (schema > SCHEMA_VERSION) return 'newer';
  if (schema < MIN_SUPPORTED_SCHEMA) return 'invalid';
  if (migrating) return 'migrating';
  if (schema < SCHEMA_VERSION) return 'needs-migration';
  return 'ok';
}

/** Разбирает YAML блока свойств текста заметки; `null` — блока нет или он повреждён. */
export function parseFrontmatterText(text: string): FrontmatterRecord | null {
  const split = splitFrontmatterText(text);
  if (split.yaml === null) return null;
  if (split.yaml.trim() === '') return {};
  try {
    const parsed: unknown = parseYaml(split.yaml);
    if (parsed === null || parsed === undefined) return {};
    return typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as FrontmatterRecord) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Запрет записи
// ---------------------------------------------------------------------------

const READ_ONLY_KEYS: Record<Exclude<SchemaStatus, 'ok'>, string> = {
  unknown: 'storage.readOnly.unknown',
  'needs-migration': 'storage.readOnly.needsMigration',
  migrating: 'storage.readOnly.migrating',
  newer: 'storage.readOnly.newer',
  invalid: 'storage.readOnly.invalid',
};

/** Обычный запрет: запись только при `ok`. */
export class MarkerWriteGuard implements WriteGuard {
  constructor(private readonly marker: Pick<MarkerService, 'getState'>) {}

  canWrite(): boolean {
    return this.check() === null;
  }

  check(): { code: 'read-only'; messageKey: string } | null {
    const status = this.marker.getState().status;
    return status === 'ok' ? null : { code: 'read-only', messageKey: READ_ONLY_KEYS[status] };
  }
}

/**
 * Запрет для службы миграции (S1.T9): разрешает запись при `ok`, `needs-migration`
 * и `migrating`, но не при новой или повреждённой схеме.
 */
export class MigrationWriteGuard implements WriteGuard {
  constructor(private readonly marker: Pick<MarkerService, 'getState'>) {}

  canWrite(): boolean {
    return this.check() === null;
  }

  check(): { code: 'read-only'; messageKey: string } | null {
    const status = this.marker.getState().status;
    if (status === 'ok' || status === 'needs-migration' || status === 'migrating') return null;
    return { code: 'read-only', messageKey: READ_ONLY_KEYS[status] };
  }
}

// ---------------------------------------------------------------------------
// Служба маркера
// ---------------------------------------------------------------------------

export interface MarkerServiceDeps {
  getPaths(): PlannerPaths;
  ids: IdGenerator;
  queue: WriteQueue;
  /** Сообщение об ошибке ввода-вывода (консоль). */
  log?(message: string, error?: unknown): void;
}

const UNKNOWN_STATE: MarkerState = { status: 'unknown', marker: null, issues: [] };

export class VaultMarkerService implements MarkerService {
  private state: MarkerState = UNKNOWN_STATE;
  private readonly listeners = new Set<(state: MarkerState) => void>();

  constructor(
    private readonly app: App,
    private readonly deps: MarkerServiceDeps,
  ) {}

  getState(): MarkerState {
    return this.state;
  }

  onChange(listener: (state: MarkerState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Перечитывает маркер без записи (например, после изменения другим устройством). */
  async refresh(): Promise<MarkerState> {
    return this.deps.queue.run(MARKER_PATH, async () => {
      const { state } = await this.readMarker();
      this.setState(state);
      return state;
    });
  }

  async ensure(): Promise<MarkerState> {
    return this.deps.queue.run(MARKER_PATH, async () => {
      const paths = this.deps.getPaths();
      let read = await this.readMarker();

      if (read.state.status === 'unknown' && !this.markerFileExists()) {
        await this.createMarker(paths.root);
        read = await this.readMarker();
      }

      // Только при поддерживаемой схеме: дополнить свойства и создать папки.
      if (read.state.status === 'ok' && read.raw) {
        const raw = read.raw;
        const needsRoot = raw['root'] !== paths.root;
        const needsVaultId = typeof raw['vault_id'] !== 'string' || raw['vault_id'].trim() === '';
        const needsMigrating = typeof raw['migrating'] !== 'boolean';
        if (needsRoot || needsVaultId || needsMigrating) {
          await this.patchMarker((fm) => {
            if (needsRoot) fm['root'] = paths.root;
            // Существующий vault_id никогда не перезаписывается.
            if (needsVaultId) fm['vault_id'] = this.deps.ids.next();
            if (needsMigrating) fm['migrating'] = false;
          });
          read = await this.readMarker();
        }
        if (read.state.status === 'ok') await this.ensureFolders(paths);
      }

      this.setState(read.state);
      return read.state;
    });
  }

  async setMigrating(migrating: boolean): Promise<void> {
    await this.deps.queue.run(MARKER_PATH, async () => {
      const read = await this.readMarker();
      const status = read.state.status;
      if (status === 'newer' || status === 'invalid' || status === 'unknown') {
        throw new Error(`Marker is not writable: ${status}`);
      }
      if (read.raw?.['migrating'] !== migrating) {
        await this.patchMarker((fm) => {
          fm['migrating'] = migrating;
        });
      }
      const next = await this.readMarker();
      this.setState(next.state);
    });
  }

  /**
   * Подписка на изменения маркера в хранилище (синхронизация, правка вручную).
   * Возвращает отписку; вызывающий регистрирует её в `plugin.register`.
   */
  watch(): Unsubscribe {
    const vault = this.app.vault;
    const onFile = (file: TAbstractFile, oldPath?: string): void => {
      if (file.path === MARKER_PATH || oldPath === MARKER_PATH) void this.refresh();
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

  // -------------------------------------------------------------------------

  private markerFileExists(): boolean {
    return this.app.vault.getAbstractFileByPath(MARKER_PATH) !== null;
  }

  private async readMarker(): Promise<{ state: MarkerState; raw: FrontmatterRecord | null }> {
    const vault = this.app.vault;
    const existing = vault.getAbstractFileByPath(MARKER_PATH);
    const file = vault.getFileByPath(MARKER_PATH);
    if (!file) {
      // Папка с именем маркера — повреждение; отсутствие файла — ещё не создан.
      return existing
        ? { state: { status: 'invalid', marker: null, issues: [{ property: 'schema', code: 'missing' }] }, raw: null }
        : { state: UNKNOWN_STATE, raw: null };
    }
    let text: string;
    try {
      text = await vault.read(file);
    } catch (error) {
      this.deps.log?.('Matrix planner: cannot read marker', error);
      return { state: { status: 'invalid', marker: null, issues: [{ property: 'schema', code: 'missing', value: describeError(error) }] }, raw: null };
    }
    const raw = parseFrontmatterText(text);
    return { state: evaluateMarker(raw), raw };
  }

  private async createMarker(root: string): Promise<void> {
    const frontmatter: FrontmatterRecord = {
      root,
      schema: SCHEMA_VERSION,
      vault_id: this.deps.ids.next(),
      migrating: false,
    };
    try {
      await this.app.vault.create(MARKER_PATH, buildNoteText(frontmatter, `${t('storage.marker.body')}\n`));
    } catch (error) {
      // Маркер мог появиться параллельно (синхронизация) — тогда просто читаем его.
      if (!this.markerFileExists()) this.deps.log?.('Matrix planner: cannot create marker', error);
    }
  }

  private async patchMarker(mutate: (frontmatter: FrontmatterRecord) => void): Promise<void> {
    const file = this.app.vault.getFileByPath(MARKER_PATH);
    if (!file) throw new Error('Marker not found');
    await this.app.fileManager.processFrontMatter(file, mutate);
  }

  private async ensureFolders(paths: PlannerPaths): Promise<void> {
    const required = [paths.root, paths.tasks, paths.events, paths.notes, paths.system];
    for (const folder of required) {
      let current = '';
      for (const segment of folder.split('/')) {
        current = joinPath(current, segment);
        const existing = this.app.vault.getAbstractFileByPath(current);
        if (existing instanceof TFolder) continue;
        if (existing) {
          this.deps.log?.(`Matrix planner: not a folder: ${current}`);
          break;
        }
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
            this.deps.log?.(`Matrix planner: cannot create folder ${current}`, error);
            break;
          }
        }
      }
    }
  }

  private setState(next: MarkerState): void {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener(next);
  }
}
