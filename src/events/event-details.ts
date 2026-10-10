/**
 * Просмотр события «Календаря» iOS из `calendar-cache.json` (ТЗ §4.4, §5.4.1): только чтение.
 * Событие, связанное с заметкой-событием (`linkedItemId`), открывается формой этой заметки.
 */

import { setIcon } from 'obsidian';
import type { PlannerServices, SheetHandle } from '../app/contracts';
import type { CachedCalendar, CachedCalendarEvent, CalendarCacheState, ItemId, Language } from '../model/types';
import { createDateLabelStrings, formatTimeLabel } from '../model/dates';
import { t, registerDictionary } from '../i18n';
import { ruModel } from '../i18n/ru/model';
import { enModel } from '../i18n/en/model';
import { shortDateLabel } from '../ui/controls/date-picker';
import { inclusiveEndDate } from './event-draft';
import { registerEventDictionaries } from './event-service';

registerEventDictionaries();
registerDictionary('ru', 'model', ruModel);
registerDictionary('en', 'model', enModel);

export type EventDetailsDeps = Pick<PlannerServices, 'calendarCache' | 'index' | 'sheets' | 'format' | 'notifier'>;

export interface EventDetailsOptions {
  /** Открыть форму связанной заметки-события. */
  openLinked?(id: ItemId): void;
}

/** Повторение из кэша по ключу; `null` — кэша нет или повторение не найдено. */
export function findCachedEvent(state: CalendarCacheState, occurrenceKey: string): CachedCalendarEvent | null {
  if (state.status !== 'ok') return null;
  return state.data.events.find((event) => event.occurrenceKey === occurrenceKey) ?? null;
}

/** Подпись времени события: «21 окт. 2026 г., 09:00 – 10:00», для «Весь день» — даты включительно. */
export function formatEventRange(
  event: Pick<CachedCalendarEvent, 'allDay' | 'start' | 'end'>,
  language: Language,
  hour12: boolean,
  strings: { am: string; pm: string; allDay: string },
): string {
  const date = (value: string) => shortDateLabel(language, value);
  if (event.allDay) {
    const last = inclusiveEndDate(event.start.date, event.end.date);
    return last === event.start.date ? `${date(event.start.date)} · ${strings.allDay}` : `${date(event.start.date)} – ${date(last)}`;
  }
  const time = (value: string | null) => (value === null ? '' : formatTimeLabel(value, hour12, strings));
  if (event.start.date === event.end.date) {
    return `${date(event.start.date)}, ${time(event.start.time)} – ${time(event.end.time)}`;
  }
  return `${date(event.start.date)}, ${time(event.start.time)} – ${date(event.end.date)}, ${time(event.end.time)}`;
}

/** Открывает просмотр. Неизвестный ключ — уведомление и `null`. */
export function openExternalEventDetails(deps: EventDetailsDeps, occurrenceKey: string, options: EventDetailsOptions = {}): SheetHandle | null {
  const event = findCachedEvent(deps.calendarCache.getState(), occurrenceKey);
  if (!event) {
    deps.notifier.show(t('events.errors.externalNotFound'));
    return null;
  }
  const linked = event.linkedItemId ? deps.index.getById(event.linkedItemId) : undefined;
  if (linked && linked.kind === 'event' && options.openLinked) {
    options.openLinked(linked.id);
    return null;
  }
  const calendar = deps.calendarCache.getCalendars().find((c) => c.calendarId === event.calendarId) ?? null;
  return deps.sheets.open({
    title: t('events.titleView'),
    submitLabel: null,
    fullScreenOnPhone: false,
    render: (contentEl) => renderDetails(contentEl, deps, event, calendar),
  });
}

function renderDetails(contentEl: HTMLElement, deps: EventDetailsDeps, event: CachedCalendarEvent, calendar: CachedCalendar | null): void {
  contentEl.addClass('mp-event-details');
  const format = deps.format.get();
  const strings = createDateLabelStrings(t);

  const head = contentEl.createDiv({ cls: 'mp-form-card mp-event-details-head' });
  head.createEl('h3', { cls: 'mp-event-details-title', text: event.title });
  head.createDiv({
    cls: 'mp-event-details-range',
    text: formatEventRange(event, format.language, format.hour12, { am: strings.am, pm: strings.pm, allDay: t('events.allDayRange') }),
  });
  if (event.recurrenceText) line(head, 'repeat', event.recurrenceText);

  const info = contentEl.createDiv({ cls: 'mp-form-card' });
  const calendarRow = line(info, 'calendar', calendar?.title ?? t('events.unknownCalendar'), t('events.fields.calendar'));
  const dot = createSpan({ cls: 'mp-event-calendar-dot', attr: { 'aria-hidden': 'true' } });
  dot.setCssProps({ '--mp-calendar-color': calendar?.color ?? 'var(--text-faint)' });
  calendarRow.prepend(dot);
  if (event.location) line(info, 'map-pin', event.location, t('events.fields.location'));
  if (event.url) {
    const row = line(info, 'link', '', t('events.fields.url'));
    row.createEl('a', { cls: 'external-link', text: event.url, href: event.url, attr: { target: '_blank', rel: 'noopener' } });
  }
  if (event.notes) {
    const notes = contentEl.createDiv({ cls: 'mp-form-card mp-event-details-notes' });
    notes.createDiv({ cls: 'mp-event-details-label', text: t('events.fields.notes') });
    notes.createDiv({ cls: 'mp-event-details-notes-text', text: event.notes });
  }
  if (!calendar?.allowsModifications) {
    contentEl.createDiv({ cls: 'mp-task-form-hint mp-event-details-hint', text: t('events.readOnly') });
  }
}

/** Строка «значок + текст»; возвращает контейнер значения. */
function line(parent: HTMLElement, icon: string, text: string, label?: string): HTMLElement {
  const row = parent.createDiv({ cls: 'mp-form-row mp-event-details-row' });
  setIcon(row.createSpan({ cls: 'mp-form-row-icon', attr: { 'aria-hidden': 'true' } }), icon);
  if (label) row.createSpan({ cls: 'mp-event-sr-only', text: label });
  const value = row.createDiv({ cls: 'mp-event-details-value' });
  if (text) value.setText(text);
  return value;
}
