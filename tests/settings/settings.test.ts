import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Записываем все созданные `Setting`, чтобы находить их по названию и имитировать ввод.
const recorded = vi.hoisted(() => ({ settings: [] as unknown[] }));

vi.mock('obsidian', async (importOriginal) => {
  const original = await importOriginal<typeof import('../__mocks__/obsidian')>();
  class RecordingSetting extends original.Setting {
    constructor(containerEl: HTMLElement) {
      super(containerEl);
      recorded.settings.push(this);
    }
  }
  return { ...original, Setting: RecordingSetting };
});

import type { App, Plugin as ObsidianPlugin } from 'obsidian';
import {
  ButtonComponent,
  DropdownComponent,
  MockElement,
  Plugin,
  Setting,
  TextComponent,
  ToggleComponent,
  createMockApp,
  resetMockState,
} from '../__mocks__/obsidian';
import type { SettingsSection } from '../../src/app/contracts';
import { setLanguageOverride } from '../../src/i18n';
import type { CompanionState, IntegrityReport, OpResult, PlannerSettings } from '../../src/model/types';
import { DEFAULT_ROOT_FOLDER } from '../../src/model/types';
import {
  DEFAULT_REMINDER_TIME,
  DEFAULT_SHORTCUT_NAME,
  SETTINGS_VERSION,
  createDefaultSettings,
  migrateSettings,
} from '../../src/settings/defaults';
import {
  PluginSettingsStore,
  normalizeArchiveDays,
  normalizeProfileId,
  normalizeSettings,
  normalizeShortcutName,
  normalizeTime,
  validateRootFolder,
} from '../../src/settings/settings-store';
import { PlannerSettingTab, isReminderSchedulingPending } from '../../src/settings/settings-tab';
import type { SettingsTabDeps } from '../../src/settings/types';

