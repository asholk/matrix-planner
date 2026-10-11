/**
 * Инкрементальный индекс заметок Планировщика внутри корня (ТЗ §3.7).
 *
 * Источник данных — `metadataCache`: событие `changed` (создание и изменение),
 * `vault.rename`/`vault.delete` (переименование `changed` не порождает).
 * После записи индекс не считается обновлённым до `changed` — для этого `waitFor`.
 * Разбор свойств внедряется через `PlannerNoteParser`.
 */

import { TFile, TFolder, type App, type CachedMetadata, type EventRef, type TAbstractFile } from 'obsidian';
import type { IndexChange, NoteIndex, PlannerNoteParser } from '../app/contracts';
import type {
  FrontmatterRecord,
  InvalidPlannerNote,
  ItemId,
  MatrixConfig,
  ParsedNote,
  PlannerEvent,
  PlannerItem,
  PlannerPaths,
  QuickNote,
  Task,
  Unsubscribe,
  VaultPath,
} from '../model/types';
import { canonicalId } from '../model/ids';
import { checklistFromListItems, type ChecklistProgress } from '../model/checklist';
import { isUnder, titleFromPath } from './paths';

/** Таймеры (в тестах можно подменить). */
export interface IndexTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: IndexTimers = {
  set: (callback, ms) => window.setTimeout(callback, ms),
  clear: (handle) => window.clearTimeout(handle as number),
};

export interface NoteIndexDeps {
  parser: PlannerNoteParser;
  getPaths(): PlannerPaths;
  timers?: IndexTimers;
  /**
   * Интервал повторной проверки, если `metadataCache.resolved` не пришёл: индекс
   * становится готовым, только когда у всех markdown-файлов под корнем есть кэш.
   */
  resolveFallbackMs?: number;
  /** Таймаут `waitFor` по умолчанию. */
  waitTimeoutMs?: number;
  log?(message: string, error?: unknown): void;
}

interface Entry {
  note: ParsedNote;
  /** Исходные свойства — для повторного разбора при переименовании. */
  frontmatter: FrontmatterRecord | null;
  /** Снимок для отсечения пустых обновлений. */
  signature: string;
  /** Прогресс чек-листа из `listItems` (для повторного разбора при переименовании). */
  checklist: ChecklistProgress | null;
}

interface Waiter {
  predicate: (item: ParsedNote) => boolean;
  resolve: (item: ParsedNote | null) => void;
  timer: unknown;
}

