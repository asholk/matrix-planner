/**
 * Режим «Месяц» (ТЗ §4.4; кадр 15): сетка 4–6 недель, плашки элементов (многодневные —
 * через несколько дней), «+N» при переполнении, серая точка заметок. Раскладка — `layoutMonth`.
 * Нажатие на день выбирает его (список дня — под сеткой), на плашку — открывает элемент.
 */

import { setIcon } from 'obsidian';
import type { DayItem, LocalDateString } from '../model/types';
import { t } from '../i18n';
import { CALENDAR_MODEL_KEYS } from './day-items';
import type { MonthLayout } from './month-layout';
import { fullDateLabel, itemColorCss, swipeDirection, weekdayNarrow, weekdayShort } from './calendar-state';

export interface MonthViewHandlers {
  select(date: LocalDateString): void;
  open(item: DayItem): void;
  move(days: number): void;
  /** Сдвиг на `delta` месяцев (свайп). */
  shift(delta: number): void;
}

export interface MonthViewOptions {
  language: string;
  maxBars: number;
  title: string;
  focusSelected: boolean;
}

export function renderMonthView(parent: HTMLElement, layout: MonthLayout, handlers: MonthViewHandlers, options: MonthViewOptions): HTMLElement {
  const grid = parent.createDiv({ cls: 'mp-cal-month', attr: { role: 'grid', 'aria-label': t('calendar.month.label', { value: options.title }) } });
  grid.setCssProps({ '--mp-cal-bars': String(options.maxBars) });

  const head = grid.createDiv({ cls: 'mp-cal-month-head', attr: { role: 'row' } });
  for (const date of layout.weeks[0]?.dates ?? []) {
    head.createDiv({
      cls: 'mp-cal-month-weekday',
      text: weekdayNarrow(options.language, date),
      attr: { role: 'columnheader', 'aria-label': weekdayShort(options.language, date) },
    });
  }

  let focusEl: HTMLElement | null = null;
  let suppressClick = false;
  for (const week of layout.weeks) {
    const row = grid.createDiv({ cls: 'mp-cal-month-week', attr: { role: 'row' } });
    week.cells.forEach((cell, col) => {
      const labelParts = [fullDateLabel(options.language, cell.date)];
      if (cell.isToday) labelParts.push(t('calendar.week.today'));
      if (cell.hasNotes) labelParts.push(t('calendar.week.notes'));
      if (cell.more > 0) labelParts.push(t('calendar.month.more', { count: cell.more }));
      const button = row.createEl('button', {
        cls: 'mp-cal-month-day',
        attr: {
          type: 'button',
          role: 'gridcell',
          'data-date': cell.date,
          'aria-label': labelParts.join(', '),
          'aria-selected': cell.isSelected ? 'true' : 'false',
          tabindex: cell.isSelected ? '0' : '-1',
        },
      });
      button.setCssProps({ '--mp-cal-col': String(col + 1) });
      if (cell.isToday) button.setAttr('aria-current', 'date');
      button.toggleClass('is-today', cell.isToday);
      button.toggleClass('is-selected', cell.isSelected);
      button.toggleClass('is-outside', !cell.inMonth);
      const top = button.createSpan({ cls: 'mp-cal-month-top', attr: { 'aria-hidden': 'true' } });
      top.createSpan({ cls: 'mp-cal-month-number', text: String(cell.dayOfMonth) });
      if (cell.hasNotes) top.createSpan({ cls: 'mp-cal-dot mp-cal-dot-note' });
      if (cell.more > 0) {
        button.createSpan({ cls: 'mp-cal-month-more', text: t(CALENDAR_MODEL_KEYS.more, { count: cell.more }), attr: { 'aria-hidden': 'true' } });
      }
      button.addEventListener('click', () => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        handlers.select(cell.date);
      });
      if (cell.isSelected) focusEl = button;
    });

    for (const bar of week.bars) {
      const item = bar.item;
      const el = row.createEl('button', {
        cls: ['mp-cal-month-bar', `mp-cal-row-${item.source}`],
        attr: { type: 'button', tabindex: '-1', 'aria-label': item.title, title: item.title },
      });
      el.setCssProps({ '--mp-item-color': itemColorCss(item) });
      el.setCssProps({ '--mp-cal-col': String(bar.startCol + 1) });
      el.setCssProps({ '--mp-cal-span': String(bar.span) });
      el.setCssProps({ '--mp-cal-lane': String(bar.lane + 2) });
      el.toggleClass('continues-before', bar.continuesBefore);
      el.toggleClass('continues-after', bar.continuesAfter);
      const completed = item.source === 'task' && item.completed;
      el.toggleClass('is-completed', completed);
      if (item.source === 'task') setIcon(el.createSpan({ cls: 'mp-cal-month-bar-mark', attr: { 'aria-hidden': 'true' } }), completed ? 'check' : 'circle');
      el.createSpan({ cls: 'mp-cal-month-bar-title', text: item.title });
      el.addEventListener('click', (evt) => {
        evt.stopPropagation();
        handlers.open(item);
      });
    }
  }

  grid.addEventListener('keydown', (evt: KeyboardEvent) => {
    if (!(evt.target as HTMLElement | null)?.hasClass?.('mp-cal-month-day')) return;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const days = step[evt.key];
    if (days === undefined) return;
    evt.preventDefault();
    handlers.move(days);
  });

  // Свайп сетки (сенсор): влево — следующий месяц.
  let start: { id: number; x: number; y: number } | null = null;
  grid.addEventListener('pointerdown', (evt: PointerEvent) => {
    if (evt.pointerType !== 'mouse') start = { id: evt.pointerId, x: evt.clientX, y: evt.clientY };
  });
  grid.addEventListener('pointerup', (evt: PointerEvent) => {
    if (!start || start.id !== evt.pointerId) return;
    const direction = swipeDirection(evt.clientX - start.x, evt.clientY - start.y, 60);
    start = null;
    if (direction === 0) return;
    suppressClick = true;
    window.setTimeout(() => (suppressClick = false), 0);
    handlers.shift(direction);
  });
  grid.addEventListener('pointercancel', () => (start = null));

  if (options.focusSelected && focusEl) (focusEl as HTMLElement).focus({ preventScroll: true });
  return grid;
}
