import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'obsidian';
import {
  createMockApp,
  Plugin as MockPlugin,
  resetMockState,
  type App as MockApp,
  type TFile as MockTFile,
} from '../__mocks__/obsidian';
import type { Clock, Notifier } from '../../src/app/contracts';
import type { Task, TaskDraft } from '../../src/model/types';
import { composeCore, localeWeekStart, resolveFormatPreferences, type CoreHandle } from '../../src/app/compose-core';
import { ATTENTION_DATA_KEY, DataJsonAttentionStateStore, PluginDataFile } from '../../src/app/attention-state-store';
import { PluginSettingsStore } from '../../src/settings/settings-store';
import { emptyAttentionState } from '../../src/integrity/integrity-service';
import { MARKER_PATH } from '../../src/storage/paths';
import { VIEW_TYPE_PLANNER } from '../../src/ui/planner-view';
import { setLanguageOverride } from '../../src/i18n';

// Вкладка «Задачи» использует `window.setTimeout`; в окружении node его нет.
const globalWithWindow = globalThis as unknown as { window?: unknown };
if (globalWithWindow.window === undefined) globalWithWindow.window = globalThis;

const ROOT = 'Планировщик';
const TASKS = `${ROOT}/Задачи`;

const clock: Clock = {
  now: () => new Date(2026, 9, 10, 9, 0, 0),
  timeZone: () => 'UTC',
};

class CollectingNotifier implements Notifier {
  readonly messages: string[] = [];
  show(message: string): void {
    this.messages.push(message);
  }
}

interface Ctx {
  app: MockApp;
  plugin: MockPlugin;
  core: CoreHandle;
  notifier: CollectingNotifier;
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) await tick(1);
}

function draft(title: string, extra: Partial<TaskDraft> = {}): TaskDraft {
  return { title, body: '', quadrant: 'do', due: null, repeat: 'none', remind: 'none', priority: 'normal', ...extra };
}

function taskById(ctx: Ctx, id: string): Task | undefined {
  const item = ctx.core.services.index.getById(id);
  return item && item.kind === 'task' ? item : undefined;
}

async function setup(data: unknown = null): Promise<Ctx> {
  const app = createMockApp();
  const plugin = new MockPlugin(app);
  plugin.data = data;
  plugin.load();
  const notifier = new CollectingNotifier();
  const core = await composeCore(plugin as unknown as Plugin, { clock, notifier });
  await core.ready;
  return { app, plugin, core, notifier };
}

async function createTask(ctx: Ctx, title: string, extra: Partial<TaskDraft> = {}): Promise<Task> {
  const result = await ctx.core.taskActions.create(draft(title, extra));
  if (!result.ok || !result.value) throw new Error(`задача не создана: ${title}`);
  return result.value;
}

async function openInEditor(ctx: Ctx, path: string): Promise<void> {
  const file = ctx.app.vault.getFileByPath(path) as MockTFile | null;
  if (!file) throw new Error(`нет файла ${path}`);
  await ctx.app.workspace.getLeaf().openFile(file);
}

