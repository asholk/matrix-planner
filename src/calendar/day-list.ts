/**
 * Список дня вкладки «Календарь» (ТЗ §4.4; кадры 09, 13): заголовок «Сегодня 10 октября — 2 элемента»,
 * сообщение о покрытии кэша, пустой день, блоки «Весь день», по времени (шкала слева с цветной точкой)
 * и «Заметки». Модель строится чистыми функциями `calendar-state.ts`.
 */

import { setIcon } from 'obsidian';
import type { DayItem, QuadrantKey, TaskDayItem } from '../model/types';
import { t, tPlural } from '../i18n';
import { CALENDAR_MODEL_KEYS } from './day-items';
import type { DayListModel, DayListRow } from './calendar-state';

export interface CalendarItemHandlers {
  open(item: DayItem): void;
  toggle(item: TaskDayItem, rowEl: HTMLElement): void;
  isBusy(key: string): boolean;
}

export interface DayListContext {
  /** Подпись пустого дня: «Нажмите +» (мобильные) или «Выберите +» (компьютер). */
  isMobile: boolean;
  quadrantTitle(key: QuadrantKey): string;
  /** Значок квадранта (Lucide) для подписи задачи; по умолчанию — без значка. */
  quadrantIcon?(key: QuadrantKey): string | null;
  /** Название календаря события; `null` — не показывать. */
  calendarTitle(row: DayListRow): string | null;
  /** Кнопка «Подключить» в сообщении об отсутствии событий iOS (переход к настройкам). */
  connectCalendar?: (() => void) | null;
  handlers: CalendarItemHandlers;
}

/** Сообщения «нет кэша», к которым относится кнопка «Подключить». */
const CONNECT_NOTICE_KEYS: readonly string[] = ['cache.notice.noCache', CALENDAR_MODEL_KEYS.coverage['no-cache']];

/** Заголовок дня: «Сегодня  10 октября … 2 элемента». */
export function renderDayHeading(parent: HTMLElement, model: DayListModel): HTMLElement {
  const header = parent.createDiv({ cls: 'mp-cal-day-header' });
  const title = header.createEl('h3', { cls: 'mp-cal-day-title' });
  title.createSpan({ cls: 'mp-cal-day-name', text: model.heading.title });
  title.createSpan({ cls: 'mp-cal-day-date', text: model.heading.date });
  header.createSpan({ cls: 'mp-cal-day-count', text: tPlural(CALENDAR_MODEL_KEYS.itemCount, model.count) });
  return header;
}

/** Сообщение о покрытии кэша и пустой день — отдельными элементами. */
export function renderDayStatus(parent: HTMLElement, model: DayListModel, ctx: Pick<DayListContext, 'isMobile' | 'connectCalendar'>): void {
  if (model.noticeKey) {
    const notice = parent.createDiv({ cls: 'mp-cal-notice', attr: { role: 'note' } });
    notice.toggleClass('is-out-of-range', model.coverage === 'out-of-range');
    setIcon(notice.createSpan({ cls: 'mp-cal-notice-icon', attr: { 'aria-hidden': 'true' } }), 'calendar-x');
    notice.createSpan({ cls: 'mp-cal-notice-text', text: t(model.noticeKey) });
    const connect = ctx.connectCalendar;
    if (connect && CONNECT_NOTICE_KEYS.includes(model.noticeKey)) {
      const button = notice.createEl('button', {
        cls: 'mp-chip mp-cal-notice-action',
        text: t('calendar.day.connect'),
        attr: { type: 'button', 'aria-label': t('calendar.day.connectLabel') },
      });
      button.addEventListener('click', () => connect());
    }
  }
  if (model.empty) {
    const empty = parent.createDiv({ cls: 'mp-cal-empty' });
    setIcon(empty.createSpan({ cls: 'mp-cal-empty-icon', attr: { 'aria-hidden': 'true' } }), 'calendar-plus');
    empty.createSpan({ text: t(ctx.isMobile ? CALENDAR_MODEL_KEYS.emptyDay : CALENDAR_MODEL_KEYS.emptyDayDesktop) });
  }
}

