/**
 * Приёмочные сценарии ТЗ §2.1 и §10 без компаньона: полная сборка `composeApp` на моке
 * Obsidian и эталонном хранилище (tests/fixtures/reference-vault.ts).
 *
 * Чего здесь нет: настоящего Canvas, устройств, VoiceOver, «Быстрых команд» и «Календаря» iOS —
 * это ручной протокол docs/acceptance.md.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'obsidian';
import { Plugin as MockPlugin, resetMockState, type App as MockApp } from '../__mocks__/obsidian';
import recurrenceFixtures from '../../fixtures/recurrence.json';
import type { Notifier, PlatformInfo, TaskFormRequest, WallpaperRenderer } from '../../src/app/contracts';
import { QUADRANT_KEYS, SYSTEM_FILES, type LocalDateString, type QuadrantKey, type Task, type TaskDraft } from '../../src/model/types';
import { composeApp, type AppHandle } from '../../src/app/compose-planner';
import { agendaItems } from '../../src/calendar/day-items';
import { buildWeekStrip, weekRange } from '../../src/calendar/week-layout';
import { groupTasksByQuadrant } from '../../src/model/task-selectors';
import { floatingFromDate } from '../../src/model/dates';
import { parsePlannerUrl } from '../../src/protocol/links';
import { hasTranslation, setLanguageOverride } from '../../src/i18n';
import { WALLPAPER_LAYOUT_MODULE } from '../../src/wallpaper/layout';
import { ruApp } from '../../src/i18n/ru/app';
import { enApp } from '../../src/i18n/en/app';
import { ruCache } from '../../src/i18n/ru/cache';
import { enCache } from '../../src/i18n/en/cache';
import { ruCalendar } from '../../src/i18n/ru/calendar';
import { enCalendar } from '../../src/i18n/en/calendar';
import { ruCalendarModel } from '../../src/i18n/ru/calendar-model';
import { enCalendarModel } from '../../src/i18n/en/calendar-model';
import { ruCommon } from '../../src/i18n/ru/common';
import { enCommon } from '../../src/i18n/en/common';
import { ruEvents } from '../../src/i18n/ru/events';
import { enEvents } from '../../src/i18n/en/events';
import { ruIntegrity } from '../../src/i18n/ru/integrity';
import { enIntegrity } from '../../src/i18n/en/integrity';
import { ruLockscreen } from '../../src/i18n/ru/lockscreen';
import { enLockscreen } from '../../src/i18n/en/lockscreen';
import { ruModel } from '../../src/i18n/ru/model';
import { enModel } from '../../src/i18n/en/model';
import { ruNotes } from '../../src/i18n/ru/notes';
import { enNotes } from '../../src/i18n/en/notes';
import { ruProtocol } from '../../src/i18n/ru/protocol';
import { enProtocol } from '../../src/i18n/en/protocol';
import { ruSettings } from '../../src/i18n/ru/settings';
import { enSettings } from '../../src/i18n/en/settings';
import { ruShell } from '../../src/i18n/ru/shell';
import { enShell } from '../../src/i18n/en/shell';
import { ruStorage } from '../../src/i18n/ru/storage';
import { enStorage } from '../../src/i18n/en/storage';
import { ruTaskActions } from '../../src/i18n/ru/task-actions';
import { enTaskActions } from '../../src/i18n/en/task-actions';
import { ruTaskForm } from '../../src/i18n/ru/task-form';
import { enTaskForm } from '../../src/i18n/en/task-form';
import { ruTasks } from '../../src/i18n/ru/tasks';
import { enTasks } from '../../src/i18n/en/tasks';
import { ruWallpaperLayout } from '../../src/i18n/ru/wallpaper-layout';
import { enWallpaperLayout } from '../../src/i18n/en/wallpaper-layout';
import { ruWallpaperRender } from '../../src/i18n/ru/wallpaper-render';
import { enWallpaperRender } from '../../src/i18n/en/wallpaper-render';
import {
  createReferenceApp,
  REFERENCE_IDS,
  REFERENCE_QUADRANT_TITLES,
  REFERENCE_ROOT,
  REFERENCE_TODAY,
  REFERENCE_TOMORROW,
  REFERENCE_VAULT_NAME,
  ReferenceClock,
  type ReferenceVaultOptions,
} from '../fixtures/reference-vault';

const TASKS_DIR = `${REFERENCE_ROOT}/Задачи`;
const PROFILE_DIR = `${REFERENCE_ROOT}/Обои/iphone-1179x2556`;
const CONCERT_DAY = '2026-10-21';

const IOS: PlatformInfo = { isMobile: true, isPhone: true, isTablet: false, isIos: true, isAndroid: false, isDesktop: false };

class CollectingNotifier implements Notifier {
  readonly messages: string[] = [];
  show(message: string): void {
    this.messages.push(message);
  }
}

/** Renderer без canvas: PNG — несколько байт, измерение — по длине строки. */
function fakeRenderer(): WallpaperRenderer {
  return {
    measurer: {
      measure: (text: string, font: { size: number }) => ({ width: text.length * font.size * 0.55, ascent: font.size * 0.8, descent: font.size * 0.2 }),
    },
    render: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    renderTo: async () => undefined,
    releaseResources: () => undefined,
  };
}

