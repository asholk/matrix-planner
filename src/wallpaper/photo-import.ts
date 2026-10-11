/**
 * Фон обоев из Фото (iOS) или с диска: декодирование, уменьшение под профиль,
 * JPEG в `<корень>/Обои/Фоны/Фото ГГГГ-ММ-ДД ЧЧ-ММ.jpg`.
 *
 * Логика размеров и путей — чистые функции; браузерные API (createImageBitmap,
 * Image, canvas) и хранилище внедряются, чтобы тесты шли с фейками.
 * Ранее загруженные фоны не удаляются.
 */

import { normalizePath } from 'obsidian';
import type { WriteGuard } from '../app/contracts';
import { floatingFromDate } from '../model/dates';
import type { VaultPath, WallpaperProfile } from '../model/types';
import { createPlannerPaths, joinPath, uniqueFilePath } from '../storage/paths';

/** Подпапка загруженных фонов в папке обоев. */
export const PHOTO_FOLDER_NAME = 'Фоны';
/** Начало имени файла загруженного фона. */
export const PHOTO_FILE_PREFIX = 'Фото';
/** Запас к большей стороне экрана: место для кадрирования и масштаба. */
export const PHOTO_SIZE_MARGIN = 1.25;
/** Качество JPEG. */
export const PHOTO_JPEG_QUALITY = 0.88;

// ===========================================================================
// Размеры и пути
// ===========================================================================

/** Наибольшая длинная сторона фото для профиля: max(ширина, высота) × 1,25. */
export function photoMaxSide(profile: Pick<WallpaperProfile, 'width' | 'height'>): number {
  return Math.max(1, Math.round(Math.max(profile.width, profile.height) * PHOTO_SIZE_MARGIN));
}

/** Размер после уменьшения: длинная сторона не больше `maxSide`, без увеличения. */
export function fitPhotoSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= maxSide) return { width: w, height: h };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Папка загруженных фонов: `<корень>/Обои/Фоны`. */
export function photoFolder(rootFolder: string): VaultPath {
  return normalizePath(joinPath(createPlannerPaths(rootFolder).wallpapers, PHOTO_FOLDER_NAME));
}

/** Имя без расширения: `Фото 2026-10-11 14-05` (время часов плагина). */
export function photoFileBase(now: Date, timeZone?: string): string {
  const { date, time } = floatingFromDate(now, timeZone);
  return `${PHOTO_FILE_PREFIX} ${date} ${time.slice(0, 5).replace(':', '-')}`;
}

/** Свободный путь файла; при совпадении — суффикс ` (2)`, ` (3)`… */
export function photoTargetPath(rootFolder: string, now: Date, timeZone: string | undefined, isTaken: (path: VaultPath) => boolean): VaultPath {
  return normalizePath(uniqueFilePath(photoFolder(rootFolder), photoFileBase(now, timeZone), '.jpg', isTaken));
}

// ===========================================================================
// Декодирование и кодирование
// ===========================================================================

/** Декодированное фото; `release` освобождает память (на iOS её мало). */
export interface DecodedPhoto {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

/** Холст для перекодирования (в тестах — фейк). */
export interface PhotoCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): Pick<CanvasRenderingContext2D, 'drawImage'> & Partial<Pick<CanvasRenderingContext2D, 'imageSmoothingEnabled' | 'imageSmoothingQuality'>> | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

