import { describe, expect, it, vi } from 'vitest';
import { ObservableDeferredDeletes, deleteWithUndo } from '../../src/app/pending-deletes';
import { pushErrorHaptic, wallpaperHapticFor } from '../../src/app/compose-planner';
import type { DeferredTimers } from '../../src/tasks/deferred-delete';
import type { HapticKind } from '../../src/ui/haptics';

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const timers: DeferredTimers = {
    set: (run) => {
      const id = next++;
      pending.set(id, run);
      return id;
    },
    clear: (id) => void pending.delete(id),
  };
  const fire = (): void => {
    for (const [id, run] of [...pending]) {
      pending.delete(id);
      run();
    }
  };
  return { timers, fire, pending };
}

describe('общая очередь отложенных удалений (006, §12)', () => {
  it('сообщает об изменениях: запланировано, отменено, выполнено', () => {
    const { timers, fire } = fakeTimers();
    const queue = new ObservableDeferredDeletes(timers);
    const changes = vi.fn();
    queue.onChange(changes);
    const run = vi.fn();
    queue.schedule('a', run);
    expect(queue.has('a')).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(queue.undo('a')).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(queue.undo('a')).toBe(false);
    queue.schedule('b', run);
    fire();
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.has('b')).toBe(false);
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it('flush выполняет ожидающие удаления сразу', () => {
    const { timers } = fakeTimers();
    const queue = new ObservableDeferredDeletes(timers);
    const run = vi.fn();
    queue.schedule('a', run);
    queue.flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.size).toBe(0);
  });

  it('deleteWithUndo: уведомление с «Вернуть», delete → undo, ошибка удаления — уведомление и error', async () => {
    const { timers, fire } = fakeTimers();
    const pending = new ObservableDeferredDeletes(timers);
    const haptics: HapticKind[] = [];
    const shown: string[] = [];
    const actions: Array<{ message: string; label: string; run(): void; timeout?: number }> = [];
    const notifier = {
      show: (message: string) => shown.push(message),
      showAction: (message: string, action: { label: string; run(): void }, timeout?: number) => actions.push({ message, ...action, timeout }),
    };
    const remove = vi.fn(async () => ({ ok: false as const, error: { code: 'trash-failed' as const } }));
    deleteWithUndo(
      { pending, notifier, haptic: (kind) => haptics.push(kind) },
      { id: 'x', remove, message: 'Событие удалено', undoLabel: 'Вернуть', errorMessage: () => 'Не удалось' },
    );
    expect(actions[0]).toMatchObject({ message: 'Событие удалено', label: 'Вернуть', timeout: 5000 });
    expect(haptics).toEqual(['delete']);
    fire();
    await vi.waitFor(() => expect(shown).toEqual(['Не удалось']));
    expect(haptics).toEqual(['delete', 'error']);
  });

  it('без showAction — обычное уведомление', () => {
    const { timers } = fakeTimers();
    const shown: string[] = [];
    deleteWithUndo(
      { pending: new ObservableDeferredDeletes(timers), notifier: { show: (m: string) => shown.push(m) } },
      { id: 'x', remove: async () => ({ ok: true, changed: true, value: undefined }), message: 'Задача удалена', undoLabel: 'Вернуть', errorMessage: () => '' },
    );
    expect(shown).toEqual(['Задача удалена']);
  });
});

describe('вибрация итогов (006, §10)', () => {
  it('обновление экрана блокировки: успех и ошибка — только после запуска', () => {
    expect(wallpaperHapticFor('rendering', 'confirmed')).toBe('success');
    expect(wallpaperHapticFor('launched', 'confirmed')).toBe('success');
    expect(wallpaperHapticFor('rendering', 'saved')).toBe('success');
    expect(wallpaperHapticFor('rendering', 'failed')).toBe('error');
    expect(wallpaperHapticFor('idle', 'confirmed')).toBeNull();
    expect(wallpaperHapticFor('rendering', 'launched')).toBeNull();
  });

  it('ошибка адресной отправки — error; «не настроено» и успех — без отклика', () => {
    expect(pushErrorHaptic({ pushing: true }, { pushing: false, error: { kind: 'network', detail: '' } })).toBe(true);
    expect(pushErrorHaptic({ pushing: true }, { pushing: false, error: { kind: 'not-configured', detail: '' } })).toBe(false);
    expect(pushErrorHaptic({ pushing: true }, { pushing: false, error: null })).toBe(false);
    expect(pushErrorHaptic({ pushing: false }, { pushing: false, error: { kind: 'network', detail: '' } })).toBe(false);
  });
});
