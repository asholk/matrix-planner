import { describe, expect, it } from 'vitest';
import type { WallpaperRenderResult } from '../../src/app/contracts';
import type { CompanionState, OpResult, WallpaperProfile, WallpaperStatusRecord } from '../../src/model/types';
import { buildShortcutRunUrl } from '../../src/protocol/links';
import { XCallbackShortcutLauncher, type ProfileShortcutLauncher } from '../../src/protocol/shortcut-launcher';
import {
  describeBanner,
  formatShortDate,
  formatWallpaperStatus,
  PlannerWallpaperStatusTracker,
} from '../../src/protocol/wallpaper-status';

const PROFILE: WallpaperProfile = { id: 'iphone-1179x2556', label: 'iPhone', width: 1179, height: 2556, safeTop: 0.38, safeBottom: 0.88 };

const RU: Record<string, string> = {
  'protocol.wallpaper.months.m10': 'окт.',
  'protocol.wallpaper.months.m2': 'февр.',
  'protocol.wallpaper.dayMonth': '{day} {month}',
  'protocol.wallpaper.status.confirmed': 'Обои обновлены {date} в {time}',
  'protocol.wallpaper.status.notConfirmedSince': 'Нет подтверждённого обновления с {date}',
  'protocol.wallpaper.status.neverConfirmed': 'Нет подтверждённого обновления',
  'protocol.wallpaper.status.saved': 'Обои сохранены {date} в {time}',
  'protocol.wallpaper.status.neverSaved': 'Обои ещё не сохранены',
};

function ru(key: string, params?: Record<string, string | number>): string {
  const template = RU[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (params?.[name] !== undefined ? String(params[name]) : m));
}

const keys = (key: string): string => key;

function record(patch: Partial<WallpaperStatusRecord>): WallpaperStatusRecord {
  return { profileId: PROFILE.id, savedAt: null, launchedAt: null, confirmedAt: null, failedAt: null, deviceName: null, ...patch };
}

class FakeClock {
  zone = 'UTC';
  constructor(public ms: number) {}
  now(): Date {
    return new Date(this.ms);
  }
  timeZone(): string {
    return this.zone;
  }
}

// ===========================================================================
// Тексты
// ===========================================================================

describe('formatWallpaperStatus', () => {
  const now = new Date('2026-10-10T15:00:00Z');

  it('shows confirmed update of today', () => {
    const text = formatWallpaperStatus(record({ confirmedAt: '2026-10-10T13:32:00Z' }), { now, timeZone: 'UTC', hour12: false, actionKind: 'update', translate: ru });
    expect(text).toBe('Обои обновлены 10 окт. в 13:32');
  });

  it('shows no confirmed update since an earlier day, even if launched later', () => {
    const text = formatWallpaperStatus(record({ confirmedAt: '2026-10-09T00:05:00Z', launchedAt: '2026-10-10T08:00:00Z', savedAt: '2026-10-10T08:00:00Z' }), {
      now,
      timeZone: 'UTC',
      hour12: false,
      actionKind: 'update',
      translate: ru,
    });
    expect(text).toBe('Нет подтверждённого обновления с 9 окт.');
  });

  it('handles never confirmed and the device time zone', () => {
    expect(formatWallpaperStatus(null, { now, timeZone: 'UTC', hour12: false, actionKind: 'update', translate: ru })).toBe('Нет подтверждённого обновления');
    // 23:30 UTC 9 октября — уже 10 октября в Москве.
    const text = formatWallpaperStatus(record({ confirmedAt: '2026-10-09T23:30:00Z' }), { now, timeZone: 'Europe/Moscow', hour12: false, actionKind: 'update', translate: ru });
    expect(text).toBe('Обои обновлены 10 окт. в 02:30');
  });

  it('shows saved time on desktop and Android', () => {
    expect(formatWallpaperStatus(record({ savedAt: '2026-10-10T13:32:00Z' }), { now, timeZone: 'UTC', hour12: false, actionKind: 'save', translate: ru })).toBe(
      'Обои сохранены 10 окт. в 13:32',
    );
    expect(formatWallpaperStatus(record({ confirmedAt: '2026-10-10T13:32:00Z' }), { now, timeZone: 'UTC', hour12: false, actionKind: 'save', translate: ru })).toBe(
      'Обои ещё не сохранены',
    );
  });

  it('formats short date', () => {
    expect(formatShortDate('2026-02-01', ru)).toBe('1 февр.');
  });
});

