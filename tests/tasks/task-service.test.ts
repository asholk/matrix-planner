import { beforeEach, describe, expect, it } from 'vitest';
import type { Clock, IdGenerator, NoteIndex, NoteRepository, Notifier } from '../../src/app/contracts';
import type { FrontmatterRecord, OpResult, ParsedNote, PlannerItem, Task, TaskDraft, VaultPath } from '../../src/model/types';
import { parseTask } from '../../src/model/properties';
import { errorResult, okResult } from '../../src/storage/note-repository';
import { createPlannerPaths, isUnder } from '../../src/storage/paths';
import { VaultTaskService } from '../../src/tasks/task-service';
import { errorMessage, TaskActions } from '../../src/tasks/task-actions';
import { setLanguageOverride, t } from '../../src/i18n';

// ---------------------------------------------------------------------------
// Фейки: хранилище заметок в памяти и индекс поверх настоящего разбора свойств
// ---------------------------------------------------------------------------

const paths = createPlannerPaths('Планировщик');
const TASKS = paths.tasks;

interface StoredNote {
  fm: FrontmatterRecord;
  body: string;
  mtime: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function titleOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

class FakeStore {
  readonly notes = new Map<VaultPath, StoredNote>();
  readonly trashed: VaultPath[] = [];
  readonly failNext = new Set<VaultPath>();
  writable = true;
  writes = 0;

  put(path: VaultPath, fm: FrontmatterRecord, body = ''): void {
    this.notes.set(path, { fm: clone(fm), body, mtime: 1 });
  }

  fm(path: VaultPath): FrontmatterRecord {
    const note = this.notes.get(path);
    if (!note) throw new Error(`нет заметки ${path}`);
    return note.fm;
  }

  uniquePath(folder: string, title: string): VaultPath {
    let candidate = `${folder}/${title}.md`;
    for (let n = 2; this.notes.has(candidate); n++) candidate = `${folder}/${title} (${n}).md`;
    return candidate;
  }
}

function fakeRepository(store: FakeStore): NoteRepository {
  const guard = <T = void>(): OpResult<T> | null => (store.writable ? null : errorResult<T>('read-only'));
  const fail = <T = void>(path: VaultPath): OpResult<T> | null => {
    if (!store.failNext.has(path)) return null;
    store.failNext.delete(path);
    return errorResult<T>('write-failed', 'тестовый сбой');
  };
  const relocate = (from: VaultPath, to: VaultPath): void => {
    const note = store.notes.get(from)!;
    store.notes.delete(from);
    store.notes.set(to, note);
  };
  return {
    paths,
    exists: (path) => store.notes.has(path),
    async create(request) {
      const blocked = guard<VaultPath>();
      if (blocked) return blocked;
      const path = store.uniquePath(request.folder, request.title);
      store.put(path, request.frontmatter, request.body);
      store.writes++;
      return okResult(path);
    },
    async updateFrontmatter(path, mutate) {
      const blocked = guard() ?? fail(path);
      if (blocked) return blocked;
      const note = store.notes.get(path);
      if (!note) return errorResult('not-found', path);
      const next = clone(note.fm);
      mutate(next);
      const changed = JSON.stringify(next) !== JSON.stringify(note.fm);
      if (changed) {
        note.fm = next;
        note.mtime++;
        store.writes++;
      }
      return okResult(undefined, changed);
    },
    async readBody(path) {
      const note = store.notes.get(path);
      return note ? okResult(note.body, false) : errorResult('not-found', path);
    },
    async updateBody(path, transform) {
      const blocked = guard() ?? fail(path);
      if (blocked) return blocked;
      const note = store.notes.get(path);
      if (!note) return errorResult('not-found', path);
      const next = transform(note.body);
      const changed = next !== note.body;
      note.body = next;
      return okResult(undefined, changed);
    },
    async rename(path, newTitle) {
      const blocked = guard<VaultPath>() ?? fail<VaultPath>(path);
      if (blocked) return blocked;
      if (!store.notes.has(path)) return errorResult('not-found', path);
      if (titleOf(path) === newTitle) return okResult(path, false);
      const target = store.uniquePath(folderOf(path), newTitle);
      relocate(path, target);
      return okResult(target);
    },
    async move(path, folder) {
      const blocked = guard<VaultPath>() ?? fail<VaultPath>(path);
      if (blocked) return blocked;
      if (!store.notes.has(path)) return errorResult('not-found', path);
      if (folderOf(path) === folder) return okResult(path, false);
      const target = store.uniquePath(folder, titleOf(path));
      relocate(path, target);
      return okResult(target);
    },
    async trash(path) {
      const blocked = guard();
      if (blocked) return blocked;
      if (store.failNext.delete(path)) return errorResult('trash-failed', 'тестовый сбой');
      if (!store.notes.has(path)) return errorResult('not-found', path);
      store.notes.delete(path);
      store.trashed.push(path);
      return okResult(undefined);
    },
    ensureFolder: async () => okResult(undefined, false),
    listFolder: async () => okResult({ files: [], folders: [] }, false),
    readBinary: async (path) => errorResult('not-found', path),
    writeBinary: async () => okResult(undefined),
  };
}

/** Индекс: разбирает хранилище настоящим `parseTask`. `freeze()` — устаревший снимок. */
class FakeIndex implements NoteIndex {
  ready = true;
  frozen: ParsedNote[] | null = null;
  readonly waits: Array<{ path: VaultPath; matched: boolean }> = [];

