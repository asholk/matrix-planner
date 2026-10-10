import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Записываем созданные `Setting`, чтобы находить их по названию.
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

import type { App } from 'obsidian';
import { ButtonComponent, MockElement, Plugin, Setting, createMockApp, resetMockState } from '../__mocks__/obsidian';
import type { PlannerViewHost } from '../../src/app/contracts';
import { openPluginSettings } from '../../src/app/compose-core';
import { setLanguageOverride } from '../../src/i18n';
import { PluginSettingsStore } from '../../src/settings/settings-store';
import { SettingsViewTab } from '../../src/ui/settings-tab-view';
import '../../src/ui/planner-view';

function names(): string[] {
  return (recorded.settings as Setting[]).map((setting) => setting.name);
}

function findSetting(name: string): Setting {
  const found = (recorded.settings as Setting[]).find((setting) => setting.name === name);
  if (!found) throw new Error(`Нет параметра «${name}»`);
  return found;
}

function createHost(): PlannerViewHost {
  return {
    actions: {} as PlannerViewHost['actions'],
    platform: { isMobile: true, isPhone: true, isTablet: false, isIos: true, isAndroid: false, isDesktop: false } as PlannerViewHost['platform'],
    getActiveTab: () => 'settings',
    switchTab: () => undefined,
    setAddContext: vi.fn(),
    getAddContext: () => ({ date: null, quadrant: null }),
    register: () => undefined,
  };
}

async function createStore(): Promise<PluginSettingsStore> {
  const plugin = new Plugin(createMockApp(), { id: 'matrix-planner' } as never);
  const store = new PluginSettingsStore(plugin);
  await store.load();
  return store;
}

beforeEach(() => {
  resetMockState();
  setLanguageOverride('ru');
  recorded.settings.length = 0;
});

afterEach(() => {
  setLanguageOverride(null);
});

describe('вкладка «Настройки» вида', () => {
  it('показывает основные настройки и кнопку «Все настройки плагина»', async () => {
    const store = await createStore();
    const open = vi.fn();
    const tab = new SettingsViewTab(createHost(), { settings: { store }, openPluginSettings: open });
    const container = new MockElement('div');
    tab.mount(container as unknown as HTMLElement);
    tab.onShow();

    expect(names()).toContain('Все настройки плагина');
    // Разделы рисует общий отрисовщик вкладки настроек Obsidian.
    expect(names()).toContain('Корневая папка');
    expect(container.findAllByClass('mp-settings-view-title')[0]?.getText()).toBe('Настройки');

    const button = findSetting('Все настройки плагина').components.find((item): item is ButtonComponent => item instanceof ButtonComponent);
    button?.click();
    expect(open).toHaveBeenCalledTimes(1);
    tab.unmount();
  });

  it('скрытие освобождает разделы, повторный показ рисует их заново', async () => {
    const store = await createStore();
    const dispose = vi.fn();
    const render = vi.fn();
    const tab = new SettingsViewTab(createHost(), {
      settings: { store, sections: [{ order: 100, render, dispose }] },
      openPluginSettings: () => undefined,
    });
    tab.mount(new MockElement('div') as unknown as HTMLElement);
    tab.onShow();
    expect(render).toHaveBeenCalledTimes(1);
    tab.onHide();
    expect(dispose).toHaveBeenCalledTimes(1);
    tab.onShow();
    expect(render).toHaveBeenCalledTimes(2);
    tab.unmount();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

describe('openPluginSettings', () => {
  it('открывает настройки на вкладке плагина через внутренний API', () => {
    const calls: string[] = [];
    const app = { setting: { open: () => calls.push('open'), openTabById: (id: string) => calls.push(`tab:${id}`) } };
    expect(openPluginSettings(app as unknown as App, 'matrix-planner')).toBe(true);
    expect(calls).toEqual(['open', 'tab:matrix-planner']);
  });

  it('без API или при ошибке возвращает false', () => {
    expect(openPluginSettings({} as unknown as App, 'matrix-planner')).toBe(false);
    expect(openPluginSettings({ setting: { open: () => undefined } } as unknown as App, 'matrix-planner')).toBe(false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = {
      setting: {
        open: () => {
          throw new Error('нет');
        },
        openTabById: () => undefined,
      },
    };
    expect(openPluginSettings(failing as unknown as App, 'matrix-planner')).toBe(false);
    error.mockRestore();
  });
});
