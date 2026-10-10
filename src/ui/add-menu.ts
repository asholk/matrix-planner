/**
 * Меню «Добавить» (S1.T4, ТЗ §4.3): на мобильных — нижний лист с плитками
 * «Задача / Событие / Заметка» (кадр 10), на компьютере — `Menu`.
 * Выбранный день и квадрант из контекста «+» передаются в форму.
 */

import { Menu, Modal, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { AddContext, PlannerActions, PlatformInfo } from '../app/contracts';
import { registerDictionary, t } from '../i18n';
import { ruShell } from '../i18n/ru/shell';
import { enShell } from '../i18n/en/shell';
import { attachDragToClose } from './controls/form-sheet';

registerDictionary('ru', 'shell', ruShell);
registerDictionary('en', 'shell', enShell);

export type AddKind = 'task' | 'event' | 'note';

export interface AddMenuItem {
  kind: AddKind;
  /** Ключ i18n подписи. */
  labelKey: string;
  icon: string;
  available: boolean;
  run(): void;
}

const ITEM_ICONS: Record<AddKind, string> = {
  task: 'circle-check',
  event: 'calendar-plus',
  note: 'sticky-note',
};

/** Пункты меню с подстановкой контекста. Чистая функция — без DOM. */
export function buildAddMenuItems(actions: PlannerActions, context: AddContext): AddMenuItem[] {
  const date = context.date ?? null;
  return [
    {
      kind: 'task',
      labelKey: 'shell.add.task',
      icon: ITEM_ICONS.task,
      available: actions.isAvailable('task'),
      run: () => actions.openTaskForm({ mode: 'create', quadrant: context.quadrant ?? null, date }),
    },
    {
      kind: 'event',
      labelKey: 'shell.add.event',
      icon: ITEM_ICONS.event,
      available: actions.isAvailable('event'),
      run: () => actions.openEventForm({ mode: 'create', date }),
    },
    {
      kind: 'note',
      labelKey: 'shell.add.note',
      icon: ITEM_ICONS.note,
      available: actions.isAvailable('note'),
      run: () => actions.openNoteForm({ mode: 'create', date }),
    },
  ];
}

/** Нижний лист «Добавить» с тремя плитками. */
class AddSheet extends Modal {
  private detachDrag: (() => void) | null = null;

  constructor(
    app: App,
    private readonly items: AddMenuItem[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { modalEl, contentEl } = this;
    this.containerEl.addClass('mp-sheet-container');
    modalEl.addClasses(['mp-sheet', 'mp-sheet-bottom', 'mp-add-sheet']);
    modalEl.setAttr('role', 'dialog');
    modalEl.setAttr('aria-modal', 'true');
    modalEl.setAttr('aria-label', t('shell.add.title'));

    const header = createDiv({ cls: 'mp-sheet-header' });
    modalEl.insertBefore(header, contentEl);
    const grabber = header.createDiv({ cls: 'mp-sheet-grabber', attr: { 'aria-hidden': 'true' } });
    this.detachDrag = attachDragToClose(grabber, modalEl, () => this.close());
    header.createDiv({ cls: 'mp-add-sheet-title', text: t('shell.add.title') });

    contentEl.addClass('mp-sheet-body');
    const grid = contentEl.createDiv({ cls: 'mp-add-grid' });
    let first: HTMLButtonElement | null = null;
    for (const item of this.items) {
      const label = t(item.labelKey);
      const tile = grid.createEl('button', {
        cls: `mp-add-tile mp-add-tile-${item.kind}`,
        attr: { type: 'button', 'aria-label': item.available ? label : `${label}. ${t('shell.add.unavailable')}` },
      });
      tile.disabled = !item.available;
      tile.toggleClass('is-disabled', !item.available);
      setIcon(tile.createSpan({ cls: 'mp-add-tile-icon', attr: { 'aria-hidden': 'true' } }), item.icon);
      tile.createSpan({ cls: 'mp-add-tile-label', text: label });
      tile.addEventListener('click', () => {
        if (!item.available) return;
        this.close();
        item.run();
      });
      if (item.available && !first) first = tile;
    }
    first?.focus();
  }

  onClose(): void {
    this.detachDrag?.();
    this.detachDrag = null;
    this.contentEl.empty();
  }
}

function isMouseEvent(value: unknown): value is MouseEvent {
  return typeof MouseEvent !== 'undefined' && value instanceof MouseEvent;
}

function showDesktopMenu(items: AddMenuItem[], anchor?: MouseEvent | HTMLElement): void {
  const menu = new Menu();
  for (const item of items) {
    menu.addItem((menuItem) => {
      menuItem
        .setTitle(t(item.labelKey))
        .setIcon(item.icon)
        .setDisabled(!item.available)
        .onClick(() => item.run());
    });
  }
  // Клавиатура (Enter/пробел на «+») даёт MouseEvent с нулевыми координатами — тогда якорь по элементу.
  if (isMouseEvent(anchor) && (anchor.clientX !== 0 || anchor.clientY !== 0)) {
    menu.showAtMouseEvent(anchor);
    return;
  }
  const target = isMouseEvent(anchor) ? (anchor.currentTarget as HTMLElement | null) : (anchor ?? null);
  if (target && typeof target.getBoundingClientRect === 'function') {
    const rect = target.getBoundingClientRect();
    menu.showAtPosition({ x: rect.right, y: rect.top, left: true }, target.doc);
    return;
  }
  menu.showAtPosition({ x: 0, y: 0 });
}

export interface AddMenuDeps {
  app: App;
  platform: PlatformInfo;
  actions: PlannerActions;
}

/** Открыть меню «Добавить» для контекста. */
export function openAddMenu(deps: AddMenuDeps, context: AddContext, anchor?: MouseEvent | HTMLElement): void {
  const items = buildAddMenuItems(deps.actions, context);
  if (deps.platform.isMobile) new AddSheet(deps.app, items).open();
  else showDesktopMenu(items, anchor);
}

/**
 * Реализация `PlannerActions.openAddMenu` для сборки. `getActions` — ленивый доступ,
 * т. к. объект действий собирается вместе с этим методом.
 */
export function createAddMenuOpener(
  app: App,
  platform: PlatformInfo,
  getActions: () => PlannerActions,
): PlannerActions['openAddMenu'] {
  return (context, anchor) => openAddMenu({ app, platform, actions: getActions() }, context, anchor);
}
