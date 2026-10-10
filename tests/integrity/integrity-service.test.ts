import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp, MockElement, splitFrontmatter, type App as MockApp } from '../__mocks__/obsidian';
import type { Clock, IdGenerator, IntegrityService, WriteGuard } from '../../src/app/contracts';
import type { AttentionItem, IntegrityReport, MarkerState } from '../../src/model/types';
import { createPlannerNoteParser } from '../../src/model/properties';
import { MetadataNoteIndex } from '../../src/storage/note-index';
import { ObsidianNoteRepository } from '../../src/storage/note-repository';
import { createPlannerPaths } from '../../src/storage/paths';
import { KeyedWriteQueue } from '../../src/storage/write-queue';
import { MemoryAttentionStateStore, VaultIntegrityService } from '../../src/integrity/integrity-service';
import { createAttentionPanel, createWorkspaceOpeners } from '../../src/integrity/attention-panel';

const ROOT = 'Планировщик';
const T = `${ROOT}/Задачи`;
const E = `${ROOT}/События`;

function task(id: string | null, extra = ''): string {
  return ['---', 'type: task', ...(id ? [`id: ${id}`] : []), 'quadrant: do', extra, '---', 'Тело', ''].filter((l) => l !== '').join('\n');
}

function event(id: string): string {
  return ['---', 'type: event', `id: ${id}`, 'start: 2026-10-10T10:00', 'end: 2026-10-10T11:00', '---', ''].join('\n');
}

let indexes: MetadataNoteIndex[] = [];

async function setup(files: Record<string, string>, options: { writable?: boolean; marker?: MarkerState } = {}) {
  const app: MockApp = createMockApp();
  for (const [path, text] of Object.entries(files)) await app.vault.create(path, text);
  app.metadataCache.flush();
  const paths = createPlannerPaths(ROOT);
  let writable = options.writable ?? true;
  const guard: WriteGuard = {
    canWrite: () => writable,
    check: () => (writable ? null : { code: 'read-only', messageKey: 'storage.readOnly.newer' }),
  };
  const repository = new ObsidianNoteRepository(app as unknown as App, { getPaths: () => paths, guard, queue: new KeyedWriteQueue() });
  const index = new MetadataNoteIndex(app as unknown as App, { parser: createPlannerNoteParser(), getPaths: () => paths });
  indexes.push(index);
  index.start();
  let seq = 0;
  const ids: IdGenerator = { next: () => `NEWID${String(++seq).padStart(4, '0')}` };
  const clock: Clock = { now: () => new Date('2026-10-10T12:00:00Z'), timeZone: () => 'UTC' };
  const state = new MemoryAttentionStateStore();
  const service = new VaultIntegrityService({
    index,
    repository,
    guard,
    ids,
    clock,
    state,
    marker: options.marker ? { getState: () => options.marker as MarkerState } : undefined,
  });
  const trashSpy = vi.spyOn(app.fileManager, 'trashFile');
  const deleteSpy = vi.spyOn(app.vault, 'delete');
  return {
    app,
    index,
    service,
    trashSpy,
    deleteSpy,
    setWritable: (value: boolean) => {
      writable = value;
    },
  };
}

function frontmatterOf(app: MockApp, path: string): Record<string, unknown> {
  const text = app.vault.contents.get(path);
  if (typeof text !== 'string') throw new Error(`no file ${path}`);
  return splitFrontmatter(text).frontmatter ?? {};
}

async function settle(app: MockApp): Promise<void> {
  await Promise.resolve();
  app.metadataCache.flush();
  await Promise.resolve();
}

function byKind(report: IntegrityReport, kind: AttentionItem['kind']): AttentionItem[] {
  return report.items.filter((item) => item.kind === kind);
}

afterEach(() => {
  for (const index of indexes) index.stop();
  indexes = [];
});