function isPlannerItem(note: ParsedNote): note is PlannerItem {
  return note.kind !== 'invalid';
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class MetadataNoteIndex implements NoteIndex {
  private readonly entries = new Map<VaultPath, Entry>();
  private readonly idToPaths = new Map<ItemId, Set<VaultPath>>();
  private readonly listeners = new Set<(change: IndexChange) => void>();
  private readonly waiters = new Map<VaultPath, Set<Waiter>>();
  private readonly refs: Array<{ source: 'vault' | 'metadata'; ref: EventRef }> = [];
  private readonly timers: IndexTimers;

  private matrix: MatrixConfig | null = null;
  private matrixFrontmatter: FrontmatterRecord | null = null;
  private matrixPresent = false;

  private lists: { tasks: Task[]; events: PlannerEvent[]; notes: QuickNote[]; invalid: InvalidPlannerNote[] } | null = null;

  private ready = false;
  private started = false;
  private readyResolve: (() => void) | null = null;
  private readonly readyPromise: Promise<void>;
  private fallbackTimer: unknown = null;

  constructor(
    private readonly app: App,
    private readonly deps: NoteIndexDeps,
  ) {
    this.timers = deps.timers ?? defaultTimers;
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  // -------------------------------------------------------------------------
  // Жизненный цикл
  // -------------------------------------------------------------------------

  /** Подписывается на события и строит индекс после готовности раскладки. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const { vault, metadataCache, workspace } = this.app;
    this.refs.push(
      { source: 'metadata', ref: metadataCache.on('changed', (file, _data, cache) => this.onChanged(file, cache)) },
      { source: 'metadata', ref: metadataCache.on('resolved', () => this.onResolved()) },
      { source: 'vault', ref: vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)) },
      { source: 'vault', ref: vault.on('delete', (file) => this.onDelete(file)) },
    );
    workspace.onLayoutReady(() => {
      if (!this.started) return;
      this.buildAll();
      if (this.isCacheResolved()) this.markReady();
      else this.scheduleReadyCheck();
    });
  }

  /**
   * Таймаут не объявляет готовность: он только перепроверяет кэш. Готовность — после
   * `resolved` или когда у всех markdown-файлов под корнем уже есть кэш метаданных.
   */
  private scheduleReadyCheck(): void {
    this.fallbackTimer = this.timers.set(() => {
      this.fallbackTimer = null;
      if (this.ready || !this.started) return;
      const pending = this.uncachedFiles();
      if (pending === 0 || this.isCacheResolved()) {
        this.buildAll();
        this.markReady();
        return;
      }
      this.deps.log?.(`Matrix planner: metadata cache is not resolved yet, ${pending} notes without cache`);
      this.scheduleReadyCheck();
    }, this.deps.resolveFallbackMs ?? 5000);
  }

  /** Число markdown-файлов под корнем без кэша метаданных. */
  private uncachedFiles(): number {
    const root = this.app.vault.getFolderByPath(this.deps.getPaths().root);
    if (!root) return 0;
    const files: TFile[] = [];
    this.collectFiles(root, files);
    let count = 0;
    for (const file of files) {
      if (file.extension === 'md' && !this.app.metadataCache.getFileCache(file)) count += 1;
    }
    return count;
  }

  /** Отписка от событий и отмена ожиданий. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const { source, ref } of this.refs.splice(0)) {
      if (source === 'vault') this.app.vault.offref(ref);
      else this.app.metadataCache.offref(ref);
    }
    if (this.fallbackTimer !== null) this.timers.clear(this.fallbackTimer);
    this.fallbackTimer = null;
    for (const [path, set] of this.waiters) {
      for (const waiter of set) {
        this.timers.clear(waiter.timer);
        waiter.resolve(this.entries.get(path)?.note ?? null);
      }
    }
    this.waiters.clear();
  }

  isReady(): boolean {
    return this.ready;
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  async rebuild(): Promise<void> {
    this.buildAll();
  }

  // -------------------------------------------------------------------------
  // Чтение
  // -------------------------------------------------------------------------

  getTasks(): readonly Task[] {
    return this.getLists().tasks;
  }

  getEvents(): readonly PlannerEvent[] {
    return this.getLists().events;
  }

  getNotes(): readonly QuickNote[] {
    return this.getLists().notes;
  }

  getInvalid(): readonly InvalidPlannerNote[] {
    return this.getLists().invalid;
  }

  getMatrix(): MatrixConfig {
    if (!this.matrix) {
      this.matrix = this.matrixPresent
        ? this.deps.parser.parseMatrix(this.deps.getPaths().matrix, this.matrixFrontmatter)
        : this.deps.parser.parseMatrix(null, null);
    }
    return this.matrix;
  }

  getById(id: ItemId): PlannerItem | undefined {
    return this.getAllById(id)[0];
  }

  getAllById(id: ItemId): readonly PlannerItem[] {
    const paths = this.idToPaths.get(canonicalId(id));
    if (!paths) return [];
    const result: PlannerItem[] = [];
    for (const path of [...paths].sort(comparePaths)) {
      const note = this.entries.get(path)?.note;
      if (note && isPlannerItem(note)) result.push(note);
    }
    return result;
  }

  getByPath(path: VaultPath): PlannerItem | InvalidPlannerNote | undefined {
    return this.entries.get(path)?.note;
  }

  onChange(listener: (change: IndexChange) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(path: VaultPath, predicate: (item: ParsedNote) => boolean = () => true, timeoutMs?: number): Promise<ParsedNote | null> {
    const current = this.entries.get(path)?.note;
    if (current && this.safePredicate(predicate, current)) return Promise.resolve(current);
    return new Promise((resolve) => {
      const waiter: Waiter = { predicate, resolve, timer: null };
      waiter.timer = this.timers.set(() => {
        this.removeWaiter(path, waiter);
        resolve(this.entries.get(path)?.note ?? null);
      }, timeoutMs ?? this.deps.waitTimeoutMs ?? 3000);
      let set = this.waiters.get(path);
      if (!set) {
        set = new Set();
        this.waiters.set(path, set);
      }
      set.add(waiter);
    });
  }

  // -------------------------------------------------------------------------
  // Обработчики событий
  // -------------------------------------------------------------------------

  private onChanged(file: TFile, cache: CachedMetadata | null): void {
    if (!this.inScope(file.path)) return;
    const frontmatter = cache?.frontmatter ?? null;
    this.applyFile(file, frontmatter, true, checklistFromListItems(cache?.listItems));
  }

  private onResolved(): void {
    if (this.ready || !this.started) return;
    if (this.fallbackTimer !== null) {
      this.timers.clear(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.buildAll();
    this.markReady();
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    if (file instanceof TFile) {
      const previous = this.entries.get(oldPath);
      const wasMatrix = oldPath === this.deps.getPaths().matrix;
      const oldFrontmatter = previous?.frontmatter ?? (wasMatrix ? this.matrixFrontmatter : null);
      const oldChecklist = previous?.checklist ?? null;
      if (previous) this.removePath(oldPath, true);
      if (wasMatrix) this.setMatrix(false, null, true);
      if (this.inScope(file.path)) {
        // Кэш может переехать на новый путь позже события — берём старые свойства и перепроверяем.
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter ?? oldFrontmatter;
        this.applyFile(file, frontmatter, true, cache ? checklistFromListItems(cache.listItems) : oldChecklist);
        queueMicrotask(() => this.recheck(file));
      }
      return;
    }
    if (file instanceof TFolder) {
      const prefix = `${oldPath}/`;
      const saved = new Map<string, { frontmatter: FrontmatterRecord | null; checklist: ChecklistProgress | null }>();
      const removed: VaultPath[] = [];
      for (const [path, entry] of [...this.entries]) {
        if (!path.startsWith(prefix)) continue;
        saved.set(`${file.path}/${path.slice(prefix.length)}`, { frontmatter: entry.frontmatter, checklist: entry.checklist });
        removed.push(path);
      }
      const removedIds = removed.map((p) => this.entries.get(p)?.note).filter((n): n is PlannerItem => !!n && isPlannerItem(n)).map((n) => n.id);
      for (const path of removed) this.removePath(path, false);
      if (removed.length) this.emit({ kind: 'remove', paths: removed, ids: removedIds });
      const matrixPath = this.deps.getPaths().matrix;
      if (this.matrixPresent && matrixPath.startsWith(prefix)) this.setMatrix(false, null, true);
      if (isUnder(file.path, this.deps.getPaths().root) || isUnder(this.deps.getPaths().root, file.path)) {
        const files: TFile[] = [];
        this.collectFiles(file, files);
        for (const child of files) {
          if (!this.inScope(child.path)) continue;
          const cache = this.app.metadataCache.getFileCache(child);
          const old = saved.get(child.path);
          const frontmatter = cache?.frontmatter ?? old?.frontmatter ?? null;
          this.applyFile(child, frontmatter, true, cache ? checklistFromListItems(cache.listItems) : (old?.checklist ?? null));
          queueMicrotask(() => this.recheck(child));
        }
      }
    }
  }

  private onDelete(file: TAbstractFile): void {
    const matrixPath = this.deps.getPaths().matrix;
    if (file instanceof TFolder) {
      const prefix = `${file.path}/`;
      const removed = [...this.entries.keys()].filter((p) => p.startsWith(prefix));
      const ids = removed.map((p) => this.entries.get(p)?.note).filter((n): n is PlannerItem => !!n && isPlannerItem(n)).map((n) => n.id);
      for (const path of removed) this.removePath(path, false);
      if (removed.length) this.emit({ kind: 'remove', paths: removed, ids });
      if (this.matrixPresent && matrixPath.startsWith(prefix)) this.setMatrix(false, null, true);
      return;
    }
    if (file.path === matrixPath) {
      this.setMatrix(false, null, true);
      return;
    }
    if (this.entries.has(file.path)) this.removePath(file.path, true);
  }

  // -------------------------------------------------------------------------
  // Внутреннее
  // -------------------------------------------------------------------------

  private inScope(path: VaultPath): boolean {
    const paths = this.deps.getPaths();
    if (!path.toLowerCase().endsWith('.md')) return false;
    if (path === paths.marker) return false;
    return isUnder(path, paths.root) && path !== paths.root;
  }

  private isCacheResolved(): boolean {
    // Публичного флага нет: внутреннее поле проверяется осторожно, иначе ждём `resolved` или таймаут.
    const flag = (this.app.metadataCache as unknown as { resolved?: unknown }).resolved;
    return flag === true;
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.readyResolve?.();
    this.readyResolve = null;
  }

  private buildAll(): void {
    this.entries.clear();
    this.idToPaths.clear();
    this.lists = null;
    this.matrix = null;
    this.matrixPresent = false;
    this.matrixFrontmatter = null;
    const root = this.app.vault.getFolderByPath(this.deps.getPaths().root);
    if (root) {
      const files: TFile[] = [];
      this.collectFiles(root, files);
      for (const file of files) {
        if (!this.inScope(file.path)) continue;
        const cache = this.app.metadataCache.getFileCache(file);
        this.applyFile(file, cache?.frontmatter ?? null, false, checklistFromListItems(cache?.listItems));
      }
    }
    this.emit({ kind: 'reset', paths: [...this.entries.keys()].sort(comparePaths), ids: [...this.idToPaths.keys()] });
    for (const path of [...this.waiters.keys()]) this.resolveWaiters(path);
  }

  private collectFiles(folder: TFolder, out: TFile[]): void {
    for (const child of folder.children) {
      if (child instanceof TFile) out.push(child);
      else if (child instanceof TFolder) this.collectFiles(child, out);
    }
  }

  /** Повторный разбор после переименования, когда кэш уже переехал. */
  private recheck(file: TFile): void {
    if (!this.started || this.app.vault.getFileByPath(file.path) !== file || !this.inScope(file.path)) return;
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (frontmatter) this.applyFile(file, frontmatter, true, checklistFromListItems(cache.listItems));
  }

  /** Разбирает файл и обновляет индекс. `emit` — сообщать подписчикам; `checklist` — из `listItems`. */
  private applyFile(file: TFile, frontmatter: FrontmatterRecord | null, emit: boolean, checklist: ChecklistProgress | null): void {
    const paths = this.deps.getPaths();
    if (file.path === paths.matrix) {
      this.setMatrix(true, frontmatter, emit);
      return;
    }
    let note: ParsedNote | null = null;
    try {
      note = this.deps.parser.parse({
        path: file.path,
        title: titleFromPath(file.path),
        mtime: file.stat.mtime,
        frontmatter,
        archived: isUnder(file.path, paths.archiveRoot),
        deletedInCalendar: isUnder(file.path, paths.deletedEvents),
      });
    } catch (error) {
      this.deps.log?.(`Matrix planner: cannot parse ${file.path}`, error);
      note = null;
    }

    // Прогресс чек-листа — только у задач (тело не читается, берётся из кэша метаданных).
    if (note && note.kind === 'task') note = { ...note, checklist };

    const previous = this.entries.get(file.path);
    if (!note) {
      if (previous) this.removePath(file.path, emit);
      return;
    }
    const signature = `${file.stat.mtime}|${file.path}|${safeStringify(frontmatter)}|${checklist ? `${checklist.done}/${checklist.total}` : ''}`;
    if (previous && previous.signature === signature) {
      this.resolveWaiters(file.path);
      return;
    }
    const previousId = previous && isPlannerItem(previous.note) ? previous.note.id : null;
    if (previousId !== null) this.unlinkId(previousId, file.path);
    this.entries.set(file.path, { note, frontmatter, signature, checklist });
    if (isPlannerItem(note)) this.linkId(note.id, file.path);
    this.lists = null;
    if (emit) {
      const ids = [...new Set([previousId, isPlannerItem(note) ? note.id : null].filter((id): id is string => id !== null))];
      this.emit({ kind: 'upsert', paths: [file.path], ids });
    }
    this.resolveWaiters(file.path);
  }

  private removePath(path: VaultPath, emit: boolean): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    const id = isPlannerItem(entry.note) ? entry.note.id : null;
    if (id !== null) this.unlinkId(id, path);
    this.lists = null;
    if (emit) this.emit({ kind: 'remove', paths: [path], ids: id !== null ? [id] : [] });
  }

  private setMatrix(present: boolean, frontmatter: FrontmatterRecord | null, emit: boolean): void {
    this.matrixPresent = present;
    this.matrixFrontmatter = present ? frontmatter : null;
    this.matrix = null;
    if (emit) this.emit({ kind: 'matrix', paths: [this.deps.getPaths().matrix], ids: [] });
  }

  private linkId(id: ItemId, path: VaultPath): void {
    let set = this.idToPaths.get(id);
    if (!set) {
      set = new Set();
      this.idToPaths.set(id, set);
    }
    set.add(path);
  }

  private unlinkId(id: ItemId, path: VaultPath): void {
    const set = this.idToPaths.get(id);
    if (!set) return;
    set.delete(path);
    if (set.size === 0) this.idToPaths.delete(id);
  }

  private getLists(): NonNullable<MetadataNoteIndex['lists']> {
    if (this.lists) return this.lists;
    const lists: NonNullable<MetadataNoteIndex['lists']> = { tasks: [], events: [], notes: [], invalid: [] };
    for (const path of [...this.entries.keys()].sort(comparePaths)) {
      const note = (this.entries.get(path) as Entry).note;
      switch (note.kind) {
        case 'task':
          lists.tasks.push(note);
          break;
        case 'event':
          lists.events.push(note);
          break;
        case 'note':
          lists.notes.push(note);
          break;
        case 'invalid':
          lists.invalid.push(note);
          break;
      }
    }
    this.lists = lists;
    return lists;
  }

  private emit(change: IndexChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.deps.log?.('Matrix planner: index listener failed', error);
      }
    }
  }

  private safePredicate(predicate: (item: ParsedNote) => boolean, item: ParsedNote): boolean {
    try {
      return predicate(item);
    } catch {
      return false;
    }
  }

  private resolveWaiters(path: VaultPath): void {
    const set = this.waiters.get(path);
    const note = this.entries.get(path)?.note;
    if (!set || !note) return;
    for (const waiter of [...set]) {
      if (!this.safePredicate(waiter.predicate, note)) continue;
      this.timers.clear(waiter.timer);
      this.removeWaiter(path, waiter);
      waiter.resolve(note);
    }
  }

  private removeWaiter(path: VaultPath, waiter: Waiter): void {
    const set = this.waiters.get(path);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) this.waiters.delete(path);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return `unserializable:${Date.now()}`;
  }
}
