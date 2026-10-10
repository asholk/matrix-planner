import { describe, it, expect, beforeAll } from 'vitest';
import type { FolderListing } from '../../src/app/contracts';
import { registerDictionary, setLanguageOverride } from '../../src/i18n';
import { ruModel } from '../../src/i18n/ru/model';
import { parseFloating } from '../../src/model/dates';
import { defaultMatrixConfig } from '../../src/model/defaults';
import type {
  DateRange,
  OpResult,
  PlannerPaths,
  PlannerSettings,
  QuadrantKey,
  Task,
  VaultPath,
  WallpaperLayout,
  WallpaperLayoutInput,
} from '../../src/model/types';
import { createDefaultSettings } from '../../src/settings/defaults';
import { BackgroundImageCache, type DecodedImage } from '../../src/wallpaper/background';
import { CanvasWallpaperRenderer, type CanvasFactory, type IconProvider, type RenderCanvas } from '../../src/wallpaper/canvas-renderer';
import { WallpaperOutputRepository, type OutputRepositoryDeps } from '../../src/wallpaper/output-repository';
import { PlannerWallpaperService } from '../../src/wallpaper/render-service';

const ROOT = 'Планировщик';
const PROFILE = 'iphone-1179x2556';
const FOLDER = `${ROOT}/Обои/${PROFILE}`;

beforeAll(() => {
  registerDictionary('ru', 'model', ruModel);
  setLanguageOverride('ru');
});

// ---------------------------------------------------------------------------
// Фейковый canvas: записывает тексты, «PNG» — JSON нарисованных строк
// ---------------------------------------------------------------------------

interface FakeCanvas extends RenderCanvas {
  texts: string[];
  calls: string[];
  released: boolean;
}

class FakeCanvasFactory implements CanvasFactory {
  readonly created: FakeCanvas[] = [];

  create(width: number, height: number): FakeCanvas {
    const texts: string[] = [];
    const calls: string[] = [];
    const state: Record<string | symbol, unknown> = {
      fillText: (text: string) => {
        texts.push(text);
        calls.push('fillText');
      },
      measureText: (text: string) => ({ width: text.length * 10 }),
      createLinearGradient: () => ({ addColorStop: () => undefined }),
    };
    const ctx = new Proxy(state, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => {
          calls.push(String(prop));
        };
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const canvas: FakeCanvas = { width, height, texts, calls, released: false, getContext: () => ctx };
    this.created.push(canvas);
    return canvas;
  }

  async toPng(canvas: RenderCanvas): Promise<ArrayBuffer> {
    const fake = canvas as FakeCanvas;
    if (fake.released) throw new Error('canvas already released');
    return new TextEncoder().encode(JSON.stringify(fake.texts)).buffer;
  }

  release(canvas: RenderCanvas): void {
    (canvas as FakeCanvas).released = true;
    canvas.width = 0;
    canvas.height = 0;
  }

  /** Холсты рендера (без служебного холста измерителя 1×1). */
  renderCanvases(): FakeCanvas[] {
    return this.created.filter((c) => c.calls.length > 0 || c.texts.length > 0);
  }
}

const noIcons: IconProvider = { load: async () => null };

// ---------------------------------------------------------------------------
// Хранилище в памяти
// ---------------------------------------------------------------------------

class MemoryRepository implements OutputRepositoryDeps {
  readonly files = new Map<VaultPath, ArrayBuffer>();
  readonly order: VaultPath[] = [];
  failWrite = new Set<VaultPath>();
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
    if (this.failWrite.has(path)) return { ok: false, error: { code: 'write-failed', detail: `failed: ${path}` } };
    this.order.push(path);
    this.files.set(path, data);
    return { ok: true, value: undefined, changed: true };
  }

  async listFolder(path: VaultPath): Promise<OpResult<FolderListing>> {
    const prefix = `${path}/`;
    const files = [...this.files.keys()].filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'));
    if (files.length === 0) return { ok: false, error: { code: 'not-found' } };
    return { ok: true, value: { files: files.sort(), folders: [] }, changed: false };
  }

  async trash(path: VaultPath): Promise<OpResult> {
    if (!this.files.delete(path)) return { ok: false, error: { code: 'not-found' } };
    return { ok: true, value: undefined, changed: true };
  }

  text(path: VaultPath): string[] | null {
    const data = this.files.get(path);
    return data ? (JSON.parse(new TextDecoder().decode(data)) as string[]) : null;
  }
}