describe('integrity/VaultIntegrityService', () => {
  it('дубликат id: копии выдан новый id, обе заметки в списке, ничего не удалено', async () => {
    const ctx = await setup({
      [`${T}/Купить хлеб.md`]: task('AAA'),
      [`${T}/Купить хлеб 2.md`]: task('AAA'),
    });
    const result = await ctx.service.check();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(frontmatterOf(ctx.app, `${T}/Купить хлеб.md`)['id']).toBe('AAA');
    expect(frontmatterOf(ctx.app, `${T}/Купить хлеб 2.md`)['id']).toBe('NEWID0001');
    expect(result.value.reassignedIds).toEqual({ [`${T}/Купить хлеб 2.md`]: 'NEWID0001' });

    const duplicates = byKind(result.value, 'duplicate-id');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.paths).toEqual([`${T}/Купить хлеб.md`, `${T}/Купить хлеб 2.md`]);
    // Копия-дубликат не показывается второй раз как конфликтная копия.
    expect(byKind(result.value, 'conflict-copy')).toHaveLength(0);

    expect(ctx.app.vault.contents.has(`${T}/Купить хлеб 2.md`)).toBe(true);
    expect(ctx.trashSpy).not.toHaveBeenCalled();
    expect(ctx.deleteSpy).not.toHaveBeenCalled();
  });

  it('после выдачи нового id обе версии показываются и при следующей проверке; id не выдаётся повторно', async () => {
    const ctx = await setup({ [`${T}/A.md`]: task('AAA'), [`${T}/B.md`]: task('AAA') });
    await ctx.service.check();
    await settle(ctx.app);
    const second = await ctx.service.check();
    expect(second.ok && second.value.reassignedIds).toEqual({});
    expect(second.ok && byKind(second.value, 'duplicate-id')[0]?.paths).toEqual([`${T}/A.md`, `${T}/B.md`]);
    expect(frontmatterOf(ctx.app, `${T}/B.md`)['id']).toBe('NEWID0001');
  });

  it('индекс отстаёт от файла: новый id не перезаписывается', async () => {
    const ctx = await setup({ [`${T}/A.md`]: task('AAA'), [`${T}/B.md`]: task('AAA') });
    ctx.app.metadataCache.autoFlush = false;
    await ctx.service.check();
    const again = await ctx.service.check();
    expect(again.ok && again.value.reassignedIds).toEqual({});
    expect(frontmatterOf(ctx.app, `${T}/B.md`)['id']).toBe('NEWID0001');
  });

  it('только чтение: новый id не выдаётся, дубликат всё равно показан', async () => {
    const ctx = await setup({ [`${T}/A.md`]: task('AAA'), [`${T}/B.md`]: task('AAA') }, { writable: false });
    const result = await ctx.service.check();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reassignedIds).toEqual({});
    expect(frontmatterOf(ctx.app, `${T}/B.md`)['id']).toBe('AAA');
    expect(byKind(result.value, 'duplicate-id')[0]?.messageKey).toBe('integrity.items.duplicateIdReadOnly');
  });

  it('«Оставить эту версию» снимает пометку и не трогает файлы', async () => {
    const ctx = await setup({ [`${T}/A.md`]: task('AAA'), [`${T}/B.md`]: task('AAA') });
    const first = await ctx.service.check();
    if (!first.ok) throw new Error('check failed');
    const item = byKind(first.value, 'duplicate-id')[0] as AttentionItem;
    const before = new Map(ctx.app.vault.contents);

    const kept = await ctx.service.keepVersion(item, `${T}/B.md`);
    expect(kept.ok).toBe(true);
    expect(new Map(ctx.app.vault.contents)).toEqual(before);
    expect(ctx.service.getLastReport()?.items.some((i) => i.key === item.key)).toBe(false);

    await settle(ctx.app);
    const next = await ctx.service.check();
    expect(next.ok && byKind(next.value, 'duplicate-id')).toEqual([]);
    expect(ctx.trashSpy).not.toHaveBeenCalled();
  });

  it('«Оставить эту версию» недоступно для пути вне элемента', async () => {
    const ctx = await setup({ [`${T}/A.md`]: task('AAA'), [`${T}/B.md`]: task('AAA') });
    const result = await ctx.service.check();
    if (!result.ok) throw new Error('check failed');
    const item = byKind(result.value, 'duplicate-id')[0] as AttentionItem;
    const kept = await ctx.service.keepVersion(item, `${T}/Чужая.md`);
    expect(kept.ok).toBe(false);
    expect(ctx.service.getLastReport()?.items).toContainEqual(item);
  });

  it('невалидная заметка показывается в списке', async () => {
    const ctx = await setup({ [`${T}/Без id.md`]: task(null) });
    const result = await ctx.service.check();
    if (!result.ok) throw new Error('check failed');
    const invalid = byKind(result.value, 'invalid-properties');
    expect(invalid.map((i) => i.paths[0])).toEqual([`${T}/Без id.md`]);
    const kept = await ctx.service.keepVersion(invalid[0] as AttentionItem, `${T}/Без id.md`);
    expect(kept.ok).toBe(false);
  });

  it('конфликтная копия показывается с исходной заметкой; пометку можно снять', async () => {
    const ctx = await setup({
      [`${T}/Отчёт.md`]: task('R1'),
      [`${T}/Отчёт (conflicted copy).md`]: task('R2'),
    });
    const result = await ctx.service.check();
    if (!result.ok) throw new Error('check failed');
    const copies = byKind(result.value, 'conflict-copy');
    expect(copies).toHaveLength(1);
    expect(copies[0]?.paths).toEqual([`${T}/Отчёт (conflicted copy).md`, `${T}/Отчёт.md`]);
    expect(copies[0]?.itemId).toBe('R2');

    await ctx.service.keepVersion(copies[0] as AttentionItem, `${T}/Отчёт (conflicted copy).md`);
    const next = await ctx.service.check();
    expect(next.ok && byKind(next.value, 'conflict-copy')).toEqual([]);
    expect(ctx.app.vault.contents.has(`${T}/Отчёт (conflicted copy).md`)).toBe(true);
  });

  it('конфликтная копия служебного JSON тоже находится', async () => {
    const ctx = await setup({});
    await ctx.app.vault.create(`${ROOT}/_system/tombstones.json`, '{}');
    await ctx.app.vault.create(`${ROOT}/_system/tombstones 2.json`, '{}');
    const result = await ctx.service.check();
    expect(result.ok && byKind(result.value, 'conflict-copy').map((i) => i.paths[0])).toEqual([`${ROOT}/_system/tombstones 2.json`]);
  });

  it('событие в «События/Удалённые/» показывается, но не переносится и не удаляется', async () => {
    const path = `${E}/Удалённые/Встреча.md`;
    const ctx = await setup({ [path]: event('EV1'), [`${E}/Обед.md`]: event('EV2') });
    const result = await ctx.service.check();
    if (!result.ok) throw new Error('check failed');
    const deleted = byKind(result.value, 'deleted-in-calendar');
    expect(deleted.map((i) => i.paths)).toEqual([[path]]);
    expect(ctx.app.vault.contents.has(path)).toBe(true);
  });

  it('проблема схемы попадает в список', async () => {
    const ctx = await setup({}, { marker: { status: 'newer', marker: null, issues: [] } });
    const result = await ctx.service.check();
    expect(result.ok && byKind(result.value, 'schema').map((i) => i.messageKey)).toEqual(['integrity.items.schema.newer']);
  });

  it('onChange получает новый отчёт', async () => {
    const ctx = await setup({ [`${T}/A.md`]: task('A1') });
    const reports: Array<IntegrityReport | null> = [];
    ctx.service.onChange((report) => reports.push(report));
    await ctx.service.check();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.checkedAt).toBe('2026-10-10T12:00:00.000Z');
    expect(reports[0]?.items).toEqual([]);
  });
});

