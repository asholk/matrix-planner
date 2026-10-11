import { describe, expect, it } from 'vitest';
import type { DrawCommand, WallpaperBackground, WallpaperLayout } from '../../src/model/types';
import { BackgroundImageCache, WallpaperBackgroundError, type DecodedImage } from '../../src/wallpaper/background';
import { CanvasWallpaperRenderer, FROST_DOWNSCALE, type CanvasFactory, type RenderCanvas } from '../../src/wallpaper/canvas-renderer';

interface Call {
  canvas: number;
  name: string;
  args: unknown[];
}

/** Холсты-фейки, записывающие вызовы 2D-контекста. */
class RecordingCanvases implements CanvasFactory {
  readonly calls: Call[] = [];
  readonly sizes: { width: number; height: number }[] = [];
  readonly released: number[] = [];
  readonly canvases: RenderCanvas[] = [];

  create(width: number, height: number): RenderCanvas {
    const index = this.sizes.length;
    this.sizes.push({ width, height });
    const calls = this.calls;
    const state: Record<string | symbol, unknown> = {
      measureText: (text: string) => ({ width: text.length * 10 }),
      createLinearGradient: () => ({ addColorStop: () => undefined }),
    };
    const ctx = new Proxy(state, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => {
          calls.push({ canvas: index, name: String(prop), args });
        };
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const canvas: RenderCanvas = { width, height, getContext: () => ctx };
    this.canvases.push(canvas);
    return canvas;
  }

  toPng(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(1));
  }

  release(canvas: RenderCanvas): void {
    this.released.push(this.canvases.indexOf(canvas));
    canvas.width = 0;
    canvas.height = 0;
  }
}

const IMAGE: WallpaperBackground = { kind: 'image', path: 'Фоны/фото.jpg', crop: { centerX: 0.5, centerY: 0.5, scale: 1 } };

function card(y: number): DrawCommand {
  return { op: 'rect', x: 50, y, w: 1079, h: 200, radius: 48, fill: 'rgba(0, 0, 0, 0.56)', backdrop: 'blur' };
}

function layout(commands: DrawCommand[]): WallpaperLayout {
  return { width: 1179, height: 2556, commands, overflow: {} };
}

function renderer(canvases: RecordingCanvases, images: BackgroundImageCache): CanvasWallpaperRenderer {
  return new CanvasWallpaperRenderer({ canvases, images, icons: { load: () => Promise.resolve(null) } });
}

function cacheWith(data: ArrayBuffer | null, decode?: () => Promise<DecodedImage>): BackgroundImageCache {
  return new BackgroundImageCache(
    { read: () => Promise.resolve(data) },
    decode ?? (() => Promise.resolve({ source: { id: 'photo' } as unknown as CanvasImageSource, width: 4032, height: 3024, release: () => undefined })),
  );
}

describe('матовое стекло под карточками (п.15)', () => {
  it('на фото-фоне: уменьшенная копия фона, обрезка по карточкам, без ctx.filter', async () => {
    const canvases = new RecordingCanvases();
    await renderer(canvases, cacheWith(new ArrayBuffer(8))).render({ layout: layout([card(800), card(1100)]), background: IMAGE });
    // Холст измерителя (1×1), основной, уменьшенный в FROST_DOWNSCALE раз и промежуточный.
    const small = canvases.sizes.findIndex((s) => s.width === Math.round(1179 / FROST_DOWNSCALE));
    expect(small).toBeGreaterThan(0);
    expect(canvases.sizes[small].height).toBe(Math.round(2556 / FROST_DOWNSCALE));
    const main = canvases.sizes.findIndex((s) => s.width === 1179 && s.height === 2556);
    const mainCalls = canvases.calls.filter((c) => c.canvas === main);
    expect(mainCalls.filter((c) => c.name === 'clip')).toHaveLength(2);
    // drawImage: фон + по одному на карточку.
    expect(mainCalls.filter((c) => c.name === 'drawImage')).toHaveLength(3);
    const order = mainCalls.map((c) => c.name);
    expect(order.indexOf('clip')).toBeLessThan(order.lastIndexOf('fill'));
    // Служебные холсты освобождены.
    expect(canvases.released).toEqual(expect.arrayContaining([small, main]));
    expect(canvases.calls.some((c) => c.name === 'filter')).toBe(false);
  });

  it('на однотонном фоне — как раньше: без размытой копии', async () => {
    const canvases = new RecordingCanvases();
    await renderer(canvases, cacheWith(null)).render({ layout: layout([card(800)]), background: { kind: 'solid', color: '#1C1C1E' } });
    expect(canvases.calls.some((c) => c.name === 'clip')).toBe(false);
    expect(canvases.calls.some((c) => c.name === 'drawImage')).toBe(false);
  });
});

describe('недоступное фото фона (п.8)', () => {
  it('нет файла — WallpaperBackgroundError(missing), холст не создаётся', async () => {
    const canvases = new RecordingCanvases();
    const error = await renderer(canvases, cacheWith(null))
      .render({ layout: layout([card(800)]), background: IMAGE })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WallpaperBackgroundError);
    expect(error).toMatchObject({ code: 'missing', path: 'Фоны/фото.jpg' });
    expect(canvases.sizes.some((s) => s.width === 1179)).toBe(false);
  });

  it('не декодируется — decode; предпросмотр (renderTo) тоже бросает', async () => {
    const canvases = new RecordingCanvases();
    const r = renderer(canvases, cacheWith(new ArrayBuffer(8), () => Promise.reject(new Error('bad image'))));
    const canvas = { width: 100, height: 216, getContext: () => null } as unknown as HTMLCanvasElement;
    await expect(r.renderTo(canvas, { layout: layout([]), background: IMAGE })).rejects.toMatchObject({ code: 'decode', detail: 'bad image' });
  });
});