/** Полный список дня (режимы «Список» и «Месяц»). */
export function renderDayList(parent: HTMLElement, model: DayListModel, ctx: DayListContext): HTMLElement {
  const section = parent.createEl('section', { cls: 'mp-cal-day', attr: { 'aria-label': t('calendar.day.label', { date: model.heading.date }) } });
  renderDayHeading(section, model);
  renderDayStatus(section, model, ctx);
  if (model.allDay.length + model.timed.length > 0) {
    const card = section.createDiv({ cls: 'mp-cal-day-card' });
    renderBlock(card, t(CALENDAR_MODEL_KEYS.allDayBlock), model.allDay, ctx, 'all-day');
    renderBlock(card, null, model.timed, ctx, 'timed');
  }
  renderNotesBlock(section, model, ctx);
  return section;
}

/** Блок «Заметки» (общий для списка и временной шкалы). */
export function renderNotesBlock(parent: HTMLElement, model: DayListModel, ctx: DayListContext): void {
  if (model.notes.length === 0) return;
  const card = parent.createDiv({ cls: 'mp-cal-day-card mp-cal-notes-card' });
  renderBlock(card, t(CALENDAR_MODEL_KEYS.notesBlock), model.notes, ctx, 'notes');
}

/** Блок «Весь день» отдельно (временная шкала). */
export function renderAllDayBlock(parent: HTMLElement, model: DayListModel, ctx: DayListContext): void {
  if (model.allDay.length === 0) return;
  const card = parent.createDiv({ cls: 'mp-cal-day-card mp-cal-allday-card' });
  renderBlock(card, t(CALENDAR_MODEL_KEYS.allDayBlock), model.allDay, ctx, 'all-day');
}

function renderBlock(parent: HTMLElement, title: string | null, rows: readonly DayListRow[], ctx: DayListContext, kind: 'all-day' | 'timed' | 'notes'): void {
  if (rows.length === 0) return;
  const block = parent.createDiv({ cls: ['mp-cal-block', `mp-cal-block-${kind}`] });
  if (title) block.createDiv({ cls: 'mp-cal-block-title', text: title });
  const list = block.createDiv({ cls: 'mp-cal-rows', attr: { role: 'list', 'aria-label': title ?? '' } });
  for (const row of rows) renderItemRow(list, row, ctx, kind === 'timed');
}

/** Строка элемента: время и точка слева (по времени), цветная плашка с кружком выполнения. */
export function renderItemRow(parent: HTMLElement, row: DayListRow, ctx: DayListContext, withRail: boolean): HTMLElement {
  const el = parent.createDiv({
    cls: ['mp-cal-row', `mp-cal-row-${row.source}`],
    attr: { role: 'listitem', 'data-key': row.key },
  });
  el.setCssProps({ '--mp-item-color': row.color });
  el.toggleClass('is-completed', row.completed);
  el.toggleClass('is-overdue', row.overdue);
  el.toggleClass('is-busy', ctx.handlers.isBusy(row.key));

  if (withRail) {
    el.addClass('has-rail');
    el.createDiv({ cls: 'mp-cal-row-time', text: row.timeLabel ?? '', attr: { 'aria-hidden': 'true' } });
    const rail = el.createDiv({ cls: 'mp-cal-row-rail', attr: { 'aria-hidden': 'true' } });
    rail.createSpan({ cls: 'mp-cal-row-dot' });
  }

  const card = el.createDiv({
    cls: 'mp-cal-row-card',
    attr: { role: 'button', tabindex: '0', 'aria-label': rowAriaLabel(row, ctx) },
  });
  card.createSpan({ cls: 'mp-cal-row-bar', attr: { 'aria-hidden': 'true' } });

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
  } else if (row.source === 'note') {
    setIcon(card.createSpan({ cls: 'mp-cal-row-kind', attr: { 'aria-hidden': 'true' } }), 'sticky-note');
  } else if (row.icon) {
    setIcon(card.createSpan({ cls: 'mp-cal-row-icon', attr: { 'aria-hidden': 'true' } }), row.icon);
  }

  const body = card.createDiv({ cls: 'mp-cal-row-body' });
  const titleEl = body.createDiv({ cls: 'mp-cal-row-title' });
  if (row.item.source === 'task' && row.item.priority === 'high') {
    setIcon(titleEl.createSpan({ cls: 'mp-cal-row-flag', attr: { 'aria-hidden': 'true' } }), 'flag');
  }
  titleEl.createSpan({ cls: 'mp-cal-row-title-text', text: row.title });

  const meta = metaParts(row, ctx);
  if (meta.length > 0 || row.recurring) {
    const metaEl = body.createDiv({ cls: 'mp-cal-row-meta', attr: { 'aria-hidden': 'true' } });
    meta.forEach((part, i) => {
      if (i > 0) metaEl.createSpan({ cls: 'mp-cal-row-sep', text: '·' });
      const span = metaEl.createSpan({ cls: 'mp-cal-row-meta-part' });
      if (part.icon) setIcon(span.createSpan({ cls: 'mp-cal-row-meta-icon' }), part.icon);
      span.createSpan({ text: part.text });
    });
    if (row.recurring) setIcon(metaEl.createSpan({ cls: 'mp-cal-row-meta-icon mp-cal-row-repeat' }), 'repeat');
  }

  const open = () => ctx.handlers.open(row.item);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (evt: KeyboardEvent) => {
    if (evt.target !== card) return;
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      open();
    }
  });
  return el;
}

