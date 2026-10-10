/**
 * Фон обоев: картинка из хранилища (с кадрированием по `WallpaperCrop`, режим cover),
 * однотонный цвет или линейный градиент. Картинка читается `vault.readBinary`,
 * декодируется через Blob → `createImageBitmap` (или `Image` как запасной путь).
 */

import type { Vault } from 'obsidian';
import type { VaultPath, WallpaperBackground, WallpaperCrop } from '../model/types';

/** Цвет вместо картинки, которую не удалось прочитать или декодировать. */
export const FALLBACK_BACKGROUND_COLOR = '#1C1C1E';

/** Декодированная картинка, готовая к `drawImage`. */
export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Освобождает память (ImageBitmap.close / отзыв URL). */
  release(): void;
}

/** Чтение двоичного файла картинки фона; `null` — файла нет. */
export interface BackgroundImageReader {
  read(path: VaultPath): Promise<ArrayBuffer | null>;
}

export type ImageDecoder = (data: ArrayBuffer, mime: string) => Promise<DecodedImage>;

/** Картинка фона может лежать в любом месте хранилища, поэтому читается напрямую из `Vault`. */
export function createVaultImageReader(vault: Pick<Vault, 'getFileByPath' | 'readBinary'>): BackgroundImageReader {
  return {
    async read(path) {
      const file = vault.getFileByPath(path);
      return file ? vault.readBinary(file) : null;
    },
  };
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  svg: 'image/svg+xml',
};

export function mimeFromPath(path: VaultPath): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** Декодирование в браузере/WebView: ImageBitmap, если доступен, иначе `<img>` с object URL. */
export const decodeImageInBrowser: ImageDecoder = async (data, mime) => {
  const blob = new Blob([data], { type: mime });
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Некоторые WebView не декодируют отдельные форматы через ImageBitmap — пробуем <img>.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
};

/** Загрузка `Image` по URL (data/object URL). */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

// ---------------------------------------------------------------------------
// Геометрия (чистые функции)
// ---------------------------------------------------------------------------

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Область исходной картинки для режима cover с кадрированием:
 * картинка заполняет холст целиком, `scale ≥ 1` дополнительно приближает,
 * центр кадра — `centerX/centerY` в долях; кадр не выходит за края картинки.
 */
export function computeCoverRect(
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
  crop: WallpaperCrop,
): SourceRect {
  const scale = Math.max(1, finiteOr(crop.scale, 1));
  const cover = Math.max(dstWidth / srcWidth, dstHeight / srcHeight) * scale;
  const sw = Math.min(srcWidth, dstWidth / cover);
  const sh = Math.min(srcHeight, dstHeight / cover);
  const cx = Math.min(1, Math.max(0, finiteOr(crop.centerX, 0.5))) * srcWidth;
  const cy = Math.min(1, Math.max(0, finiteOr(crop.centerY, 0.5))) * srcHeight;
  const sx = Math.min(srcWidth - sw, Math.max(0, cx - sw / 2));
  const sy = Math.min(srcHeight - sh, Math.max(0, cy - sh / 2));
  return { sx, sy, sw, sh };
}

export interface GradientLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Линия градиента по правилам CSS `linear-gradient(<angle>deg)`:
 * 0° — снизу вверх, 90° — слева направо, 180° — сверху вниз; углы прямоугольника
 * получают крайние цвета.
 */
export function gradientLine(width: number, height: number, angleDeg: number): GradientLine {
  const rad = (finiteOr(angleDeg, 180) * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const cx = width / 2;
  const cy = height / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

// ---------------------------------------------------------------------------
// Рисование
// ---------------------------------------------------------------------------

/** Минимальный набор методов 2D-контекста для фона. */
export type BackgroundContext = Pick<
  CanvasRenderingContext2D,
  'fillStyle' | 'fillRect' | 'createLinearGradient' | 'drawImage' | 'save' | 'restore'
>;

/**
 * Рисует фон на весь холст. Для `image` нужна декодированная картинка;
 * `null` — запасной однотонный фон.
 */
export function paintBackground(
  ctx: BackgroundContext,
  background: WallpaperBackground,
  image: DecodedImage | null,
  width: number,
  height: number,
): void {
  ctx.save();
  try {
    switch (background.kind) {
      case 'solid':
        ctx.fillStyle = background.color;
        ctx.fillRect(0, 0, width, height);
        break;
      case 'gradient': {
        const line = gradientLine(width, height, background.angle);
        const gradient = ctx.createLinearGradient(line.x0, line.y0, line.x1, line.y1);
        gradient.addColorStop(0, background.from);
        gradient.addColorStop(1, background.to);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
        break;
      }
      case 'image': {
        // Подложка на случай прозрачной картинки или сбоя.
        ctx.fillStyle = FALLBACK_BACKGROUND_COLOR;
        ctx.fillRect(0, 0, width, height);
        if (image && image.width > 0 && image.height > 0) {
          const r = computeCoverRect(image.width, image.height, width, height, background.crop);
          ctx.drawImage(image.source, r.sx, r.sy, r.sw, r.sh, 0, 0, width, height);
        }
        break;
      }
    }
  } finally {
    ctx.restore();
  }
}

/**
 * Загрузчик картинок фона с кэшем последней картинки: пакет из семи PNG
 * декодирует файл один раз; `release()` освобождает память после пакета.
 */
export class BackgroundImageCache {
  private cached: { path: VaultPath; image: DecodedImage } | null = null;

  constructor(
    private readonly reader: BackgroundImageReader,
    private readonly decode: ImageDecoder = decodeImageInBrowser,
  ) {}

  /** `null` — файла нет или он не декодируется (рисуется запасной фон). */
  async load(path: VaultPath): Promise<DecodedImage | null> {
    if (this.cached && this.cached.path === path) return this.cached.image;
    this.release();
    let image: DecodedImage | null = null;
    try {
      const data = await this.reader.read(path);
      if (data) image = await this.decode(data, mimeFromPath(path));
    } catch {
      image = null;
    }
    // Отсутствие не кэшируется: файл могут добавить, пока открыт предпросмотр.
    if (image) this.cached = { path, image };
    return image;
  }

  release(): void {
    this.cached?.image.release();
    this.cached = null;
  }
}
