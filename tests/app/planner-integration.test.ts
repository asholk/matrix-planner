import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'obsidian';
import { createMockApp, Plugin as MockPlugin, resetMockState, type App as MockApp } from '../__mocks__/obsidian';
import type { Clock, Notifier, PlatformInfo, WallpaperRenderer } from '../../src/app/contracts';
import type { EventDraft, PlannerEvent, Task, TaskDraft } from '../../src/model/types';
import { SYSTEM_FILES } from '../../src/model/types';
import { composeApp, type AppHandle } from '../../src/app/compose-planner';
import { agendaItems } from '../../src/calendar/day-items';
import { MARKER_PATH } from '../../src/storage/paths';
import { VIEW_TYPE_PLANNER } from '../../src/ui/planner-view';
import { setLanguageOverride } from '../../src/i18n';

const ROOT = 'Планировщик';
const TODAY = '2026-10-10';
const PROFILE_DIR = `${ROOT}/Обои/iphone-1179x2556`;

const clock: Clock = {
  now: () => new Date(Date.UTC(2026, 9, 10, 9, 0, 0)),
  timeZone: () => 'UTC',
};

const IOS: PlatformInfo = { isMobile: true, isPhone: true, isTablet: false, isIos: true, isAndroid: false, isDesktop: false };

class CollectingNotifier implements Notifier {
  readonly messages: string[] = [];
  show(message: string): void {
    this.messages.push(message);
  }
}

/** Renderer без canvas: PNG — несколько байт, измерение — по длине строки. */
function fakeRenderer(): WallpaperRenderer & { renders: number } {
  const renderer = {
    renders: 0,
    measurer: {
      measure: (text: string, font: { size: number }) => ({ width: text.length * font.size * 0.55, ascent: font.size * 0.8, descent: font.size * 0.2 }),
    },
    render: async () => {
      renderer.renders += 1;
      return new Uint8Array([137, 80, 78, 71]).buffer;
    },
    renderTo: async () => undefined,
    releaseResources: () => undefined,
  };
  return renderer;
}

interface Ctx {
  app: MockApp;
  plugin: MockPlugin;
  handle: AppHandle;
  notifier: CollectingNotifier;
  opened: string[];
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) await tick(1);
}

async function setup(options: { app?: MockApp; platform?: PlatformInfo } = {}): Promise<Ctx> {
  const app = options.app ?? createMockApp();
  const plugin = new MockPlugin(app);
  plugin.load();
  const notifier = new CollectingNotifier();
  const opened: string[] = [];
  const handle = await composeApp(plugin as unknown as Plugin, {
    clock,
    notifier,
    platform: options.platform ?? IOS,
    renderer: fakeRenderer(),
    openUrl: (url) => opened.push(url),
    getScreen: () => null,
  });
  await handle.ready;
  await handle.extension!.planner.started;
  return { app, plugin, handle, notifier, opened };
}

function planner(ctx: Ctx) {
  return ctx.handle.extension!.planner.services;
}

function eventDraft(title: string, date: string, extra: Partial<EventDraft> = {}): EventDraft {
  return {
    title,
    body: '',
    icon: null,
    url: null,
    allDay: false,
    start: { date, time: '09:00' },
    end: { date, time: '10:00' },
    repeat: 'none',
    color: 'blue',
    calendarId: null,
    tz: null,
    ...extra,
  };
}

function taskDraft(title: string, extra: Partial<TaskDraft> = {}): TaskDraft {
  return { title, body: '', quadrant: 'do', due: null, repeat: 'none', remind: 'none', priority: 'normal', duration: null, ...extra };
}

async function createEvent(ctx: Ctx, title: string, date: string): Promise<PlannerEvent> {
  const result = await planner(ctx).events.create(eventDraft(title, date));
  if (!result.ok || !result.value) throw new Error(`событие не создано: ${title}`);
  return result.value;
}

async function createTask(ctx: Ctx, title: string, extra: Partial<TaskDraft> = {}): Promise<Task> {
  const result = await ctx.handle.taskActions.create(taskDraft(title, extra));
  if (!result.ok || !result.value) throw new Error(`задача не создана: ${title}`);
  return result.value;
}

