import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockElement } from '../__mocks__/obsidian';
import { setLanguageOverride } from '../../src/i18n';
import type { SheetHandle, SheetOptions, TaskService } from '../../src/app/contracts';
import type { Task } from '../../src/model/types';
import { defaultMatrixConfig } from '../../src/model/defaults';
import { createDefaultSettings } from '../../src/settings/defaults';
import { durationLabel, isTaskDraftDirty, openTaskForm, shouldAutofocusTitle, type TaskFormDeps } from '../../src/tasks/task-form';
import { createDraftState, draftFromTask, setPriority, setQuadrant, setTitle } from '../../src/tasks/task-draft';
import { ObservableDeferredDeletes } from '../../src/app/pending-deletes';
import type { HapticKind } from '../../src/ui/haptics';

const TASK = {
  kind: 'task',
  id: '01JTASK00000000000000000001',
  path: 'Планировщик/Задачи/Позвонить.md',
  title: 'Позвонить',
  quadrant: 'do',
  due: null,
  repeat: 'none',
  remind: 'none',
  priority: 'normal',
} as unknown as Task;

interface Harness {
  deps: TaskFormDeps;
  options: () => SheetOptions;
  content: MockElement;
  handle: { submit: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; requestClose: ReturnType<typeof vi.fn> };
  haptics: HapticKind[];
  notices: string[];
  actions: Array<{ message: string; label: string; run(): void }>;
  pending: ObservableDeferredDeletes;
  tasks: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
}

function harness(platform: { isMobile: boolean } = { isMobile: true }): Harness {
  let opened: SheetOptions | null = null;
  const content = new MockElement();
  const handle = { submit: vi.fn(), close: vi.fn(), requestClose: vi.fn(async () => true) };
  const haptics: HapticKind[] = [];
  const notices: string[] = [];
  const actions: Harness['actions'] = [];
  const pending = new ObservableDeferredDeletes();
  const tasks = {
    create: vi.fn(async () => ({ ok: true as const, changed: true, value: null })),
    update: vi.fn(async () => ({ ok: true as const, changed: true, value: undefined })),
    delete: vi.fn(async () => ({ ok: true as const, changed: true, value: undefined })),
  };
  const deps = {
    tasks: tasks as unknown as TaskService,
    index: { getById: (id: string) => (id === TASK.id ? TASK : undefined), getMatrix: () => defaultMatrixConfig('ru') },
    repository: { readBody: async () => ({ ok: true, changed: false, value: '' }) },
    sheets: {
      open: (options: SheetOptions): SheetHandle => {
        opened = options;
        const sheetHandle: SheetHandle = { setSubmitEnabled: () => undefined, setBusy: () => undefined, ...handle };
        options.render(content as unknown as HTMLElement, sheetHandle);
        return sheetHandle;
      },
    },
    datePicker: () => ({ setValue: () => undefined, destroy: () => undefined }),
    clock: { now: () => new Date('2026-10-11T09:00:00Z'), timeZone: () => 'Europe/Moscow' },
    format: { get: () => ({ language: 'ru', weekStart: 1, hour12: false }) },
    notifier: {
      show: (message: string) => notices.push(message),
      showAction: (message: string, action: { label: string; run(): void }) => actions.push({ message, ...action }),
    },
    settings: { get: () => createDefaultSettings() },
    platform,
    haptics: { play: (kind: HapticKind) => haptics.push(kind) },
    pendingDeletes: pending,
  } as unknown as TaskFormDeps;
  return {
    deps,
    options: () => {
      if (!opened) throw new Error('лист не открыт');
      return opened;
    },
    content,
    handle,
    haptics,
    notices,
    actions,
    pending,
    tasks,
  };
}

function titleInput(h: Harness): MockElement {
  const input = h.content.findAllByClass('mp-task-form-title')[0];
  if (!input) throw new Error('нет поля названия');
  return input;
}

function enter(input: MockElement, extra: Partial<KeyboardEvent> = {}): { prevented: boolean } {
  const state = { prevented: false };
  input.dispatch('keydown', { key: 'Enter', isComposing: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault: () => (state.prevented = true), ...extra });
  return state;
}

beforeEach(() => setLanguageOverride('ru'));
afterEach(() => {
  setLanguageOverride(null);
  vi.useRealTimers();
});

