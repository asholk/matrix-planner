/**
 * Форма задачи (ТЗ §4.3, кадры 02–06): лист `SheetPresenter`, выбор даты `DatePickerFactory`.
 *
 * Состояние и правила — в `task-draft.ts`; здесь только DOM. Сохранение — через контракт
 * `TaskService` (реализация внедряется сборкой). Поля «Время», «Повтор» и «Напоминание»
 * показываются только при выбранной дате; «Квадрант» — четыре плитки.
 */

import { Menu, ToggleComponent, setIcon } from 'obsidian';
import type { CoreServices, SheetHandle, TaskFormRequest } from '../app/contracts';
import type { PlannerError, PlannerErrorCode, QuadrantConfig, QuadrantKey, RemindOffset, RepeatRule, Task } from '../model/types';
import { QUADRANT_KEYS } from '../model/types';
import { localDateOf } from '../model/dates';
import { registerDictionary, t } from '../i18n';
import { ruTaskForm } from '../i18n/ru/task-form';
import { enTaskForm } from '../i18n/en/task-form';
import { shortDateLabel } from '../ui/controls/date-picker';
import { renderDeleteButton } from '../ui/controls/delete-button';
import {
  REMIND_OPTIONS,
  REPEAT_OPTIONS,
  TaskDraftController,
  addTime,
  createDraftState,
  draftFromTask,
  fieldAvailability,
  setBody,
  setDate,
  setLoadedBody,
  setPriority,
  setQuadrant,
  setRemind,
  setRepeat,
  setTime,
  setTitle,
  type TaskDraftState,
} from './task-draft';

registerDictionary('ru', 'taskForm', ruTaskForm);
registerDictionary('en', 'taskForm', enTaskForm);
// Словарь `model` (названия повторов и напоминаний) регистрирует сборка: app/compose-core.

export type TaskFormDeps = Pick<
  CoreServices,
  'tasks' | 'index' | 'repository' | 'sheets' | 'datePicker' | 'clock' | 'format' | 'notifier' | 'settings'
>;

export interface TaskFormOptions {
  /** Вызывается после успешного сохранения (созданная задача или `null` при правке). */
  onSaved?(task: Task | null): void;
  /** Вызывается после удаления задачи из формы. */
  onDeleted?(id: string): void;
}

/** Положение квадранта в мини-сетке плитки (как на кадре 02). */
const QUADRANT_CELL: Record<QuadrantKey, number> = { do: 0, plan: 1, urgent: 2, someday: 3 };

const ERROR_KEYS: Record<PlannerErrorCode, string> = {
  'not-found': 'common.errors.notFound',
  'read-only': 'common.errors.readOnly',
  stale: 'common.errors.stale',
  invalid: 'common.errors.invalid',
  'outside-root': 'common.errors.outsideRoot',
  'write-failed': 'common.errors.writeFailed',
  'trash-failed': 'common.errors.trashFailed',
  'tombstone-failed': 'common.errors.tombstoneFailed',
  'not-ready': 'common.errors.notReady',
  unsupported: 'common.errors.unsupported',
  unknown: 'common.errors.unknown',
};

export function errorMessage(error: PlannerError): string {
  return t(error.messageKey ?? ERROR_KEYS[error.code] ?? ERROR_KEYS.unknown);
}

/** Подпись квадранта справа от поля «Квадрант». */
export function quadrantHint(key: QuadrantKey): string {
  return t(`taskForm.quadrantHint.${key}`);
}

export function repeatLabel(rule: RepeatRule): string {
  return t(`model.repeat.${rule}`);
}

export function remindLabel(offset: RemindOffset): string {
  return t(`model.remind.${offset}`);
}

/**
 * Открывает форму задачи. Для правки неизвестного id показывает уведомление и возвращает `null`.
 */
