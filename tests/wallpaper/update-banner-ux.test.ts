import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockElement } from '../__mocks__/obsidian';
import { setLanguageOverride } from '../../src/i18n';
import type { WallpaperBannerState, WallpaperStatusTracker } from '../../src/app/contracts';
import { UpdateBanner, isBannerHidden } from '../../src/wallpaper/update-banner';

function tracker(initial: WallpaperBannerState, actionKind: 'update' | 'save' = 'update') {
  let state = initial;
  const run = vi.fn(async () => undefined);
  const listeners = new Set<(s: WallpaperBannerState) => void>();
  const status = {
    getState: () => state,
    getActionKind: () => actionKind,
    onChange: (listener: (s: WallpaperBannerState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run,
  } as unknown as WallpaperStatusTracker;
  const emit = (next: WallpaperBannerState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  return { status, emit, run };
}

function mount(status: WallpaperStatusTracker, compact: boolean, haptic = vi.fn()) {
  const container = new MockElement();
  const banner = new UpdateBanner({ status, sheets: { open: vi.fn() }, getHelpContext: () => ({ profileId: 'p', shortcutName: 's' }), compact, haptic });
  banner.mount(container as unknown as HTMLElement);
  const root = container.findAllByClass('mp-ls-banner')[0];
  if (!root) throw new Error('нет баннера');
  return { root, haptic };
}

beforeEach(() => setLanguageOverride('ru'));
afterEach(() => setLanguageOverride(null));

describe('баннер «Обновить экран блокировки» (006, §8)', () => {
  it('скрыт после успеха: подтверждение на iPhone, сохранение на компьютере', () => {
    expect(isBannerHidden({ kind: 'confirmed', at: 'x' }, 'update')).toBe(true);
    expect(isBannerHidden({ kind: 'saved', at: 'x' }, 'save')).toBe(true);
    expect(isBannerHidden({ kind: 'saved', at: 'x' }, 'update')).toBe(false);
    expect(isBannerHidden({ kind: 'dirty' }, 'update')).toBe(false);
    expect(isBannerHidden({ kind: 'failed', reason: 'render' }, 'save')).toBe(false);
  });

  it('компактный вид: одна строка без описания, описание — в подписи для диктора', () => {
    const { status } = tracker({ kind: 'dirty' });
    const { root } = mount(status, true);
    expect(root.hasClass('is-compact')).toBe(true);
    expect(root.findAllByClass('mp-ls-banner-subtitle')).toHaveLength(0);
    const action = root.findAllByClass('mp-ls-banner-action')[0];
    expect(action?.findAllByClass('mp-ls-banner-title')[0]?.getText()).toBe('Обновить экран блокировки');
    expect(action?.getAttribute('aria-label')).toMatch(/^Обновить экран блокировки\. .+/);
  });

  it('на компьютере — с описанием', () => {
    const { status } = tracker({ kind: 'dirty' }, 'save');
    const { root } = mount(status, false);
    expect(root.hasClass('is-compact')).toBe(false);
    expect(root.findAllByClass('mp-ls-banner-subtitle')).toHaveLength(1);
  });

  it('нажатие — tap и запуск; успех скрывает баннер, новые изменения показывают снова', () => {
    const { status, emit, run } = tracker({ kind: 'dirty' });
    const { root, haptic } = mount(status, true);
    root.findAllByClass('mp-ls-banner-action')[0]?.dispatch('click');
    expect(haptic).toHaveBeenCalledWith('tap');
    expect(run).toHaveBeenCalledTimes(1);
    emit({ kind: 'confirmed', at: '2026-10-11T10:00:00Z' });
    expect(root.hasClass('is-hidden')).toBe(true);
    emit({ kind: 'dirty' });
    expect(root.hasClass('is-hidden')).toBe(false);
  });
});
