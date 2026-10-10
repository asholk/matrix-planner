/**
 * Вкладка «Настройки» вида (кадр 19): основные настройки плагина прямо в планировщике
 * и переход ко всем настройкам плагина в Obsidian. Разделы рисует общий
 * `PlannerSettingsRenderer` (тот же код, что и вкладка настроек Obsidian).
 */

import { Setting } from 'obsidian';
import type { PlannerViewHost, TabController, TabFactory } from '../app/contracts';
import { t } from '../i18n';
import { PlannerSettingsRenderer } from '../settings/settings-tab';
import type { SettingsTabDeps } from '../settings/types';

export interface SettingsViewTabDeps {
  settings: SettingsTabDeps;
  /** Открыть вкладку плагина в настройках Obsidian (недоступность сообщает сама). */
  openPluginSettings(): void;
}

/** Фабрика вкладки для `PlannerViewOptions.tabs.settings`. */
export function createSettingsViewTab(deps: SettingsViewTabDeps): TabFactory {
  return (host) => new SettingsViewTab(host, deps);
}

export class SettingsViewTab implements TabController {
  readonly id = 'settings' as const;

  private rootEl: HTMLElement | null = null;
  private sectionsEl: HTMLElement | null = null;
  private readonly renderer: PlannerSettingsRenderer;
  private shown = false;

  constructor(
    private readonly host: PlannerViewHost,
    private readonly deps: SettingsViewTabDeps,
  ) {
    this.renderer = new PlannerSettingsRenderer(deps.settings);
  }

  mount(containerEl: HTMLElement): void {
    this.unmount();
    const root = containerEl.createDiv({ cls: 'mp-settings-view' });
    this.rootEl = root;
    root.createEl('h2', { cls: 'mp-settings-view-title', text: t('common.tabs.settings') });

    const all = root.createDiv({ cls: 'mp-settings-view-card mp-settings-view-all' });
    new Setting(all)
      .setName(t('shell.settings.all.name'))
      .setDesc(t('shell.settings.all.desc'))
      .addButton((button) =>
        button
          .setButtonText(t('shell.settings.all.button'))
          .setCta()
          .onClick(() => this.deps.openPluginSettings()),
      );

    this.sectionsEl = root.createDiv({ cls: 'mp-settings-view-sections' });
    // Без `onShow` (например, первая отрисовка в тестах) — рисуем сразу.
    this.draw();
  }

  unmount(): void {
    this.renderer.dispose();
    this.shown = false;
    this.rootEl?.remove();
    this.rootEl = null;
    this.sectionsEl = null;
  }

  onShow(): void {
    this.host.setAddContext({ date: null, quadrant: null });
    // Значения могли измениться в настройках Obsidian, пока вкладка была скрыта.
    if (!this.shown) this.draw();
  }

  onHide(): void {
    this.shown = false;
    this.renderer.dispose();
  }

  private draw(): void {
    if (!this.sectionsEl) return;
    this.shown = true;
    this.renderer.render(this.sectionsEl);
  }
}
