/**
 * Проверка целостности и список «Требуют внимания» (ТЗ §3.8, §4.6, §5.4.3).
 *
 * - Дубликат id: копии выдаётся новый id (если запись разрешена), обе версии остаются
 *   в списке, пока пользователь не выберет «Оставить эту версию».
 * - Конфликтные копии, невалидные заметки, события в «Удалённых», схема — только показываются.
 * - Ни одно действие сервиса не удаляет и не переносит заметки.
 */

import type {
  Clock,
  IdGenerator,
  IntegrityService,
  MarkerService,
  NoteIndex,
  NoteRepository,
  TombstoneWriter,
  WriteGuard,
} from '../app/contracts';
import type { AttentionItem, IntegrityReport, ItemId, OpResult, Unsubscribe, VaultPath } from '../model/types';
import { registerDictionary } from '../i18n';
import { ruIntegrity } from '../i18n/ru/integrity';
import { enIntegrity } from '../i18n/en/integrity';
import { describeError, errorResult, okResult } from '../storage/note-repository';
import { isUnder, MARKER_PATH } from '../storage/paths';
import {
  canKeepVersion,
  conflictItem,
  conflictKey,
  deletedInCalendarItem,
  detectConflictCopy,
  duplicateItem,
  findConflictCopies,
  findDuplicateIds,
  invalidItem,
  pendingDeletionItem,
  schemaItem,
  sortAttentionItems,
} from './checks';

registerDictionary('ru', 'integrity', ruIntegrity);
registerDictionary('en', 'integrity', enIntegrity);

// ---------------------------------------------------------------------------
// Состояние между проверками
// ---------------------------------------------------------------------------

/** Найденный дубликат, который ещё показывается (после выдачи нового id индекс его уже не видит). */
export interface DuplicateRecord {
  id: ItemId;
  /** Первый путь — исходная заметка. */
  paths: VaultPath[];
  /** Выданные копиям id: путь → id. */
  reassigned: Record<VaultPath, ItemId>;
}

export interface AttentionState {
  version: 1;
  duplicates: DuplicateRecord[];
  /** Ключи конфликтных копий, для которых выбрано «Оставить эту версию». */
  acknowledged: string[];
}

/** Хранение состояния (например, в data.json плагина). По умолчанию — только в памяти. */
export interface AttentionStateStore {
  load(): Promise<unknown>;
  save(state: AttentionState): Promise<void>;
}