// ---------------------------------------------------------------------------
// Сборка сервиса
// ---------------------------------------------------------------------------

function makeTask(id: string, quadrant: QuadrantKey, dueRaw: string | null): Task {
  const due = dueRaw === null ? null : parseFloating(dueRaw);
  return {
    kind: 'task',
    id,
    path: `${ROOT}/Задачи/${id}.md`,
    title: id,
    mtime: 0,
    props: {
      type: 'task',
      id,
      quadrant,
      due: dueRaw,
      repeat: 'none',
      repeat_anchor: null,
      remind: 'none',
      priority: 'normal',
      done: false,
      completed: null,
      completions: [],
      created: null,
    },
    extra: {},
    issues: [],
    quadrant,
    due,
    repeat: 'none',
    repeatAnchor: due ? due.date : null,
    remind: 'none',
    priority: 'normal',
    done: false,
    completed: null,
    completions: [],
    created: null,
    archived: false,
  };
}

interface Harness {
  service: PlannerWallpaperService;
  repo: MemoryRepository;
  canvases: FakeCanvasFactory;
  settings: PlannerSettings;
  tasks: Task[];
  ranges: { range: DateRange; options: unknown }[];
  revision: { value: number };
  /** Даты, на которых раскладка бросает исключение. */
  failDates: Set<string>;
  /** Вызывается из раскладки (имитация правки во время рендера). */
  onLayout: ((input: WallpaperLayoutInput) => void) | null;
  images: { reads: number; released: number; present: boolean };
}

function setup(now = '2026-12-29T10:00:00Z'): Harness {
  const repo = new MemoryRepository();
  const canvases = new FakeCanvasFactory();
  const settings = createDefaultSettings();
  settings.wallpaper.profile = PROFILE;
  const images = { reads: 0, released: 0, present: true };
  const imageCache = new BackgroundImageCache(
    {
      read: async () => {
        images.reads += 1;
        return images.present ? new ArrayBuffer(4) : null;
      },
    },
    async (): Promise<DecodedImage> => ({
      source: {} as CanvasImageSource,
      width: 2000,
      height: 3000,
      release: () => {
        images.released += 1;
      },
    }),
  );
  const renderer = new CanvasWallpaperRenderer({ canvases, images: imageCache, icons: noIcons });
  const h: Harness = {
    service: null as unknown as PlannerWallpaperService,
    repo,
    canvases,
    settings,
    tasks: [makeTask('call', 'do', '2026-12-30 17:00')],
    ranges: [],
    revision: { value: 5 },
    failDates: new Set(),
    onLayout: null,
    images,
  };
  const layout = (input: WallpaperLayoutInput): WallpaperLayout => {
    h.onLayout?.(input);
    if (h.failDates.has(input.date)) throw new Error(`layout failed ${input.date}`);
    const first = input.tasksByQuadrant.do[0];
    const due = first?.due ? input.strings.formatDue(first.due, input.date) : '-';
    return {
      width: input.profile.width,
      height: input.profile.height,
      commands: [
        { op: 'text', x: 0, y: 0, text: input.date, font: { size: 10, weight: 400, family: null }, color: '#fff', align: 'left', baseline: 'top' },
        { op: 'text', x: 0, y: 20, text: due, font: { size: 10, weight: 400, family: null }, color: '#fff', align: 'left', baseline: 'top' },
        { op: 'icon', name: 'check', x: 0, y: 40, size: 24, color: '#fff' },
      ],
      overflow: {},
    };
  };
  h.service = new PlannerWallpaperService({
    settings: { get: () => settings },
    index: { getTasks: () => h.tasks, getMatrix: () => defaultMatrixConfig('ru') },
    dayItems: {
      getDays: (range, options) => {
        h.ranges.push({ range, options });
        return new Map();
      },
    },
    output: new WallpaperOutputRepository(repo),
    renderer,
    clock: { now: () => new Date(now), timeZone: () => 'UTC' },
    format: { get: () => ({ language: 'ru', weekStart: 1, hour12: false }) },
    getDataRevision: () => h.revision.value,
    getScreen: () => null,
    layout,
  });
  return h;
}

const DATES = ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04'];
const dated = (date: string) => `${FOLDER}/lock-${date}.png`;
const LOCK = `${FOLDER}/lock.png`;

// ---------------------------------------------------------------------------

