import { describe, expect, it, vi } from 'vitest';
import { MockElement } from '../__mocks__/obsidian';
import { renderDeleteButton } from '../../src/ui/controls/delete-button';

function setup(result: boolean | Error) {
  const parent = new MockElement();
  const onDelete = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const handle = renderDeleteButton(parent as unknown as HTMLElement, {
    label: 'Удалить',
    ariaLabel: 'Удалить задачу',
    confirmLabel: 'Нажмите ещё раз, чтобы удалить',
    onDelete,
  });
  const button = parent.findAllByClass('mp-form-delete')[0];
  if (!button) throw new Error('нет кнопки «Удалить»');
  const label = () => button.findAllByClass('mp-form-delete-label')[0]?.getText();
  return { parent, handle, button, label, onDelete };
}

describe('кнопка «Удалить» формы (доработка 005, §2)', () => {
  it('значок trash-2, текст «Удалить», подпись для диктора', () => {
    const { button, label } = setup(true);
    expect(button.findAllByClass('mp-form-delete-icon')[0]?.getAttribute('data-icon')).toBe('trash-2');
    expect(label()).toBe('Удалить');
    expect(button.getAttribute('aria-label')).toBe('Удалить задачу');
  });

  it('первое нажатие просит подтверждения, второе удаляет', async () => {
    const { button, label, onDelete, handle } = setup(true);
    button.dispatch('click');
    expect(onDelete).not.toHaveBeenCalled();
    expect(handle.isArmed()).toBe(true);
    expect(button.hasClass('is-armed')).toBe(true);
    expect(label()).toBe('Нажмите ещё раз, чтобы удалить');
    button.dispatch('click');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    // Повторные нажатия во время удаления игнорируются.
    button.dispatch('click');
    expect(onDelete).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.isDeleting()).toBe(false);
  });

  it('неудача — кнопка снова «Удалить» и доступна', async () => {
    const { button, label, handle } = setup(false);
    button.dispatch('click');
    button.dispatch('click');
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(handle.isArmed()).toBe(false);
    expect(label()).toBe('Удалить');
  });

  it('исключение не ломает кнопку', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { button, label } = setup(new Error('boom'));
    button.dispatch('click');
    button.dispatch('click');
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(label()).toBe('Удалить');
  });
});
