import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp, splitFrontmatter, type App as MockApp } from '../__mocks__/obsidian';
import type { Clock, MarkerService } from '../../src/app/contracts';
import type { MarkerState } from '../../src/model/types';
import { MarkerWriteGuard, MigrationWriteGuard } from '../../src/storage/marker';
import { ObsidianNoteRepository } from '../../src/storage/note-repository';
import { createPlannerPaths } from '../../src/storage/paths';
import { AdapterSystemJsonStore } from '../../src/storage/system-json-store';
import { KeyedWriteQueue } from '../../src/storage/write-queue';
import {
  createVaultMigrationDeps,
  MIGRATIONS,
  needsMigration,
  runMigrations,
  type Migration,
  type MigrationDeps,
} from '../../src/integrity/migrations';

const ROOT = 'Планировщик';
const T = `${ROOT}/Задачи`;
const BACKUP = `${ROOT}/_system/migration-2.json`;
const paths = createPlannerPaths(ROOT);
const clock: Clock = { now: () => new Date('2026-10-10T12:00:00Z'), timeZone: () => 'UTC' };

/** Тестовая миграция 1 → 2: `old_prop` переименовывается в `new_prop`. Идемпотентна. */
const renameMigration: Migration = {
  to: 2,
  plan: ({ frontmatter }) => {
    if (frontmatter['type'] !== 'task' || !('old_prop' in frontmatter)) return null;
    return { new_prop: frontmatter['old_prop'], old_prop: undefined };
  },
};

function fakeMarker(initial: { schema: number; migrating: boolean }, target = 2) {
  const m = { ...initial };
  const calls: boolean[] = [];
  const status = (): MarkerState['status'] =>
    m.schema > target ? 'newer' : m.migrating ? 'migrating' : m.schema < target ? 'needs-migration' : 'ok';
  const marker: Pick<MarkerService, 'getState' | 'setMigrating'> = {
    getState: () => ({ status: status(), marker: { root: ROOT, schema: m.schema, vault_id: 'V', migrating: m.migrating }, issues: [] }),
    setMigrating: async (value) => {
      calls.push(value);
      m.migrating = value;
    },
  };
  return { marker, m, calls };
}

function note(oldProp: string | null, extra: string[] = []): string {
  return ['---', 'type: task', 'id: X', 'quadrant: do', ...(oldProp ? [`old_prop: ${oldProp}`] : []), ...extra, '---', 'Тело заметки', ''].join('\n');
}

async function setup(files: Record<string, string>, markerInit: { schema: number; migrating: boolean }) {
  const app: MockApp = createMockApp();
  await app.vault.create('matrix-planner.md', `---\nroot: ${ROOT}\nschema: ${markerInit.schema}\nvault_id: V\nmigrating: ${markerInit.migrating}\n---\n`);
  for (const [path, text] of Object.entries(files)) await app.vault.create(path, text);
  const fake = fakeMarker(markerInit);
  const queue = new KeyedWriteQueue();
  const base = createVaultMigrationDeps(app as unknown as App, {
    getPaths: () => paths,
    queue,
    marker: fake.marker,
    clock,
    migrations: [renameMigration],
    targetVersion: 2,
  });
  const log: string[] = [];
  const deps: MigrationDeps = {
    ...base,
    writeSchema: async (version) => {
      await base.writeSchema(version);
      fake.m.schema = version;
      log.push(`schema:${version}`);
    },
    systemJson: {
      read: (name) => base.systemJson.read(name),
      update: async (name, mutate) => {
        log.push(`backup:${name}`);
        return base.systemJson.update(name, mutate);
      },
    },
    repository: {
      updateFrontmatter: async (path, mutate) => {
        log.push(`note:${path}`);
        return base.repository.updateFrontmatter(path, mutate);
      },
    },
  };
  return { app, fake, deps, log, queue };
}

function fm(app: MockApp, path: string): Record<string, unknown> {
  const text = app.vault.contents.get(path);
  if (typeof text !== 'string') throw new Error(`no file ${path}`);
  return splitFrontmatter(text).frontmatter ?? {};
}

interface BackupJson {
  notes: Record<string, Record<string, unknown> | undefined>;
  [key: string]: unknown;
}

function backup(app: MockApp): BackupJson {
  const text = app.vault.contents.get(BACKUP);
  if (typeof text !== 'string') throw new Error('no backup');
  return JSON.parse(text) as BackupJson;
}

