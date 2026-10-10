import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { CalDavClient, basicAuthHeader, normalizeSubscriptionUrl } from '../../src/caldav/client';
import type { HttpClient, HttpRequest, HttpResponse } from '../../src/caldav/http';
import {
  buildCalendarQuery,
  buildMkcalendar,
  buildSyncCollection,
  formatIcsUtc,
  normalizeColor,
  parseMultistatus,
  parseXml,
  resolveHref,
} from '../../src/caldav/xml';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

type Handler = (req: HttpRequest) => Partial<HttpResponse> | Error | undefined;

class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly handlers: Handler[]) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    for (const h of this.handlers) {
      const r = h(req);
      if (r instanceof Error) throw r;
      if (r) return { status: r.status ?? 200, headers: r.headers ?? {}, text: r.text ?? '' };
    }
    return { status: 404, headers: {}, text: 'no handler' };
  }
}

const ICLOUD = 'https://caldav.icloud.com';
const P57 = 'https://p57-caldav.icloud.com';
const HOME = `${P57}/123456789/calendars/`;
const CAL = `${P57}/123456789/calendars/home/`;

function makeClient(handlers: Handler[], newId?: () => string): { client: CalDavClient; http: FakeHttp } {
  const http = new FakeHttp(handlers);
  const client = new CalDavClient(
    { serverUrl: ICLOUD, username: 'user@icloud.com', password: 'abcd-efgh-ijkl-mnop' },
    { http, xmlParser: new DOMParser(), newId },
  );
  return { client, http };
}

const on =
  (method: string, url: string, res: Partial<HttpResponse> | Error, depth?: string): Handler =>
  (req) =>
    req.method === method && req.url === url && (depth === undefined || req.headers['Depth'] === depth)
      ? res
      : undefined;

/** Полный сценарий обнаружения iCloud с редиректом на pXX. */
function icloudDiscoveryHandlers(): Handler[] {
  return [
    on('PROPFIND', `${ICLOUD}/`, { status: 207, text: fixture('icloud-principal.xml') }, '0'),
    on('PROPFIND', `${ICLOUD}/123456789/principal/`, { status: 301, headers: { location: `${P57}/123456789/principal/` } }),
    on('PROPFIND', `${P57}/123456789/principal/`, { status: 207, text: fixture('icloud-home-set.xml') }, '0'),
    on('PROPFIND', HOME, { status: 207, text: fixture('icloud-calendars.xml') }, '1'),
  ];
}