describe('форма задачи: защита черновика (006, §6)', () => {
  it('новая задача: пустая — не изменена, любое поле — изменена', () => {
    const base = createDraftState({ quadrant: 'plan' });
    expect(isTaskDraftDirty(base, base)).toBe(false);
    expect(isTaskDraftDirty(setTitle(base, '   '), base)).toBe(false);
    expect(isTaskDraftDirty(setTitle(base, 'Купить хлеб'), base)).toBe(true);
    expect(isTaskDraftDirty(setQuadrant(base, 'do'), base)).toBe(true);
    expect(isTaskDraftDirty(setPriority(base, true), base)).toBe(true);
  });

  it('правка: без изменений — не изменена, новое название — изменена', () => {
    const base = draftFromTask(TASK, '');
    expect(isTaskDraftDirty(base, base)).toBe(false);
    expect(isTaskDraftDirty(setTitle(base, 'Позвонить маме'), base)).toBe(true);
  });

  it('лист получает isDirty: после ввода названия — true', () => {
    const h = harness();
    openTaskForm(h.deps, { mode: 'create' });
    expect(h.options().isDirty?.()).toBe(false);
    const input = titleInput(h);
    input.value = 'Купить хлеб';
    input.dispatch('input');
    expect(h.options().isDirty?.()).toBe(true);
  });
});

