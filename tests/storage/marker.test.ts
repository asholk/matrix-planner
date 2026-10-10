import { beforeEach, describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp, splitFrontmatter, type App as MockApp } from '../__mocks__/obsidian';
import {
  evaluateMarker,
  MarkerWriteGuard,
  MigrationWriteGuard,
  parseFrontmatterText,
  schemaStatus,
  VaultMarkerService,
} from '../../src/storage/marker';
import { createPlannerPaths } from '../../src/storage/paths';
import { KeyedWriteQueue } from '../../src/storage/write-queue';
import type { PlannerPaths } from '../../src/model/types';

const MARKER = 'matrix-planner.md';

function setup(rootFolder = 'Планировщик') {
  const app: MockApp = createMockApp();
  let counter = 0;
  const ids = { next: () => `VAULT${++counter}`, count: () => counter };
  const queue = new KeyedWriteQueue();
  let paths: PlannerPaths = createPlannerPaths(rootFolder);
  const service = new VaultMarkerService(app as unknown as App, { getPaths: () => paths, ids, queue });
  return {
    app,
    ids,
    queue,
    service,
    setRoot: (root: string) => {
      paths = createPlannerPaths(root);
    },
  };
}

function markerFrontmatter(app: MockApp): Record<string, unknown> | null {
  const text = app.vault.contents.get(MARKER);
  return typeof text === 'string' ? splitFrontmatter(text).frontmatter : null;
}