function protocol(ctx: Ctx): (params: Record<string, string>) => unknown {
  const handler = ctx.plugin.protocolHandlers.get('planner');
  if (!handler) throw new Error('обработчик planner не зарегистрирован');
  return handler;
}

describe('сборка этапа 2', () => {
  let ctx: Ctx | null = null;

  beforeEach(() => {
    resetMockState();
    setLanguageOverride('ru');
  });

  afterEach(() => {
    ctx?.plugin.unload();
    ctx = null;
    setLanguageOverride(null);
  });

  it('регистрирует команды этапа 2, обработчик ссылок и подключает формы', async () => {
    ctx = await setup();
    for (const id of ['open-calendar', 'open-lockscreen', 'create-event', 'create-note', 'update-lockscreen']) {
      expect(ctx.plugin.commands.has(id)).toBe(true);
    }
    for (const command of ctx.plugin.commands.values()) {
      expect(command.name).not.toMatch(/matrix planner/i);
      expect((command as { hotkeys?: unknown }).hotkeys).toBeUndefined();
    }
    expect(ctx.plugin.protocolHandlers.has('planner')).toBe(true);
    for (const feature of ['task', 'event', 'note', 'wallpaper'] as const) {
      expect(ctx.handle.actions.isAvailable(feature)).toBe(true);
    }
  });

  it('создаёт событие на выбранный день — оно видно в элементах дня', async () => {
    ctx = await setup();
    const event = await createEvent(ctx, 'Стоматолог', '2026-10-15');
    expect(event.path.startsWith(`${ROOT}/`)).toBe(true);
    const days = planner(ctx).dayItems.getDays({ from: '2026-10-15', to: '2026-10-15' });
    const items = agendaItems(days.get('2026-10-15')!);
    expect(items.some((item) => item.source === 'event' && item.title === 'Стоматолог')).toBe(true);
    // В другой день события нет.
    const other = agendaItems(planner(ctx).dayItems.getDays({ from: '2026-10-14', to: '2026-10-14' }).get('2026-10-14')!);
    expect(other.some((item) => item.title === 'Стоматолог')).toBe(false);
  });

  it('удаляет событие: сначала tombstone, затем корзина', async () => {
    ctx = await setup();
    const event = await createEvent(ctx, 'Встреча', TODAY);
    const deleted = await planner(ctx).events.delete(event.id);
    expect(deleted.ok).toBe(true);
    expect(await planner(ctx).tombstones.has(event.id)).toBe(true);
    const read = await planner(ctx).systemJson.read(SYSTEM_FILES.tombstones);
    expect(read.status).toBe('ok');
    expect(JSON.stringify(read.status === 'ok' ? read.value : null)).toContain(event.id);
    await waitUntil(() => planner(ctx!).index.getById(event.id) === undefined);
    expect(ctx.app.vault.getFileByPath(event.path)).toBeNull();
    expect(planner(ctx).index.getById(event.id)).toBeUndefined();
  });

  it('пакет обоев: фоновая подготовка → «Установить» → запуск → подтверждение только своего runId', async () => {
    ctx = await setup();
    const status = planner(ctx).wallpaperStatus;
    // После запуска пакет не на сегодня — фоновая подготовка сразу, без запуска команды.
    await waitUntil(() => status.getState().kind === 'ready');
    expect(ctx.app.vault.getFileByPath(`${PROFILE_DIR}/lock-expired.png`)).not.toBeNull();
    await waitUntil(() => {
      const state = planner(ctx!).companion.getState();
      return state.status === 'ok' && !!state.wallpapers['iphone-1179x2556']?.fingerprint;
    });
    expect(ctx.opened).toEqual([]);

    // Ревизия без изменения картинки: отпечаток совпал — пакет не перерисован, savedAt прежний.
    const savedAt = () => {
      const state = planner(ctx!).companion.getState();
      return state.status === 'ok' ? state.wallpapers['iphone-1179x2556']?.savedAt : null;
    };
    const savedBefore = savedAt();
    const service = planner(ctx).wallpaper;
    const original = service.renderAll.bind(service);
    const results: Array<boolean | undefined> = [];
    service.renderAll = async (options) => {
      const result = await original(options);
      results.push(result.ok ? result.value.unchanged : undefined);
      return result;
    };
    status.markDataChanged();
    await (status as unknown as { prepareNow(): Promise<void> }).prepareNow();
    expect(results).toEqual([true]);
    expect(status.getState().kind).toBe('ready');
    expect(savedAt()).toBe(savedBefore);

    // Правка данных — «Есть изменения».
    await createTask(ctx, 'Позвонить маме', { due: { date: TODAY, time: '18:00' } });
    await waitUntil(() => status.getState().kind === 'dirty');

    await status.run();
    // Семь датированных файлов, lock.png и lock-expired.png.
    for (let day = 10; day <= 16; day++) {
      expect(ctx.app.vault.getFileByPath(`${PROFILE_DIR}/lock-2026-10-${day}.png`)).not.toBeNull();
    }
    expect(ctx.app.vault.getFileByPath(`${PROFILE_DIR}/lock.png`)).not.toBeNull();
    // Рендер дольше жеста — команда по второму нажатию.
    expect(status.getState().kind).toBe('ready');
    expect(ctx.opened).toEqual([]);
    const tap = status.run();
    expect(ctx.opened).toHaveLength(1);
    await tap;
    expect(status.getState().kind).toBe('launched');
    const url = ctx.opened[0] ?? '';
    expect(url.startsWith('shortcuts://x-callback-url/run-shortcut?name=')).toBe(true);
    // Ссылки возврата используют `do=`, а не `action=`.
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('do=wallpaper-done');
    expect(decoded).toContain('do=wallpaper-cancelled');
    expect(decoded).not.toContain('action=wallpaper');
    const outer = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(outer.get('input')).toBe('text');
    const input = JSON.parse(outer.get('text') ?? '{}') as { profile: string; runId: string; file: string };
    expect(input).toMatchObject({ profile: 'iphone-1179x2556', file: `lock-${TODAY}.png` });
    const success = new URLSearchParams((outer.get('x-success') ?? '').split('?')[1]);
    expect(success.get('run')).toBe(input.runId);

    // Чужой (запоздалый) runId — игнор.
    await protocol(ctx)({ action: 'planner', vault: 'Хранилище', do: 'wallpaper-done', profile: 'iphone-1179x2556', run: 'old-run' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(status.getState().kind).toBe('launched');

    // Возврат из «Быстрых команд»: Obsidian кладёт имя обработчика в `action`.
    protocol(ctx)({ action: 'planner', vault: 'Хранилище', do: 'wallpaper-done', profile: 'iphone-1179x2556', run: input.runId });
    await waitUntil(() => status.getState().kind === 'confirmed');
    expect(status.getState().kind).toBe('confirmed');
    await waitUntil(() => {
      const state = planner(ctx!).companion.getState();
      return state.status === 'ok' && !!state.wallpapers['iphone-1179x2556']?.confirmedAt;
    });
    const companion = planner(ctx).companion.getState();
    expect(companion.status === 'ok' && companion.wallpapers['iphone-1179x2556']?.confirmedAt).toBeTruthy();
  });

  it('x-error с errorMessage: уведомление с причиной и запись в companion.json', async () => {
    ctx = await setup();
    const status = planner(ctx).wallpaperStatus;
    await protocol(ctx)({ action: 'planner', vault: 'Хранилище', do: 'wallpaper-failed', profile: 'iphone-1179x2556', errorMessage: 'Файл не найден' });
    await waitUntil(() => status.getState().kind === 'failed');
    expect(ctx.notifier.messages).toContain('Не удалось установить обои: Файл не найден');
    await waitUntil(() => {
      const state = planner(ctx!).companion.getState();
      return state.status === 'ok' && state.wallpapers['iphone-1179x2556']?.errorMessage === 'Файл не найден';
    });
  });

  it('открывает ссылку в существующем виде', async () => {
    ctx = await setup();
    const view = await ctx.handle.activateView();
    expect(view).not.toBeNull();
    protocol(ctx)({ action: 'planner', vault: 'Хранилище', view: 'calendar' });
    await waitUntil(() => view!.getActiveTab() === 'calendar');
    const leaves = ctx.app.workspace.getLeavesOfType(VIEW_TYPE_PLANNER);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.view).toBe(view);
    expect(view!.getActiveTab()).toBe('calendar');
  });

  it('неизвестный id по ссылке — нейтральное сообщение «Элемент не найден»', async () => {
    ctx = await setup();
    protocol(ctx)({ action: 'planner', do: 'open', id: '01JABCDEFGHJKMNPQRSTVWXYZ0' });
    await waitUntil(() => ctx!.notifier.messages.length > 0);
    expect(ctx.notifier.messages.at(-1)).toBe('Элемент не найден. Возможно, он ещё не синхронизирован');
  });

  it('правка задачи с напоминанием отмечается для баннера настроек', async () => {
    ctx = await setup();
    await createTask(ctx, 'Без напоминания', { due: { date: TODAY, time: '12:00' } });
    // Время последней правки доступно только через вкладку настроек — проверяем через её зависимости.
    const tab = ctx.plugin.settingTabs[0] as unknown as { deps: { lastReminderEditAt?: () => number | null } };
    expect(tab.deps.lastReminderEditAt?.()).toBeNull();
    await createTask(ctx, 'С напоминанием', { due: { date: TODAY, time: '12:00' }, remind: '15m' });
    expect(tab.deps.lastReminderEditAt?.()).toBe(clock.now().getTime());
  });

  it('повторная загрузка и выгрузка не оставляют лишних подписок', async () => {
    const app = createMockApp();
    const baseline = {
      modify: app.vault.listenerCount('modify'),
      create: app.vault.listenerCount('create'),
      delete: app.vault.listenerCount('delete'),
      rename: app.vault.listenerCount('rename'),
      changed: app.metadataCache.listenerCount('changed'),
    };
    const counts = () => ({
      modify: app.vault.listenerCount('modify'),
      create: app.vault.listenerCount('create'),
      delete: app.vault.listenerCount('delete'),
      rename: app.vault.listenerCount('rename'),
      changed: app.metadataCache.listenerCount('changed'),
    });

    const first = await setup({ app });
    const loaded = counts();
    first.plugin.unload();
    expect(counts()).toEqual(baseline);
    expect(first.plugin.protocolHandlers.size).toBe(0);
    expect(first.plugin.commands.size).toBe(0);

    const second = await setup({ app });
    expect(counts()).toEqual(loaded);
    second.plugin.unload();
    expect(counts()).toEqual(baseline);

    // Ссылка после выгрузки не выполняется.
    const before = second.notifier.messages.length;
    expect(second.plugin.protocolHandlers.has('planner')).toBe(false);
    expect(second.notifier.messages.length).toBe(before);
  });

  it('новая схема (только чтение): ни одна запись не выполняется', async () => {
    const app = createMockApp();
    await app.vault.create(MARKER_PATH, `---\nroot: ${ROOT}\nschema: 2\nvault_id: V\n---\n`);
    ctx = await setup({ app });
    const files = () => [...ctx!.app.vault.contents.keys()].sort();
    const before = files();

    expect(ctx.handle.services.guard.canWrite()).toBe(false);
    const task = await ctx.handle.services.tasks.create(taskDraft('Нельзя'));
    expect(task.ok).toBe(false);
    const event = await planner(ctx).events.create(eventDraft('Нельзя', TODAY));
    expect(event.ok).toBe(false);
    const note = await planner(ctx).notes.create({ title: 'Нельзя', body: '', date: TODAY });
    expect(note.ok).toBe(false);
    const tombstone = await planner(ctx).tombstones.add('01JABCDEFGHJKMNPQRSTVWXYZ0', 'event');
    expect(tombstone.ok).toBe(false);
    const companion = await planner(ctx).companion.updateWallpaperStatus('iphone-1179x2556', { savedAt: '2026-10-10T09:00:00.000Z' });
    expect(companion.ok).toBe(false);

    // Обои не сохраняются — это сбой рендера, быстрая команда не запускается.
    await planner(ctx).wallpaperStatus.run();
    expect(planner(ctx).wallpaperStatus.getState()).toMatchObject({ kind: 'failed', reason: 'render' });
    expect(ctx.opened).toEqual([]);

    expect(files()).toEqual(before);
  });
});
