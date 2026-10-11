/**
 * Режим «Временная шкала» (ТЗ §4.4): блок «Весь день», сутки по часам с блоками элементов
 * (перекрытия — колонками из `layoutTimeline`), линия «Сейчас» для сегодняшнего дня, блок «Заметки».
 * Высота часа — CSS-переменная `--mp-cal-hour`, положение блоков — проценты суток.
 */

import { setIcon } from 'obsidian';
import { t } from '../i18n';
import { layoutTimeline, MINUTES_PER_DAY, timelineMinuteAt } from './timeline-layout';
import {
  initialScrollMinute,
  minuteLabel,
  timelineGeometry,
  type CalendarLabelStrings,
  type DayListModel,
  type DayListRow,
} from './calendar-state';
import { bindItemActions, renderAllDayBlock, renderDayHeading, renderDayStatus, renderNotesBlock, rowAriaLabel, type DayListContext } from './day-list';

export interface TimelineOptions {
  /** Текущая минута, если показан сегодняшний день. */
  nowMinute: number | null;
  strings: Pick<CalendarLabelStrings, 'hour12' | 'am' | 'pm'>;
  /** Прокрутка шкалы с прошлой отрисовки того же дня; `null` — начальная. */
  scrollTop: number | null;
  /**
   * Долгое нажатие на пустом месте шкалы (доработка 006, §13): минута начала нового события
   * (округлена до 15 мин). Прокрутка и сдвиг пальца отменяют нажатие.
   */
  onLongPressEmpty?: ((minute: number) => void) | null;
}

/** Задержка долгого нажатия на пустом месте шкалы, мс. */
export const TIMELINE_LONG_PRESS_MS = 500;
/** Сдвиг пальца, после которого нажатие считается прокруткой, px. */
const LONG_PRESS_SLOP_PX = 8;

/**
 * Долгое нажатие на пустом месте сетки: блоки элементов не считаются, прокрутка шкалы, сдвиг
 * пальца, отпускание и отмена указателя сбрасывают таймер.
 */