interface Ctx {
  app: MockApp;
  plugin: MockPlugin;
  handle: AppHandle;
  clock: ReferenceClock;
  notifier: CollectingNotifier;
  opened: string[];
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) await tick(1);
}

async function setup(options: ReferenceVaultOptions = {}): Promise<Ctx> {
  const app = createReferenceApp(options);
  const plugin = new MockPlugin(app);
  plugin.load();
  const clock = new ReferenceClock();
  const notifier = new CollectingNotifier();
  const opened: string[] = [];
  const handle = await composeApp(plugin as unknown as Plugin, {
    clock,
    notifier,
    platform: IOS,
    renderer: fakeRenderer(),
    openUrl: (url) => opened.push(url),
    getScreen: () => null,
  });
  await handle.ready;
  await handle.extension!.planner.started;
  return { app, plugin, handle, clock, notifier, opened };
}

function planner(ctx: Ctx) {
  return ctx.handle.extension!.planner.services;
}

function taskById(ctx: Ctx, id: string): Task | undefined {
  const item = planner(ctx).index.getById(id);
  return item && item.kind === 'task' ? item : undefined;
}

function nowFloating(ctx: Ctx) {
  return floatingFromDate(ctx.clock.now(), ctx.clock.timeZone());
}

function quadrantTitles(ctx: Ctx): Record<QuadrantKey, string[]> {
  const groups = groupTasksByQuadrant(planner(ctx).index.getTasks(), nowFloating(ctx));
  const out = {} as Record<QuadrantKey, string[]>;
  for (const key of QUADRANT_KEYS) out[key] = groups[key].map((task) => task.title);
  return out;
}

function dayAgenda(ctx: Ctx, date: LocalDateString) {
  const agenda = planner(ctx).dayItems.getDays({ from: date, to: date }).get(date);
  if (!agenda) throw new Error(`нет дня ${date}`);
  return agenda;
}

function taskDraft(title: string, extra: Partial<TaskDraft> = {}): TaskDraft {
  return { title, body: '', quadrant: 'do', due: null, repeat: 'none', remind: 'none', priority: 'normal', ...extra };
}

