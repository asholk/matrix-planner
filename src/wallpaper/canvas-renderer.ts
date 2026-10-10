/**
 * Тонкий Canvas 2D renderer обоев: фон + команды `DrawCommand` → PNG.
 * Холсты создаются внедрённой фабрикой (`CanvasFactory`): в плагине — DOM-canvas,
 * в тестах — фейк. После рендера холст освобождается (важно для памяти iOS).
 */

import { getIcon } from 'obsidian';
import type { TextMeasurer, WallpaperRenderer, WallpaperRenderRequest } from '../app/contracts';
import type { DrawCommand, FontSpec, TextMetrics } from '../model/types';
import { BackgroundImageCache, loadImage, paintBackground, type DecodedImage, type ImageLease } from './background';

/** Системный шрифт, близкий к шрифту экрана блокировки. */
export const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Холст, достаточный для рендера (HTMLCanvasElement или фейк). */
export interface RenderCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
}

export interface CanvasFactory {
  create(width: number, height: number): RenderCanvas;
  /** PNG-байты холста (`canvas.toBlob` → `ArrayBuffer`). */
  toPng(canvas: RenderCanvas): Promise<ArrayBuffer>;
  /** Освобождает память холста. */
  release(canvas: RenderCanvas): void;
}

/** Значки Lucide как картинки для `drawImage`. */
export interface IconProvider {
  /** `null` — значок не найден (рисуется запасная фигура). */
  load(name: string, color: string, size: number): Promise<CanvasImageSource | null>;
  release?(): void;
}

// ---------------------------------------------------------------------------
// DOM-реализации
// ---------------------------------------------------------------------------

/** `canvas.toBlob('image/png')` → `ArrayBuffer`. */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('canvas.toBlob returned null'));
        return;
      }
      blob.arrayBuffer().then(resolve, reject);
    }, 'image/png');
  });
}