export function openTaskForm(deps: TaskFormDeps, request: TaskFormRequest, options: TaskFormOptions = {}): SheetHandle | null {
  let initial: TaskDraftState;
  let editTask: Task | null = null;
  if (request.mode === 'edit') {
    const item = deps.index.getById(request.id);
    if (!item || item.kind !== 'task') {
      deps.notifier.show(t('common.errors.notFound'));
      return null;
    }
    editTask = item;
    initial = draftFromTask(item, null);
  } else {
    initial = createDraftState({ quadrant: request.quadrant ?? null, date: request.date ?? null });
  }
  const form = new TaskFormView(deps, new TaskDraftController(initial, deps.tasks), options, editTask?.id ?? null);
  const handle = deps.sheets.open({
    title: t(request.mode === 'edit' ? 'taskForm.titleEdit' : 'taskForm.titleCreate'),
    submitLabel: t('common.actions.done'),
    fullScreenOnPhone: true,
    render: (contentEl, sheet) => form.mount(contentEl, sheet),
    onSubmit: () => form.submit(),
    onClose: () => form.dispose(),
  });
  if (editTask) form.loadBody(editTask);
  return handle;
}

class TaskFormView {
  private sheet: SheetHandle | null = null;
  private titleInput: HTMLInputElement | null = null;
  private bodyInput: HTMLTextAreaElement | null = null;
  private bodyStatusEl: HTMLElement | null = null;
  private scheduleEl: HTMLElement | null = null;
  private quadrantEl: HTMLElement | null = null;
  private calendarOpen = false;
  private disposed = false;
  private deleting = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly deps: TaskFormDeps,
    private readonly controller: TaskDraftController,
    private readonly options: TaskFormOptions,
    /** Правка существующей задачи — внизу кнопка «Удалить». */
    private readonly editId: string | null = null,
  ) {}

  private get state(): TaskDraftState {
    return this.controller.get();
  }

  private today(): string {
    return localDateOf(this.deps.clock.now(), this.deps.clock.timeZone());
  }

  mount(contentEl: HTMLElement, sheet: SheetHandle): void {
    this.sheet = sheet;
    contentEl.addClass('mp-task-form');
    this.renderText(contentEl.createDiv({ cls: 'mp-form-card' }));
    this.scheduleEl = contentEl.createDiv({ cls: 'mp-form-card mp-task-form-schedule' });
    this.quadrantEl = contentEl.createDiv({ cls: 'mp-form-card mp-task-form-matrix' });
    this.renderSchedule();
    this.renderPriorityAndQuadrant();
    if (this.editId !== null) {
      renderDeleteButton(contentEl, {
        label: t('taskForm.delete'),
        ariaLabel: t('taskForm.deleteLabel'),
        confirmLabel: t('taskForm.deleteConfirm'),
        onDelete: () => this.runDelete(),
      });
    }
    this.syncSubmit();
    // Фокус на названии при открытии (после вставки листа в DOM).
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
      this.options.onSaved?.(result.task);
      return true;
    }
    if (result.reason === 'error') this.deps.notifier.show(errorMessage(result.error));
    else if (result.reason === 'invalid') {
      this.titleInput?.setAttr('aria-invalid', 'true');
      this.titleInput?.focus();
    }
    this.syncSubmit();
    return false;
  }

  /** Тело заметки читается асинхронно; до загрузки поле недоступно и тело не перезаписывается. */
  loadBody(task: Task): void {
    void this.deps.repository.readBody(task.path).then(
      (result) => {
        if (this.disposed) return;
        if (result.ok) {
          this.controller.update((s) => setLoadedBody(s, result.value));
          this.syncBody(null);
        } else {
          this.syncBody(t('taskForm.bodyLoadFailed'));
        }
      },
      () => {
        if (!this.disposed) this.syncBody(t('taskForm.bodyLoadFailed'));
      },
    );
  }

  private update(change: (state: TaskDraftState) => TaskDraftState, rerender: 'schedule' | 'matrix' | 'none' = 'none'): void {
    this.controller.update(change);
    if (rerender === 'schedule') this.renderSchedule();
    else if (rerender === 'matrix') this.renderPriorityAndQuadrant();
    this.syncSubmit();
  }

  private syncSubmit(): void {
    this.sheet?.setSubmitEnabled(this.controller.canSubmit() && !this.deleting);
  }

  /** Удаление из формы: в корзину через `TaskService.delete`, лист закрывается. */
  private async runDelete(): Promise<boolean> {
    const id = this.editId;
    if (id === null) return false;
    this.deleting = true;
    this.sheet?.setBusy(true);
    this.syncSubmit();
    try {
      const result = await this.deps.tasks.delete(id);
      if (this.disposed) return true;
      if (result.ok) {
        this.deps.notifier.show(t('taskForm.deleted'));
        this.options.onDeleted?.(id);
        this.sheet?.close();
        return true;
      }
      this.deps.notifier.show(errorMessage(result.error));
      return false;
    } catch (error) {
      if (!this.disposed) this.deps.notifier.show(t('common.errors.unknown'));
      console.error('[matrix-planner] task delete failed', error);
      return false;
    } finally {
      this.deleting = false;
      if (!this.disposed) {
        this.sheet?.setBusy(false);
        this.syncSubmit();
      }
    }
  }

  private syncBody(status: string | null): void {
    const input = this.bodyInput;
    if (!input) return;
    const loaded = this.state.bodyLoaded;
    input.disabled = !loaded;
    if (loaded && input.value !== this.state.body) input.value = this.state.body;
    this.bodyStatusEl?.setText(status ?? (loaded ? '' : t('taskForm.loadingBody')));
    this.bodyStatusEl?.toggleClass('is-hidden', !(status ?? !loaded));
  }

  // --- Название и заметки ---

  private renderText(card: HTMLElement): void {
    const title = card.createEl('input', {
      cls: 'mp-task-form-title',
      attr: {
        type: 'text',
        placeholder: t('taskForm.fields.title'),
        'aria-label': t('taskForm.fields.title'),
        'aria-required': 'true',
        enterkeyhint: 'done',
      },
    });
    title.value = this.state.title;
    title.addEventListener('input', () => {
      title.removeAttribute('aria-invalid');
      this.update((s) => setTitle(s, title.value));
    });
    title.addEventListener('keydown', (evt: KeyboardEvent) => {
      // Enter в названии переходит к заметкам (Ctrl/Cmd+Enter — «Готово» в листе).
      if (evt.key === 'Enter' && !evt.isComposing && !evt.ctrlKey && !evt.metaKey) {
        evt.preventDefault();
        this.bodyInput?.focus();
      }
    });
    this.titleInput = title;

    card.createDiv({ cls: 'mp-form-separator' });
    const body = card.createEl('textarea', {
      cls: 'mp-task-form-body',
      attr: { placeholder: t('taskForm.fields.body'), 'aria-label': t('taskForm.fields.body'), rows: '2' },
    });
    body.value = this.state.body;
    body.addEventListener('input', () => this.update((s) => setBody(s, body.value)));
    this.bodyInput = body;
    this.bodyStatusEl = card.createDiv({ cls: 'mp-task-form-status', attr: { 'aria-live': 'polite' } });
    this.syncBody(null);
  }

  // --- Дата, время, повтор, напоминание ---

  private renderSchedule(): void {
    const card = this.scheduleEl;
    if (!card) return;
    card.empty();
    const state = this.state;
    const available = fieldAvailability(state);

    this.renderDateRow(card);
    if (this.calendarOpen) this.renderCalendar(card);
    if (available.time) this.renderTimeRow(card);
    if (available.repeat) {
      this.renderSelectRow(card, 'repeat', t('taskForm.fields.repeat'), repeatLabel(state.repeat), (menu) => {
        for (const rule of REPEAT_OPTIONS) {
          menu.addItem((item) =>
            item
              .setTitle(repeatLabel(rule))
              .setChecked(rule === this.state.repeat)
              .onClick(() => this.update((s) => setRepeat(s, rule), 'schedule')),
          );
        }
      });
    }
    if (available.remind) {
      this.renderSelectRow(card, 'bell', t('taskForm.fields.remind'), remindLabel(state.remind), (menu) => {
        for (const offset of REMIND_OPTIONS) {
          menu.addItem((item) =>
            item
              .setTitle(remindLabel(offset))
              .setChecked(offset === this.state.remind)
              .onClick(() => this.update((s) => setRemind(s, offset), 'schedule')),
          );
        }
      });
      if (state.remind !== 'none' && state.time === null) {
        card.createDiv({
          cls: 'mp-task-form-hint',
          text: t('taskForm.remindAtHint', { time: this.deps.settings.get().reminderTimeForDateOnly }),
        });
      }
    }
  }

  private row(card: HTMLElement, icon: string, label: string): { row: HTMLElement; value: HTMLElement; labelId: string } {
    const row = card.createDiv({ cls: 'mp-form-row' });
    setIcon(row.createSpan({ cls: 'mp-form-row-icon', attr: { 'aria-hidden': 'true' } }), icon);
    const labelId = `mp-task-form-${icon}-${Math.random().toString(36).slice(2, 8)}`;
    row.createSpan({ cls: 'mp-form-row-label', text: label, attr: { id: labelId } });
    const value = row.createDiv({ cls: 'mp-form-row-value' });
    return { row, value, labelId };
  }

  private clearButton(parent: HTMLElement, label: string, onClick: () => void): void {
    const button = parent.createEl('button', {
      cls: 'mp-icon-button mp-form-clear',
      attr: { type: 'button', 'aria-label': label, title: label },
    });
    setIcon(button, 'x-circle');
    button.addEventListener('click', onClick);
  }

  private renderDateRow(card: HTMLElement): void {
    const { value, labelId } = this.row(card, 'calendar', t('taskForm.fields.date'));
    const date = this.state.date;
    const language = this.deps.format.get().language;
    const pill = value.createEl('button', {
      cls: date === null ? 'mp-form-pill mp-form-pill-add' : 'mp-form-pill',
      text: date === null ? t('taskForm.addDate') : shortDateLabel(language, date),
      attr: {
        type: 'button',
        'aria-expanded': String(this.calendarOpen),
        'aria-describedby': labelId,
        'aria-label': date === null ? t('taskForm.addDate') : `${t('taskForm.chooseDate')}: ${shortDateLabel(language, date)}`,
      },
    });
    pill.addEventListener('click', () => {
      this.calendarOpen = !this.calendarOpen;
      this.renderSchedule();
    });
    if (date !== null) {
      this.clearButton(value, t('taskForm.clearDate'), () => {
        this.calendarOpen = false;
        this.update((s) => setDate(s, null), 'schedule');
      });
    }
  }

  private renderCalendar(card: HTMLElement): void {
    const holder = card.createDiv({ cls: 'mp-task-form-calendar' });
    const format = this.deps.format.get();
    this.deps.datePicker(holder, {
      value: this.state.date,
      today: this.today(),
      weekStart: format.weekStart,
      language: format.language,
      quickOptions: true,
      onChange: (value) => {
        // Выбор дня закрывает календарь (DOM выбора даты удаляется перерисовкой карточки).
        this.calendarOpen = false;
        this.update((s) => setDate(s, value), 'schedule');
      },
    });
    holder.addEventListener('keydown', (evt: KeyboardEvent) => {
      if (evt.key !== 'Escape') return;
      evt.preventDefault();
      evt.stopPropagation();
      this.calendarOpen = false;
      this.renderSchedule();
    });
  }

  private renderTimeRow(card: HTMLElement): void {
    const { value, labelId } = this.row(card, 'clock', t('taskForm.fields.time'));
    const time = this.state.time;
    if (time === null) {
      const add = value.createEl('button', {
        cls: 'mp-form-pill mp-form-pill-add',
        text: t('taskForm.addTime'),
        attr: { type: 'button' },
      });
      add.addEventListener('click', () => {
        this.update((s) => addTime(s), 'schedule');
        this.scheduleEl?.querySelector<HTMLInputElement>('.mp-task-form-time')?.focus();
      });
      return;
    }
    const input = value.createEl('input', {
      cls: 'mp-form-pill mp-task-form-time',
      attr: { type: 'time', 'aria-labelledby': labelId },
    });
    input.value = time;
    input.addEventListener('change', () => {
      // Пустое значение (очистка в поле) — без времени.
      this.update((s) => setTime(s, input.value === '' ? null : input.value), input.value === '' ? 'schedule' : 'none');
    });
    this.clearButton(value, t('taskForm.clearTime'), () => this.update((s) => setTime(s, null), 'schedule'));
  }

  private renderSelectRow(card: HTMLElement, icon: string, label: string, current: string, fill: (menu: Menu) => void): void {
    const { value, labelId } = this.row(card, icon, label);
    const button = value.createEl('button', {
      cls: 'mp-form-select',
      attr: { type: 'button', 'aria-haspopup': 'menu', 'aria-describedby': labelId, 'aria-label': `${label}: ${current}` },
    });
    button.createSpan({ text: current });
    setIcon(button.createSpan({ cls: 'mp-form-select-icon', attr: { 'aria-hidden': 'true' } }), 'chevrons-up-down');
    button.addEventListener('click', (evt: MouseEvent) => {
      const menu = new Menu();
      fill(menu);
      if (evt.detail > 0) {
        menu.showAtMouseEvent(evt);
      } else {
        // Открытие с клавиатуры — под кнопкой.
        const rect = button.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom });
      }
    });
  }

  // --- Приоритет и квадрант ---

  private renderPriorityAndQuadrant(): void {
    const card = this.quadrantEl;
    if (!card) return;
    card.empty();
    const state = this.state;

    const priority = this.row(card, 'flag', t('taskForm.fields.priority'));
    const toggle = new ToggleComponent(priority.value).setValue(state.priority === 'high');
    toggle.toggleEl.setAttr('aria-labelledby', priority.labelId);
    toggle.onChange((high) => this.update((s) => setPriority(s, high)));

    const matrix = this.deps.index.getMatrix();
    const quadrantRow = this.row(card, 'layout-grid', t('taskForm.fields.quadrant'));
    // Подпись выбранного квадранта (кадры 04, 05): «Срочно и важно», «Важно, не срочно»…
    quadrantRow.value.createSpan({ cls: 'mp-task-form-quadrant-name', text: quadrantHint(state.quadrant) });

    const tiles = card.createDiv({
      cls: 'mp-task-form-tiles',
      attr: { role: 'radiogroup', 'aria-labelledby': quadrantRow.labelId },
    });
    for (const key of QUADRANT_KEYS) {
      const config = matrix.byKey[key];
      if (config) this.renderTile(tiles, config, key === state.quadrant);
    }
    // Стрелки переключают плитки (шаблон ARIA radiogroup).
    tiles.addEventListener('keydown', (evt: KeyboardEvent) => {
      const step: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
      const delta = step[evt.key];
      if (delta === undefined) return;
      evt.preventDefault();
      const index = QUADRANT_KEYS.indexOf(this.state.quadrant);
      const next = QUADRANT_KEYS[(index + delta + QUADRANT_KEYS.length) % QUADRANT_KEYS.length];
      if (!next) return;
      this.update((s) => setQuadrant(s, next), 'matrix');
      this.quadrantEl?.querySelector<HTMLElement>('.mp-task-form-tile.is-selected')?.focus();
    });
  }

  private renderTile(parent: HTMLElement, config: QuadrantConfig, selected: boolean): void {
    const tile = parent.createEl('button', {
      cls: 'mp-task-form-tile',
      attr: {
        type: 'button',
        role: 'radio',
        'aria-checked': String(selected),
        'aria-label': t('taskForm.quadrantTile', { title: config.title }),
        tabindex: selected ? '0' : '-1',
        'data-quadrant': config.key,
      },
    });
    tile.toggleClass('is-selected', selected);
    tile.setCssProps({ '--mp-tile-color': config.color });
    const mini = tile.createDiv({ cls: 'mp-task-form-tile-grid', attr: { 'aria-hidden': 'true' } });
    for (let cell = 0; cell < 4; cell++) {
      mini.createSpan({ cls: cell === QUADRANT_CELL[config.key] ? 'mp-task-form-tile-cell is-active' : 'mp-task-form-tile-cell' });
    }
    tile.createSpan({ cls: 'mp-task-form-tile-label', text: config.title });
    tile.addEventListener('click', () => this.update((s) => setQuadrant(s, config.key), 'matrix'));
  }
}