describe('integrity/attention-panel', () => {
  const dup: AttentionItem = {
    key: 'duplicate-id:AAA',
    kind: 'duplicate-id',
    paths: [`${T}/A.md`, `${T}/A 2.md`],
    itemId: 'AAA',
    messageKey: 'integrity.items.duplicateId',
    messageParams: { count: 2 },
  };
  const invalid: AttentionItem = {
    key: `invalid-properties:${T}/X.md`,
    kind: 'invalid-properties',
    paths: [`${T}/X.md`],
    itemId: null,
    messageKey: 'integrity.items.invalid',
    messageParams: { properties: 'quadrant' },
  };

  function fakeIntegrity(report: IntegrityReport | null) {
    let listener: ((r: IntegrityReport | null) => void) | null = null;
    const keepVersion = vi.fn(async () => ({ ok: true as const, value: undefined, changed: true }));
    const integrity: Pick<IntegrityService, 'getLastReport' | 'keepVersion' | 'onChange'> = {
      getLastReport: () => report,
      keepVersion,
      onChange: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    };
    return { integrity, keepVersion, emit: (r: IntegrityReport | null) => listener?.(r), hasListener: () => listener !== null };
  }

  const report: IntegrityReport = { checkedAt: '2026-10-10T12:00:00.000Z', items: [dup, invalid], reassignedIds: {} };

  it('действия «Открыть», «Оставить эту версию», «Объединить вручную»; удаления нет', async () => {
    const fake = fakeIntegrity(report);
    const openNote = vi.fn();
    const openSideBySide = vi.fn();
    const container = new MockElement();
    const handle = createAttentionPanel({ integrity: fake.integrity, openNote, openSideBySide })(container as unknown as HTMLElement);

    const items = container.findAllByClass('mp-attention-item');
    expect(items).toHaveLength(2);
    const [dupEl, invalidEl] = items as [MockElement, MockElement];

    expect(dupEl.findAllByClass('mp-attention-open')).toHaveLength(2);
    expect(dupEl.findAllByClass('mp-attention-keep')).toHaveLength(2);
    expect(dupEl.findAllByClass('mp-attention-merge')).toHaveLength(1);
    expect(invalidEl.findAllByClass('mp-attention-open')).toHaveLength(1);
    expect(invalidEl.findAllByClass('mp-attention-keep')).toHaveLength(0);
    expect(invalidEl.findAllByClass('mp-attention-merge')).toHaveLength(0);
    expect(container.findAllByClass('mp-attention-delete')).toHaveLength(0);

    dupEl.findAllByClass('mp-attention-open')[1]?.click();
    expect(openNote).toHaveBeenCalledWith(`${T}/A 2.md`);

    dupEl.findAllByClass('mp-attention-merge')[0]?.click();
    expect(openSideBySide).toHaveBeenCalledWith([`${T}/A.md`, `${T}/A 2.md`]);

    dupEl.findAllByClass('mp-attention-keep')[0]?.click();
    await Promise.resolve();
    expect(fake.keepVersion).toHaveBeenCalledWith(dup, `${T}/A.md`);

    handle.dispose();
    expect(fake.hasListener()).toBe(false);
  });

  it('перерисовывается по onChange; пустой отчёт — подпись', () => {
    const fake = fakeIntegrity(null);
    const container = new MockElement();
    createAttentionPanel({ integrity: fake.integrity, openNote: vi.fn(), openSideBySide: vi.fn() })(container as unknown as HTMLElement);
    expect(container.findAllByClass('mp-attention-item')).toHaveLength(0);
    fake.emit({ checkedAt: '', items: [], reassignedIds: {} });
    expect(container.findAllByClass('mp-attention-empty')).toHaveLength(1);
    fake.emit(report);
    expect(container.findAllByClass('mp-attention-item')).toHaveLength(2);
  });

  it('«Объединить вручную» открывает обе заметки', async () => {
    const app = createMockApp();
    await app.vault.create(`${T}/A.md`, task('AAA'));
    await app.vault.create(`${T}/A 2.md`, task('AAA'));
    const openers = createWorkspaceOpeners(app as unknown as App);
    openers.openSideBySide([`${T}/A.md`, `${T}/A 2.md`]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const opened = app.workspace.leaves.map((leaf) => (leaf.getViewState().state as { file?: string } | undefined)?.file);
    expect(opened).toEqual([`${T}/A.md`, `${T}/A 2.md`]);
  });
});