export function createDomCanvasFactory(): CanvasFactory {
  return {
    create(width, height) {
      const canvas = createEl('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    toPng: (canvas) => canvasToPng(canvas as HTMLCanvasElement),
    release(canvas) {
      // Нулевой размер сразу отдаёт память холста (Safari/WebView держит её до GC).
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

/** Значки через `getIcon` Obsidian: SVG → data-URL → `Image`. */
export function createObsidianIconProvider(): IconProvider {
  const cache = new Map<string, Promise<CanvasImageSource | null>>();
  return {
    load(name, color, size) {
      const key = `${name}|${color}|${size}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = loadIconImage(name, color, size).catch(() => null);
        cache.set(key, pending);
      }
      return pending;
    },
    release() {
      cache.clear();
    },
  };
}

async function loadIconImage(name: string, color: string, size: number): Promise<CanvasImageSource | null> {
  const svg = getIcon(name);
  if (!svg) return null;
  const px = String(Math.max(1, Math.round(size)));
  svg.setAttribute('width', px);
  svg.setAttribute('height', px);
  svg.setAttribute('color', color);
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const markup = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, color);
  return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
}

// ---------------------------------------------------------------------------
// Измерение текста
// ---------------------------------------------------------------------------

export function cssFont(font: FontSpec): string {
  return `${font.weight} ${font.size}px ${font.family ?? SYSTEM_FONT_STACK}`;
}

/** Измеритель на маленьком служебном холсте; те же шрифты, что и при рисовании. */
export class CanvasTextMeasurer implements TextMeasurer {
  private ctx: CanvasRenderingContext2D | null | undefined;

  constructor(private readonly canvases: CanvasFactory) {}

  measure(text: string, font: FontSpec): TextMetrics {
    if (this.ctx === undefined) this.ctx = this.canvases.create(1, 1).getContext('2d');
    const size = font.size;
    if (!this.ctx) return { width: text.length * size * 0.55, ascent: size * 0.8, descent: size * 0.2 };
    this.ctx.font = cssFont(font);
    const m = this.ctx.measureText(text);
    const ascent = positive(m.fontBoundingBoxAscent) ?? positive(m.actualBoundingBoxAscent) ?? size * 0.8;
    const descent = positive(m.fontBoundingBoxDescent) ?? positive(m.actualBoundingBoxDescent) ?? size * 0.2;
    return { width: m.width, ascent, descent };
  }
}

function positive(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Рисование команд
// ---------------------------------------------------------------------------

type IconCommand = Extract<DrawCommand, { op: 'icon' }>;

function iconKey(command: IconCommand): string {
  return `${command.name}|${command.color}|${Math.round(command.size)}`;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Смещение линии зачёркивания от `y` при данной базовой линии. */
function strikeOffset(baseline: Extract<DrawCommand, { op: 'text' }>['baseline'], size: number): number {
  switch (baseline) {
    case 'top':
      return size * 0.55;
    case 'middle':
      return size * 0.05;
    case 'alphabetic':
      return -size * 0.3;
    case 'bottom':
      return -size * 0.5;
  }
}

/** Рисует команды на контексте; значки — из заранее загруженной карты. */
export function drawCommands(
  ctx: CanvasRenderingContext2D,
  commands: readonly DrawCommand[],
  icons: ReadonlyMap<string, CanvasImageSource | null> = new Map(),
): void {
  for (const command of commands) {
    ctx.save();
    try {
      drawCommand(ctx, command, icons);
    } finally {
      ctx.restore();
    }
  }
}

function drawCommand(ctx: CanvasRenderingContext2D, command: DrawCommand, icons: ReadonlyMap<string, CanvasImageSource | null>): void {
  switch (command.op) {
    case 'rect': {
      roundRectPath(ctx, command.x, command.y, command.w, command.h, command.radius);
      ctx.fillStyle = command.fill;
      ctx.fill();
      const lineWidth = command.lineWidth ?? 1;
      if (command.stroke && lineWidth > 0) {
        ctx.strokeStyle = command.stroke;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      }
      return;
    }
    case 'circle': {
      ctx.beginPath();
      ctx.arc(command.cx, command.cy, Math.max(0, command.r), 0, Math.PI * 2);
      if (command.fill) {
        ctx.fillStyle = command.fill;
        ctx.fill();
      }
      if (command.stroke && command.lineWidth > 0) {
        ctx.strokeStyle = command.stroke;
        ctx.lineWidth = command.lineWidth;
        ctx.stroke();
      }
      return;
    }
    case 'line': {
      ctx.beginPath();
      ctx.moveTo(command.x1, command.y1);
      ctx.lineTo(command.x2, command.y2);
      ctx.strokeStyle = command.stroke;
      ctx.lineWidth = command.lineWidth;
      ctx.stroke();
      return;
    }
    case 'text': {
      ctx.font = cssFont(command.font);
      ctx.fillStyle = command.color;
      ctx.textAlign = command.align;
      ctx.textBaseline = command.baseline;
      ctx.fillText(command.text, command.x, command.y);
      if (command.strike) {
        const width = ctx.measureText(command.text).width;
        const left = command.align === 'left' ? command.x : command.align === 'right' ? command.x - width : command.x - width / 2;
        const y = command.y + strikeOffset(command.baseline, command.font.size);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.strokeStyle = command.color;
        ctx.lineWidth = Math.max(1, command.font.size / 14);
        ctx.stroke();
      }
      return;
    }
    case 'icon': {
      const image = icons.get(iconKey(command)) ?? null;
      if (image) {
        ctx.drawImage(image, command.x, command.y, command.size, command.size);
        return;
      }
      // Запасная фигура: кружок в квадрате значка.
      ctx.beginPath();
      ctx.arc(command.x + command.size / 2, command.y + command.size / 2, command.size * 0.35, 0, Math.PI * 2);
      ctx.strokeStyle = command.color;
      ctx.lineWidth = Math.max(1, command.size / 12);
      ctx.stroke();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

interface PreparedResources {
  image: DecodedImage | null;
  /** Картинка фона, выданная кэшем; вернуть после рисования. */
  lease: ImageLease | null;
  icons: Map<string, CanvasImageSource | null>;
}

export interface CanvasRendererDeps {
  canvases: CanvasFactory;
  /** Загрузчик картинок фона (кэш на пакет). */
  images: BackgroundImageCache;
  icons?: IconProvider;
}

export class CanvasWallpaperRenderer implements WallpaperRenderer {
  readonly measurer: TextMeasurer;
  private readonly icons: IconProvider;

  constructor(private readonly deps: CanvasRendererDeps) {
    this.measurer = new CanvasTextMeasurer(deps.canvases);
    this.icons = deps.icons ?? createObsidianIconProvider();
  }

  async render(request: WallpaperRenderRequest): Promise<ArrayBuffer> {
    const { width, height } = request.layout;
    // Ресурсы загружаются до создания холста, чтобы не держать его дольше нужного.
    const resources = await this.prepare(request);
    try {
      const canvas = this.deps.canvases.create(width, height);
      try {
        this.paint(canvas, request, resources);
        return await this.deps.canvases.toPng(canvas);
      } finally {
        this.deps.canvases.release(canvas);
      }
    } finally {
      resources.lease?.release();
    }
  }

  async renderTo(canvas: HTMLCanvasElement, request: WallpaperRenderRequest): Promise<void> {
    const resources = await this.prepare(request);
    try {
      if (canvas.width === 0 || canvas.height === 0) {
        canvas.width = request.layout.width;
        canvas.height = request.layout.height;
      }
      this.paint(canvas, request, resources);
    } finally {
      resources.lease?.release();
    }
  }

  /** Освобождает декодированную картинку фона и кэш значков (после пакета). */
  releaseResources(): void {
    this.deps.images.release();
    this.icons.release?.();
  }

  private async prepare(request: WallpaperRenderRequest): Promise<PreparedResources> {
    const lease = request.background.kind === 'image' ? await this.deps.images.acquire(request.background.path) : null;
    const icons = new Map<string, CanvasImageSource | null>();
    for (const command of request.layout.commands) {
      if (command.op !== 'icon') continue;
      const key = iconKey(command);
      if (icons.has(key)) continue;
      let source: CanvasImageSource | null = null;
      try {
        source = await this.icons.load(command.name, command.color, Math.round(command.size));
      } catch {
        source = null;
      }
      icons.set(key, source);
    }
    return { image: lease?.image ?? null, lease, icons };
  }

  private paint(
    canvas: RenderCanvas,
    request: WallpaperRenderRequest,
    resources: PreparedResources,
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    const { width, height } = request.layout;
    // Холст предпросмотра может быть меньше профиля — масштабируем.
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    paintBackground(ctx, request.background, resources.image, width, height);
    drawCommands(ctx, request.layout.commands, resources.icons);
  }
}
