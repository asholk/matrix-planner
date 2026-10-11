import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockElement } from '../__mocks__/obsidian';
import { setLanguageOverride } from '../../src/i18n';
import type { SheetHandle, SheetOptions, TaskService } from '../../src/app/contracts';
import type { Task } from '../../src/model/types';
import { defaultMatrixConfig } from '../../src/model/defaults';
import { createDefaultSettings } from '../../src/settings/defaults';
import { openTaskForm, type TaskFormDeps } from '../../src/tasks/task-form';
import type { HapticKind } from '../../src/ui/haptics';

const TASK = {
  kind: 'task',
  id: '01JTASK00000000000000000001',
  path: 'Планировщик/Задачи/Поездка.md',
  title: 'Поездка',
  quadrant: 'do',
  due: null,
  repeat: 'none',
  remind: 'none',
  priority: 'normal',
} as unknown as Task;

function harness(body: string | null) {
  const content = new MockElement();
  const haptics: HapticKind[] = [];
  let resolveBody: (value: string) => void = () => undefined;
  const bodyPromise = new Promise<string>((resolve) => (resolveBody = resolve));
  if (body !== null) resolveBody(body);
  const tasks = {
    create: vi.fn(async () => ({ ok: true as const, changed: true, value: null })),
    update: vi.fn(async () => ({ ok: true as const, changed: true, value: undefined })),
    delete: vi.fn(async () => ({ ok: true as const, changed: true, value: undefined })),
  };
  let opened: SheetOptions | null = null;
  const deps = {
    tasks: tasks as unknown as TaskService,
    index: { getById: (id: string) => (id === TASK.id ? TASK : undefined), getMatrix: () => defaultMatrixConfig('ru') },
    repository: { readBody: async () => ({ ok: true, changed: false, value: await bodyPromise }) },
    sheets: {
      open: (options: SheetOptions): SheetHandle => {
        opened = options;
        const handle: SheetHandle = { setSubmitEnabled: () => undefined, setBusy: () => undefined, submit: vi.fn(), close: vi.fn(), requestClose: vi.fn(async () => true) };
        options.render(content as unknown as HTMLElement, handle);
        return handle;
      },
    },
    datePicker: () => ({ setValue: () => undefined, destroy: () => undefined }),
    clock: { now: () => new Date('2026-10-11T09:00:00Z'), timeZone: () => 'Europe/Moscow' },
    format: { get: () => ({ language: 'ru', weekStart: 1, hour12: false }) },
    notifier: { show: () => undefined, showAction: () => undefined },
    settings: { get: () => createDefaultSettings() },
    platform: { isMobile: true },
    haptics: { play: (kind: HapticKind) => haptics.push(kind) },
  } as unknown as TaskFormDeps;
  return {
    deps,
    content,
    haptics,
    tasks,
    resolveBody,
    submit: () => opened?.onSubmit?.(),
    textarea: () => content.findAllByClass('mp-task-form-body')[0],
    items: () => content.findAllByClass('mp-task-form-checklist-item'),
    section: () => content.findAllByClass('mp-task-form-checklist')[0],
    addInput: () => content.findAllByClass('mp-task-form-checklist-add-input')[0],
  };
}

function enter(input: MockElement): void {
  input.dispatch('keydown', { key: 'Enter', isComposing: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault: () => undefined, stopPropagation: () => undefined });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

beforeEach(() => setLanguageOverride('ru'));
afterEach(() => setLanguageOverride(null));

describe('форма задачи: чек-лист (доработка 008)', () => {
  it('показывает пункты из тела; переключение меняет тело и поле «Заметки»', async () => {
    const h = harness('Описание\n- [ ] Паспорт\n- [x] Билеты\n');
    openTaskForm(h.deps, { mode: 'edit', id: TASK.id });
    await flush();

    expect(h.section().hasClass('is-disabled')).toBe(false);
    const items = h.items();
    expect(items).toHaveLength(2);
    expect(items[1]?.hasClass('is-checked')).toBe(true);
    expect(h.content.findAllByClass('mp-task-form-checklist-progress')[0]?.getText()).toBe('1/2');

    const check = items[0]?.findAllByClass('mp-task-form-checklist-check')[0];
    expect(check?.getAttribute('aria-checked')).toBe('false');
    check?.click();
    expect(h.textarea().value).toBe('Описание\n- [x] Паспорт\n- [x] Билеты\n');
    expect(h.haptics).toContain('select');
    expect(h.items()[0]?.hasClass('is-checked')).toBe(true);
    expect(h.content.findAllByClass('mp-task-form-checklist-progress')[0]?.hasClass('is-complete')).toBe(true);

    // «Готово» сохраняет новое тело.
    await h.submit();
    expect(h.tasks.update).toHaveBeenCalledWith(TASK.id, expect.objectContaining({ body: 'Описание\n- [x] Паспорт\n- [x] Билеты\n' }));
  });

  it('добавление по Enter и удаление пункта', async () => {
    const h = harness('Описание');
    openTaskForm(h.deps, { mode: 'edit', id: TASK.id });
    await flush();
    expect(h.items()).toHaveLength(0);

    h.addInput().value = 'Зарядка';
    enter(h.addInput());
    expect(h.textarea().value).toBe('Описание\n\n- [ ] Зарядка');
    expect(h.addInput().value).toBe('');
    expect(h.items()).toHaveLength(1);

    h.items()[0]?.findAllByClass('mp-task-form-checklist-remove')[0]?.click();
    expect(h.textarea().value).toBe('Описание\n');
    expect(h.items()).toHaveLength(0);
  });

  it('правка поля «Заметки» обновляет список; правка текста пункта меняет тело', async () => {
    const h = harness('');
    openTaskForm(h.deps, { mode: 'edit', id: TASK.id });
    await flush();
    const textarea = h.textarea();
    textarea.value = '- [ ] один\n- [ ] два';
    textarea.dispatch('input');
    expect(h.items()).toHaveLength(2);

    const text = h.items()[1]?.findAllByClass('mp-task-form-checklist-text')[0];
    expect(text?.value).toBe('два');
    if (text) {
      text.value = 'три';
      text.dispatch('change');
    }
    expect(h.textarea().value).toBe('- [ ] один\n- [ ] три');
  });

  it('пока тело не загружено — секция неактивна', async () => {
    const h = harness(null);
    openTaskForm(h.deps, { mode: 'edit', id: TASK.id });
    await flush();
    expect(h.section().hasClass('is-disabled')).toBe(true);
    expect(h.addInput().disabled).toBe(true);
    h.addInput().value = 'Пункт';
    enter(h.addInput());
    expect(h.textarea().value).toBe('');

    h.resolveBody('- [ ] a');
    await flush();
    expect(h.section().hasClass('is-disabled')).toBe(false);
    expect(h.items()).toHaveLength(1);
  });

  it('новая задача: секция есть и пишет в тело', async () => {
    const h = harness('');
    openTaskForm(h.deps, { mode: 'create', quadrant: 'plan' });
    expect(h.section()).toBeDefined();
    h.addInput().value = 'Первый';
    enter(h.addInput());
    expect(h.textarea().value).toBe('- [ ] Первый');
  });
});