/**
 * Подпись под названием (кадры 09, референс LockDay): задача — «[значок] квадрант · [календарь] Планировщик»,
 * событие — «[календарь] 9:00–10:00 · Календарь».
 */
export function metaParts(row: DayListRow, ctx: Pick<DayListContext, 'quadrantTitle' | 'quadrantIcon' | 'calendarTitle'>): Array<{ text: string; icon: string | null }> {
  const parts: Array<{ text: string; icon: string | null }> = [];
  if (row.source === 'note') return parts;
  const calendar = ctx.calendarTitle(row);
  if (row.quadrant) {
    parts.push({ text: ctx.quadrantTitle(row.quadrant), icon: ctx.quadrantIcon?.(row.quadrant) ?? null });
    if (calendar) parts.push({ text: calendar, icon: 'calendar' });
  } else {
    let leading = false;
    if (row.rangeLabel) {
      parts.push({ text: row.rangeLabel, icon: 'calendar' });
      leading = true;
    } else if (row.continues && row.allDay) {
      parts.push({ text: t('calendar.item.continues'), icon: 'calendar' });
      leading = true;
    }
    if (calendar) parts.push({ text: calendar, icon: leading ? null : 'calendar' });
  }
  if (row.readOnly) parts.push({ text: t('calendar.item.readOnly'), icon: 'eye' });
  return parts;
}

/** «Задача „Танцы“, 13:31, квадрант „Важно и срочно“, выполнена». */
export function rowAriaLabel(row: DayListRow, ctx: Pick<DayListContext, 'quadrantTitle' | 'calendarTitle'>): string {
  const kindKey = { task: 'calendar.item.task', event: 'calendar.item.event', external: 'calendar.item.external', note: 'calendar.item.note' }[row.source];
  const parts = [t(kindKey, { title: row.title })];
  if (row.rangeLabel) parts.push(row.rangeLabel);
  else if (row.timeLabel) parts.push(row.timeLabel);
  else if (row.allDay) parts.push(t('calendar.item.allDay'));
  if (row.quadrant) parts.push(ctx.quadrantTitle(row.quadrant));
  const calendar = ctx.calendarTitle(row);
  if (calendar) parts.push(calendar);
  if (row.recurring) parts.push(t('calendar.item.recurring'));
  if (row.checkable) parts.push(t(row.completed ? 'calendar.item.done' : 'calendar.item.notDone'));
  if (row.readOnly) parts.push(t('calendar.item.readOnly'));
  return parts.join(', ');
}