/** Браузерные API декодирования; любой может отсутствовать. */
export interface PhotoDecodeApi {
  createImageBitmap?: (blob: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>;
  /** Запасной путь: `<img>` из object URL. */
  loadImage?: (blob: Blob) => Promise<DecodedPhoto>;
}

/** Параметры декодирования. */
export interface PhotoDecodeOptions {
  /**
   * Уменьшить при декодировании до этой ширины (высота — по пропорциям):
   * полноразмерное очень большое фото не помещается в память iOS.
   */
  resizeWidth?: number;
}

export interface PhotoImportEnv {
  /** Бросает, если фото не открывается (например, HEIC без поддержки). */
  decode(blob: Blob, options?: PhotoDecodeOptions): Promise<DecodedPhoto>;
  encodeJpeg(photo: DecodedPhoto, size: { width: number; height: number }, quality: number): Promise<ArrayBuffer>;
}

/** Ошибка декодирования: показываем «выберите JPEG или PNG». */
export class PhotoDecodeError extends Error {}

/** Декодирует фото с учётом EXIF-ориентации; запасной путь — `<img>`. */
export async function decodePhotoBlob(blob: Blob, api: PhotoDecodeApi, options: PhotoDecodeOptions = {}): Promise<DecodedPhoto> {
  const errors: unknown[] = [];
  const resizeWidth = options.resizeWidth && options.resizeWidth > 0 ? Math.round(options.resizeWidth) : null;
  if (api.createImageBitmap) {
    try {
      const resize: ImageBitmapOptions = resizeWidth ? { resizeWidth, resizeQuality: 'high' } : {};
      const bitmap = await api.createImageBitmap(blob, { imageOrientation: 'from-image', ...resize });
      if (bitmap.width > 0 && bitmap.height > 0) {
        return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
      }
      bitmap.close?.();
    } catch (error) {
      errors.push(error);
    }
  }
  // `<img>` декодирует фото целиком — для уменьшения при декодировании не годится.
  if (api.loadImage && !resizeWidth) {
    try {
      const image = await api.loadImage(blob);
      if (image.width > 0 && image.height > 0) return image;
      image.release();
    } catch (error) {
      errors.push(error);
    }
  }
  throw new PhotoDecodeError(`cannot decode photo (${blob.type || 'unknown type'})`, { cause: errors[errors.length - 1] });
}

/** Рисует фото на холсте нужного размера и кодирует в JPEG. */
export async function encodePhotoJpeg(
  photo: DecodedPhoto,
  size: { width: number; height: number },
  quality: number,
  createCanvas: (width: number, height: number) => PhotoCanvas,
): Promise<ArrayBuffer> {
  const canvas = createCanvas(size.width, size.height);
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(photo.source, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('canvas.toBlob returned null');
    return await blob.arrayBuffer();
  } finally {
    // iOS держит память холста, пока у него есть размер.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** `<img>` из object URL: браузер сам учитывает EXIF-ориентацию при отрисовке. */
function loadImageElement(blob: Blob): Promise<DecodedPhoto> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = createEl('img');
    const cleanup = (): void => URL.revokeObjectURL(url);
    img.onload = () =>
      resolve({
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => {
          cleanup();
          img.removeAttribute('src');
        },
      });
    img.onerror = () => {
      cleanup();
      reject(new Error('image load failed'));
    };
    img.src = url;
  });
}

/** Окружение браузера/WebView Obsidian. */
export function createBrowserPhotoEnv(): PhotoImportEnv {
  const api: PhotoDecodeApi = {
    createImageBitmap: typeof createImageBitmap === 'function' ? (blob, options) => createImageBitmap(blob, options) : undefined,
    loadImage: typeof URL.createObjectURL === 'function' ? loadImageElement : undefined,
  };
  return {
    decode: (blob, options) => decodePhotoBlob(blob, api, options),
    encodeJpeg: (photo, size, quality) =>
      encodePhotoJpeg(photo, size, quality, (width, height) => {
        const canvas = createEl('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
      }),
  };
}

// ===========================================================================
// Формат и размер по байтам файла
// ===========================================================================

/** Формат по сигнатуре байтов. */
export type PhotoFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'heic' | 'avif' | 'tiff' | 'unknown';

/** Больше — слишком большое для памяти телефона: уменьшаем при декодировании. */
export const PHOTO_MAX_MEGAPIXELS = 50;
/** Сколько байт начала файла читать для сигнатуры и размеров. */
export const PHOTO_HEADER_BYTES = 256 * 1024;
/** Фото меньше экрана больше чем на 5 % — предупреждение «будет размытым». */
export const PHOTO_SMALL_TOLERANCE = 1.05;
/** Шаги уменьшения при нехватке памяти (доля целевого размера). */
export const PHOTO_SHRINK_STEPS: readonly number[] = [1, 0.75, 0.5];

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Формат по сигнатуре: HEIC — `ftypheic`/`ftypmif1` и родственные бренды. */
export function sniffPhotoFormat(bytes: Uint8Array): PhotoFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'png';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 2) === 'BM' && bytes.length >= 26) return 'bmp';
  if (ascii(bytes, 0, 4) === 'II*\u0000' || ascii(bytes, 0, 4) === 'MM\u0000*') return 'tiff';
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const boxSize = Math.min(bytes.length, u32be(bytes, 0));
    const brands = [ascii(bytes, 8, 4)];
    for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(ascii(bytes, i, 4));
    if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif';
    if (brands.some((b) => HEIF_BRANDS.has(b))) return 'heic';
  }
  return 'unknown';
}

/** Формат по MIME-типу файла (`File.type`); `null` — тип неизвестен. */
export function formatFromMime(type: string): PhotoFormat | null {
  const value = type.trim().toLowerCase();
  if (value === '') return null;
  if (value === 'image/jpeg' || value === 'image/jpg' || value === 'image/pjpeg') return 'jpeg';
  if (value === 'image/png') return 'png';
  if (value === 'image/gif') return 'gif';
  if (value === 'image/webp') return 'webp';
  if (value === 'image/bmp') return 'bmp';
  if (value === 'image/heic' || value === 'image/heif' || value === 'image/heic-sequence' || value === 'image/heif-sequence') return 'heic';
  if (value === 'image/avif') return 'avif';
  if (value === 'image/tiff') return 'tiff';
  return 'unknown';
}

