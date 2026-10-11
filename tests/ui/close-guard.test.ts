import { describe, expect, it, vi } from 'vitest';
import { MockElement } from '../__mocks__/obsidian';
import { createCloseGuard } from '../../src/ui/controls/form-sheet';
import { renderDeleteButton } from '../../src/ui/controls/delete-button';
import type { HapticKind } from '../../src/ui/haptics';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('защита черновика листа (006, §6)', () => {
  it('неизменённая форма закрывается сразу, без вопроса', async () => {
    const close = vi.fn();
    const confirm = vi.fn(async () => true);
    const guard = createCloseGuard({ isDirty: () => false, confirm, close });
    await expect(guard.request()).resolves.toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('без isDirty — тоже сразу', async () => {
    const close = vi.fn();
    const guard = createCloseGuard({ confirm: async () => false, close });
    await expect(guard.request()).resolves.toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('изменённая форма: «Сбросить» закрывает, отклик warning', async () => {
    const close = vi.fn();
    const haptics: HapticKind[] = [];
    const guard = createCloseGuard({ isDirty: () => true, confirm: async () => true, close, haptic: (kind) => haptics.push(kind) });
    await expect(guard.request()).resolves.toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(haptics).toEqual(['warning']);
  });

  it('«Продолжить правку» оставляет лист открытым', async () => {
    const close = vi.fn();
    const guard = createCloseGuard({ isDirty: () => true, confirm: async () => false, close });
    await expect(guard.request()).resolves.toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('повторные попытки закрытия (Esc, касание вне листа) во время вопроса игнорируются', async () => {
    const close = vi.fn();
    const answer = deferred<boolean>();
    const confirm = vi.fn(() => answer.promise);
    const guard = createCloseGuard({ isDirty: () => true, confirm, close });
    const first = guard.request();
    expect(guard.isAsking()).toBe(true);
    await expect(guard.request()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    answer.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(guard.isAsking()).toBe(false);
  });

  it('ошибка isDirty не блокирует закрытие', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const close = vi.fn();
    const guard = createCloseGuard({
      isDirty: () => {
        throw new Error('boom');
      },
      confirm: async () => false,
      close,
    });
    await expect(guard.request()).resolves.toBe(true);
    expect(close).toHaveBeenCalled();
  });
});

describe('кнопка «Удалить» без подтверждения (006, §12)', () => {
  it('без confirmLabel удаляет с первого нажатия', async () => {
    const parent = new MockElement();
    const onDelete = vi.fn(async () => true);
    const handle = renderDeleteButton(parent as unknown as HTMLElement, { label: 'Удалить', onDelete });
    parent.findAllByClass('mp-form-delete')[0]?.dispatch('click');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(handle.isArmed()).toBe(false);
    await Promise.resolve();
  });
});
