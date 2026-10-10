/**
 * Репозиторий заметок Планировщика поверх Vault API.
 *
 * - пути проходят `normalizePath()` и проверку «внутри корня»;
 * - свойства — `fileManager.processFrontMatter`, тело — `vault.process`,
 *   для активной заметки в редакторе — Editor API (несохранённый ввод не теряется);
 * - удаление — только `fileManager.trashFile`;
 * - пишущие методы проверяют `WriteGuard` и сериализуются очередью по пути.
 */

import { MarkdownView, stringifyYaml, TFile, TFolder, type App, type Editor } from 'obsidian';
import type {
  CreateNoteRequest,
  FolderListing,
  NoteRepository,
  WriteGuard,
  WriteQueue,
} from '../app/contracts';
import type { FrontmatterRecord, OpResult, PlannerErrorCode, PlannerPaths, VaultPath } from '../model/types';
import { registerDictionary, t } from '../i18n';
import { ruStorage } from '../i18n/ru/storage';
import { enStorage } from '../i18n/en/storage';
import {
  fileNameOf,
  joinPath,
  normalizeVaultPath,
  parentPath,
  resolveInsideRoot,
  sanitizeFileName,
  uniqueFilePath,
} from './paths';

registerDictionary('ru', 'storage', ruStorage);
registerDictionary('en', 'storage', enStorage);

// ---------------------------------------------------------------------------
// Результаты операций
// ---------------------------------------------------------------------------

const ERROR_MESSAGE_KEYS: Record<PlannerErrorCode, string> = {
  'not-found': 'common.errors.notFound',
  'read-only': 'common.errors.readOnly',
  stale: 'common.errors.stale',
  invalid: 'common.errors.invalid',
  'outside-root': 'common.errors.outsideRoot',
  'write-failed': 'common.errors.writeFailed',
  'trash-failed': 'common.errors.trashFailed',
  'tombstone-failed': 'common.errors.tombstoneFailed',
  'not-ready': 'common.errors.notReady',
  unsupported: 'common.errors.unsupported',
  unknown: 'common.errors.unknown',
};

export function okResult<T>(value: T, changed = true): OpResult<T> {
  return { ok: true, value, changed };
}

export function errorResult<T = void>(code: PlannerErrorCode, detail?: string, cause?: unknown, messageKey?: string): OpResult<T> {
  const error: { code: PlannerErrorCode; messageKey: string; detail?: string; cause?: unknown } = {
    code,
    messageKey: messageKey ?? ERROR_MESSAGE_KEYS[code],
  };
  if (detail !== undefined) error.detail = detail;
  if (cause !== undefined) error.cause = cause;
  return { ok: false, error };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Frontmatter в тексте заметки
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export interface FrontmatterSplit {
  /** YAML между разделителями; `null` — блока свойств нет. */
  yaml: string | null;
  /** Длина блока свойств вместе с разделителями (смещение начала тела). */
  end: number;
}

/** Находит блок свойств в начале текста. */
export function splitFrontmatterText(text: string): FrontmatterSplit {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { yaml: null, end: 0 };
  return { yaml: match[1] ?? '', end: match[0].length };
}

/** Тело заметки без блока свойств. */
export function bodyOf(text: string): string {
  return text.slice(splitFrontmatterText(text).end);
}

/** Текст новой заметки: свойства + тело. Пустые свойства — без блока. */
export function buildNoteText(frontmatter: FrontmatterRecord, body: string): string {
  if (Object.keys(frontmatter).length === 0) return body;
  const yaml = stringifyYaml(frontmatter);
  return `---\n${yaml}${yaml.endsWith('\n') ? '' : '\n'}---\n${body}`;
}

/** Смещение в тексте → позиция редактора. */
export function offsetToPosition(text: string, offset: number): { line: number; ch: number } {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length - 1, ch: (lines[lines.length - 1] ?? '').length };
}

// ---------------------------------------------------------------------------
// Репозиторий
// ---------------------------------------------------------------------------

