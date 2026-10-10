import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp, type App as MockApp } from '../__mocks__/obsidian';
import fixture from '../../fixtures/calendar-cache.json';
import type { Clock, SystemJsonReadResult, SystemJsonStore, WriteGuard } from '../../src/app/contracts';
import { SystemCalendarCacheReader } from '../../src/calendar/cache-reader';
import {
  CALENDAR_CACHE_VERSION,
  cacheCoverage,
  cacheNoticeKey,
  isCalendarReadOnly,
  linkedItemIdOf,
  parseCalendarCache,
  toCacheState,
  writableCalendars,
} from '../../src/calendar/cache-schema';
import type { CalendarCacheData, CalendarCacheState } from '../../src/model/types';
import { createPlannerPaths } from '../../src/storage/paths';
import { AdapterSystemJsonStore } from '../../src/storage/system-json-store';
import { KeyedWriteQueue } from '../../src/storage/write-queue';

const TZ = 'Europe/Moscow';
const CACHE_PATH = 'Планировщик/_system/calendar-cache.json';
const LINKED_ID = '01JA2B3C4D5E6F7G8H9JKMNPQR';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseOk(value: unknown, timeZone = TZ): CalendarCacheData {
  const parsed = parseCalendarCache(value, { timeZone });
  if (parsed.status !== 'ok') throw new Error(`expected ok, got ${parsed.status}`);
  return parsed.data;
}

function fixedClock(iso: string, timeZone = TZ): Clock & { set(iso: string): void } {
  let now = new Date(iso);
  return {
    set: (next) => {
      now = new Date(next);
    },
    now: () => now,
    timeZone: () => timeZone,
  };
}

const allowAll: WriteGuard = { canWrite: () => true, check: () => null };

function setup(nowIso = '2026-10-10T12:00:00Z') {
  const app: MockApp = createMockApp();
  const store = new AdapterSystemJsonStore(app as unknown as App, {
    getPaths: () => createPlannerPaths('Планировщик'),
    queue: new KeyedWriteQueue(),
    guard: allowAll,
  });
  const clock = fixedClock(nowIso);
  const reader = new SystemCalendarCacheReader({ store, clock });
  return { app, store, clock, reader };
}

