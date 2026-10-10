import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockElement } from '../__mocks__/obsidian';
import type { App } from 'obsidian';
import type { SheetHandle, SheetOptions, WallpaperBannerState, WallpaperRenderResult } from '../../src/app/contracts';
import { setLanguageOverride } from '../../src/i18n';
import type { OpResult, VaultPath, WallpaperProfile } from '../../src/model/types';
import { defaultProfile } from '../../src/wallpaper/profiles';
import { PhotoExporter, type PhotoEnvironment } from '../../src/wallpaper/photo-export';

const LOCK = 'Планировщик/Обои/iphone-1179x2556/lock.png';
const NOW = '2026-10-11T09:00:00Z';

beforeEach(() => setLanguageOverride('ru'));
afterEach(() => setLanguageOverride(null));

interface Harness {
  exporter: PhotoExporter;
  status: { fresh: boolean; revision: number; kind: 'update' | 'save'; state: WallpaperBannerState; runs: number };
  renders: number;
  reads: number;
  renderOk: boolean;
  readOk: boolean;
  notices: string[];
  sheets: { options: SheetOptions; contentEl: MockElement; closed: number }[];
  shared: ShareData[];
  shareResult: () => Promise<void>;
  canShare: boolean;
  copied: Blob[];
  revoked: string[];
  appCalls: string[];
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setup(options: { mobile: boolean; share?: boolean; kind?: 'update' | 'save'; app?: Partial<App> | null; fresh?: boolean }): Harness {
  const profile: WallpaperProfile = defaultProfile();
  const h = {
    status: { fresh: options.fresh ?? false, revision: 1, kind: options.kind ?? 'update', state: { kind: 'dirty' }, runs: 0 },
    renders: 0,
    reads: 0,
    renderOk: true,
    readOk: true,
    notices: [] as string[],
    sheets: [] as Harness['sheets'],
    shared: [] as ShareData[],
    shareResult: () => Promise.resolve(),
    canShare: options.share ?? true,
    copied: [] as Blob[],
    revoked: [] as string[],
    appCalls: [] as string[],
  } as Harness;
  let urls = 0;
  const env: PhotoEnvironment = {
    isMobile: () => options.mobile,
    canShare: (data) => h.canShare && (data.files?.length ?? 0) === 1,
    share: options.share === false ? null : (data) => {
      h.shared.push(data);
      return h.shareResult();
    },
    copyImage: async (blob) => {
      h.copied.push(blob);
    },
    createFile: (blob, name) => new File([blob], name, { type: 'image/png' }),
    createObjectUrl: () => `blob:photo-${++urls}`,
    revokeObjectUrl: (url) => h.revoked.push(url),
  };
  h.exporter = new PhotoExporter({
    wallpaper: {
      resolveProfile: () => profile,
      renderAll: async (): Promise<OpResult<WallpaperRenderResult>> => {
        h.renders += 1;
        if (!h.renderOk) return { ok: false, error: { code: 'unknown' } };
        return { ok: true, value: { profile, written: [], failed: [], lockUpdated: true, dataRevision: h.status.revision }, changed: true };
      },
      readCurrentImage: async (): Promise<OpResult<{ path: VaultPath; data: ArrayBuffer }>> => {
        h.reads += 1;
        if (!h.readOk) return { ok: false, error: { code: 'not-found' } };
        return { ok: true, value: { path: LOCK, data: new Uint8Array([137, 80, 78, 71]).buffer }, changed: false };
      },
    },
    status: {
      isFresh: () => h.status.fresh,
      getDataRevision: () => h.status.revision,
      getActionKind: () => h.status.kind,
      getState: () => h.status.state,
      run: async () => {
        h.status.runs += 1;
        h.status.fresh = h.renderOk;
      },
    },
    clock: { now: () => new Date(NOW), timeZone: () => 'UTC' },
    notifier: { show: (message) => h.notices.push(message) },
    sheets: {
      open: (sheetOptions) => {
        const contentEl = new MockElement('div');
        const entry = { options: sheetOptions, contentEl, closed: 0 };
        const handle: SheetHandle = {
          setSubmitEnabled: () => undefined,
          setBusy: () => undefined,
          close: () => {
            entry.closed += 1;
            sheetOptions.onClose?.();
          },
        };
        sheetOptions.render(contentEl as unknown as HTMLElement, handle);
        h.sheets.push(entry);
        return handle;
      },
    },
    app: options.app === undefined ? null : (options.app as App | null),
    env,
  });
  return h;
}

function buttons(el: MockElement): MockElement[] {
  return el.findAllByClass('mp-ls-photo-action');
}

function sharedFile(data: ShareData): File {
  const file = data.files?.[0];
  if (!file) throw new Error('no file');
  return file;
}

describe('PhotoExporter on a phone', () => {
  it('shares synchronously on the first tap when the PNG was warmed', async () => {
    const h = setup({ mobile: true, fresh: true });
    h.exporter.warm();
    await flush();
    expect(h.reads).toBe(1);
    h.exporter.handleClick();
    // Без ожидания: share вызван в том же такте, что и нажатие.
    expect(h.shared).toHaveLength(1);
    const file = sharedFile(h.shared[0]);
    expect(file.name).toBe('Обои 2026-10-11.png');
    expect(file.type).toBe('image/png');
    expect(h.renders).toBe(0);
  });

  it('two steps: first tap renders and arms “Share”, second tap shares', async () => {
    const h = setup({ mobile: true });
    expect(h.exporter.buttonModel()).toMatchObject({ kind: 'get', label: 'Получить фото' });
    h.exporter.handleClick();
    expect(h.exporter.buttonModel().busy).toBe(true);
    await flush();
    expect(h.renders).toBe(1);
    expect(h.status.runs).toBe(0); // на iPhone быстрая команда не запускается
    expect(h.shared).toHaveLength(0);
    expect(h.exporter.buttonModel()).toMatchObject({ kind: 'share', label: 'Поделиться', busy: false });
    expect(h.notices).toHaveLength(1);
    h.exporter.handleClick();
    expect(h.shared).toHaveLength(1);
    expect(h.exporter.buttonModel().kind).toBe('get');
    expect(h.renders).toBe(1);
  });

  it('does not render again while its own render is fresh', async () => {
    const h = setup({ mobile: true });
    h.exporter.handleClick();
    await flush();
    h.exporter.handleClick();
    h.exporter.handleClick();
    expect(h.renders).toBe(1);
    expect(h.shared).toHaveLength(2);
  });

  it('re-renders after data changed', async () => {
    const h = setup({ mobile: true });
    h.exporter.handleClick();
    await flush();
    h.status.revision += 1;
    expect(h.exporter.buttonModel().kind).toBe('get');
    h.exporter.handleClick();
    await flush();
    expect(h.renders).toBe(2);
    expect(h.shared).toHaveLength(0);
  });

  it('falls back to the image sheet without navigator.share', async () => {
    const h = setup({ mobile: true, share: false, app: { vault: { getFileByPath: () => null } } as unknown as App });
    h.exporter.handleClick();
    await flush();
    expect(h.sheets).toHaveLength(1);
    const root = h.sheets[0].contentEl;
    const img = root.findAllByClass('mp-ls-photo-image')[0];
    expect(img.getAttribute('src')).toBe('blob:photo-1');
    expect(root.getText()).toContain('Нажмите и удерживайте изображение');
    expect(buttons(root).map((b) => b.getText())).toEqual(['Открыть файл']);
  });

  it('“Open file” opens lock.png in a new tab', async () => {
    const opened: unknown[] = [];
    const file = { path: LOCK };
    const app = {
      vault: { getFileByPath: (path: string) => (path === LOCK ? file : null) },
      workspace: { getLeaf: () => ({ openFile: async (f: unknown) => void opened.push(f) }) },
    } as unknown as App;
    const h = setup({ mobile: true, share: false, app });
    h.exporter.handleClick();
    await flush();
    buttons(h.sheets[0].contentEl)[0].click();
    expect(opened).toEqual([file]);
    expect(h.sheets[0].closed).toBe(1);
    expect(h.revoked).toEqual(['blob:photo-1']);
  });

  it('hides “Open file” without App', async () => {
    const h = setup({ mobile: true, share: false });
    h.exporter.handleClick();
    await flush();
    expect(buttons(h.sheets[0].contentEl)).toHaveLength(0);
  });

  it('cancelled share stays silent; a share error shows the sheet', async () => {
    const h = setup({ mobile: true, fresh: true });
    h.exporter.warm();
    await flush();
    h.shareResult = () => Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' }));
    h.exporter.handleClick();
    await flush();
    expect(h.sheets).toHaveLength(0);
    h.shareResult = () => Promise.reject(new Error('NotAllowedError'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.exporter.handleClick();
    await flush();
    expect(h.sheets).toHaveLength(1);
  });

  it('reports a render failure without a sheet', async () => {
    const h = setup({ mobile: true });
    h.renderOk = false;
    h.exporter.handleClick();
    await flush();
    expect(h.notices).toEqual(['Не удалось нарисовать обои']);
    expect(h.sheets).toHaveLength(0);
    expect(h.exporter.buttonModel()).toMatchObject({ kind: 'get', busy: false });
  });

  it('reports a read failure', async () => {
    const h = setup({ mobile: true, fresh: true });
    h.readOk = false;
    h.exporter.handleClick();
    await flush();
    expect(h.notices).toEqual(['Не удалось прочитать файл обоев']);
  });

  it('waits while the banner is rendering', async () => {
    const h = setup({ mobile: true });
    h.status.state = { kind: 'rendering' };
    h.exporter.handleClick();
    await flush();
    expect(h.renders).toBe(0);
    expect(h.notices[0]).toContain('ещё обновляются');
  });

  it('warm does nothing while files are stale', async () => {
    const h = setup({ mobile: true });
    h.exporter.warm();
    await flush();
    expect(h.reads).toBe(0);
  });
});

describe('PhotoExporter on a computer', () => {
  it('renders through the status tracker and opens the preview sheet', async () => {
    const h = setup({ mobile: false, kind: 'save' });
    h.exporter.handleClick();
    await flush();
    expect(h.status.runs).toBe(1);
    expect(h.renders).toBe(0);
    expect(h.sheets).toHaveLength(1);
    expect(h.sheets[0].options.title).toBe('Фото обоев');
    expect(buttons(h.sheets[0].contentEl).map((b) => b.getText())).toEqual(['Сохранить как…', 'Скопировать']);
  });

  it('opens the sheet immediately when files are fresh', async () => {
    const h = setup({ mobile: false, kind: 'save', fresh: true });
    h.exporter.warm();
    await flush();
    h.exporter.handleClick();
    expect(h.sheets).toHaveLength(1);
    expect(h.status.runs).toBe(0);
  });

  it('“Save as…” clicks a download link with a dated file name', async () => {
    const h = setup({ mobile: false, kind: 'save', fresh: true });
    h.exporter.handleClick();
    await flush();
    const click = vi.spyOn(MockElement.prototype, 'click');
    buttons(h.sheets[0].contentEl)[0].click();
    const link = click.mock.contexts.find((el) => (el as MockElement).tagName === 'A') as MockElement | undefined;
    expect(link?.getAttribute('download')).toBe('Обои 2026-10-11.png');
    expect(link?.getAttribute('href')).toBe('blob:photo-1');
    expect(link?.parent).toBeNull();
  });

  it('“Copy” writes the PNG to the clipboard', async () => {
    const h = setup({ mobile: false, kind: 'save', fresh: true });
    h.exporter.handleClick();
    await flush();
    buttons(h.sheets[0].contentEl)[1].click();
    await flush();
    expect(h.copied).toHaveLength(1);
    expect(h.copied[0].type).toBe('image/png');
    expect(h.notices).toEqual(['Картинка скопирована']);
  });

  it('shows “Show in folder” and “Open” only when App has them', async () => {
    const calls: string[] = [];
    const app = {
      showInFolder: (path: string) => calls.push(`folder:${path}`),
      openWithDefaultApp: (path: string) => calls.push(`open:${path}`),
    } as unknown as App;
    const h = setup({ mobile: false, kind: 'save', fresh: true, app });
    h.exporter.handleClick();
    await flush();
    const list = buttons(h.sheets[0].contentEl);
    expect(list.map((b) => b.getText())).toEqual(['Сохранить как…', 'Скопировать', 'Показать в папке', 'Открыть']);
    list[2].click();
    list[3].click();
    expect(calls).toEqual([`folder:${LOCK}`, `open:${LOCK}`]);
  });

  it('a failed tracker render shows no sheet', async () => {
    const h = setup({ mobile: false, kind: 'save' });
    h.renderOk = false;
    h.exporter.handleClick();
    await flush();
    expect(h.sheets).toHaveLength(0);
  });

  it('dispose stops further work', async () => {
    const h = setup({ mobile: false, kind: 'save', fresh: true });
    h.exporter.dispose();
    h.exporter.handleClick();
    await flush();
    expect(h.reads).toBe(0);
    expect(h.sheets).toHaveLength(0);
  });
});