describe('приёмка без компаньона (ТЗ §10)', () => {
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

  it('эталонное хранилище: задачи по квадрантам в порядке ТЗ §4.2, «Танцы» — в «Выполнено»', async () => {
    ctx = await setup();
    expect(planner(ctx).index.getTasks()).toHaveLength(8);
    expect(planner(ctx).index.getInvalid()).toEqual([]);
    expect(quadrantTitles(ctx)).toEqual(REFERENCE_QUADRANT_TITLES);

    const done = planner(ctx).tasks.getCompletions();
    const dancing = done.find((entry) => entry.taskId === REFERENCE_IDS.dancing);
    expect(dancing?.date).toBe(REFERENCE_TODAY);
    expect(dancing?.completedAt).toBe(`${REFERENCE_TODAY}T13:31`);
    expect(taskById(ctx, REFERENCE_IDS.dentist)?.remind).toBe('15m');
  });

  it('создание задачи из каждого квадранта', async () => {
    ctx = await setup();
    for (const quadrant of QUADRANT_KEYS) {
      expect(ctx.plugin.commands.has(`create-task-${quadrant}`)).toBe(true);
      const result = await ctx.handle.taskActions.create(taskDraft(`Новая ${quadrant}`, { quadrant, due: { date: REFERENCE_TOMORROW, time: null } }));
      expect(result.ok).toBe(true);
      const task = result.ok ? result.value : null;
      expect(task?.path).toBe(`${TASKS_DIR}/Новая ${quadrant}.md`);
      await waitUntil(() => taskById(ctx!, task!.id) !== undefined);
      expect(taskById(ctx, task!.id)?.quadrant).toBe(quadrant);
      expect(quadrantTitles(ctx)[quadrant]).toContain(`Новая ${quadrant}`);
    }
    expect(planner(ctx).index.getTasks()).toHaveLength(8 + QUADRANT_KEYS.length);
  });

  it('выполнение → «Выполнено» → вернуть в работу', async () => {
    ctx = await setup();
    const id = REFERENCE_IDS.khrum;
    const completed = await ctx.handle.taskActions.complete(id);
    expect(completed.ok).toBe(true);
    await waitUntil(() => taskById(ctx!, id)?.done === true);
    expect(quadrantTitles(ctx).urgent).toEqual(['Забрать Авито на почте']);
    const entry = planner(ctx).tasks.getCompletions().find((item) => item.taskId === id);
    expect(entry?.date).toBe(REFERENCE_TODAY);
    expect(entry?.completedAt).toBe(`${REFERENCE_TODAY}T13:40`);

    const returned = await ctx.handle.taskActions.uncomplete(id);
    expect(returned.ok).toBe(true);
    await waitUntil(() => taskById(ctx!, id)?.done === false);
    expect(quadrantTitles(ctx).urgent).toEqual(REFERENCE_QUADRANT_TITLES.urgent);
    expect(planner(ctx).tasks.getCompletions().some((item) => item.taskId === id)).toBe(false);
  });

  describe('повторы по фикстурам (критерий 8)', () => {
    interface SeriesCase { name: string; rule: string; anchor: string; count: number; expected: string[] }
    const series = recurrenceFixtures.series as SeriesCase[];
    const cases: Array<{ fixture: string; id: string; time: string | null }> = [
      { fixture: 'monthly from Jan 31', id: REFERENCE_IDS.monthly, time: '09:00' },
      { fixture: 'yearly from Feb 29', id: REFERENCE_IDS.yearly, time: null },
    ];

    for (const c of cases) {
      it(`${c.fixture}: выполнение сдвигает срок по эталонной серии`, async () => {
        const expected = series.find((item) => item.name === c.fixture);
        expect(expected).toBeDefined();
        ctx = await setup({ recurring: true });
        const dueDates: string[] = [];
        let task = taskById(ctx, c.id);
        expect(task?.due?.date).toBe(expected!.anchor);
        dueDates.push(task!.due!.date);

        for (let step = 1; step < expected!.count; step++) {
          const previous = task!.due!.date;
          // Выполняем в день срока, после его времени.
          ctx.clock.setLocal(`${previous}T10:00`);
          const result = await ctx.handle.taskActions.complete(c.id);
          expect(result.ok).toBe(true);
          await waitUntil(() => taskById(ctx!, c.id)?.due?.date !== previous);
          task = taskById(ctx, c.id);
          expect(task?.due?.time ?? null).toBe(c.time);
          dueDates.push(task!.due!.date);
        }

        expect(dueDates).toEqual(expected!.expected);
        expect(task?.completions).toEqual(expected!.expected.slice(0, -1));
        expect(task?.repeatAnchor).toBe(expected!.anchor);
        expect(task?.done).toBe(false);
      });
    }
  });

  it('календарь: «Концерт» 21 окт. 09:00–10:00 и заметка с датой видны в дне', async () => {
    ctx = await setup();
    const agenda = dayAgenda(ctx, CONCERT_DAY);
    const concert = agenda.timed.find((item) => item.source === 'event' && item.title === 'Концерт');
    expect(concert).toBeDefined();
    expect(concert?.startMinute).toBe(9 * 60);
    expect(concert?.endMinute).toBe(10 * 60);
    expect(agenda.notes.map((item) => item.title)).toEqual(['Взять билеты']);

    // Задачи завтрашнего дня — в списке по времени.
    const tomorrow = agendaItems(dayAgenda(ctx, REFERENCE_TOMORROW)).filter((item) => item.source === 'task').map((item) => item.title);
    expect(tomorrow).toEqual(expect.arrayContaining(['Стоматолог', 'Кулинария']));

    // Новая заметка с датой появляется в своём дне и не появляется в соседнем.
    const created = await planner(ctx).notes.create({ title: 'Купить цветы', body: '', date: '2026-10-20' });
    expect(created.ok).toBe(true);
    await waitUntil(() => dayAgenda(ctx!, '2026-10-20').notes.length > 0);
    expect(dayAgenda(ctx, '2026-10-20').notes.map((item) => item.title)).toEqual(['Купить цветы']);
    expect(dayAgenda(ctx, CONCERT_DAY).notes.map((item) => item.title)).toEqual(['Взять билеты']);
  });

  it('удаление события: сначала tombstone, затем корзина', async () => {
    ctx = await setup();
    const id = REFERENCE_IDS.concert;
    const path = planner(ctx).index.getById(id)?.path;
    expect(path).toBe(`${REFERENCE_ROOT}/События/Концерт.md`);

    const deleted = await planner(ctx).events.delete(id);
    expect(deleted.ok).toBe(true);
    expect(await planner(ctx).tombstones.has(id)).toBe(true);
    const read = await planner(ctx).systemJson.read(SYSTEM_FILES.tombstones);
    expect(read.status).toBe('ok');
    expect(JSON.stringify(read.status === 'ok' ? read.value : null)).toContain(id);

    await waitUntil(() => planner(ctx!).index.getById(id) === undefined);
    expect(ctx.app.vault.getFileByPath(path!)).toBeNull();
    expect(agendaItems(dayAgenda(ctx, CONCERT_DAY)).some((item) => item.source === 'event')).toBe(false);
  });

  it('пакет обоев на 7 дней: lock-*.png и lock.png, затем запуск быстрой команды с do=…', async () => {
    ctx = await setup();
    const status = planner(ctx).wallpaperStatus;
    await status.run();
    for (let day = 10; day <= 16; day++) {
      expect(ctx.app.vault.getFileByPath(`${PROFILE_DIR}/lock-2026-10-${day}.png`)).not.toBeNull();
    }
    expect(ctx.app.vault.getFileByPath(`${PROFILE_DIR}/lock.png`)).not.toBeNull();
    // Восьмой день не сохраняется.
    expect(ctx.app.vault.getFileByPath(`${PROFILE_DIR}/lock-2026-10-17.png`)).toBeNull();
    expect(status.getState().kind).toBe('launched');
    expect(ctx.opened).toHaveLength(1);
    const url = decodeURIComponent(ctx.opened[0] ?? '');
    expect(url).toContain('do=wallpaper-done');
    expect(url).toContain('do=wallpaper-failed');
    expect(url).not.toContain('action=wallpaper');
  });

  it('ссылки obsidian://planner: do=new-task и do=open', async () => {
    ctx = await setup();
    const links = planner(ctx).links;
    const url = links.build({ action: 'new-task', quadrant: 'plan', date: CONCERT_DAY });
    expect(url).toBe(`obsidian://planner?vault=${encodeURIComponent(REFERENCE_VAULT_NAME)}&do=new-task&quadrant=plan&date=${CONCERT_DAY}`);
    const parsed = parsePlannerUrl(url);
    expect(parsed.ok && parsed.result.ok ? parsed.result.link : null).toEqual({ action: 'new-task', quadrant: 'plan', date: CONCERT_DAY });

    const forms: TaskFormRequest[] = [];
    const openedItems: string[] = [];
    ctx.handle.actions.openTaskForm = (request) => {
      forms.push(request);
    };
    ctx.handle.actions.openItem = async (id) => {
      openedItems.push(id);
    };
    const protocol = ctx.handle.extension!.planner.protocol;
    await protocol.handle({ action: 'planner', vault: REFERENCE_VAULT_NAME, do: 'new-task', quadrant: 'plan', date: CONCERT_DAY });
    expect(forms).toEqual([{ mode: 'create', quadrant: 'plan', date: CONCERT_DAY }]);

    await protocol.handle({ action: 'planner', vault: REFERENCE_VAULT_NAME, do: 'open', id: REFERENCE_IDS.concert });
    expect(openedItems).toEqual([REFERENCE_IDS.concert]);

    const openUrl = links.build({ action: 'open', id: REFERENCE_IDS.dentist });
    expect(openUrl).toContain(`do=open&id=${REFERENCE_IDS.dentist}`);
  });

  it('новая схема — режим только чтения: данные видны, записи не выполняются', async () => {
    ctx = await setup({ schema: 2 });
    const files = () => [...ctx!.app.vault.contents.entries()].map(([path, content]) => `${path}\n${typeof content === 'string' ? content : new Uint8Array(content).join(',')}`).sort();
    const before = files();

    expect(planner(ctx).guard.canWrite()).toBe(false);
    expect(quadrantTitles(ctx)).toEqual(REFERENCE_QUADRANT_TITLES);

    expect((await ctx.handle.taskActions.create(taskDraft('Нельзя'))).ok).toBe(false);
    expect((await ctx.handle.taskActions.complete(REFERENCE_IDS.khrum)).ok).toBe(false);
    expect((await planner(ctx).tasks.postponeToTomorrow(REFERENCE_IDS.avito)).ok).toBe(false);
    expect((await planner(ctx).events.delete(REFERENCE_IDS.concert)).ok).toBe(false);
    expect((await planner(ctx).notes.create({ title: 'Нельзя', body: '', date: REFERENCE_TODAY })).ok).toBe(false);
    await planner(ctx).wallpaperStatus.run();
    expect(planner(ctx).wallpaperStatus.getState()).toEqual({ kind: 'failed', reason: 'render' });
    expect(ctx.opened).toEqual([]);

    await tick(10);
    expect(files()).toEqual(before);
  });
});

