import { describe, it, expect } from 'vitest';
import type { FolderListing } from '../../src/app/contracts';
import type { OpResult, PlannerPaths, VaultPath } from '../../src/model/types';
import { WallpaperOutputRepository, type OutputRepositoryDeps } from '../../src/wallpaper/output-repository';

const ROOT = 'Планировщик';
const FOLDER = `${ROOT}/Обои/iphone-1179x2556`;

/** Хранилище в памяти: только то, что нужно файлам обоев. */
class MemoryRepository implements OutputRepositoryDeps {
  readonly files = new Map<VaultPath, ArrayBuffer>();
  readonly writes: { path: VaultPath; mode: 'create' | 'modify' }[] = [];
  readonly trashed: VaultPath[] = [];
  failWrite = new Set<VaultPath>();
  failTrash = new Set<VaultPath>();
  readOnly = false;

  readonly paths = {
    root: ROOT,
    wallpapers: `${ROOT}/Обои`,
    wallpaperProfile: (id: string) => `${ROOT}/Обои/${id}`,
  } as unknown as PlannerPaths;

  exists(path: VaultPath): boolean {
    return this.files.has(path);
  }

  async writeBinary(path: VaultPath, data: ArrayBuffer): Promise<OpResult> {
    if (this.readOnly) return { ok: false, error: { code: 'read-only' } };
    if (this.failWrite.has(path)) return { ok: false, error: { code: 'write-failed', detail: `disk full: ${path}` } };
    this.writes.push({ path, mode: this.files.has(path) ? 'modify' : 'create' });
    this.files.set(path, data);
    return { ok: true, value: undefined, changed: true };
  }

  async listFolder(path: VaultPath): Promise<OpResult<FolderListing>> {
    const prefix = `${path}/`;
    const files: VaultPath[] = [];
    const folders = new Set<VaultPath>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push(file);
      else folders.add(prefix + rest.slice(0, slash));
    }
    if (files.length === 0 && folders.size === 0) return { ok: false, error: { code: 'not-found', detail: path } };
    return { ok: true, value: { files: files.sort(), folders: [...folders].sort() }, changed: false };
  }

  async trash(path: VaultPath): Promise<OpResult> {
    if (this.failTrash.has(path)) return { ok: false, error: { code: 'trash-failed', detail: path } };
    if (!this.files.delete(path)) return { ok: false, error: { code: 'not-found' } };
    this.trashed.push(path);
    return { ok: true, value: undefined, changed: true };
  }
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('WallpaperOutputRepository paths', () => {
  it('builds profile paths', () => {
    const output = new WallpaperOutputRepository(new MemoryRepository());
    expect(output.folder('iphone-1179x2556')).toBe(FOLDER);
    expect(output.datedPath('iphone-1179x2556', '2026-10-10')).toBe(`${FOLDER}/lock-2026-10-10.png`);
    expect(output.lockPath('iphone-1179x2556')).toBe(`${FOLDER}/lock.png`);
  });
});

describe('WallpaperOutputRepository writes', () => {
  it('creates and then modifies binary files', async () => {
    const repo = new MemoryRepository();
    const output = new WallpaperOutputRepository(repo);
    expect((await output.writeDated('iphone-1179x2556', '2026-10-10', bytes('a'))).ok).toBe(true);
    expect((await output.writeDated('iphone-1179x2556', '2026-10-10', bytes('b'))).ok).toBe(true);
    expect((await output.writeLock('iphone-1179x2556', bytes('c'))).ok).toBe(true);
    expect(repo.writes).toEqual([
      { path: `${FOLDER}/lock-2026-10-10.png`, mode: 'create' },
      { path: `${FOLDER}/lock-2026-10-10.png`, mode: 'modify' },
      { path: `${FOLDER}/lock.png`, mode: 'create' },
    ]);
    expect(new TextDecoder().decode(repo.files.get(`${FOLDER}/lock-2026-10-10.png`))).toBe('b');
    expect(output.exists(`${FOLDER}/lock.png`)).toBe(true);
  });

  it('passes write errors through', async () => {
    const repo = new MemoryRepository();
    repo.readOnly = true;
    const result = await new WallpaperOutputRepository(repo).writeLock('iphone-1179x2556', bytes('x'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('read-only');
  });
});

describe('WallpaperOutputRepository cleanup', () => {
  function seed(repo: MemoryRepository): void {
    for (const name of [
      'lock-2026-10-08.png',
      'lock-2026-10-09.png',
      'lock-2026-10-10.png',
      'lock-2026-10-11.png',
      'lock.png',
      'shortcut-last-run.txt',
      'lock-2026-02-30.png',
      'notes.md',
      'архив/lock-2026-01-01.png',
    ]) {
      repo.files.set(`${FOLDER}/${name}`, bytes(name));
    }
    repo.files.set(`${ROOT}/Обои/screen-1080x2400/lock-2026-10-01.png`, bytes('other'));
    repo.files.set(`${ROOT}/Обои/lock-2026-10-01.png`, bytes('parent'));
  }

  it('removes only own dated files older than today in the profile folder', async () => {
    const repo = new MemoryRepository();
    seed(repo);
    const result = await new WallpaperOutputRepository(repo).cleanup('iphone-1179x2556', '2026-10-10');
    expect(result.removed).toEqual([`${FOLDER}/lock-2026-10-08.png`, `${FOLDER}/lock-2026-10-09.png`]);
    expect(result.failed).toEqual([]);
    for (const kept of [
      'lock-2026-10-10.png',
      'lock-2026-10-11.png',
      'lock.png',
      'shortcut-last-run.txt',
      'lock-2026-02-30.png',
      'notes.md',
      'архив/lock-2026-01-01.png',
    ]) {
      expect(repo.files.has(`${FOLDER}/${kept}`)).toBe(true);
    }
    expect(repo.files.has(`${ROOT}/Обои/screen-1080x2400/lock-2026-10-01.png`)).toBe(true);
    expect(repo.files.has(`${ROOT}/Обои/lock-2026-10-01.png`)).toBe(true);
  });

  it('is idempotent', async () => {
    const repo = new MemoryRepository();
    seed(repo);
    const output = new WallpaperOutputRepository(repo);
    await output.cleanup('iphone-1179x2556', '2026-10-10');
    const second = await output.cleanup('iphone-1179x2556', '2026-10-10');
    expect(second).toEqual({ removed: [], failed: [] });
    expect(repo.trashed).toHaveLength(2);
  });

  it('treats a missing folder as nothing to clean', async () => {
    const result = await new WallpaperOutputRepository(new MemoryRepository()).cleanup('iphone-1179x2556', '2026-10-10');
    expect(result).toEqual({ removed: [], failed: [] });
  });

  it('reports trash failures and continues', async () => {
    const repo = new MemoryRepository();
    seed(repo);
    repo.failTrash.add(`${FOLDER}/lock-2026-10-08.png`);
    const result = await new WallpaperOutputRepository(repo).cleanup('iphone-1179x2556', '2026-10-10');
    expect(result.removed).toEqual([`${FOLDER}/lock-2026-10-09.png`]);
    expect(result.failed.map((f) => f.path)).toEqual([`${FOLDER}/lock-2026-10-08.png`]);
  });
});
