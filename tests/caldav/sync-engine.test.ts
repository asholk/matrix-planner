import { beforeEach, describe, expect, it } from 'vitest';
import type { NoteIndex, NoteRepository, SystemJsonReadResult, TombstoneWriter } from '../../src/app/contracts';
import type { CalDavCalendar, CalDavError, CalDavResult } from '../../src/caldav/client-types';
import {
  CalendarSyncEngine,
  CalendarSyncScheduler,
  itemHref,
  PUSH_DELAY_MS,
  type CalDavApi,
  type PushOutcome,
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
    this.log.push({ method: 'PROPFIND', href: HOST });
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
    expect(monthly[0]).toMatchObject({ allDay: true, linkedItemId: TASK_DATE, recurrenceText: expect.any(String) as string });
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

  describe('подтверждение массового удаления (ТЗ §5.4.3)', () => {
    const EXTRA = ['01JA2B3C4D5E6F7G8H9JKMNPA1', '01JA2B3C4D5E6F7G8H9JKMNPA2', '01JA2B3C4D5E6F7G8H9JKMNPA3', '01JA2B3C4D5E6F7G8H9JKMNPA4'];

    function addEvents(count: number): ItemId[] {
      const ids = EXTRA.slice(0, count);
      ids.forEach((id, i) => {
        ctx.notes.map.set(`${paths.events}/Событие ${i}.md`, { fm: eventFm(id, '2026-10-20T10:00', '2026-10-20T11:00'), body: '' });
      });
      return ids;
    }

    async function tombstone(ids: ItemId[]): Promise<void> {
      for (const id of ids) {
        const path = ctx.notes.pathOf(id);
        if (path) ctx.notes.map.delete(path);
        await ctx.tombstones.add(id);
      }
    }

    it('больше 3 событий — ничего не удаляется, статус и уведомление; после подтверждения — удаляются', async () => {
      const ids = [EVENT_ID, ...addEvents(3)];
      expectOk(await ctx.engine.syncNow());
      await tombstone(ids);
      ctx.server.log.length = 0;

      expectOk(await ctx.engine.syncNow());
      expect(ctx.server.writes().filter((r) => r.method === 'DELETE')).toEqual([]);
      for (const id of ids) expect(ctx.server.resources.has(itemHref(PLANNER, id))).toBe(true);
      expect(ctx.engine.getPendingDeletions()).toBe(4);
      expect(ctx.engine.getStatus().pendingDeletions).toBe(4);
      expect(ctx.notices.filter((n) => /confirm/i.test(n))).toHaveLength(1);

      // Фоновый повтор — без нового уведомления; заметки с меткой не пишутся заново.
      ctx.server.log.length = 0;
      expectOk(await ctx.engine.syncNow());
      expect(ctx.server.writes()).toEqual([]);
      expect(ctx.notices.filter((n) => /confirm/i.test(n))).toHaveLength(1);

      const confirmed = ctx.engine.confirmPendingDeletions();
      expect(confirmed).not.toBeNull();
      expectOk(await confirmed!);
      for (const id of ids) expect(ctx.server.resources.has(itemHref(PLANNER, id))).toBe(false);
      expect(ctx.engine.getPendingDeletions()).toBe(0);
      expect(ctx.engine.getStatus().pendingDeletions).toBe(0);
      expect(ctx.engine.confirmPendingDeletions()).toBeNull();
    });

    it('3 события удаляются без подтверждения; метки событий, которых нет на сервере, не считаются', async () => {
      const ids = [EVENT_ID, ...addEvents(2)];
      expectOk(await ctx.engine.syncNow());
      // Две метки событий, никогда не попадавших на сервер.
      await tombstone([...ids, '01JA2B3C4D5E6F7G8H9JKMNPB1', '01JA2B3C4D5E6F7G8H9JKMNPB2']);
      expectOk(await ctx.engine.syncNow());
      for (const id of ids) expect(ctx.server.resources.has(itemHref(PLANNER, id))).toBe(false);
      expect(ctx.engine.getPendingDeletions()).toBe(0);
      expect(ctx.notices.filter((n) => /confirm/i.test(n))).toEqual([]);
    });
  });

  it('ручная синхронизация находит календарь, созданный на сервере после первого обнаружения', async () => {
    expectOk(await ctx.engine.syncNow());
    const HOME_CAL = `${HOME}home/`;
    ctx.server.calendars.push({ href: HOME_CAL, displayName: 'Дом', color: '#FF9500', components: ['VEVENT'], allowsModifications: true });
    ctx.server.setResource(`${HOME_CAL}foreign-3.ics`, FOREIGN_ICS.replace('UID:foreign-1', 'UID:foreign-3'));
    const titles = (): string[] => ((ctx.getCache() as { calendars: { title: string }[] }).calendars ?? []).map((c) => c.title);

    // Фоновый проход в пределах срока кэша обнаружения — без нового PROPFIND.
    expectOk(await ctx.engine.syncNow());
    expect(titles()).not.toContain('Дом');

    expectOk(await ctx.engine.syncNow({ manual: true }));
    expect(titles()).toContain('Дом');
    expect(ctx.engine.getKnownCalendars().map((c) => c.displayName)).toContain('Дом');
  });

  it('новый календарь кэша один раз включается в «Показываемые календари» вкладки «Календарь»', async () => {
    expectOk(await ctx.engine.syncNow());
    expect(ctx.settings.visibleCalendars.calendarIds).toEqual(expect.arrayContaining([PLANNER, WORK, BIRTHDAYS]));
    // Пользователь выключил «Работу» — следующая синхронизация не включает её заново.
    ctx.settings.visibleCalendars.calendarIds = ctx.settings.visibleCalendars.calendarIds.filter((id) => id !== WORK);
    expectOk(await ctx.engine.syncNow());
    expect(ctx.settings.visibleCalendars.calendarIds).not.toContain(WORK);
  });

  it('фоновая синхронизация обновляет список календарей по истечении срока', async () => {
    expectOk(await ctx.engine.syncNow());
    ctx.server.calendars.push({ href: `${HOME}home/`, displayName: 'Дом', components: ['VEVENT'], allowsModifications: true });
    ctx.now.value = new Date(ctx.now.value.getTime() + 31 * 60_000);
    expectOk(await ctx.engine.syncNow());
    expect(ctx.engine.getKnownCalendars().map((c) => c.displayName)).toContain('Дом');
  });

  it('ошибка входа на другом сервере CalDAV — без упоминания Apple ID', async () => {
    ctx.settings.calendarSync.provider = 'caldav';
    ctx.settings.calendarSync.serverUrl = 'http://127.0.0.1:5232/';
    ctx.server.discover = async () => fail('auth');
    expect(await ctx.engine.syncNow({ manual: true })).toMatchObject({ status: 'error', kind: 'auth' });
    expect(ctx.notices.at(-1)).toContain('username');
    expect(ctx.notices.some((n) => n.includes('Apple ID'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Адресная отправка изменений
// ---------------------------------------------------------------------------

describe('caldav/sync-engine: адресная отправка', () => {
  let ctx: ReturnType<typeof setup>;
  const NEW_EVENT = '01JA2B3C4D5E6F7G8H9JKMNPN1';
  const NEW_TASK = '01JA2B3C4D5E6F7G8H9JKMNPN2';
  beforeEach(() => {
    ctx = setup();
    ctx.server.setResource(`${WORK}foreign-1.ics`, FOREIGN_ICS);
  });

  function expectPushed(outcome: PushOutcome, pushed: number): void {
    expect(outcome).toEqual({ status: 'ok', pushed, failed: 0 });
  }

  function methods(): string[] {
    return ctx.server.log.map((r) => r.method);
  }

  it('новое событие → один PUT без выборки календарей и без повторного обнаружения', async () => {
    expectOk(await ctx.engine.syncNow());
    ctx.notes.map.set(`${paths.events}/Йога.md`, { fm: eventFm(NEW_EVENT, '2026-10-16T08:00', '2026-10-16T09:00'), body: '' });
    ctx.server.log.length = 0;

    // Остальные элементы не менялись — для них запросов нет.
    expectPushed(await ctx.engine.pushItems([NEW_EVENT, EVENT_ID, TASK_TIMED]), 1);
    expect(ctx.server.log).toEqual([{ method: 'PUT', href: itemHref(PLANNER, NEW_EVENT), etag: undefined, create: true }]);
    expect(parseIcs(ctx.server.resources.get(itemHref(PLANNER, NEW_EVENT))!.ics).events[0].summary).toBe('Йога');
    expect(ctx.engine.getStatus().lastPushAt).toBe(ctx.now.value.toISOString());

    // Следующий полный проход не пишет событие повторно.
    ctx.server.log.length = 0;
    expectOk(await ctx.engine.syncNow());
    expect(ctx.server.writes()).toEqual([]);
  });

  it('без обнаружения в сессии — обнаружение и PUT, но без выборки календарей', async () => {
    expectPushed(await ctx.engine.pushItems([EVENT_ID]), 1);
    expect(methods()).toEqual(['PROPFIND', 'MKCALENDAR', 'PUT']);
    expect(ctx.server.resources.has(itemHref(PLANNER, EVENT_ID))).toBe(true);
  });

  it('изменение события → GET и PUT с If-Match только этого события', async () => {
    expectOk(await ctx.engine.syncNow());
    const href = itemHref(PLANNER, EVENT_ID);
    const etag = ctx.server.resources.get(href)!.etag;
    fm(ctx.notes, EVENT_ID).start = '2026-10-12T09:00';
    ctx.server.log.length = 0;

    expectPushed(await ctx.engine.pushItems([EVENT_ID]), 1);
    expect(ctx.server.log).toEqual([
      { method: 'GET', href },
      { method: 'PUT', href, etag, create: undefined },
    ]);
    expect(parseIcs(ctx.server.resources.get(href)!.ics).events[0].start.time).toBe('09:00');
  });

  it('событие уже есть на сервере (создано другим устройством) → 412 → перечитать и записать', async () => {
    expectOk(await ctx.engine.syncNow());
    ctx.notes.map.set(`${paths.events}/Йога.md`, { fm: eventFm(NEW_EVENT, '2026-10-16T08:00', '2026-10-16T09:00'), body: '' });
    ctx.server.setResource(itemHref(PLANNER, NEW_EVENT), FOREIGN_ICS.replace('UID:foreign-1', `UID:${NEW_EVENT}`));
    expectPushed(await ctx.engine.pushItems([NEW_EVENT]), 1);
    expect(parseIcs(ctx.server.resources.get(itemHref(PLANNER, NEW_EVENT))!.ics).events[0].summary).toBe('Йога');
  });

  it('задача со сроком → адресная отправка; выполненная → удаление события', async () => {
    expectOk(await ctx.engine.syncNow());
    ctx.notes.map.set(`${paths.tasks}/Купить молоко.md`, { fm: taskFm(NEW_TASK, '2026-10-17'), body: '' });
    ctx.server.log.length = 0;
    expectPushed(await ctx.engine.pushItems([NEW_TASK]), 1);
    expect(ctx.server.log).toEqual([{ method: 'PUT', href: itemHref(PLANNER, NEW_TASK), etag: undefined, create: true }]);
    expect(parseIcs(ctx.server.resources.get(itemHref(PLANNER, NEW_TASK))!.ics).events[0].summary).toBe('○ Купить молоко');

    fm(ctx.notes, NEW_TASK).due = '2026-10-18';
    expectPushed(await ctx.engine.pushItems([NEW_TASK]), 1);
    expect(parseIcs(ctx.server.resources.get(itemHref(PLANNER, NEW_TASK))!.ics).events[0].start.date).toBe('2026-10-18');

    fm(ctx.notes, NEW_TASK).done = true;
    fm(ctx.notes, NEW_TASK).completed = '2026-10-11T12:00';
    ctx.server.log.length = 0;
    expectPushed(await ctx.engine.pushItems([NEW_TASK]), 1);
    expect(ctx.server.writes()).toEqual([expect.objectContaining({ method: 'DELETE', href: itemHref(PLANNER, NEW_TASK) })]);
  });

  it('удалённое событие (метка) → DELETE адресно; метка обработана для полного прохода', async () => {
    expectOk(await ctx.engine.syncNow());
    const href = itemHref(PLANNER, EVENT_ID);
    ctx.notes.map.delete(ctx.notes.pathOf(EVENT_ID)!);
    await ctx.tombstones.add(EVENT_ID);
    ctx.server.log.length = 0;

    expectPushed(await ctx.engine.pushItems([EVENT_ID]), 1);
    expect(ctx.server.log).toEqual([{ method: 'DELETE', href }]);
    expect(ctx.server.resources.has(href)).toBe(false);

    ctx.server.log.length = 0;
    expectOk(await ctx.engine.syncNow());
    expect(ctx.server.writes()).toEqual([]);
  });

  it('удаление больше порога — не адресно, а через подтверждение в полном проходе', async () => {
    const extra = ['01JA2B3C4D5E6F7G8H9JKMNPA1', '01JA2B3C4D5E6F7G8H9JKMNPA2', '01JA2B3C4D5E6F7G8H9JKMNPA3'];
    extra.forEach((id, i) => ctx.notes.map.set(`${paths.events}/Событие ${i}.md`, { fm: eventFm(id, '2026-10-20T10:00', '2026-10-20T11:00'), body: '' }));
    expectOk(await ctx.engine.syncNow());
    const ids = [EVENT_ID, ...extra];
    for (const id of ids) {
      ctx.notes.map.delete(ctx.notes.pathOf(id)!);
      await ctx.tombstones.add(id);
    }
    ctx.server.log.length = 0;

    expectPushed(await ctx.engine.pushItems(ids), 0);
    expect(ctx.server.writes()).toEqual([]);
    expectOk(await ctx.engine.syncNow());
    expect(ctx.engine.getPendingDeletions()).toBe(4);
    for (const id of ids) expect(ctx.server.resources.has(itemHref(PLANNER, id))).toBe(true);
  });

  it('изменение во время идущей синхронизации → ещё один проход', async () => {
    expectOk(await ctx.engine.syncNow());
    const href = itemHref(PLANNER, EVENT_ID);
    let second: Promise<SyncOutcome> | null = null;
    ctx.server.beforePut = (target) => {
      if (second || target !== href) return;
      // Правка во время записи: текущий проход уже сериализовал прежнюю версию.
      fm(ctx.notes, EVENT_ID).start = '2026-10-12T08:00';
      second = ctx.engine.syncNow();
    };
    fm(ctx.notes, EVENT_ID).end = '2026-10-12T11:30';
    const first = ctx.engine.syncNow();
    expectOk(await first);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expectOk(await second!);
    expect(parseIcs(ctx.server.resources.get(href)!.ics).events[0].start.time).toBe('08:00');
  });

  it('отправка во время полного прохода выполняется после него', async () => {
    expectOk(await ctx.engine.syncNow());
    ctx.notes.map.set(`${paths.events}/Йога.md`, { fm: eventFm(NEW_EVENT, '2026-10-16T08:00', '2026-10-16T09:00'), body: '' });
    let pushed: Promise<PushOutcome> | null = null;
    ctx.server.beforePut = () => {
      pushed ??= ctx.engine.pushItems([NEW_EVENT]);
    };
    fm(ctx.notes, EVENT_ID).start = '2026-10-12T07:00';
    // Полный проход видит и новое событие: адресная отправка после него ничего не повторяет.
    expectOk(await ctx.engine.syncNow());
    expect(pushed).not.toBeNull();
    expect(await pushed!).toEqual({ status: 'ok', pushed: 0, failed: 0 });
    expect(ctx.server.log.filter((r) => r.method === 'PUT' && r.href === itemHref(PLANNER, NEW_EVENT))).toHaveLength(1);
  });

  it('ошибка сети при отправке — одно уведомление с причиной; выключено или нет пароля — без запросов', async () => {
    expectOk(await ctx.engine.syncNow());
    fm(ctx.notes, EVENT_ID).start = '2026-10-12T09:00';
    ctx.server.networkDown = true;
    expect(await ctx.engine.pushItems([EVENT_ID])).toMatchObject({ status: 'error', kind: 'network' });
    expect(await ctx.engine.pushItems([EVENT_ID])).toMatchObject({ status: 'error', kind: 'network' });
    expect(ctx.notices.filter((n) => /unreachable/.test(n))).toHaveLength(1);
    expect(ctx.engine.getStatus().error?.kind).toBe('network');

    ctx.server.networkDown = false;
    expectPushed(await ctx.engine.pushItems([EVENT_ID]), 1);
    expect(ctx.engine.getStatus().error).toBeNull();

    ctx.server.log.length = 0;
    ctx.settings.calendarSync.enabled = false;
    expect(await ctx.engine.pushItems([EVENT_ID])).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(ctx.server.log).toEqual([]);
  });

  it('успешная проверка подключения включает синхронизацию и запускает первую', async () => {
    ctx.settings.calendarSync.enabled = false;
    expect(ctx.engine.isConfigured()).toBe(false);
    const result = await ctx.engine.testConnection();
    expect(result).toMatchObject({ ok: true, enabled: true });
    expect(ctx.settings.calendarSync.enabled).toBe(true);
    expect(ctx.engine.isConfigured()).toBe(true);
    expect(ctx.notices).toContain('iOS Calendar sync is turned on');
    // Первая синхронизация запущена проверкой: следующий вызов ждёт её завершения в очереди.
    expectOk(await ctx.engine.syncNow());
    expect(ctx.server.resources.has(itemHref(PLANNER, EVENT_ID))).toBe(true);

    // Повторная проверка ничего не включает и не уведомляет.
    const notices = ctx.notices.length;
    expect(await ctx.engine.testConnection()).toMatchObject({ ok: true, enabled: false });
    expect(ctx.notices.length).toBe(notices);
  });

  it('неудачная проверка синхронизацию не включает', async () => {
    ctx.settings.calendarSync.enabled = false;
    ctx.server.discover = async () => fail('auth');
    expect(await ctx.engine.testConnection()).toMatchObject({ ok: false, kind: 'auth' });
    expect(ctx.settings.calendarSync.enabled).toBe(false);
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
        pushItems: async () => ({ status: 'skipped', reason: 'disabled' }) as const,
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

describe('caldav/CalendarSyncScheduler: адресная отправка', () => {
  function create(enabled = true) {
    const timers = new Map<number, { callback: () => void; ms: number }>();
    let nextId = 0;
    const pushes: string[][] = [];
    const fulls: number[] = [];
    const scheduler = new CalendarSyncScheduler({
      engine: {
        syncNow: async () => {
          fulls.push(1);
          return { status: 'skipped', reason: 'disabled' } as const;
        },
        pushItems: async (ids) => {
          pushes.push([...ids]);
          return { status: 'ok', pushed: 1, failed: 0 } as const;
        },
      },
      isEnabled: () => enabled,
      intervalMs: () => 15 * 60_000,
      now: () => 0,
      setTimeout: (callback, ms) => {
        timers.set(++nextId, { callback, ms });
        return nextId;
      },
      clearTimeout: (id) => timers.delete(id),
    });
    return { scheduler, timers, pushes, fulls };
  }

  it('изменения отправляются через ~1 с, раньше полного прохода', () => {
    const { scheduler, timers, pushes, fulls } = create();
    scheduler.push(['a']);
    scheduler.schedule();
    scheduler.push(['b', 'a']);
    const delays = [...timers.values()].map((timer) => timer.ms).sort((x, y) => x - y);
    expect(delays).toEqual([PUSH_DELAY_MS, 10_000]);
    expect(PUSH_DELAY_MS).toBeLessThanOrEqual(1_000);
    [...timers.values()].find((timer) => timer.ms === PUSH_DELAY_MS)!.callback();
    expect(pushes).toEqual([['a', 'b']]);
    expect(fulls).toEqual([]);
  });

  it('уход в фон (flush) — немедленная отправка без ожидания таймера', () => {
    const { scheduler, timers, pushes } = create();
    scheduler.push(['a']);
    expect(scheduler.flush()).not.toBeNull();
    expect(pushes).toEqual([['a']]);
    expect(timers.size).toBe(0);
    // Нечего отправлять — ничего не вызывается.
    expect(scheduler.flush()).toBeNull();
    expect(pushes).toHaveLength(1);
  });

  it('выключенная синхронизация — без таймеров и отправки', () => {
    const { scheduler, timers, pushes } = create(false);
    scheduler.push(['a']);
    expect(timers.size).toBe(0);
    expect(scheduler.flush()).toBeNull();
    expect(pushes).toEqual([]);
  });
});

describe('caldav/sync-engine: статус адресной отправки (доработка 006, §7)', () => {
  it('pushing — true на время отправки, затем false и новое lastPushAt', async () => {
    const ctx = setup();
    const seen: Array<{ pushing: boolean | undefined; lastPushAt: string | null }> = [];
    ctx.engine.onStatusChange((status) => seen.push({ pushing: status.pushing, lastPushAt: status.lastPushAt }));
    await ctx.engine.pushItems([EVENT_ID]);
    expect(seen[0]?.pushing).toBe(true);
    expect(ctx.engine.getStatus().pushing).toBe(false);
    expect(ctx.engine.getStatus().lastPushAt).toBe(ctx.now.value.toISOString());
  });

  it('ошибка сети при отправке — pushing сбрасывается, error.kind = network', async () => {
    const ctx = setup();
    ctx.server.networkDown = true;
    await ctx.engine.pushItems([EVENT_ID]);
    expect(ctx.engine.getStatus().pushing).toBe(false);
    expect(ctx.engine.getStatus().error?.kind).toBe('network');
  });
});
