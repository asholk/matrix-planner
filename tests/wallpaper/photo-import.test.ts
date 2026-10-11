import { describe, expect, it, vi } from 'vitest';
import {
  PHOTO_JPEG_QUALITY,
  PhotoDecodeError,
  decodePhotoBlob,
  encodePhotoJpeg,
  fitPhotoSize,
  formatFromMime,
  importPhoto,
  megapixels,
  photoFileBase,
  photoFolder,
  photoMaxSide,
  photoTargetPath,
  readPhotoDimensions,
  sniffPhotoFormat,
  type DecodedPhoto,
  type PhotoCanvas,
  type PhotoImportDeps,
  type PhotoImportEnv,
  type PhotoVault,
} from '../../src/wallpaper/photo-import';

const PROFILE = { width: 1179, height: 2556 }; // iPhone 15/16
// 14:05 по UTC.
const NOW = new Date(Date.UTC(2026, 9, 11, 14, 5, 30));

class FakeVault implements PhotoVault {
  readonly files = new Map<string, ArrayBuffer>();
  readonly folders = new Set<string>();
  failWrite: Error | null = null;

  getAbstractFileByPath(path: string): unknown {
    if (this.files.has(path)) return { path };
    if (this.folders.has(path)) return { path, children: [] };
    return null;
  }

  createFolder(path: string): Promise<unknown> {
    if (this.folders.has(path)) return Promise.reject(new Error('Folder already exists.'));
    this.folders.add(path);
    return Promise.resolve({ path });
  }

  createBinary(path: string, data: ArrayBuffer): Promise<unknown> {
    if (this.failWrite) return Promise.reject(this.failWrite);
    if (this.files.has(path)) return Promise.reject(new Error('File already exists.'));
    this.files.set(path, data);
    return Promise.resolve({ path });
  }
}

function fakePhoto(width: number, height: number): DecodedPhoto & { released: boolean } {
  const photo = {
    source: {} as CanvasImageSource,
    width,
    height,
    released: false,
    release() {
      photo.released = true;
    },
  };
  return photo;
}

function fakeEnv(photo: DecodedPhoto | Error): PhotoImportEnv & { encoded: { width: number; height: number; quality: number }[] } {
  const encoded: { width: number; height: number; quality: number }[] = [];
  return {
    encoded,
    decode: () => (photo instanceof Error ? Promise.reject(photo) : Promise.resolve(photo)),
    encodeJpeg: (_photo, size, quality) => {
      encoded.push({ ...size, quality });
      return Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
    },
  };
}

function deps(overrides: Partial<PhotoImportDeps> = {}): PhotoImportDeps {
  return {
    vault: new FakeVault(),
    guard: { check: () => null },
    env: fakeEnv(fakePhoto(4032, 3024)),
    rootFolder: 'Planner',
    profile: PROFILE,
    now: NOW,
    timeZone: 'UTC',
    ...overrides,
  };
}

const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

describe('размер уменьшения', () => {
  it('длинная сторона — max(ширина, высота) профиля × 1,25', () => {
    expect(photoMaxSide(PROFILE)).toBe(3195);
    expect(photoMaxSide({ width: 2556, height: 1179 })).toBe(3195);
  });

  it('уменьшает большое фото с сохранением пропорций', () => {
    expect(fitPhotoSize(4032, 3024, 3195)).toEqual({ width: 3195, height: 2396 });
    expect(fitPhotoSize(3024, 4032, 3195)).toEqual({ width: 2396, height: 3195 });
    expect(fitPhotoSize(8000, 8000, 3195)).toEqual({ width: 3195, height: 3195 });
  });

  it('не увеличивает маленькое фото', () => {
    expect(fitPhotoSize(800, 600, 3195)).toEqual({ width: 800, height: 600 });
    expect(fitPhotoSize(3195, 100, 3195)).toEqual({ width: 3195, height: 100 });
  });

  it('не даёт нулевых сторон', () => {
    expect(fitPhotoSize(100000, 1, 3195)).toEqual({ width: 3195, height: 1 });
  });
});