describe('PlannerWallpaperService.renderAll', () => {
  it('writes seven dated files across the year boundary and lock.png last', async () => {
    const h = setup();
    const result = await h.service.renderAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profile.id).toBe(PROFILE);
    expect(result.value.written).toEqual(DATES.map(dated));
    expect(result.value.failed).toEqual([]);
    expect(result.value.lockUpdated).toBe(true);
    expect(h.repo.order).toEqual([...DATES.map(dated), LOCK]);
    expect(h.repo.text(LOCK)).toEqual(h.repo.text(dated('2026-12-29')));
    expect(h.ranges).toHaveLength(1);
    expect(h.ranges[0].options).toEqual({ forWallpaper: true });
    expect(h.ranges[0].range.from <= '2026-12-01').toBe(true);
    expect(h.ranges[0].range.to >= '2027-01-31').toBe(true);
  });

  it('draws relative labels from each date', async () => {
    const h = setup();
    await h.service.renderAll();
    expect(h.repo.text(dated('2026-12-29'))).toEqual(['2026-12-29', 'Завтра 17:00']);
    expect(h.repo.text(dated('2026-12-30'))).toEqual(['2026-12-30', '17:00']);
    expect(h.repo.text(dated('2026-12-31'))).toEqual(['2026-12-31', 'Вчера 17:00']);
    expect(h.repo.text(dated('2027-01-02'))).toEqual(['2027-01-02', '30 дек. 2026 17:00']);
  });

  it('renders sequentially and releases every canvas', async () => {
    const h = setup();
    await h.service.renderAll();
    const used = h.canvases.renderCanvases();
    expect(used).toHaveLength(7);
    expect(used.every((c) => c.released)).toBe(true);
    // Значок без картинки рисуется запасной фигурой.
    expect(used[0].calls).toContain('arc');
  });

  it('keeps going after a partial failure', async () => {
    const h = setup();
    h.failDates.add('2027-01-01');
    h.repo.failWrite.add(dated('2027-01-03'));
    const result = await h.service.renderAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed.map((f) => f.date)).toEqual(['2027-01-01', '2027-01-03']);
    expect(result.value.written).toEqual(DATES.filter((d) => d !== '2027-01-01' && d !== '2027-01-03').map(dated));
    expect(result.value.lockUpdated).toBe(true);
  });

  it('keeps the previous lock.png when today fails to render', async () => {
    const h = setup();
    h.repo.files.set(LOCK, new TextEncoder().encode(JSON.stringify(['old'])).buffer);
    h.failDates.add('2026-12-29');
    const result = await h.service.renderAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lockUpdated).toBe(false);
    expect(h.repo.text(LOCK)).toEqual(['old']);
    expect(h.repo.order).not.toContain(LOCK);
  });

  it('removes a stale dated file for today when the new one cannot be written', async () => {
    const h = setup();
    h.repo.files.set(dated('2026-12-29'), new TextEncoder().encode(JSON.stringify(['old'])).buffer);
    h.repo.failWrite.add(dated('2026-12-29'));
    const result = await h.service.renderAll();
    expect(result.ok && result.value.failed.map((f) => f.date)).toEqual(['2026-12-29']);
    expect(result.ok && result.value.lockUpdated).toBe(true);
    // Быстрая команда не найдёт файла на сегодня и возьмёт новый lock.png.
    expect(h.repo.exists(dated('2026-12-29'))).toBe(false);
    expect(h.repo.exists(LOCK)).toBe(true);
  });

  it('fails without touching files when nothing can be written', async () => {
    const h = setup();
    h.repo.files.set(LOCK, new TextEncoder().encode(JSON.stringify(['old'])).buffer);
    h.repo.readOnly = true;
    const result = await h.service.renderAll();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('read-only');
    expect(h.repo.text(LOCK)).toEqual(['old']);
  });

  it('fails when every date fails to render', async () => {
    const h = setup();
    for (const d of DATES) h.failDates.add(d);
    const result = await h.service.renderAll();
    expect(result.ok).toBe(false);
    expect(h.repo.order).toEqual([]);
  });

  it('returns the data revision taken before rendering', async () => {
    const h = setup();
    h.onLayout = () => {
      h.revision.value += 1;
    };
    const result = await h.service.renderAll();
    expect(result.ok && result.value.dataRevision).toBe(5);
    expect(h.revision.value).toBe(12);
  });

  it('draws from a snapshot taken at the start', async () => {
    const h = setup();
    h.onLayout = (input) => {
      if (input.date === '2026-12-29') h.tasks = [];
    };
    await h.service.renderAll();
    expect(h.repo.text(dated('2027-01-04'))?.[1]).not.toBe('-');
  });

  it('removes only own stale dated files of the profile', async () => {
    const h = setup();
    const put = (path: string) => h.repo.files.set(path, new ArrayBuffer(1));
    put(`${FOLDER}/lock-2026-12-27.png`);
    put(`${FOLDER}/lock-2026-12-28.png`);
    put(`${FOLDER}/shortcut-last-run.txt`);
    put(`${FOLDER}/фото.png`);
    put(`${ROOT}/Обои/screen-1080x2400/lock-2026-12-01.png`);
    await h.service.renderAll();
    expect(h.repo.files.has(`${FOLDER}/lock-2026-12-27.png`)).toBe(false);
    expect(h.repo.files.has(`${FOLDER}/lock-2026-12-28.png`)).toBe(false);
    expect(h.repo.files.has(`${FOLDER}/shortcut-last-run.txt`)).toBe(true);
    expect(h.repo.files.has(`${FOLDER}/фото.png`)).toBe(true);
    expect(h.repo.files.has(`${ROOT}/Обои/screen-1080x2400/lock-2026-12-01.png`)).toBe(true);
    expect(h.repo.files.has(LOCK)).toBe(true);
  });

  it('is idempotent on repeated runs', async () => {
    const h = setup();
    const first = await h.service.renderAll();
    const snapshot = new Map([...h.repo.files].map(([k, v]) => [k, new TextDecoder().decode(v)]));
    const second = await h.service.renderAll();
    expect(second.ok && second.value.written).toEqual(first.ok && first.value.written);
    expect(new Map([...h.repo.files].map(([k, v]) => [k, new TextDecoder().decode(v)]))).toEqual(snapshot);
    expect([...h.repo.files.keys()].filter((k) => k.startsWith(FOLDER))).toHaveLength(8);
  });

  it('shares one run between concurrent calls', async () => {
    const h = setup();
    const [a, b] = await Promise.all([h.service.renderAll(), h.service.renderAll()]);
    expect(a).toBe(b);
    expect(h.repo.order).toHaveLength(8);
  });

  it('loads a background image once per batch and releases it', async () => {
    const h = setup();
    h.settings.wallpaper.background = { kind: 'image', path: 'Картинки/фон.jpg', crop: { centerX: 0.5, centerY: 0.5, scale: 1 } };
    await h.service.renderAll();
    expect(h.images.reads).toBe(1);
    expect(h.images.released).toBe(1);
    expect(h.canvases.renderCanvases()[0].calls).toContain('drawImage');
  });

  it('renders with a fallback when the background image is missing', async () => {
    const h = setup();
    h.images.present = false;
    h.settings.wallpaper.background = { kind: 'image', path: 'нет.png', crop: { centerX: 0.5, centerY: 0.5, scale: 1 } };
    const result = await h.service.renderAll();
    expect(result.ok && result.value.written).toHaveLength(7);
    expect(h.canvases.renderCanvases()[0].calls).not.toContain('drawImage');
  });

  it('uses a gradient background', async () => {
    const h = setup();
    h.settings.wallpaper.background = { kind: 'gradient', from: '#000', to: '#fff', angle: 180 };
    const result = await h.service.renderAll();
    expect(result.ok).toBe(true);
    expect(h.canvases.renderCanvases()[0].calls).toContain('fillRect');
  });
});

describe('PlannerWallpaperService helpers', () => {
  it('reports the current image path only when lock.png exists', async () => {
    const h = setup();
    expect(h.service.getCurrentImagePath()).toBeNull();
    await h.service.renderAll();
    expect(h.service.getCurrentImagePath()).toBe(LOCK);
  });

  it('resolves the profile from settings or the screen', () => {
    const h = setup();
    expect(h.service.resolveProfile().id).toBe(PROFILE);
    expect(h.service.resolveProfile({ ...h.settings.wallpaper, profile: 'screen-1080x2400' }).id).toBe('screen-1080x2400');
  });

  it('renders a preview into a given canvas without writing files', async () => {
    const h = setup();
    const canvas = h.canvases.create(0, 0);
    await h.service.renderPreview(canvas as unknown as HTMLCanvasElement, h.settings.wallpaper, '2026-12-31');
    expect(canvas.width).toBe(1179);
    expect(canvas.texts[0]).toBe('2026-12-31');
    expect(h.repo.order).toEqual([]);
  });
});
