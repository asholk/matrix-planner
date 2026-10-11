/**
 * Форма быстрой заметки (ТЗ §4.3): название, текст, дата (подставляется из выбранного дня).
 * Созданная заметка сохраняется в `Заметки/` и открывается в редакторе.
 */

import { setIcon } from 'obsidian';
import type { CoreServices, NoteFormRequest, NoteService, SheetHandle } from '../app/contracts';
import type { LocalDateString, NoteDraft, OpResult, PlannerError, QuickNote, VaultPath } from '../model/types';
import { isValidDate, localDateOf } from '../model/dates';
import { t } from '../i18n';
import { shortDateLabel } from '../ui/controls/date-picker';
import type { HapticKind } from '../ui/haptics';
import { bindEnterToSubmit, shouldAutofocusTitle } from '../tasks/task-form';
import { registerNoteDictionaries } from './note-service';

registerNoteDictionaries();

export type NoteFormDeps = Pick<CoreServices, 'index' | 'repository' | 'sheets' | 'datePicker' | 'clock' | 'format' | 'notifier'> &
  Partial<Pick<CoreServices, 'platform' | 'haptics'>> & {
  notes: NoteService;
  /** Открыть заметку в редакторе (`PlannerActions.openNote`). */
  openNote(path: VaultPath): Promise<void>;
};

export interface NoteFormOptions {
  onSaved?(path: VaultPath | null): void;
}

export interface NoteFormState {
  title: string;
  body: string;
  bodyLoaded: boolean;
  date: LocalDateString | null;
}

export function noteErrorMessage(error: PlannerError): string {
  if (error.code === 'not-found' && (!error.messageKey || error.messageKey === 'common.errors.notFound')) {
    return t('notes.errors.notFound');
  }
  return t(error.messageKey ?? 'common.errors.unknown');
}

/** Изменённые поля заметки; пустой объект — ничего не менялось. */
export function notePatch(state: NoteFormState, initial: NoteDraft): Partial<NoteDraft> {
  const patch: Partial<NoteDraft> = {};
  const title = state.title.trim();
  if (title !== initial.title) patch.title = title;
  if (state.bodyLoaded && state.body !== initial.body) patch.body = state.body;
  if (state.date !== initial.date) patch.date = state.date;
  return patch;
}

/** Форма заметки изменена: правка — есть изменённые поля, создание — что-то введено или дата сменена. */
export function isNoteFormDirty(state: NoteFormState, initial: NoteDraft | null, createDate: LocalDateString | null): boolean {
  if (initial) return Object.keys(notePatch(state, initial)).length > 0;
  return state.title.trim() !== '' || state.body.trim() !== '' || state.date !== createDate;
}

/**
 * Создаёт заметку и открывает её в редакторе (ТЗ §4.3). Сбой открытия не отменяет
 * создание: заметка уже сохранена, ошибка пишется в консоль.
 */
export async function createAndOpenNote(
  deps: Pick<NoteFormDeps, 'notes' | 'openNote'>,
  draft: NoteDraft,
): Promise<OpResult<VaultPath>> {
  const result = await deps.notes.create({ ...draft, title: draft.title.trim() });
  if (!result.ok) return result;
  try {
    await deps.openNote(result.value);
  } catch (error) {
    console.error('[matrix-planner] open note failed', error);
  }
  return result;
}

/** Открывает форму заметки. Неизвестный id — уведомление и `null`. */
export function openNoteForm(deps: NoteFormDeps, request: NoteFormRequest, options: NoteFormOptions = {}): SheetHandle | null {
  let note: QuickNote | null = null;
  let state: NoteFormState;
  if (request.mode === 'edit') {
    const item = deps.index.getById(request.id);
    if (!item || item.kind !== 'note') {
      deps.notifier.show(t('notes.errors.notFound'));
      return null;
    }
    note = item;
    state = { title: item.title, body: '', bodyLoaded: false, date: item.date };
  } else {
    state = { title: '', body: '', bodyLoaded: true, date: isValidDate(request.date) ? request.date : null };
  }
  const view = new NoteFormView(deps, state, note, options);
  const haptic = (kind: HapticKind): void => deps.haptics?.play(kind);
  haptic('tap');
  const handle = deps.sheets.open({
    title: t(note ? 'notes.titleEdit' : 'notes.titleCreate'),
    submitLabel: t('common.actions.done'),
    fullScreenOnPhone: true,
    render: (contentEl, sheet) => view.mount(contentEl, sheet),
    onSubmit: () => view.submit(),
    onClose: () => view.dispose(),
    isDirty: () => view.isDirty(),
    haptic,
  });
  if (note) view.loadBody(note);
  return handle;
}

