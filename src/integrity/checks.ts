/**
 * Чистые проверки целостности (ТЗ §3.8, §4.6, §5.4.3): дубликаты id, конфликтные копии,
 * невалидные заметки, удалённые в «Календаре» события, проблемы схемы.
 * Не импортирует `obsidian` и DOM; ничего не пишет — только описывает находки.
 */

import type {
  AttentionItem,
  InvalidPlannerNote,
  ItemId,
  MarkerState,
  PlannerEvent,
  PlannerItem,
  VaultPath,
} from '../model/types';
import { canonicalId } from '../model/ids';

// ---------------------------------------------------------------------------
// Пути
// ---------------------------------------------------------------------------

function splitName(path: VaultPath): { folder: string; base: string; ext: string } {
  const slash = path.lastIndexOf('/');
  const folder = slash === -1 ? '' : path.slice(0, slash);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { folder, base: name.slice(0, dot), ext: name.slice(dot) } : { folder, base: name, ext: '' };
}

function joinName(folder: string, base: string, ext: string): VaultPath {
  return folder === '' ? `${base}${ext}` : `${folder}/${base}${ext}`;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Конфликтные копии
// ---------------------------------------------------------------------------

export type ConflictPattern = 'numbered' | 'conflicted-copy' | 'sync-conflict';

export interface ConflictCopyMatch {
  path: VaultPath;
  /** Исходный файл, если он найден рядом. */
  originalPath: VaultPath | null;
  pattern: ConflictPattern;
}

/** Явные пометки служб синхронизации в конце имени (Dropbox, Nextcloud, Obsidian Sync, рус.). */
const CONFLICTED_COPY_RE = /\s*\((?:[^()]*\s)?(?:conflicted copy|conflict|конфликтующая копия|конфликт)(?:\s[^()]*)?\)$/i;
/** Syncthing: `name.sync-conflict-20240101-120000-ABCDEFG`. */
const SYNC_CONFLICT_RE = /\.sync-conflict-\d{8}-\d{6}(?:-[A-Z0-9]+)?$/i;
/** iCloud и «Создать копию» Obsidian: `name 2`. Скобки ` (2)` — собственные имена плагина, не копии. */
const NUMBERED_RE = /^(.*\S) (\d{1,3})$/;

/**
 * Похоже ли имя файла на конфликтную копию. `exists` — есть ли файл по пути.
 * Для нумерованных копий (`… 2.md`) обязателен исходный файл рядом, иначе это просто название.
 */
export function detectConflictCopy(path: VaultPath, exists: (path: VaultPath) => boolean): ConflictCopyMatch | null {
  const { folder, base, ext } = splitName(path);

  const syncConflict = SYNC_CONFLICT_RE.exec(base);
  if (syncConflict) {
    const original = joinName(folder, base.slice(0, syncConflict.index), ext);
    return { path, originalPath: exists(original) ? original : null, pattern: 'sync-conflict' };
  }

  const conflicted = CONFLICTED_COPY_RE.exec(base);
  if (conflicted && conflicted.index > 0) {
    const original = joinName(folder, base.slice(0, conflicted.index).trimEnd(), ext);
    return { path, originalPath: exists(original) ? original : null, pattern: 'conflicted-copy' };
  }

  const numbered = NUMBERED_RE.exec(base);
  if (numbered) {
    const original = joinName(folder, numbered[1], ext);
    if (original !== path && exists(original)) return { path, originalPath: original, pattern: 'numbered' };
  }
  return null;
}

/** Конфликтные копии среди файлов (`.md` и `.json`); результат отсортирован по пути. */
export function findConflictCopies(paths: readonly VaultPath[]): ConflictCopyMatch[] {
  const set = new Set(paths);
  const result: ConflictCopyMatch[] = [];
  for (const path of [...paths].sort(comparePaths)) {
    const lower = path.toLowerCase();
    if (!lower.endsWith('.md') && !lower.endsWith('.json')) continue;
    const match = detectConflictCopy(path, (candidate) => set.has(candidate));
    if (match) result.push(match);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Дубликаты id
// ---------------------------------------------------------------------------

export interface IdCarrier {
  id: ItemId;
  path: VaultPath;
}

export interface DuplicateGroup {
  id: ItemId;
  /** Заметка, которая сохраняет id. */
  keep: VaultPath;
  /** Копии, которым нужно выдать новый id (по возрастанию пути). */
  copies: VaultPath[];
}

/**
 * Группы заметок с одинаковым id. Id сохраняет заметка, не похожая на копию
 * (`isCopy`) и не лежащая в «Удалённых» (`isSecondary`), при равенстве — первая по пути.
 */
export function findDuplicateIds(
  items: readonly IdCarrier[],
  options: { isCopy?: (path: VaultPath) => boolean; isSecondary?: (path: VaultPath) => boolean } = {},
): DuplicateGroup[] {
  const byId = new Map<ItemId, VaultPath[]>();
  for (const item of items) {
    // ID сравниваются в каноническом виде: строчный и прописной ULID — один и тот же ID.
    const id = canonicalId(item.id);
    const list = byId.get(id);
    if (list) {
      if (!list.includes(item.path)) list.push(item.path);
    } else byId.set(id, [item.path]);
  }
  const rank = (path: VaultPath): number =>
    (options.isCopy?.(path) ? 2 : 0) + (options.isSecondary?.(path) ? 1 : 0);
  const groups: DuplicateGroup[] = [];
  for (const [id, paths] of byId) {
    if (paths.length < 2) continue;
    const ordered = [...paths].sort((a, b) => rank(a) - rank(b) || comparePaths(a, b));
    const [keep, ...rest] = ordered as [VaultPath, ...VaultPath[]];
    groups.push({ id, keep, copies: rest.sort(comparePaths) });
  }
  return groups.sort((a, b) => comparePaths(a.keep, b.keep));
}

// ---------------------------------------------------------------------------
// Элементы «Требуют внимания»
// ---------------------------------------------------------------------------

export function duplicateKey(id: ItemId): string {
  return `duplicate-id:${id}`;
}

export function conflictKey(copyPath: VaultPath): string {
  return `conflict-copy:${copyPath}`;
}

/** Дубликат: первый путь — исходная заметка, остальные — копии. */
export function duplicateItem(id: ItemId, keep: VaultPath, copies: readonly VaultPath[], reassigned: boolean): AttentionItem {
  return {
    key: duplicateKey(id),
    kind: 'duplicate-id',
    paths: [keep, ...copies],
    itemId: id,
    messageKey: reassigned ? 'integrity.items.duplicateId' : 'integrity.items.duplicateIdReadOnly',
    messageParams: { count: copies.length + 1, original: 1 },
  };
}

/** Конфликтная копия: копия первой, затем исходный файл (если найден). */
export function conflictItem(match: ConflictCopyMatch, itemId: ItemId | null = null): AttentionItem {
  return {
    key: conflictKey(match.path),
    kind: 'conflict-copy',
    paths: match.originalPath ? [match.path, match.originalPath] : [match.path],
    itemId,
    messageKey: 'integrity.items.conflictCopy',
    messageParams: { pattern: match.pattern, original: match.originalPath ? 1 : 0 },
  };
}

export function invalidItem(note: InvalidPlannerNote): AttentionItem {
  const properties = [...new Set(note.issues.map((issue) => issue.property))].join(', ');
  const rawId = note.frontmatter['id'];
  return {
    key: `invalid-properties:${note.path}`,
    kind: 'invalid-properties',
    paths: [note.path],
    itemId: typeof rawId === 'string' && rawId.trim() !== '' ? canonicalId(rawId) : null,
    messageKey: 'integrity.items.invalid',
    messageParams: { properties, type: note.declaredType },
    issues: note.issues,
  };
}

/**
 * Заметка разобрана, но с проблемами свойств (например, `due: 2026-02-30`): показывается
 * в списке, а неверные значения заменены значениями по умолчанию — пользователь должен это видеть.
 */
export function itemIssuesItem(item: Pick<PlannerItem, 'kind' | 'id' | 'path' | 'issues'>): AttentionItem | null {
  if (item.issues.length === 0) return null;
  const properties = [...new Set(item.issues.map((issue) => issue.property))].join(', ');
  return {
    key: `invalid-properties:${item.path}`,
    kind: 'invalid-properties',
    paths: [item.path],
    itemId: item.id,
    messageKey: 'integrity.items.invalid',
    messageParams: { properties, type: item.kind },
    issues: item.issues,
  };
}

export function deletedInCalendarItem(event: Pick<PlannerEvent, 'id' | 'path'>): AttentionItem {
  return {
    key: `deleted-in-calendar:${event.path}`,
    kind: 'deleted-in-calendar',
    paths: [event.path],
    itemId: event.id,
    messageKey: 'integrity.items.deletedInCalendar',
  };
}

export function pendingDeletionItem(event: Pick<PlannerEvent, 'id' | 'path'>): AttentionItem {
  return {
    key: `pending-deletion:${event.id}`,
    kind: 'pending-deletion',
    paths: [event.path],
    itemId: event.id,
    messageKey: 'integrity.items.pendingDeletion',
  };
}

const SCHEMA_KEYS: Partial<Record<MarkerState['status'], string>> = {
  newer: 'integrity.items.schema.newer',
  invalid: 'integrity.items.schema.invalid',
  'needs-migration': 'integrity.items.schema.needsMigration',
  migrating: 'integrity.items.schema.migrating',
};

/** Проблема маркера/схемы; `null` — всё в порядке или маркер ещё не прочитан. */
export function schemaItem(state: MarkerState, markerPath: VaultPath): AttentionItem | null {
  const messageKey = SCHEMA_KEYS[state.status];
  if (!messageKey) return null;
  return {
    key: `schema:${state.status}`,
    kind: 'schema',
    paths: [markerPath],
    itemId: null,
    messageKey,
    issues: state.issues.length > 0 ? state.issues : undefined,
  };
}

const KIND_ORDER: Record<AttentionItem['kind'], number> = {
  schema: 0,
  'duplicate-id': 1,
  'conflict-copy': 2,
  'invalid-properties': 3,
  'pending-deletion': 4,
  'deleted-in-calendar': 5,
};

/** Порядок показа: схема, дубликаты, копии, невалидные, удаления; внутри — по первому пути. */
export function sortAttentionItems(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || comparePaths(a.paths[0] ?? '', b.paths[0] ?? '') || comparePaths(a.key, b.key),
  );
}

// ---------------------------------------------------------------------------
// Действия панели
// ---------------------------------------------------------------------------

export type AttentionAction = 'open' | 'keep' | 'merge';

/** Действия для элемента в целом: «Объединить вручную» — когда версий несколько. */
export function itemActions(item: AttentionItem): AttentionAction[] {
  const isVersioned = item.kind === 'duplicate-id' || item.kind === 'conflict-copy';
  return isVersioned && item.paths.length > 1 ? ['merge'] : [];
}

/** Действия для отдельной заметки элемента. Удаления среди действий нет никогда. */
export function pathActions(item: AttentionItem): AttentionAction[] {
  if (item.kind === 'duplicate-id' || item.kind === 'conflict-copy') return ['open', 'keep'];
  return ['open'];
}

/** Можно ли «Оставить эту версию» для элемента и пути. */
export function canKeepVersion(item: AttentionItem, path: VaultPath): boolean {
  return pathActions(item).includes('keep') && item.paths.includes(path);
}