describe('имя и путь файла', () => {
  it('имя по дате и времени часов плагина', () => {
    expect(photoFileBase(NOW, 'UTC')).toBe('Фото 2026-10-11 14-05');
    expect(photoFileBase(NOW, 'Europe/Moscow')).toBe('Фото 2026-10-11 17-05');
  });

  it('папка в корне Планировщика', () => {
    expect(photoFolder('Planner')).toBe('Planner/Обои/Фоны');
    expect(photoFolder('Work/Planner/')).toBe('Work/Planner/Обои/Фоны');
  });

  it('суффикс при совпадении имени', () => {
    const taken = new Set(['Planner/Обои/Фоны/Фото 2026-10-11 14-05.jpg', 'Planner/Обои/Фоны/Фото 2026-10-11 14-05 (2).jpg']);
    expect(photoTargetPath('Planner', NOW, 'UTC', () => false)).toBe('Planner/Обои/Фоны/Фото 2026-10-11 14-05.jpg');
    expect(photoTargetPath('Planner', NOW, 'UTC', (path) => taken.has(path))).toBe('Planner/Обои/Фоны/Фото 2026-10-11 14-05 (3).jpg');
  });
});

describe('декодирование', () => {
  it('createImageBitmap с учётом EXIF-ориентации', async () => {
    const close = vi.fn();
    const createImageBitmap = vi.fn(() => Promise.resolve({ width: 3024, height: 4032, close } as unknown as ImageBitmap));
    const decoded = await decodePhotoBlob(file, { createImageBitmap });
    expect(createImageBitmap).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(decoded.width).toBe(3024);
    expect(decoded.height).toBe(4032);
    decoded.release();
    expect(close).toHaveBeenCalled();
  });

  it('запасной путь через <img>, если createImageBitmap не справился', async () => {
    const fallback = fakePhoto(640, 480);
    const decoded = await decodePhotoBlob(file, {
      createImageBitmap: () => Promise.reject(new Error('InvalidStateError')),
      loadImage: () => Promise.resolve(fallback),
    });
    expect(decoded).toBe(fallback);
  });

  it('HEIC без поддержки — PhotoDecodeError', async () => {
    const heic = new Blob([new Uint8Array([0])], { type: 'image/heic' });
    await expect(
      decodePhotoBlob(heic, {
        createImageBitmap: () => Promise.reject(new Error('unsupported')),
        loadImage: () => Promise.reject(new Error('image load failed')),
      }),
    ).rejects.toBeInstanceOf(PhotoDecodeError);
    await expect(decodePhotoBlob(heic, {})).rejects.toBeInstanceOf(PhotoDecodeError);
  });
});

