/**
 * Панель навигации мобильного Obsidian (доработка 008).
 *
 * Пока на телефоне активен Планировщик, плавающая панель навигации Obsidian скрыта, а панель
 * вкладок плагина стоит у нижнего края экрана. Главное меню Obsidian открывается кнопкой «Меню»
 * на панели вкладок. Панель скрывается через `visibility`, а не `display: none`: с `display: none`
 * Obsidian не открывает меню навигации (`showRibbonMenu`).
 */

import type { App, WorkspaceLeaf } from 'obsidian';

/** Класс `body`, пока панель навигации Obsidian скрыта ради Планировщика. */
export const NAVBAR_HIDDEN_CLASS = 'mp-hides-mobile-navbar';

interface MobileNavbarLike {
  showRibbonMenu?: (evt: MouseEvent) => void;
}

interface AppWithNavbar {
  mobileNavbar?: MobileNavbarLike | null;
  commands?: { executeCommandById?(id: string): boolean };
}

/**
 * Открывает главное меню Obsidian: меню панели навигации на телефоне, иначе — палитру команд.
 * `false` — ни то ни другое недоступно.
 */
export function openObsidianMenu(app: App, evt: MouseEvent): boolean {
  const host = app as unknown as AppWithNavbar;
  const navbar = host.mobileNavbar;
  if (navbar && typeof navbar.showRibbonMenu === 'function') {
    try {
      navbar.showRibbonMenu(evt);
      return true;
    } catch (error) {
      console.error('[matrix-planner] cannot open Obsidian menu', error);
    }
  }
  try {
    return host.commands?.executeCommandById?.('command-palette:open') === true;
  } catch (error) {
    console.error('[matrix-planner] cannot open command palette', error);
    return false;
  }
}

/** Есть ли у Obsidian меню панели навигации (мобильное приложение). */
export function hasObsidianNavbarMenu(app: App): boolean {
  return typeof (app as unknown as AppWithNavbar).mobileNavbar?.showRibbonMenu === 'function';
}

/**
 * Скрывает панель навигации Obsidian, пока активен вид `viewType`. Возвращает отписку
 * (класс снимается).
 */
export function watchNavbarForPlanner(app: App, viewType: string, target?: HTMLElement): () => void {
  const body = target ?? (typeof activeDocument === 'undefined' ? null : activeDocument.body);
  if (!body) return () => undefined;
  const update = (leaf?: WorkspaceLeaf | null): void => {
    const view = (leaf ?? app.workspace.getMostRecentLeaf())?.view;
    body.toggleClass(NAVBAR_HIDDEN_CLASS, view?.getViewType() === viewType);
  };
  const refs = [
    app.workspace.on('active-leaf-change', (leaf) => update(leaf)),
    app.workspace.on('layout-change', () => update()),
  ];
  app.workspace.onLayoutReady(() => update());
  return () => {
    for (const ref of refs) app.workspace.offref(ref);
    body.removeClass(NAVBAR_HIDDEN_CLASS);
  };
}
