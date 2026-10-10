import { describe, expect, it } from 'vitest';
import type { IdGenerator, NoteIndex, NoteRepository, TombstoneWriter } from '../../src/app/contracts';
import type {
  CachedCalendar,
  EventDraft,
  FrontmatterRecord,
  ItemId,
  OpResult,
  ParsedNote,
  PlannerEvent,
  PlannerItem,
  TombstoneRecord,
  VaultPath,
} from '../../src/model/types';
import { parsePlannerNote } from '../../src/model/properties';
import { errorResult, okResult } from '../../src/storage/note-repository';
import { createPlannerPaths } from '../../src/storage/paths';
import { VaultEventService, eventDraftToProperties } from '../../src/events/event-service';

// ---------------------------------------------------------------------------
// Фейки: заметки в памяти, индекс на настоящем разборе, метки удаления
// ---------------------------------------------------------------------------

const paths = createPlannerPaths('Планировщик');

interface StoredNote {
  fm: FrontmatterRecord;
  body: string;
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
  /** Сбой переноса в корзину для пути (один раз). */
  readonly failTrash = new Set<VaultPath>();
  /** Заметку удалили «другим устройством»: в индексе есть, в хранилище — нет. */
  readonly vanished = new Set<VaultPath>();
  created: Array<{ folder: string; fm: FrontmatterRecord; body: string }> = [];

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
      const path = store.uniquePath(request.folder, request.title);
      store.notes.set(path, { fm: clone(request.frontmatter), body: request.body });
      store.created.push({ folder: request.folder, fm: clone(request.frontmatter), body: request.body });
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
      const target = store.uniquePath(folderOf(path), newTitle);
      store.notes.delete(path);
      store.notes.set(target, note);
      return okResult(target);
    },
    move: async (path) => okResult(path, false),
    async trash(path) {
      if (store.failTrash.delete(path)) return errorResult('trash-failed', 'тестовый сбой');
      if (store.vanished.has(path) || !store.notes.has(path)) return errorResult('not-found', path);
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

class FakeIndex implements NoteIndex {
  /** Снимок индекса, который не видит удаление (задержка `changed`). */
  stale: ParsedNote[] | null = null;

  constructor(private readonly store: FakeStore) {}

  private parseAll(): ParsedNote[] {
    if (this.stale) return this.stale;
    const out: ParsedNote[] = [];
    for (const [path, note] of this.store.notes) {
      const parsed = parsePlannerNote({ path, title: titleOf(path), mtime: 1, frontmatter: clone(note.fm), archived: false, deletedInCalendar: false });
      if (parsed) out.push(parsed);
    }
    return out;
  }

  freeze(): void {
    this.stale = this.parseAll();
  }

  isReady = () => true;
  whenReady = async () => {};
  getTasks = () => [];
  getEvents = () => this.parseAll().filter((n): n is PlannerEvent => n.kind === 'event');
  getNotes = () => [];
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

class FakeTombstones implements TombstoneWriter {
  readonly records: TombstoneRecord[] = [];
  failNext = false;
  readonly order: string[];

  constructor(order: string[]) {
    this.order = order;
  }

  async add(id: ItemId): Promise<OpResult> {
    this.order.push(`tombstone:${id}`);
    if (this.failNext) {
      this.failNext = false;
      return errorResult('write-failed', 'тестовый сбой');
    }
    if (this.records.some((r) => r.id === id)) return okResult(undefined, false);
    this.records.push({ id, kind: 'event', deletedAt: '2026-10-10T13:20:00Z' });
    return okResult(undefined);
  }

  async list(): Promise<OpResult<readonly TombstoneRecord[]>> {
    return okResult(this.records, false);
  }

  async has(id: ItemId): Promise<boolean> {
    return this.records.some((r) => r.id === id);
  }
}

const CALENDARS: CachedCalendar[] = [
  { calendarId: 'home', title: 'Дом', color: '#3E8BF0', kind: 'caldav', allowsModifications: true },
  { calendarId: 'birthdays', title: 'Дни рождения', color: '#8E8E93', kind: 'birthdays', allowsModifications: false },
  { calendarId: 'subscribed', title: 'Праздники', color: '#E5484D', kind: 'subscription', allowsModifications: false },
];

function idGenerator(): IdGenerator {
  let n = 0;
  return { next: () => `01EVENT${String(++n).padStart(19, '0')}` };
}

function setup(calendars: CachedCalendar[] = CALENDARS) {
  const store = new FakeStore();
  const index = new FakeIndex(store);
  const order: string[] = [];
  const tombstones = new FakeTombstones(order);
  const repository = fakeRepository(store);
  const trash = repository.trash.bind(repository);
  repository.trash = async (path) => {
    order.push(`trash:${path}`);
    return trash(path);
  };
  const service = new VaultEventService({
    repository,
    index,
    ids: idGenerator(),
    calendars: { getCalendars: () => calendars },
    tombstones,
    plannerCalendarTitle: () => 'Планировщик',
  });
  return { store, index, tombstones, service, order };
}

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    title: 'Концерт',
    body: 'Заметки к событию.',
    icon: 'star',
    url: null,
    allDay: false,
    start: { date: '2026-10-21', time: '09:00' },
    end: { date: '2026-10-21', time: '10:00' },
    repeat: 'none',
    color: 'blue',
    calendarId: null,
    tz: null,
    ...overrides,
  };
}

