import { describe, expect, it } from 'vitest';
import type { IdGenerator, NoteIndex, NoteRepository, NoteService } from '../../src/app/contracts';
import type { FrontmatterRecord, OpResult, ParsedNote, PlannerItem, QuickNote, VaultPath } from '../../src/model/types';
import { parsePlannerNote } from '../../src/model/properties';
import { errorResult, okResult } from '../../src/storage/note-repository';
import { createPlannerPaths } from '../../src/storage/paths';
import { VaultNoteService } from '../../src/notes/note-service';
import { createAndOpenNote, notePatch } from '../../src/notes/note-form';

const paths = createPlannerPaths('Планировщик');

interface StoredNote {
  fm: FrontmatterRecord;
  body: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function titleOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

class FakeStore {
  readonly notes = new Map<VaultPath, StoredNote>();
  readonly trashed: VaultPath[] = [];
  failCreate = false;

  uniquePath(folder: string, title: string): VaultPath {
    let candidate = `${folder}/${title}.md`;
    for (let n = 2; this.notes.has(candidate); n++) candidate = `${folder}/${title} (${n}).md`;
    return candidate;
  }
}

function fakeRepository(store: FakeStore): NoteRepository {
  return {
    paths,
    exists: (path) => store.notes.has(path),
    async create(request) {
      if (store.failCreate) return errorResult<VaultPath>('write-failed', 'тестовый сбой');
      const path = store.uniquePath(request.folder, request.title);
      store.notes.set(path, { fm: clone(request.frontmatter), body: request.body });
      return okResult(path);
    },
    async updateFrontmatter(path, mutate) {
      const note = store.notes.get(path);
      if (!note) return errorResult('not-found', path);
      const next = clone(note.fm);
      mutate(next);
      const changed = JSON.stringify(next) !== JSON.stringify(note.fm);
      note.fm = next;
      return okResult(undefined, changed);
    },
    async readBody(path) {
      const note = store.notes.get(path);
      return note ? okResult(note.body, false) : errorResult('not-found', path);
    },
    async updateBody(path, transform) {
      const note = store.notes.get(path);
      if (!note) return errorResult('not-found', path);
      const next = transform(note.body);
      const changed = next !== note.body;
      note.body = next;
      return okResult(undefined, changed);
    },
    async rename(path, newTitle) {
      const note = store.notes.get(path);
      if (!note) return errorResult('not-found', path);
      const target = store.uniquePath(path.slice(0, path.lastIndexOf('/')), newTitle);
      store.notes.delete(path);
      store.notes.set(target, note);
      return okResult(target);
    },
    move: async (path) => okResult(path, false),
    async trash(path) {
      if (!store.notes.delete(path)) return errorResult('not-found', path);
      store.trashed.push(path);
      return okResult(undefined);
    },
    ensureFolder: async () => okResult(undefined, false),
    listFolder: async () => okResult({ files: [], folders: [] }, false),
    readBinary: async (path) => errorResult('not-found', path),
    writeBinary: async () => okResult(undefined),
  };
}

class FakeIndex implements NoteIndex {
  constructor(private readonly store: FakeStore) {}

  private parseAll(): ParsedNote[] {
    const out: ParsedNote[] = [];
    for (const [path, note] of this.store.notes) {
      const parsed = parsePlannerNote({ path, title: titleOf(path), mtime: 1, frontmatter: clone(note.fm), archived: false, deletedInCalendar: false });
      if (parsed) out.push(parsed);
    }
    return out;
  }