function u16be(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}
function u16le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}
function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}
function u32le(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0;
}
function u24le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
}

/** Размер картинки из заголовка (JPEG, PNG, GIF, WebP, BMP) без декодирования; `null` — неизвестен. */
export function readPhotoDimensions(
  bytes: Uint8Array,
  format: PhotoFormat = sniffPhotoFormat(bytes),
): { width: number; height: number } | null {
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  switch (format) {
    case 'png':
      return bytes.length >= 24 ? ok(u32be(bytes, 16), u32be(bytes, 20)) : null;
    case 'gif':
      return bytes.length >= 10 ? ok(u16le(bytes, 6), u16le(bytes, 8)) : null;
    case 'bmp':
      return bytes.length >= 26 ? ok(Math.abs(u32le(bytes, 18)), Math.abs(u32le(bytes, 22))) : null;
    case 'webp': {
      const chunk = ascii(bytes, 12, 4);
      if (chunk === 'VP8X' && bytes.length >= 30) return ok(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
      if (chunk === 'VP8 ' && bytes.length >= 30) return ok(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
      if (chunk === 'VP8L' && bytes.length >= 25) {
        const b = bytes;
        const width = 1 + (((b[22] & 0x3f) << 8) | b[21]);
        const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
        return ok(width, height);
      }
      return null;
    }
    case 'jpeg': {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = bytes[i + 1];
        if (marker === 0xff) {
          i++;
          continue;
        }
        // SOF0–SOF15, кроме DHT (C4), JPG (C8), DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return ok(u16be(bytes, i + 7), u16be(bytes, i + 5));
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        i += 2 + u16be(bytes, i + 2);
      }
      return null;
    }
    default:
      return null;
  }
}

/** Мегапиксели (одна цифра после запятой). */
export function megapixels(width: number, height: number): number {
  return Math.round((width * height) / 100000) / 10;
}

/**
 * Во сколько раз фото придётся увеличить, чтобы закрыть экран (режим cover);
 * больше `PHOTO_SMALL_TOLERANCE` — предупреждение.
 */
export function upscaleNeeded(width: number, height: number, profile: Pick<WallpaperProfile, 'width' | 'height'>): number {
  if (!(width > 0 && height > 0)) return Infinity;
  return Math.max(profile.width / width, profile.height / height);
}

// ===========================================================================
// Импорт
// ===========================================================================

/** Часть `Vault`, нужная импорту. */
export interface PhotoVault {
  getAbstractFileByPath(path: string): unknown;
  createFolder(path: string): Promise<unknown>;
  createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
}

export interface PhotoImportDeps {
  vault: PhotoVault;
  /** Запрет записи (новая схема, миграция); `null` — не проверяется. */
  guard?: Pick<WriteGuard, 'check'> | null;
  env: PhotoImportEnv;
  rootFolder: string;
  profile: Pick<WallpaperProfile, 'width' | 'height'>;
  now: Date;
  timeZone?: string;
  /** Фото меньше экрана: сохранить без вопроса («Всё равно использовать»). */
  allowSmall?: boolean;
}

/** Причины, по которым фото не загружено (доработка 007: «почему не подходит»). */
export type PhotoImportFailure =
  | { ok: false; code: 'read-only'; messageKey: string }
  /** Файл пустой (0 байт). */
  | { ok: false; code: 'empty' }
  /** Формат не открывается на этом устройстве: HEIC/HEIF, TIFF, не картинка. */
  | { ok: false; code: 'unsupported'; format: PhotoFormat; detail: string }
  /** Формат известный, но файл не декодируется (повреждён). */
  | { ok: false; code: 'corrupt'; format: PhotoFormat; detail: string }
  /** Фото меньше экрана: можно сохранить с `allowSmall`. */
  | { ok: false; code: 'too-small'; width: number; height: number; needWidth: number; needHeight: number }
  /** Не хватило памяти даже после поэтапного уменьшения. */
  | { ok: false; code: 'too-large'; width: number; height: number; detail: string }
  | { ok: false; code: 'encode' | 'write'; detail: string };

export type PhotoImportResult = { ok: true; path: VaultPath; width: number; height: number } | PhotoImportFailure;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Создаёт недостающие папки пути по одной. */
async function ensureFolder(vault: PhotoVault, folder: VaultPath): Promise<void> {
  const parts = folder.split('/').filter((part) => part !== '');
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (vault.getAbstractFileByPath(current)) continue;
    try {
      await vault.createFolder(current);
    } catch (error) {
      // Папку могла создать синхронизация между проверкой и созданием.
      if (!vault.getAbstractFileByPath(current)) throw error;
    }
  }
}