function expectOk<T>(result: OpResult<T>): T {
  if (!result.ok) throw new Error(`ожидался успех: ${result.error.code} ${result.error.detail ?? ''}`);
  return result.value;
}

function expectError(result: OpResult<unknown>, code: string, detail?: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
    if (detail !== undefined) expect(result.error.detail).toBe(detail);
  }
}

// ---------------------------------------------------------------------------

describe('создание события', () => {
  it('пишет заметку в «События» со свойствами по ТЗ', async () => {
    const { store, service } = setup();
    const event = expectOk(await service.create(draft()));
    expect(event?.title).toBe('Концерт');
    const [created] = store.created;
    expect(created?.folder).toBe(paths.events);
    expect(created?.fm).toEqual({
      type: 'event',
      id: event?.id,
      start: '2026-10-21T09:00',
      end: '2026-10-21T10:00',
      all_day: false,
      tz: null,
      repeat: 'none',
      color: 'blue',
      icon: 'star',
      calendar_id: null,
      url: null,
    });
    expect(Object.keys(created?.fm ?? {})).toEqual(['type', 'id', 'start', 'end', 'all_day', 'tz', 'repeat', 'color', 'icon', 'calendar_id', 'url']);
    expect(created?.body).toBe('Заметки к событию.');
  });

  it('«Весь день»: даты, конец не включается', async () => {
    const { store, service } = setup();
    expectOk(
      await service.create(draft({ allDay: true, start: { date: '2026-10-21', time: null }, end: { date: '2026-10-21', time: null } })),
    );
    expect(store.created[0]?.fm).toMatchObject({ start: '2026-10-21', end: '2026-10-22', all_day: true });
  });

  it('конец не позже начала — ошибка, файл не создаётся', async () => {
    const { store, service } = setup();
    expectError(await service.create(draft({ end: { date: '2026-10-21', time: '09:00' } })), 'invalid', 'end');
    expectError(
      await service.create(draft({ allDay: true, start: { date: '2026-10-21', time: null }, end: { date: '2026-10-20', time: null } })),
      'invalid',
      'end',
    );
    expect(store.created).toHaveLength(0);
  });

  it('пустое название и неизвестный цвет отклоняются', async () => {
    const { service } = setup();
    expectError(await service.create(draft({ title: '  ' })), 'invalid', 'title');
    expectError(await service.create(draft({ color: 'pink' as never })), 'invalid', 'color');
  });

  it('все 8 цветов записываются', async () => {
    const { store, service } = setup();
    for (const color of ['blue', 'red', 'orange', 'yellow', 'green', 'teal', 'sky', 'purple'] as const) {
      expectOk(await service.create(draft({ color, title: color })));
    }
    expect(store.created.map((c) => c.fm.color)).toEqual(['blue', 'red', 'orange', 'yellow', 'green', 'teal', 'sky', 'purple']);
  });
});

describe('календари для записи', () => {
  it('«Планировщик» и календари кэша с allows_modifications', () => {
    const { service } = setup();
    expect(service.getWritableCalendars().map((c) => c.calendarId)).toEqual([null, 'home']);
    expect(service.getWritableCalendars()[0]?.title).toBe('Планировщик');
  });

  it('без компаньона (кэша нет) — только «Планировщик»', () => {
    const { service } = setup([]);
    expect(service.getWritableCalendars().map((c) => c.calendarId)).toEqual([null]);
  });

  it('запись только в разрешённый календарь', async () => {
    const { store, service } = setup();
    expectError(await service.create(draft({ calendarId: 'birthdays' })), 'invalid', 'calendarId');
    expectError(await service.create(draft({ calendarId: 'нет-такого' })), 'invalid', 'calendarId');
    expect(store.created).toHaveLength(0);
    expectOk(await service.create(draft({ calendarId: 'home' })));
    expect(store.created[0]?.fm.calendar_id).toBe('home');
  });

  it('правка оставляет прежний календарь, даже если он стал только для чтения', async () => {
    const { store, service } = setup();
    const id = 'EV-OLD';
    store.notes.set(`${paths.events}/Старое.md`, {
      fm: eventDraftToProperties(draft({ calendarId: 'subscribed' }), id) as unknown as FrontmatterRecord,
      body: '',
    });
    expectOk(await service.update(id, { calendarId: 'subscribed', color: 'red' }));
    expectError(await service.update(id, { calendarId: 'birthdays' }), 'invalid', 'calendarId');
    expect(store.notes.get(`${paths.events}/Старое.md`)?.fm).toMatchObject({ calendar_id: 'subscribed', color: 'red' });
  });
});