describe('storage/marker', () => {
  describe('разбор', () => {
    it('статус схемы', () => {
      expect(schemaStatus(1, false)).toBe('ok');
      expect(schemaStatus(2, false)).toBe('newer');
      expect(schemaStatus(2, true)).toBe('newer');
      expect(schemaStatus(1, true)).toBe('migrating');
      expect(schemaStatus(0, false)).toBe('invalid');
    });

    it('маркер без схемы или с неверной схемой повреждён', () => {
      expect(evaluateMarker(null).status).toBe('invalid');
      expect(evaluateMarker({ root: 'x' }).status).toBe('invalid');
      expect(evaluateMarker({ schema: 'abc' }).status).toBe('invalid');
      expect(evaluateMarker({ schema: 1.5 }).status).toBe('invalid');
    });

    it('недостающие root/vault_id — проблемы, а не повреждение', () => {
      const state = evaluateMarker({ schema: 1 });
      expect(state.status).toBe('ok');
      expect(state.issues.map((i) => i.property).sort()).toEqual(['root', 'vault_id']);
      expect(evaluateMarker({ schema: '1', root: 'P', vault_id: 'V' }).marker).toEqual({ root: 'P', schema: 1, vault_id: 'V', migrating: false });
    });

    it('разбор блока свойств', () => {
      expect(parseFrontmatterText('---\nschema: 1\n---\ntext')).toEqual({ schema: 1 });
      expect(parseFrontmatterText('---\n---\n')).toEqual({});
      expect(parseFrontmatterText('без свойств')).toBeNull();
      expect(parseFrontmatterText('---\nschema: [1\n---\n')).toBeNull();
      expect(parseFrontmatterText('---\n- 1\n- 2\n---\n')).toBeNull();
    });
  });

  describe('инициализация', () => {
    let ctx: ReturnType<typeof setup>;
    beforeEach(() => {
      ctx = setup();
    });

    it('создаёт маркер и папки', async () => {
      const state = await ctx.service.ensure();
      expect(state.status).toBe('ok');
      expect(state.marker).toEqual({ root: 'Планировщик', schema: 1, vault_id: 'VAULT1', migrating: false });
      expect(markerFrontmatter(ctx.app)).toEqual({ root: 'Планировщик', schema: 1, vault_id: 'VAULT1', migrating: false });
      for (const folder of ['Планировщик', 'Планировщик/Задачи', 'Планировщик/События', 'Планировщик/Заметки', 'Планировщик/_system']) {
        expect(ctx.app.vault.getFolderByPath(folder)).not.toBeNull();
      }
      expect(new MarkerWriteGuard(ctx.service).canWrite()).toBe(true);
    });

    it('повторная инициализация ничего не меняет', async () => {
      await ctx.service.ensure();
      const before = ctx.app.vault.contents.get(MARKER);
      const mtime = ctx.app.vault.getFileByPath(MARKER)?.stat.mtime;
      const state = await ctx.service.ensure();
      expect(state.status).toBe('ok');
      expect(ctx.app.vault.contents.get(MARKER)).toBe(before);
      expect(ctx.app.vault.getFileByPath(MARKER)?.stat.mtime).toBe(mtime);
      expect(ctx.ids.count()).toBe(1);
    });

    it('не перезаписывает существующий vault_id и чужие свойства', async () => {
      await ctx.app.vault.create(MARKER, '---\nschema: 1\nvault_id: keep-me\ncustom: 42\n---\nМоё описание\n');
      const state = await ctx.service.ensure();
      expect(state.marker?.vault_id).toBe('keep-me');
      const text = ctx.app.vault.contents.get(MARKER) as string;
      expect(splitFrontmatter(text).frontmatter).toEqual({ schema: 1, vault_id: 'keep-me', custom: 42, root: 'Планировщик', migrating: false });
      expect(splitFrontmatter(text).body).toBe('Моё описание\n');
      expect(ctx.ids.count()).toBe(0);
    });

    it('дополняет отсутствующий vault_id', async () => {
      await ctx.app.vault.create(MARKER, '---\nroot: Планировщик\nschema: 1\nmigrating: false\n---\n');
      const state = await ctx.service.ensure();
      expect(state.marker?.vault_id).toBe('VAULT1');
      expect(state.issues).toEqual([]);
    });

    it('обновляет root при смене корня', async () => {
      await ctx.service.ensure();
      ctx.setRoot('Работа/План');
      const state = await ctx.service.ensure();
      expect(state.marker?.root).toBe('Работа/План');
      expect(state.marker?.vault_id).toBe('VAULT1');
      expect(ctx.app.vault.getFolderByPath('Работа/План/Задачи')).not.toBeNull();
    });
  });

  describe('новая схема — только чтение', () => {
    it('не пишет ничего и запрещает запись', async () => {
      const ctx = setup();
      const original = '---\nroot: Планировщик\nschema: 2\nvault_id: V\n---\n';
      await ctx.app.vault.create(MARKER, original);
      const state = await ctx.service.ensure();
      expect(state.status).toBe('newer');
      expect(ctx.app.vault.contents.get(MARKER)).toBe(original);
      expect(ctx.app.vault.getFolderByPath('Планировщик')).toBeNull();
      const guard = new MarkerWriteGuard(ctx.service);
      expect(guard.canWrite()).toBe(false);
      expect(guard.check()).toEqual({ code: 'read-only', messageKey: 'storage.readOnly.newer' });
      expect(new MigrationWriteGuard(ctx.service).canWrite()).toBe(false);
      await expect(ctx.service.setMigrating(true)).rejects.toThrow();
    });

    it('повреждённый YAML — только чтение', async () => {
      const ctx = setup();
      await ctx.app.vault.create(MARKER, '---\nschema: [1\n---\n');
      const state = await ctx.service.ensure();
      expect(state.status).toBe('invalid');
      expect(new MarkerWriteGuard(ctx.service).check()?.messageKey).toBe('storage.readOnly.invalid');
    });

    it('до чтения маркера запись запрещена', () => {
      const ctx = setup();
      expect(ctx.service.getState().status).toBe('unknown');
      expect(new MarkerWriteGuard(ctx.service).canWrite()).toBe(false);
    });
  });

  describe('флаг миграции', () => {
    it('поднимается и снимается; во время миграции обычная запись запрещена', async () => {
      const ctx = setup();
      await ctx.service.ensure();
      await ctx.service.setMigrating(true);
      expect(ctx.service.getState().status).toBe('migrating');
      expect(markerFrontmatter(ctx.app)?.['migrating']).toBe(true);
      expect(new MarkerWriteGuard(ctx.service).check()?.messageKey).toBe('storage.readOnly.migrating');
      expect(new MigrationWriteGuard(ctx.service).canWrite()).toBe(true);

      await ctx.service.setMigrating(false);
      expect(ctx.service.getState().status).toBe('ok');
      expect(new MarkerWriteGuard(ctx.service).canWrite()).toBe(true);
    });
  });

  describe('слежение', () => {
    it('уведомляет об изменении маркера другим устройством', async () => {
      const ctx = setup();
      await ctx.service.ensure();
      const states: string[] = [];
      ctx.service.onChange((s) => states.push(s.status));
      const stop = ctx.service.watch();
      const file = ctx.app.vault.getFileByPath(MARKER);
      if (!file) throw new Error('no marker');
      await ctx.app.vault.modify(file, '---\nroot: Планировщик\nschema: 3\nvault_id: VAULT1\nmigrating: false\n---\n');
      await ctx.queue.idle();
      expect(ctx.service.getState().status).toBe('newer');
      expect(states).toEqual(['newer']);
      stop();
    });
  });
});
