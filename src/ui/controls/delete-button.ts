/**
 * Кнопка «Удалить» внизу формы задачи и события (доработка 005, кадр 04): широкая розовая
 * кнопка со значком `trash-2`. Первое нажатие просит подтверждения («Нажмите ещё раз…»),
 * второе — удаляет. Пока идёт удаление, кнопка заблокирована; при неудаче — снова «Удалить».
 */

import { setIcon } from 'obsidian';

export interface DeleteButtonOptions {
  /** Текст кнопки: «Удалить». */
  label: string;
  /** Подпись для диктора: «Удалить задачу». */
  ariaLabel?: string;
  /** Текст после первого нажатия. */
  confirmLabel: string;
  /** Удаление; `true` — успешно (форма закрывается сама). */
  onDelete(): Promise<boolean>;
}

export interface DeleteButtonHandle {
  readonly buttonEl: HTMLButtonElement;
  isArmed(): boolean;
  isDeleting(): boolean;
}

export function renderDeleteButton(parent: HTMLElement, options: DeleteButtonOptions): DeleteButtonHandle {
  const holder = parent.createDiv({ cls: 'mp-form-actions' });
  const button = holder.createEl('button', {
    cls: 'mp-form-delete',
    attr: { type: 'button', 'aria-label': options.ariaLabel ?? options.label },
  });
  setIcon(button.createSpan({ cls: 'mp-form-delete-icon', attr: { 'aria-hidden': 'true' } }), 'trash-2');
  const text = button.createSpan({ cls: 'mp-form-delete-label', text: options.label });
  let armed = false;
  let deleting = false;

  const setArmed = (value: boolean): void => {
    armed = value;
    button.toggleClass('is-armed', value);
    text.setText(value ? options.confirmLabel : options.label);
    button.setAttr('aria-label', value ? options.confirmLabel : (options.ariaLabel ?? options.label));
  };

  button.addEventListener('click', () => {
    if (deleting) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    deleting = true;
    button.disabled = true;
    void options
      .onDelete()
      .catch((error: unknown) => {
        console.error('[matrix-planner] delete failed', error);
        return false;
      })
      .then((ok) => {
        deleting = false;
        if (ok) return;
        button.disabled = false;
        setArmed(false);
      });
  });

  return {
    buttonEl: button,
    isArmed: () => armed,
    isDeleting: () => deleting,
  };
}