class NoteFormView {
  private sheet: SheetHandle | null = null;
  private titleInput: HTMLInputElement | null = null;
  private bodyInput: HTMLTextAreaElement | null = null;
  private bodyStatusEl: HTMLElement | null = null;
  private dateEl: HTMLElement | null = null;
  private calendarOpen = false;
  private inFlight = false;
  private saved = false;
  private disposed = false;
  private readonly initial: NoteDraft | null;
  private readonly createDate: LocalDateString | null;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly deps: NoteFormDeps,
    private state: NoteFormState,
    private readonly note: QuickNote | null,
    private readonly options: NoteFormOptions,
  ) {
    this.initial = note ? { title: note.title, body: '', date: note.date } : null;
    this.createDate = state.date;
  }

  isDirty(): boolean {
    if (this.saved) return false;
    return isNoteFormDirty(this.state, this.initial, this.createDate);
  }

  private haptic(kind: HapticKind): void {
    this.deps.haptics?.play(kind);
  }

  mount(contentEl: HTMLElement, sheet: SheetHandle): void {
    this.sheet = sheet;
    contentEl.addClass('mp-task-form', 'mp-note-form');
    const card = contentEl.createDiv({ cls: 'mp-form-card' });
    const title = card.createEl('input', {
      cls: 'mp-task-form-title',
      attr: { type: 'text', placeholder: t('notes.fields.title'), 'aria-label': t('notes.fields.title'), 'aria-required': 'true', enterkeyhint: 'done' },
    });
    title.value = this.state.title;
    title.addEventListener('input', () => {
      title.removeAttribute('aria-invalid');
      this.state = { ...this.state, title: title.value };
      this.syncSubmit();
    });
    // Enter — «Готово» (доработка 006, §9); к тексту — Tab.
    bindEnterToSubmit(title, () => {
      if (!this.canSubmit()) {
        if (this.state.title.trim() === '') title.setAttr('aria-invalid', 'true');
        return;
      }
      this.sheet?.submit?.();
    });
    this.titleInput = title;

    card.createDiv({ cls: 'mp-form-separator' });
    const body = card.createEl('textarea', {
      cls: 'mp-task-form-body mp-note-form-body',
      attr: { placeholder: t('notes.fields.body'), 'aria-label': t('notes.fields.body'), rows: '5' },
    });
    body.value = this.state.body;
    body.addEventListener('input', () => {
      if (this.state.bodyLoaded) this.state = { ...this.state, body: body.value };
    });
    this.bodyInput = body;
    this.bodyStatusEl = card.createDiv({ cls: 'mp-task-form-status', attr: { 'aria-live': 'polite' } });
    this.syncBody(null);

    this.dateEl = contentEl.createDiv({ cls: 'mp-form-card' });
    this.renderDate();
    this.syncSubmit();
    if (shouldAutofocusTitle(this.note ? 'edit' : 'create', this.deps.platform)) {
      const focusTimer = window.setTimeout(() => this.titleInput?.focus(), 0);
      this.cleanups.push(() => window.clearTimeout(focusTimer));
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  loadBody(note: QuickNote): void {
    void this.deps.repository.readBody(note.path).then(
      (result) => {
        if (this.disposed) return;
        if (result.ok) {
          if (!this.state.bodyLoaded) {
            this.state = { ...this.state, body: result.value, bodyLoaded: true };
            if (this.initial) this.initial.body = result.value;
          }
          this.syncBody(null);
        } else {
          this.syncBody(t('notes.bodyLoadFailed'));
        }
      },
      () => {
        if (!this.disposed) this.syncBody(t('notes.bodyLoadFailed'));
      },
    );
  }

  private canSubmit(): boolean {
    return !this.inFlight && !this.saved && this.state.title.trim() !== '';
  }

  private syncSubmit(): void {
    this.sheet?.setSubmitEnabled(this.canSubmit());
  }

  private syncBody(status: string | null): void {
    const input = this.bodyInput;
    if (!input) return;
    const loaded = this.state.bodyLoaded;
    input.disabled = !loaded;
    if (loaded && input.value !== this.state.body) input.value = this.state.body;
    this.bodyStatusEl?.setText(status ?? (loaded ? '' : t('notes.loadingBody')));
    this.bodyStatusEl?.toggleClass('is-hidden', !(status ?? !loaded));
  }

  async submit(): Promise<boolean> {
    if (this.inFlight || this.saved) return false;
    if (this.state.title.trim() === '') {
      this.titleInput?.setAttr('aria-invalid', 'true');
      this.titleInput?.focus();
      return false;
    }
    this.inFlight = true;
    this.syncSubmit();
    try {
      if (this.note && this.initial) {
        const patch = notePatch(this.state, this.initial);
        if (Object.keys(patch).length > 0) {
          const result = await this.deps.notes.update(this.note.id, patch);
          if (!result.ok) {
            this.haptic('error');
            this.deps.notifier.show(noteErrorMessage(result.error));
            return false;
          }
        }
        this.saved = true;
        this.haptic('success');
        this.options.onSaved?.(null);
        return true;
      }
      const result = await createAndOpenNote(this.deps, { title: this.state.title, body: this.state.body, date: this.state.date });
      if (!result.ok) {
        this.haptic('error');
        this.deps.notifier.show(noteErrorMessage(result.error));
        return false;
      }
      this.saved = true;
      this.haptic('success');
      this.options.onSaved?.(result.value);
      return true;
    } catch (error) {
      this.haptic('error');
      this.deps.notifier.show(t('common.errors.unknown'));
      console.error('[matrix-planner] note save failed', error);
      return false;
    } finally {
      this.inFlight = false;
      if (!this.disposed) this.syncSubmit();
    }
  }

  private renderDate(): void {
    const card = this.dateEl;
    if (!card) return;
    card.empty();
    const row = card.createDiv({ cls: 'mp-form-row' });
    setIcon(row.createSpan({ cls: 'mp-form-row-icon', attr: { 'aria-hidden': 'true' } }), 'calendar');
    const labelId = `mp-note-form-date-${Math.random().toString(36).slice(2, 8)}`;
    row.createSpan({ cls: 'mp-form-row-label', text: t('notes.fields.date'), attr: { id: labelId } });
    const value = row.createDiv({ cls: 'mp-form-row-value' });
    const date = this.state.date;
    const language = this.deps.format.get().language;
    const pill = value.createEl('button', {
      cls: date === null ? 'mp-form-pill mp-form-pill-add' : 'mp-form-pill',
      text: date === null ? t('notes.addDate') : shortDateLabel(language, date),
      attr: {
        type: 'button',
        'aria-expanded': String(this.calendarOpen),
        'aria-describedby': labelId,
        'aria-label': date === null ? t('notes.addDate') : `${t('notes.chooseDate')}: ${shortDateLabel(language, date)}`,
      },
    });
    pill.addEventListener('click', () => {
      this.calendarOpen = !this.calendarOpen;
      this.renderDate();
    });
    if (date !== null) {
      const clear = value.createEl('button', {
        cls: 'mp-icon-button mp-form-clear',
        attr: { type: 'button', 'aria-label': t('notes.clearDate'), title: t('notes.clearDate') },
      });
      setIcon(clear, 'x-circle');
      clear.addEventListener('click', () => {
        this.calendarOpen = false;
        this.state = { ...this.state, date: null };
        this.renderDate();
      });
    }
    if (!this.calendarOpen) return;
    const holder = card.createDiv({ cls: 'mp-task-form-calendar' });
    const format = this.deps.format.get();
    this.deps.datePicker(holder, {
      value: date,
      today: localDateOf(this.deps.clock.now(), this.deps.clock.timeZone()),
      weekStart: format.weekStart,
      language: format.language,
      quickOptions: true,
      onChange: (next) => {
        this.calendarOpen = false;
        this.state = { ...this.state, date: next };
        this.renderDate();
      },
    });
    holder.addEventListener('keydown', (evt: KeyboardEvent) => {
      if (evt.key !== 'Escape') return;
      evt.preventDefault();
      evt.stopPropagation();
      this.calendarOpen = false;
      this.renderDate();
    });
  }
}
