import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShortcutLauncher, WallpaperBannerState, WallpaperRenderResult } from '../../src/app/contracts';
import { setLanguageOverride } from '../../src/i18n';
import type { CompanionState, OpResult, WallpaperProfile, WallpaperStatusRecord } from '../../src/model/types';
import { PlannerWallpaperStatusTracker } from '../../src/protocol/wallpaper-status';
import {
  bannerViewModel,
  bannerViewModelOf,
  statusNeedsAttention,
  statusTextOf,
  type WallpaperStatusTrackerExt,
} from '../../src/wallpaper/update-banner';

const PROFILE: WallpaperProfile = { id: 'iphone-1179x2556', label: 'iPhone', width: 1179, height: 2556, safeTop: 0.38, safeBottom: 0.88 };

beforeEach(() => setLanguageOverride('ru'));
afterEach(() => setLanguageOverride(null));

// ===========================================================================
// Чистая модель баннера
// ===========================================================================

describe('bannerViewModel', () => {
  it('iPhone/iPad: «Обновить экран блокировки» без пояснения в покое', () => {
    const model = bannerViewModel({ kind: 'idle' }, 'update');
    expect(model.title).toBe('Обновить экран блокировки');
    expect(model.subtitle).toBeNull();
    expect(model.tone).toBe('neutral');
    expect(model.icon).toBe('refresh-cw');
  });

  it('после изменений: «Есть изменения. Нажмите, чтобы перенести их на экран блокировки»', () => {
    const model = bannerViewModel({ kind: 'dirty' }, 'update');
    expect(model.title).toBe('Обновить экран блокировки');
    expect(model.subtitle).toBe('Есть изменения. Нажмите, чтобы перенести их на экран блокировки');
    expect(model.tone).toBe('attention');
    expect(model.ariaLabel).toContain('Есть изменения');
  });

  it('компьютер и Android: «Сохранить обои»', () => {
    const idle = bannerViewModel({ kind: 'idle' }, 'save');
    expect(idle.title).toBe('Сохранить обои');
    expect(idle.icon).toBe('download');
    expect(bannerViewModel({ kind: 'dirty' }, 'save').title).toBe('Сохранить обои');
  });

  it('сохранение PNG не означает установку: «Обои сохранены», а не «обновлён»', () => {
    const saved = bannerViewModel({ kind: 'saved', at: '2026-10-10T10:00:00Z' }, 'update');
    expect(saved.subtitle).toBe('Обои сохранены');
    expect(saved.tone).toBe('neutral');
    const launched = bannerViewModel({ kind: 'launched', at: '2026-10-10T10:00:00Z' }, 'update');
    expect(launched.subtitle).toBe('Быстрая команда запущена. Подтверждения пока нет');
    expect(launched.tone).not.toBe('success');
  });

  it('только подтверждение x-success показывает «Экран блокировки обновлён»', () => {
    const model = bannerViewModel({ kind: 'confirmed', at: '2026-10-10T10:00:00Z' }, 'update');
    expect(model.subtitle).toBe('Экран блокировки обновлён');
    expect(model.tone).toBe('success');
  });

  it('рендер: занято, повторное нажатие игнорируется', () => {
    const model = bannerViewModel({ kind: 'rendering' }, 'update');
    expect(model.busy).toBe(true);
  });

  it('ошибка команды — «Как настроить», ошибка рисования — без него', () => {
    const shortcut = bannerViewModel({ kind: 'failed', reason: 'callback-error' }, 'update');
    expect(shortcut.subtitle).toBe('Не удалось обновить экран блокировки');
    expect(shortcut.helpLabel).toBe('Как настроить');
    expect(shortcut.tone).toBe('error');
    expect(bannerViewModel({ kind: 'failed', reason: 'render' }, 'update').helpLabel).toBeNull();
  });
});

// ===========================================================================
// С трекером
// ===========================================================================

function record(patch: Partial<WallpaperStatusRecord>): WallpaperStatusRecord {
  return { profileId: PROFILE.id, savedAt: null, launchedAt: null, confirmedAt: null, failedAt: null, deviceName: null, ...patch };
}