export function emptyAttentionState(): AttentionState {
  return { version: 1, duplicates: [], acknowledged: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Разбор сохранённого состояния с отбрасыванием повреждённых записей. */
export function normalizeAttentionState(raw: unknown): AttentionState {
  const state = emptyAttentionState();
  if (!isRecord(raw)) return state;
  if (Array.isArray(raw['duplicates'])) {
    for (const entry of raw['duplicates']) {
      if (!isRecord(entry) || typeof entry['id'] !== 'string' || !Array.isArray(entry['paths'])) continue;
      const paths = entry['paths'].filter((p): p is string => typeof p === 'string');
      const reassigned: Record<VaultPath, ItemId> = {};
      if (isRecord(entry['reassigned'])) {
        for (const [path, id] of Object.entries(entry['reassigned'])) if (typeof id === 'string') reassigned[path] = id;
      }
      if (paths.length > 0) state.duplicates.push({ id: entry['id'], paths, reassigned });
    }
  }
  if (Array.isArray(raw['acknowledged'])) {
    state.acknowledged = raw['acknowledged'].filter((k): k is string => typeof k === 'string');
  }
  return state;
}

export class MemoryAttentionStateStore implements AttentionStateStore {
  private value: AttentionState | null = null;

  async load(): Promise<unknown> {
    return this.value ? JSON.parse(JSON.stringify(this.value)) : null;
  }

  async save(state: AttentionState): Promise<void> {
    this.value = JSON.parse(JSON.stringify(state)) as AttentionState;
  }
}

// ---------------------------------------------------------------------------
// Сервис
// ---------------------------------------------------------------------------

export interface IntegrityServiceDeps {
  index: Pick<NoteIndex, 'whenReady' | 'getTasks' | 'getEvents' | 'getNotes' | 'getInvalid'>;
  repository: Pick<NoteRepository, 'paths' | 'exists' | 'listFolder' | 'updateFrontmatter'>;
  /** Обычный запрет записи: при только чтении новые id не выдаются. */
  guard: WriteGuard;
  ids: IdGenerator;
  clock: Clock;
  marker?: Pick<MarkerService, 'getState'>;
  /** Метки удаления (этап 2). Без них проверка «удалено, но заметка осталась» не выполняется. */
  tombstones?: Pick<TombstoneWriter, 'list'>;
  state?: AttentionStateStore;
  log?(message: string, error?: unknown): void;
}

export class VaultIntegrityService implements IntegrityService {
  private report: IntegrityReport | null = null;
  private running: Promise<OpResult<IntegrityReport>> | null = null;
  private readonly listeners = new Set<(report: IntegrityReport | null) => void>();
  private readonly stateStore: AttentionStateStore;

  constructor(private readonly deps: IntegrityServiceDeps) {
    this.stateStore = deps.state ?? new MemoryAttentionStateStore();
  }

  getLastReport(): IntegrityReport | null {
    return this.report;
  }

  onChange(listener: (report: IntegrityReport | null) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Повторный вызов во время проверки возвращает ту же проверку. */
  check(): Promise<OpResult<IntegrityReport>> {
    if (!this.running) {
      this.running = this.runCheck().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  async keepVersion(item: AttentionItem, path: VaultPath): Promise<OpResult> {
    if (!canKeepVersion(item, path)) return errorResult('invalid', `keepVersion is not available for ${item.kind}: ${path}`);
    try {
      const state = await this.loadState();
      if (item.kind === 'duplicate-id') {
        state.duplicates = state.duplicates.filter((record) => record.id !== item.itemId);
      } else if (!state.acknowledged.includes(item.key)) {
        state.acknowledged.push(item.key);
      }
      await this.stateStore.save(state);
    } catch (error) {
      return errorResult('write-failed', describeError(error), error);
    }
    // Пометка снимается; файлы не трогаются.
    if (this.report) {
      this.setReport({ ...this.report, items: this.report.items.filter((existing) => existing.key !== item.key) });
    }
    return okResult(undefined, true);
  }

  // -------------------------------------------------------------------------

  private async runCheck(): Promise<OpResult<IntegrityReport>> {
    try {
      await this.deps.index.whenReady();
      const state = await this.loadState();
      const paths = this.deps.repository.paths;
      const { index } = this.deps;
      const items: AttentionItem[] = [];
      const reassignedIds: Record<VaultPath, ItemId> = {};

      // Файлы корня (без обоев) — для поиска конфликтных копий.
      const files = await this.listFiles(paths.root, paths.wallpapers);
      const fileSet = new Set(files);
      const exists = (path: VaultPath): boolean => fileSet.has(path) || this.deps.repository.exists(path);
      const copies = findConflictCopies(files);
      const copyPaths = new Set(copies.map((match) => match.path));

      // Дубликаты id.
      const planner = [...index.getTasks(), ...index.getEvents(), ...index.getNotes()];
      const groups = findDuplicateIds(planner, {
        isCopy: (path) => copyPaths.has(path) || detectConflictCopy(path, exists) !== null,
        isSecondary: (path) => isUnder(path, paths.deletedEvents),
      });
      const canWrite = this.deps.guard.canWrite();
      for (const group of groups) {
        const record = this.recordFor(state, group.id, group.keep);
        for (const copy of group.copies) {
          if (!record.paths.includes(copy)) record.paths.push(copy);
          if (!canWrite) continue;
          const newId = await this.reassign(copy, group.id);
          if (newId) {
            record.reassigned[copy] = newId;
            reassignedIds[copy] = newId;
          }
        }
      }

      // Показываем записанные дубликаты, пока живы хотя бы две версии.
      state.duplicates = state.duplicates.filter((record) => {
        record.paths = record.paths.filter(exists);
        return record.paths.length > 1;
      });
      const duplicatePaths = new Set<VaultPath>();
      for (const record of state.duplicates) {
        const [keep, ...rest] = record.paths as [VaultPath, ...VaultPath[]];
        const reassigned = rest.every((path) => record.reassigned[path] !== undefined);
        items.push(duplicateItem(record.id, keep, rest, reassigned));
        for (const path of record.paths) duplicatePaths.add(path);
      }

      // Конфликтные копии (если копия уже показана как дубликат — второй раз не показываем).
      const byPath = new Map(planner.map((item) => [item.path, item.id] as const));
      const liveCopyKeys = new Set<string>();
      for (const match of copies) {
        const key = conflictKey(match.path);
        liveCopyKeys.add(key);
        if (state.acknowledged.includes(key) || duplicatePaths.has(match.path)) continue;
        items.push(conflictItem(match, byPath.get(match.path) ?? null));
      }
      // Снятые пометки исчезнувших копий больше не нужны.
      state.acknowledged = state.acknowledged.filter((key) => liveCopyKeys.has(key));

      for (const note of index.getInvalid()) items.push(invalidItem(note));

      const events = index.getEvents();
      for (const event of events) if (event.deletedInCalendar) items.push(deletedInCalendarItem(event));

      if (this.deps.tombstones) {
        const listed = await this.deps.tombstones.list();
        if (listed.ok) {
          const ids = new Set(listed.value.map((record) => record.id));
          for (const event of events) if (ids.has(event.id) && exists(event.path)) items.push(pendingDeletionItem(event));
        }
      }

      if (this.deps.marker) {
        const item = schemaItem(this.deps.marker.getState(), MARKER_PATH);
        if (item) items.push(item);
      }

      await this.stateStore.save(state);
      const report: IntegrityReport = {
        checkedAt: this.deps.clock.now().toISOString(),
        items: sortAttentionItems(items),
        reassignedIds,
      };
      this.setReport(report);
      return okResult(report, Object.keys(reassignedIds).length > 0);
    } catch (error) {
      this.deps.log?.('Matrix planner: integrity check failed', error);
      return errorResult<IntegrityReport>('unknown', describeError(error), error);
    }
  }

  private recordFor(state: AttentionState, id: ItemId, keep: VaultPath): DuplicateRecord {
    let record = state.duplicates.find((existing) => existing.id === id);
    if (!record) {
      record = { id, paths: [keep], reassigned: {} };
      state.duplicates.push(record);
    } else if (!record.paths.includes(keep)) {
      record.paths.unshift(keep);
    }
    return record;
  }

  /**
   * Выдаёт копии новый id, только если в файле всё ещё старый id
   * (индекс может отставать от файла после предыдущей проверки).
   */
  private async reassign(path: VaultPath, oldId: ItemId): Promise<ItemId | null> {
    const newId = this.deps.ids.next();
    let applied = false;
    const result = await this.deps.repository.updateFrontmatter(path, (frontmatter) => {
      if (frontmatter['id'] !== oldId) return;
      frontmatter['id'] = newId;
      applied = true;
    });
    if (!result.ok) {
      this.deps.log?.(`Matrix planner: cannot assign a new id to ${path}`, result.error);
      return null;
    }
    return applied ? newId : null;
  }

  private async listFiles(root: VaultPath, excluded: VaultPath): Promise<VaultPath[]> {
    const out: VaultPath[] = [];
    const queue: VaultPath[] = [root];
    while (queue.length > 0) {
      const folder = queue.shift() as VaultPath;
      const listing = await this.deps.repository.listFolder(folder);
      if (!listing.ok) continue;
      out.push(...listing.value.files);
      for (const sub of listing.value.folders) if (!isUnder(sub, excluded)) queue.push(sub);
    }
    return out;
  }

  private async loadState(): Promise<AttentionState> {
    try {
      return normalizeAttentionState(await this.stateStore.load());
    } catch (error) {
      this.deps.log?.('Matrix planner: cannot load attention state', error);
      return emptyAttentionState();
    }
  }

  private setReport(report: IntegrityReport | null): void {
    this.report = report;
    for (const listener of [...this.listeners]) {
      try {
        listener(report);
      } catch (error) {
        this.deps.log?.('Matrix planner: integrity listener failed', error);
      }
    }
  }
}