describe('форма задачи: Enter сохраняет (006, §9)', () => {
  it('Enter в названии — «Готово» листа, клавиша подписана done', () => {
    const h = harness();
    openTaskForm(h.deps, { mode: 'create' });
    const input = titleInput(h);
    expect(input.getAttribute('enterkeyhint')).toBe('done');
    input.value = 'Купить хлеб';
    input.dispatch('input');
    expect(enter(input).prevented).toBe(true);
    expect(h.handle.submit).toHaveBeenCalledTimes(1);
  });

  it('пустое название: Enter не сохраняет и подсвечивает поле', () => {
    const h = harness();
    openTaskForm(h.deps, { mode: 'create' });
    const input = titleInput(h);
    enter(input);
    expect(h.handle.submit).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('правка: Enter тоже сохраняет; Shift+Enter и набор IME — нет', () => {
    const h = harness();
    openTaskForm(h.deps, { mode: 'edit', id: TASK.id });
    const input = titleInput(h);
    enter(input, { shiftKey: true });
    enter(input, { isComposing: true });
    expect(h.handle.submit).not.toHaveBeenCalled();
    enter(input);
    expect(h.handle.submit).toHaveBeenCalledTimes(1);
  });
});

describe('форма задачи: автофокус (006, §10)', () => {
  it('создание — фокус; правка на телефоне — без фокуса; правка на компьютере — фокус', () => {
    expect(shouldAutofocusTitle('create', { isMobile: true })).toBe(true);
    expect(shouldAutofocusTitle('edit', { isMobile: true })).toBe(false);
    expect(shouldAutofocusTitle('edit', { isMobile: false })).toBe(true);
    expect(shouldAutofocusTitle('edit', undefined)).toBe(true);
  });

  it('правка на телефоне не ставит фокус на название', () => {
    vi.useFakeTimers();
    const h = harness({ isMobile: true });
    openTaskForm(h.deps, { mode: 'edit', id: TASK.id });
    const focus = vi.fn();
    titleInput(h).addEventListener('focus', focus);
    vi.runAllTimers();
    expect(focus).not.toHaveBeenCalled();
  });

  it('создание на телефоне ставит фокус на название', () => {
    vi.useFakeTimers();
    const h = harness({ isMobile: true });
    openTaskForm(h.deps, { mode: 'create' });
    const focus = vi.fn();
    titleInput(h).addEventListener('focus', focus);
    vi.runAllTimers();
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

describe('форма задачи: удаление одним нажатием с «Вернуть» (006, §12)', () => {
  it('лист закрывается, задача скрыта, уведомление «Задача удалена · Вернуть», через 5 с — удаление', async () => {
    vi.useFakeTimers();
    const h = harness();
    openTaskForm(h.deps, { mode: 'edit', id: TASK.id });
    const button = h.content.findAllByClass('mp-form-delete')[0];
    if (!button) throw new Error('нет кнопки «Удалить»');
    button.dispatch('click');
    await Promise.resolve();
    expect(h.handle.close).toHaveBeenCalledTimes(1);
    expect(h.pending.has(TASK.id)).toBe(true);
    expect(h.actions).toHaveLength(1);
    expect(h.actions[0]?.message).toBe('Задача удалена');
    expect(h.actions[0]?.label).toBe('Вернуть');
    expect(h.haptics).toContain('delete');
    expect(h.options().isDirty?.()).toBe(false);
    expect(h.tasks.delete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(h.tasks.delete).toHaveBeenCalledWith(TASK.id);
    expect(h.pending.has(TASK.id)).toBe(false);
  });

  it('«Вернуть» отменяет удаление, отклик undo', async () => {
    vi.useFakeTimers();
    const h = harness();
    openTaskForm(h.deps, { mode: 'edit', id: TASK.id });
    h.content.findAllByClass('mp-form-delete')[0]?.dispatch('click');
    await Promise.resolve();
    h.actions[0]?.run();
    expect(h.pending.has(TASK.id)).toBe(false);
    expect(h.haptics).toContain('undo');
    vi.advanceTimersByTime(10_000);
    expect(h.tasks.delete).not.toHaveBeenCalled();
  });
});

describe('форма задачи: вибрация (006, §10)', () => {
  it('открытие — tap, выбор квадранта — select, сохранение — success', async () => {
    const h = harness();
    openTaskForm(h.deps, { mode: 'create' });
    expect(h.haptics).toEqual(['tap']);
    const tile = h.content.findAllByClass('mp-task-form-tile').find((el) => el.getAttribute('data-quadrant') === 'someday');
    tile?.dispatch('click');
    expect(h.haptics).toEqual(['tap', 'select']);
    const input = titleInput(h);
    input.value = 'Купить хлеб';
    input.dispatch('input');
    await expect(Promise.resolve(h.options().onSubmit?.())).resolves.toBe(true);
    expect(h.haptics.at(-1)).toBe('success');
  });

  it('ошибка сохранения — error', async () => {
    const h = harness();
    h.tasks.create.mockResolvedValueOnce({ ok: false, error: { code: 'write-failed' } });
    openTaskForm(h.deps, { mode: 'create' });
    const input = titleInput(h);
    input.value = 'Купить хлеб';
    input.dispatch('input');
    await expect(Promise.resolve(h.options().onSubmit?.())).resolves.toBe(false);
    expect(h.haptics.at(-1)).toBe('error');
  });
});

describe('форма задачи: длительность (008)', () => {
  function chips(h: Harness): MockElement[] {
    return h.content.findAllByClass('mp-task-form-duration');
  }

  it('подписи вариантов: ru и en', () => {
    expect([15, 30, 45, 60, 90, 120].map(durationLabel)).toEqual(['15 мин', '30 мин', '45 мин', '1 ч', '1,5 ч', '2 ч']);
    setLanguageOverride('en');
    expect([15, 60, 90].map(durationLabel)).toEqual(['15 min', '1 h', '1.5 h']);
  });

  it('без времени строки нет; со временем — чипы, выбор с откликом select, повторное нажатие снимает выбор', async () => {
    const h = harness();
    openTaskForm(h.deps, { mode: 'create', date: '2026-10-12' });
    expect(chips(h)).toEqual([]);
    const addTime = h.content.findAllByClass('mp-form-pill-add').find((el) => el.getText() === 'Добавить время');
    addTime!.click();
    expect(chips(h).map((el) => el.getText())).toEqual(['15 мин', '30 мин', '45 мин', '1 ч', '1,5 ч', '2 ч', 'Не задано']);
    expect(chips(h).at(-1)!.classes.has('is-active')).toBe(true);

    h.haptics.length = 0;
    chips(h).find((el) => el.getText() === '1,5 ч')!.click();
    expect(h.haptics).toEqual(['select']);
    const active = chips(h).filter((el) => el.classes.has('is-active'));
    expect(active.map((el) => el.getText())).toEqual(['1,5 ч']);
    expect(active[0]?.getAttribute('aria-checked')).toBe('true');

    chips(h).find((el) => el.getText() === '1,5 ч')!.click();
    expect(chips(h).filter((el) => el.classes.has('is-active')).map((el) => el.getText())).toEqual(['Не задано']);

    chips(h).find((el) => el.getText() === '1 ч')!.click();
    const input = titleInput(h);
    input.value = 'Танцы';
    input.dispatch('input');
    expect(h.options().isDirty?.()).toBe(true);
    await h.options().onSubmit?.();
    expect(h.tasks.create).toHaveBeenCalledWith(expect.objectContaining({ due: { date: '2026-10-12', time: '09:00' }, duration: 60 }));
  });
});
