/**
 * Карточка задачи (ТЗ §4.2, кадры 01, 07, 08): кружок цвета квадранта, `flag`
 * при высоком приоритете, название до 2 строк, относительный срок, `repeat`.
 * Только DOM; жесты и действия — обработчики вкладки.
 */

import { setIcon } from 'obsidian';
import { t } from '../i18n';
import { isMenuKey } from '../ui/controls/context-menu';
import { cardAriaLabel, type CardLabelStrings, type TaskCardModel } from './tasks-presenter';

export interface TaskCardOptions {
  /** Название квадранта карточки (для подписи диктора). */
  quadrantTitle: string;
  /** Маркер перетаскивания справа (мобильные, активный режим). */
  showHandle: boolean;
  /** Показывать точку квадранта (список по датам — карточки из разных квадрантов). */
  showQuadrantDot: boolean;
  /** Карточка в процессе операции (кнопки заблокированы). */
  busy: boolean;
}

export interface TaskCardHandlers {
  /** Кружок: выполнить или вернуть в работу. */
  onToggle(card: TaskCardModel, cardEl: HTMLElement): void;
  /** Нажатие на карточку: форма редактирования. */
  onOpen(card: TaskCardModel): void;
  /** Меню действий (ПКМ, кнопка действий, клавиатура). */
  onMenu(card: TaskCardModel, anchor: MouseEvent | HTMLElement): void;
  /** Начало жеста (перетаскивание, долгое нажатие). */
  onPointerDown(card: TaskCardModel, evt: PointerEvent, cardEl: HTMLElement, onHandle: boolean): void;
  /** `true` — этот click завершает жест и не должен открывать форму. */
  consumeClick(): boolean;
}

function labelStrings(): CardLabelStrings {
  return {
    label: (title) => t('tasks.card.label', { title }),
    quadrant: (quadrant) => t('tasks.card.quadrant', { quadrant }),
    highPriority: t('tasks.card.highPriority'),
    repeat: t('tasks.card.repeat'),
    overdue: t('tasks.card.overdue'),
    noDue: t('tasks.card.noDue'),
    notDone: t('tasks.card.notDone'),
    done: t('tasks.card.done'),
  };
}

export function renderTaskCard(
  parent: HTMLElement,
  card: TaskCardModel,
  options: TaskCardOptions,
  handlers: TaskCardHandlers,
): HTMLElement {
  const cardEl = parent.createDiv({
    cls: ['mp-task-card', `mp-q-${card.quadrant}`],
    attr: { role: 'listitem', 'data-card-key': card.key, 'data-task-id': card.taskId },
  });
  cardEl.toggleClass('is-done', card.done);
  cardEl.toggleClass('is-overdue', card.overdue);
  cardEl.toggleClass('is-busy', options.busy);

  // Кружок: выполнить / вернуть в работу.
  const toggle = cardEl.createEl('button', {
    cls: 'mp-task-check',
    attr: {
      type: 'button',
      'data-role': 'check',
      'aria-label': t(card.done ? 'tasks.card.uncomplete' : 'tasks.card.complete', { title: card.title }),
      'aria-pressed': card.done ? 'true' : 'false',
    },
  });
  toggle.disabled = options.busy;
  const mark = toggle.createSpan({ cls: 'mp-task-check-mark', attr: { 'aria-hidden': 'true' } });
  setIcon(mark, 'check');
  toggle.addEventListener('click', (evt) => {
    evt.stopPropagation();
    handlers.onToggle(card, cardEl);
  });

  // Основная часть: открыть форму.
  const main = cardEl.createEl('button', {
    cls: 'mp-task-main',
    attr: { type: 'button', 'data-role': 'main', 'aria-label': cardAriaLabel(card, options.quadrantTitle, labelStrings()) },
  });
  const titleRow = main.createDiv({ cls: 'mp-task-title-row', attr: { 'aria-hidden': 'true' } });
  if (options.showQuadrantDot) titleRow.createSpan({ cls: 'mp-task-dot' });
  if (card.highPriority) setIcon(titleRow.createSpan({ cls: 'mp-task-flag' }), 'flag');
  titleRow.createSpan({ cls: 'mp-task-title', text: card.title });

  const meta = card.done ? card.completedLabel : card.dueLabel;
  if (meta || card.recurring) {
    const metaRow = main.createDiv({ cls: 'mp-task-meta', attr: { 'aria-hidden': 'true' } });
    if (meta) metaRow.createSpan({ cls: 'mp-task-due', text: meta });
    if (card.recurring) setIcon(metaRow.createSpan({ cls: 'mp-task-repeat' }), 'repeat');
  }
  main.addEventListener('click', () => {
    if (handlers.consumeClick()) return;
    handlers.onOpen(card);
  });
  main.addEventListener('keydown', (evt) => {
    if (isMenuKey(evt)) {
      evt.preventDefault();
      handlers.onMenu(card, main);
    }
  });

  // Кнопка действий: доступ к меню без жестов (диктор, клавиатура).
  const more = cardEl.createEl('button', {
    cls: 'mp-task-more',
    attr: { type: 'button', 'data-role': 'more', 'aria-label': t('tasks.card.more', { title: card.title }), 'aria-haspopup': 'menu' },
  });
  setIcon(more, 'more-horizontal');
  more.addEventListener('click', (evt) => {
    evt.stopPropagation();
    handlers.onMenu(card, more);
  });

  if (options.showHandle) {
    const handle = cardEl.createDiv({
      cls: 'mp-task-handle',
      attr: { 'data-role': 'handle', 'aria-hidden': 'true', title: t('tasks.card.dragHandle') },
    });
    setIcon(handle, 'grip-vertical');
  }

  cardEl.addEventListener('contextmenu', (evt) => {
    evt.preventDefault();
    handlers.onMenu(card, evt);
  });
  cardEl.addEventListener('pointerdown', (evt) => {
    const target = evt.target as HTMLElement | null;
    const onHandle = Boolean(target?.closest?.('.mp-task-handle'));
    handlers.onPointerDown(card, evt, cardEl, onHandle);
  });

  return cardEl;
}
