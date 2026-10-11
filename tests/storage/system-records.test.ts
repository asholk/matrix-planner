import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp, type App as MockApp } from '../__mocks__/obsidian';
import companionFixture from '../../fixtures/companion.json';
import tombstonesFixture from '../../fixtures/tombstones.json';
import type { Clock, WriteGuard } from '../../src/app/contracts';
import type { CompanionState } from '../../src/model/types';
import { createPlannerPaths } from '../../src/storage/paths';
import { AdapterSystemJsonStore } from '../../src/storage/system-json-store';
import { parseCompanion, parseTombstones, SystemCompanionStore, SystemTombstoneWriter } from '../../src/storage/system-records';
import { KeyedWriteQueue } from '../../src/storage/write-queue';

const SYSTEM = 'Планировщик/_system';
const TOMBSTONES = `${SYSTEM}/tombstones.json`;
const COMPANION = `${SYSTEM}/companion.json`;
const ID_A = '01JA2B3C4D5E6F7G8H9JKMNPQR';
const ID_B = '01JA2B3C4D5E6F7G8H9JKMNPQS';
const PROFILE = 'iphone-1179x2556';

function setup() {
  const app: MockApp = createMockApp();
  let writable = true;
  const guard: WriteGuard = {
    canWrite: () => writable,
    check: () => (writable ? null : { code: 'read-only', messageKey: 'storage.readOnly.newer' }),
  };
  const store = new AdapterSystemJsonStore(app as unknown as App, {
    getPaths: () => createPlannerPaths('Планировщик'),
    queue: new KeyedWriteQueue(),
    guard,
  });
  let now = new Date('2026-10-10T10:00:00.000Z');
  const clock: Clock = { now: () => now, timeZone: () => 'Europe/Moscow' };
  const tombstones = new SystemTombstoneWriter({ store, clock, deviceName: () => 'MacBook Air' });
  const companion = new SystemCompanionStore({ store });
  return {
    app,
    store,
    tombstones,
    companion,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
    setWritable: (value: boolean) => {
      writable = value;
    },
  };
}