describe('describeBanner', () => {
  it('uses update texts on iPhone and save texts elsewhere', () => {
    expect(describeBanner({ kind: 'dirty' }, 'update', keys)).toMatchObject({ text: 'protocol.wallpaper.dirtyUpdate', actionLabel: 'protocol.wallpaper.actionUpdate', attention: true });
    expect(describeBanner({ kind: 'idle' }, 'save', keys)).toMatchObject({ text: 'protocol.wallpaper.actionSave', actionLabel: 'protocol.wallpaper.actionSave' });
  });

  it('offers help only for shortcut errors', () => {
    expect(describeBanner({ kind: 'failed', reason: 'callback-error' }, 'update', keys).helpLabel).toBe('protocol.wallpaper.howToSetUp');
    expect(describeBanner({ kind: 'failed', reason: 'shortcut' }, 'update', keys).helpLabel).toBe('protocol.wallpaper.howToSetUp');
    expect(describeBanner({ kind: 'failed', reason: 'render' }, 'update', keys).helpLabel).toBeNull();
  });
});

// ===========================================================================
// Запуск быстрой команды
// ===========================================================================

describe('XCallbackShortcutLauncher', () => {
  function launcher(isIos = true) {
    const clock = new FakeClock(Date.parse('2026-10-10T10:00:00Z'));
    const opened: string[] = [];
    const l = new XCallbackShortcutLauncher({
      links: { shortcutRunUrl: (name) => buildShortcutRunUrl('Хранилище', name) },
      platform: { isIos },
      clock,
      open: (url) => opened.push(url),
    });
    return { l, clock, opened };
  }

  it('opens x-callback url with vault in callbacks', () => {
    const { l, opened } = launcher();
    expect(l.launch('Обои Планировщика')).toEqual({ ok: true });
    expect(opened).toEqual([buildShortcutRunUrl('Хранилище', 'Обои Планировщика')]);
  });

  it('skips repeated launch within 10 seconds', () => {
    const { l, clock, opened } = launcher();
    l.launch('A');
    clock.ms += 9_999;
    expect(l.launch('A')).toEqual({ ok: false, reason: 'recently-launched' });
    clock.ms += 1;
    expect(l.launch('A')).toEqual({ ok: true });
    expect(opened).toHaveLength(2);
  });

  it('passes the launch profile into callback links', () => {
    const clock = new FakeClock(Date.parse('2026-10-10T10:00:00Z'));
    const opened: string[] = [];
    const l = new XCallbackShortcutLauncher({
      links: { shortcutRunUrl: (name, options) => buildShortcutRunUrl('V', name, options) },
      platform: { isIos: true },
      clock,
      open: (url) => opened.push(url),
    });
    l.launch('A', { profileId: 'iphone-1179x2556' });
    expect(opened).toEqual([buildShortcutRunUrl('V', 'A', { profileId: 'iphone-1179x2556' })]);
    expect(decodeURIComponent(opened[0]!)).toContain('profile=iphone-1179x2556');
  });

  it('is unsupported outside iPhone and iPad', () => {
    const { l, opened } = launcher(false);
    expect(l.launch('A')).toEqual({ ok: false, reason: 'unsupported' });
    expect(opened).toEqual([]);
  });
});

// ===========================================================================
// Трекер
// ===========================================================================

function renderOk(): OpResult<WallpaperRenderResult> {
  return { ok: true, changed: true, value: { profile: PROFILE, written: ['Планировщик/Обои/iphone-1179x2556/lock-2026-10-10.png'], failed: [], lockUpdated: true, dataRevision: 0 } };
}

function setupTracker(options: { isIos: boolean; launch?: ProfileShortcutLauncher['launch']; render?: () => Promise<OpResult<WallpaperRenderResult>>; shortcutName?: string }) {
  const clock = new FakeClock(Date.parse('2026-10-10T13:32:00Z'));
  const patches: Array<Partial<WallpaperStatusRecord>> = [];
  const messages: string[] = [];
  const launches: string[] = [];
  const launchProfiles: Array<string | null | undefined> = [];
  const patchProfiles: string[] = [];
  let renders = 0;
  const tracker = new PlannerWallpaperStatusTracker({
    wallpaper: {
      resolveProfile: () => PROFILE,
      renderAll: async () => {
        renders += 1;
        return options.render ? options.render() : renderOk();
      },
    },
    companion: {
      getState: (): CompanionState => ({ status: 'missing' }),
      updateWallpaperStatus: async (profileId, patch) => {
        patches.push(patch);
        patchProfiles.push(profileId);
        return { ok: true, value: undefined, changed: true };
      },
    },
    launcher: {
      launch:
        options.launch ??
        ((name, launchOptions) => {
          launches.push(name);
          launchProfiles.push(launchOptions?.profileId);
          return { ok: true };
        }),
    },
    platform: { isIos: options.isIos },
    clock,
    notifier: { show: (m) => messages.push(m) },
    getShortcutName: () => options.shortcutName ?? 'Обои Планировщика',
    translate: keys,
  });
  return { tracker, clock, patches, messages, launches, launchProfiles, patchProfiles, renders: () => renders };
}

