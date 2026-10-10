import { beforeEach, describe, expect, it } from 'vitest';
import type { NoteIndex, NoteRepository, SystemJsonReadResult, TombstoneWriter } from '../../src/app/contracts';
import type { CalDavCalendar, CalDavError, CalDavResult } from '../../src/caldav/client-types';
import {
  CalendarSyncEngine,
  CalendarSyncScheduler,
  itemHref,
  type CalDavApi,
  type SyncOutcome,
} from '../../src/caldav/sync-engine';
import { parseIcs } from '../../src/caldav/ics';
import type { LocalJsonStore } from '../../src/caldav/credentials';
import { SystemCalendarCacheReader } from '../../src/calendar/cache-reader';
import { VaultEventService } from '../../src/events/event-service';
import { createDefaultSettings } from '../../src/settings/defaults';
import { parsePlannerNote } from '../../src/model/properties';
import { errorResult, okResult } from '../../src/storage/note-repository';
import { createPlannerPaths } from '../../src/storage/paths';
import type {
  FrontmatterRecord,
  ItemId,
  OpResult,
  ParsedNote,
  PlannerEvent,
  PlannerItem,
  PlannerSettings,
  Task,
  TombstoneRecord,
  VaultPath,
} from '../../src/model/types';

// ---------------------------------------------------------------------------
// Фейковый сервер CalDAV в памяти
// ---------------------------------------------------------------------------

const HOST = 'https://p1-caldav.example.com';
const HOME = `${HOST}/123/calendars/`;
const WORK = `${HOME}work/`;
const BIRTHDAYS = `${HOME}birthdays/`;

interface Resource {
  etag: string;
  ics: string;
}

interface RequestLog {
  method: string;
  href: string;
  etag?: string;
  create?: boolean;
}

function fail<T>(code: CalDavError['code'], message = code): CalDavResult<T> {
  return { ok: false, error: { code, message } };
}

function parentOf(href: string): string {
  return href.slice(0, href.lastIndexOf('/') + 1);
}

class FakeCalDav implements CalDavApi {
  calendars: CalDavCalendar[] = [
    { href: WORK, displayName: 'Работа', color: '#34C759', components: ['VEVENT'], allowsModifications: true },
    { href: BIRTHDAYS, displayName: 'Дни рождения', color: '#8E8E93', components: ['VEVENT'], allowsModifications: false },
  ];
  readonly resources = new Map<string, Resource>();
  readonly subscriptions = new Map<string, string>();
  readonly log: RequestLog[] = [];
  networkDown = false;
  /** Вызывается перед PUT (имитация правки на другом устройстве). */
  beforePut: ((href: string) => void) | null = null;
  private etagCounter = 0;

  nextEtag(): string {
    return `"e${++this.etagCounter}"`;
  }

  setResource(href: string, ics: string): void {
    this.resources.set(href, { etag: this.nextEtag(), ics });
  }

  writes(): RequestLog[] {
    return this.log.filter((r) => r.method === 'PUT' || r.method === 'DELETE' || r.method === 'MKCALENDAR');
  }

  async discover() {
    if (this.networkDown) return fail<never>('network');
    return { ok: true as const, value: { principalHref: `${HOST}/123/principal/`, homeHref: HOME, calendars: this.calendars.map((c) => ({ ...c })) } };
  }

  async listEvents(calendarHref: string) {
    this.log.push({ method: 'REPORT', href: calendarHref });
    if (this.networkDown) return fail<never>('network');
    const value = [...this.resources]
      .filter(([href]) => parentOf(href) === calendarHref)
      .map(([href, r]) => ({ href, etag: r.etag, ics: r.ics }));
    return { ok: true as const, value };
  }

  async getEvent(href: string) {
    this.log.push({ method: 'GET', href });
    if (this.networkDown) return fail<never>('network');
    const r = this.resources.get(href);
    return r ? { ok: true as const, value: { href, etag: r.etag, ics: r.ics } } : fail<never>('not-found');
  }