  constructor(private readonly store: FakeStore) {}

  private parseAll(): ParsedNote[] {
    if (this.frozen) return this.frozen;
    return [...this.store.notes.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, note]) =>
        parseTask({
          path,
          title: titleOf(path),
          mtime: note.mtime,
          frontmatter: clone(note.fm),
          archived: isUnder(path, paths.archiveRoot),
          deletedInCalendar: false,
        }),
      );
  }

  freeze(): void {
    this.frozen = this.parseAll();
  }

  isReady = () => this.ready;
  whenReady = async () => {};
  getTasks = () => this.parseAll().filter((n): n is Task => n.kind === 'task');
  getEvents = () => [];
  getNotes = () => [];
  getInvalid = () => [];
  getMatrix = () => {
    throw new Error('не нужно в тестах');
  };
  getById = (id: string) => this.getTasks().find((task) => task.id === id) as PlannerItem | undefined;
  getAllById = (id: string) => this.getTasks().filter((task) => task.id === id);
  getByPath = (path: string) => this.parseAll().find((n) => n.path === path) as never;
  onChange = () => () => {};
  rebuild = async () => {};

  async waitFor(path: VaultPath, predicate?: (item: ParsedNote) => boolean): Promise<ParsedNote | null> {
    const item = this.parseAll().find((n) => n.path === path) ?? null;
    this.waits.push({ path, matched: item !== null && (predicate ? predicate(item) : true) });
    return item;
  }
}

const NOW = new Date(Date.UTC(2026, 9, 10, 13, 20));
const clock: Clock = { now: () => NOW, timeZone: () => 'UTC' };

function idGenerator(): IdGenerator {
  let n = 0;
  return { next: () => `01J00000000000000000000${String(++n).padStart(3, '0')}` };
}

const ID = '01JA7Q3K8Z6Y2V5N4M0C1B2D3E';

function taskFm(extra: FrontmatterRecord = {}): FrontmatterRecord {
  return {
    type: 'task',
    id: ID,
    quadrant: 'do',
    due: '2026-10-10',
    repeat: 'none',
    repeat_anchor: null,
    remind: 'none',
    priority: 'normal',
    done: false,
    completed: null,
    completions: [],
    created: '2026-10-01T10:00',
    custom_field: 'оставить',
    ...extra,
  };
}

function setup() {
  const store = new FakeStore();
  const index = new FakeIndex(store);
  const service = new VaultTaskService({ repository: fakeRepository(store), index, clock, ids: idGenerator() });
  return { store, index, service };
}

function expectOk<T>(result: OpResult<T>): { value: T; changed: boolean } {
  if (!result.ok) throw new Error(`ожидался успех: ${result.error.code} ${result.error.detail ?? ''}`);
  return result;
}