describe('PlannerWallpaperStatusTracker', () => {
  it('desktop/Android: saves wallpaper only', async () => {
    const s = setupTracker({ isIos: false });
    expect(s.tracker.getActionKind()).toBe('save');
    s.tracker.markDataChanged();
    expect(s.tracker.getState()).toEqual({ kind: 'dirty' });
    await s.tracker.run();
    expect(s.tracker.getState()).toEqual({ kind: 'saved', at: '2026-10-10T13:32:00.000Z' });
    expect(s.launches).toEqual([]);
    expect(s.patches).toEqual([{ savedAt: '2026-10-10T13:32:00.000Z' }]);
  });

  it('iPhone: render → launch, saved and launched are separate fields', async () => {
    const s = setupTracker({ isIos: true });
    expect(s.tracker.getActionKind()).toBe('update');
    await s.tracker.run();
    expect(s.launches).toEqual(['Обои Планировщика']);
    expect(s.tracker.getState().kind).toBe('launched');
    expect(s.patches).toEqual([{ savedAt: '2026-10-10T13:32:00.000Z' }, { launchedAt: '2026-10-10T13:32:00.000Z' }]);
  });

  it('x-success confirms and records confirmedAt', async () => {
    const s = setupTracker({ isIos: true });
    await s.tracker.run();
    s.clock.ms += 5_000;
    await s.tracker.onWallpaperCallback('done');
    expect(s.tracker.getState()).toEqual({ kind: 'confirmed', at: '2026-10-10T13:32:05.000Z' });
    expect(s.patches.at(-1)).toEqual({ confirmedAt: '2026-10-10T13:32:05.000Z' });
    expect(s.messages.at(-1)).toBe('protocol.wallpaper.confirmed');
  });

  it('x-error marks failure with help', async () => {
    const s = setupTracker({ isIos: true });
    await s.tracker.run();
    await s.tracker.onWallpaperCallback('failed');
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'callback-error' });
    expect(s.patches.at(-1)).toEqual({ failedAt: '2026-10-10T13:32:00.000Z' });
    expect(s.tracker.describe().helpLabel).toBe('protocol.wallpaper.howToSetUp');
  });

  it('no callback: stays launched without confirmation', async () => {
    const s = setupTracker({ isIos: true });
    await s.tracker.run();
    s.clock.ms += 60_000;
    expect(s.tracker.getState().kind).toBe('launched');
    expect(s.patches.some((p) => 'confirmedAt' in p)).toBe(false);
  });

  it('fresh files: second tap launches without rendering again', async () => {
    const s = setupTracker({ isIos: true });
    await s.tracker.run();
    await s.tracker.run();
    expect(s.renders()).toBe(1);
    expect(s.launches).toHaveLength(2);
  });

  it('repeated launch within 10 seconds is skipped with a message', async () => {
    let calls = 0;
    const s = setupTracker({
      isIos: true,
      launch: () => (++calls === 1 ? { ok: true } : { ok: false, reason: 'recently-launched' }),
    });
    await s.tracker.run();
    await s.tracker.run();
    expect(s.messages).toContain('protocol.shortcut.recentlyLaunched');
    expect(s.patches.filter((p) => 'launchedAt' in p)).toHaveLength(1);
  });

  it('render failure', async () => {
    const s = setupTracker({ isIos: true, render: async () => ({ ok: false, error: { code: 'write-failed' } }) });
    await s.tracker.run();
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'render' });
    expect(s.launches).toEqual([]);
  });

  it('lock.png not updated (today failed) counts as render failure', async () => {
    const partial = renderOk();
    if (partial.ok) partial.value.lockUpdated = false;
    const s = setupTracker({ isIos: true, render: async () => partial });
    await s.tracker.run();
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'render' });
    expect(s.launches).toEqual([]);
    expect(s.patches.filter((p) => 'savedAt' in p)).toHaveLength(0);
  });

  it('empty shortcut name or launcher error → shortcut failure', async () => {
    const empty = setupTracker({ isIos: true, shortcutName: '  ' });
    await empty.tracker.run();
    expect(empty.tracker.getState()).toEqual({ kind: 'failed', reason: 'shortcut' });

    const throwing = setupTracker({
      isIos: true,
      launch: () => {
        throw new Error('blocked');
      },
    });
    await throwing.tracker.run();
    expect(throwing.tracker.getState()).toEqual({ kind: 'failed', reason: 'shortcut' });
  });

  it('data changed during render or before confirmation → dirty', async () => {
    let release: () => void = () => undefined;
    const s = setupTracker({
      isIos: false,
      render: () =>
        new Promise((resolve) => {
          release = () => resolve(renderOk());
        }),
    });
    const running = s.tracker.run();
    expect(s.tracker.getState().kind).toBe('rendering');
    s.tracker.markDataChanged();
    expect(s.tracker.getState().kind).toBe('rendering');
    release();
    await running;
    expect(s.tracker.getState()).toEqual({ kind: 'dirty' });

    const ios = setupTracker({ isIos: true });
    await ios.tracker.run();
    ios.tracker.markDataChanged();
    await ios.tracker.onWallpaperCallback('done');
    expect(ios.tracker.getState()).toEqual({ kind: 'dirty' });
  });

  it('day change: files are stale after the pack ends, second tap renders again', async () => {
    const s = setupTracker({ isIos: true });
    await s.tracker.run();
    expect(s.tracker.isFresh()).toBe(true);
    s.clock.ms += 8 * 86_400_000;
    expect(s.tracker.isFresh()).toBe(false);
    await s.tracker.run();
    expect(s.renders()).toBe(2);
    // Уже следующий день делает lock.png устаревшим.
    s.clock.ms += 86_400_000;
    expect(s.tracker.isFresh()).toBe(false);
  });

  it('time zone change: files are stale', async () => {
    const s = setupTracker({ isIos: true });
    await s.tracker.run();
    s.clock.zone = 'Asia/Tokyo';
    expect(s.tracker.isFresh()).toBe(false);
    await s.tracker.run();
    expect(s.renders()).toBe(2);
  });

  it('partial pack (future date failed): launches, reports failure, not fresh', async () => {
    const partial = renderOk();
    if (partial.ok) partial.value.failed = [{ date: '2026-10-12', detail: 'write-failed' }];
    const s = setupTracker({ isIos: true, render: async () => partial });
    await s.tracker.run();
    expect(s.launches).toHaveLength(1);
    expect(s.messages).toContain('wallpaperRender.errors.render');
    expect(s.tracker.isFresh()).toBe(false);
    await s.tracker.run();
    expect(s.renders()).toBe(2);
  });

  it('partial pack with today failed: no launch, render failure', async () => {
    const partial = renderOk();
    if (partial.ok) partial.value.failed = [{ date: '2026-10-10', detail: 'write-failed' }];
    const s = setupTracker({ isIos: true, render: async () => partial });
    await s.tracker.run();
    expect(s.launches).toEqual([]);
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'render' });
    expect(s.tracker.isFresh()).toBe(false);
  });

  it('desktop: partial pack is a render failure', async () => {
    const partial = renderOk();
    if (partial.ok) partial.value.failed = [{ date: '2026-10-14', detail: 'render' }];
    const s = setupTracker({ isIos: false, render: async () => partial });
    await s.tracker.run();
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'render' });
    expect(s.messages).not.toContain('protocol.wallpaper.saved');
  });

  it('launch carries the profile; callback writes into the profile from the link', async () => {
    const s = setupTracker({ isIos: true });
    await s.tracker.run();
    expect(s.launchProfiles).toEqual([PROFILE.id]);
    await s.tracker.onWallpaperCallback('done', { profileId: 'iphone-1170x2532' });
    expect(s.patchProfiles.at(-1)).toBe('iphone-1170x2532');
    await s.tracker.onWallpaperCallback('failed', { profileId: 'iphone-1170x2532' });
    expect(s.patchProfiles.at(-1)).toBe('iphone-1170x2532');
    // Нет профиля или он некорректен — текущий профиль.
    await s.tracker.onWallpaperCallback('done', { profileId: '../evil' });
    expect(s.patchProfiles.at(-1)).toBe(PROFILE.id);
    await s.tracker.onWallpaperCallback('done', { profileId: null });
    expect(s.patchProfiles.at(-1)).toBe(PROFILE.id);
  });

  it('notifies listeners and supports unsubscribe', async () => {
    const s = setupTracker({ isIos: false });
    const seen: string[] = [];
    const off = s.tracker.onChange((state) => seen.push(state.kind));
    await s.tracker.run();
    off();
    s.tracker.markDataChanged();
    expect(seen).toEqual(['rendering', 'saved']);
  });
});