async function readHeader(file: Blob): Promise<Uint8Array> {
  try {
    const part = file.size > PHOTO_HEADER_BYTES ? file.slice(0, PHOTO_HEADER_BYTES) : file;
    return new Uint8Array(await part.arrayBuffer());
  } catch {
    return new Uint8Array(0);
  }
}

/** Форматы, которые WebView может не открыть: сбой — «не поддерживается», а не «повреждён». */
const MAYBE_UNSUPPORTED: ReadonlySet<PhotoFormat> = new Set<PhotoFormat>(['heic', 'avif', 'tiff', 'unknown']);

/**
 * Декодирует, уменьшает, сохраняет JPEG; возвращает путь нового файла
 * или понятную причину отказа (формат, пустой файл, размер, память, хранилище).
 */
export async function importPhoto(file: Blob, deps: PhotoImportDeps): Promise<PhotoImportResult> {
  const blocked = deps.guard?.check() ?? null;
  if (blocked) return { ok: false, code: 'read-only', messageKey: blocked.messageKey };
  if (file.size === 0) return { ok: false, code: 'empty' };

  const header = await readHeader(file);
  const sniffed = sniffPhotoFormat(header);
  // По байтам надёжнее; если сигнатура неизвестна — по типу файла.
  const format = sniffed !== 'unknown' ? sniffed : (formatFromMime(file.type) ?? 'unknown');
  const headerSize = readPhotoDimensions(header, sniffed);
  const maxSide = photoMaxSide(deps.profile);

  // Очень большое фото — уменьшаем уже при декодировании, поэтапно.
  const huge = headerSize !== null && headerSize.width * headerSize.height > PHOTO_MAX_MEGAPIXELS * 1e6;
  let decoded: DecodedPhoto | null = null;
  if (huge && headerSize) {
    const target = fitPhotoSize(headerSize.width, headerSize.height, maxSide);
    let lastError: unknown = null;
    for (const step of PHOTO_SHRINK_STEPS) {
      try {
        decoded = await deps.env.decode(file, { resizeWidth: Math.max(1, Math.round(target.width * step)) });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!decoded) return { ok: false, code: 'too-large', width: headerSize.width, height: headerSize.height, detail: describe(lastError) };
  } else {
    try {
      decoded = await deps.env.decode(file);
    } catch (error) {
      const detail = describe(error);
      if (MAYBE_UNSUPPORTED.has(format)) return { ok: false, code: 'unsupported', format, detail };
      return { ok: false, code: 'corrupt', format, detail };
    }
  }

  const photo = decoded;
  try {
    const original = headerSize ?? { width: photo.width, height: photo.height };
    if (!deps.allowSmall && upscaleNeeded(original.width, original.height, deps.profile) > PHOTO_SMALL_TOLERANCE) {
      return {
        ok: false,
        code: 'too-small',
        width: original.width,
        height: original.height,
        needWidth: deps.profile.width,
        needHeight: deps.profile.height,
      };
    }

    const size = fitPhotoSize(photo.width, photo.height, maxSide);
    let jpeg: ArrayBuffer | null = null;
    let encodeError: unknown = null;
    let saved = size;
    // Холст полного размера может не поместиться в память — пробуем меньше.
    for (const step of PHOTO_SHRINK_STEPS) {
      const attempt =
        step === 1 ? size : { width: Math.max(1, Math.round(size.width * step)), height: Math.max(1, Math.round(size.height * step)) };
      try {
        jpeg = await deps.env.encodeJpeg(photo, attempt, PHOTO_JPEG_QUALITY);
        saved = attempt;
        break;
      } catch (error) {
        encodeError = error;
      }
    }
    if (!jpeg) {
      if (huge && headerSize) return { ok: false, code: 'too-large', width: headerSize.width, height: headerSize.height, detail: describe(encodeError) };
      return { ok: false, code: 'encode', detail: describe(encodeError) };
    }

    // Запрет мог включиться, пока фото кодировалось.
    const blockedLate = deps.guard?.check() ?? null;
    if (blockedLate) return { ok: false, code: 'read-only', messageKey: blockedLate.messageKey };

    try {
      const folder = photoFolder(deps.rootFolder);
      await ensureFolder(deps.vault, folder);
      const path = photoTargetPath(deps.rootFolder, deps.now, deps.timeZone, (candidate) => deps.vault.getAbstractFileByPath(candidate) != null);
      await deps.vault.createBinary(path, jpeg);
      return { ok: true, path, width: saved.width, height: saved.height };
    } catch (error) {
      return { ok: false, code: 'write', detail: describe(error) };
    }
  } finally {
    photo.release();
  }
}
