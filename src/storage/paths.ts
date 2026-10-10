/**
 * Пути Планировщика: нормализация, ограничение корнем, имена файлов.
 *
 * Только строковая логика; из `obsidian` берётся лишь `normalizePath`.
 */

import { normalizePath } from 'obsidian';
import {
  DEFAULT_ROOT_FOLDER,
  MARKER_FILE_NAME,
  PLANNER_LAYOUT,
  type PlannerPaths,
  type SystemJsonName,
  type VaultPath,
} from '../model/types';

/** Максимальная длина названия файла без расширения и суффикса ` (N)`. */
export const MAX_FILE_TITLE_LENGTH = 120;

/** Символы, недопустимые в именах файлов Obsidian/ОС или ломающие ссылки. */
const FORBIDDEN_CHARS_RE = /[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export type RootFolderError = 'empty' | 'hidden' | 'parent' | 'invalid-chars';

export type RootFolderResult = { ok: true; root: VaultPath } | { ok: false; reason: RootFolderError };

/** Нормализует путь хранилища: `normalizePath`, без ведущего/замыкающего `/`. `''` — корень хранилища. */
export function normalizeVaultPath(path: string): VaultPath {
  const normalized = normalizePath(path ?? '');
  return normalized === '/' ? '' : normalized.replace(/^\/+|\/+$/g, '');
}

function segmentsOf(path: VaultPath): string[] {
  return path === '' ? [] : path.split('/');
}

/** Проверяет путь корневой папки из настроек. Пустой путь (корень хранилища) недопустим. */
export function validateRootFolder(input: string): RootFolderResult {
  const root = normalizeVaultPath(input.trim());
  if (root === '') return { ok: false, reason: 'empty' };
  const segments = segmentsOf(root);
  if (segments.some((s) => s === '..' || s === '.')) return { ok: false, reason: 'parent' };
  // Скрытые папки не синхронизирует Obsidian Sync (ТЗ §3.1).
  if (segments.some((s) => s.startsWith('.'))) return { ok: false, reason: 'hidden' };
  if (segments.some((s) => new RegExp(FORBIDDEN_CHARS_RE.source).test(s) || s.trim() !== s || s === '')) {
    return { ok: false, reason: 'invalid-chars' };
  }
  return { ok: true, root };
}

/** Корень из настроек или значение по умолчанию, если настройка некорректна. */
export function resolveRootFolder(input: string | null | undefined): VaultPath {
  const result = validateRootFolder(input ?? '');
  return result.ok ? result.root : DEFAULT_ROOT_FOLDER;
}

/** Путь лежит внутри корня (или равен ему). Пути с `..`/`.` всегда вне корня. */
export function isInsideRoot(path: string, root: VaultPath): boolean {
  const raw = (path ?? '').replace(/\\/g, '/');
  if (raw.split('/').some((s) => s === '..' || s === '.')) return false;
  const normalized = normalizeVaultPath(raw);
  const normalizedRoot = normalizeVaultPath(root);
  if (normalizedRoot === '') return true;
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}

/** Нормализует путь и проверяет, что он внутри корня; иначе `null`. */
export function resolveInsideRoot(path: string, root: VaultPath): VaultPath | null {
  if (!isInsideRoot(path, root)) return null;
  return normalizeVaultPath(path);
}

/** Склеивает сегменты пути и нормализует результат. */
export function joinPath(...parts: string[]): VaultPath {
  return normalizeVaultPath(parts.filter((p) => p !== '').join('/'));
}

/** Родительская папка (`''` — корень хранилища). */
export function parentPath(path: VaultPath): VaultPath {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** Имя файла с расширением. */
export function fileNameOf(path: VaultPath): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** Название заметки: имя файла без `.md`. */
export function titleFromPath(path: VaultPath): string {
  const name = fileNameOf(path);
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * Превращает название в допустимое имя файла: недопустимые символы → пробел,
 * пробелы схлопываются, без ведущих точек и замыкающих точек/пробелов, длина ограничена.
 * Пустой результат заменяется `fallback`.
 */
export function sanitizeFileName(title: string, fallback: string): string {
  let name = (title ?? '').replace(FORBIDDEN_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
  if (name.length > MAX_FILE_TITLE_LENGTH) {
    name = Array.from(name).slice(0, MAX_FILE_TITLE_LENGTH).join('').replace(/[. ]+$/, '').trim();
  }
  if (WINDOWS_RESERVED_RE.test(name)) name = `${name}_`;
  if (name === '') {
    return fallback === '' ? 'Untitled' : sanitizeFileName(fallback, 'Untitled');
  }
  return name;
}

/**
 * Свободный путь `<folder>/<base><ext>`; при совпадении — `<base> (2)<ext>`, `(3)` и т. д.
 * `isTaken` получает путь-кандидат; сравнение регистра — на стороне вызывающего.
 */
export function uniqueFilePath(folder: VaultPath, base: string, ext: string, isTaken: (path: VaultPath) => boolean): VaultPath {
  const make = (suffix: string): VaultPath => joinPath(folder, `${base}${suffix}${ext}`);
  let candidate = make('');
  for (let n = 2; isTaken(candidate); n += 1) {
    candidate = make(` (${n})`);
    if (n > 10_000) throw new Error('uniqueFilePath: too many collisions');
  }
  return candidate;
}

/** Путь маркера (всегда в корне хранилища). */
export const MARKER_PATH: VaultPath = MARKER_FILE_NAME;

/** Пути Планировщика при заданном корне. */
export function createPlannerPaths(rootInput: string): PlannerPaths {
  const root = resolveRootFolder(rootInput);
  const tasks = joinPath(root, PLANNER_LAYOUT.tasks);
  const archiveRoot = joinPath(tasks, PLANNER_LAYOUT.archive);
  const events = joinPath(root, PLANNER_LAYOUT.events);
  const system = joinPath(root, PLANNER_LAYOUT.system);
  const wallpapers = joinPath(root, PLANNER_LAYOUT.wallpapers);
  return {
    root,
    marker: MARKER_PATH,
    tasks,
    archiveRoot,
    archiveFor: (month: string) => joinPath(archiveRoot, sanitizeFileName(month, 'archive')),
    events,
    deletedEvents: joinPath(events, PLANNER_LAYOUT.deletedEvents),
    notes: joinPath(root, PLANNER_LAYOUT.notes),
    matrix: joinPath(root, PLANNER_LAYOUT.matrixFile),
    system,
    systemFile: (name: SystemJsonName) => joinPath(system, fileNameOf(normalizeVaultPath(name))),
    wallpapers,
    wallpaperProfile: (profileId: string) => joinPath(wallpapers, sanitizeFileName(profileId, 'default')),
  };
}

/** Путь лежит в папке `folder` или её подпапках. */
export function isUnder(path: VaultPath, folder: VaultPath): boolean {
  return folder === '' || path === folder || path.startsWith(`${folder}/`);
}