describe('локализация: словари ru и en совпадают по ключам', () => {
  type AnyDict = { [key: string]: unknown };
  const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

  /** Плоские ключи; формы множественного числа сводятся к `<ключ>.#plural` (у ru их больше). */
  function flatKeys(dict: AnyDict, prefix = ''): Set<string> {
    const out = new Set<string>();
    for (const [key, value] of Object.entries(dict)) {
      const full = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') out.add(PLURAL_CATEGORIES.has(key) && prefix ? `${prefix}.#plural` : full);
      else if (value && typeof value === 'object') for (const nested of flatKeys(value as AnyDict, full)) out.add(nested);
    }
    return out;
  }

  /** Модуль i18n → словари; имена модулей — как в `registerDictionary`. */
  const modules: Array<[string, AnyDict, AnyDict]> = [
    ['app', ruApp, enApp],
    ['cache', ruCache, enCache],
    ['calendar', ruCalendar, enCalendar],
    ['calendar-model', ruCalendarModel, enCalendarModel],
    ['common', ruCommon, enCommon],
    ['events', ruEvents, enEvents],
    ['integrity', ruIntegrity, enIntegrity],
    ['lockscreen', ruLockscreen, enLockscreen],
    ['model', ruModel, enModel],
    ['notes', ruNotes, enNotes],
    ['protocol', ruProtocol, enProtocol],
    ['settings', ruSettings, enSettings],
    ['shell', ruShell, enShell],
    ['storage', ruStorage, enStorage],
    ['taskActions', ruTaskActions, enTaskActions],
    ['taskForm', ruTaskForm, enTaskForm],
    ['tasks', ruTasks, enTasks],
    [WALLPAPER_LAYOUT_MODULE, ruWallpaperLayout, enWallpaperLayout],
    ['wallpaperRender', ruWallpaperRender, enWallpaperRender],
  ];

  for (const [module, ru, en] of modules) {
    it(`${module}: все ключи ru есть в en и наоборот`, () => {
      const ruKeys = flatKeys(ru);
      const enKeys = flatKeys(en);
      expect([...ruKeys].filter((key) => !enKeys.has(key)).sort()).toEqual([]);
      expect([...enKeys].filter((key) => !ruKeys.has(key)).sort()).toEqual([]);
    });
  }

  it('после сборки плагина все словари зарегистрированы', async () => {
    resetMockState();
    const app = createReferenceApp({ empty: true });
    const plugin = new MockPlugin(app);
    plugin.load();
    const handle = await composeApp(plugin as unknown as Plugin, {
      clock: new ReferenceClock(),
      notifier: new CollectingNotifier(),
      platform: IOS,
      renderer: fakeRenderer(),
      openUrl: () => undefined,
      getScreen: () => null,
    });
    await handle.ready;
    try {
      const missing: string[] = [];
      for (const [module, ru] of modules) {
        for (const key of flatKeys(ru)) {
          const fullKey = key.endsWith('.#plural') ? `${module}.${key.slice(0, -'.#plural'.length)}.other` : `${module}.${key}`;
          if (!hasTranslation(fullKey)) missing.push(fullKey);
        }
      }
      expect(missing).toEqual([]);
    } finally {
      plugin.unload();
    }
  });
});