describe('xml', () => {
  it('normalizeColor отбрасывает альфа-канал Apple', () => {
    expect(normalizeColor('#34AADCFF')).toBe('#34AADC');
    expect(normalizeColor('#ff2968')).toBe('#FF2968');
    expect(normalizeColor('#abc')).toBe('#AABBCC');
    expect(normalizeColor('red')).toBeUndefined();
  });

  it('resolveHref делает относительные href абсолютными', () => {
    expect(resolveHref('/1/principal/', 'https://caldav.icloud.com/')).toBe('https://caldav.icloud.com/1/principal/');
    expect(resolveHref('https://p57-caldav.icloud.com:443/1/', 'https://caldav.icloud.com/')).toBe(
      'https://p57-caldav.icloud.com/1/',
    );
  });

  it('formatIcsUtc и time-range в calendar-query', () => {
    expect(formatIcsUtc(new Date('2026-10-11T05:06:07.123Z'))).toBe('20261011T050607Z');
    const body = buildCalendarQuery({ start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') });
    expect(body).toContain('<c:time-range start="20261001T000000Z" end="20261101T000000Z"/>');
    expect(body).toContain('<c:comp-filter name="VEVENT">');
    expect(body).not.toContain('expand');
  });

  it('тела запросов — корректный XML с экранированием', () => {
    const parser = new DOMParser();
    const mk = buildMkcalendar('Планировщик <&>', '#112233');
    expect(parseXml(parser, mk)).not.toBeNull();
    expect(mk).toContain('Планировщик &lt;&amp;&gt;');
    expect(mk).toContain('#112233FF');
    expect(buildSyncCollection('')).toContain('<d:sync-token/>');
    expect(parseXml(parser, buildSyncCollection('a&b'))).not.toBeNull();
  });

  it('parseXml возвращает null для не-XML', () => {
    expect(parseXml(new DOMParser(), '<html><body>Oops')).toBeNull();
    expect(parseXml(new DOMParser(), '')).toBeNull();
  });

  it('parseMultistatus разбирает префиксы и статусы propstat', () => {
    const root = parseXml(new DOMParser(), fixture('icloud-multiget.xml'))!;
    const ms = parseMultistatus(root, CAL)!;
    expect(ms.responses).toHaveLength(1);
    expect(ms.responses[0].href).toBe(`${CAL}abc-2.ics`);
    expect(ms.responses[0].propstats[0].status).toBe(200);
  });
});

describe('basic auth и адреса', () => {
  it('кодирует UTF-8 без Buffer', () => {
    expect(basicAuthHeader('user', 'pass')).toBe('Basic dXNlcjpwYXNz');
    // 'юзер:пароль' в UTF-8
    expect(basicAuthHeader('юзер', 'пароль')).toBe('Basic 0Y7Qt9C10YA60L/QsNGA0L7Qu9GM');
  });

  it('webcal:// → https://', () => {
    expect(normalizeSubscriptionUrl('webcal://example.com/a.ics')).toBe('https://example.com/a.ics');
    expect(normalizeSubscriptionUrl('webcals://example.com/a.ics')).toBe('https://example.com/a.ics');
    expect(normalizeSubscriptionUrl('https://example.com/a.ics')).toBe('https://example.com/a.ics');
  });
});

describe('CalDavClient.discover', () => {
  it('находит principal, home-set (с редиректом) и календари с VEVENT', async () => {
    const { client, http } = makeClient(icloudDiscoveryHandlers());
    const res = await client.discover();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.principalHref).toBe(`${ICLOUD}/123456789/principal/`);
    expect(res.value.homeHref).toBe(HOME);
    const cals = res.value.calendars;
    expect(cals.map((c) => c.displayName)).toEqual(['Дом', 'Семья']);
    expect(cals[0]).toEqual({
      href: CAL,
      displayName: 'Дом',
      color: '#34AADC',
      components: ['VEVENT'],
      allowsModifications: true,
      ctag: 'HwoQEgwAAAh4yw==',
      syncToken: 'HwoQEgwAAAh4yw8AAAAAAAAAAAAAAAAA',
    });
    expect(cals[1].allowsModifications).toBe(false);
    expect(cals[1].color).toBe('#FF2968');
    // авторизация и Depth в каждом запросе, включая повтор после редиректа
    for (const r of http.requests) expect(r.headers['Authorization']).toMatch(/^Basic /);
    expect(http.requests.filter((r) => r.url === `${P57}/123456789/principal/`)).toHaveLength(1);
  });

  it('после discover относительные href разрешаются от хоста pXX', async () => {
    const { client, http } = makeClient([...icloudDiscoveryHandlers(), on('DELETE', `${CAL}x.ics`, { status: 204 })]);
    await client.discover();
    expect((await client.deleteEvent('/123456789/calendars/home/x.ics')).ok).toBe(true);
    expect(http.requests.at(-1)!.url).toBe(`${CAL}x.ics`);
  });

  it('при отсутствии principal в корне пробует /.well-known/caldav', async () => {
    const { client } = makeClient([
      on('PROPFIND', `${ICLOUD}/`, { status: 405, text: 'Method Not Allowed' }),
      on('PROPFIND', `${ICLOUD}/.well-known/caldav`, { status: 301, headers: { location: '/dav/' } }),
      on('PROPFIND', `${ICLOUD}/dav/`, { status: 207, text: fixture('icloud-principal.xml') }),
      ...icloudDiscoveryHandlers().slice(1),
    ]);
    const res = await client.discover();
    expect(res.ok).toBe(true);
  });

  it('401 → auth', async () => {
    const { client } = makeClient([on('PROPFIND', `${ICLOUD}/`, { status: 401, text: 'Unauthorized' })]);
    const res = await client.discover();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatchObject({ code: 'auth', status: 401 });
  });

  it('сетевая ошибка → network', async () => {
    const { client } = makeClient([() => new Error('ERR_INTERNET_DISCONNECTED')]);
    const res = await client.discover();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('network');
  });

  it('не-XML ответ → invalid-response', async () => {
    const { client } = makeClient([() => ({ status: 207, text: '<html>oops' })]);
    const res = await client.discover();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid-response');
  });

  it('бесконечный редирект ограничен', async () => {
    const { client } = makeClient([() => ({ status: 302, headers: { location: `${ICLOUD}/loop/` } })]);
    const res = await client.discover();
    expect(res.ok).toBe(false);
  });
});

describe('CalDavClient.listEvents', () => {
  it('calendar-query + дочитывание через multiget, если нет calendar-data', async () => {
    const { client, http } = makeClient([
      (req) =>
        req.method === 'REPORT' && req.url === CAL && req.body?.includes('calendar-query')
          ? { status: 207, text: fixture('icloud-calendar-query.xml') }
          : undefined,
      (req) =>
        req.method === 'REPORT' && req.url === CAL && req.body?.includes('calendar-multiget')
          ? { status: 207, text: fixture('icloud-multiget.xml') }
          : undefined,
    ]);
    const res = await client.listEvents(CAL, {
      start: new Date('2026-10-01T00:00:00Z'),
      end: new Date('2026-11-01T00:00:00Z'),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(2);
    expect(res.value[0]).toMatchObject({ href: `${CAL}abc-1.ics`, etag: '"C=101@U=abc"' });
    expect(res.value[0].ics).toContain('SUMMARY:Встреча & обед');
    expect(res.value[1].ics).toContain('UID:abc-2');
    expect(http.requests[0].headers['Depth']).toBe('1');
    expect(http.requests[1].body).toContain('<d:href>/123456789/calendars/home/abc-2.ics</d:href>');
  });
});

describe('CalDavClient.syncCollection', () => {
  it('возвращает изменённые и удалённые href и новый токен', async () => {
    const { client, http } = makeClient([on('REPORT', CAL, { status: 207, text: fixture('icloud-sync-collection.xml') }, '0')]);
    const res = await client.syncCollection(CAL, 'old-token');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({
      fullResyncRequired: false,
      changed: [{ href: `${CAL}abc-1.ics`, etag: '"C=110@U=abc"' }],
      deleted: [`${CAL}gone.ics`],
      syncToken: 'HwoQEgwAAAh4yw8AAAAAAAAAAAAAAAAB',
      truncated: true,
    });
    expect(http.requests[0].body).toContain('<d:sync-token>old-token</d:sync-token>');
  });

  it('valid-sync-token → нужна полная выборка', async () => {
    const { client } = makeClient([on('REPORT', CAL, { status: 409, text: fixture('sync-token-invalid.xml') })]);
    const res = await client.syncCollection(CAL, 'expired');
    expect(res.ok && res.value.fullResyncRequired).toBe(true);
  });

  it('403 → нужна полная выборка', async () => {
    const { client } = makeClient([on('REPORT', CAL, { status: 403, text: '' })]);
    const res = await client.syncCollection(CAL, 'expired');
    expect(res.ok && res.value.fullResyncRequired).toBe(true);
  });

  it('500 → server с кодом', async () => {
    const { client } = makeClient([on('REPORT', CAL, { status: 500, text: 'Internal' })]);
    const res = await client.syncCollection(CAL, 't');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatchObject({ code: 'server', status: 500 });
  });
});

describe('CalDavClient: события', () => {
  const EV = `${CAL}note-1.ics`;

  it('getEvent возвращает ics и etag', async () => {
    const { client } = makeClient([on('GET', EV, { status: 200, headers: { etag: '"e1"' }, text: 'BEGIN:VCALENDAR' })]);
    const res = await client.getEvent(EV);
    expect(res).toEqual({ ok: true, value: { href: EV, etag: '"e1"', ics: 'BEGIN:VCALENDAR' } });
  });

  it('putEvent create → If-None-Match: *', async () => {
    const { client, http } = makeClient([on('PUT', EV, { status: 201, headers: { etag: '"e2"' } })]);
    const res = await client.putEvent(EV, 'BEGIN:VCALENDAR', { create: true });
    expect(res).toEqual({ ok: true, value: { href: EV, etag: '"e2"' } });
    expect(http.requests[0].headers['If-None-Match']).toBe('*');
    expect(http.requests[0].headers['If-Match']).toBeUndefined();
    expect(http.requests[0].headers['Content-Type']).toContain('text/calendar');
  });

  it('putEvent с etag → If-Match; 412 → conflict', async () => {
    const { client, http } = makeClient([on('PUT', EV, { status: 412, text: 'Precondition Failed' })]);
    const res = await client.putEvent(EV, 'X', { etag: '"old"' });
    expect(http.requests[0].headers['If-Match']).toBe('"old"');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('conflict');
  });

  it('putEvent без etag в ответе', async () => {
    const { client } = makeClient([on('PUT', EV, { status: 204 })]);
    expect(await client.putEvent(EV, 'X')).toEqual({ ok: true, value: { href: EV } });
  });

  it('deleteEvent: 404 — успех, 412 — конфликт', async () => {
    const a = makeClient([on('DELETE', EV, { status: 404 })]);
    expect((await a.client.deleteEvent(EV, '"e"')).ok).toBe(true);
    expect(a.http.requests[0].headers['If-Match']).toBe('"e"');
    const b = makeClient([on('DELETE', EV, { status: 412 })]);
    const res = await b.client.deleteEvent(EV, '"e"');
    expect(!res.ok && res.error.code).toBe('conflict');
  });
});

describe('CalDavClient.makeCalendar', () => {
  it('MKCALENDAR в домашней коллекции', async () => {
    const { client, http } = makeClient([on('MKCALENDAR', `${HOME}planner-id/`, { status: 201 })], () => 'planner-id');
    const res = await client.makeCalendar(HOME, 'Планировщик', '#5856D6');
    expect(res).toEqual({
      ok: true,
      value: {
        href: `${HOME}planner-id/`,
        displayName: 'Планировщик',
        color: '#5856D6',
        components: ['VEVENT'],
        allowsModifications: true,
      },
    });
    expect(http.requests[0].body).toContain('<d:displayname>Планировщик</d:displayname>');
  });

  it('403/405 → forbidden с кодом', async () => {
    for (const status of [403, 405]) {
      const { client } = makeClient([() => ({ status, text: 'nope' })], () => 'x');
      const res = await client.makeCalendar(HOME, 'Планировщик', '#5856D6');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatchObject({ code: 'forbidden', status });
    }
  });
});

describe('CalDavClient.fetchIcsSubscription', () => {
  it('webcal → https, без Authorization', async () => {
    const { client, http } = makeClient([
      on('GET', 'https://example.com/holidays.ics', { status: 200, text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }),
    ]);
    const res = await client.fetchIcsSubscription('webcal://example.com/holidays.ics');
    expect(res.ok && res.value).toContain('BEGIN:VCALENDAR');
    expect(http.requests[0].headers['Authorization']).toBeUndefined();
  });

  it('не ICS → invalid-response; 404 → not-found', async () => {
    const a = makeClient([() => ({ status: 200, text: '<html></html>' })]);
    const r1 = await a.client.fetchIcsSubscription('https://example.com/x');
    expect(!r1.ok && r1.error.code).toBe('invalid-response');
    const b = makeClient([() => ({ status: 404 })]);
    const r2 = await b.client.fetchIcsSubscription('https://example.com/x');
    expect(!r2.ok && r2.error.code).toBe('not-found');
  });
});