describe('сборка ядра', () => {
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

  it('создаёт маркер и папки, регистрирует вид, значок, настройки и команды ядра', async () => {
    ctx = await setup();
    expect(ctx.app.vault.getFileByPath(MARKER_PATH)).not.toBeNull();
    expect(ctx.core.services.marker.getState().status).toBe('ok');
    expect(ctx.app.vault.getFolderByPath(TASKS)).not.toBeNull();
    expect(ctx.plugin.registeredViews).toContain(VIEW_TYPE_PLANNER);
    expect(ctx.plugin.ribbonIcons.map((icon) => icon.icon)).toEqual(['layout-grid']);
    expect(ctx.plugin.settingTabs).toHaveLength(1);

    const ids = [...ctx.plugin.commands.keys()];
    expect(ids).toEqual(
      expect.arrayContaining([
        'open-tasks',
        'create-task',
        'create-task-do',
        'create-task-plan',
        'create-task-urgent',
        'create-task-someday',
        'complete-active-task',
        'postpone-active-task',
        'check-integrity',
      ]),
    );
    // Команды этапа 2 не регистрируются, пока нет реализации.
    for (const id of ['open-calendar', 'open-lockscreen', 'create-event', 'create-note', 'update-lockscreen']) {
      expect(ctx.plugin.commands.has(id)).toBe(false);
    }
    for (const command of ctx.plugin.commands.values()) {
      expect(command.name).not.toMatch(/matrix planner/i);
      expect((command as { hotkeys?: unknown }).hotkeys).toBeUndefined();
    }
    expect(ctx.core.actions.isAvailable('task')).toBe(true);
    expect(ctx.core.actions.isAvailable('event')).toBe(false);
    expect(ctx.core.actions.isAvailable('note')).toBe(false);
  });

  it('создание → выполнение → возврат в работу', async () => {
    ctx = await setup();
    const task = await createTask(ctx, 'Купить хлеб');
    expect(task.path).toBe(`${TASKS}/Купить хлеб.md`);
    expect(taskById(ctx, task.id)?.done).toBe(false);

    const completed = await ctx.core.taskActions.complete(task.id);
    expect(completed.ok).toBe(true);
    expect(taskById(ctx, task.id)?.done).toBe(true);

    // Повторное выполнение не создаёт лишней отметки.
    const again = await ctx.core.taskActions.complete(task.id);
    expect(again.ok && again.changed).toBe(false);

    const returned = await ctx.core.taskActions.uncomplete(task.id);
    expect(returned.ok).toBe(true);
    expect(taskById(ctx, task.id)?.done).toBe(false);
  });

  it('команды активной заметки доступны только для задачи Планировщика', async () => {
    ctx = await setup();
    const complete = ctx.plugin.commands.get('complete-active-task')!;
    const postpone = ctx.plugin.commands.get('postpone-active-task')!;

    // Обычная заметка — команды скрыты.
    await ctx.app.vault.create('Заметка.md', 'текст\n');
    await openInEditor(ctx, 'Заметка.md');
    expect(complete.checkCallback!(true)).toBe(false);
    expect(postpone.checkCallback!(true)).toBe(false);

    const task = await createTask(ctx, 'Позвонить', { due: { date: '2026-10-10', time: null } });
    await openInEditor(ctx, task.path);
    expect(postpone.checkCallback!(true)).toBe(true);
    postpone.checkCallback!(false);
    await waitUntil(() => taskById(ctx!, task.id)?.due?.date === '2026-10-11');
    expect(taskById(ctx, task.id)?.due?.date).toBe('2026-10-11');

    expect(complete.checkCallback!(true)).toBe(true);
    complete.checkCallback!(false);
    await waitUntil(() => taskById(ctx!, task.id)?.done === true);
    expect(taskById(ctx, task.id)?.done).toBe(true);
    // Выполненная задача: выполнять и переносить больше нечего.
    expect(complete.checkCallback!(true)).toBe(false);
    expect(postpone.checkCallback!(true)).toBe(false);
  });

  it('повторное открытие использует существующий вид', async () => {
    ctx = await setup();
    const first = await ctx.core.activateView();
    expect(first).not.toBeNull();
    await ctx.core.actions.showTab('tasks');
    ctx.plugin.runCommand('open-tasks');
    await tick();
    const leaves = ctx.app.workspace.getLeavesOfType(VIEW_TYPE_PLANNER);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.view).toBe(first);
    expect(first!.getActiveTab()).toBe('tasks');
  });

  it('ошибка сохранения не теряется: результат с ошибкой и уведомление', async () => {
    ctx = await setup();
    ctx.app.vault.failNextWrite(`${TASKS}/Сбой.md`);
    const before = ctx.notifier.messages.length;
    const result = await ctx.core.taskActions.create(draft('Сбой'));
    expect(result.ok).toBe(false);
    expect(ctx.notifier.messages.length).toBeGreaterThan(before);
    expect(ctx.core.services.index.getTasks().some((task) => task.title === 'Сбой')).toBe(false);
  });

  it('смена корня создаёт папки и перестраивает индекс', async () => {
    ctx = await setup();
    await createTask(ctx, 'Старая');
    await ctx.core.services.settings.update((settings) => {
      settings.rootFolder = 'Новый корень';
    });
    await waitUntil(() => ctx!.app.vault.getFolderByPath('Новый корень/Задачи') !== null && ctx!.core.services.index.getTasks().length === 0);
    expect(ctx.app.vault.getFolderByPath('Новый корень/Задачи')).not.toBeNull();
    expect(ctx.core.services.index.getTasks()).toHaveLength(0);
  });

  it('автоархив запускается при смене настройки архива', async () => {
    ctx = await setup();
    const task = await createTask(ctx, 'Старая выполненная');
    await ctx.core.taskActions.complete(task.id);
    // Дата выполнения — «сегодня»: при N = 1 задача ещё не уходит в архив.
    await ctx.core.services.settings.update((settings) => {
      settings.archive = { mode: 'after-days', days: 1 };
    });
    await tick(10);
    expect(taskById(ctx, task.id)?.archived).toBe(false);
  });

  it('выгрузка снимает команды, вид и подписки', async () => {
    const app = createMockApp();
    const baseline = {
      vaultModify: app.vault.listenerCount('modify'),
      vaultRename: app.vault.listenerCount('rename'),
      changed: app.metadataCache.listenerCount('changed'),
    };
    const plugin = new MockPlugin(app);
    plugin.load();
    const core = await composeCore(plugin as unknown as Plugin, { clock, notifier: new CollectingNotifier() });
    await core.ready;
    expect(app.metadataCache.listenerCount('changed')).toBeGreaterThan(baseline.changed);

    plugin.unload();
    expect(plugin.commands.size).toBe(0);
    expect(app.workspace.viewCreators.has(VIEW_TYPE_PLANNER)).toBe(false);
    expect(app.vault.listenerCount('modify')).toBe(baseline.vaultModify);
    expect(app.vault.listenerCount('rename')).toBe(baseline.vaultRename);
    expect(app.metadataCache.listenerCount('changed')).toBe(baseline.changed);
  });
});