  isReady = () => true;
  whenReady = async () => {};
  getTasks = () => [];
  getEvents = () => [];
  getNotes = () => this.parseAll().filter((n): n is QuickNote => n.kind === 'note');
  getInvalid = () => [];
  getMatrix = () => {
    throw new Error('не нужно в тестах');
  };
  getById = (id: string) => this.parseAll().find((n) => n.kind !== 'invalid' && n.id === id) as PlannerItem | undefined;
  getAllById = (id: string) => this.parseAll().filter((n): n is PlannerItem => n.kind !== 'invalid' && n.id === id);
  getByPath = (path: string) => this.parseAll().find((n) => n.path === path) as never;
  onChange = () => () => {};
  rebuild = async () => {};
  waitFor = async (path: VaultPath) => this.parseAll().find((n) => n.path === path) ?? null;
}

function idGenerator(): IdGenerator {
  let n = 0;
  return { next: () => `01NOTE${String(++n).padStart(20, '0')}` };
}

function setup() {
  const store = new FakeStore();
  const index = new FakeIndex(store);
  const service = new VaultNoteService({ repository: fakeRepository(store), index, ids: idGenerator() });
  return { store, index, service };
}

function expectOk<T>(result: OpResult<T>): T {
  if (!result.ok) throw new Error(`ожидался успех: ${result.error.code} ${result.error.detail ?? ''}`);
  return result.value;
}

describe('создание быстрой заметки', () => {
  it('пишет файл в «Заметки» со свойствами type/id/date и телом', async () => {
    const { store, service } = setup();
    const path = expectOk(await service.create({ title: ' Идеи ', body: 'Текст заметки.', date: '2026-10-21' }));
    expect(path).toBe(`${paths.notes}/Идеи.md`);
    const note = store.notes.get(path);
    expect(note?.fm).toEqual({ type: 'note', id: '01NOTE00000000000000000001', date: '2026-10-21' });
    expect(Object.keys(note?.fm ?? {})).toEqual(['type', 'id', 'date']);
    expect(note?.body).toBe('Текст заметки.');
  });

  it('дата может быть пустой', async () => {
    const { store, service } = setup();
    const path = expectOk(await service.create({ title: 'Без даты', body: '', date: null }));
    expect(store.notes.get(path)?.fm.date).toBeNull();
  });

  it('пустое название и неверная дата отклоняются', async () => {
    const { store, service } = setup();
    const empty = await service.create({ title: '  ', body: '', date: null });
    expect(empty.ok).toBe(false);
    const badDate = await service.create({ title: 'Заметка', body: '', date: '2026-02-30' });
    expect(badDate.ok).toBe(false);
    expect(store.notes.size).toBe(0);
  });
});

describe('открытие созданной заметки в редакторе', () => {
  it('созданная заметка открывается по возвращённому пути', async () => {
    const { service } = setup();
    const opened: VaultPath[] = [];
    const result = await createAndOpenNote(
      { notes: service, openNote: async (path) => void opened.push(path) },
      { title: 'Список покупок', body: '', date: '2026-10-10' },
    );
    expect(expectOk(result)).toBe(`${paths.notes}/Список покупок.md`);
    expect(opened).toEqual([`${paths.notes}/Список покупок.md`]);
  });

  it('при ошибке создания редактор не открывается', async () => {
    const { store, service } = setup();
    store.failCreate = true;
    const opened: VaultPath[] = [];
    const result = await createAndOpenNote({ notes: service, openNote: async (path) => void opened.push(path) }, { title: 'X', body: '', date: null });
    expect(result.ok).toBe(false);
    expect(opened).toEqual([]);
  });

  it('сбой открытия не отменяет созданную заметку', async () => {
    const { store, service } = setup();
    const notes: NoteService = service;
    const result = await createAndOpenNote(
      {
        notes,
        openNote: async () => {
          throw new Error('нет вкладки');
        },
      },
      { title: 'Y', body: '', date: null },
    );
    expect(result.ok).toBe(true);
    expect(store.notes.size).toBe(1);
  });
});

describe('правка и удаление', () => {
  async function seeded() {
    const ctx = setup();
    const path = expectOk(await ctx.service.create({ title: 'Черновик', body: 'старый', date: '2026-10-10' }));
    const id = ctx.store.notes.get(path)?.fm.id as string;
    ctx.store.notes.get(path)!.fm.custom = 'оставить';
    return { ...ctx, path, id };
  }

  it('меняет дату точечно, неизвестные свойства сохраняются', async () => {
    const { store, service, path, id } = await seeded();
    expectOk(await service.update(id, { date: null }));
    expect(store.notes.get(path)?.fm).toEqual({ type: 'note', id, date: null, custom: 'оставить' });
  });

  it('название меняет имя файла, id сохраняется', async () => {
    const { store, service, id } = await seeded();
    expectOk(await service.update(id, { title: 'Итог', body: 'новый' }));
    const note = store.notes.get(`${paths.notes}/Итог.md`);
    expect(note?.fm.id).toBe(id);
    expect(note?.body).toBe('новый');
  });

  it('удаление — в корзину', async () => {
    const { store, service, path, id } = await seeded();
    expectOk(await service.delete(id));
    expect(store.trashed).toEqual([path]);
  });

  it('неизвестный id — not-found', async () => {
    const { service } = await seeded();
    const result = await service.update('NOPE', { date: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('notePatch отдаёт только изменённые поля и не трогает незагруженное тело', () => {
    const initial = { title: 'А', body: '', date: '2026-10-10' };
    expect(notePatch({ title: 'А', body: 'x', bodyLoaded: false, date: '2026-10-10' }, initial)).toEqual({});
    expect(notePatch({ title: ' Б ', body: 'x', bodyLoaded: true, date: null }, initial)).toEqual({ title: 'Б', body: 'x', date: null });
  });
});