export interface NoteRepositoryDeps {
  /** Пути при текущем корне (корень меняется в настройках). */
  getPaths(): PlannerPaths;
  guard: WriteGuard;
  queue: WriteQueue;
  /** Название по умолчанию для пустого ввода. */
  untitled?(): string;
}

const MAX_CREATE_ATTEMPTS = 5;

export class ObsidianNoteRepository implements NoteRepository {
  constructor(
    private readonly app: App,
    private readonly deps: NoteRepositoryDeps,
  ) {}

  get paths(): PlannerPaths {
    return this.deps.getPaths();
  }

  exists(path: VaultPath): boolean {
    const resolved = this.resolve(path);
    return resolved !== null && this.app.vault.getAbstractFileByPath(resolved) !== null;
  }

  async create(request: CreateNoteRequest): Promise<OpResult<VaultPath>> {
    const blocked = this.checkGuard<VaultPath>();
    if (blocked) return blocked;
    const folder = this.resolve(request.folder);
    if (folder === null) return errorResult('outside-root', request.folder);
    const folderResult = await this.createFolders(folder);
    if (!folderResult.ok) return folderResult;

    const base = sanitizeFileName(request.title, this.untitled());
    const text = buildNoteText(request.frontmatter, request.body);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const target = uniqueFilePath(folder, base, '.md', (candidate) => this.isTaken(candidate));
      let failed = false;
      const result = await this.runGuarded<VaultPath>(target, [], async () => {
        try {
          const file = await this.app.vault.create(target, text);
          return okResult(file.path);
        } catch (error) {
          lastError = error;
          failed = true;
          return errorResult<VaultPath>('write-failed', describeError(error), error);
        }
      });
      if (!failed) return result;
      // Гонка: файл появился между проверкой и созданием — берём следующий суффикс.
      if (!this.isTaken(target)) break;
    }
    return errorResult('write-failed', describeError(lastError), lastError);
  }

  async updateFrontmatter(path: VaultPath, mutate: (frontmatter: FrontmatterRecord) => void): Promise<OpResult> {
    const target = this.fileFor(path);
    if (!target.ok) return target;
    const file = target.value;
    return this.runGuarded(file.path, [], async () => {
      let changed = false;
      try {
        await this.app.fileManager.processFrontMatter(file, (frontmatter: FrontmatterRecord) => {
          const before = safeJson(frontmatter);
          mutate(frontmatter);
          const after = safeJson(frontmatter);
          changed = before === null || after === null || after !== before;
        });
      } catch (error) {
        return errorResult('write-failed', describeError(error), error);
      }
      return okResult(undefined, changed);
    });
  }

  async readBody(path: VaultPath): Promise<OpResult<string>> {
    const resolved = this.resolve(path);
    if (resolved === null) return errorResult('outside-root', path);
    const file = this.app.vault.getFileByPath(resolved);
    if (!file) return errorResult('not-found', resolved);
    const editor = this.activeEditorFor(file);
    if (editor) return okResult(bodyOf(editor.getValue()), false);
    try {
      return okResult(bodyOf(await this.app.vault.read(file)), false);
    } catch (error) {
      return errorResult('unknown', describeError(error), error);
    }
  }

  async updateBody(path: VaultPath, transform: (body: string) => string): Promise<OpResult> {
    const target = this.fileFor(path);
    if (!target.ok) return target;
    const file = target.value;
    return this.runGuarded(file.path, [], async () => {
      try {
        const editor = this.activeEditorFor(file);
        if (editor) {
          // Активная заметка: правим через редактор, чтобы не затереть несохранённый ввод.
          const text = editor.getValue();
          const start = splitFrontmatterText(text).end;
          const body = text.slice(start);
          const next = transform(body);
          if (next === body) return okResult(undefined, false);
          editor.replaceRange(next, offsetToPosition(text, start), offsetToPosition(text, text.length));
          return okResult(undefined, true);
        }
        let changed = false;
        await this.app.vault.process(file, (text) => {
          const start = splitFrontmatterText(text).end;
          const body = text.slice(start);
          const next = transform(body);
          changed = next !== body;
          return changed ? text.slice(0, start) + next : text;
        });
        return okResult(undefined, changed);
      } catch (error) {
        return errorResult('write-failed', describeError(error), error);
      }
    });
  }

  async rename(path: VaultPath, newTitle: string): Promise<OpResult<VaultPath>> {
    const target = this.fileFor(path);
    if (!target.ok) return target;
    const file = target.value;
    const folder = parentPath(file.path);
    const base = sanitizeFileName(newTitle, this.untitled());
    if (`${base}.${file.extension}` === file.name) return okResult(file.path, false);
    const ext = file.extension ? `.${file.extension}` : '';
    const destination = uniqueFilePath(folder, base, ext, (candidate) => this.isTaken(candidate, file.path));
    return this.renameTo(file, destination);
  }

  async move(path: VaultPath, folder: VaultPath): Promise<OpResult<VaultPath>> {
    const target = this.fileFor(path);
    if (!target.ok) return target;
    const file = target.value;
    const destinationFolder = this.resolve(folder);
    if (destinationFolder === null) return errorResult('outside-root', folder);
    if (parentPath(file.path) === destinationFolder) return okResult(file.path, false);
    const folderResult = await this.createFolders(destinationFolder);
    if (!folderResult.ok) return folderResult;
    const ext = file.extension ? `.${file.extension}` : '';
    const destination = uniqueFilePath(destinationFolder, file.basename, ext, (candidate) => this.isTaken(candidate, file.path));
    return this.renameTo(file, destination);
  }

  async trash(path: VaultPath): Promise<OpResult> {
    const blocked = this.checkGuard();
    if (blocked) return blocked;
    const resolved = this.resolve(path);
    if (resolved === null) return errorResult('outside-root', path);
    const file = this.app.vault.getAbstractFileByPath(resolved);
    if (!file) return errorResult('not-found', resolved);
    return this.runGuarded(resolved, [], async () => {
      try {
        await this.app.fileManager.trashFile(file);
        return okResult(undefined, true);
      } catch (error) {
        return errorResult('trash-failed', describeError(error), error);
      }
    });
  }

  async ensureFolder(path: VaultPath): Promise<OpResult> {
    const blocked = this.checkGuard();
    if (blocked) return blocked;
    const resolved = this.resolve(path);
    if (resolved === null) return errorResult('outside-root', path);
    return this.createFolders(resolved);
  }

  async listFolder(path: VaultPath): Promise<OpResult<FolderListing>> {
    const resolved = this.resolve(path);
    if (resolved === null) return errorResult('outside-root', path);
    const folder = this.app.vault.getFolderByPath(resolved);
    if (!folder) return errorResult('not-found', resolved);
    const files: VaultPath[] = [];
    const folders: VaultPath[] = [];
    for (const child of folder.children) {
      if (child instanceof TFolder) folders.push(child.path);
      else if (child instanceof TFile) files.push(child.path);
    }
    files.sort();
    folders.sort();
    return okResult({ files, folders }, false);
  }

  async readBinary(path: VaultPath): Promise<OpResult<ArrayBuffer>> {
    const resolved = this.resolve(path);
    if (resolved === null) return errorResult('outside-root', path);
    const file = this.app.vault.getFileByPath(resolved);
    if (!file) return errorResult('not-found', resolved);
    try {
      return okResult(await this.app.vault.readBinary(file), false);
    } catch (error) {
      return errorResult('unknown', describeError(error), error);
    }
  }

  async writeBinary(path: VaultPath, data: ArrayBuffer): Promise<OpResult> {
    const blocked = this.checkGuard();
    if (blocked) return blocked;
    const resolved = this.resolve(path);
    if (resolved === null) return errorResult('outside-root', path);
    const folderResult = await this.createFolders(parentPath(resolved));
    if (!folderResult.ok) return folderResult;
    return this.runGuarded(resolved, [], async () => {
      try {
        const existing = this.app.vault.getAbstractFileByPath(resolved);
        if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data);
        else if (existing) return errorResult<void>('write-failed', `not a file: ${resolved}`);
        else await this.app.vault.createBinary(resolved, data);
        return okResult(undefined, true);
      } catch (error) {
        return errorResult<void>('write-failed', describeError(error), error);
      }
    });
  }

  // -------------------------------------------------------------------------

  private untitled(): string {
    return this.deps.untitled?.() ?? t('storage.untitled');
  }

  private resolve(path: VaultPath): VaultPath | null {
    return resolveInsideRoot(path, this.paths.root);
  }

  private checkGuard<T = void>(): OpResult<T> | null {
    const blocked = this.deps.guard.check();
    return blocked ? errorResult<T>('read-only', undefined, undefined, blocked.messageKey) : null;
  }

  /**
   * Задание очереди с повторной проверкой запрета и корня перед изменением:
   * пока задание ждало, схема могла стать `newer`/`migrating`, а корень — смениться.
   */
  private runGuarded<T>(key: VaultPath, extraPaths: VaultPath[], job: () => Promise<OpResult<T>>): Promise<OpResult<T>> {
    return this.deps.queue.run(key, async () => {
      const blocked = this.checkGuard<T>();
      if (blocked) return blocked;
      for (const path of [key, ...extraPaths]) {
        if (this.resolve(path) === null) return errorResult<T>('outside-root', path);
      }
      return job();
    });
  }

  /** Проверки пишущей операции над существующим файлом. */
  private fileFor(path: VaultPath): OpResult<TFile> {
    const blocked = this.checkGuard<TFile>();
    if (blocked) return blocked;
    const resolved = this.resolve(path);
    if (resolved === null) return errorResult('outside-root', path);
    const file = this.app.vault.getFileByPath(resolved);
    if (!file) return errorResult('not-found', resolved);
    return okResult(file, false);
  }

  /** Имя занято: точное совпадение или совпадение без учёта регистра в той же папке. */
  private isTaken(candidate: VaultPath, ignorePath?: VaultPath): boolean {
    if (ignorePath !== undefined && candidate === ignorePath) return false;
    if (this.app.vault.getAbstractFileByPath(candidate)) return true;
    const folder = this.app.vault.getFolderByPath(parentPath(candidate) || '/');
    if (!folder) return false;
    const lower = fileNameOf(candidate).toLowerCase();
    return folder.children.some((child) => child.path !== ignorePath && child.name.toLowerCase() === lower);
  }

  private async renameTo(file: TFile, destination: VaultPath): Promise<OpResult<VaultPath>> {
    const from = file.path;
    return this.runGuarded(from, [destination], async () => {
      try {
        await this.app.fileManager.renameFile(file, destination);
        return okResult(file.path === from ? destination : file.path, true);
      } catch (error) {
        return errorResult<VaultPath>('write-failed', describeError(error), error);
      }
    });
  }

  /** Создаёт папку и недостающих родителей (без проверки guard и корня). */
  private async createFolders(path: VaultPath): Promise<OpResult> {
    const normalized = normalizeVaultPath(path);
    if (normalized === '') return okResult(undefined, false);
    let current = '';
    let created = false;
    for (const segment of normalized.split('/')) {
      current = joinPath(current, segment);
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) return errorResult('write-failed', `not a folder: ${current}`);
      try {
        await this.app.vault.createFolder(current);
        created = true;
      } catch (error) {
        // Папку могли создать параллельно.
        if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
          return errorResult('write-failed', describeError(error), error);
        }
      }
    }
    return okResult(undefined, created);
  }

  /** Редактор активной заметки, если открыт именно этот файл. */
  private activeEditorFor(file: TFile): Editor | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view && view.file && view.file.path === file.path ? view.editor : null;
  }
}

/** JSON-снимок для сравнения; несериализуемое значение — `null` (считается изменённым). */
function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
