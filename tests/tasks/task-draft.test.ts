import { describe, expect, it, vi } from 'vitest';
import type { TaskService } from '../../src/app/contracts';
import type { OpResult, Task, TaskDraft, TaskPatch, TaskProperties } from '../../src/model/types';
import { REMIND_OFFSETS, REPEAT_RULES } from '../../src/model/types';
import {
  DEFAULT_TASK_TIME,
  REMIND_OPTIONS,
  REPEAT_OPTIONS,
  TaskDraftController,
  addTime,
  applyQuickDate,
  createDraftState,
  draftFromTask,
  fieldAvailability,
  previewPropertiesChange,
  setBody,
  setDate,
  setLoadedBody,
  setPriority,
  setQuadrant,
  setRemind,
  setRepeat,
  setTime,
  setTitle,
  toTaskDraft,
  toTaskPatch,
  validateDraft,
  type TaskDraftState,
} from '../../src/tasks/task-draft';

const TODAY = '2026-10-10';

function props(overrides: Partial<TaskProperties> = {}): TaskProperties {
  return {
    type: 'task',
    id: 'T1',
    quadrant: 'plan',
    due: '2026-10-12T09:00',
    repeat: 'weekly',
    repeat_anchor: '2026-10-05',
    remind: 'at',
    priority: 'normal',
    done: false,
    completed: null,
    completions: ['2026-10-05'],
    created: '2026-10-01T10:00',
    ...overrides,
  };
}

function task(p: TaskProperties = props()): Task {
  const due = p.due ? { date: p.due.slice(0, 10), time: p.due.length > 10 ? p.due.slice(11) : null } : null;
  return {
    kind: 'task',
    id: p.id,
    path: 'Планировщик/Задачи/Стоматолог.md',
    title: 'Стоматолог',
    mtime: 0,
    props: p,
    extra: {},
    issues: [],
    quadrant: p.quadrant,
    due,
    repeat: p.repeat,
    repeatAnchor: p.repeat_anchor ?? due?.date ?? null,
    remind: p.remind,
    priority: p.priority,
    done: p.done,
    completed: p.completed,
    completions: p.completions,
    created: p.created,
    archived: false,
  };
}

function named(state: TaskDraftState = createDraftState(), title = 'Стоматолог'): TaskDraftState {
  return setTitle(state, title);
}

function fakeService(result: OpResult<Task | null> = { ok: true, value: null, changed: true }) {
  const create = vi.fn<(draft: TaskDraft) => Promise<OpResult<Task | null>>>(async () => result);
  const update = vi.fn<(id: string, patch: TaskPatch) => Promise<OpResult>>(async () =>
    result.ok ? { ok: true, value: undefined, changed: true } : result,
  );
  const service: Pick<TaskService, 'create' | 'update'> = { create, update };
  return { service, create, update };
}