function expectError(result: OpResult<unknown>, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

const PATH = `${TASKS}/Стоматолог.md`;

const draft: TaskDraft = {
  title: '  Стоматолог ',
  body: 'Взять полис',
  quadrant: 'plan',
  due: { date: '2026-10-11', time: '09:00' },
  repeat: 'weekly',
  remind: 'at',
  priority: 'high',
  duration: null,
};

// ---------------------------------------------------------------------------

describe('TaskService.create', () => {
  it('создаёт заметку в «Задачах» со свойствами из формы и ждёт индекс', async () => {
    const { store, index, service } = setup();
    const result = expectOk(await service.create(draft));
    expect(result.changed).toBe(true);
    const task = result.value;
    expect(task?.path).toBe(PATH);
    expect(task?.id).toBe('01J00000000000000000000001');
    const fm = store.fm(PATH);
    expect(fm).toMatchObject({
      type: 'task',
      quadrant: 'plan',
      due: '2026-10-11T09:00',
      repeat: 'weekly',
      repeat_anchor: '2026-10-11',
      remind: 'at',
      priority: 'high',
      done: false,
      completions: [],
      created: '2026-10-10T13:20',
    });
    expect(store.notes.get(PATH)?.body).toBe('Взять полис');
    expect(index.waits.at(-1)).toEqual({ path: PATH, matched: true });
  });

  it('без срока сбрасывает повтор и напоминание', async () => {
    const { store, service } = setup();
    expectOk(await service.create({ ...draft, due: null }));
    expect(store.fm(PATH)).toMatchObject({ due: null, repeat: 'none', remind: 'none', repeat_anchor: null });
  });

  it('отклоняет пустое название и неверную дату', async () => {
    const { store, service } = setup();
    expectError(await service.create({ ...draft, title: '   ' }), 'invalid');
    expectError(await service.create({ ...draft, due: { date: '2026-02-30', time: null } }), 'invalid');
    expect(store.notes.size).toBe(0);
  });

  it('при запрете записи возвращает read-only', async () => {
    const { store, service } = setup();
    store.writable = false;
    expectError(await service.create(draft), 'read-only');
  });
});

describe('TaskService.complete', () => {
  it('неповторяющаяся: выполнение и повторное выполнение без лишней записи', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm());
    const first = expectOk(await service.complete(ID));
    expect(first.changed).toBe(true);
    expect(store.fm(PATH)).toMatchObject({ done: true, completed: '2026-10-10T13:20', custom_field: 'оставить' });

    const writes = store.writes;
    const second = expectOk(await service.complete(ID));
    expect(second.changed).toBe(false);
    expect(store.writes).toBe(writes);
  });

  it('повторяющаяся: дата добавляется в completions, срок переносится; повтор той же даты пропускается', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm({ due: '2026-10-10T09:00', repeat: 'daily', repeat_anchor: '2026-10-01' }));
    expectOk(await service.complete(ID, '2026-10-10'));
    expect(store.fm(PATH)).toMatchObject({ completions: ['2026-10-10'], due: '2026-10-11T09:00', done: false });

    const again = expectOk(await service.complete(ID, '2026-10-10'));
    expect(again.changed).toBe(false);
    expect(store.fm(PATH).completions).toEqual(['2026-10-10']);
  });

  it('устаревшее действие сверяется с файлом, а не со снимком индекса', async () => {
    const { store, index, service } = setup();
    store.put(PATH, taskFm({ due: '2026-10-10', repeat: 'daily', repeat_anchor: '2026-10-10' }));
    index.freeze();
    // Другое устройство уже выполнило повторение 10-го; индекс ещё не обновлён.
    store.fm(PATH).completions = ['2026-10-10'];
    store.fm(PATH).due = '2026-10-11';

    const repeated = expectOk(await service.complete(ID, '2026-10-10'));
    expect(repeated.changed).toBe(false);
    expect(store.fm(PATH).completions).toEqual(['2026-10-10']);

    // Повторение раньше текущего срока уже пропущено.
    expectError(await service.complete(ID, '2026-10-09'), 'stale');
  });

  it('заметку подменили другой задачей — stale без записи', async () => {
    const { store, index, service } = setup();
    store.put(PATH, taskFm());
    index.freeze();
    store.fm(PATH).id = '01JB0000000000000000000000';
    expectError(await service.complete(ID), 'stale');
    expect(store.fm(PATH).done).toBe(false);
  });

  it('отказ записи: ошибка write-failed, файл не меняется', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm());
    store.failNext.add(PATH);
    expectError(await service.complete(ID), 'write-failed');
    expect(store.fm(PATH).done).toBe(false);
    // Следующая попытка проходит.
    expect(expectOk(await service.complete(ID)).changed).toBe(true);
  });

  it('неизвестный id — not-found; индекс не готов — not-ready', async () => {
    const { index, service } = setup();
    expectError(await service.complete('01JZZZZZZZZZZZZZZZZZZZZZZZ'), 'not-found');
    index.ready = false;
    expectError(await service.complete(ID), 'not-ready');
  });
});