describe('data.json: настройки и «Требуют внимания»', () => {
  function memorySource(initial: unknown) {
    const source = {
      data: initial as unknown,
      async loadData(): Promise<unknown> {
        return source.data === null ? null : structuredClone(source.data);
      },
      async saveData(data: unknown): Promise<void> {
        source.data = structuredClone(data);
      },
    };
    return source;
  }

  it('настройки не видят ключ attention и не затирают его', async () => {
    const state = { ...emptyAttentionState(), acknowledged: ['conflict:a'] };
    const source = memorySource({ rootFolder: 'Мой корень', custom: 1, [ATTENTION_DATA_KEY]: state });
    const file = new PluginDataFile(source);
    const settings = new PluginSettingsStore(file.settingsSource());
    await settings.load();
    expect((settings.get() as unknown as Record<string, unknown>)[ATTENTION_DATA_KEY]).toBeUndefined();

    await settings.update((draft) => {
      draft.weekStart = 'monday';
    });
    const saved = source.data as Record<string, unknown>;
    expect(saved[ATTENTION_DATA_KEY]).toEqual(state);
    expect(saved['custom']).toBe(1);
    expect(saved['weekStart']).toBe('monday');
  });

  it('состояние внимания сохраняется, не трогая настройки', async () => {
    const source = memorySource({ rootFolder: 'Мой корень', weekStart: 'sunday' });
    const file = new PluginDataFile(source);
    const settings = new PluginSettingsStore(file.settingsSource());
    await settings.load();
    const store = new DataJsonAttentionStateStore(file);
    expect(await store.load()).toBeNull();

    const state = { ...emptyAttentionState(), acknowledged: ['conflict:b'] };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    const saved = source.data as Record<string, unknown>;
    expect(saved['rootFolder']).toBe('Мой корень');
    expect(saved['weekStart']).toBe('sunday');

    // Последующая запись настроек сохраняет состояние.
    await settings.update((draft) => {
      draft.timeFormat = '24h';
    });
    expect((source.data as Record<string, unknown>)[ATTENTION_DATA_KEY]).toEqual(state);
  });
});

describe('региональные настройки', () => {
  it('явные значения важнее локали', () => {
    expect(resolveFormatPreferences({ weekStart: 'sunday', timeFormat: '24h' }, 'ru', 'ru-RU')).toEqual({ language: 'ru', weekStart: 0, hour12: false });
    expect(resolveFormatPreferences({ weekStart: 'monday', timeFormat: '12h' }, 'en', 'en-US')).toEqual({ language: 'en', weekStart: 1, hour12: true });
  });

  it('auto: неделя по локали', () => {
    expect(localeWeekStart('ru-RU')).toBe(1);
    expect(localeWeekStart('en-US')).toBe(0);
  });
});