describe('набор на 1 000 задач', () => {
  it('группы квадрантов и элементы недели строятся быстрее мягкого порога', async () => {
    resetMockState();
    setLanguageOverride('ru');
    const ctx = await setup({ empty: true, loadTasks: 1000 });
    try {
      const tasks = planner(ctx).index.getTasks();
      expect(tasks).toHaveLength(1000);

      const started = performance.now();
      const now = nowFloating(ctx);
      const groups = groupTasksByQuadrant(tasks, now);
      const range = weekRange(REFERENCE_TODAY, 1);
      const days = planner(ctx).dayItems.getDays(range);
      const strip = buildWeekStrip({ selected: REFERENCE_TODAY, today: REFERENCE_TODAY, weekStart: 1, days });
      const elapsed = performance.now() - started;

      const active = QUADRANT_KEYS.reduce((sum, key) => sum + groups[key].length, 0);
      expect(active).toBeGreaterThan(0);
      expect(active).toBeLessThan(1000);
      expect(strip).toHaveLength(7);
      expect(strip.some((day) => day.summary.count > 0)).toBe(true);
      // Мягкий порог для node; на устройстве — ручная проверка docs/acceptance.md.
      expect(elapsed).toBeLessThan(1500);
    } finally {
      ctx.plugin.unload();
      setLanguageOverride(null);
    }
  }, 60_000);
});
