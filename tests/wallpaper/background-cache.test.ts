import { describe, expect, it } from 'vitest';
import {
  BackgroundImageCache,
  WallpaperBackgroundError,
  backgroundAffectedBy,
  findBackgroundError,
  type DecodedImage,
} from '../../src/wallpaper/background';

function harness() {
  const files = new Map<string, { version: string; bytes: number }>();
  const stats = { reads: 0, decoded: 0, released: [] as number[] };
  const cache = new BackgroundImageCache(
    {
      read: async (path) => {
        stats.reads += 1;
        const file = files.get(path);
        return file ? new ArrayBuffer(file.bytes) : null;
      },
      version: (path) => files.get(path)?.version ?? null,
    },
    async (data): Promise<DecodedImage> => {
      const id = ++stats.decoded;
      return {
        source: {} as CanvasImageSource,
        width: data.byteLength,
        height: 10,
        release: () => stats.released.push(id),
      };
    },
  );
  return { cache, files, stats };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('BackgroundImageCache', () => {
  it('does not close an image while a parallel consumer still draws it', async () => {
    const h = harness();
    h.files.set('a.png', { version: '1', bytes: 4 });
    h.files.set('b.png', { version: '1', bytes: 8 });
    const batch = await h.cache.acquire('a.png');
    // Предпросмотр сменил фон, пока пакет рисует a.png.
    const preview = await h.cache.acquire('b.png');
    await flush();
    expect(h.stats.released).toEqual([]);
    // Конец пакета: текущая (b) больше не держится кэшем, но предпросмотр её ещё рисует.
    h.cache.release();
    await flush();
    expect(h.stats.released).toEqual([]);
    batch.release();
    await flush();
    expect(h.stats.released).toEqual([1]);
    preview.release();
    preview.release(); // повторный возврат игнорируется
    await flush();
    expect(h.stats.released).toEqual([1, 2]);
  });

  it('decodes once for a batch and releases after the batch', async () => {
    const h = harness();
    h.files.set('a.png', { version: '1', bytes: 4 });
    for (let i = 0; i < 7; i++) (await h.cache.acquire('a.png')).release();
    expect(h.stats.reads).toBe(1);
    await flush();
    expect(h.stats.released).toEqual([]);
    h.cache.release();
    await flush();
    expect(h.stats.released).toEqual([1]);
  });

  it('re-reads a file replaced at the same path (mtime/size changed)', async () => {
    const h = harness();
    h.files.set('a.png', { version: '100:4', bytes: 4 });
    const first = await h.cache.acquire('a.png');
    first.release();
    h.files.set('a.png', { version: '200:6', bytes: 6 });
    const second = await h.cache.acquire('a.png');
    expect(h.stats.reads).toBe(2);
    expect(second?.image.width).toBe(6);
    await flush();
    expect(h.stats.released).toEqual([1]);
    second.release();
  });

  it('invalidate drops the cached image so the next load reads the file', async () => {
    const h = harness();
    h.files.set('a.png', { version: '1', bytes: 4 });
    (await h.cache.acquire('a.png')).release();
    h.cache.invalidate();
    (await h.cache.acquire('a.png')).release();
    expect(h.stats.reads).toBe(2);
  });

  it('missing file: WallpaperBackgroundError(missing), not cached', async () => {
    const h = harness();
    await expect(h.cache.acquire('a.png')).rejects.toMatchObject({ name: 'WallpaperBackgroundError', code: 'missing', path: 'a.png' });
    h.files.set('a.png', { version: '1', bytes: 4 });
    const lease = await h.cache.acquire('a.png');
    expect(lease.image.width).toBe(4);
  });

  it('unreadable and undecodable files: read / decode with the reason', async () => {
    const reader = new BackgroundImageCache(
      { read: () => Promise.reject(new Error('EACCES')) },
      () => Promise.reject(new Error('never')),
    );
    const read = await reader.acquire('x.jpg').catch((error: unknown) => error);
    expect(read).toBeInstanceOf(WallpaperBackgroundError);
    expect(read).toMatchObject({ code: 'read', detail: 'EACCES' });

    const broken = new BackgroundImageCache(
      { read: () => Promise.resolve(new ArrayBuffer(8)) },
      () => Promise.reject(new Error('bad data')),
    );
    await expect(broken.acquire('x.jpg')).rejects.toMatchObject({ code: 'decode', detail: 'bad data' });

    const empty = new BackgroundImageCache({ read: () => Promise.resolve(new ArrayBuffer(0)) });
    await expect(empty.acquire('x.jpg')).rejects.toMatchObject({ code: 'decode' });
  });

  it('findBackgroundError unwraps `cause` and duck-typed errors', () => {
    const inner = new WallpaperBackgroundError('missing', 'a.png');
    expect(findBackgroundError(new Error('render failed', { cause: inner }))).toBe(inner);
    const plain = Object.assign(new Error('x'), { name: 'WallpaperBackgroundError', code: 'read', path: 'b.png' });
    expect(findBackgroundError(plain)).toMatchObject({ code: 'read', path: 'b.png' });
    expect(findBackgroundError(new Error('other'))).toBeNull();
  });
});

describe('backgroundAffectedBy', () => {
  const image = { kind: 'image' as const, path: 'Фоны/a.png', crop: { centerX: 0.5, centerY: 0.5, scale: 1 } };

  it('matches modify/delete by path and rename by old path', () => {
    expect(backgroundAffectedBy(image, 'Фоны/a.png')).toBe(true);
    expect(backgroundAffectedBy(image, 'Фоны/b.png', 'Фоны/a.png')).toBe(true);
    expect(backgroundAffectedBy(image, 'Фоны/b.png')).toBe(false);
    expect(backgroundAffectedBy({ kind: 'solid', color: '#000' }, 'Фоны/a.png')).toBe(false);
  });
});