  async putEvent(href: string, ics: string, opts: { etag?: string; create?: boolean } = {}) {
    this.log.push({ method: 'PUT', href, etag: opts.etag, create: opts.create });
    if (this.networkDown) return fail<never>('network');
    this.beforePut?.(href);
    const current = this.resources.get(href);
    if (opts.create && current) return fail<never>('conflict');
    if (opts.etag && (!current || current.etag !== opts.etag)) return fail<never>('conflict');
    const etag = this.nextEtag();
    this.resources.set(href, { etag, ics });
    return { ok: true as const, value: { href, etag } };
  }

  async deleteEvent(href: string) {
    this.log.push({ method: 'DELETE', href });
    if (this.networkDown) return fail<never>('network');
    this.resources.delete(href);
    return { ok: true as const, value: undefined };
  }

  async makeCalendar(homeHref: string, name: string, color?: string) {
    this.log.push({ method: 'MKCALENDAR', href: homeHref });
    if (this.networkDown) return fail<never>('network');
    const calendar: CalDavCalendar = { href: `${homeHref}planner/`, displayName: name, components: ['VEVENT'], allowsModifications: true };
    if (color) calendar.color = color;
    this.calendars.push(calendar);
    return { ok: true as const, value: { ...calendar } };
  }

  async fetchIcsSubscription(url: string) {
    if (this.networkDown) return fail<never>('network');
    const text = this.subscriptions.get(url);
    return text ? { ok: true as const, value: text } : fail<never>('not-found');
  }
}

// ---------------------------------------------------------------------------
// Заметки в памяти, индекс на настоящем разборе
// ---------------------------------------------------------------------------

const paths = createPlannerPaths('Планировщик');
const PLANNER = `${HOME}planner/`;

const EVENT_ID = '01JA2B3C4D5E6F7G8H9JKMNPQR';
const TASK_TIMED = '01JA2B3C4D5E6F7G8H9JKMNPQS';
const TASK_DATE = '01JA2B3C4D5E6F7G8H9JKMNPQT';
const TASK_NO_DUE = '01JA2B3C4D5E6F7G8H9JKMNPQV';

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

class Notes {
  readonly map = new Map<VaultPath, StoredNote>();
  ready = true;

  parseAll(): ParsedNote[] {
    const out: ParsedNote[] = [];
    for (const [path, note] of this.map) {
      const parsed = parsePlannerNote({
        path,
        title: titleOf(path),
        mtime: 1,
        frontmatter: clone(note.fm),
        archived: path.startsWith(`${paths.tasks}/Архив/`),
        deletedInCalendar: path.startsWith(`${paths.deletedEvents}/`),
      });
      if (parsed) out.push(parsed);
    }
    return out;
  }

  pathOf(id: ItemId): VaultPath | undefined {
    return this.parseAll().find((n) => n.kind !== 'invalid' && n.id === id)?.path;
  }
}

function fakeIndex(notes: Notes): NoteIndex {
  return {
    isReady: () => notes.ready,
    whenReady: async () => {},
    getTasks: () => notes.parseAll().filter((n): n is Task => n.kind === 'task'),
    getEvents: () => notes.parseAll().filter((n): n is PlannerEvent => n.kind === 'event'),
    getNotes: () => [],
    getInvalid: () => [],
    getMatrix: () => {
      throw new Error('не нужно');
    },
    getById: (id) => notes.parseAll().find((n) => n.kind !== 'invalid' && n.id === id) as PlannerItem | undefined,
    getAllById: (id) => notes.parseAll().filter((n): n is PlannerItem => n.kind !== 'invalid' && n.id === id),
    getByPath: (path) => notes.parseAll().find((n) => n.path === path),
    onChange: () => () => {},
    waitFor: async (path) => notes.parseAll().find((n) => n.path === path) ?? null,
    rebuild: async () => {},
  };
}