function readJson(app: MockApp, path: string): Record<string, unknown> {
  const text = app.vault.contents.get(path);
  if (typeof text !== 'string') throw new Error(`no file ${path}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function fileText(app: MockApp, path: string): string | undefined {
  const value = app.vault.contents.get(path);
  return typeof value === 'string' ? value : undefined;
}

/** Сырой JSON компаньона для проверок сохранения чужих полей. */
interface CompanionJson {
  wallpapers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

describe('storage/system-records: tombstones.json', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('создаёт файл с версией и меткой', async () => {
    const result = await ctx.tombstones.add(ID_A, 'event');
    expect(result).toEqual({ ok: true, value: undefined, changed: true });
    expect(readJson(ctx.app, TOMBSTONES)).toEqual({
      version: 1,
      tombstones: [{ id: ID_A, kind: 'event', deleted_at: '2026-10-10T10:00:00.000Z', device_name: 'MacBook Air' }],
    });
  });

  it('идемпотентно: повторный id не дублируется и файл не переписывается', async () => {
    await ctx.tombstones.add(ID_A, 'event');
    const before = fileText(ctx.app, TOMBSTONES);
    ctx.setNow('2026-10-11T00:00:00.000Z');
    const again = await ctx.tombstones.add(ID_A, 'event');
    expect(again.ok && again.changed).toBe(false);
    expect(fileText(ctx.app, TOMBSTONES)).toBe(before);
    const listed = await ctx.tombstones.list();
    expect(listed.ok && listed.value).toEqual([{ id: ID_A, kind: 'event', deletedAt: '2026-10-10T10:00:00.000Z' }]);
  });

  it('объединяет с метками других устройств и сохраняет неизвестные поля', async () => {
    const foreign = { ...tombstonesFixture, extra: { from: 'companion' } };
    foreign.tombstones = [...foreign.tombstones, { id: 'x', kind: 'note', deleted_at: '2026-10-01T00:00:00Z' }];
    await ctx.app.vault.adapter.write(TOMBSTONES, JSON.stringify(foreign));
    await ctx.tombstones.add(ID_B, 'event');
    const written = readJson(ctx.app, TOMBSTONES);
    expect(written['extra']).toEqual({ from: 'companion' });
    const list = written['tombstones'] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(4);
    expect(list.slice(0, 3)).toEqual(foreign.tombstones);
    expect(list[3]?.['id']).toBe(ID_B);
  });

  it('метка с id из фикстуры уже есть — ничего не меняется', async () => {
    const text = JSON.stringify(tombstonesFixture);
    await ctx.app.vault.adapter.write(TOMBSTONES, text);
    const result = await ctx.tombstones.add(tombstonesFixture.tombstones[0].id, 'event');
    expect(result.ok && result.changed).toBe(false);
    expect(fileText(ctx.app, TOMBSTONES)).toBe(text);
  });

  it('параллельные add не теряют метки', async () => {
    await Promise.all([ctx.tombstones.add(ID_A, 'event'), ctx.tombstones.add(ID_B, 'event'), ctx.tombstones.add(ID_A, 'event')]);
    const listed = await ctx.tombstones.list();
    expect(listed.ok && listed.value.map((r) => r.id).sort()).toEqual([ID_A, ID_B]);
  });

  it('повреждённый файл не перезаписывается → tombstone-failed', async () => {
    await ctx.app.vault.adapter.write(TOMBSTONES, '{"tombstones": [');
    const result = await ctx.tombstones.add(ID_A, 'event');
    expect(!result.ok && result.error.code).toBe('tombstone-failed');
    expect(!result.ok && result.error.messageKey).toBe('cache.errors.tombstonesCorrupt');
    expect(fileText(ctx.app, TOMBSTONES)).toBe('{"tombstones": [');
    const listed = await ctx.tombstones.list();
    expect(!listed.ok && listed.error.code).toBe('invalid');
    expect(await ctx.tombstones.has(ID_A)).toBe(false);
  });

  it('tombstones не массив → ошибка, файл не меняется', async () => {
    await ctx.app.vault.adapter.write(TOMBSTONES, '{"version":1,"tombstones":{}}');
    const result = await ctx.tombstones.add(ID_A, 'event');
    expect(!result.ok && result.error.code).toBe('tombstone-failed');
    expect(fileText(ctx.app, TOMBSTONES)).toBe('{"version":1,"tombstones":{}}');
  });

  it('новая версия файла — запись запрещена', async () => {
    await ctx.app.vault.adapter.write(TOMBSTONES, '{"version":2,"tombstones":[]}');
    const result = await ctx.tombstones.add(ID_A, 'event');
    expect(!result.ok && result.error.code).toBe('tombstone-failed');
    expect(!result.ok && result.error.messageKey).toBe('cache.errors.tombstonesNewer');
    expect(fileText(ctx.app, TOMBSTONES)).toBe('{"version":2,"tombstones":[]}');
  });

  it('режим только чтения → read-only', async () => {
    ctx.setWritable(false);
    const result = await ctx.tombstones.add(ID_A, 'event');
    expect(!result.ok && result.error.code).toBe('read-only');
  });

  it('пустой id → invalid', async () => {
    const result = await ctx.tombstones.add('  ', 'event');
    expect(!result.ok && result.error.code).toBe('invalid');
  });

  it('list: нет файла → пустой список; has', async () => {
    const empty = await ctx.tombstones.list();
    expect(empty.ok && empty.value).toEqual([]);
    await ctx.tombstones.add(ID_A, 'event');
    expect(await ctx.tombstones.has(ID_A)).toBe(true);
    expect(await ctx.tombstones.has(ID_B)).toBe(false);
  });

  it('parseTombstones: пропускает битые и чужие типы, дубли — самая ранняя', () => {
    expect(
      parseTombstones({
        tombstones: [
          { id: ID_A, kind: 'event', deleted_at: '2026-10-10T00:00:00Z' },
          { id: ID_A, kind: 'event', deleted_at: '2026-10-09T00:00:00Z' },
          { id: ID_B, kind: 'event', deleted_at: 'bad' },
          { id: 'n', kind: 'note', deleted_at: '2026-10-09T00:00:00Z' },
          { kind: 'event' },
          42,
        ],
      }),
    ).toEqual([
      { id: ID_A, kind: 'event', deletedAt: '2026-10-09T00:00:00Z' },
      { id: ID_B, kind: 'event', deletedAt: '' },
    ]);
    expect(parseTombstones({})).toEqual([]);
    expect(parseTombstones({ tombstones: 'x' })).toBeNull();
    expect(parseTombstones([])).toBeNull();
  });
});

describe('storage/system-records: companion.json', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('read: нет файла / повреждён / фикстура', async () => {
    expect(await ctx.companion.read()).toEqual({ status: 'missing' });
    await ctx.app.vault.adapter.write(COMPANION, '{oops');
    expect((await ctx.companion.read()).status).toBe('corrupt');
    await ctx.app.vault.adapter.write(COMPANION, JSON.stringify(companionFixture));
    const state = await ctx.companion.read();
    expect(state.status).toBe('ok');
    if (state.status !== 'ok') return;
    expect(state.primaryDevice).toBe('iPhone Александра');
    expect(state.lastUpdate).toBe('2026-10-10T06:05:12Z');
    expect(state.wallpapers[PROFILE]).toEqual({
      profileId: PROFILE,
      savedAt: '2026-10-10T10:32:05.000Z',
      launchedAt: '2026-10-10T10:32:06.000Z',
      confirmedAt: '2026-10-10T10:32:09.000Z',
      failedAt: null,
      deviceName: 'iPhone Александра',
      cancelledAt: null,
      errorMessage: null,
      runId: null,
      fingerprint: null,
    });
    expect(state.wallpapers['ipad-2048x2732']?.failedAt).toBe('2026-10-09T21:00:04.000Z');
    expect(ctx.companion.getState()).toBe(state);
  });

  it('сохраняет чужие поля, другие профили и неизвестные поля профиля', async () => {
    const original = JSON.parse(JSON.stringify(companionFixture)) as CompanionJson;
    original['wallpapers'][PROFILE]['future_flag'] = true;
    await ctx.app.vault.adapter.write(COMPANION, JSON.stringify(original));
    const result = await ctx.companion.updateWallpaperStatus(PROFILE, { launchedAt: '2026-10-10T11:00:00.000Z', deviceName: 'iPhone' });
    expect(result.ok && result.changed).toBe(true);
    const written = readJson(ctx.app, COMPANION) as CompanionJson;
    expect(written['primary_device']).toBe(original['primary_device']);
    expect(written['last_update']).toBe(original['last_update']);
    expect(written['reminders']).toEqual(original['reminders']);
    expect(written['devices']).toEqual(original['devices']);
    expect(written['wallpapers']['ipad-2048x2732']).toEqual(original['wallpapers']['ipad-2048x2732']);
    expect(written['wallpapers'][PROFILE]).toEqual({
      ...original['wallpapers'][PROFILE],
      launched_at: '2026-10-10T11:00:00.000Z',
      device_name: 'iPhone',
    });
  });

  it('saved/launched/confirmed/failed — разные поля; null очищает, undefined не трогает', async () => {
    await ctx.companion.updateWallpaperStatus(PROFILE, { savedAt: '2026-10-10T10:00:00.000Z' });
    await ctx.companion.updateWallpaperStatus(PROFILE, { launchedAt: '2026-10-10T10:00:01.000Z' });
    await ctx.companion.updateWallpaperStatus(PROFILE, { failedAt: '2026-10-10T10:00:05.000Z' });
    await ctx.companion.updateWallpaperStatus(PROFILE, { confirmedAt: '2026-10-10T10:01:00.000Z', failedAt: null });
    const written = readJson(ctx.app, COMPANION);
    expect(written).toEqual({
      version: 1,
      wallpapers: {
        [PROFILE]: {
          saved_at: '2026-10-10T10:00:00.000Z',
          launched_at: '2026-10-10T10:00:01.000Z',
          failed_at: null,
          confirmed_at: '2026-10-10T10:01:00.000Z',
        },
      },
    });
    const state = ctx.companion.getState();
    expect(state.status === 'ok' && state.wallpapers[PROFILE]).toEqual({
      profileId: PROFILE,
      savedAt: '2026-10-10T10:00:00.000Z',
      launchedAt: '2026-10-10T10:00:01.000Z',
      confirmedAt: '2026-10-10T10:01:00.000Z',
      failedAt: null,
      deviceName: null,
      cancelledAt: null,
      errorMessage: null,
      runId: null,
      fingerprint: null,
    });
  });

  it('007: cancelled_at, error_message, run_id и fingerprint пишутся и читаются', async () => {
    await ctx.companion.updateWallpaperStatus(PROFILE, { savedAt: '2026-10-10T10:00:00.000Z', fingerprint: 'v2-2026-10-10-0123456789abcdef' });
    await ctx.companion.updateWallpaperStatus(PROFILE, { launchedAt: '2026-10-10T10:00:01.000Z', runId: 'mf3k2-0a1b' });
    await ctx.companion.updateWallpaperStatus(PROFILE, { failedAt: '2026-10-10T10:00:05.000Z', errorMessage: 'Нет доступа к папке', runId: null });
    await ctx.companion.updateWallpaperStatus(PROFILE, { cancelledAt: '2026-10-10T10:02:00.000Z' });
    expect(readJson(ctx.app, COMPANION)).toEqual({
      version: 1,
      wallpapers: {
        [PROFILE]: {
          saved_at: '2026-10-10T10:00:00.000Z',
          fingerprint: 'v2-2026-10-10-0123456789abcdef',
          launched_at: '2026-10-10T10:00:01.000Z',
          run_id: null,
          failed_at: '2026-10-10T10:00:05.000Z',
          error_message: 'Нет доступа к папке',
          cancelled_at: '2026-10-10T10:02:00.000Z',
        },
      },
    });
    const state = ctx.companion.getState();
    const record = state.status === 'ok' ? state.wallpapers[PROFILE] : null;
    expect(record).toMatchObject({
      fingerprint: 'v2-2026-10-10-0123456789abcdef',
      runId: null,
      errorMessage: 'Нет доступа к папке',
      cancelledAt: '2026-10-10T10:02:00.000Z',
    });
    const bad = await ctx.companion.updateWallpaperStatus(PROFILE, { cancelledAt: 'вчера' });
    expect(!bad.ok && bad.error.code).toBe('invalid');
    const badText = await ctx.companion.updateWallpaperStatus(PROFILE, { runId: 5 as unknown as string });
    expect(!badText.ok && badText.error.code).toBe('invalid');
  });

  it('повторная запись того же значения — changed: false', async () => {
    await ctx.companion.updateWallpaperStatus(PROFILE, { savedAt: '2026-10-10T10:00:00.000Z' });
    const again = await ctx.companion.updateWallpaperStatus(PROFILE, { savedAt: '2026-10-10T10:00:00.000Z' });
    expect(again.ok && again.changed).toBe(false);
  });

  it('повреждённый файл и wallpapers не объект — ничего не пишется', async () => {
    await ctx.app.vault.adapter.write(COMPANION, '{broken');
    const corrupt = await ctx.companion.updateWallpaperStatus(PROFILE, { savedAt: '2026-10-10T10:00:00.000Z' });
    expect(!corrupt.ok && corrupt.error.code).toBe('invalid');
    expect(!corrupt.ok && corrupt.error.messageKey).toBe('cache.errors.companionCorrupt');
    expect(fileText(ctx.app, COMPANION)).toBe('{broken');

    await ctx.app.vault.adapter.write(COMPANION, '{"version":1,"wallpapers":[]}');
    const shape = await ctx.companion.updateWallpaperStatus(PROFILE, { savedAt: '2026-10-10T10:00:00.000Z' });
    expect(!shape.ok && shape.error.code).toBe('invalid');
    expect(fileText(ctx.app, COMPANION)).toBe('{"version":1,"wallpapers":[]}');
  });

  it('новая версия файла — запись запрещена', async () => {
    await ctx.app.vault.adapter.write(COMPANION, '{"version":3}');
    const result = await ctx.companion.updateWallpaperStatus(PROFILE, { savedAt: '2026-10-10T10:00:00.000Z' });
    expect(!result.ok && result.error.code).toBe('read-only');
    expect(!result.ok && result.error.messageKey).toBe('cache.errors.companionNewer');
    expect(fileText(ctx.app, COMPANION)).toBe('{"version":3}');
  });

  it('проверка аргументов', async () => {
    for (const id of ['', '__proto__', 'constructor']) {
      const result = await ctx.companion.updateWallpaperStatus(id, { savedAt: '2026-10-10T10:00:00.000Z' });
      expect(!result.ok && result.error.code).toBe('invalid');
    }
    const badTime = await ctx.companion.updateWallpaperStatus(PROFILE, { savedAt: 'сегодня' });
    expect(!badTime.ok && badTime.error.code).toBe('invalid');
    expect(await ctx.app.vault.adapter.exists(COMPANION)).toBe(false);
  });

  it('onChange и watch: изменение компаньоном перечитывается', async () => {
    const off = ctx.companion.watch(ctx.app as unknown as App);
    const listener = vi.fn();
    ctx.companion.onChange(listener);
    const changed = new Promise<CompanionState>((resolve) => ctx.companion.onChange(resolve));
    await ctx.app.vault.adapter.write(COMPANION, JSON.stringify({ version: 1, primary_device: 'iPad' }));
    const state = await changed;
    expect(state.status === 'ok' && state.primaryDevice).toBe('iPad');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('parseCompanion: некорректное время → null, битые профили пропускаются', () => {
    const state = parseCompanion({
      last_update: 'вчера',
      wallpapers: { a: { saved_at: 'x', device_name: 5 }, b: 'bad' },
    });
    expect(state).toEqual({
      status: 'ok',
      primaryDevice: null,
      lastUpdate: null,
      wallpapers: {
        a: {
          profileId: 'a',
          savedAt: null,
          launchedAt: null,
          confirmedAt: null,
          failedAt: null,
          deviceName: null,
          cancelledAt: null,
          errorMessage: null,
          runId: null,
          fingerprint: null,
        },
      },
    });
    expect(parseCompanion([]).status).toBe('corrupt');
  });
});

describe('storage/system-records: финальные исправления', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('запись с тем же id, но без kind: event — tombstone-failed, файл не меняется', async () => {
    for (const entry of [{ id: ID_A }, { id: ID_A, kind: 'note', deleted_at: '2026-10-01T00:00:00Z' }]) {
      const text = JSON.stringify({ version: 1, tombstones: [entry] });
      await ctx.app.vault.adapter.write(TOMBSTONES, text);
      const result = await ctx.tombstones.add(ID_A, 'event');
      expect(!result.ok && result.error.code).toBe('tombstone-failed');
      expect(fileText(ctx.app, TOMBSTONES)).toBe(text);
      expect(await ctx.tombstones.has(ID_A)).toBe(false);
    }
  });

  it('повреждённая запись рядом с полноценной меткой того же id — метка готова', async () => {
    const text = JSON.stringify({ version: 1, tombstones: [{ id: ID_A }, { id: ID_A, kind: 'event', deleted_at: '2026-10-01T00:00:00Z' }] });
    await ctx.app.vault.adapter.write(TOMBSTONES, text);
    const result = await ctx.tombstones.add(ID_A, 'event');
    expect(result.ok && result.changed).toBe(false);
    expect(await ctx.tombstones.has(ID_A)).toBe(true);
  });

  it('onChange оповещает о новой метке, но не о повторной', async () => {
    const listener = vi.fn();
    ctx.tombstones.onChange(listener);
    await ctx.tombstones.add(ID_A, 'event');
    await ctx.tombstones.add(ID_A, 'event');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('запоздалое чтение не заменяет состояние после updateWallpaperStatus', async () => {
    await ctx.app.vault.adapter.write(COMPANION, JSON.stringify({ version: 1, wallpapers: {} }));
    const realRead = ctx.store.read.bind(ctx.store);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Чтение получает старое содержимое, но завершается после записи.
    const spy = vi.spyOn(ctx.store, 'read').mockImplementationOnce(async (name) => {
      const old = await realRead(name);
      await gate;
      return old;
    });
    const pending = ctx.companion.read();
    expect((await ctx.companion.updateWallpaperStatus(PROFILE, { savedAt: '2026-10-10T10:00:00Z' })).ok).toBe(true);
    release();
    const state = await pending;
    spy.mockRestore();
    const current = ctx.companion.getState();
    expect(current.status === 'ok' && current.wallpapers[PROFILE]?.savedAt).toBe('2026-10-10T10:00:00Z');
    expect(state).toBe(current);
  });
});
