import { describe, expect, it } from 'vitest';
import type { WallpaperRenderOptions, WallpaperRenderResult } from '../../src/app/contracts';
import type { CompanionState, OpResult, WallpaperProfile, WallpaperStatusRecord } from '../../src/model/types';
import { buildShortcutRunUrl, type ShortcutRunOptions } from '../../src/protocol/links';
import { XCallbackShortcutLauncher, type ProfileShortcutLauncher } from '../../src/protocol/shortcut-launcher';
import {
  createRunId,
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
    expect(decodeURIComponent(opened[0])).toContain('profile=iphone-1179x2556');
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

function renderOk(patch: Partial<WallpaperRenderResult> = {}): OpResult<WallpaperRenderResult> {
  return {
    ok: true,
    changed: true,
    value: { profile: PROFILE, written: ['Планировщик/Обои/iphone-1179x2556/lock-2026-10-10.png'], failed: [], lockUpdated: true, dataRevision: 0, fingerprint: 'fp-1', ...patch },
  };
}

class FakeTimers {
  next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  set(callback: () => void, ms: number): number {
    const id = this.next++;
    this.pending.set(id, { callback, ms });
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Выполнить все ожидающие таймеры. */
  fire(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const timer of all) timer.callback();
  }
  delays(): number[] {
    return [...this.pending.values()].map((timer) => timer.ms);
  }
}

interface TrackerOptions {
  isIos: boolean;
  launch?: ProfileShortcutLauncher['launch'];
  render?: (options?: WallpaperRenderOptions) => Promise<OpResult<WallpaperRenderResult>>;
  shortcutName?: string;
  companion?: Record<string, Partial<WallpaperStatusRecord>>;
}

function setupTracker(options: TrackerOptions) {
  const clock = new FakeClock(Date.parse('2026-10-10T13:32:00Z'));
  const patches: Array<Partial<WallpaperStatusRecord>> = [];
  const messages: string[] = [];
  const launches: string[] = [];
  const launchOptions: Array<ShortcutRunOptions | undefined> = [];
  const patchProfiles: string[] = [];
  const logs: string[] = [];
  const renderOptions: Array<WallpaperRenderOptions | undefined> = [];
  const timers = new FakeTimers();
  const env = { foreground: true };
  const stored: Record<string, WallpaperStatusRecord> = {};
  for (const [id, rec] of Object.entries(options.companion ?? {})) stored[id] = record({ profileId: id, ...rec });
  let renders = 0;
  let runs = 0;
  const tracker = new PlannerWallpaperStatusTracker({
    wallpaper: {
      resolveProfile: () => PROFILE,
      renderAll: async (opts) => {
        renders += 1;
        renderOptions.push(opts);
        return options.render ? options.render(opts) : renderOk();
      },
    },
    companion: {
      getState: (): CompanionState => ({ status: 'ok', primaryDevice: null, lastUpdate: null, wallpapers: stored }),
      updateWallpaperStatus: async (profileId, patch) => {
        patches.push(patch);
        patchProfiles.push(profileId);
        stored[profileId] = { ...(stored[profileId] ?? record({ profileId })), ...patch };
        return { ok: true, value: undefined, changed: true };
      },
    },
    launcher: {
      launch:
        options.launch ??
        ((name, launchOpts) => {
          launches.push(name);
          launchOptions.push(launchOpts);
          return { ok: true };
        }),
    },
    platform: { isIos: options.isIos },
    clock,
    notifier: { show: (m) => messages.push(m) },
    getShortcutName: () => options.shortcutName ?? 'Обои Планировщика',
    translate: (key, params) => (params?.reason !== undefined ? `${key}:${params.reason}` : key),
    timers,
    isForeground: () => env.foreground,
    log: (message) => logs.push(message),
    createRunId: () => `run-${++runs}`,
  });
  return { tracker, clock, patches, messages, launches, launchOptions, patchProfiles, logs, timers, env, stored, renderOptions, renders: () => renders };
}

/** Пакет готов (второе нажатие запускает команду). */
async function readyPack(s: ReturnType<typeof setupTracker>): Promise<void> {
  await s.tracker.run();
  expect(s.tracker.getState().kind).toBe('ready');
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
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
    expect(s.patches).toEqual([{ savedAt: '2026-10-10T13:32:00.000Z', fingerprint: 'fp-1' }]);
  });

  it('iPhone: render after the gesture gives «ready», second tap launches synchronously', async () => {
    const s = setupTracker({ isIos: true });
    expect(s.tracker.getActionKind()).toBe('update');
    await readyPack(s);
    expect(s.launches).toEqual([]);
    expect(s.tracker.describe()).toMatchObject({ actionLabel: 'protocol.wallpaper.readyAction', text: 'protocol.wallpaper.readyHint' });
    // Запуск — до первого await (жест пользователя ещё действителен).
    const pending = s.tracker.run();
    expect(s.launches).toEqual(['Обои Планировщика']);
    expect(s.tracker.getState().kind).toBe('launched');
    await pending;
    expect(s.renders()).toBe(1);
    expect(s.patches).toEqual([
      { savedAt: '2026-10-10T13:32:00.000Z', fingerprint: 'fp-1' },
      { launchedAt: '2026-10-10T13:32:00.000Z', runId: 'run-1', errorMessage: null },
    ]);
  });

  it('launch passes profile, runId and the expected file of today', async () => {
    const s = setupTracker({ isIos: true });
    await readyPack(s);
    await s.tracker.run();
    expect(s.launchOptions).toEqual([{ profileId: PROFILE.id, runId: 'run-1', expectedFile: 'lock-2026-10-10.png' }]);
  });

  it('x-success of the pending run confirms', async () => {
    const s = setupTracker({ isIos: true });
    await readyPack(s);
    await s.tracker.run();
    s.clock.ms += 5_000;
    await s.tracker.onWallpaperCallback('done', { profileId: PROFILE.id, runId: 'run-1' });
    expect(s.tracker.getState()).toEqual({ kind: 'confirmed', at: '2026-10-10T13:32:05.000Z' });
    expect(s.patches.at(-1)).toEqual({ confirmedAt: '2026-10-10T13:32:05.000Z', errorMessage: null, runId: null });
    expect(s.messages.at(-1)).toBe('protocol.wallpaper.confirmed');
  });

  it('ignores late, foreign and repeated callbacks with a log entry', async () => {
    const s = setupTracker({ isIos: true });
    await readyPack(s);
    await s.tracker.run();
    await s.tracker.onWallpaperCallback('done', { profileId: PROFILE.id, runId: 'run-0' });
    expect(s.tracker.getState().kind).toBe('launched');
    expect(s.logs).toHaveLength(1);
    await s.tracker.onWallpaperCallback('done', { profileId: PROFILE.id, runId: 'run-1' });
    expect(s.tracker.getState().kind).toBe('confirmed');
    const patchCount = s.patches.length;
    await s.tracker.onWallpaperCallback('failed', { profileId: PROFILE.id, runId: 'run-1', errorMessage: 'x' });
    expect(s.tracker.getState().kind).toBe('confirmed');
    expect(s.patches).toHaveLength(patchCount);
    expect(s.logs).toHaveLength(2);
  });

  it('accepts the run stored in companion.json after a restart; old links without runId are accepted', async () => {
    const s = setupTracker({ isIos: true, companion: { [PROFILE.id]: { runId: 'run-77', launchedAt: '2026-10-10T13:00:00Z' } } });
    await s.tracker.onWallpaperCallback('done', { profileId: PROFILE.id, runId: 'run-76' });
    expect(s.tracker.getState().kind).toBe('idle');
    await s.tracker.onWallpaperCallback('done', { profileId: PROFILE.id, runId: 'run-77' });
    expect(s.tracker.getState().kind).toBe('confirmed');
    const legacy = setupTracker({ isIos: true });
    await legacy.tracker.onWallpaperCallback('done');
    expect(legacy.tracker.getState().kind).toBe('confirmed');
  });

  it('x-error shows and stores errorMessage from Shortcuts', async () => {
    const s = setupTracker({ isIos: true });
    await readyPack(s);
    await s.tracker.run();
    await s.tracker.onWallpaperCallback('failed', { profileId: PROFILE.id, runId: 'run-1', errorMessage: 'Нет доступа к папке' });
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'callback-error', message: 'Нет доступа к папке' });
    expect(s.messages.at(-1)).toBe('protocol.wallpaper.failedInstallReason:Нет доступа к папке');
    expect(s.patches.at(-1)).toEqual({ failedAt: '2026-10-10T13:32:00.000Z', errorMessage: 'Нет доступа к папке', runId: null });
    expect(s.tracker.describe()).toMatchObject({ text: 'protocol.wallpaper.failedInstallReason:Нет доступа к папке', helpLabel: 'protocol.wallpaper.howToSetUp' });
  });

  it('x-error without a message uses the generic text', async () => {
    const s = setupTracker({ isIos: true });
    await s.tracker.onWallpaperCallback('failed');
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'callback-error', message: null });
    expect(s.messages.at(-1)).toBe('protocol.wallpaper.failedCallback');
  });

  it('x-cancel: cancelled without error, banner back to «changes», not hidden', async () => {
    const s = setupTracker({ isIos: true });
    await readyPack(s);
    await s.tracker.run();
    await s.tracker.onWallpaperCallback('cancelled', { profileId: PROFILE.id, runId: 'run-1' });
    expect(s.tracker.getState()).toEqual({ kind: 'cancelled', at: '2026-10-10T13:32:00.000Z' });
    expect(s.tracker.describe()).toMatchObject({ text: 'protocol.wallpaper.dirtyUpdate', attention: true, helpLabel: null });
    expect(s.messages.at(-1)).toBe('protocol.wallpaper.cancelled');
    expect(s.patches.at(-1)).toEqual({ cancelledAt: '2026-10-10T13:32:00.000Z', runId: null });
    // Пакет по-прежнему свежий: следующее нажатие сразу запускает команду.
    await s.tracker.run();
    expect(s.launches).toHaveLength(2);
  });

  it('no callback: stays launched without confirmation', async () => {
    const s = setupTracker({ isIos: true });
    await readyPack(s);
    await s.tracker.run();
    s.clock.ms += 60_000;
    expect(s.tracker.getState().kind).toBe('launched');
    expect(s.patches.some((p) => 'confirmedAt' in p)).toBe(false);
  });

  it('repeated launch within 10 seconds is skipped with a message', async () => {
    let calls = 0;
    const s = setupTracker({
      isIos: true,
      launch: () => (++calls === 1 ? { ok: true } : { ok: false, reason: 'recently-launched' }),
    });
    await readyPack(s);
    await s.tracker.run();
    await s.tracker.run();
    expect(s.messages).toContain('protocol.shortcut.recentlyLaunched');
    expect(s.patches.filter((p) => 'launchedAt' in p)).toHaveLength(1);
  });

  it('render failure', async () => {
    const s = setupTracker({ isIos: true, render: async () => ({ ok: false, error: { code: 'write-failed' } }) });
    await s.tracker.run();
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'render', message: null });
    expect(s.launches).toEqual([]);
  });

  it('unavailable background: render failure with a clear reason, nothing saved', async () => {
    const s = setupTracker({
      isIos: true,
      render: async () => ({ ok: false, error: { code: 'not-found', messageKey: 'protocol.wallpaper.background.missing' } }),
    });
    await s.tracker.run();
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'render', message: 'protocol.wallpaper.background.missing' });
    expect(s.messages.at(-1)).toBe('protocol.wallpaper.failedRenderReason:protocol.wallpaper.background.missing');
    expect(s.patches).toEqual([]);
  });

  it('lock.png not updated (today failed) counts as render failure', async () => {
    const s = setupTracker({ isIos: true, render: async () => renderOk({ lockUpdated: false }) });
    await s.tracker.run();
    expect(s.tracker.getState().kind).toBe('failed');
    expect(s.launches).toEqual([]);
    expect(s.patches.filter((p) => 'savedAt' in p)).toHaveLength(0);
  });

  it('empty shortcut name or launcher error gives a shortcut failure', async () => {
    const empty = setupTracker({ isIos: true, shortcutName: '  ' });
    await readyPack(empty);
    await empty.tracker.run();
    expect(empty.tracker.getState()).toEqual({ kind: 'failed', reason: 'shortcut' });

    const throwing = setupTracker({
      isIos: true,
      launch: () => {
        throw new Error('blocked');
      },
    });
    await readyPack(throwing);
    await throwing.tracker.run();
    expect(throwing.tracker.getState()).toEqual({ kind: 'failed', reason: 'shortcut' });
  });

  it('data changed during render: rendered again; before confirmation: dirty', async () => {
    let release: () => void = () => undefined;
    let first = true;
    const s = setupTracker({
      isIos: false,
      render: () => {
        if (!first) return Promise.resolve(renderOk({ fingerprint: 'fp-2' }));
        first = false;
        return new Promise((resolve) => {
          release = () => resolve(renderOk());
        });
      },
    });
    const running = s.tracker.run();
    expect(s.tracker.getState().kind).toBe('rendering');
    s.tracker.markDataChanged();
    expect(s.tracker.getState().kind).toBe('rendering');
    release();
    await running;
    // Пакет, начатый до правки, дорисован заново.
    expect(s.renders()).toBe(2);
    expect(s.tracker.getState().kind).toBe('saved');

    const ios = setupTracker({ isIos: true });
    await readyPack(ios);
    await ios.tracker.run();
    ios.tracker.markDataChanged();
    await ios.tracker.onWallpaperCallback('done', { profileId: PROFILE.id, runId: 'run-1' });
    expect(ios.tracker.getState()).toEqual({ kind: 'dirty' });
  });

  it('day change: files are stale, second tap renders again', async () => {
    const s = setupTracker({ isIos: true });
    await readyPack(s);
    expect(s.tracker.isFresh()).toBe(true);
    s.clock.ms += 86_400_000;
    expect(s.tracker.isFresh()).toBe(false);
    await s.tracker.run();
    expect(s.renders()).toBe(2);
    expect(s.launches).toEqual([]);
  });

  it('time zone change: files are stale', async () => {
    const s = setupTracker({ isIos: true });
    await readyPack(s);
    s.clock.zone = 'Asia/Tokyo';
    expect(s.tracker.isFresh()).toBe(false);
    await s.tracker.run();
    expect(s.renders()).toBe(2);
  });

  it('partial pack (future date failed): ready to install, reports failure, not fresh', async () => {
    const s = setupTracker({ isIos: true, render: async () => renderOk({ failed: [{ date: '2026-10-12', detail: 'write-failed' }] }) });
    await s.tracker.run();
    expect(s.tracker.getState().kind).toBe('ready');
    expect(s.messages).toContain('wallpaperRender.errors.render');
    expect(s.tracker.isFresh()).toBe(false);
    expect(s.patches[0]).toEqual({ savedAt: '2026-10-10T13:32:00.000Z', fingerprint: null });
  });

  it('partial pack with today failed: no launch, render failure', async () => {
    const s = setupTracker({ isIos: true, render: async () => renderOk({ failed: [{ date: '2026-10-10', detail: 'write-failed' }] }) });
    await s.tracker.run();
    expect(s.launches).toEqual([]);
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'render' });
    expect(s.tracker.isFresh()).toBe(false);
  });

  it('desktop: partial pack is a render failure', async () => {
    const s = setupTracker({ isIos: false, render: async () => renderOk({ failed: [{ date: '2026-10-14', detail: 'render' }] }) });
    await s.tracker.run();
    expect(s.tracker.getState()).toEqual({ kind: 'failed', reason: 'render' });
    expect(s.messages).not.toContain('protocol.wallpaper.saved');
  });

  it('callback writes into the profile from the link', async () => {
    const s = setupTracker({ isIos: true });
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

// ===========================================================================
// Фоновая подготовка, свежесть, смена суток (п. 3, 4, 12)
// ===========================================================================

describe('PlannerWallpaperStatusTracker background preparation', () => {
  it('prepares ~4 s after the last change while in foreground', async () => {
    const s = setupTracker({ isIos: true });
    s.tracker.markDataChanged();
    s.tracker.markDataChanged();
    expect(s.timers.delays()).toEqual([4_000]);
    s.timers.fire();
    await flush();
    expect(s.renders()).toBe(1);
    expect(s.tracker.getState()).toEqual({ kind: 'ready', at: '2026-10-10T13:32:00.000Z' });
    expect(s.launches).toEqual([]);
    // Пакет свежий — нажатие сразу открывает команду.
    const pending = s.tracker.run();
    expect(s.launches).toHaveLength(1);
    await pending;
  });

  it('does not schedule in background; prepares immediately when Obsidian goes to background', async () => {
    const s = setupTracker({ isIos: true });
    s.env.foreground = false;
    s.tracker.markDataChanged();
    expect(s.timers.delays()).toEqual([]);
    s.tracker.onHidden();
    await flush();
    expect(s.renders()).toBe(1);
    s.tracker.onHidden();
    await flush();
    expect(s.renders()).toBe(1);
  });

  it('concurrent tap joins the background render instead of starting another', async () => {
    let release: () => void = () => undefined;
    const s = setupTracker({
      isIos: true,
      render: () =>
        new Promise((resolve) => {
          release = () => resolve(renderOk());
        }),
    });
    s.tracker.markDataChanged();
    const background = s.tracker.prepareNow();
    const tap = s.tracker.run();
    expect(s.tracker.getState().kind).toBe('rendering');
    release();
    await Promise.all([background, tap]);
    expect(s.renders()).toBe(1);
    expect(s.tracker.getState().kind).toBe('ready');
  });

  it('background errors are quiet: state kept, reason in getLastPrepareError and log', async () => {
    const s = setupTracker({
      isIos: true,
      render: async () => ({ ok: false, error: { code: 'not-found', messageKey: 'protocol.wallpaper.background.missing' } }),
    });
    s.tracker.markDataChanged();
    await s.tracker.prepareNow();
    expect(s.tracker.getState()).toEqual({ kind: 'dirty' });
    expect(s.messages).toEqual([]);
    expect(s.tracker.getLastPrepareError()).toBe('protocol.wallpaper.background.missing');
    expect(s.logs).toHaveLength(1);
  });

  it('desktop: background preparation saves the wallpaper (banner hidden)', async () => {
    const s = setupTracker({ isIos: false });
    s.tracker.markDataChanged();
    await s.tracker.prepareNow();
    expect(s.tracker.getState().kind).toBe('saved');
    expect(s.messages).toEqual([]);
  });

  it('passes the stored fingerprint; unchanged pack keeps savedAt and restores «confirmed» after restart', async () => {
    const s = setupTracker({
      isIos: true,
      companion: { [PROFILE.id]: { fingerprint: 'fp-1', savedAt: '2026-10-10T08:00:00.000Z', confirmedAt: '2026-10-10T08:00:05.000Z' } },
      render: async () => renderOk({ unchanged: true }),
    });
    expect(s.tracker.isFresh()).toBe(false);
    s.tracker.refresh();
    expect(s.tracker.getState().kind).toBe('idle');
    expect(s.timers.delays()).toEqual([0]);
    s.timers.fire();
    await flush();
    expect(s.renderOptions[0]).toEqual({ knownFingerprint: 'fp-1' });
    expect(s.tracker.isFresh()).toBe(true);
    expect(s.tracker.getState()).toEqual({ kind: 'confirmed', at: '2026-10-10T08:00:00.000Z' });
    expect(s.patches).toEqual([]);
  });

  it('unchanged pack confirmed yesterday is only «ready»', async () => {
    const s = setupTracker({
      isIos: true,
      companion: { [PROFILE.id]: { fingerprint: 'fp-1', savedAt: '2026-10-09T08:00:00.000Z', confirmedAt: '2026-10-09T08:00:05.000Z' } },
      render: async () => renderOk({ unchanged: true }),
    });
    await s.tracker.prepareNow();
    expect(s.tracker.getState().kind).toBe('ready');
  });

  it('edits that do not change the picture return to «confirmed»', async () => {
    const s = setupTracker({ isIos: true });
    await readyPack(s);
    await s.tracker.run();
    await s.tracker.onWallpaperCallback('done', { profileId: PROFILE.id, runId: 'run-1' });
    s.tracker.markDataChanged();
    expect(s.tracker.getState().kind).toBe('dirty');
    await s.tracker.prepareNow();
    expect(s.tracker.getState().kind).toBe('confirmed');
  });

  it('day change: yesterday «updated» no longer hides the banner; subscribers are notified', async () => {
    const s = setupTracker({ isIos: true });
    await readyPack(s);
    await s.tracker.run();
    await s.tracker.onWallpaperCallback('done', { profileId: PROFILE.id, runId: 'run-1' });
    const seen: string[] = [];
    s.tracker.onChange((state) => seen.push(state.kind));
    s.tracker.refresh();
    expect(seen).toEqual([]);
    s.clock.ms += 12 * 3_600_000; // 01:32 следующего дня
    s.tracker.refresh();
    expect(s.tracker.getState().kind).toBe('dirty');
    expect(seen).toEqual(['dirty']);
    expect(s.timers.delays()).toEqual([0]);
  });

  it('day change while failed still signals subscribers (thumbnails)', async () => {
    const s = setupTracker({ isIos: true });
    await s.tracker.onWallpaperCallback('failed');
    const seen: string[] = [];
    s.tracker.onChange((state) => seen.push(state.kind));
    s.clock.zone = 'Asia/Tokyo';
    s.tracker.refresh();
    expect(seen).toEqual(['failed']);
  });

  it('dispose cancels the timer', () => {
    const s = setupTracker({ isIos: true });
    s.tracker.markDataChanged();
    s.tracker.dispose();
    expect(s.timers.delays()).toEqual([]);
  });

  it('createRunId is short base36', () => {
    expect(createRunId(Date.parse('2026-10-10T13:32:00Z'), () => 0.5)).toMatch(/^[0-9a-z]+-[0-9a-z]{4}$/);
  });
});