describe('task-draft: название', () => {
  it('пустое и пробельное название не проходит проверку', () => {
    expect(validateDraft(createDraftState()).errors.title).toBe('required');
    expect(validateDraft(named(createDraftState(), '   ')).valid).toBe(false);
    expect(validateDraft(named()).valid).toBe(true);
  });

  it('название обрезается при сохранении', () => {
    expect(toTaskDraft(named(createDraftState(), '  Стоматолог  ')).title).toBe('Стоматолог');
  });

  it('контроллер не сохраняет задачу без названия', async () => {
    const { service, create } = fakeService();
    const controller = new TaskDraftController(createDraftState(), service);
    expect(controller.canSubmit()).toBe(false);
    expect(await controller.submit()).toEqual({ ok: false, reason: 'invalid' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('task-draft: квадрант и день по умолчанию', () => {
  it('без контекста — «Важно и срочно», без даты, обычный приоритет', () => {
    const state = createDraftState();
    expect(state.quadrant).toBe('do');
    expect(state.date).toBeNull();
    expect(state.priority).toBe('normal');
    expect(state.repeat).toBe('none');
    expect(state.remind).toBe('none');
  });

  it('квадрант и день подставляются из контекста', () => {
    const state = createDraftState({ quadrant: 'urgent', date: '2026-10-21' });
    expect(state.quadrant).toBe('urgent');
    expect(state.date).toBe('2026-10-21');
  });

  it('null и невалидные значения контекста заменяются значениями по умолчанию', () => {
    const state = createDraftState({ quadrant: null, date: '2026-02-30' });
    expect(state.quadrant).toBe('do');
    expect(state.date).toBeNull();
  });

  it('квадрант и приоритет меняются', () => {
    const state = setPriority(setQuadrant(createDraftState(), 'someday'), true);
    expect(toTaskDraft(named(state))).toMatchObject({ quadrant: 'someday', priority: 'high' });
  });
});

describe('task-draft: дата и зависимые поля', () => {
  it('без даты время, повтор и напоминание недоступны и не меняются', () => {
    const state = createDraftState();
    expect(fieldAvailability(state)).toEqual({ time: false, repeat: false, remind: false });
    expect(setTime(state, '10:00')).toBe(state);
    expect(addTime(state)).toBe(state);
    expect(setRepeat(state, 'daily')).toBe(state);
    expect(setRemind(state, '5m')).toBe(state);
  });

  it('после выбора даты поля доступны; первая дата включает «В момент события»', () => {
    const state = setDate(createDraftState(), '2026-10-11');
    expect(fieldAvailability(state)).toEqual({ time: true, repeat: true, remind: true });
    expect(state.remind).toBe('at');
  });

  it('смена даты не трогает выбранное напоминание', () => {
    let state = setRemind(setDate(createDraftState(), '2026-10-11'), 'none');
    state = setDate(state, '2026-10-12');
    expect(state.remind).toBe('none');
  });

  it('быстрые даты: сегодня, завтра, через неделю', () => {
    const base = createDraftState();
    expect(applyQuickDate(base, 'today', TODAY).date).toBe('2026-10-10');
    expect(applyQuickDate(base, 'tomorrow', TODAY).date).toBe('2026-10-11');
    expect(applyQuickDate(base, 'nextWeek', TODAY).date).toBe('2026-10-17');
    // Через границу месяца и года.
    expect(applyQuickDate(base, 'nextWeek', '2026-12-28').date).toBe('2027-01-04');
  });

  it('очистка даты сбрасывает время, повтор и напоминание', () => {
    let state = setDate(named(), '2026-10-11');
    state = setRemind(setRepeat(setTime(state, '09:00'), 'monthly'), '1h');
    state = setDate(state, null);
    expect(state).toMatchObject({ date: null, time: null, repeat: 'none', remind: 'none' });
    expect(toTaskDraft(state)).toMatchObject({ due: null, repeat: 'none', remind: 'none' });
  });

  it('невалидная дата игнорируется', () => {
    const state = setDate(createDraftState(), '2026-10-11');
    expect(setDate(state, '2026-13-01')).toBe(state);
  });
});

describe('task-draft: время', () => {
  it('время сохраняется в сроке и переживает смену даты', () => {
    let state = setTime(setDate(named(), '2026-10-11'), '17:30');
    state = setDate(state, '2026-10-16');
    expect(toTaskDraft(state).due).toEqual({ date: '2026-10-16', time: '17:30' });
  });

  it('«Добавить время» подставляет 09:00, повторно не перезаписывает', () => {
    let state = addTime(setDate(createDraftState(), '2026-10-11'));
    expect(state.time).toBe(DEFAULT_TASK_TIME);
    state = setTime(state, '12:30');
    expect(addTime(state).time).toBe('12:30');
  });

  it('невалидное время игнорируется, null убирает время', () => {
    const state = setTime(setDate(createDraftState(), '2026-10-11'), '09:00');
    expect(setTime(state, '25:00')).toBe(state);
    expect(setTime(state, null).time).toBeNull();
    expect(toTaskDraft(named(setTime(state, null))).due).toEqual({ date: '2026-10-11', time: null });
  });
});

describe('task-draft: повтор и напоминание', () => {
  it('доступны все пять вариантов повтора', () => {
    expect(REPEAT_OPTIONS).toEqual(['none', 'daily', 'weekly', 'monthly', 'yearly']);
    const dated = setDate(named(), '2026-10-11');
    for (const rule of REPEAT_RULES) expect(toTaskDraft(setRepeat(dated, rule)).repeat).toBe(rule);
  });

  it('доступны все напоминания', () => {
    expect(REMIND_OPTIONS).toEqual(['none', 'at', '5m', '15m', '30m', '1h', '1d']);
    const dated = setDate(named(), '2026-10-11');
    for (const offset of REMIND_OFFSETS) expect(toTaskDraft(setRemind(dated, offset)).remind).toBe(offset);
  });
});

describe('task-draft: редактирование', () => {
  it('без изменений патч пустой', () => {
    const state = draftFromTask(task(), 'Тело');
    expect(toTaskPatch(state)).toEqual({});
    expect(previewPropertiesChange(state, props())).toEqual({ kind: 'skip' });
  });

  it('патч содержит только изменённые поля', () => {
    let state = draftFromTask(task(), 'Тело');
    state = setPriority(setTitle(state, 'Стоматолог 2'), true);
    expect(toTaskPatch(state)).toEqual({ title: 'Стоматолог 2', priority: 'high' });
  });

  it('смена даты переносит якорь серии, время сохраняется', () => {
    const state = setDate(draftFromTask(task(), ''), '2026-10-14');
    expect(toTaskPatch(state)).toEqual({ due: { date: '2026-10-14', time: '09:00' } });
    const outcome = previewPropertiesChange(state, props());
    expect(outcome).toEqual({ kind: 'change', patch: { due: '2026-10-14T09:00', repeat_anchor: '2026-10-14' } });
  });

  it('смена правила переносит якорь на дату срока', () => {
    const state = setRepeat(draftFromTask(task(), ''), 'monthly');
    expect(previewPropertiesChange(state, props())).toEqual({
      kind: 'change',
      patch: { repeat: 'monthly', repeat_anchor: '2026-10-12' },
    });
  });

  it('правка без даты и правила не трогает якорь', () => {
    const state = setQuadrant(draftFromTask(task(), ''), 'do');
    expect(previewPropertiesChange(state, props())).toEqual({ kind: 'change', patch: { quadrant: 'do' } });
  });

  it('очистка даты у серии убирает повтор и якорь', () => {
    const state = setDate(draftFromTask(task(), ''), null);
    expect(previewPropertiesChange(state, props())).toEqual({
      kind: 'change',
      patch: { due: null, repeat: 'none', remind: 'none', repeat_anchor: null },
    });
  });

  it('до загрузки тело не меняется и не попадает в патч', () => {
    let state = draftFromTask(task(), null);
    expect(state.bodyLoaded).toBe(false);
    expect(setBody(state, 'x')).toBe(state);
    expect(toTaskPatch(state)).toEqual({});
    state = setBody(setLoadedBody(state, 'Старое'), 'Новое');
    expect(toTaskPatch(state)).toEqual({ body: 'Новое' });
  });
});

describe('task-draft: сохранение', () => {
  it('создание передаёт черновик в TaskService.create', async () => {
    const { service, create } = fakeService();
    const state = setTime(setDate(named(createDraftState({ quadrant: 'plan' })), '2026-10-11'), '09:00');
    const controller = new TaskDraftController(state, service);
    expect(await controller.submit()).toEqual({ ok: true, changed: true, task: null });
    expect(create).toHaveBeenCalledWith({
      title: 'Стоматолог',
      body: '',
      quadrant: 'plan',
      due: { date: '2026-10-11', time: '09:00' },
      repeat: 'none',
      remind: 'at',
      priority: 'normal',
    });
  });

  it('повторное нажатие «Готово» во время и после сохранения не создаёт вторую задачу', async () => {
    const { service, create } = fakeService();
    const controller = new TaskDraftController(named(), service);
    const first = controller.submit();
    expect(controller.isBusy()).toBe(true);
    expect(controller.canSubmit()).toBe(false);
    const second = await controller.submit();
    expect(second).toEqual({ ok: false, reason: 'busy' });
    expect((await first).ok).toBe(true);
    expect(await controller.submit()).toEqual({ ok: false, reason: 'busy' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('после ошибки сохранения можно повторить', async () => {
    const failure: OpResult<Task | null> = { ok: false, error: { code: 'write-failed' } };
    const { service, create } = fakeService(failure);
    const controller = new TaskDraftController(named(), service);
    expect(await controller.submit()).toEqual({ ok: false, reason: 'error', error: { code: 'write-failed' } });
    expect(controller.canSubmit()).toBe(true);
    await controller.submit();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('исключение сервиса превращается в ошибку unknown', async () => {
    const service: Pick<TaskService, 'create' | 'update'> = {
      create: async () => {
        throw new Error('boom');
      },
      update: async () => ({ ok: true, value: undefined, changed: true }),
    };
    const result = await new TaskDraftController(named(), service).submit();
    expect(result).toMatchObject({ ok: false, reason: 'error', error: { code: 'unknown' } });
  });

  it('правка без изменений не вызывает сервис', async () => {
    const { service, update } = fakeService();
    const controller = new TaskDraftController(draftFromTask(task(), ''), service);
    expect(await controller.submit()).toEqual({ ok: true, changed: false, task: null });
    expect(update).not.toHaveBeenCalled();
  });

  it('правка передаёт патч в TaskService.update', async () => {
    const { service, update } = fakeService();
    const controller = new TaskDraftController(draftFromTask(task(), ''), service);
    controller.update((s) => setRemind(s, '1d'));
    await controller.submit();
    expect(update).toHaveBeenCalledWith('T1', { remind: '1d' });
  });

  it('слушатели получают новое состояние', () => {
    const { service } = fakeService();
    const controller = new TaskDraftController(createDraftState(), service);
    const seen: string[] = [];
    controller.onChange((s) => seen.push(s.title));
    controller.update((s) => setTitle(s, 'А'));
    controller.update((s) => s);
    expect(seen).toEqual(['А']);
  });
});