/** Дождаться цепочки промисов сохранения. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createPlugin(data: unknown = null): Plugin {
  const plugin = new Plugin(createMockApp());
  plugin.data = data;
  return plugin;
}

async function createStore(data: unknown = null): Promise<{ plugin: Plugin; store: PluginSettingsStore }> {
  const plugin = createPlugin(data);
  const store = new PluginSettingsStore(plugin);
  await store.load();
  return { plugin, store };
}

function settingsList(): Setting[] {
  return recorded.settings as Setting[];
}

function findSetting(name: string): Setting {
  const found = settingsList().find((setting) => setting.name === name && !setting.heading);
  if (!found) throw new Error(`Нет параметра «${name}»`);
  return found;
}

function component<T>(setting: Setting, type: abstract new (...args: never[]) => T): T {
  const found = setting.components.find((item): item is T => item instanceof type);
  if (!found) throw new Error(`У «${setting.name}» нет нужного элемента`);
  return found;
}

function headings(): string[] {
  return settingsList()
    .filter((setting) => setting.heading)
    .map((setting) => setting.name);
}

function createTab(plugin: Plugin, deps: SettingsTabDeps): PlannerSettingTab {
  return new PlannerSettingTab(plugin.app as unknown as App, plugin as unknown as ObsidianPlugin, deps);
}

beforeEach(() => {
  resetMockState();
  setLanguageOverride('ru');
  recorded.settings.length = 0;
});

afterEach(() => {
  setLanguageOverride(null);
});

// ---------------------------------------------------------------------------
// Значения по умолчанию и нормализация
// ---------------------------------------------------------------------------

describe('значения по умолчанию', () => {
  it('соответствуют ТЗ §4.6', () => {
    const defaults = createDefaultSettings();
    expect(defaults.version).toBe(SETTINGS_VERSION);
    expect(defaults.rootFolder).toBe(DEFAULT_ROOT_FOLDER);
    expect(defaults.archive).toEqual({ mode: 'never' });
    expect(defaults.reminderTimeForDateOnly).toBe('09:00');
    expect(defaults.weekStart).toBe('auto');
    expect(defaults.timeFormat).toBe('auto');
    expect(defaults.showTasksInIosCalendar).toBe(true);
    expect(defaults.writeCompletedTasksToCalendar).toBe(false);
    expect(defaults.defaultEventCalendarId).toBeNull();
    expect(defaults.visibleCalendars).toEqual({ planner: true, birthdays: true, calendarIds: [] });
    expect(defaults.wallpaper.profile).toBe('auto');
    expect(defaults.wallpaper.shortcutName).toBe(DEFAULT_SHORTCUT_NAME);
    expect(defaults.wallpaper.template).toBe('matrix');
  });

  it('каждый вызов возвращает независимую копию', () => {
    const a = createDefaultSettings();
    a.visibleCalendars.calendarIds.push('x');
    expect(createDefaultSettings().visibleCalendars.calendarIds).toEqual([]);
  });

  it('пустой или битый data.json даёт значения по умолчанию', async () => {
    expect(normalizeSettings(null)).toEqual(createDefaultSettings());
    expect(normalizeSettings('мусор')).toEqual(createDefaultSettings());
    expect(normalizeSettings([1, 2])).toEqual(createDefaultSettings());
    const { store } = await createStore(null);
    expect(store.get()).toEqual(createDefaultSettings());
  });

  it('ошибка чтения data.json не мешает загрузке', async () => {
    const store = new PluginSettingsStore({
      loadData: () => Promise.reject(new Error('io')),
      saveData: () => Promise.resolve(),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.load();
    expect(store.get()).toEqual(createDefaultSettings());
  });

  it('данные без версии считаются версией 1, более новая версия не понижается', () => {
    expect(migrateSettings({ rootFolder: 'A' })).toEqual({ rootFolder: 'A' });
    expect(normalizeSettings({}).version).toBe(SETTINGS_VERSION);
    expect(normalizeSettings({ version: SETTINGS_VERSION + 5 }).version).toBe(SETTINGS_VERSION + 5);
  });
});

describe('неизвестные поля', () => {
  const stored = {
    version: 1,
    rootFolder: 'Работа/План',
    futureFlag: { nested: [1, 2, 3] },
    archive: { mode: 'after-days', days: 14, note: 'x' },
    visibleCalendars: { planner: false, birthdays: true, calendarIds: ['c1'], order: ['c1'] },
    wallpaper: { template: 'calendar', shortcutName: 'Моя команда', futureOption: 42, background: { kind: 'solid', color: '#000000', blur: 3 } },
    ui: { lastTab: 'calendar', zoom: 2, calendarSources: { tasks: false, extraSource: true } },
  };

  it('сохраняются при загрузке и после изменения', async () => {
    const { plugin, store } = await createStore(stored);
    const loaded = store.get() as PlannerSettings & Record<string, unknown>;
    expect(loaded.futureFlag).toEqual({ nested: [1, 2, 3] });
    expect(loaded.rootFolder).toBe('Работа/План');
    expect(loaded.archive).toEqual({ mode: 'after-days', days: 14, note: 'x' });

    await store.update((draft) => {
      draft.timeFormat = '24h';
    });
    const saved = plugin.data as Record<string, any>;
    expect(saved.futureFlag).toEqual({ nested: [1, 2, 3] });
    expect(saved.visibleCalendars.order).toEqual(['c1']);
    expect(saved.wallpaper.futureOption).toBe(42);
    expect(saved.wallpaper.background).toEqual({ kind: 'solid', color: '#000000', blur: 3 });
    expect(saved.ui.zoom).toBe(2);
    expect(saved.ui.calendarSources).toEqual({ tasks: false, events: true, notes: true, external: true, extraSource: true });
    expect(saved.timeFormat).toBe('24h');
    // Отсутствующие известные поля дополнены значениями по умолчанию.
    expect(saved.reminderTimeForDateOnly).toBe(DEFAULT_REMINDER_TIME);
    expect(saved.wallpaper.palette).toBe('dark');
  });
});

describe('корневая папка', () => {
  it('нормализует допустимые пути', () => {
    expect(validateRootFolder('  Планировщик  ')).toEqual({ ok: true, value: 'Планировщик' });
    expect(validateRootFolder('/Работа//План/')).toEqual({ ok: true, value: 'Работа/План' });
    expect(validateRootFolder('Работа\\План')).toEqual({ ok: true, value: 'Работа/План' });
  });

  it('отклоняет недопустимые значения', () => {
    expect(validateRootFolder('')).toMatchObject({ ok: false, error: 'empty' });
    expect(validateRootFolder(' / ')).toMatchObject({ ok: false, error: 'empty' });
    expect(validateRootFolder(42)).toMatchObject({ ok: false, error: 'empty' });
    expect(validateRootFolder('../Чужое')).toMatchObject({ ok: false, error: 'dot-segment' });
    expect(validateRootFolder('A/./B')).toMatchObject({ ok: false, error: 'dot-segment' });
    expect(validateRootFolder('.planner')).toMatchObject({ ok: false, error: 'hidden' });
    expect(validateRootFolder('План: 2026')).toMatchObject({ ok: false, error: 'invalid-chars', chars: ':' });
    expect(validateRootFolder('План#1')).toMatchObject({ ok: false, error: 'invalid-chars' });
    expect(validateRootFolder('matrix-planner.md')).toMatchObject({ ok: false, error: 'reserved' });
    expect(validateRootFolder('Планировщик/_system')).toMatchObject({ ok: false, error: 'reserved' });
  });

  it('невалидный корень в data.json заменяется значением по умолчанию', async () => {
    const { store } = await createStore({ rootFolder: '../outside' });
    expect(store.get().rootFolder).toBe(DEFAULT_ROOT_FOLDER);
  });

  it('невалидный корень при изменении откатывается к предыдущему', async () => {
    const { store } = await createStore({ rootFolder: 'Мой план' });
    await store.update((draft) => {
      draft.rootFolder = '.hidden';
    });
    expect(store.get().rootFolder).toBe('Мой план');
  });

  it('вкладка показывает ошибку и не сохраняет невалидный корень, а валидный сохраняет по завершении ввода', async () => {
    const { plugin, store } = await createStore();
    const tab = createTab(plugin, { store });
    tab.display();
    const setting = findSetting('Корневая папка');
    const text = component(setting, TextComponent);
    const input = text.inputEl as unknown as MockElement;

    text.simulateChange('../x');
    input.dispatch('change');
    await flush();
    expect(store.get().rootFolder).toBe(DEFAULT_ROOT_FOLDER);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const error = (setting.descEl as unknown as MockElement).findAllByClass('mp-settings-error')[0];
    expect(error?.getText()).toContain('«.»');

    text.simulateChange(' Работа/План/ ');
    // До события change корень не меняется.
    await flush();
    expect(store.get().rootFolder).toBe(DEFAULT_ROOT_FOLDER);
    input.dispatch('change');
    await flush();
    expect(store.get().rootFolder).toBe('Работа/План');
    expect(text.getValue()).toBe('Работа/План');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });
});

describe('архив через N дней', () => {
  it('валидирует число дней', () => {
    expect(normalizeArchiveDays(30)).toBe(30);
    expect(normalizeArchiveDays('7')).toBe(7);
    expect(normalizeArchiveDays(0)).toBeNull();
    expect(normalizeArchiveDays(1.5)).toBeNull();
    expect(normalizeArchiveDays(100000)).toBeNull();
    expect(normalizeArchiveDays('abc')).toBeNull();
  });

  it('нормализует режим архива', () => {
    expect(normalizeSettings({ archive: { mode: 'after-days', days: 14 } }).archive).toEqual({ mode: 'after-days', days: 14 });
    expect(normalizeSettings({ archive: { mode: 'after-days', days: -1 } }).archive).toEqual({ mode: 'never' });
    expect(normalizeSettings({ archive: { mode: 'sometimes' } }).archive).toEqual({ mode: 'never' });
    expect(normalizeSettings({ archive: { mode: 'never', days: 5 } }).archive).toEqual({ mode: 'never' });
  });

  it('вкладка включает режим «Через N дней» и меняет N', async () => {
    const { plugin, store } = await createStore();
    const tab = createTab(plugin, { store });
    tab.display();
    expect(() => findSetting('Через сколько дней')).toThrow();

    component(findSetting('Перенос выполненных в архив'), DropdownComponent).simulateChange('after-days');
    await flush();
    expect(store.get().archive).toEqual({ mode: 'after-days', days: 30 });

    // Вкладка перерисована: появилось поле N.
    const days = component(findSetting('Через сколько дней'), TextComponent);
    days.simulateChange('0');
    await flush();
    expect(store.get().archive).toEqual({ mode: 'after-days', days: 30 });
    days.simulateChange('45');
    await flush();
    expect(store.get().archive).toEqual({ mode: 'after-days', days: 45 });

    recorded.settings.length = 0;
    tab.display();
    component(findSetting('Перенос выполненных в архив'), DropdownComponent).simulateChange('never');
    await flush();
    expect(store.get().archive).toEqual({ mode: 'never' });
  });
});

describe('формат времени и начало недели', () => {
  it('недопустимые значения заменяются значениями по умолчанию', () => {
    const settings = normalizeSettings({ weekStart: 'friday', timeFormat: '36h' });
    expect(settings.weekStart).toBe('auto');
    expect(settings.timeFormat).toBe('auto');
    const valid = normalizeSettings({ weekStart: 'sunday', timeFormat: '12h' });
    expect(valid.weekStart).toBe('sunday');
    expect(valid.timeFormat).toBe('12h');
  });

  it('вкладка сохраняет выбор и показывает вычисленное значение', async () => {
    const { plugin, store } = await createStore();
    const tab = createTab(plugin, {
      store,
      format: { get: () => ({ language: 'ru', weekStart: 1, hour12: false }) },
    });
    tab.display();
    expect(findSetting('Неделя начинается с').desc).toBe('Сейчас: Понедельник');
    expect(findSetting('Формат времени').desc).toBe('Сейчас: 24-часовой');

    component(findSetting('Неделя начинается с'), DropdownComponent).simulateChange('sunday');
    component(findSetting('Формат времени'), DropdownComponent).simulateChange('12h');
    await flush();
    expect(store.get().weekStart).toBe('sunday');
    expect(store.get().timeFormat).toBe('12h');
  });
});

describe('время напоминания 09:00', () => {
  it('по умолчанию 09:00 и нормализуется до ЧЧ:ММ', () => {
    expect(normalizeSettings({}).reminderTimeForDateOnly).toBe('09:00');
    expect(normalizeTime('9:05')).toBe('09:05');
    expect(normalizeTime('23:59')).toBe('23:59');
    expect(normalizeTime('24:00')).toBeNull();
    expect(normalizeTime('12:60')).toBeNull();
    expect(normalizeTime('утро')).toBeNull();
    expect(normalizeSettings({ reminderTimeForDateOnly: '25:00' }).reminderTimeForDateOnly).toBe('09:00');
  });

  it('вкладка сохраняет только корректное время', async () => {
    const { plugin, store } = await createStore();
    const tab = createTab(plugin, { store });
    tab.display();
    const text = component(findSetting('Время напоминания для задач без времени'), TextComponent);
    expect(text.getValue()).toBe('09:00');
    expect((text.inputEl as unknown as MockElement).getAttribute('type')).toBe('time');
    text.simulateChange('');
    await flush();
    expect(store.get().reminderTimeForDateOnly).toBe('09:00');
    text.simulateChange('07:30');
    await flush();
    expect(store.get().reminderTimeForDateOnly).toBe('07:30');
  });
});

describe('профиль устройства и быстрая команда', () => {
  it('валидирует id профиля и название команды', () => {
    expect(normalizeProfileId('auto')).toBe('auto');
    expect(normalizeProfileId('iphone-1179x2556')).toBe('iphone-1179x2556');
    expect(normalizeProfileId('../evil')).toBeNull();
    expect(normalizeProfileId('a/b')).toBeNull();
    expect(normalizeShortcutName('  Обои  ')).toBe('Обои');
    expect(normalizeShortcutName('   ')).toBeNull();
    const settings = normalizeSettings({ wallpaper: { profile: '../x', shortcutName: '' } });
    expect(settings.wallpaper.profile).toBe('auto');
    expect(settings.wallpaper.shortcutName).toBe(DEFAULT_SHORTCUT_NAME);
  });

  it('вкладка показывает профили и сохраняет профиль, шаблон и команду', async () => {
    const { plugin, store } = await createStore({ wallpaper: { profile: 'ipad-2048x2732' } });
    const profile = { id: 'iphone-1179x2556', label: 'iPhone 1179 × 2556', width: 1179, height: 2556, safeTop: 0.38, safeBottom: 0.88 };
    const tab = createTab(plugin, {
      store,
      wallpaperProfiles: { list: () => [profile], resolveAuto: () => profile },
    });
    tab.display();

    const dropdown = component(findSetting('Профиль устройства'), DropdownComponent);
    expect(Object.keys(dropdown.options)).toEqual(['auto', 'iphone-1179x2556', 'ipad-2048x2732']);
    expect(dropdown.getValue()).toBe('ipad-2048x2732');
    dropdown.simulateChange('auto');
    await flush();
    expect(store.get().wallpaper.profile).toBe('auto');

    component(findSetting('Шаблон'), DropdownComponent).simulateChange('calendar');
    await flush();
    expect(store.get().wallpaper.template).toBe('calendar');

    const shortcut = component(findSetting('Название быстрой команды'), TextComponent);
    const input = shortcut.inputEl as unknown as MockElement;
    shortcut.simulateChange('   ');
    input.dispatch('change');
    await flush();
    expect(store.get().wallpaper.shortcutName).toBe(DEFAULT_SHORTCUT_NAME);
    shortcut.simulateChange(' Обои iPhone ');
    input.dispatch('change');
    await flush();
    expect(store.get().wallpaper.shortcutName).toBe('Обои iPhone');
  });
});

// ---------------------------------------------------------------------------
// Хранилище
// ---------------------------------------------------------------------------

describe('PluginSettingsStore', () => {
  it('вызывает слушателей после сохранения с предыдущим значением', async () => {
    const { plugin, store } = await createStore();
    const calls: Array<[string, string, unknown]> = [];
    const unsubscribe = store.onChange((next, previous) => {
      calls.push([next.timeFormat, previous.timeFormat, (plugin.data as PlannerSettings).timeFormat]);
    });
    await store.update((draft) => {
      draft.timeFormat = '12h';
    });
    expect(calls).toEqual([['12h', 'auto', '12h']]);
    unsubscribe();
    await store.update((draft) => {
      draft.timeFormat = '24h';
    });
    expect(calls).toHaveLength(1);
  });

  it('при ошибке записи сохраняет прежнее состояние и пробрасывает ошибку', async () => {
    let fail = true;
    const store = new PluginSettingsStore({
      loadData: () => Promise.resolve(null),
      saveData: () => (fail ? Promise.reject(new Error('disk')) : Promise.resolve()),
    });
    await store.load();
    await expect(
      store.update((draft) => {
        draft.weekStart = 'monday';
      }),
    ).rejects.toThrow('disk');
    expect(store.get().weekStart).toBe('auto');
    fail = false;
    await store.update((draft) => {
      draft.weekStart = 'monday';
    });
    expect(store.get().weekStart).toBe('monday');
  });

  it('последовательные изменения не теряются', async () => {
    const { store } = await createStore();
    await Promise.all([
      store.update((draft) => {
        draft.weekStart = 'sunday';
      }),
      store.update((draft) => {
        draft.timeFormat = '12h';
      }),
    ]);
    expect(store.get().weekStart).toBe('sunday');
    expect(store.get().timeFormat).toBe('12h');
  });
});

// ---------------------------------------------------------------------------
// Вкладка: разделы и заголовки
// ---------------------------------------------------------------------------

describe('вкладка настроек', () => {
  it('общие параметры без заголовка, разделы через setHeading без слова «настройки»', async () => {
    const { plugin, store } = await createStore();
    const integrity = {
      check: () => Promise.resolve({ ok: true, value: { checkedAt: '2026-10-10T10:00:00Z', items: [], reassignedIds: {} }, changed: false } as OpResult<IntegrityReport>),
      getLastReport: () => null,
      onChange: () => () => undefined,
    };
    const tab = createTab(plugin, { store, integrity });
    tab.display();

    expect(headings()).toEqual(['Календарь', 'Экран блокировки', 'Компаньон', 'Данные']);
    expect(settingsList()[0]?.heading).toBe(false);
    expect(settingsList()[0]?.name).toBe('Корневая папка');
    for (const name of headings()) expect(name.toLowerCase()).not.toContain('настройк');
  });

  it('английские заголовки тоже без слова «settings»', async () => {
    setLanguageOverride('en');
    const { plugin, store } = await createStore();
    createTab(plugin, { store }).display();
    expect(headings()).toEqual(['Calendar', 'Lock screen', 'Companion']);
    for (const name of headings()) expect(name.toLowerCase()).not.toContain('settings');
  });

  it('без сервиса целостности раздел «Данные» не показывается, без компаньона — нет кнопки открытия', async () => {
    const { plugin, store } = await createStore();
    createTab(plugin, { store }).display();
    expect(headings()).not.toContain('Данные');
    expect(() => findSetting('Открыть компаньон')).toThrow();
    expect(findSetting('Состояние')).toBeDefined();
  });

  it('дополнительные разделы встают по order и освобождаются при скрытии', async () => {
    const { plugin, store } = await createStore();
    const dispose = vi.fn();
    const section: SettingsSection = {
      order: 15,
      render: (el) => {
        (el as unknown as MockElement).createDiv({ cls: 'extra-section' });
      },
      dispose,
    };
    const tab = createTab(plugin, { store, sections: [section] });
    tab.display();
    const container = tab.containerEl as unknown as MockElement;
    const sections = container.children.filter((child) => child.hasClass('mp-settings-section'));
    // Общие, календарь, доп. раздел (15), экран блокировки, компаньон.
    expect(sections).toHaveLength(5);
    expect(sections[2]?.findAllByClass('extra-section')).toHaveLength(1);
    tab.hide();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('показываемые календари: «Планировщик», «Дни рождения» и календари кэша', async () => {
    const { plugin, store } = await createStore();
    const tab = createTab(plugin, {
      store,
      calendars: {
        getCalendars: () => [
          { calendarId: 'work', title: 'Работа', color: '#3E8BF0', kind: 'caldav', allowsModifications: true },
          { calendarId: 'bd', title: 'Дни рождения', color: '#8E8E93', kind: 'birthdays', allowsModifications: false },
          { calendarId: 'holidays', title: 'Праздники', color: '#E5484D', kind: 'subscription', allowsModifications: false },
        ],
        onChange: () => () => undefined,
      },
    });
    tab.display();

    const defaultCalendar = component(findSetting('Календарь для новых событий'), DropdownComponent);
    expect(Object.keys(defaultCalendar.options)).toEqual(['', 'work']);
    defaultCalendar.simulateChange('work');
    await flush();
    expect(store.get().defaultEventCalendarId).toBe('work');

    const birthdays = settingsList().filter((setting) => setting.name === 'Дни рождения');
    expect(birthdays).toHaveLength(1);
    component(findSetting('Праздники'), ToggleComponent).simulateChange(true);
    await flush();
    component(findSetting('Планировщик'), ToggleComponent).simulateChange(false);
    await flush();
    expect(store.get().visibleCalendars).toEqual({ planner: false, birthdays: true, calendarIds: ['holidays'] });
  });

  it('компаньон: состояние, кнопка открытия и баннер о напоминании', async () => {
    const { plugin, store } = await createStore();
    let state: CompanionState = { status: 'missing' };
    const hub: { listener: ((value: CompanionState) => void) | null } = { listener: null };
    const open = vi.fn();
    const now = Date.parse('2026-10-10T12:00:00Z');
    const tab = createTab(plugin, {
      store,
      clock: { now: () => new Date(now), timeZone: () => 'UTC' },
      companion: {
        getState: () => state,
        onChange: (cb) => {
          hub.listener = cb;
          return () => {
            hub.listener = null;
          };
        },
      },
      openCompanion: open,
      lastReminderEditAt: () => now - 5 * 60_000,
    });
    tab.display();
    const container = tab.containerEl as unknown as MockElement;
    expect(findSetting('Состояние').desc).toBe('');
    expect((findSetting('Состояние').descEl as unknown as MockElement).children[0]?.getText()).toContain('не подключён');
    expect(container.findAllByClass('mp-settings-banner')).toHaveLength(1);

    component(findSetting('Открыть компаньон'), ButtonComponent).click();
    expect(open).toHaveBeenCalledTimes(1);

    // Компаньон обновил данные после правки — раздел перерисовывается, баннер исчезает.
    state = { status: 'ok', primaryDevice: 'iPhone Анны', lastUpdate: '2026-10-10T11:58:00Z', wallpapers: {} };
    recorded.settings.length = 0;
    hub.listener?.(state);
    const lines = (findSetting('Состояние').descEl as unknown as MockElement).children.map((child) => child.getText());
    expect(lines[1]).toBe('Основное устройство: iPhone Анны');
    expect(container.findAllByClass('mp-settings-banner')).toHaveLength(0);

    tab.hide();
    expect(hub.listener).toBeNull();
  });

  it('данные: проверка целостности и простой список «Требуют внимания»', async () => {
    const { plugin, store } = await createStore();
    let report: IntegrityReport | null = null;
    let listener: ((value: IntegrityReport | null) => void) | null = null;
    const opened: string[] = [];
    const notices: string[] = [];
    const nextReport: IntegrityReport = {
      checkedAt: '2026-10-10T10:00:00Z',
      items: [
        { key: 'dup', kind: 'duplicate-id', paths: ['Планировщик/Задачи/А.md', 'Планировщик/Задачи/А (2).md'], itemId: 'X', messageKey: 'settings.data.attention.name' },
      ],
      reassignedIds: {},
    };
    const tab = createTab(plugin, {
      store,
      notifier: { show: (message) => notices.push(message) },
      openNote: (path) => opened.push(path),
      integrity: {
        check: async () => {
          report = nextReport;
          listener?.(report);
          return { ok: true, value: nextReport, changed: true };
        },
        getLastReport: () => report,
        onChange: (cb) => {
          listener = cb;
          return () => {
            listener = null;
          };
        },
      },
    });
    tab.display();
    expect(findSetting('Требуют внимания').desc).toBe('Проверка ещё не выполнялась.');

    component(findSetting('Проверить целостность'), ButtonComponent).click();
    await flush();
    expect(notices).toEqual(['Найдена 1 проблема']);
    const container = tab.containerEl as unknown as MockElement;
    const items = container.findAllByClass('mp-settings-attention-item');
    expect(items).toHaveLength(1);
    const buttons = container.findAllByClass('mp-settings-attention-open');
    expect(buttons).toHaveLength(2);
    buttons[1]?.click();
    expect(opened).toEqual(['Планировщик/Задачи/А (2).md']);
  });

  it('данные: подключённая панель «Требуют внимания» заменяет простой список и освобождается', async () => {
    const { plugin, store } = await createStore();
    const dispose = vi.fn();
    const tab = createTab(plugin, {
      store,
      integrity: {
        check: () => Promise.resolve({ ok: false, error: { code: 'unknown' } }),
        getLastReport: () => null,
        onChange: () => () => undefined,
      },
      attentionPanel: (el) => {
        (el as unknown as MockElement).createDiv({ cls: 'panel' });
        return { dispose };
      },
    });
    tab.display();
    expect((tab.containerEl as unknown as MockElement).findAllByClass('panel')).toHaveLength(1);
    tab.hide();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('баннер о планировании напоминания', () => {
  const edit = Date.parse('2026-10-10T12:00:00Z');

  it('показывается, если компаньон не обновлялся больше минуты после правки', () => {
    expect(isReminderSchedulingPending(null, edit, edit + 61_000)).toBe(true);
    expect(isReminderSchedulingPending('2026-10-10T11:00:00Z', edit, edit + 120_000)).toBe(true);
  });

  it('не показывается в первую минуту, после обновления компаньона и без правок', () => {
    expect(isReminderSchedulingPending(null, edit, edit + 30_000)).toBe(false);
    expect(isReminderSchedulingPending('2026-10-10T12:00:30Z', edit, edit + 120_000)).toBe(false);
    expect(isReminderSchedulingPending(null, null, edit)).toBe(false);
  });
});
