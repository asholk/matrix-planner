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

export interface PhotoImportEnv {
  /** Бросает, если фото не открывается (например, HEIC без поддержки). */
  decode(blob: Blob): Promise<DecodedPhoto>;
  encodeJpeg(photo: DecodedPhoto, size: { width: number; height: number }, quality: number): Promise<ArrayBuffer>;
}

/** Ошибка декодирования: показываем «выберите JPEG или PNG». */
export class PhotoDecodeError extends Error {}

/** Декодирует фото с учётом EXIF-ориентации; запасной путь — `<img>`. */
export async function decodePhotoBlob(blob: Blob, api: PhotoDecodeApi): Promise<DecodedPhoto> {
  const errors: unknown[] = [];
  if (api.createImageBitmap) {
    try {
      const bitmap = await api.createImageBitmap(blob, { imageOrientation: 'from-image' });
      if (bitmap.width > 0 && bitmap.height > 0) {
        return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
      }
      bitmap.close?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (api.loadImage) {
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
    const img = activeDocument.createEl('img');
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
    decode: (blob) => decodePhotoBlob(blob, api),
    encodeJpeg: (photo, size, quality) =>
      encodePhotoJpeg(photo, size, quality, (width, height) => {
        const canvas = activeDocument.createEl('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
      }),
  };
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
}

export type PhotoImportResult =
  | { ok: true; path: VaultPath; width: number; height: number }
  | { ok: false; code: 'read-only'; messageKey: string }
  | { ok: false; code: 'decode' | 'encode' | 'write'; detail: string };

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

/** Декодирует, уменьшает, сохраняет JPEG; возвращает путь нового файла. */
export async function importPhoto(file: Blob, deps: PhotoImportDeps): Promise<PhotoImportResult> {
  const blocked = deps.guard?.check() ?? null;
  if (blocked) return { ok: false, code: 'read-only', messageKey: blocked.messageKey };

  let decoded: DecodedPhoto;
  try {
    decoded = await deps.env.decode(file);
  } catch (error) {
    return { ok: false, code: 'decode', detail: describe(error) };
  }

  const size = fitPhotoSize(decoded.width, decoded.height, photoMaxSide(deps.profile));
  let jpeg: ArrayBuffer;
  try {
    jpeg = await deps.env.encodeJpeg(decoded, size, PHOTO_JPEG_QUALITY);
  } catch (error) {
    return { ok: false, code: 'encode', detail: describe(error) };
  } finally {
    decoded.release();
  }

  // Запрет мог включиться, пока фото кодировалось.
  const blockedLate = deps.guard?.check() ?? null;
  if (blockedLate) return { ok: false, code: 'read-only', messageKey: blockedLate.messageKey };

  try {
    const folder = photoFolder(deps.rootFolder);
    await ensureFolder(deps.vault, folder);
    const path = photoTargetPath(deps.rootFolder, deps.now, deps.timeZone, (candidate) => deps.vault.getAbstractFileByPath(candidate) != null);
    await deps.vault.createBinary(path, jpeg);
    return { ok: true, path, width: size.width, height: size.height };
  } catch (error) {
    return { ok: false, code: 'write', detail: describe(error) };
  }
}
