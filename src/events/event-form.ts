/**
 * Форма события (ТЗ §4.3, кадры 11–12): лист `SheetPresenter`, выбор даты `DatePickerFactory`.
 *
 * Карточки: значок + название, заметки, URL; «Весь день», «Начало», «Конец», «Повтор»;
 * «Цвет» (8 цветов) и «Календарь» (только разрешающие запись, без компаньона — «Планировщик»).
 * При правке — кнопка удаления (с подтверждением повторным нажатием). Правка меняет всю серию.
 * Состояние и правила — в `event-draft.ts`; общие классы полей — из формы задачи.
 */

import { Menu, ToggleComponent, setIcon } from 'obsidian';
import type { CalendarOption, EventFormRequest, PlannerServices, SheetHandle } from '../app/contracts';
import type { EventColor, PlannerError, PlannerEvent, RepeatRule } from '../model/types';
import { floatingFromDate } from '../model/dates';
import { registerDictionary, t } from '../i18n';
import { ruModel } from '../i18n/ru/model';
import { enModel } from '../i18n/en/model';
import { shortDateLabel } from '../ui/controls/date-picker';
import { registerEventDictionaries } from './event-service';
import { openExternalEventDetails } from './event-details';
import {
  EVENT_COLOR_OPTIONS,
  EVENT_ICON_OPTIONS,
  EVENT_REPEAT_OPTIONS,
  EventDraftController,
  createEventDraftState,
  draftStateFromEvent,
  setAllDay,
  setBody,
  setCalendar,
  setColor,
  setEnd,
  setIconName,
  setLoadedBody,
  setRepeat,
  setStart,
  setTitle,
  setUrl,
  validateEventDraft,
  type EventDraftState,
} from './event-draft';

registerEventDictionaries();
// Названия повторов; повторная регистрация словаря модуля безвредна.
registerDictionary('ru', 'model', ruModel);
registerDictionary('en', 'model', enModel);

export type EventFormDeps = Pick<
  PlannerServices,
  'events' | 'index' | 'repository' | 'sheets' | 'datePicker' | 'clock' | 'format' | 'notifier' | 'settings' | 'calendarCache'
>;

export interface EventFormOptions {
  /** После успешного сохранения (созданное событие или `null` при правке). */
  onSaved?(event: PlannerEvent | null): void;
  /** После удаления события. */
  onDeleted?(id: string): void;
}

/** CSS-цвет палитры события (переменные определены в styles/40-events-notes.css). */
export function eventColorVar(color: EventColor): string {
  return `var(--mp-event-${color})`;
}

export function eventErrorMessage(error: PlannerError): string {
  if (error.code === 'not-found' && (!error.messageKey || error.messageKey === 'common.errors.notFound')) {
    return t('events.errors.notFound');
  }
  return t(error.messageKey ?? 'common.errors.unknown');
}

function repeatLabel(rule: RepeatRule): string {
  return t(`model.repeat.${rule}`);
}

/** Календари для выбора: разрешающие запись + текущий календарь события (если его нет в списке). */
export function calendarChoices(
  writable: readonly CalendarOption[],
  current: string | null,
  known: ReadonlyArray<{ calendarId: string; title: string; color: string }>,
): CalendarOption[] {
  const options = [...writable];
  if (!options.some((option) => option.calendarId === current) && current !== null) {
    const cached = known.find((calendar) => calendar.calendarId === current);
    options.push({ calendarId: current, title: cached?.title ?? t('events.unknownCalendar'), color: cached?.color ?? 'var(--text-faint)' });
  }
  return options;
}

/** Открывает форму события или просмотр внешнего события. Неизвестный id — уведомление и `null`. */
export function openEventForm(deps: EventFormDeps, request: EventFormRequest, options: EventFormOptions = {}): SheetHandle | null {
  if (request.mode === 'view-external') {
    return openExternalEventDetails(deps, request.occurrenceKey, {
      openLinked: (id) => openEventForm(deps, { mode: 'edit', id }, options),
    });
  }
  const now = floatingFromDate(deps.clock.now(), deps.clock.timeZone());
  let initial: EventDraftState;
  let editEvent: PlannerEvent | null = null;
  if (request.mode === 'edit') {
    const item = deps.index.getById(request.id);
    if (!item || item.kind !== 'event') {
      deps.notifier.show(t('events.errors.notFound'));
      return null;
    }
    editEvent = item;
    initial = draftStateFromEvent(item, null, now);
  } else {
    const preferred = deps.settings.get().defaultEventCalendarId;
    const writable = deps.events.getWritableCalendars();
    const calendarId = writable.some((option) => option.calendarId === preferred) ? preferred : null;
    initial = createEventDraftState({ now, date: request.date ?? null, calendarId });
  }
  const form = new EventFormView(deps, new EventDraftController(initial, deps.events), options);
  const handle = deps.sheets.open({
    title: t(request.mode === 'edit' ? 'events.titleEdit' : 'events.titleCreate'),
    submitLabel: t('common.actions.done'),
    fullScreenOnPhone: true,
    render: (contentEl, sheet) => form.mount(contentEl, sheet),
    onSubmit: () => form.submit(),
    onClose: () => form.dispose(),
  });
  if (editEvent) form.loadBody(editEvent);
  return handle;
}

