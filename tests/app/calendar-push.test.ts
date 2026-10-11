import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'obsidian';
import { createMockApp, dispatchWindowEvent, Plugin as MockPlugin, resetMockState } from '../__mocks__/obsidian';
import type { Clock, Notifier, PlatformInfo, WallpaperRenderer } from '../../src/app/contracts';
import type { ItemId } from '../../src/model/types';
import { composeApp, type AppHandle } from '../../src/app/compose-planner';
import { setLanguageOverride } from '../../src/i18n';

/** Сборка плагина: изменения событий и задач уходят в календарь адресно, не дожидаясь интервала. */

const clock: Clock = { now: () => new Date(Date.UTC(2026, 9, 10, 9, 0, 0)), timeZone: () => 'UTC' };
const IOS: PlatformInfo = { isMobile: true, isPhone: true, isTablet: false, isIos: true, isAndroid: false, isDesktop: false };

const renderer: WallpaperRenderer = {
  measurer: { measure: (text: string, font: { size: number }) => ({ width: text.length * font.size * 0.55, ascent: font.size * 0.8, descent: font.size * 0.2 }) },
  render: async () => new Uint8Array([137, 80, 78, 71]).buffer,
  renderTo: async () => undefined,
  releaseResources: () => undefined,
};

/** `document` для `visibilitychange` (окружение тестов — node). */
class FakeDocument {
  visibilityState: 'visible' | 'hidden' = 'visible';
  private readonly listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }
  hide(): void {
    this.visibilityState = 'hidden';
    for (const listener of this.listeners.get('visibilitychange') ?? []) listener();
  }
}

describe('сборка: адресная отправка в «Календарь» iOS', () => {
  let plugin: MockPlugin | null = null;
  let handle: AppHandle;
  let doc: FakeDocument;
  let pushed: ItemId[][];
  let fullSyncs: number;

  beforeEach(async () => {
    resetMockState();
    setLanguageOverride('ru');
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    const app = createMockApp();
    plugin = new MockPlugin(app);
    plugin.load();
    const notifier: Notifier = { show: () => {} };
    handle = await composeApp(plugin as unknown as Plugin, { clock, notifier, platform: IOS, renderer, getScreen: () => null });
    await handle.ready;
    await handle.extension!.planner.started;
    const engine = handle.extension!.planner.calendarSync;
    pushed = [];
    vi.spyOn(engine, 'pushItems').mockImplementation(async (ids) => {
      pushed.push([...ids]);
      return { status: 'ok', pushed: 1, failed: 0 };
    });
    fullSyncs = 0;
    vi.spyOn(engine, 'syncNow').mockImplementation(async () => {
      fullSyncs++;
      return { status: 'skipped', reason: 'disabled' };
    });
    await handle.services.settings.update((draft) => {
      draft.calendarSync.enabled = true;
    });
  });

  afterEach(() => {
    plugin?.unload();
    plugin = null;
    vi.stubGlobal('document', undefined);
    setLanguageOverride(null);
  });

  it('новое событие отправляется примерно через секунду без полной синхронизации', async () => {
    const created = await handle.extension!.planner.services.events.create({
      title: 'Йога',
      body: '',
      icon: null,
      url: null,
      allDay: false,
      start: { date: '2026-10-15', time: '08:00' },
      end: { date: '2026-10-15', time: '09:00' },
      repeat: 'none',
      color: 'blue',
      calendarId: null,
      tz: null,
    });
    if (!created.ok || !created.value) throw new Error('событие не создано');
    const id = created.value.id;
    expect(pushed.flat()).not.toContain(id);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(pushed.flat()).toContain(id);
    // Полная синхронизация — позже (через 10 с), адресная отправка её не ждёт.
    expect(fullSyncs).toBe(0);
  });

  it('уход приложения в фон — задача со сроком отправляется сразу', async () => {
    const created = await handle.taskActions.create({ title: 'Купить молоко', body: '', quadrant: 'do', due: { date: '2026-10-17', time: null }, repeat: 'none', remind: 'none', priority: 'normal' });
    if (!created.ok || !created.value) throw new Error('задача не создана');
    const id = created.value.id;
    doc.hide();
    expect(pushed.flat()).toContain(id);
  });

  it('закрытие страницы (pagehide) — ожидающее отправляется сразу', async () => {
    const created = await handle.taskActions.create({ title: 'Позвонить', body: '', quadrant: 'do', due: { date: '2026-10-18', time: null }, repeat: 'none', remind: 'none', priority: 'normal' });
    if (!created.ok || !created.value) throw new Error('задача не создана');
    dispatchWindowEvent('pagehide');
    expect(pushed.flat()).toContain(created.value.id);
  });
});