async function writeCache(app: MockApp, value: unknown): Promise<void> {
  await app.vault.adapter.write(CACHE_PATH, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('calendar/cache-schema: разбор', () => {
  it('фикстура читается целиком', () => {
    const data = parseOk(fixture);
    expect(data.version).toBe(1);
    expect(data.generatedAt).toBe('2026-10-10T06:05:12Z');
    expect(data.deviceName).toBe('iPhone Александра');
    expect(data.range).toEqual({ from: '2026-09-10', to: '2027-04-08' });
    expect(data.calendars).toHaveLength(4);
    expect(data.events).toHaveLength(6);
  });

  it('календари: allows_modifications, цвет, тип', () => {
    const data = parseOk(fixture);
    const home = data.calendars.find((c) => c.calendarId === '8C1F2E3A-0001');
    expect(home).toEqual({ calendarId: '8C1F2E3A-0001', title: 'Дом', color: '#34c759', kind: 'caldav', allowsModifications: true });
    expect(writableCalendars(data.calendars).map((c) => c.calendarId)).toEqual(['8C1F2E3A-0001', '8C1F2E3A-0002']);
    expect(isCalendarReadOnly(data.calendars, '8C1F2E3A-0003')).toBe(true);
    expect(isCalendarReadOnly(data.calendars, '8C1F2E3A-0001')).toBe(false);
    expect(isCalendarReadOnly(data.calendars, 'unknown')).toBe(true);
  });

  it('календарь без allows_modifications — только чтение; неизвестный тип → other; битый цвет → серый', () => {
    const raw = clone(fixture) as Record<string, unknown>;
    raw['calendars'] = [
      { calendar_id: 'a', title: 'A', color: '#abc', kind: 'weird' },
      { calendar_id: 'b', title: 'B', color: 'red', allows_modifications: 'yes' },
      { title: 'без id' },
      { calendar_id: 'a', title: 'дубль' },
    ];
    const data = parseOk(raw);
    expect(data.calendars).toEqual([
      { calendarId: 'a', title: 'A', color: '#aabbcc', kind: 'other', allowsModifications: false },
      { calendarId: 'b', title: 'B', color: '#8e8e93', kind: 'other', allowsModifications: false },
    ]);
  });

  it('время со смещением переводится в зону устройства, есть startMs/endMs', () => {
    const data = parseOk(fixture);
    const dentist = data.events.find((e) => e.eventId === 'E7A1:0002');
    expect(dentist?.start).toEqual({ date: '2026-10-10', time: '17:00' });
    expect(dentist?.end).toEqual({ date: '2026-10-10', time: '18:00' });
    expect(dentist?.startMs).toBe(Date.parse('2026-10-10T14:00:00Z'));
    expect(dentist?.endMs).toBe(Date.parse('2026-10-10T15:00:00Z'));

    const inTokyo = parseOk(fixture, 'Asia/Tokyo').events.find((e) => e.eventId === 'E7A1:0002');
    expect(inTokyo?.start).toEqual({ date: '2026-10-10', time: '23:00' });
    expect(inTokyo?.end).toEqual({ date: '2026-10-11', time: '00:00' });
  });

  it('весь день: даты, end исключительный, нет ms', () => {
    const data = parseOk(fixture);
    const birthday = data.events.find((e) => e.eventId === 'E7A1:0003');
    expect(birthday).toMatchObject({
      allDay: true,
      start: { date: '2026-10-11', time: null },
      end: { date: '2026-10-12', time: null },
      startMs: null,
      endMs: null,
      recurrenceText: 'Каждый год',
      occurrenceKey: 'E7A1:0003@2026-10-11',
    });
    const holidays = data.events.find((e) => e.eventId === 'E7A1:0004');
    expect(holidays?.end).toEqual({ date: '2027-01-09', time: null });
  });

  it('весь день без end или с end ≤ start — однодневное', () => {
    const raw = { ...clone(fixture), events: [
      { id: 'x', calendar_id: 'c', all_day: true, start: '2026-10-11' },
      { id: 'y', calendar_id: 'c', all_day: true, start: '2026-10-11', end: '2026-10-11' },
    ] };
    const data = parseOk(raw);
    expect(data.events.map((e) => e.end.date)).toEqual(['2026-10-12', '2026-10-12']);
  });

  it('повторения одной серии — отдельные записи с разными ключами; дубль ключа пропускается', () => {
    const data = parseOk(fixture);
    const series = data.events.filter((e) => e.eventId === 'E7A1:0001');
    expect(series).toHaveLength(2);
    expect(new Set(series.map((e) => e.occurrenceKey)).size).toBe(2);
    expect(series[0]?.occurrenceKey).toBe('E7A1:0001@2026-10-12T07:00:00.000Z');

    const raw = clone(fixture) as { events: unknown[] };
    raw.events.push(clone(raw.events[0]));
    const parsed = parseCalendarCache(raw, { timeZone: TZ });
    expect(parsed.status === 'ok' && parsed.data.events.length).toBe(6);
    expect(parsed.status === 'ok' && parsed.skipped).toBe(1);
  });

  it('связь с заметкой: item_id или URL matrixplanner://item/<id>', () => {
    const data = parseOk(fixture);
    expect(data.events.find((e) => e.eventId === 'E7A1:0002')?.linkedItemId).toBe(LINKED_ID);
    expect(data.events.find((e) => e.eventId === 'E7A1:0005')?.linkedItemId).toBe('01JA2B3C4D5E6F7G8H9JKMNPQS');
    expect(data.events.find((e) => e.eventId === 'E7A1:0003')?.linkedItemId).toBeNull();
    expect(linkedItemIdOf(null, `matrixplanner://item/${LINKED_ID}?x=1`)).toBe(LINKED_ID);
    expect(linkedItemIdOf('not-a-ulid', 'https://example.com')).toBeNull();
  });

  it('битые события пропускаются, остальные читаются', () => {
    const raw = { ...clone(fixture), events: [
      { id: 'ok', calendar_id: 'c', start: '2026-10-10T10:00:00Z', end: '2026-10-10T11:00:00Z' },
      { calendar_id: 'c', start: '2026-10-10T10:00:00Z' },
      { id: 'no-cal', start: '2026-10-10T10:00:00Z' },
      { id: 'bad-date', calendar_id: 'c', start: '2026-13-40T10:00:00Z' },
      { id: 'bad-all-day', calendar_id: 'c', all_day: true, start: 'завтра' },
      'string',
    ] };
    const parsed = parseCalendarCache(raw, { timeZone: TZ });
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(parsed.data.events.map((e) => e.eventId)).toEqual(['ok']);
    expect(parsed.skipped).toBe(5);
  });

  it('конец раньше начала → нулевая длительность; время без смещения — плавающее', () => {
    const raw = { ...clone(fixture), events: [
      { id: 'a', calendar_id: 'c', start: '2026-10-10T10:00:00Z', end: '2026-10-10T09:00:00Z' },
      { id: 'b', calendar_id: 'c', start: '2026-10-10T09:30', end: '2026-10-10T10:15' },
    ] };
    const data = parseOk(raw);
    expect(data.events[0]?.endMs).toBe(data.events[0]?.startMs);
    expect(data.events[1]?.start).toEqual({ date: '2026-10-10', time: '09:30' });
    expect(data.events[1]?.end).toEqual({ date: '2026-10-10', time: '10:15' });
  });

  it('неизвестные поля игнорируются', () => {
    const raw = { ...clone(fixture), future: { a: 1 } };
    expect(parseCalendarCache(raw, { timeZone: TZ }).status).toBe('ok');
  });

  it('повреждение: не объект, нет version/generated_at/range, списки не массивы', () => {
    const cases: unknown[] = [
      null,
      [1, 2],
      'text',
      { ...clone(fixture), version: undefined },
      { ...clone(fixture), version: '1' },
      { ...clone(fixture), version: 0 },
      { ...clone(fixture), version: 1.5 },
      { ...clone(fixture), generated_at: 'вчера' },
      { ...clone(fixture), range: undefined },
      { ...clone(fixture), range: { from: '2026-10-10' } },
      { ...clone(fixture), range: { from: '2026-10-10', to: '2026-10-01' } },
      { ...clone(fixture), calendars: {} },
      { ...clone(fixture), events: 'none' },
    ];
    for (const value of cases) expect(parseCalendarCache(value, { timeZone: TZ }).status).toBe('corrupt');
  });

  it('новая версия → unsupported-version, данные не читаются', () => {
    const parsed = parseCalendarCache({ version: CALENDAR_CACHE_VERSION + 1, whatever: true }, { timeZone: TZ });
    expect(parsed).toEqual({ status: 'unsupported-version', version: 2 });
  });

  it('пустые списки допустимы', () => {
    const data = parseOk({ version: 1, generated_at: '2026-10-10T00:00:00Z', range: { from: '2026-10-01', to: '2026-10-31' } });
    expect(data.calendars).toEqual([]);
    expect(data.events).toEqual([]);
    expect(data.deviceName).toBeNull();
  });

  it('неизвестная зона устройства не ломает разбор', () => {
    expect(parseCalendarCache(fixture, { timeZone: 'Nowhere/City' }).status).toBe('ok');
    expect(parseCalendarCache(fixture, { timeZone: '' }).status).toBe('ok');
  });
});

describe('calendar/cache-schema: устаревание и покрытие', () => {
  const parsed = parseCalendarCache(fixture, { timeZone: TZ });

  it('stale по порогу (48 ч по умолчанию)', () => {
    const fresh = toCacheState(parsed, Date.parse('2026-10-11T06:05:12Z'));
    const old = toCacheState(parsed, Date.parse('2026-10-12T06:05:13Z'));
    expect(fresh.status === 'ok' && fresh.stale).toBe(false);
    expect(old.status === 'ok' && old.stale).toBe(true);
    const custom = toCacheState(parsed, Date.parse('2026-10-10T07:05:13Z'), 60 * 60 * 1000);
    expect(custom.status === 'ok' && custom.stale).toBe(true);
  });

  it('границы диапазона включительно', () => {
    const state = toCacheState(parsed, Date.parse('2026-10-10T12:00:00Z'));
    expect(cacheCoverage(state, '2026-09-10')).toBe('covered');
    expect(cacheCoverage(state, '2027-04-08')).toBe('covered');
    expect(cacheCoverage(state, '2026-09-09')).toBe('out-of-range');
    expect(cacheCoverage(state, '2027-04-09')).toBe('out-of-range');
  });

  it('нет кэша, повреждение и новая версия → no-cache, но разные пояснения', () => {
    const missing: CalendarCacheState = { status: 'missing' };
    const corrupt: CalendarCacheState = { status: 'corrupt', detail: 'x' };
    const newer: CalendarCacheState = { status: 'unsupported-version', version: 2 };
    for (const state of [missing, corrupt, newer]) expect(cacheCoverage(state, '2026-10-10')).toBe('no-cache');
    expect(cacheNoticeKey(missing, 'no-cache')).toBe('cache.notice.noCache');
    expect(cacheNoticeKey(corrupt, 'no-cache')).toBe('cache.notice.corrupt');
    expect(cacheNoticeKey(newer, 'no-cache')).toBe('cache.notice.unsupportedVersion');
    const ok = toCacheState(parsed, Date.parse('2026-10-10T12:00:00Z'));
    expect(cacheNoticeKey(ok, 'out-of-range')).toBe('cache.notice.outOfRange');
    expect(cacheNoticeKey(ok, 'covered')).toBeNull();
  });
});

describe('calendar/cache-reader', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('до refresh и без файла — missing, календарей нет', async () => {
    expect(ctx.reader.getState()).toEqual({ status: 'missing' });
    expect(await ctx.reader.refresh()).toEqual({ status: 'missing' });
    expect(ctx.reader.coverage('2026-10-10')).toBe('no-cache');
    expect(ctx.reader.getCalendars()).toEqual([]);
  });

  it('читает файл, отдаёт календари и покрытие', async () => {
    await writeCache(ctx.app, fixture);
    const state = await ctx.reader.refresh();
    expect(state.status).toBe('ok');
    expect(state.status === 'ok' && state.stale).toBe(false);
    expect(ctx.reader.getCalendars()).toHaveLength(4);
    expect(ctx.reader.coverage('2026-10-10')).toBe('covered');
    expect(ctx.reader.coverage('2027-05-01')).toBe('out-of-range');
  });

  it('битый JSON → corrupt; новая версия → unsupported-version', async () => {
    await writeCache(ctx.app, '{"version": 1,');
    expect((await ctx.reader.refresh()).status).toBe('corrupt');
    await writeCache(ctx.app, { version: 99 });
    expect(await ctx.reader.refresh()).toEqual({ status: 'unsupported-version', version: 99 });
    expect(ctx.reader.getCalendars()).toEqual([]);
  });

  it('stale пересчитывается по часам без перечитывания файла', async () => {
    await writeCache(ctx.app, fixture);
    await ctx.reader.refresh();
    ctx.clock.set('2026-10-20T00:00:00Z');
    const state = ctx.reader.getState();
    expect(state.status === 'ok' && state.stale).toBe(true);
    expect(ctx.reader.getState()).toBe(state);
  });

  it('оповещает только при изменении', async () => {
    const listener = vi.fn();
    const off = ctx.reader.onChange(listener);
    await writeCache(ctx.app, fixture);
    await ctx.reader.refresh();
    await ctx.reader.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    await ctx.app.vault.adapter.remove(CACHE_PATH);
    await ctx.reader.refresh();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]?.[0]).toEqual({ status: 'missing' });
    off();
    await writeCache(ctx.app, fixture);
    await ctx.reader.refresh();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('watch перечитывает кэш при изменении файла в хранилище', async () => {
    const off = ctx.reader.watch(ctx.app as unknown as App);
    const changed = new Promise<CalendarCacheState>((resolve) => ctx.reader.onChange(resolve));
    await writeCache(ctx.app, fixture);
    expect((await changed).status).toBe('ok');
    off();
  });

  it('календарный кэш никогда не записывается', async () => {
    const read = vi.fn(async (): Promise<SystemJsonReadResult> => ({ status: 'ok', value: clone(fixture) }));
    const update = vi.fn();
    const write = vi.fn();
    const store = { read, update, write, path: () => CACHE_PATH } as unknown as SystemJsonStore;
    const reader = new SystemCalendarCacheReader({ store, clock: fixedClock('2026-10-10T12:00:00Z') });
    await reader.refresh();
    reader.getState();
    reader.coverage('2026-10-10');
    reader.getCalendars();
    expect(read).toHaveBeenCalledWith('calendar-cache.json');
    expect(update).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    // Сам store тоже запрещает запись.
    const result = await ctx.store.write('calendar-cache.json', { version: 1 });
    expect(!result.ok && result.error.code).toBe('read-only');
  });

  it('параллельные refresh объединяются', async () => {
    await writeCache(ctx.app, fixture);
    const [a, b] = await Promise.all([ctx.reader.refresh(), ctx.reader.refresh()]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
  });
});

describe('calendar/cache-reader: смена часового пояса', () => {
  it('после смены зоны getState отдаёт время в новой зоне и оповещает подписчиков', async () => {
    const app: MockApp = createMockApp();
    const store = new AdapterSystemJsonStore(app as unknown as App, {
      getPaths: () => createPlannerPaths('Планировщик'),
      queue: new KeyedWriteQueue(),
      guard: allowAll,
    });
    let zone = TZ;
    const clock: Clock = { now: () => new Date('2026-10-10T12:00:00Z'), timeZone: () => zone };
    const reader = new SystemCalendarCacheReader({ store, clock });
    await writeCache(app, fixture);
    await reader.refresh();
    const listener = vi.fn();
    reader.onChange(listener);

    zone = 'Asia/Tokyo';
    const state = reader.getState();
    const dentist = state.status === 'ok' ? state.data.events.find((e) => e.eventId === 'E7A1:0002') : undefined;
    expect(dentist?.start).toEqual({ date: '2026-10-10', time: '23:00' });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    // Повторное обращение без смены зоны — без оповещений и пересчёта.
    expect(reader.getState()).toBe(state);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    // Перечитывание того же файла в новой зоне не оповещает повторно.
    await reader.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('linkedItemIdOf: регистр ULID', () => {
  it('строчный ULID в item_id и в URL приводится к верхнему регистру', () => {
    const ulid = '01JA7Q3K8Z6Y2V5N4M0C1B2D3E';
    expect(linkedItemIdOf(ulid.toLowerCase(), null)).toBe(ulid);
    expect(linkedItemIdOf(null, `matrixplanner://item/${ulid.toLowerCase()}`)).toBe(ulid);
  });
});