function fakeRepository(notes: Notes): NoteRepository {
  const repo: Partial<NoteRepository> = {
    paths,
    exists: (path) => notes.map.has(path),
    async readBody(path) {
      const note = notes.map.get(path);
      return note ? okResult(note.body, false) : errorResult('not-found', path);
    },
    async updateFrontmatter(path, mutate) {
      const note = notes.map.get(path);
      if (!note) return errorResult('not-found', path);
      const next = clone(note.fm);
      mutate(next);
      const changed = JSON.stringify(next) !== JSON.stringify(note.fm);
      note.fm = next;
      return okResult(undefined, changed);
    },
    async updateBody(path, transform) {
      const note = notes.map.get(path);
      if (!note) return errorResult('not-found', path);
      const next = transform(note.body);
      const changed = next !== note.body;
      note.body = next;
      return okResult(undefined, changed);
    },
    async rename(path, title) {
      const note = notes.map.get(path);
      if (!note) return errorResult('not-found', path);
      const target = `${parentOf(path)}${title}.md`;
      notes.map.delete(path);
      notes.map.set(target, note);
      return okResult(target);
    },
    async move(path, folder) {
      const note = notes.map.get(path);
      if (!note) return errorResult('not-found', path);
      const target = `${folder}/${titleOf(path)}.md`;
      notes.map.delete(path);
      notes.map.set(target, note);
      return okResult(target);
    },
  };
  return repo as NoteRepository;
}

class FakeTombstones implements TombstoneWriter {
  readonly records: TombstoneRecord[] = [];
  async add(id: ItemId): Promise<OpResult> {
    this.records.push({ id, kind: 'event', deletedAt: '2026-10-11T10:00:00Z' });
    return okResult(undefined);
  }
  async list(): Promise<OpResult<readonly TombstoneRecord[]>> {
    return okResult(this.records, false);
  }
  async has(id: ItemId): Promise<boolean> {
    return this.records.some((r) => r.id === id);
  }
}

function eventFm(id: ItemId, start: string, end: string, extra: FrontmatterRecord = {}): FrontmatterRecord {
  return { type: 'event', id, start, end, all_day: false, tz: null, repeat: 'none', color: 'blue', icon: null, calendar_id: null, url: null, ...extra };
}

