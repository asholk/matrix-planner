/**
 * Секция «Чек-лист» формы задачи (доработка 008): пункты — задачи Markdown в теле заметки.
 * Только DOM; правка текста тела — чистые функции `model/checklist`. Источник истины — тело
 * (`getBody`), изменения уходят через `onChange` (форма вызывает `setBody`).
 */

import { setIcon } from 'obsidian';
import { t } from '../i18n';
import {
  addChecklistItem,
  checklistProgress,
  formatChecklistProgress,
  isChecklistComplete,
  parseChecklist,
  removeChecklistItem,
  renameChecklistItem,
  toggleChecklistItem,
  type ChecklistItem,
} from '../model/checklist';
import type { HapticKind } from '../ui/haptics';

export interface ChecklistEditorOptions {
  getBody(): string;
  /** Тело загружено и доступно для правки. */
  isEnabled(): boolean;
  onChange(body: string): void;
  haptic?(kind: HapticKind): void;
}

export interface ChecklistEditor {
  /** Перерисовать список по текущему телу (после правки поля «Заметки» или загрузки тела). */
  refresh(): void;
}

export function renderChecklistEditor(parent: HTMLElement, options: ChecklistEditorOptions): ChecklistEditor {
  const section = parent.createDiv({ cls: 'mp-task-form-checklist', attr: { role: 'group' } });
  const header = section.createDiv({ cls: 'mp-task-form-checklist-header' });
  setIcon(header.createSpan({ cls: 'mp-task-form-checklist-icon', attr: { 'aria-hidden': 'true' } }), 'list-checks');
  const titleId = `mp-task-checklist-${Math.random().toString(36).slice(2, 8)}`;
  header.createSpan({ cls: 'mp-task-form-checklist-title', text: t('taskForm.checklist.title'), attr: { id: titleId } });
  section.setAttr('aria-labelledby', titleId);
  const progressEl = header.createSpan({ cls: 'mp-task-form-checklist-progress' });
  const list = section.createDiv({ cls: 'mp-task-form-checklist-items', attr: { role: 'list' } });

  const addRow = section.createDiv({ cls: 'mp-task-form-checklist-add' });
  setIcon(addRow.createSpan({ cls: 'mp-task-form-checklist-add-icon', attr: { 'aria-hidden': 'true' } }), 'plus');
  const addInput = addRow.createEl('input', {
    cls: 'mp-task-form-checklist-add-input',
    attr: { type: 'text', placeholder: t('taskForm.checklist.add'), 'aria-label': t('taskForm.checklist.add'), enterkeyhint: 'enter' },
  });

  const change = (next: string): void => {
    if (next === options.getBody()) return;
    options.onChange(next);
    render();
  };

  const add = (): void => {
    if (!options.isEnabled()) return;
    const text = addInput.value.trim();
    if (text === '') return;
    options.haptic?.('tap');
    addInput.value = '';
    change(addChecklistItem(options.getBody(), text));
  };
  addInput.addEventListener('keydown', (evt: KeyboardEvent) => {
    if (evt.key !== 'Enter' || evt.isComposing || evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
    // Enter добавляет пункт, а не сохраняет форму.
    evt.preventDefault();
    evt.stopPropagation();
    add();
  });

  const renderItem = (item: ChecklistItem, enabled: boolean): void => {
    const row = list.createDiv({ cls: 'mp-task-form-checklist-item', attr: { role: 'listitem', 'data-line': String(item.line) } });
    row.toggleClass('is-checked', item.checked);
    const label = item.text || t('taskForm.checklist.empty');
    const check = row.createEl('button', {
      cls: 'mp-task-form-checklist-check',
      attr: { type: 'button', role: 'checkbox', 'aria-checked': String(item.checked), 'aria-label': t('taskForm.checklist.check', { text: label }) },
    });
    check.disabled = !enabled;
    setIcon(check.createSpan({ cls: 'mp-task-form-checklist-mark', attr: { 'aria-hidden': 'true' } }), 'check');
    check.addEventListener('click', () => {
      if (!options.isEnabled()) return;
      options.haptic?.('select');
      change(toggleChecklistItem(options.getBody(), item.line));
    });

    const text = row.createEl('input', {
      cls: 'mp-task-form-checklist-text',
      attr: { type: 'text', 'aria-label': label, enterkeyhint: 'done' },
    });
    text.value = item.text;
    text.disabled = !enabled;
    text.addEventListener('keydown', (evt: KeyboardEvent) => {
      if (evt.key !== 'Enter' || evt.isComposing) return;
      evt.preventDefault();
      evt.stopPropagation();
      text.blur();
    });
    text.addEventListener('change', () => {
      if (!options.isEnabled()) return;
      // Пустой текст — пункт не меняется (удаление — кнопкой).
      if (text.value.trim() === '') {
        text.value = item.text;
        return;
      }
      change(renameChecklistItem(options.getBody(), item.line, text.value));
    });

    const remove = row.createEl('button', {
      cls: 'mp-icon-button mp-task-form-checklist-remove',
      attr: { type: 'button', 'aria-label': t('taskForm.checklist.removeItem', { text: label }), title: t('taskForm.checklist.remove') },
    });
    remove.disabled = !enabled;
    setIcon(remove, 'x');
    remove.addEventListener('click', () => {
      if (!options.isEnabled()) return;
      options.haptic?.('tap');
      change(removeChecklistItem(options.getBody(), item.line));
    });
  };

  const render = (): void => {
    const enabled = options.isEnabled();
    const items = parseChecklist(options.getBody());
    const progress = checklistProgress(items);
    section.toggleClass('is-disabled', !enabled);
    section.toggleClass('is-empty', items.length === 0);
    progressEl.setText(progress ? formatChecklistProgress(progress) : '');
    progressEl.toggleClass('is-complete', progress !== null && isChecklistComplete(progress));
    if (progress) progressEl.setAttr('aria-label', t('taskForm.checklist.progress', { done: String(progress.done), total: String(progress.total) }));
    else progressEl.removeAttribute('aria-label');
    list.empty();
    for (const item of items) renderItem(item, enabled);
    addInput.disabled = !enabled;
  };

  render();
  return { refresh: render };
}