describe('кодирование JPEG', () => {
  function fakeCanvas(blob: Blob | null): PhotoCanvas & { drawn: unknown[]; type?: string; quality?: number } {
    const canvas: PhotoCanvas & { drawn: unknown[]; type?: string; quality?: number } = {
      width: 0,
      height: 0,
      drawn: [],
      getContext: () => ({
        drawImage: (...args: unknown[]) => {
          canvas.drawn.push(args);
        },
      }),
      toBlob(callback, type, quality) {
        canvas.type = type;
        canvas.quality = quality;
        callback(blob);
      },
    };
    return canvas;
  }

  it('рисует в нужном размере, JPEG 0,88, освобождает холст', async () => {
    const canvas = fakeCanvas(new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' }));
    const photo = fakePhoto(4032, 3024);
    const data = await encodePhotoJpeg(photo, { width: 3195, height: 2396 }, PHOTO_JPEG_QUALITY, (width, height) => {
      canvas.width = width;
      canvas.height = height;
      return canvas;
    });
    expect(data.byteLength).toBe(2);
    expect(canvas.drawn).toEqual([[photo.source, 0, 0, 3195, 2396]]);
    expect(canvas.type).toBe('image/jpeg');
    expect(canvas.quality).toBe(0.88);
    expect(canvas.width).toBe(0);
  });

  it('toBlob вернул null — ошибка', async () => {
    const canvas = fakeCanvas(null);
    await expect(encodePhotoJpeg(fakePhoto(10, 10), { width: 10, height: 10 }, 0.88, () => canvas)).rejects.toThrow('toBlob');
  });
});

describe('importPhoto', () => {
  it('сохраняет уменьшенный JPEG в <корень>/Обои/Фоны, создаёт папки', async () => {
    const vault = new FakeVault();
    const photo = fakePhoto(4032, 3024);
    const env = fakeEnv(photo);
    const result = await importPhoto(file, deps({ vault, env }));
    expect(result).toEqual({ ok: true, path: 'Planner/Обои/Фоны/Фото 2026-10-11 14-05.jpg', width: 3195, height: 2396 });
    expect([...vault.folders]).toEqual(['Planner', 'Planner/Обои', 'Planner/Обои/Фоны']);
    expect(vault.files.has('Planner/Обои/Фоны/Фото 2026-10-11 14-05.jpg')).toBe(true);
    expect(env.encoded).toEqual([{ width: 3195, height: 2396, quality: 0.88 }]);
    expect(photo.released).toBe(true);
  });

  it('второе фото в ту же минуту — с суффиксом, старое не удаляется', async () => {
    const vault = new FakeVault();
    vault.folders.add('Planner');
    const first = await importPhoto(file, deps({ vault }));
    const second = await importPhoto(file, deps({ vault }));
    expect(first.ok && first.path).toBe('Planner/Обои/Фоны/Фото 2026-10-11 14-05.jpg');
    expect(second.ok && second.path).toBe('Planner/Обои/Фоны/Фото 2026-10-11 14-05 (2).jpg');
    expect(vault.files.size).toBe(2);
  });

  it('фото меньше экрана — предупреждение too-small, ничего не записано', async () => {
    const vault = new FakeVault();
    const photo = fakePhoto(800, 600);
    const result = await importPhoto(file, deps({ vault, env: fakeEnv(photo) }));
    expect(result).toEqual({ ok: false, code: 'too-small', width: 800, height: 600, needWidth: 1179, needHeight: 2556 });
    expect(vault.files.size).toBe(0);
    expect(photo.released).toBe(true);
  });

  it('«Всё равно использовать»: маленькое фото сохраняется без увеличения', async () => {
    const env = fakeEnv(fakePhoto(800, 600));
    const result = await importPhoto(file, deps({ env, allowSmall: true }));
    expect(result.ok && [result.width, result.height]).toEqual([800, 600]);
  });

  it('фото чуть меньше экрана (в пределах 5 %) — без предупреждения', async () => {
    const result = await importPhoto(file, deps({ env: fakeEnv(fakePhoto(1170, 2532)) }));
    expect(result.ok).toBe(true);
  });

  it('JPEG не декодируется — код corrupt с форматом, ничего не записано', async () => {
    const vault = new FakeVault();
    const result = await importPhoto(file, deps({ vault, env: fakeEnv(new PhotoDecodeError('bad jpeg')) }));
    expect(result).toEqual({ ok: false, code: 'corrupt', format: 'jpeg', detail: 'bad jpeg' });
    expect(vault.files.size).toBe(0);
    expect(vault.folders.size).toBe(0);
  });

  it('запрет записи — read-only до декодирования', async () => {
    const vault = new FakeVault();
    const decode = vi.fn();
    const env: PhotoImportEnv = { decode, encodeJpeg: vi.fn() };
    const result = await importPhoto(file, deps({ vault, env, guard: { check: () => ({ code: 'read-only', messageKey: 'storage.readOnly.newer' }) } }));
    expect(result).toEqual({ ok: false, code: 'read-only', messageKey: 'storage.readOnly.newer' });
    expect(decode).not.toHaveBeenCalled();
    expect(vault.files.size).toBe(0);
  });

  it('запрет записи, включившийся во время обработки, тоже останавливает запись', async () => {
    const vault = new FakeVault();
    let calls = 0;
    const guard = { check: () => (calls++ === 0 ? null : { code: 'read-only' as const, messageKey: 'common.readOnly' }) };
    const result = await importPhoto(file, deps({ vault, guard }));
    expect(result).toEqual({ ok: false, code: 'read-only', messageKey: 'common.readOnly' });
    expect(vault.files.size).toBe(0);
  });

  it('ошибка хранилища — код write с причиной', async () => {
    const vault = new FakeVault();
    vault.failWrite = new Error('disk full');
    const result = await importPhoto(file, deps({ vault }));
    expect(result).toEqual({ ok: false, code: 'write', detail: 'disk full' });
  });

  it('ошибка кодирования — код encode, фото освобождено', async () => {
    const photo = fakePhoto(100, 100);
    const env: PhotoImportEnv = { decode: () => Promise.resolve(photo), encodeJpeg: () => Promise.reject(new Error('no canvas')) };
    const result = await importPhoto(file, deps({ env, allowSmall: true }));
    expect(result).toEqual({ ok: false, code: 'encode', detail: 'no canvas' });
    expect(photo.released).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Причины отказа (доработка 007)
// ---------------------------------------------------------------------------

function bytes(...parts: (string | number[])[]): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') for (const ch of part) out.push(ch.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array(out);
}

/** Коробка ftyp ISO BMFF: размер, «ftyp», основной бренд, версия, совместимые бренды. */
function ftyp(major: string, ...compatible: string[]): Uint8Array<ArrayBuffer> {
  const size = 16 + 4 * compatible.length;
  return bytes([0, 0, 0, size], 'ftyp', major, [0, 0, 0, 0], ...compatible, [0, 0, 0, 0]);
}

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], 'IHDR', be(width), be(height), [8, 6, 0, 0, 0]);
}

function jpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  const app0 = [0xff, 0xe0, 0, 16, ...Array.from('JFIF', (c) => c.charCodeAt(0)), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0, 17, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return bytes([0xff, 0xd8], app0, sof, [0xff, 0xd9]);
}

describe('формат и размер по байтам', () => {
  it('сигнатуры: JPEG, PNG, GIF, WebP, BMP, TIFF', () => {
    expect(sniffPhotoFormat(jpeg(10, 10))).toBe('jpeg');
    expect(sniffPhotoFormat(png(10, 10))).toBe('png');
    expect(sniffPhotoFormat(bytes('GIF89a', [10, 0, 20, 0]))).toBe('gif');
    expect(sniffPhotoFormat(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('webp');
    expect(sniffPhotoFormat(bytes('BM', new Array<number>(30).fill(0)))).toBe('bmp');
    expect(sniffPhotoFormat(bytes('II*', [0, 8, 0, 0, 0]))).toBe('tiff');
    expect(sniffPhotoFormat(bytes('hello world'))).toBe('unknown');
    expect(sniffPhotoFormat(new Uint8Array(0))).toBe('unknown');
  });

  it('HEIC: ftypheic, ftypmif1 с брендом heic; AVIF отдельно', () => {
    expect(sniffPhotoFormat(ftyp('heic', 'mif1', 'heic'))).toBe('heic');
    expect(sniffPhotoFormat(ftyp('mif1', 'mif1', 'heic'))).toBe('heic');
    expect(sniffPhotoFormat(ftyp('heix'))).toBe('heic');
    expect(sniffPhotoFormat(ftyp('avif', 'mif1', 'miaf'))).toBe('avif');
    expect(sniffPhotoFormat(ftyp('isom', 'mp41'))).toBe('unknown');
  });

  it('MIME-тип файла', () => {
    expect(formatFromMime('image/heic')).toBe('heic');
    expect(formatFromMime('image/HEIF')).toBe('heic');
    expect(formatFromMime('image/jpeg')).toBe('jpeg');
    expect(formatFromMime('application/pdf')).toBe('unknown');
    expect(formatFromMime('')).toBeNull();
  });

  it('размер из заголовка без декодирования', () => {
    expect(readPhotoDimensions(png(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    expect(readPhotoDimensions(jpeg(9000, 7000))).toEqual({ width: 9000, height: 7000 });
    expect(readPhotoDimensions(bytes('GIF89a', [0x40, 1, 0xf0, 0]))).toEqual({ width: 320, height: 240 });
    const vp8x = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', [10, 0, 0, 0], [0, 0, 0, 0], [0x7f, 0x07, 0], [0x37, 0x04, 0]);
    expect(readPhotoDimensions(vp8x)).toEqual({ width: 1920, height: 1080 });
    expect(readPhotoDimensions(ftyp('heic'))).toBeNull();
    expect(megapixels(9000, 7000)).toBe(63);
  });
});

describe('importPhoto: понятные причины', () => {
  it('пустой файл — empty, без декодирования', async () => {
    const decode = vi.fn();
    const result = await importPhoto(new Blob([], { type: 'image/jpeg' }), deps({ env: { decode, encodeJpeg: vi.fn() } }));
    expect(result).toEqual({ ok: false, code: 'empty' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('HEIC, который WebView не открывает, — unsupported/heic (по байтам, даже без типа файла)', async () => {
    const heic = new Blob([ftyp('mif1', 'mif1', 'heic')], { type: '' });
    const result = await importPhoto(heic, deps({ env: fakeEnv(new PhotoDecodeError('no decoder')) }));
    expect(result).toEqual({ ok: false, code: 'unsupported', format: 'heic', detail: 'no decoder' });
  });

  it('HEIC, который WebView открывает, сохраняется как JPEG', async () => {
    const heic = new Blob([ftyp('heic')], { type: 'image/heic' });
    const result = await importPhoto(heic, deps());
    expect(result.ok).toBe(true);
  });

  it('не картинка — unsupported/unknown', async () => {
    const pdf = new Blob([bytes('%PDF-1.7 ...')], { type: 'application/pdf' });
    const result = await importPhoto(pdf, deps({ env: fakeEnv(new Error('not an image')) }));
    expect(result).toMatchObject({ ok: false, code: 'unsupported', format: 'unknown' });
  });

  it('очень большое фото (> 50 Мп) уменьшается уже при декодировании, поэтапно', async () => {
    const huge = new Blob([jpeg(12000, 9000)], { type: 'image/jpeg' });
    const calls: (number | undefined)[] = [];
    const photo = fakePhoto(2396, 1797);
    const env: PhotoImportEnv = {
      decode: (_blob, options) => {
        calls.push(options?.resizeWidth);
        return calls.length < 2 ? Promise.reject(new Error('out of memory')) : Promise.resolve(photo);
      },
      encodeJpeg: () => Promise.resolve(new ArrayBuffer(4)),
    };
    const result = await importPhoto(huge, deps({ env, allowSmall: true }));
    expect(calls).toEqual([3195, 2396]);
    expect(result.ok).toBe(true);
    expect(photo.released).toBe(true);
  });

  it('очень большое фото, которое не уменьшилось, — too-large с размером', async () => {
    const huge = new Blob([jpeg(12000, 9000)], { type: 'image/jpeg' });
    const decode = vi.fn(() => Promise.reject(new Error('out of memory')));
    const result = await importPhoto(huge, deps({ env: { decode, encodeJpeg: vi.fn() } }));
    expect(result).toEqual({ ok: false, code: 'too-large', width: 12000, height: 9000, detail: 'out of memory' });
    expect(decode).toHaveBeenCalledTimes(3);
  });

  it('холст не создаётся в полном размере — сохраняем меньше', async () => {
    const sizes: number[] = [];
    const env: PhotoImportEnv = {
      decode: () => Promise.resolve(fakePhoto(4032, 3024)),
      encodeJpeg: (_p, size) => {
        sizes.push(size.width);
        return sizes.length === 1 ? Promise.reject(new Error('canvas too big')) : Promise.resolve(new ArrayBuffer(4));
      },
    };
    const result = await importPhoto(file, deps({ env }));
    expect(sizes).toEqual([3195, 2396]);
    expect(result.ok && result.width).toBe(2396);
  });
});
