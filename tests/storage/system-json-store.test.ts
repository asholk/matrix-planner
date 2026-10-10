import { beforeEach, describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp, type App as MockApp } from '../__mocks__/obsidian';
import type { WriteGuard } from '../../src/app/contracts';
import { createPlannerPaths } from '../../src/storage/paths';
import { AdapterSystemJsonStore, isSystemJsonName, parseSystemJson } from '../../src/storage/system-json-store';
import { KeyedWriteQueue } from '../../src/storage/write-queue';

const SYSTEM = 'Планировщик/_system';

function flagGuard(initial: boolean): WriteGuard & { set(value: boolean): void } {
  let writable = initial;
  return {
    set: (value) => {
      writable = value;
    },
    canWrite: () => writable,
    check: () => (writable ? null : { code: 'read-only', messageKey: 'storage.readOnly.newer' }),
  };
}

function setup() {
  const app: MockApp = createMockApp();
  const guard = flagGuard(true);
  const migrationGuard = flagGuard(true);
  const queue = new KeyedWriteQueue();
  const store = new AdapterSystemJsonStore(app as unknown as App, {
    getPaths: () => createPlannerPaths('Планировщик'),
    queue,
    guard,
    migrationGuard,
  });
  return { app, store, guard, migrationGuard, queue };
}

function fileText(app: MockApp, path: string): string | undefined {
  const value = app.vault.contents.get(path);
  return typeof value === 'string' ? value : undefined;
}