function taskFm(id: ItemId, due: string | null, extra: FrontmatterRecord = {}): FrontmatterRecord {
  return {
    type: 'task',
    id,
    quadrant: 'do',
    due,
    repeat: 'none',
    repeat_anchor: null,
    remind: 'none',
    priority: 'normal',
    done: false,
    completed: null,
    completions: [],
    created: '2026-10-01T09:00',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

function setup() {
  const server = new FakeCalDav();
  const notes = new Notes();
  notes.map.set(`${paths.events}/Стоматолог.md`, { fm: eventFm(EVENT_ID, '2026-10-12T10:00', '2026-10-12T11:00'), body: 'Взять полис\n' });
  notes.map.set(`${paths.tasks}/Позвонить.md`, { fm: taskFm(TASK_TIMED, '2026-10-13T15:00', { remind: '15m' }), body: '' });
  notes.map.set(`${paths.tasks}/Оплатить.md`, { fm: taskFm(TASK_DATE, '2026-10-14', { remind: 'at', repeat: 'monthly' }), body: '' });
  notes.map.set(`${paths.tasks}/Когда-нибудь.md`, { fm: taskFm(TASK_NO_DUE, null), body: '' });

  const settings: PlannerSettings = createDefaultSettings();
  settings.calendarSync = { ...settings.calendarSync, enabled: true, username: 'user@icloud.com' };
  const settingsStore = {
    get: () => settings,
    update: async (mutate: (draft: PlannerSettings) => void) => {
      mutate(settings);
    },
  };

  const index = fakeIndex(notes);
  const repository = fakeRepository(notes);
  const tombstones = new FakeTombstones();
  const events = new VaultEventService({
    repository,
    index,
    ids: { next: () => '01JA2B3C4D5E6F7G8H9JKMNPQZ' },
    calendars: { getCalendars: () => [] },
    tombstones,
    waitTimeoutMs: 0,
  });

  let cacheValue: unknown = null;
  const cacheWrites: unknown[] = [];
  const cache = {
    read: async (): Promise<SystemJsonReadResult> => (cacheValue === null ? { status: 'missing' } : { status: 'ok', value: clone(cacheValue) }),
    write: async (value: Record<string, unknown>): Promise<OpResult> => {
      cacheValue = clone(value);
      cacheWrites.push(cacheValue);
      return okResult(undefined);
    },
  };

  let stored: unknown = null;
  const state: LocalJsonStore = { load: () => clone(stored), save: (value) => (stored = clone(value)) };
  const notices: string[] = [];
  const now = { value: new Date('2026-10-11T09:00:00Z') };

  const engine = new CalendarSyncEngine({
    settings: settingsStore,
    index,
    events,
    repository,
    tombstones,
    cache,
    passwords: { getPassword: () => 'abcd-efgh-ijkl-mnop' },
    state,
    clock: { now: () => now.value, timeZone: () => 'Europe/Moscow' },
    notifier: { show: (message) => notices.push(message) },
    createClient: () => server,
    log: () => {},
  });
  return { server, notes, settings, engine, tombstones, notices, cacheWrites, getCache: () => cacheValue, now };
}

function expectOk(outcome: SyncOutcome): void {
  if (outcome.status !== 'ok') throw new Error(`ожидался успех: ${JSON.stringify(outcome)}`);
}

function fm(notes: Notes, id: ItemId): FrontmatterRecord {
  const path = notes.pathOf(id);
  if (!path) throw new Error(`нет заметки ${id}`);
  return notes.map.get(path)!.fm;
}

const FOREIGN_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//iOS 18//EN',
  'BEGIN:VEVENT',
  'UID:foreign-1',
  'DTSTAMP:20261001T000000Z',
  'DTSTART;TZID=Europe/Moscow:20261015T180000',
  'DTEND;TZID=Europe/Moscow:20261015T190000',
  'SUMMARY:Встреча',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

// ---------------------------------------------------------------------------

describe('caldav/sync-engine', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.server.setResource(`${WORK}foreign-1.ics`, FOREIGN_ICS);
  });

  it('первая синхронизация создаёт календарь «Планировщик» и события для заметок и задач', async () => {
    expectOk(await ctx.engine.syncNow());
    expect(ctx.settings.calendarSync.writeCalendarHref).toBe(PLANNER);
    const puts = ctx.server.log.filter((r) => r.method === 'PUT');
    expect(puts.map((r) => r.href).sort()).toEqual(
      [itemHref(PLANNER, EVENT_ID), itemHref(PLANNER, TASK_TIMED), itemHref(PLANNER, TASK_DATE)].sort(),
    );
    expect(puts.every((r) => r.create)).toBe(true);

    const event = parseIcs(ctx.server.resources.get(itemHref(PLANNER, EVENT_ID))!.ics).events[0];
    expect(event.uid).toBe(EVENT_ID);
    expect(event.summary).toBe('Стоматолог');
    expect(event.url).toBe(`matrixplanner://item/${EVENT_ID}`);
    expect(event.description).toBe('Взять полис');
    expect(event.start).toMatchObject({ date: '2026-10-12', time: '10:00', tzid: 'Europe/Moscow' });

    const timed = parseIcs(ctx.server.resources.get(itemHref(PLANNER, TASK_TIMED))!.ics).events[0];
    expect(timed.summary).toBe('○ Позвонить');
    expect(timed.start).toMatchObject({ date: '2026-10-13', time: '15:00' });
    expect(timed.end).toMatchObject({ date: '2026-10-13', time: '15:30' });
    expect(timed.alarms).toEqual([expect.objectContaining({ triggerMinutesBefore: 15 })]);

    const dated = parseIcs(ctx.server.resources.get(itemHref(PLANNER, TASK_DATE))!.ics).events[0];
    expect(dated.allDay).toBe(true);
    expect(dated.rrule?.freq).toBe('MONTHLY');
    // Задача без времени — напоминание в 09:00 (настройка) в день срока.
    expect(dated.alarms).toEqual([expect.objectContaining({ triggerMinutesBefore: -540 })]);
    expect(ctx.server.resources.get(itemHref(PLANNER, TASK_DATE))!.ics).toContain('TRIGGER:PT9H');
  });

  it('повторная синхронизация ничего не меняет', async () => {
    expectOk(await ctx.engine.syncNow());
    const before = ctx.server.writes().length;
    const outcome = await ctx.engine.syncNow();
    expectOk(outcome);
    expect(ctx.server.writes().length).toBe(before);
    expect(outcome.status === 'ok' && outcome.stats).toEqual({ created: 0, updated: 0, pulled: 0, deleted: 0, movedToDeleted: 0 });
  });

  it('изменение на сервере попадает в заметку, без обратной записи', async () => {
    expectOk(await ctx.engine.syncNow());
    const href = itemHref(PLANNER, EVENT_ID);
    const ics = ctx.server.resources.get(href)!.ics
      .replace('SUMMARY:Стоматолог', 'SUMMARY:Стоматолог (перенос)')
      .replace('DTSTART;TZID=Europe/Moscow:20261012T100000', 'DTSTART;TZID=Europe/Moscow:20261012T120000')
      .replace('DTEND;TZID=Europe/Moscow:20261012T110000', 'DTEND;TZID=Europe/Moscow:20261012T130000');
    ctx.server.setResource(href, ics);
    const writes = ctx.server.writes().length;

    expectOk(await ctx.engine.syncNow());
    expect(ctx.notes.pathOf(EVENT_ID)).toBe(`${paths.events}/Стоматолог (перенос).md`);
    expect(fm(ctx.notes, EVENT_ID)).toMatchObject({ start: '2026-10-12T12:00', end: '2026-10-12T13:00' });
    expect(ctx.server.writes().length).toBe(writes);

    // Запись в заметку не порождает обратную запись.
    expectOk(await ctx.engine.syncNow());
    expect(ctx.server.writes().length).toBe(writes);
  });

  it('изменение заметки → PUT с If-Match', async () => {
    expectOk(await ctx.engine.syncNow());
    const href = itemHref(PLANNER, EVENT_ID);
    const etag = ctx.server.resources.get(href)!.etag;
    fm(ctx.notes, EVENT_ID).start = '2026-10-12T09:00';
    ctx.server.log.length = 0;

    expectOk(await ctx.engine.syncNow());
    expect(ctx.server.writes()).toEqual([{ method: 'PUT', href, etag, create: undefined }]);
    const event = parseIcs(ctx.server.resources.get(href)!.ics).events[0];
    expect(event.start.time).toBe('09:00');
    expect(event.sequence).toBe(1);
  });

  it('обе стороны изменились, 412 → перечитать и повторить; побеждает заметка', async () => {
    expectOk(await ctx.engine.syncNow());
    const href = itemHref(PLANNER, EVENT_ID);
    // Сервер изменился до прохода…
    ctx.server.setResource(href, ctx.server.resources.get(href)!.ics.replace('SUMMARY:Стоматолог', 'SUMMARY:С iPhone'));
    // …и ещё раз прямо перед нашей записью (412).
    let raced = false;
    ctx.server.beforePut = (target) => {
      if (raced || target !== href) return;
      raced = true;
      ctx.server.setResource(href, ctx.server.resources.get(href)!.ics.replace('LOCATION:', 'LOCATION:').replace('SUMMARY:С iPhone', 'SUMMARY:С iPad'));
    };
    fm(ctx.notes, EVENT_ID).end = '2026-10-12T11:30';
    ctx.server.log.length = 0;

    expectOk(await ctx.engine.syncNow());
    const puts = ctx.server.log.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(ctx.server.log.some((r) => r.method === 'GET' && r.href === href)).toBe(true);
    const event = parseIcs(ctx.server.resources.get(href)!.ics).events[0];
    expect(event.summary).toBe('Стоматолог');
    expect(event.end.time).toBe('11:30');
    expect(ctx.notes.pathOf(EVENT_ID)).toBe(`${paths.events}/Стоматолог.md`);
  });

  it('удаление события — только по метке', async () => {
    expectOk(await ctx.engine.syncNow());
    const href = itemHref(PLANNER, EVENT_ID);
    // Заметки нет, метки нет — это не удаление.
    const path = ctx.notes.pathOf(EVENT_ID)!;
    const saved = ctx.notes.map.get(path)!;
    ctx.notes.map.delete(path);
    expectOk(await ctx.engine.syncNow());
    expect(ctx.server.resources.has(href)).toBe(true);

    await ctx.tombstones.add(EVENT_ID);
    ctx.server.log.length = 0;
    expectOk(await ctx.engine.syncNow());
    expect(ctx.server.writes()).toEqual([expect.objectContaining({ method: 'DELETE', href })]);
    expect(ctx.server.resources.has(href)).toBe(false);

    // Метка обработана: повторно не удаляется, вернувшаяся заметка с меткой не синхронизируется.
    ctx.notes.map.set(path, saved);
    ctx.server.log.length = 0;
    expectOk(await ctx.engine.syncNow());
    expect(ctx.server.writes()).toEqual([]);
  });

  it('событие Планировщика, удалённое на сервере, → заметка в «Удалённые»', async () => {
    expectOk(await ctx.engine.syncNow());
    ctx.server.resources.delete(itemHref(PLANNER, EVENT_ID));
    const outcome = await ctx.engine.syncNow();
    expectOk(outcome);
    expect(outcome.status === 'ok' && outcome.stats.movedToDeleted).toBe(1);
    expect(ctx.notes.pathOf(EVENT_ID)).toBe(`${paths.deletedEvents}/Стоматолог.md`);
    // Заметка в «Удалённых» не создаёт событие заново.
    ctx.server.log.length = 0;
    expectOk(await ctx.engine.syncNow());
    expect(ctx.server.writes()).toEqual([]);
  });

  it('чужие события не меняются и не удаляются', async () => {
    const plannerForeign = FOREIGN_ICS.replace('UID:foreign-1', 'UID:foreign-2');
    ctx.server.calendars.push({ href: PLANNER, displayName: 'Планировщик', components: ['VEVENT'], allowsModifications: true });
    ctx.server.setResource(`${PLANNER}foreign-2.ics`, plannerForeign);
    expectOk(await ctx.engine.syncNow());
    await ctx.tombstones.add(EVENT_ID);
    ctx.server.resources.delete(itemHref(PLANNER, TASK_TIMED));
    expectOk(await ctx.engine.syncNow());
    const touched = ctx.server.writes().filter((r) => r.href.includes('foreign'));
    expect(touched).toEqual([]);
    expect(ctx.server.resources.get(`${WORK}foreign-1.ics`)!.ics).toBe(FOREIGN_ICS);
    expect(ctx.server.resources.get(`${PLANNER}foreign-2.ics`)!.ics).toBe(plannerForeign);
    // Календарь найден по названию, новый не создавался.
    expect(ctx.server.log.some((r) => r.method === 'MKCALENDAR')).toBe(false);
  });

  it('ошибка сети ничего не удаляет и не пишет кэш', async () => {
    expectOk(await ctx.engine.syncNow());
    const cacheWrites = ctx.cacheWrites.length;
    ctx.server.resources.delete(itemHref(PLANNER, EVENT_ID));
    await ctx.tombstones.add(TASK_TIMED);
    ctx.server.networkDown = true;
    ctx.server.log.length = 0;

    const outcome = await ctx.engine.syncNow();
    expect(outcome).toMatchObject({ status: 'error', kind: 'network' });
    expect(ctx.notes.pathOf(EVENT_ID)).toBe(`${paths.events}/Стоматолог.md`);
    expect(ctx.cacheWrites.length).toBe(cacheWrites);
    expect(ctx.engine.getStatus().error?.kind).toBe('network');
    // Фоновая синхронизация при ошибке сети молчит.
    expect(ctx.notices.filter((n) => n.includes('связи'))).toEqual([]);
  });

  it('ошибка входа — понятное уведомление один раз', async () => {
    ctx.server.discover = async () => fail('auth');
    expect(await ctx.engine.syncNow()).toMatchObject({ status: 'error', kind: 'auth' });
    expect(await ctx.engine.syncNow()).toMatchObject({ status: 'error', kind: 'auth' });
    expect(ctx.notices.filter((n) => n.includes('Apple ID'))).toHaveLength(1);
  });

  it('задача выполнена или удалена → событие удаляется', async () => {
    expectOk(await ctx.engine.syncNow());
    fm(ctx.notes, TASK_TIMED).done = true;
    fm(ctx.notes, TASK_TIMED).completed = '2026-10-11T12:00';
    ctx.notes.map.delete(ctx.notes.pathOf(TASK_DATE)!);
    ctx.server.log.length = 0;
    expectOk(await ctx.engine.syncNow());
    expect(ctx.server.writes().map((r) => `${r.method} ${r.href}`).sort()).toEqual(
      [`DELETE ${itemHref(PLANNER, TASK_TIMED)}`, `DELETE ${itemHref(PLANNER, TASK_DATE)}`].sort(),
    );
  });

  it('правка задачи в «Календаре» iOS перезаписывается', async () => {
    expectOk(await ctx.engine.syncNow());
    const href = itemHref(PLANNER, TASK_TIMED);
    ctx.server.setResource(href, ctx.server.resources.get(href)!.ics.replace('SUMMARY:○ Позвонить', 'SUMMARY:Чужая правка'));
    expectOk(await ctx.engine.syncNow());
    expect(parseIcs(ctx.server.resources.get(href)!.ics).events[0].summary).toBe('○ Позвонить');
    expect(ctx.notes.pathOf(TASK_TIMED)).toBe(`${paths.tasks}/Позвонить.md`);
  });

  it('кэш читается SystemCalendarCacheReader (круговой тест), включая подписку ICS', async () => {
    const url = 'webcal://example.com/holidays.ics';
    ctx.server.subscriptions.set(url, FOREIGN_ICS.replace('UID:foreign-1', 'UID:holiday-1').replace('SUMMARY:Встреча', 'SUMMARY:Праздник'));
    ctx.settings.calendarSync.icsSubscriptions = [{ name: 'Праздники', url, color: '#ff0000' }];
    expectOk(await ctx.engine.syncNow());

    const raw = ctx.getCache() as Record<string, unknown>;
    expect(raw).toMatchObject({ version: 1, range: { from: '2026-09-11', to: '2027-04-09' } });
    const reader = new SystemCalendarCacheReader({
      store: { read: async () => ({ status: 'ok', value: raw }), path: () => 'Планировщик/_system/calendar-cache.json' },
      clock: { now: () => ctx.now.value, timeZone: () => 'Europe/Moscow' },
    });
    const state = await reader.refresh();
    if (state.status !== 'ok') throw new Error(state.status);
    expect(state.data.calendars.map((c) => c.calendarId).sort()).toEqual([BIRTHDAYS, PLANNER, WORK, `ics:${url}`].sort());
    expect(state.data.calendars.find((c) => c.calendarId === BIRTHDAYS)?.allowsModifications).toBe(false);
    expect(state.data.calendars.find((c) => c.calendarId === `ics:${url}`)).toMatchObject({ title: 'Праздники', kind: 'subscription', allowsModifications: false });

    const meeting = state.data.events.find((e) => e.eventId === 'foreign-1');
    expect(meeting).toMatchObject({ calendarId: WORK, title: 'Встреча', allDay: false, start: { date: '2026-10-15', time: '18:00' }, linkedItemId: null });
    const linked = state.data.events.find((e) => e.eventId === EVENT_ID);
    expect(linked).toMatchObject({ linkedItemId: EVENT_ID, start: { date: '2026-10-12', time: '10:00' } });
    // Повторяющаяся задача развёрнута по повторениям в диапазоне.
    const monthly = state.data.events.filter((e) => e.eventId === TASK_DATE);
    expect(monthly.length).toBeGreaterThan(5);
    expect(monthly[0]).toMatchObject({ allDay: true, linkedItemId: TASK_DATE, recurrenceText: expect.any(String) });
    expect(state.data.events.some((e) => e.title === 'Праздник')).toBe(true);
  });

  it('недоступная подписка сохраняет прежние события в кэше', async () => {
    const url = 'https://example.com/a.ics';
    ctx.server.subscriptions.set(url, FOREIGN_ICS.replace('UID:foreign-1', 'UID:sub-1'));
    ctx.settings.calendarSync.icsSubscriptions = [{ name: 'A', url, color: '#00ff00' }];
    expectOk(await ctx.engine.syncNow());
    ctx.server.subscriptions.delete(url);
    ctx.now.value = new Date('2026-10-11T20:00:00Z');
    fm(ctx.notes, EVENT_ID).start = '2026-10-12T09:30';
    expectOk(await ctx.engine.syncNow());
    const raw = ctx.getCache() as { events: Array<{ id: string }> };
    expect(raw.events.some((e) => e.id === 'sub-1')).toBe(true);
  });

  it('параллельные запуски объединяются', async () => {
    const a = ctx.engine.syncNow();
    const b = ctx.engine.syncNow();
    expect(a).toBe(b);
    expectOk(await a);
    const puts = ctx.server.log.filter((r) => r.method === 'PUT');
    expect(new Set(puts.map((r) => r.href)).size).toBe(puts.length);
  });

  it('выключенная синхронизация и неготовый индекс — пропуск', async () => {
    ctx.notes.ready = false;
    expect(await ctx.engine.syncNow()).toEqual({ status: 'skipped', reason: 'not-ready' });
    ctx.settings.calendarSync.enabled = false;
    expect(await ctx.engine.syncNow()).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(ctx.server.log).toEqual([]);
  });
});

describe('caldav/CalendarSyncScheduler', () => {
  it('debounce после изменений и интервал', async () => {
    const timers = new Map<number, () => void>();
    let nextId = 0;
    let now = 0;
    const runs: number[] = [];
    const scheduler = new CalendarSyncScheduler({
      engine: {
        syncNow: async () => {
          runs.push(now);
          return { status: 'skipped', reason: 'disabled' } as const;
        },
      },
      isEnabled: () => true,
      intervalMs: () => 15 * 60_000,
      now: () => now,
      setTimeout: (callback) => {
        timers.set(++nextId, callback);
        return nextId;
      },
      clearTimeout: (id) => timers.delete(id),
    });
    scheduler.schedule();
    scheduler.schedule();
    expect(timers.size).toBe(1);
    [...timers.values()][0]();
    expect(runs).toEqual([0]);
    now = 10 * 60_000;
    scheduler.tick();
    expect(runs).toEqual([0]);
    now = 16 * 60_000;
    scheduler.tick();
    expect(runs).toEqual([0, 16 * 60_000]);
    scheduler.dispose();
    const issued = nextId;
    scheduler.schedule();
    expect(nextId).toBe(issued);
  });
});
