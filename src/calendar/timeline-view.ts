/**
 * Режим «Временная шкала» (ТЗ §4.4): блок «Весь день», сутки по часам с блоками элементов
 * (перекрытия — колонками из `layoutTimeline`), линия «Сейчас» для сегодняшнего дня, блок «Заметки».
 * Высота часа — CSS-переменная `--mp-cal-hour`, положение блоков — проценты суток.
 */

import { setIcon } from 'obsidian';
import { t } from '../i18n';
import { layoutTimeline, MINUTES_PER_DAY } from './timeline-layout';
import {
  initialScrollMinute,
  minuteLabel,
  timelineGeometry,
  type CalendarLabelStrings,
  type DayListModel,
  type DayListRow,
} from './calendar-state';
import { renderAllDayBlock, renderDayHeading, renderDayStatus, renderNotesBlock, rowAriaLabel, type DayListContext } from './day-list';

export interface TimelineOptions {
  /** Текущая минута, если показан сегодняшний день. */
  nowMinute: number | null;
  strings: Pick<CalendarLabelStrings, 'hour12' | 'am' | 'pm'>;
  /** Прокрутка шкалы с прошлой отрисовки того же дня; `null` — начальная. */
  scrollTop: number | null;
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

  const open = () => ctx.handlers.open(row.item);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (evt: KeyboardEvent) => {
    if (evt.target !== card) return;
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      open();
    }
  });
}