describe('storage/system-json-store', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  describe('разбор', () => {
    it('различает повреждение и пустой файл', () => {
      expect(parseSystemJson('{"a":1}')).toEqual({ status: 'ok', value: { a: 1 } });
      expect(parseSystemJson('﻿{"a":1}')).toEqual({ status: 'ok', value: { a: 1 } });
      expect(parseSystemJson('').status).toBe('corrupt');
      expect(parseSystemJson('{"a":').status).toBe('corrupt');
    });

    it('допустимые имена', () => {
      expect(isSystemJsonName('tombstones.json')).toBe(true);
      expect(isSystemJsonName('migration-2.json')).toBe(true);
      expect(isSystemJsonName('../data.json')).toBe(false);
      expect(isSystemJsonName('other.json')).toBe(false);
    });
  });

  describe('чтение', () => {
    it('путь в _system', () => {
      expect(ctx.store.path('companion.json')).toBe(`${SYSTEM}/companion.json`);
    });

    it('отсутствующий файл', async () => {
      expect(await ctx.store.read('tombstones.json')).toEqual({ status: 'missing' });
    });

    it('повреждённый JSON', async () => {
      await ctx.app.vault.adapter.write(`${SYSTEM}/companion.json`, '{"primary_device": ');
      const result = await ctx.store.read('companion.json');
      expect(result.status).toBe('corrupt');
    });

    it('корректный JSON', async () => {
      await ctx.app.vault.adapter.write(`${SYSTEM}/companion.json`, '{"version":1}');
      expect(await ctx.store.read('companion.json')).toEqual({ status: 'ok', value: { version: 1 } });
    });
  });

  describe('изменение', () => {
    it('сохраняет неизвестные поля', async () => {
      const original = { version: 1, primary_device: 'iPhone', future_field: { nested: [1, 2] }, wallpapers: { old: { saved_at: 'x' } } };
      await ctx.app.vault.adapter.write(`${SYSTEM}/companion.json`, JSON.stringify(original));
      const result = await ctx.store.update('companion.json', (current) => {
        const wallpapers = { ...(current?.['wallpapers'] as Record<string, unknown>) };
        wallpapers['iphone'] = { saved_at: '2026-10-10T10:00:00Z' };
        return { ...current, wallpapers };
      });
      expect(result.ok && result.changed).toBe(true);
      const written = JSON.parse(fileText(ctx.app, `${SYSTEM}/companion.json`) ?? '') as Record<string, unknown>;
      expect(written).toEqual({
        version: 1,
        primary_device: 'iPhone',
        future_field: { nested: [1, 2] },
        wallpapers: { old: { saved_at: 'x' }, iphone: { saved_at: '2026-10-10T10:00:00Z' } },
      });
    });

    it('отсутствующий файл: current = null, файл и папка создаются', async () => {
      let seen: unknown = 'not called';
      const result = await ctx.store.update('tombstones.json', (current) => {
        seen = current;
        return { version: 1, items: [] };
      });
      expect(seen).toBeNull();
      expect(result.ok).toBe(true);
      expect(JSON.parse(fileText(ctx.app, `${SYSTEM}/tombstones.json`) ?? '')).toEqual({ version: 1, items: [] });
    });

    it('повреждённый файл не перезаписывается', async () => {
      await ctx.app.vault.adapter.write(`${SYSTEM}/tombstones.json`, '{broken');
      let called = false;
      const result = await ctx.store.update('tombstones.json', () => {
        called = true;
        return {};
      });
      expect(called).toBe(false);
      expect(!result.ok && result.error.code).toBe('invalid');
      expect(fileText(ctx.app, `${SYSTEM}/tombstones.json`)).toBe('{broken');
    });

    it('JSON не объект — ошибка, файл не меняется', async () => {
      await ctx.app.vault.adapter.write(`${SYSTEM}/tombstones.json`, '[1,2]');
      const result = await ctx.store.update('tombstones.json', () => ({}));
      expect(!result.ok && result.error.code).toBe('invalid');
      expect(fileText(ctx.app, `${SYSTEM}/tombstones.json`)).toBe('[1,2]');
    });

    it('без изменений → changed: false, файл не переписывается', async () => {
      await ctx.app.vault.adapter.write(`${SYSTEM}/tombstones.json`, '{"version":1}');
      const result = await ctx.store.update('tombstones.json', (current) => ({ ...current }));
      expect(result.ok && result.changed).toBe(false);
      expect(fileText(ctx.app, `${SYSTEM}/tombstones.json`)).toBe('{"version":1}');
    });

    it('параллельные изменения сериализуются и перечитывают файл', async () => {
      await ctx.app.vault.adapter.write(`${SYSTEM}/tombstones.json`, '{"count":0}');
      const increment = (current: Record<string, unknown> | null) => ({ ...current, count: Number(current?.['count'] ?? 0) + 1 });
      await Promise.all([1, 2, 3, 4, 5].map(() => ctx.store.update('tombstones.json', increment)));
      expect(JSON.parse(fileText(ctx.app, `${SYSTEM}/tombstones.json`) ?? '')).toEqual({ count: 5 });
    });

    it('сбой записи → write-failed', async () => {
      ctx.app.vault.failNextWrite(`${SYSTEM}/tombstones.json`);
      const result = await ctx.store.write('tombstones.json', { version: 1 });
      expect(!result.ok && result.error.code).toBe('write-failed');
    });
  });

  describe('запреты', () => {
    it('calendar-cache.json никогда не записывается', async () => {
      const update = await ctx.store.update('calendar-cache.json', () => ({ version: 1 }));
      const write = await ctx.store.write('calendar-cache.json', { version: 1 });
      expect(!update.ok && update.error.code).toBe('read-only');
      expect(!write.ok && write.error.code).toBe('read-only');
      expect(await ctx.app.vault.adapter.exists(`${SYSTEM}/calendar-cache.json`)).toBe(false);
    });

    it('новая схема запрещает запись, чтение разрешено', async () => {
      await ctx.app.vault.adapter.write(`${SYSTEM}/companion.json`, '{"version":1}');
      ctx.guard.set(false);
      const result = await ctx.store.update('companion.json', (current) => ({ ...current, x: 1 }));
      expect(!result.ok && result.error.code).toBe('read-only');
      expect(!result.ok && result.error.messageKey).toBe('storage.readOnly.newer');
      expect(await ctx.store.read('companion.json')).toEqual({ status: 'ok', value: { version: 1 } });
    });

    it('файл резервной копии миграции использует отдельный запрет', async () => {
      ctx.guard.set(false);
      expect((await ctx.store.write('migration-2.json', { schema_from: 1 })).ok).toBe(true);
      ctx.migrationGuard.set(false);
      expect((await ctx.store.write('migration-2.json', { schema_from: 1 })).ok).toBe(false);
    });
  });
});

describe('storage/write-queue', () => {
  it('задания одного ключа выполняются последовательно, ошибка не останавливает очередь', async () => {
    const queue = new KeyedWriteQueue();
    const log: string[] = [];
    const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
    const first = queue.run('a', async () => {
      log.push('a1:start');
      await delay();
      log.push('a1:end');
      throw new Error('boom');
    });
    const second = queue.run('a', async () => {
      log.push('a2');
      return 2;
    });
    const other = queue.run('b', async () => {
      log.push('b1');
      return 'b';
    });
    await expect(first).rejects.toThrow('boom');
    expect(await second).toBe(2);
    expect(await other).toBe('b');
    expect(log.indexOf('a2')).toBeGreaterThan(log.indexOf('a1:end'));
    expect(log.indexOf('b1')).toBeLessThan(log.indexOf('a1:end'));
    await queue.idle();
    expect(queue.isBusy()).toBe(false);
  });
});