export function attachTimelineLongPress(
  scroller: HTMLElement,
  grid: HTMLElement,
  onLongPress: (minute: number) => void,
  timers: { set(callback: () => void, ms: number): number; clear(id: number): void } = {
    set: (callback, ms) => window.setTimeout(callback, ms),
    clear: (id) => window.clearTimeout(id),
  },
): () => void {
  let timer: number | null = null;
  let start: { x: number; y: number } | null = null;
  const cancel = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    start = null;
  };
  const down = (evt: PointerEvent): void => {
    if (evt.button !== 0) return;
    const target = evt.target as HTMLElement | null;
    if (target?.closest?.('.mp-cal-timeline-block')) return;
    cancel();
    start = { x: evt.clientX, y: evt.clientY };
    const clientY = evt.clientY;
    timer = timers.set(() => {
      timer = null;
      start = null;
      const rect = grid.getBoundingClientRect();
      onLongPress(timelineMinuteAt(clientY - rect.top, rect.height));
    }, TIMELINE_LONG_PRESS_MS);
  };
  const move = (evt: PointerEvent): void => {
    if (!start) return;
    if (Math.abs(evt.clientX - start.x) > LONG_PRESS_SLOP_PX || Math.abs(evt.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
  };
  // Системное меню долгого нажатия на пустом месте не нужно.
  const context = (evt: MouseEvent): void => {
    const target = evt.target as HTMLElement | null;
    if (!target?.closest?.('.mp-cal-timeline-block')) evt.preventDefault();
  };
  grid.addEventListener('pointerdown', down);
  grid.addEventListener('pointermove', move);
  grid.addEventListener('pointerup', cancel);
  grid.addEventListener('pointercancel', cancel);
  grid.addEventListener('pointerleave', cancel);
  grid.addEventListener('contextmenu', context);
  scroller.addEventListener('scroll', cancel);
  return () => {
    cancel();
    grid.removeEventListener('pointerdown', down);
    grid.removeEventListener('pointermove', move);
    grid.removeEventListener('pointerup', cancel);
    grid.removeEventListener('pointercancel', cancel);
    grid.removeEventListener('pointerleave', cancel);
    grid.removeEventListener('contextmenu', context);
    scroller.removeEventListener('scroll', cancel);
  };
}

/** Возвращает прокручиваемый элемент шкалы (вкладка сохраняет его прокрутку). */
export function renderTimeline(parent: HTMLElement, model: DayListModel, ctx: DayListContext, options: TimelineOptions): HTMLElement {
  const section = parent.createEl('section', { cls: 'mp-cal-day mp-cal-timeline-day', attr: { 'aria-label': t('calendar.timeline.label') } });
  renderDayHeading(section, model);
  renderDayStatus(section, model, ctx);
  renderAllDayBlock(section, model, ctx);

  const scroller = section.createDiv({ cls: 'mp-cal-timeline', attr: { tabindex: '0', 'aria-label': t('calendar.timeline.label') } });
  const grid = scroller.createDiv({ cls: 'mp-cal-timeline-grid' });
  for (let hour = 0; hour < 24; hour++) {
    const line = grid.createDiv({ cls: 'mp-cal-timeline-hour', attr: { 'aria-hidden': 'true' } });
    line.setCssProps({ '--mp-cal-top': `${(hour / 24) * 100}%` });
    if (hour > 0) line.createSpan({ cls: 'mp-cal-timeline-hour-label', text: minuteLabel(hour * 60, options.strings) });
  }

  const lane = grid.createDiv({ cls: 'mp-cal-timeline-lane', attr: { role: 'list' } });
  const rows = new Map<string, DayListRow>(model.timed.map((row) => [row.key, row]));
  for (const block of layoutTimeline(model.timed.map((row) => row.item))) {
    const row = rows.get(block.item.key);
    if (!row) continue;
    renderBlock(lane, row, timelineGeometry(block), block.endMinute - block.startMinute, ctx);
  }

  if (options.onLongPressEmpty) {
    scroller.setAttr('aria-description', t('calendar.timeline.newEventHint'));
    grid.addClass('is-pressable');
    attachTimelineLongPress(scroller, grid, options.onLongPressEmpty);
  }

  if (options.nowMinute !== null) {
    const now = grid.createDiv({ cls: 'mp-cal-timeline-now', attr: { 'aria-label': t('calendar.timeline.now') } });
    now.setCssProps({ '--mp-cal-top': `${(options.nowMinute / MINUTES_PER_DAY) * 100}%` });
  }

  renderNotesBlock(section, model, ctx);

  // Начальная прокрутка: к «сейчас», первому событию или 8:00.
  const target = options.scrollTop ?? (initialScrollMinute(model.timed.map((row) => row.item), options.nowMinute) / MINUTES_PER_DAY) * grid.scrollHeight;
  scroller.scrollTop = target;
  return scroller;
}

function renderBlock(
  parent: HTMLElement,
  row: DayListRow,
  geometry: ReturnType<typeof timelineGeometry>,
  minutes: number,
  ctx: DayListContext,
): void {
  const el = parent.createDiv({
    cls: ['mp-cal-timeline-block', `mp-cal-row-${row.source}`],
    attr: { role: 'listitem', 'data-key': row.key },
  });
  el.setCssProps({ '--mp-item-color': row.color });
  el.setCssProps({ '--mp-cal-top': `${geometry.top}%` });
  el.setCssProps({ '--mp-cal-height': `${geometry.height}%` });
  el.setCssProps({ '--mp-cal-left': `${geometry.left}%` });
  el.setCssProps({ '--mp-cal-width': `${geometry.width}%` });
  el.toggleClass('is-completed', row.completed);
  el.toggleClass('is-short', minutes < 45);

  const card = el.createDiv({ cls: 'mp-cal-timeline-card', attr: { role: 'button', tabindex: '0', 'aria-label': rowAriaLabel(row, ctx) } });
  if (row.checkable && row.item.source === 'task') {
    const item = row.item;
    const label = t(row.completed ? 'calendar.item.uncomplete' : 'calendar.item.complete', { title: row.title });
    const check = card.createEl('button', {
      cls: 'mp-cal-check',
      attr: { type: 'button', 'aria-label': label, title: label, 'aria-pressed': row.completed ? 'true' : 'false' },
    });
    if (row.completed) setIcon(check, 'check');
    check.addEventListener('click', (evt) => {
      evt.stopPropagation();
      if (!ctx.handlers.isBusy(row.key)) ctx.handlers.toggle(item, el);
    });
  }
  const body = card.createDiv({ cls: 'mp-cal-timeline-body' });
  body.createDiv({ cls: 'mp-cal-timeline-title', text: row.title });
  const time = row.rangeLabel ?? row.timeLabel;
  if (time) body.createDiv({ cls: 'mp-cal-timeline-time', text: time, attr: { 'aria-hidden': 'true' } });

  bindItemActions(card, row.item, ctx, '.mp-cal-check');
}
