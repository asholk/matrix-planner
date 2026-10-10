import { describe, expect, it } from 'vitest';
import type { AttentionItem, InvalidPlannerNote, MarkerState } from '../../src/model/types';
import {
  canKeepVersion,
  conflictItem,
  detectConflictCopy,
  duplicateItem,
  findConflictCopies,
  findDuplicateIds,
  invalidItem,
  itemActions,
  pathActions,
  schemaItem,
  sortAttentionItems,
} from '../../src/integrity/checks';

const T = 'Планировщик/Задачи';

describe('integrity/checks: конфликтные копии', () => {
  it('нумерованная копия iCloud распознаётся только при наличии исходного файла', () => {
    const files = new Set([`${T}/Купить хлеб.md`, `${T}/Купить хлеб 2.md`, `${T}/Глава 3.md`]);
    const exists = (p: string) => files.has(p);
    expect(detectConflictCopy(`${T}/Купить хлеб 2.md`, exists)).toEqual({
      path: `${T}/Купить хлеб 2.md`,
      originalPath: `${T}/Купить хлеб.md`,
      pattern: 'numbered',
    });
    // «Глава 3» без «Глава» — обычное название.
    expect(detectConflictCopy(`${T}/Глава 3.md`, exists)).toBeNull();
  });

  it('собственный суффикс плагина « (2)» не считается конфликтной копией', () => {
    const files = new Set([`${T}/Отчёт.md`, `${T}/Отчёт (2).md`]);
    expect(detectConflictCopy(`${T}/Отчёт (2).md`, (p) => files.has(p))).toBeNull();
  });

  it('распознаёт пометки Dropbox, Obsidian Sync, Syncthing и русскую', () => {
    const none = () => false;
    expect(detectConflictCopy(`${T}/Задача (John's conflicted copy 2026-01-02).md`, none)?.pattern).toBe('conflicted-copy');
    expect(detectConflictCopy(`${T}/Задача (Conflicted copy MacBook 202601021200).md`, none)?.pattern).toBe('conflicted-copy');
    expect(detectConflictCopy(`${T}/Задача (конфликтующая копия).md`, none)?.pattern).toBe('conflicted-copy');
    expect(detectConflictCopy(`${T}/Задача.sync-conflict-20260102-120000-ABCDEFG.md`, none)?.pattern).toBe('sync-conflict');
    expect(detectConflictCopy(`${T}/Обычная задача.md`, none)).toBeNull();
  });

  it('находит исходный файл для явной пометки', () => {
    const files = new Set([`${T}/Задача.md`]);
    const match = detectConflictCopy(`${T}/Задача (conflicted copy).md`, (p) => files.has(p));
    expect(match?.originalPath).toBe(`${T}/Задача.md`);
  });

  it('findConflictCopies смотрит только .md и .json', () => {
    const result = findConflictCopies([
      'Планировщик/_system/tombstones.json',
      'Планировщик/_system/tombstones 2.json',
      'Планировщик/Обои/lock.png',
      'Планировщик/Обои/lock 2.png',
    ]);
    expect(result.map((m) => m.path)).toEqual(['Планировщик/_system/tombstones 2.json']);
  });
});

describe('integrity/checks: дубликаты id', () => {
  it('id сохраняет исходная заметка, копия получает новый id', () => {
    const groups = findDuplicateIds(
      [
        { id: 'A', path: `${T}/Задача 2.md` },
        { id: 'A', path: `${T}/Задача.md` },
        { id: 'B', path: `${T}/Другая.md` },
      ],
      { isCopy: (p) => p.endsWith(' 2.md') },
    );
    expect(groups).toEqual([{ id: 'A', keep: `${T}/Задача.md`, copies: [`${T}/Задача 2.md`] }]);
  });

  it('копия в «Удалённых» уступает id активной заметке', () => {
    const groups = findDuplicateIds(
      [
        { id: 'E', path: 'Планировщик/События/Удалённые/Встреча.md' },
        { id: 'E', path: 'Планировщик/События/Встреча.md' },
      ],
      { isSecondary: (p) => p.includes('/Удалённые/') },
    );
    expect(groups[0]?.keep).toBe('Планировщик/События/Встреча.md');
  });

  it('без признаков копии — первая по пути', () => {
    const groups = findDuplicateIds([
      { id: 'X', path: `${T}/b.md` },
      { id: 'X', path: `${T}/a.md` },
      { id: 'X', path: `${T}/c.md` },
    ]);
    expect(groups).toEqual([{ id: 'X', keep: `${T}/a.md`, copies: [`${T}/b.md`, `${T}/c.md`] }]);
  });
});

describe('integrity/checks: элементы и действия', () => {
  it('дубликат показывает обе версии; действия без удаления', () => {
    const item = duplicateItem('A', `${T}/Задача.md`, [`${T}/Задача 2.md`], true);
    expect(item.paths).toEqual([`${T}/Задача.md`, `${T}/Задача 2.md`]);
    expect(item.messageKey).toBe('integrity.items.duplicateId');
    expect(pathActions(item)).toEqual(['open', 'keep']);
    expect(itemActions(item)).toEqual(['merge']);
    expect(canKeepVersion(item, `${T}/Задача 2.md`)).toBe(true);
    expect(canKeepVersion(item, `${T}/Чужая.md`)).toBe(false);
  });

  it('конфликтная копия без исходного файла — без «Объединить вручную»', () => {
    const item = conflictItem({ path: `${T}/Задача (conflicted copy).md`, originalPath: null, pattern: 'conflicted-copy' });
    expect(item.paths).toHaveLength(1);
    expect(itemActions(item)).toEqual([]);
    expect(pathActions(item)).toEqual(['open', 'keep']);
  });

  it('невалидная заметка — только «Открыть», перечислены свойства', () => {
    const note: InvalidPlannerNote = {
      kind: 'invalid',
      path: `${T}/Сломанная.md`,
      title: 'Сломанная',
      mtime: 0,
      declaredType: 'task',
      frontmatter: { type: 'task', id: 'Z' },
      issues: [{ property: 'quadrant', code: 'missing' }],
    };
    const item = invalidItem(note);
    expect(item.kind).toBe('invalid-properties');
    expect(item.messageParams?.['properties']).toBe('quadrant');
    expect(item.itemId).toBe('Z');
    expect(pathActions(item)).toEqual(['open']);
    expect(canKeepVersion(item, note.path)).toBe(false);
  });

  it('схема: элемент только для проблемных статусов', () => {
    const state = (status: MarkerState['status']): MarkerState => ({ status, marker: null, issues: [] });
    expect(schemaItem(state('ok'), 'matrix-planner.md')).toBeNull();
    expect(schemaItem(state('unknown'), 'matrix-planner.md')).toBeNull();
    expect(schemaItem(state('newer'), 'matrix-planner.md')?.messageKey).toBe('integrity.items.schema.newer');
  });

  it('сортировка: схема, дубликаты, копии, невалидные', () => {
    const items: AttentionItem[] = [
      { key: 'c', kind: 'conflict-copy', paths: ['b'], itemId: null, messageKey: '' },
      { key: 'i', kind: 'invalid-properties', paths: ['a'], itemId: null, messageKey: '' },
      { key: 'd', kind: 'duplicate-id', paths: ['z'], itemId: null, messageKey: '' },
      { key: 's', kind: 'schema', paths: ['m'], itemId: null, messageKey: '' },
    ];
    expect(sortAttentionItems(items).map((i) => i.key)).toEqual(['s', 'd', 'c', 'i']);
  });
});
