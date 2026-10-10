import { describe, expect, it } from 'vitest';
import type { Clock, IdGenerator, NoteIndex, NoteRepository } from '../../src/app/contracts';
import type { ArchiveSetting, FrontmatterRecord, OpResult, ParsedNote, PlannerItem, PlannerSettings, Task, VaultPath } from '../../src/model/types';
import { parseTask } from '../../src/model/properties';
import { errorResult, okResult } from '../../src/storage/note-repository';
import { createPlannerPaths, isUnder } from '../../src/storage/paths';
import { VaultTaskService } from '../../src/tasks/task-service';
import { completionDateOf, selectForAutoArchive, VaultArchiveService } from '../../src/tasks/archive-service';

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

function setup(archive: ArchiveSetting = { mode: 'after-days', days: 7 }) {
  const store = new FakeStore();
  const index = new FakeIndex(store);
  const repository = fakeRepository(store);
  const tasks = new VaultTaskService({ repository, index, clock, ids: idGenerator() });
  const settings = { get: () => ({ archive }) as unknown as PlannerSettings };
  const service = new VaultArchiveService({ repository, index, clock, settings, tasks });
  return { store, index, tasks, service };
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
const ARCHIVE_OCT = paths.archiveFor('2026-10');

function doneTask(id: string, completed: string, extra: FrontmatterRecord = {}): FrontmatterRecord {
  return taskFm({ id, done: true, completed, ...extra });
}

// ---------------------------------------------------------------------------

describe('selectForAutoArchive', () => {
  it('только выполненные неповторяющиеся задачи старше N дней', () => {
    const { store, index } = setup();
    store.put(`${TASKS}/Старая.md`, doneTask('01JD0000000000000000000001', '2026-10-03T12:00'));
    store.put(`${TASKS}/Свежая.md`, doneTask('01JD0000000000000000000002', '2026-10-08T12:00'));
    store.put(`${TASKS}/Открытая.md`, taskFm({ id: '01JD0000000000000000000003' }));
    store.put(
      `${TASKS}/Серия.md`,
      taskFm({ id: '01JD0000000000000000000004', repeat: 'daily', repeat_anchor: '2026-09-01', due: '2026-10-11', completions: ['2026-09-01'] }),
    );
    const selected = selectForAutoArchive(index.getTasks(), '2026-10-10', 7, 'UTC');
    expect(selected.map((task) => task.title)).toEqual(['Старая']);
  });

  it('дата выполнения: completed, иначе дата изменения файла', () => {
    expect(completionDateOf({ completed: '2026-09-15T08:00', mtime: 0 })).toBe('2026-09-15');
    expect(completionDateOf({ completed: null, mtime: Date.UTC(2026, 8, 1, 12) }, 'UTC')).toBe('2026-09-01');
    expect(completionDateOf({ completed: null, mtime: 0 })).toBeNull();
  });
});

describe('ArchiveService.runAuto', () => {
  it('«никогда» — ничего не переносит', async () => {
    const { store, service } = setup({ mode: 'never' });
    store.put(`${TASKS}/Старая.md`, doneTask(ID, '2026-01-01T12:00'));
    const result = expectOk(await service.runAuto());
    expect(result).toMatchObject({ value: 0, changed: false });
    expect(store.notes.has(`${TASKS}/Старая.md`)).toBe(true);
  });

  it('переносит в папку месяца выполнения; повторный запуск ничего не меняет', async () => {
    const { store, index, service } = setup();
    store.put(`${TASKS}/Старая.md`, doneTask(ID, '2026-10-02T12:00'), 'тело');
    store.put(`${TASKS}/Свежая.md`, doneTask('01JD0000000000000000000002', '2026-10-09T12:00'));
    const first = expectOk(await service.runAuto());
    expect(first).toMatchObject({ value: 1, changed: true });
    const archived = `${ARCHIVE_OCT}/Старая.md`;
    expect(store.notes.has(archived)).toBe(true);
    expect(store.notes.get(archived)?.body).toBe('тело');
    expect(store.fm(archived)).toMatchObject({ id: ID, done: true, custom_field: 'оставить' });
    expect((index.getById(ID) as Task).archived).toBe(true);
    expect(store.notes.has(`${TASKS}/Свежая.md`)).toBe(true);

    const second = expectOk(await service.runAuto());
    expect(second).toMatchObject({ value: 0, changed: false });
  });

  it('индекс не готов — not-ready; запись запрещена — read-only', async () => {
    const { store, index, service } = setup();
    store.put(`${TASKS}/Старая.md`, doneTask(ID, '2026-10-01T12:00'));
    index.ready = false;
    expectError(await service.runAuto(), 'not-ready');
    index.ready = true;
    store.writable = false;
    expectError(await service.runAuto(), 'read-only');
    expect(store.notes.has(`${TASKS}/Старая.md`)).toBe(true);
  });

  it('частичный сбой: перенесённые считаются, остальные остаются', async () => {
    const { store, service } = setup();
    store.put(`${TASKS}/А.md`, doneTask('01JD0000000000000000000001', '2026-10-01T12:00'));
    store.put(`${TASKS}/Б.md`, doneTask('01JD0000000000000000000002', '2026-10-01T12:00'));
    store.failNext.add(`${TASKS}/А.md`);
    const result = expectOk(await service.runAuto());
    expect(result.value).toBe(1);
    expect(store.notes.has(`${TASKS}/А.md`)).toBe(true);
    expect(store.notes.has(`${ARCHIVE_OCT}/Б.md`)).toBe(true);
  });
});

describe('ArchiveService.runAuto: гонка с «Вернуть в работу»', () => {
  const A = '01JD0000000000000000000001';
  const B = '01JD0000000000000000000002';

  it('задача, возвращённая в работу во время пакета, не уходит в архив', async () => {
    const { store, index, service } = setup();
    store.put(`${TASKS}/А.md`, doneTask(A, '2026-10-01T12:00'));
    store.put(`${TASKS}/Б.md`, doneTask(B, '2026-10-01T12:00'));
    const repository = (service as unknown as { deps: { repository: NoteRepository } }).deps.repository;
    const move = repository.move.bind(repository);
    let raced = false;
    repository.move = async (path, folder) => {
      if (!raced && path === `${TASKS}/А.md`) {
        raced = true;
        // Пока переносится «А», «Б» возвращают в работу; индекс ещё не знает об этом.
        index.freeze();
        store.fm(`${TASKS}/Б.md`).done = false;
        store.fm(`${TASKS}/Б.md`).completed = null;
      }
      return move(path, folder);
    };
    const result = expectOk(await service.runAuto());
    expect(result.value).toBe(1);
    expect(store.notes.has(`${ARCHIVE_OCT}/А.md`)).toBe(true);
    expect(store.notes.has(`${TASKS}/Б.md`)).toBe(true);
    expect(store.fm(`${TASKS}/Б.md`)).toMatchObject({ done: false });
  });

  it('отмена выполнения во время самого переноса — задача возвращается в «Задачи»', async () => {
    const { store, service } = setup();
    store.put(`${TASKS}/Б.md`, doneTask(B, '2026-10-01T12:00'));
    const repository = (service as unknown as { deps: { repository: NoteRepository } }).deps.repository;
    const move = repository.move.bind(repository);
    repository.move = async (path, folder) => {
      const result = await move(path, folder);
      // «Вернуть в работу» записалось сразу после переноса.
      if (result.ok && folder === ARCHIVE_OCT) store.fm(result.value).done = false;
      return result;
    };
    const result = expectOk(await service.runAuto());
    expect(result).toMatchObject({ value: 0, changed: false });
    expect(store.notes.has(`${TASKS}/Б.md`)).toBe(true);
    expect(store.notes.has(`${ARCHIVE_OCT}/Б.md`)).toBe(false);
  });

  it('ручной перенос тоже сверяется с файлом', async () => {
    const { store, index, service } = setup({ mode: 'never' });
    store.put(PATH, doneTask(ID, '2026-09-15T08:00'));
    index.freeze();
    store.fm(PATH).done = false;
    expect(expectOk(await service.archive(ID)).changed).toBe(false);
    expect(store.notes.has(PATH)).toBe(true);
  });
});

describe('ArchiveService.archive', () => {
  it('переносит выполненную задачу вручную; повтор — без изменений', async () => {
    const { store, service } = setup({ mode: 'never' });
    store.put(PATH, doneTask(ID, '2026-09-15T08:00'));
    expect(expectOk(await service.archive(ID)).changed).toBe(true);
    expect(store.notes.has(`${paths.archiveFor('2026-09')}/Стоматолог.md`)).toBe(true);
    expect(expectOk(await service.archive(ID)).changed).toBe(false);
  });

  it('невыполненную и повторяющуюся задачи не архивирует', async () => {
    const { store, service } = setup();
    store.put(PATH, taskFm());
    store.put(
      `${TASKS}/Серия.md`,
      taskFm({ id: '01JD0000000000000000000004', repeat: 'daily', repeat_anchor: '2026-10-01', completions: ['2026-10-01'] }),
    );
    expectError(await service.archive(ID), 'invalid');
    expectError(await service.archive('01JD0000000000000000000004'), 'invalid');
    expect(store.notes.has(PATH)).toBe(true);
  });
});

describe('Возврат из архива', () => {
  it('restore возвращает задачу в «Задачи» и в работу', async () => {
    const { store, index, service } = setup();
    const archived = `${ARCHIVE_OCT}/Стоматолог.md`;
    store.put(archived, doneTask(ID, '2026-10-01T12:00'));
    expect(expectOk(await service.restore(ID)).changed).toBe(true);
    expect(store.notes.has(archived)).toBe(false);
    expect(store.fm(PATH)).toMatchObject({ id: ID, done: false, completed: null });
    expect((index.getById(ID) as Task).archived).toBe(false);
    // Задача не в архиве — повтор ничего не делает.
    expect(expectOk(await service.restore(ID)).changed).toBe(false);
  });

  it('«Вернуть в работу» для задачи из архива тоже переносит её обратно', async () => {
    const { store, tasks } = setup();
    store.put(`${ARCHIVE_OCT}/Стоматолог.md`, doneTask(ID, '2026-10-01T12:00'));
    expect(expectOk(await tasks.uncomplete(ID)).changed).toBe(true);
    expect(store.fm(PATH)).toMatchObject({ done: false });
  });

  it('сбой переноса при возврате — ошибка, задача остаётся в архиве', async () => {
    const { store, service } = setup();
    const archived = `${ARCHIVE_OCT}/Стоматолог.md`;
    store.put(archived, doneTask(ID, '2026-10-01T12:00'));
    store.writable = false;
    expectError(await service.restore(ID), 'read-only');
    expect(store.notes.has(archived)).toBe(true);
  });
});