describe('TaskService.uncomplete', () => {
  it('неповторяющаяся: снимает отметку; повтор — пропуск', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm({ done: true, completed: '2026-10-09T18:00' }));
    expect(expectOk(await service.uncomplete(ID)).changed).toBe(true);
    expect(store.fm(PATH)).toMatchObject({ done: false, completed: null });
    expect(expectOk(await service.uncomplete(ID)).changed).toBe(false);
  });

  it('повторяющаяся: дата убирается из completions, срок возвращается на неё', async () => {
    const { store, service } = setup();
    store.put(
      PATH,
      taskFm({ due: '2026-10-12T09:00', repeat: 'daily', repeat_anchor: '2026-10-01', completions: ['2026-10-10', '2026-10-11'] }),
    );
    expectOk(await service.uncomplete(ID, '2026-10-10'));
    expect(store.fm(PATH)).toMatchObject({ completions: ['2026-10-11'], due: '2026-10-10T09:00' });
  });
});

describe('TaskService.update', () => {
  it('переименование меняет имя файла, id сохраняется', async () => {
    const { store, index, service } = setup();
    store.put(PATH, taskFm(), 'старое тело');
    const result = expectOk(await service.update(ID, { title: 'Стоматолог в 9', body: 'новое тело' }));
    expect(result.changed).toBe(true);
    const renamed = `${TASKS}/Стоматолог в 9.md`;
    expect(store.notes.has(PATH)).toBe(false);
    expect(store.fm(renamed).id).toBe(ID);
    expect(store.notes.get(renamed)?.body).toBe('новое тело');
    expect(index.getById(ID)?.path).toBe(renamed);
    expect(index.waits.at(-1)?.path).toBe(renamed);
  });

  it('то же название и те же свойства — без изменений', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm());
    const result = expectOk(await service.update(ID, { title: 'Стоматолог', quadrant: 'do' }));
    expect(result.changed).toBe(false);
  });

  it('смена даты в форме переносит якорь серии', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm({ due: '2026-10-10', repeat: 'monthly', repeat_anchor: '2026-08-31' }));
    expectOk(await service.update(ID, { due: { date: '2026-10-15', time: '10:00' } }));
    expect(store.fm(PATH)).toMatchObject({ due: '2026-10-15T10:00', repeat_anchor: '2026-10-15' });
  });

  it('очистка срока сбрасывает повтор и напоминание', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm({ due: '2026-10-10', repeat: 'weekly', repeat_anchor: '2026-10-10', remind: '1h' }));
    expectOk(await service.update(ID, { due: null }));
    expect(store.fm(PATH)).toMatchObject({ due: null, repeat: 'none', remind: 'none', repeat_anchor: null });
    expect(store.fm(PATH).custom_field).toBe('оставить');
  });

  it('длительность: записывается, общая для серии; null удаляет свойство; неверная — invalid', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm({ due: '2026-10-10T18:00', repeat: 'weekly', repeat_anchor: '2026-10-10' }));
    expect('duration' in store.fm(PATH)).toBe(false);
    expectOk(await service.update(ID, { duration: 90 }));
    expect(store.fm(PATH)).toMatchObject({ duration: 90, repeat: 'weekly', repeat_anchor: '2026-10-10', due: '2026-10-10T18:00' });
    expectOk(await service.update(ID, { duration: null }));
    expect('duration' in store.fm(PATH)).toBe(false);
    expectError(await service.update(ID, { duration: 3 }), 'invalid');
  });

  it('новая задача без длительности не получает свойство duration; с длительностью — получает', async () => {
    const { store, service } = setup();
    expectOk(await service.create(draft));
    expect('duration' in store.fm(PATH)).toBe(false);
    expectOk(await service.create({ ...draft, title: 'Танцы', duration: 90 }));
    expect(store.fm(`${TASKS}/Танцы.md`).duration).toBe(90);
  });

  it('отклоняет неверный квадрант', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm());
    expectError(await service.update(ID, { quadrant: 'later' as never }), 'invalid');
  });
});

