/**
 * Выбор даты (S1.T4): компактный календарь месяца с навигацией (кадр 04),
 * переход к выбору месяца и года, быстрые варианты и очистка.
 *
 * Верхняя часть файла — чистая логика (без DOM), её проверяют тесты;
 * ниже — DOM-фабрика `createDatePicker`, совместимая с `DatePickerFactory`.
 */

import { setIcon } from 'obsidian';
import type { DatePickerFactory, DatePickerHandle, DatePickerOptions } from '../../app/contracts';
import type { Language, LocalDateString, WeekStartDay } from '../../model/types';
import { registerDictionary, t } from '../../i18n';
import { ruShell } from '../../i18n/ru/shell';
import { enShell } from '../../i18n/en/shell';

registerDictionary('ru', 'shell', ruShell);
registerDictionary('en', 'shell', enShell);

// ===========================================================================
// Чистая логика
// ===========================================================================

export const MIN_YEAR = 1900;
export const MAX_YEAR = 2999;
const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface YearMonth {
  year: number;
  /** 0–11. */
  month: number;
}

export type DatePickerMode = 'days' | 'months';

export interface DatePickerState {
  value: LocalDateString | null;
  today: LocalDateString;
  /** Показываемый месяц. */
  view: YearMonth;
  /** День с фокусом клавиатуры (roving tabindex). */
  focusDate: LocalDateString;
  mode: DatePickerMode;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function clampYear(year: number): number {
  return Math.min(MAX_YEAR, Math.max(MIN_YEAR, year));
}

export function isLocalDate(value: unknown): value is LocalDateString {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  return month >= 0 && month < 12 && day >= 1 && day <= daysInMonth(Number(match[1]), month);
}

/** `YYYY-MM-DD` → UTC-полночь (без влияния часового пояса и перехода на летнее время). */
function toUtc(date: LocalDateString): number {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Invalid date: ${date}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function fromUtc(ms: number): LocalDateString {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatDate(year: number, month: number, day: number): LocalDateString {
  return `${pad(year, 4)}-${pad(month + 1)}-${pad(day)}`;
}

export function yearMonthOf(date: LocalDateString): YearMonth {
  const d = new Date(toUtc(date));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function addDays(date: LocalDateString, days: number): LocalDateString {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** День недели: 0 — воскресенье. */
export function weekdayOf(date: LocalDateString): number {
  return new Date(toUtc(date)).getUTCDay();
}

/** Сдвиг месяца с переходом через год. */
export function shiftYearMonth(ym: YearMonth, deltaMonths: number): YearMonth {
  const total = ym.year * 12 + ym.month + deltaMonths;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const clamped = clampYear(year);
  if (clamped !== year) return { year: clamped, month: year < clamped ? 0 : 11 };
  return { year, month };
}

/** Тот же день в другом месяце; 31-е → последний день короткого месяца. */
export function sameDayIn(date: LocalDateString, ym: YearMonth): LocalDateString {
  const day = Number(date.slice(8, 10));
  return formatDate(ym.year, ym.month, Math.min(day, daysInMonth(ym.year, ym.month)));
}

/**
 * Сетка месяца по неделям. Пустые ячейки до первого и после последнего дня — `null`
 * (как на кадре 04). Строк ровно столько, сколько недель занимает месяц.
 */
export function buildMonthGrid(ym: YearMonth, weekStart: WeekStartDay): Array<Array<LocalDateString | null>> {
  const first = formatDate(ym.year, ym.month, 1);
  const lead = (weekdayOf(first) - weekStart + 7) % 7;
  const count = daysInMonth(ym.year, ym.month);
  const cells: Array<LocalDateString | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let day = 1; day <= count; day++) cells.push(formatDate(ym.year, ym.month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: Array<Array<LocalDateString | null>> = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

function formatUtc(language: Language, ms: number, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(language, { ...options, timeZone: 'UTC' }).format(new Date(ms));
}

/** Короткие названия дней недели начиная с `weekStart` («пн», «вт»… / «Mon», «Tue»…). */
export function weekdayLabels(language: Language, weekStart: WeekStartDay, width: 'short' | 'long' = 'short'): string[] {
  // 2024-01-07 — воскресенье.
  const sunday = Date.UTC(2024, 0, 7);
  const labels: string[] = [];
  for (let i = 0; i < 7; i++) {
    labels.push(formatUtc(language, sunday + ((weekStart + i) % 7) * DAY_MS, { weekday: width }));
  }
  return labels;
}

/** Заголовок месяца: «Октябрь 2026 г.» / «October 2026». */
export function monthTitle(language: Language, ym: YearMonth): string {
  return capitalize(formatUtc(language, Date.UTC(ym.year, ym.month, 1), { month: 'long', year: 'numeric' }));
}

/** Названия месяцев в именительном падеже («Январь»…). */
export function monthNames(language: Language, width: 'long' | 'short' = 'long'): string[] {
  const names: string[] = [];
  for (let month = 0; month < 12; month++) {
    names.push(capitalize(formatUtc(language, Date.UTC(2024, month, 1), { month: width })));
  }
  return names;
}

/** Полная подпись дня для экранного диктора. */
export function fullDateLabel(language: Language, date: LocalDateString): string {
  return formatUtc(language, toUtc(date), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** Подпись выбранной даты на кнопке поля («10 окт. 2026 г.»). */
export function shortDateLabel(language: Language, date: LocalDateString): string {
  return formatUtc(language, toUtc(date), { day: 'numeric', month: 'short', year: 'numeric' });
}

export interface QuickDates {
  today: LocalDateString;
  tomorrow: LocalDateString;
  nextWeek: LocalDateString;
}

export function quickDates(today: LocalDateString): QuickDates {
  return { today, tomorrow: addDays(today, 1), nextWeek: addDays(today, 7) };
}

export function initDatePickerState(value: LocalDateString | null, today: LocalDateString): DatePickerState {
  const selected = isLocalDate(value) ? value : null;
  const anchor = selected ?? today;
  return { value: selected, today, view: yearMonthOf(anchor), focusDate: anchor, mode: 'days' };
}

/** Перелистывание месяца стрелками заголовка. Фокус — тот же день нового месяца. */
export function shiftMonth(state: DatePickerState, delta: number): DatePickerState {
  const view = shiftYearMonth(state.view, delta);
  return { ...state, view, focusDate: sameDayIn(state.focusDate, view) };
}

export function shiftYear(state: DatePickerState, delta: number): DatePickerState {
  return shiftMonth(state, delta * 12);
}

export function toggleMode(state: DatePickerState): DatePickerState {
  return { ...state, mode: state.mode === 'days' ? 'months' : 'days' };
}

/** Выбор месяца в режиме «месяцы» → возврат к дням этого месяца. */
export function chooseMonth(state: DatePickerState, month: number): DatePickerState {
  const view = { year: state.view.year, month: Math.min(11, Math.max(0, Math.trunc(month))) };
  return { ...state, view, focusDate: sameDayIn(state.focusDate, view), mode: 'days' };
}

/** Выбор дня (или `null` — очистка). Месяц выбранного дня становится видимым. */
export function selectDate(state: DatePickerState, date: LocalDateString | null): DatePickerState {
  if (date === null) return { ...state, value: null };
  if (!isLocalDate(date)) return state;
  return { ...state, value: date, focusDate: date, view: yearMonthOf(date), mode: 'days' };
}

/** Внешняя установка значения (`DatePickerHandle.setValue`). */
export function applyValue(state: DatePickerState, value: LocalDateString | null): DatePickerState {
  if (value === null || !isLocalDate(value)) return { ...state, value: null };
  return { ...state, value, focusDate: value, view: yearMonthOf(value) };
}

export function setToday(state: DatePickerState, today: LocalDateString): DatePickerState {
  return isLocalDate(today) ? { ...state, today } : state;
}

/**
 * Клавиатура сетки дней (шаблон ARIA grid): стрелки — день/неделя,
 * PageUp/PageDown — месяц (с Shift — год), Home/End — начало/конец недели.
 * Возвращает `null`, если клавиша не обрабатывается.
 */
export function moveFocus(
  state: DatePickerState,
  key: string,
  weekStart: WeekStartDay,
  shift = false,
): DatePickerState | null {
  let focus: LocalDateString;
  switch (key) {
    case 'ArrowLeft':
      focus = addDays(state.focusDate, -1);
      break;
    case 'ArrowRight':
      focus = addDays(state.focusDate, 1);
      break;
    case 'ArrowUp':
      focus = addDays(state.focusDate, -7);
      break;
    case 'ArrowDown':
      focus = addDays(state.focusDate, 7);
      break;
    case 'PageUp':
    case 'PageDown': {
      const delta = (key === 'PageUp' ? -1 : 1) * (shift ? 12 : 1);
      focus = sameDayIn(state.focusDate, shiftYearMonth(yearMonthOf(state.focusDate), delta));
      break;
    }
    case 'Home':
      focus = addDays(state.focusDate, -((weekdayOf(state.focusDate) - weekStart + 7) % 7));
      break;
    case 'End':
      focus = addDays(state.focusDate, 6 - ((weekdayOf(state.focusDate) - weekStart + 7) % 7));
      break;
    default:
      return null;
  }
  const ym = yearMonthOf(focus);
  if (ym.year < MIN_YEAR || ym.year > MAX_YEAR) return state;
  return { ...state, focusDate: focus, view: ym };
}

// ===========================================================================
// DOM
// ===========================================================================

function iconButton(parent: HTMLElement, icon: string, label: string, cls: string): HTMLButtonElement {
  const button = parent.createEl('button', {
    cls: `mp-icon-button ${cls}`,
    attr: { type: 'button', 'aria-label': label, title: label },
  });
  setIcon(button, icon);
  return button;
}

class DatePickerView implements DatePickerHandle {
  private state: DatePickerState;
  private readonly rootEl: HTMLElement;
  private destroyed = false;

  constructor(containerEl: HTMLElement, private readonly options: DatePickerOptions) {
    this.state = initDatePickerState(options.value, options.today);
    this.rootEl = containerEl.createDiv({
      cls: 'mp-datepicker',
      attr: { role: 'group', 'aria-label': t('shell.datePicker.label') },
    });
    this.render(false);
  }

  setValue(value: LocalDateString | null): void {
    if (this.destroyed) return;
    this.state = applyValue(this.state, value);
    this.render(false);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rootEl.remove();
  }

  private update(next: DatePickerState, focusGrid: boolean): void {
    this.state = next;
    this.render(focusGrid);
  }

  private commit(date: LocalDateString | null): void {
    const changed = this.state.value !== date;
    this.update(selectDate(this.state, date), false);
    if (changed) this.options.onChange(this.state.value);
  }

  private render(focusGrid: boolean): void {
    const root = this.rootEl;
    root.empty();
    root.toggleClass('is-months', this.state.mode === 'months');
    if (this.options.quickOptions) this.renderQuick(root);
    this.renderHeader(root);
    if (this.state.mode === 'days') this.renderDays(root, focusGrid);
    else this.renderMonths(root, focusGrid);
  }

  private renderQuick(root: HTMLElement): void {
    const row = root.createDiv({ cls: 'mp-datepicker-quick' });
    const quick = quickDates(this.state.today);
    const entries: Array<[LocalDateString, string]> = [
      [quick.today, t('shell.datePicker.today')],
      [quick.tomorrow, t('shell.datePicker.tomorrow')],
      [quick.nextWeek, t('shell.datePicker.nextWeek')],
    ];
    for (const [date, label] of entries) {
      const pressed = this.state.value === date;
      const chip = row.createEl('button', {
        cls: 'mp-chip',
        text: label,
        attr: { type: 'button', 'aria-pressed': String(pressed) },
      });
      chip.toggleClass('is-active', pressed);
      chip.addEventListener('click', () => this.commit(date));
    }
    if (this.state.value !== null) {
      const clear = iconButton(row, 'x-circle', t('shell.datePicker.clear'), 'mp-datepicker-clear');
      clear.addEventListener('click', () => this.commit(null));
    }
  }

  private renderHeader(root: HTMLElement): void {
    const { language } = this.options;
    const header = root.createDiv({ cls: 'mp-datepicker-header' });
    const days = this.state.mode === 'days';
    const title = header.createEl('button', {
      cls: 'mp-datepicker-title',
      attr: {
        type: 'button',
        'aria-label': days ? t('shell.datePicker.chooseMonth') : t('shell.datePicker.backToDays'),
        'aria-expanded': String(!days),
      },
    });
    title.createSpan({ text: days ? monthTitle(language, this.state.view) : String(this.state.view.year) });
    setIcon(title.createSpan({ cls: 'mp-datepicker-title-icon' }), days ? 'chevron-right' : 'chevron-down');
    title.addEventListener('click', () => this.update(toggleMode(this.state), false));

    const nav = header.createDiv({ cls: 'mp-datepicker-nav' });
    const prev = iconButton(nav, 'chevron-left', t(days ? 'shell.datePicker.prevMonth' : 'shell.datePicker.prevYear'), 'mp-datepicker-prev');
    const next = iconButton(nav, 'chevron-right', t(days ? 'shell.datePicker.nextMonth' : 'shell.datePicker.nextYear'), 'mp-datepicker-next');
    prev.addEventListener('click', () => this.update(days ? shiftMonth(this.state, -1) : shiftYear(this.state, -1), false));
    next.addEventListener('click', () => this.update(days ? shiftMonth(this.state, 1) : shiftYear(this.state, 1), false));
  }

  private renderDays(root: HTMLElement, focusGrid: boolean): void {
    const { language, weekStart } = this.options;
    const grid = root.createDiv({
      cls: 'mp-datepicker-grid',
      attr: { role: 'grid', 'aria-label': monthTitle(language, this.state.view) },
    });
    const head = grid.createDiv({ cls: 'mp-datepicker-row mp-datepicker-weekdays', attr: { role: 'row' } });
    const short = weekdayLabels(language, weekStart, 'short');
    const long = weekdayLabels(language, weekStart, 'long');
    short.forEach((label, i) => {
      head.createDiv({
        cls: 'mp-datepicker-weekday',
        text: label,
        attr: { role: 'columnheader', 'aria-label': long[i] ?? label },
      });
    });

    let focusEl: HTMLElement | null = null;
    for (const week of buildMonthGrid(this.state.view, weekStart)) {
      const row = grid.createDiv({ cls: 'mp-datepicker-row', attr: { role: 'row' } });
      for (const date of week) {
        if (date === null) {
          row.createDiv({ cls: 'mp-datepicker-day is-empty', attr: { role: 'gridcell', 'aria-hidden': 'true' } });
          continue;
        }
        const selected = date === this.state.value;
        const isToday = date === this.state.today;
        const focused = date === this.state.focusDate;
        let label = fullDateLabel(language, date);
        if (isToday) label += `, ${t('shell.datePicker.todayMark')}`;
        const cell = row.createEl('button', {
          cls: 'mp-datepicker-day',
          text: String(Number(date.slice(8, 10))),
          attr: {
            type: 'button',
            role: 'gridcell',
            'data-date': date,
            'aria-label': label,
            'aria-selected': String(selected),
            tabindex: focused ? '0' : '-1',
          },
        });
        if (isToday) cell.setAttr('aria-current', 'date');
        cell.toggleClass('is-selected', selected);
        cell.toggleClass('is-today', isToday);
        cell.addEventListener('click', () => this.commit(date));
        if (focused) focusEl = cell;
      }
    }

    grid.addEventListener('keydown', (evt: KeyboardEvent) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        this.commit(this.state.focusDate);
        return;
      }
      const next = moveFocus(this.state, evt.key, weekStart, evt.shiftKey);
      if (!next) return;
      evt.preventDefault();
      this.update(next, true);
    });

    if (focusGrid && focusEl) (focusEl).focus();
  }

  private renderMonths(root: HTMLElement, focusGrid: boolean): void {
    const { language } = this.options;
    const grid = root.createDiv({ cls: 'mp-datepicker-months', attr: { role: 'listbox', 'aria-label': String(this.state.view.year) } });
    const current = yearMonthOf(this.state.value ?? this.state.today);
    let focusEl: HTMLElement | null = null;
    monthNames(language).forEach((name, month) => {
      const selected = month === this.state.view.month;
      const button = grid.createEl('button', {
        cls: 'mp-datepicker-month',
        text: name,
        attr: {
          type: 'button',
          role: 'option',
          'aria-selected': String(selected),
          tabindex: selected ? '0' : '-1',
        },
      });
      button.toggleClass('is-selected', selected);
      button.toggleClass('is-current', current.year === this.state.view.year && current.month === month);
      button.addEventListener('click', () => this.update(chooseMonth(this.state, month), true));
      if (selected) focusEl = button;
    });
    grid.addEventListener('keydown', (evt: KeyboardEvent) => {
      const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
      const delta = step[evt.key];
      if (delta === undefined) return;
      evt.preventDefault();
      const month = Math.min(11, Math.max(0, this.state.view.month + delta));
      this.update({ ...this.state, view: { ...this.state.view, month } }, true);
    });
    if (focusGrid && focusEl) (focusEl as HTMLElement).focus();
  }
}

/** Фабрика выбора даты (`CoreServices.datePicker`). */
export const createDatePicker: DatePickerFactory = (containerEl, options) => new DatePickerView(containerEl, options);
