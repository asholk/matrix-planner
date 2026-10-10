/**
 * Лента недели (ТЗ §4.4; кадры 09, 13): буква дня недели, число (сегодня — в круге,
 * выбранный день — заливкой), до 3 цветных точек, серая точка заметок и галочка выполненных.
 * Прокрутка: свайп (сенсор и перо), горизонтальное колесо, стрелки клавиатуры; на компьютере —
 * ещё кнопки предыдущей и следующей недели.
 */

import { setIcon } from 'obsidian';
import type { LocalDateString } from '../model/types';
import { t, tPlural } from '../i18n';
import { CALENDAR_MODEL_KEYS } from './day-items';
import { swipeDirection, type WeekCell } from './calendar-state';

/** Порог накопленного горизонтального колеса для смены недели. */
const WHEEL_THRESHOLD = 60;
/** Пауза между сменами недели колесом, мс. */
const WHEEL_COOLDOWN_MS = 350;

export interface WeekStripHandlers {
  select(date: LocalDateString): void;
  /** Сдвиг на `delta` недель. */
  shift(delta: number): void;
  /** Сдвиг выбранного дня на `days` (клавиатура). */
  move(days: number): void;
}

export interface WeekStripOptions {
  showArrows: boolean;
  /** Вернуть фокус выбранному дню после перерисовки. */
  focusSelected: boolean;
}

/** Отрисовывает ленту в `parent` (содержимое заменяется); обработчики живут на её элементах. */
export function renderWeekStrip(parent: HTMLElement, cells: readonly WeekCell[], handlers: WeekStripHandlers, options: WeekStripOptions): void {
  parent.empty();
  parent.addClass('mp-cal-week');

  if (options.showArrows) arrow(parent, 'chevron-left', t('calendar.header.prevWeek'), () => handlers.shift(-1));

  const strip = parent.createDiv({
    cls: 'mp-cal-week-days',
    attr: { role: 'listbox', 'aria-label': t('calendar.week.label'), 'aria-orientation': 'horizontal' },
  });

  let suppressClick = false;
  let focusEl: HTMLElement | null = null;
  for (const cell of cells) {
    const button = strip.createEl('button', {
      cls: 'mp-cal-week-day',
      attr: {
        type: 'button',
        role: 'option',
        'data-date': cell.date,
        'aria-selected': cell.isSelected ? 'true' : 'false',
        'aria-label': cellLabel(cell),
        tabindex: cell.isSelected ? '0' : '-1',
      },
    });
    if (cell.isToday) button.setAttr('aria-current', 'date');
    button.toggleClass('is-today', cell.isToday);
    button.toggleClass('is-selected', cell.isSelected);
    button.createSpan({ cls: 'mp-cal-week-weekday', text: cell.weekdayLabel, attr: { 'aria-hidden': 'true' } });
    button.createSpan({ cls: 'mp-cal-week-number', text: String(cell.dayOfMonth), attr: { 'aria-hidden': 'true' } });
    const marks = button.createSpan({ cls: 'mp-cal-week-marks', attr: { 'aria-hidden': 'true' } });
    for (const color of cell.dots) {
      const dot = marks.createSpan({ cls: 'mp-cal-dot' });
      dot.setCssProps({ '--mp-item-color': color });
    }
    if (cell.hasNotes) marks.createSpan({ cls: 'mp-cal-dot mp-cal-dot-note' });
    if (cell.hasCompleted) setIcon(marks.createSpan({ cls: 'mp-cal-week-check' }), 'check');
    button.addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      handlers.select(cell.date);
    });
    if (cell.isSelected) focusEl = button;
  }

  if (options.showArrows) arrow(parent, 'chevron-right', t('calendar.header.nextWeek'), () => handlers.shift(1));

  strip.addEventListener('keydown', (evt: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -7, PageDown: 7 };
    const days = step[evt.key];
    if (days === undefined) return;
    evt.preventDefault();
    handlers.move(days);
  });

  // Свайп: только сенсор и перо; мышь выбирает день обычным нажатием.
  let start: { id: number; x: number; y: number } | null = null;
  strip.addEventListener('pointerdown', (evt: PointerEvent) => {
    if (evt.pointerType === 'mouse') return;
    start = { id: evt.pointerId, x: evt.clientX, y: evt.clientY };
  });
  strip.addEventListener('pointerup', (evt: PointerEvent) => {
    if (!start || evt.pointerId !== start.id) return;
    const direction = swipeDirection(evt.clientX - start.x, evt.clientY - start.y);
    start = null;
    if (direction === 0) return;
    suppressClick = true;
    window.setTimeout(() => (suppressClick = false), 0);
    handlers.shift(direction);
  });
  strip.addEventListener('pointercancel', () => (start = null));

  let wheel = 0;
  let lastWheelShift = 0;
  strip.addEventListener(
    'wheel',
    (evt: WheelEvent) => {
      if (Math.abs(evt.deltaX) <= Math.abs(evt.deltaY)) return;
      evt.preventDefault();
      wheel += evt.deltaX;
      const now = Date.now();
      if (Math.abs(wheel) < WHEEL_THRESHOLD || now - lastWheelShift < WHEEL_COOLDOWN_MS) return;
      lastWheelShift = now;
      const delta = wheel > 0 ? 1 : -1;
      wheel = 0;
      handlers.shift(delta);
    },
    { passive: false },
  );

  if (options.focusSelected && focusEl) (focusEl).focus({ preventScroll: true });
}

function arrow(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
  const button = parent.createEl('button', {
    cls: 'mp-icon-button mp-cal-week-arrow',
    attr: { type: 'button', 'aria-label': label, title: label },
  });
  setIcon(button, icon);
  button.addEventListener('click', onClick);
}

function cellLabel(cell: WeekCell): string {
  const parts = [cell.fullLabel];
  if (cell.isToday) parts.push(t('calendar.week.today'));
  if (cell.count > 0) parts.push(tPlural(CALENDAR_MODEL_KEYS.itemCount, cell.count));
  if (cell.hasCompleted) parts.push(t('calendar.week.completed'));
  if (cell.hasNotes) parts.push(t('calendar.week.notes'));
  return parts.join(', ');
}