function setup(options: { isIos: boolean; companion?: CompanionState; launch?: ShortcutLauncher['launch'] }) {
  let companion: CompanionState = options.companion ?? { status: 'missing' };
  const launches: string[] = [];
  const renderResult: OpResult<WallpaperRenderResult> = {
    ok: true,
    value: { profile: PROFILE, written: ['Планировщик/Обои/iphone-1179x2556/lock-2026-10-10.png'], failed: [], lockUpdated: true, dataRevision: 0 },
    changed: true,
  };
  const tracker = new PlannerWallpaperStatusTracker({
    wallpaper: { renderAll: async () => renderResult, resolveProfile: () => PROFILE },
    companion: {
      getState: () => companion,
      updateWallpaperStatus: async (profileId, patch) => {
        const prev = companion.status === 'ok' ? companion.wallpapers[profileId] ?? record({}) : record({});
        const wallpapers = { ...(companion.status === 'ok' ? companion.wallpapers : {}), [profileId]: { ...prev, ...patch } };
        companion = { status: 'ok', primaryDevice: null, lastUpdate: null, wallpapers };
        return { ok: true, value: undefined, changed: true };
      },
    },
    launcher: {
      launch:
        options.launch ??
        ((name: string) => {
          launches.push(name);
          return { ok: true };
        }),
    },
    platform: { isIos: options.isIos },
    clock: { now: () => new Date('2026-10-10T13:32:00Z'), timeZone: () => 'UTC' },
    notifier: { show: () => undefined },
    getShortcutName: () => 'Обои Планировщика',
  });
  return { tracker, launches };
}

describe('баннер и статус по трекеру', () => {
  it('нет подтверждения: статус «Нет подтверждённого обновления», выделен', () => {
    const { tracker } = setup({ isIos: true });
    expect(statusTextOf(tracker)).toBe('Нет подтверждённого обновления');
    expect(statusNeedsAttention(tracker)).toBe(true);
  });

  it('подтверждение было раньше: «Нет подтверждённого обновления с 9 окт.»', () => {
    const { tracker } = setup({
      isIos: true,
      companion: { status: 'ok', primaryDevice: null, lastUpdate: null, wallpapers: { [PROFILE.id]: record({ confirmedAt: '2026-10-09T00:05:00Z' }) } },
    });
    expect(statusTextOf(tracker)).toBe('Нет подтверждённого обновления с 9 окт.');
  });

  it('после сохранения и запуска команды без callback статус не говорит «обновлены»', async () => {
    const { tracker, launches } = setup({ isIos: true });
    tracker.markDataChanged();
    expect(bannerViewModelOf(tracker).subtitle).toBe('Есть изменения. Нажмите, чтобы перенести их на экран блокировки');
    await tracker.run();
    expect(launches).toEqual(['Обои Планировщика']);
    expect(tracker.getState().kind).toBe('launched');
    expect(statusTextOf(tracker)).toBe('Нет подтверждённого обновления');
    expect(statusNeedsAttention(tracker)).toBe(true);
  });

  it('после x-success: «Обои обновлены 10 окт. в 13:32»', async () => {
    const { tracker } = setup({ isIos: true });
    await tracker.run();
    await tracker.onWallpaperCallback('done');
    expect(bannerViewModelOf(tracker).subtitle).toBe('Экран блокировки обновлён');
    expect(statusTextOf(tracker)).toBe('Обои обновлены 10 окт. в 13:32');
    expect(statusNeedsAttention(tracker)).toBe(false);
  });

  it('свежие PNG: нажатие запускает команду синхронно, до первого await', () => {
    const { tracker, launches } = setup({ isIos: true });
    return tracker.run().then(() => {
      launches.length = 0;
      void tracker.run();
      expect(launches).toEqual(['Обои Планировщика']);
    });
  });

  it('компьютер/Android: «Сохранить обои», после сохранения — время сохранения, команда не запускается', async () => {
    const { tracker, launches } = setup({ isIos: false });
    expect(bannerViewModelOf(tracker).title).toBe('Сохранить обои');
    expect(statusTextOf(tracker)).toBe('Обои ещё не сохранены');
    tracker.markDataChanged();
    expect(bannerViewModelOf(tracker).subtitle).toBe('Есть изменения. Нажмите, чтобы сохранить обои');
    await tracker.run();
    expect(launches).toEqual([]);
    expect(tracker.getState().kind).toBe('saved');
    expect(statusTextOf(tracker)).toBe('Обои сохранены 10 окт. в 13:32');
    expect(statusNeedsAttention(tracker)).toBe(false);
  });

  it('трекер без методов вне контракта: запасной текст статуса', () => {
    let state: WallpaperBannerState = { kind: 'idle' };
    const minimal: WallpaperStatusTrackerExt = {
      getState: () => state,
      getActionKind: () => 'update',
      getDataRevision: () => 0,
      markDataChanged: () => undefined,
      run: async () => undefined,
      onWallpaperCallback: async () => undefined,
      onChange: () => () => undefined,
    };
    expect(statusTextOf(minimal)).toBe('Нет подтверждённого обновления');
    state = { kind: 'launched', at: '2026-10-10T10:00:00Z' };
    expect(statusTextOf(minimal)).toBe('Быстрая команда запущена. Подтверждения пока нет');
  });
});
