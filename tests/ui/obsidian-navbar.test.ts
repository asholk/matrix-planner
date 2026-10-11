import { describe, expect, it, vi } from 'vitest';
import { App, ItemView, MockElement, WorkspaceLeaf } from '../__mocks__/obsidian';
import type { App as ObsidianApp } from 'obsidian';
import { NAVBAR_HIDDEN_CLASS, hasObsidianNavbarMenu, openObsidianMenu, watchNavbarForPlanner } from '../../src/ui/obsidian-navbar';

class StubView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly type: string,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return this.type;
  }

  getDisplayText(): string {
    return this.type;
  }
}

function leafWith(app: App, type: string): WorkspaceLeaf {
  const leaf = app.workspace.getLeaf();
  leaf.view = new StubView(leaf, type);
  return leaf;
}

const asApp = (app: unknown): ObsidianApp => app as ObsidianApp;

describe('главное меню Obsidian на панели вкладок (008)', () => {
  it('на телефоне открывает меню панели навигации Obsidian с событием нажатия', () => {
    const showRibbonMenu = vi.fn();
    const executeCommandById = vi.fn(() => true);
    const app = { mobileNavbar: { showRibbonMenu }, commands: { executeCommandById } };
    const evt = { type: 'click' } as MouseEvent;
    expect(hasObsidianNavbarMenu(asApp(app))).toBe(true);
    expect(openObsidianMenu(asApp(app), evt)).toBe(true);
    expect(showRibbonMenu).toHaveBeenCalledWith(evt);
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it('без панели навигации (компьютер) или при её ошибке — палитра команд', () => {
    const executeCommandById = vi.fn(() => true);
    expect(hasObsidianNavbarMenu(asApp({ commands: { executeCommandById } }))).toBe(false);
    expect(openObsidianMenu(asApp({ commands: { executeCommandById } }), {} as MouseEvent)).toBe(true);
    expect(executeCommandById).toHaveBeenCalledWith('command-palette:open');

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = {
      mobileNavbar: {
        showRibbonMenu: () => {
          throw new Error('api changed');
        },
      },
      commands: { executeCommandById },
    };
    expect(openObsidianMenu(asApp(broken), {} as MouseEvent)).toBe(true);
    expect(executeCommandById).toHaveBeenCalledTimes(2);
  });

  it('ничего не доступно — false', () => {
    expect(openObsidianMenu(asApp({}), {} as MouseEvent)).toBe(false);
  });
});

describe('панель навигации Obsidian скрыта, пока активен Планировщик (008)', () => {
  it('класс на body следует за активной вкладкой и снимается при выгрузке', () => {
    const app = new App();
    const body = new MockElement('body') as unknown as HTMLElement;
    const planner = leafWith(app, 'matrix-planner');
    const note = leafWith(app, 'markdown');
    app.workspace.setActiveLeaf(planner);

    const stop = watchNavbarForPlanner(asApp(app), 'matrix-planner', body);
    expect(body.hasClass(NAVBAR_HIDDEN_CLASS)).toBe(true);

    app.workspace.setActiveLeaf(note);
    expect(body.hasClass(NAVBAR_HIDDEN_CLASS)).toBe(false);

    app.workspace.setActiveLeaf(planner);
    expect(body.hasClass(NAVBAR_HIDDEN_CLASS)).toBe(true);

    stop();
    expect(body.hasClass(NAVBAR_HIDDEN_CLASS)).toBe(false);
    app.workspace.setActiveLeaf(planner);
    expect(body.hasClass(NAVBAR_HIDDEN_CLASS)).toBe(false);
  });
});