describe('TaskService: перенос и квадрант', () => {
  it('перенос из меню не меняет якорь, время сохраняется', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm({ due: '2026-10-10T09:00', repeat: 'weekly', repeat_anchor: '2026-10-03' }));
    expectOk(await service.reschedule(ID, '2026-10-12'));
    expect(store.fm(PATH)).toMatchObject({ due: '2026-10-12T09:00', repeat_anchor: '2026-10-03' });
    expect(expectOk(await service.reschedule(ID, '2026-10-12')).changed).toBe(false);
  });

  it('«Перенести на завтра» — от сегодняшнего дня, а не от срока', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm({ due: '2026-10-05T09:00' }));
    expectOk(await service.postponeToTomorrow(ID));
    expect(store.fm(PATH).due).toBe('2026-10-11T09:00');
  });

  it('перенос в квадрант; тот же квадрант — пропуск', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm());
    expect(expectOk(await service.moveToQuadrant(ID, 'someday')).changed).toBe(true);
    expect(store.fm(PATH).quadrant).toBe('someday');
    expect(expectOk(await service.moveToQuadrant(ID, 'someday')).changed).toBe(false);
  });
});

describe('TaskService.delete', () => {
  it('удаляет через корзину', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm());
    expectOk(await service.delete(ID));
    expect(store.trashed).toEqual([PATH]);
    expect(store.notes.has(PATH)).toBe(false);
    expectError(await service.delete(ID), 'not-found');
  });

  it('сбой корзины возвращает ошибку', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm());
    store.failNext.add(PATH);
    expectError(await service.delete(ID), 'trash-failed');
    expect(store.notes.has(PATH)).toBe(true);
  });
});

describe('TaskService.getCompletions', () => {
  it('выполненные задачи и каждое выполненное повторение', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm({ done: true, completed: '2026-10-09T18:00' }));
    store.put(`${TASKS}/Зарядка.md`, taskFm({ id: '01JC0000000000000000000000', due: '2026-10-12', repeat: 'daily', repeat_anchor: '2026-10-01', completions: ['2026-10-10', '2026-10-11'] }));
    const entries = service.getCompletions();
    expect(entries.map((e) => [e.date, e.instanceDate])).toEqual([
      ['2026-10-11', '2026-10-11'],
      ['2026-10-10', '2026-10-10'],
      ['2026-10-09', null],
    ]);
  });
});

describe('TaskActions', () => {
  beforeEach(() => setLanguageOverride('ru'));

  function withActions() {
    const env = setup();
    const messages: string[] = [];
    const notifier: Notifier = { show: (message) => messages.push(message) };
    const archive = {
      runAuto: async () => okResult(2),
      archive: async () => okResult(undefined),
      restore: async () => okResult(undefined),
    };
    const actions = new TaskActions({ tasks: env.service, archive, notifier, log: () => {} });
    return { ...env, actions, messages };
  }

  it('ошибка показывается локализованным сообщением, результат возвращается', async () => {
    const { actions, messages } = withActions();
    const result = await actions.complete('01JZZZZZZZZZZZZZZZZZZZZZZZ');
    expectError(result, 'not-found');
    expect(messages).toEqual([t('common.errors.notFound')]);
  });

  it('успешный перенос на завтра сообщает о результате, пропуск — молча', async () => {
    const { store, actions, messages } = withActions();
    store.put(PATH, taskFm({ due: '2026-10-05' }));
    await actions.postponeToTomorrow(ID);
    expect(messages).toEqual([t('taskActions.done.postponed')]);
    await actions.postponeToTomorrow(ID);
    expect(messages).toHaveLength(1);
  });

  it('выполнение без сообщения, удаление — с сообщением', async () => {
    const { store, actions, messages } = withActions();
    store.put(PATH, taskFm());
    await actions.complete(ID);
    expect(messages).toEqual([]);
    await actions.delete(ID);
    expect(messages).toEqual([t('taskActions.done.deleted')]);
  });

  it('автоархив сообщает число перенесённых задач', async () => {
    const { actions, messages } = withActions();
    const result = await actions.runAutoArchive();
    expect(expectOk(result).value).toBe(2);
    expect(messages).toEqual(['Перенесено в архив 2 задачи']);
  });

  it('errorMessage: неизвестный ключ заменяется общим текстом по коду', () => {
    expect(errorMessage({ code: 'stale', messageKey: 'нет.такого.ключа' })).toBe(t('common.errors.stale'));
  });
});