type PickerTarget = 'start' | 'end' | null;

class EventFormView {
  private sheet: SheetHandle | null = null;
  private titleInput: HTMLInputElement | null = null;
  private bodyInput: HTMLTextAreaElement | null = null;
  private bodyStatusEl: HTMLElement | null = null;
  private iconButton: HTMLButtonElement | null = null;
  private scheduleEl: HTMLElement | null = null;
  private styleEl: HTMLElement | null = null;
  private picker: PickerTarget = null;
  private deleteArmed = false;
  private deleting = false;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly deps: EventFormDeps,
    private readonly controller: EventDraftController,
    private readonly options: EventFormOptions,
  ) {}

  private get state(): EventDraftState {
    return this.controller.get();
  }

  private today(): string {
    return floatingFromDate(this.deps.clock.now(), this.deps.clock.timeZone()).date;
  }

  mount(contentEl: HTMLElement, sheet: SheetHandle): void {
    this.sheet = sheet;
    contentEl.addClass('mp-task-form', 'mp-event-form');
    this.renderText(contentEl.createDiv({ cls: 'mp-form-card' }));
    this.scheduleEl = contentEl.createDiv({ cls: 'mp-form-card mp-event-form-schedule' });
    this.styleEl = contentEl.createDiv({ cls: 'mp-form-card mp-event-form-style' });
    this.renderSchedule();
    this.renderStyle();
    if (this.state.mode === 'edit') this.renderDelete(contentEl.createDiv({ cls: 'mp-event-form-actions' }));
    this.syncSubmit();
    const focusTimer = window.setTimeout(() => this.titleInput?.focus(), 0);
    this.cleanups.push(() => window.clearTimeout(focusTimer));
  }

  dispose(): void {
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  async submit(): Promise<boolean> {
    if (this.deleting) return false;
    const result = await this.controller.submit();
    if (result.ok) {
      this.options.onSaved?.(result.event);
      return true;
    }
    if (result.reason === 'error') this.deps.notifier.show(eventErrorMessage(result.error));
    else if (result.reason === 'invalid') {
      const errors = validateEventDraft(this.state).errors;
      if (errors.title) {
        this.titleInput?.setAttr('aria-invalid', 'true');
        this.titleInput?.focus();
      } else {
        this.renderSchedule();
      }
    }
    this.syncSubmit();
    return false;
  }

  loadBody(event: PlannerEvent): void {
    void this.deps.repository.readBody(event.path).then(
      (result) => {
        if (this.disposed) return;
        if (result.ok) {
          this.controller.update((s) => setLoadedBody(s, result.value));
          this.syncBody(null);
        } else {
          this.syncBody(t('events.bodyLoadFailed'));
        }
      },
      () => {
        if (!this.disposed) this.syncBody(t('events.bodyLoadFailed'));
      },
    );
  }

  private update(change: (state: EventDraftState) => EventDraftState, rerender: 'schedule' | 'style' | 'none' = 'none'): void {
    this.controller.update(change);
    if (rerender === 'schedule') this.renderSchedule();
    else if (rerender === 'style') this.renderStyle();
    this.syncSubmit();
  }

  private syncSubmit(): void {
    this.sheet?.setSubmitEnabled(this.controller.canSubmit() && !this.deleting);
  }

  private syncBody(status: string | null): void {
    const input = this.bodyInput;
    if (!input) return;
    const loaded = this.state.bodyLoaded;
    input.disabled = !loaded;
    if (loaded && input.value !== this.state.body) input.value = this.state.body;
    this.bodyStatusEl?.setText(status ?? (loaded ? '' : t('events.loadingBody')));
    this.bodyStatusEl?.toggleClass('is-hidden', !(status ?? !loaded));
  }

  // --- Значок, название, заметки, URL ---

  private renderText(card: HTMLElement): void {
    const head = card.createDiv({ cls: 'mp-event-form-head' });
    const iconButton = head.createEl('button', {
      cls: 'mp-event-form-icon',
      attr: { type: 'button', 'aria-haspopup': 'menu', 'aria-label': t('events.chooseIcon'), title: t('events.chooseIcon') },
    });
    iconButton.addEventListener('click', (evt: MouseEvent) => this.openIconMenu(evt, iconButton));
    this.iconButton = iconButton;
    this.syncIcon();

    const title = head.createEl('input', {
      cls: 'mp-task-form-title',
      attr: {
        type: 'text',
        placeholder: t('events.fields.title'),
        'aria-label': t('events.fields.title'),
        'aria-required': 'true',
        enterkeyhint: 'next',
      },
    });
    title.value = this.state.title;
    title.addEventListener('input', () => {
      title.removeAttribute('aria-invalid');
      this.update((s) => setTitle(s, title.value));
    });
    title.addEventListener('keydown', (evt: KeyboardEvent) => {
      if (evt.key === 'Enter' && !evt.isComposing && !evt.ctrlKey && !evt.metaKey) {
        evt.preventDefault();
        this.bodyInput?.focus();
      }
    });
    this.titleInput = title;

    card.createDiv({ cls: 'mp-form-separator' });
    const body = card.createEl('textarea', {
      cls: 'mp-task-form-body',
      attr: { placeholder: t('events.fields.body'), 'aria-label': t('events.fields.body'), rows: '2' },
    });
    body.value = this.state.body;
    body.addEventListener('input', () => this.update((s) => setBody(s, body.value)));
    this.bodyInput = body;
    this.bodyStatusEl = card.createDiv({ cls: 'mp-task-form-status', attr: { 'aria-live': 'polite' } });
    this.syncBody(null);

    card.createDiv({ cls: 'mp-form-separator' });
    const url = card.createEl('input', {
      cls: 'mp-task-form-body mp-event-form-url',
      attr: { type: 'url', placeholder: t('events.fields.url'), 'aria-label': t('events.fields.url'), inputmode: 'url' },
    });
    url.value = this.state.url;
    url.addEventListener('input', () => this.update((s) => setUrl(s, url.value)));
  }

  private syncIcon(): void {
    const button = this.iconButton;
    if (!button) return;
    button.empty();
    button.setCssProps({ '--mp-event-color': eventColorVar(this.state.color) });
    setIcon(button, this.state.icon ?? 'calendar');
    button.toggleClass('is-empty', this.state.icon === null);
  }

  private openIconMenu(evt: MouseEvent, anchor: HTMLElement): void {
    const menu = new Menu();
    for (const name of EVENT_ICON_OPTIONS) {
      menu.addItem((item) =>
        item
          .setTitle(name)
          .setIcon(name)
          .setChecked(name === this.state.icon)
          .onClick(() => {
            this.update((s) => setIconName(s, name));
            this.syncIcon();
          }),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t('events.noIcon'))
        .setChecked(this.state.icon === null)
        .onClick(() => {
          this.update((s) => setIconName(s, null));
          this.syncIcon();
        }),
    );
    showMenu(menu, evt, anchor);
  }

  // --- Весь день, начало, конец, повтор ---

  private row(card: HTMLElement, icon: string, label: string): { row: HTMLElement; value: HTMLElement; labelId: string } {
    const row = card.createDiv({ cls: 'mp-form-row' });
    setIcon(row.createSpan({ cls: 'mp-form-row-icon', attr: { 'aria-hidden': 'true' } }), icon);
    const labelId = `mp-event-form-${icon}-${Math.random().toString(36).slice(2, 8)}`;
    row.createSpan({ cls: 'mp-form-row-label', text: label, attr: { id: labelId } });
    const value = row.createDiv({ cls: 'mp-form-row-value' });
    return { row, value, labelId };
  }

  private renderSchedule(): void {
    const card = this.scheduleEl;
    if (!card) return;
    card.empty();
    const state = this.state;
    const errors = validateEventDraft(state).errors;

    const allDay = this.row(card, 'clock', t('events.fields.allDay'));
    const toggle = new ToggleComponent(allDay.value).setValue(state.allDay);
    toggle.toggleEl.setAttr('aria-labelledby', allDay.labelId);
    toggle.onChange((value) => {
      this.picker = null;
      this.update((s) => setAllDay(s, value), 'schedule');
    });

    this.renderMomentRow(card, 'start');
    if (this.picker === 'start') this.renderPicker(card, 'start');
    const end = this.renderMomentRow(card, 'end');
    if (errors.end) end.addClass('is-invalid');
    if (this.picker === 'end') this.renderPicker(card, 'end');
    if (errors.end === 'before-start') {
      card.createDiv({ cls: 'mp-task-form-hint mp-event-form-error', text: t('events.endBeforeStart'), attr: { role: 'alert' } });
    }

    const repeat = this.row(card, 'repeat', t('events.fields.repeat'));
    selectButton(repeat.value, repeat.labelId, t('events.fields.repeat'), repeatLabel(state.repeat), (menu) => {
      for (const rule of EVENT_REPEAT_OPTIONS) {
        menu.addItem((item) =>
          item
            .setTitle(repeatLabel(rule))
            .setChecked(rule === this.state.repeat)
            .onClick(() => this.update((s) => setRepeat(s, rule), 'schedule')),
        );
      }
    });
    if (state.mode === 'edit' && (state.repeat !== 'none' || state.initial?.repeat !== 'none')) {
      card.createDiv({ cls: 'mp-task-form-hint', text: t('events.seriesHint') });
    }
  }

  private renderMomentRow(card: HTMLElement, which: 'start' | 'end'): HTMLElement {
    const state = this.state;
    const { row, value, labelId } = this.row(card, which === 'start' ? 'circle-dot' : 'circle', t(`events.fields.${which}`));
    const date = which === 'start' ? state.startDate : state.endDate;
    const time = which === 'start' ? state.startTime : state.endTime;
    const language = this.deps.format.get().language;
    const dateLabel = shortDateLabel(language, date);
    const pill = value.createEl('button', {
      cls: 'mp-form-pill',
      text: dateLabel,
      attr: {
        type: 'button',
        'aria-expanded': String(this.picker === which),
        'aria-describedby': labelId,
        'aria-label': `${t(which === 'start' ? 'events.startDate' : 'events.endDate')}: ${dateLabel}`,
      },
    });
    pill.addEventListener('click', () => {
      this.picker = this.picker === which ? null : which;
      this.renderSchedule();
    });
    if (!state.allDay) {
      const input = value.createEl('input', {
        cls: 'mp-form-pill mp-task-form-time',
        attr: { type: 'time', 'aria-label': t(which === 'start' ? 'events.startTime' : 'events.endTime') },
      });
      input.value = time;
      input.addEventListener('change', () => {
        if (input.value === '') {
          input.value = which === 'start' ? this.state.startTime : this.state.endTime;
          return;
        }
        const s = this.state;
        this.update(
          (current) => (which === 'start' ? setStart(current, s.startDate, input.value) : setEnd(current, s.endDate, input.value)),
          'schedule',
        );
      });
    }
    return row;
  }

  private renderPicker(card: HTMLElement, which: 'start' | 'end'): void {
    const holder = card.createDiv({ cls: 'mp-task-form-calendar' });
    const format = this.deps.format.get();
    this.deps.datePicker(holder, {
      value: which === 'start' ? this.state.startDate : this.state.endDate,
      today: this.today(),
      weekStart: format.weekStart,
      language: format.language,
      quickOptions: false,
      onChange: (value) => {
        if (value === null) return;
        this.picker = null;
        this.update((s) => (which === 'start' ? setStart(s, value) : setEnd(s, value)), 'schedule');
      },
    });
    holder.addEventListener('keydown', (evt: KeyboardEvent) => {
      if (evt.key !== 'Escape') return;
      evt.preventDefault();
      evt.stopPropagation();
      this.picker = null;
      this.renderSchedule();
    });
  }

  // --- Цвет и календарь ---

  private renderStyle(): void {
    const card = this.styleEl;
    if (!card) return;
    card.empty();
    const state = this.state;

    const colorRow = this.row(card, 'palette', t('events.fields.color'));
    colorRow.row.addClass('mp-event-form-color-row');
    const swatches = colorRow.value.createDiv({
      cls: 'mp-event-form-swatches',
      attr: { role: 'radiogroup', 'aria-labelledby': colorRow.labelId },
    });
    for (const color of EVENT_COLOR_OPTIONS) {
      const selected = color === state.color;
      const swatch = swatches.createEl('button', {
        cls: selected ? 'mp-event-form-swatch is-selected' : 'mp-event-form-swatch',
        attr: {
          type: 'button',
          role: 'radio',
          'aria-checked': String(selected),
          'aria-label': t('events.colorSwatch', { color: t(`events.colors.${color}`) }),
          title: t(`events.colors.${color}`),
          tabindex: selected ? '0' : '-1',
          'data-color': color,
        },
      });
      swatch.setCssProps({ '--mp-event-color': eventColorVar(color) });
      swatch.addEventListener('click', () => this.chooseColor(color));
    }
    swatches.addEventListener('keydown', (evt: KeyboardEvent) => {
      const step: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
      const delta = step[evt.key];
      if (delta === undefined) return;
      evt.preventDefault();
      const index = EVENT_COLOR_OPTIONS.indexOf(this.state.color);
      const next = EVENT_COLOR_OPTIONS[(index + delta + EVENT_COLOR_OPTIONS.length) % EVENT_COLOR_OPTIONS.length];
      if (!next) return;
      this.chooseColor(next);
      this.styleEl?.querySelector<HTMLElement>('.mp-event-form-swatch.is-selected')?.focus();
    });

    const choices = calendarChoices(
      this.deps.events.getWritableCalendars(),
      state.calendarId,
      this.deps.calendarCache.getCalendars(),
    );
    const current = choices.find((option) => option.calendarId === state.calendarId) ?? choices[0];
    const calendarRow = this.row(card, 'calendar', t('events.fields.calendar'));
    const button = selectButton(calendarRow.value, calendarRow.labelId, t('events.fields.calendar'), current?.title ?? '', (menu) => {
      for (const option of choices) {
        menu.addItem((item) =>
          item
            .setTitle(option.title)
            .setChecked(option.calendarId === this.state.calendarId)
            .onClick(() => this.update((s) => setCalendar(s, option.calendarId), 'style')),
        );
      }
    });
    const dot = createSpan({ cls: 'mp-event-calendar-dot', attr: { 'aria-hidden': 'true' } });
    dot.setCssProps({ '--mp-calendar-color': current?.color ?? 'var(--text-faint)' });
    button.prepend(dot);
    if (choices.length === 1) card.createDiv({ cls: 'mp-task-form-hint', text: t('events.calendarHint') });
  }

  private chooseColor(color: EventColor): void {
    this.update((s) => setColor(s, color), 'style');
    this.syncIcon();
  }

  // --- Удаление ---

  private renderDelete(holder: HTMLElement): void {
    const button = holder.createEl('button', {
      cls: 'mod-warning mp-event-form-delete',
      text: t('events.delete'),
      attr: { type: 'button' },
    });
    button.addEventListener('click', () => {
      if (this.deleting) return;
      if (!this.deleteArmed) {
        this.deleteArmed = true;
        button.setText(t('events.deleteConfirm'));
        return;
      }
      void this.runDelete(button);
    });
  }

  private async runDelete(button: HTMLButtonElement): Promise<void> {
    const id = this.state.eventId;
    if (id === null) return;
    this.deleting = true;
    button.disabled = true;
    this.sheet?.setBusy(true);
    this.syncSubmit();
    try {
      const result = await this.deps.events.delete(id);
      if (this.disposed) return;
      if (result.ok) {
        this.deps.notifier.show(t('events.deleted'));
        this.options.onDeleted?.(id);
        this.sheet?.close();
        return;
      }
      // Сбой не теряется: сообщение называет этап, форма остаётся открытой для повтора.
      this.deps.notifier.show(eventErrorMessage(result.error));
    } catch (error) {
      if (!this.disposed) this.deps.notifier.show(t('common.errors.unknown'));
      console.error('[matrix-planner] event delete failed', error);
    } finally {
      this.deleting = false;
      if (!this.disposed) {
        this.deleteArmed = false;
        button.disabled = false;
        button.setText(t('events.delete'));
        this.sheet?.setBusy(false);
        this.syncSubmit();
      }
    }
  }
}

function showMenu(menu: Menu, evt: MouseEvent, anchor: HTMLElement): void {
  if (evt.detail > 0) {
    menu.showAtMouseEvent(evt);
  } else {
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }
}

function selectButton(parent: HTMLElement, labelId: string, label: string, current: string, fill: (menu: Menu) => void): HTMLButtonElement {
  const button = parent.createEl('button', {
    cls: 'mp-form-select',
    attr: { type: 'button', 'aria-haspopup': 'menu', 'aria-describedby': labelId, 'aria-label': `${label}: ${current}` },
  });
  button.createSpan({ text: current });
  setIcon(button.createSpan({ cls: 'mp-form-select-icon', attr: { 'aria-hidden': 'true' } }), 'chevrons-up-down');
  button.addEventListener('click', (evt: MouseEvent) => {
    const menu = new Menu();
    fill(menu);
    showMenu(menu, evt, button);
  });
  return button;
}