describe('integrity/migrations', () => {
  it('список миграций плагина пуст; на текущей схеме ничего не пишется', async () => {
    expect(MIGRATIONS).toEqual([]);
    const ctx = await setup({ [`${T}/A.md`]: note('x') }, { schema: 1, migrating: false });
    const result = await runMigrations({ ...ctx.deps, migrations: undefined, targetVersion: undefined });
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(ctx.log).toEqual([]);
    expect(ctx.fake.calls).toEqual([]);
  });

  it('needsMigration: старая схема и прерванная миграция', () => {
    const state = (status: MarkerState['status']): MarkerState => ({ status, marker: null, issues: [] });
    expect(needsMigration(state('needs-migration'))).toBe(true);
    expect(needsMigration(state('migrating'))).toBe(true);
    expect(needsMigration(state('ok'))).toBe(false);
    expect(needsMigration(state('newer'))).toBe(false);
  });

  it('резервная копия свойств пишется до изменения заметок; затем схема и снятие флага', async () => {
    const ctx = await setup(
      {
        [`${T}/A.md`]: note('alpha', ['custom: оставить']),
        [`${T}/B.md`]: note(null),
      },
      { schema: 1, migrating: false },
    );
    const result = await runMigrations(ctx.deps);
    expect(result).toMatchObject({ ok: true, value: { from: 1, to: 2, changedNotes: 1 } });

    // Порядок: копия → заметка → отметка «done» → схема.
    expect(ctx.log).toEqual(['backup:migration-2.json', `note:${T}/A.md`, 'backup:migration-2.json', 'schema:2']);
    expect(ctx.fake.calls).toEqual([true, false]);

    const data = backup(ctx.app);
    expect(data['status']).toBe('done');
    expect(data['version']).toBe(2);
    expect(data['from']).toBe(1);
    expect(data['notes'][`${T}/A.md`]).toEqual({ before: { old_prop: 'alpha' }, missing: ['new_prop'], done: true });
    expect(data['notes'][`${T}/B.md`]).toBeUndefined();

    const a = fm(ctx.app, `${T}/A.md`);
    expect(a['new_prop']).toBe('alpha');
    expect('old_prop' in a).toBe(false);
    expect(a['custom']).toBe('оставить');
    expect(ctx.app.vault.contents.get(`${T}/A.md`)).toContain('Тело заметки');
    expect(fm(ctx.app, 'matrix-planner.md')['schema']).toBe(2);
  });

  it('возобновление после прерывания: флаг остаётся, исходные значения в копии не теряются', async () => {
    const ctx = await setup(
      { [`${T}/A.md`]: note('alpha'), [`${T}/B.md`]: note('beta') },
      { schema: 1, migrating: false },
    );
    ctx.app.vault.failNextWrite(`${T}/B.md`);
    const first = await runMigrations(ctx.deps);
    expect(first.ok).toBe(false);
    expect(ctx.fake.m.migrating).toBe(true);
    expect(ctx.fake.m.schema).toBe(1);
    expect(backup(ctx.app)['status']).toBe('in-progress');
    expect(fm(ctx.app, `${T}/A.md`)['new_prop']).toBe('alpha');
    expect(fm(ctx.app, `${T}/B.md`)['old_prop']).toBe('beta');

    ctx.log.length = 0;
    const second = await runMigrations(ctx.deps);
    expect(second).toMatchObject({ ok: true, value: { from: 1, to: 2, changedNotes: 1 } });
    // Флаг уже поднят — повторно не поднимается, в конце снимается.
    expect(ctx.fake.calls).toEqual([true, false]);
    expect(ctx.log).not.toContain(`note:${T}/A.md`);

    const data = backup(ctx.app);
    expect(data['status']).toBe('done');
    expect(data['notes'][`${T}/A.md`]?.['before']).toEqual({ old_prop: 'alpha' });
    expect(data['notes'][`${T}/B.md`]?.['before']).toEqual({ old_prop: 'beta' });
    expect(fm(ctx.app, `${T}/B.md`)['new_prop']).toBe('beta');
    expect(fm(ctx.app, 'matrix-planner.md')['schema']).toBe(2);
  });

  it('прерывание после записи схемы: повторный запуск только снимает флаг', async () => {
    const ctx = await setup({ [`${T}/A.md`]: note(null, ['new_prop: alpha']) }, { schema: 2, migrating: true });
    const result = await runMigrations(ctx.deps);
    expect(result).toMatchObject({ ok: true, value: { from: 2, to: 2, changedNotes: 0 } });
    expect(ctx.fake.calls).toEqual([false]);
    expect(ctx.log).toEqual([]);
  });

  it('готовая копия шага (status: done) не перезаписывается, шаг завершается записью схемы', async () => {
    const ctx = await setup({ [`${T}/A.md`]: note(null, ['new_prop: alpha']) }, { schema: 1, migrating: true });
    await ctx.app.vault.adapter.write(BACKUP, JSON.stringify({ version: 2, status: 'done', notes: { x: 1 } }));
    const result = await runMigrations(ctx.deps);
    expect(result.ok).toBe(true);
    expect(ctx.log).toEqual(['schema:2']);
    expect(backup(ctx.app)['notes']).toEqual({ x: 1 });
  });

  it('повреждённая резервная копия не перезаписывается', async () => {
    const ctx = await setup({ [`${T}/A.md`]: note('alpha') }, { schema: 1, migrating: true });
    await ctx.app.vault.adapter.write(BACKUP, '{ broken');
    const result = await runMigrations(ctx.deps);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(ctx.app.vault.contents.get(BACKUP)).toBe('{ broken');
    expect(fm(ctx.app, `${T}/A.md`)['old_prop']).toBe('alpha');
    expect(ctx.fake.m.migrating).toBe(true);
  });

  it('повреждённый YAML заметки прерывает миграцию: схема не повышается, заметки не меняются', async () => {
    const ctx = await setup(
      {
        [`${T}/A.md`]: note('alpha'),
        [`${T}/Broken.md`]: ['---', 'type: task', 'old_prop: [oops', '---', 'Тело', ''].join('\n'),
        [`${T}/Plain.md`]: 'Заметка без свойств\n',
      },
      { schema: 1, migrating: false },
    );
    const result = await runMigrations(ctx.deps);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(!result.ok && result.error.detail).toContain('Broken.md');
    expect(fm(ctx.app, `${T}/A.md`)['old_prop']).toBe('alpha');
    expect(ctx.log).toEqual([]);
    expect(ctx.fake.m.schema).toBe(1);
    expect(ctx.fake.m.migrating).toBe(true);
  });

  it('нечитаемая заметка прерывает миграцию', async () => {
    const ctx = await setup({ [`${T}/A.md`]: note('alpha'), [`${T}/B.md`]: note('beta') }, { schema: 1, migrating: false });
    const vault = ctx.app.vault as unknown as { read(file: { path: string }): Promise<string> };
    const read = vault.read.bind(vault);
    vault.read = async (file) => {
      if (file.path === `${T}/B.md`) throw new Error('EIO');
      return read(file);
    };
    const result = await runMigrations(ctx.deps);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(fm(ctx.app, `${T}/A.md`)['old_prop']).toBe('alpha');
    expect(ctx.fake.m.schema).toBe(1);
  });

  it('заметка без блока свойств не мешает миграции', async () => {
    const ctx = await setup({ [`${T}/A.md`]: note('alpha'), [`${T}/Plain.md`]: 'Просто текст\n' }, { schema: 1, migrating: false });
    const result = await runMigrations(ctx.deps);
    expect(result).toMatchObject({ ok: true, value: { changedNotes: 1 } });
    expect(ctx.fake.m.schema).toBe(2);
  });

  it('новая схема: только чтение, ничего не пишется', async () => {
    const ctx = await setup({ [`${T}/A.md`]: note('alpha') }, { schema: 3, migrating: false });
    const result = await runMigrations(ctx.deps);
    expect(result).toMatchObject({ ok: false, error: { code: 'read-only' } });
    expect(ctx.log).toEqual([]);
    expect(ctx.fake.calls).toEqual([]);
    expect(ctx.app.vault.contents.has(BACKUP)).toBe(false);
    expect(fm(ctx.app, `${T}/A.md`)['old_prop']).toBe('alpha');
  });

  it('нет шага миграции до нужной версии — ошибка без записи', async () => {
    const ctx = await setup({ [`${T}/A.md`]: note('alpha') }, { schema: 1, migrating: false });
    const result = await runMigrations({ ...ctx.deps, migrations: [], targetVersion: 2 });
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(ctx.fake.calls).toEqual([]);
  });

  it('MigrationWriteGuard: пишет при миграции, но не при новой схеме; обычный запрет при миграции блокирует', async () => {
    const app = createMockApp();
    await app.vault.create(`${T}/A.md`, note('alpha'));
    const state: { current: MarkerState } = {
      current: { status: 'migrating', marker: { root: ROOT, schema: 1, vault_id: 'V', migrating: true }, issues: [] },
    };
    const marker = { getState: () => state.current };
    const queue = new KeyedWriteQueue();
    const normalGuard = new MarkerWriteGuard(marker);
    const migrationGuard = new MigrationWriteGuard(marker);
    const normalRepo = new ObsidianNoteRepository(app as unknown as App, { getPaths: () => paths, guard: normalGuard, queue });
    const migrationRepo = new ObsidianNoteRepository(app as unknown as App, { getPaths: () => paths, guard: migrationGuard, queue });
    const store = new AdapterSystemJsonStore(app as unknown as App, { getPaths: () => paths, queue, guard: normalGuard, migrationGuard });

    expect((await normalRepo.updateFrontmatter(`${T}/A.md`, (f) => void (f['x'] = 1))).ok).toBe(false);
    expect((await migrationRepo.updateFrontmatter(`${T}/A.md`, (f) => void (f['x'] = 1))).ok).toBe(true);
    expect((await store.write('migration-2.json', { ok: true })).ok).toBe(true);
    expect((await store.write('tombstones.json', { tombstones: [] })).ok).toBe(false);

    state.current = { status: 'newer', marker: { root: ROOT, schema: 3, vault_id: 'V', migrating: false }, issues: [] };
    expect((await migrationRepo.updateFrontmatter(`${T}/A.md`, (f) => void (f['x'] = 2))).ok).toBe(false);
    expect((await store.write('migration-3.json', { ok: true })).ok).toBe(false);
    expect(fm(app, `${T}/A.md`)['x']).toBe(1);
  });
});