describe('правка всей серии', () => {
  async function seeded() {
    const ctx = setup();
    ctx.store.notes.set(`${paths.events}/Йога.md`, {
      fm: { ...eventDraftToProperties(draft({ repeat: 'weekly' }), 'EV1'), custom: 'оставить' } as FrontmatterRecord,
      body: 'тело',
    });
    return ctx;
  }

  it('меняет свойства серии точечно, неизвестные свойства сохраняются', async () => {
    const { store, service } = await seeded();
    expectOk(
      await service.update('EV1', { start: { date: '2026-10-22', time: '18:00' }, end: { date: '2026-10-22', time: '19:30' }, allDay: false }),
    );
    expect(store.notes.get(`${paths.events}/Йога.md`)?.fm).toMatchObject({
      start: '2026-10-22T18:00',
      end: '2026-10-22T19:30',
      repeat: 'weekly',
      custom: 'оставить',
    });
  });

  it('переключение на «Весь день» без новых дат даёт исключительный конец', async () => {
    const { store, service } = await seeded();
    expectOk(await service.update('EV1', { allDay: true }));
    expect(store.notes.get(`${paths.events}/Йога.md`)?.fm).toMatchObject({ start: '2026-10-21', end: '2026-10-22', all_day: true });
  });

  it('конец раньше начала при правке отклоняется', async () => {
    const { store, service } = await seeded();
    expectError(await service.update('EV1', { end: { date: '2026-10-21', time: '08:00' } }), 'invalid', 'end');
    expect(store.notes.get(`${paths.events}/Йога.md`)?.fm.end).toBe('2026-10-21T10:00');
  });

  it('название меняет имя файла, id сохраняется', async () => {
    const { store, service } = await seeded();
    expectOk(await service.update('EV1', { title: 'Пилатес', body: 'новое' }));
    const note = store.notes.get(`${paths.events}/Пилатес.md`);
    expect(note?.fm.id).toBe('EV1');
    expect(note?.body).toBe('новое');
  });

  it('неизвестный id — not-found', async () => {
    const { service } = await seeded();
    expectError(await service.update('NOPE', { color: 'red' }), 'not-found');
  });
});

describe('удаление события', () => {
  async function seeded() {
    const ctx = setup();
    const path = `${paths.events}/Концерт.md`;
    ctx.store.notes.set(path, { fm: eventDraftToProperties(draft(), 'EV1') as unknown as FrontmatterRecord, body: '' });
    return { ...ctx, path };
  }

  it('сначала метка, затем корзина', async () => {
    const { service, tombstones, store, order, path } = await seeded();
    expectOk(await service.delete('EV1'));
    expect(order).toEqual(['tombstone:EV1', `trash:${path}`]);
    expect(tombstones.records.map((r) => r.id)).toEqual(['EV1']);
    expect(store.trashed).toEqual([path]);
  });

  it('сбой метки: заметка не удаляется, ошибка называет этап', async () => {
    const { service, tombstones, store, path } = await seeded();
    tombstones.failNext = true;
    const result = await service.delete('EV1');
    expectError(result, 'tombstone-failed', 'tombstone');
    expect(store.notes.has(path)).toBe(true);
    expect(store.trashed).toHaveLength(0);
  });

  it('сбой корзины не теряется незаметно; повторный вызов завершает удаление', async () => {
    const { service, tombstones, store, path } = await seeded();
    store.failTrash.add(path);
    const first = await service.delete('EV1');
    expectError(first, 'trash-failed', 'trash');
    if (!first.ok) expect(first.error.messageKey).toBe('events.errors.deleteTrash');
    expect(store.notes.has(path)).toBe(true);
    expect(tombstones.records).toHaveLength(1);

    expectOk(await service.delete('EV1'));
    expect(store.trashed).toEqual([path]);
    // Метка не дублируется.
    expect(tombstones.records).toHaveLength(1);
  });

  it('«не найдено» при переносе в корзину считается завершением', async () => {
    const { service, index, store, path } = await seeded();
    index.freeze();
    store.vanished.add(path);
    expectOk(await service.delete('EV1'));
  });

  it('повтор после завершённого удаления — без изменений', async () => {
    const { service } = await seeded();
    expectOk(await service.delete('EV1'));
    const again = await service.delete('EV1');
    expect(again).toEqual({ ok: true, value: undefined, changed: false });
  });

  it('неизвестное событие без метки — not-found', async () => {
    const { service } = await seeded();
    expectError(await service.delete('NOPE'), 'not-found');
  });
});
