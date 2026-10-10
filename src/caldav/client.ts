/**
 * Клиент CalDAV (RFC 4791, RFC 6578) для iCloud и серверов с Basic auth.
 * Без obsidian-импортов: HTTP и DOMParser внедряются. Исключения наружу не бросаются.
 */
import type {
  CalDavCalendar,
  CalDavChangedRef,
  CalDavCredentials,
  CalDavDiscovery,
  CalDavError,
  CalDavErrorCode,
  CalDavEventResource,
  CalDavPutOptions,
  CalDavPutResult,
  CalDavResult,
  CalDavSyncResult,
  CalDavTimeRange,
} from './client-types';
import type { HttpClient, HttpResponse } from './http';
import {
  NS_APPLE,
  NS_CALDAV,
  NS_CS,
  NS_DAV,
  buildCalendarMultiget,
  buildCalendarQuery,
  buildMkcalendar,
  buildPropfind,
  buildSyncCollection,
  childElements,
  getHrefProp,
  getProp,
  hasErrorCondition,
  isEl,
  normalizeColor,
  parseMultistatus,
  parseXml,
  resolveHref,
  sameResource,
  textOf,
  type Multistatus,
  type MultistatusResponse,
  type XmlParser,
} from './xml';

export interface CalDavClientDeps {
  http: HttpClient;
  xmlParser: XmlParser;
  /** Генератор сегмента URL для MKCALENDAR (по умолчанию crypto.randomUUID). */
  newId?: () => string;
  maxRedirects?: number;
}

interface SendOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Отправлять ли Authorization (для подписок ICS — нет). */
  auth?: boolean;
}

interface SendResult {
  res: HttpResponse;
  /** Адрес после редиректов — база для относительных href. */
  finalUrl: string;
}

const XML_CT = 'application/xml; charset=utf-8';
const MULTIGET_CHUNK = 100;

function ok<T>(value: T): CalDavResult<T> {
  return { ok: true, value };
}

function fail<T>(code: CalDavErrorCode, message: string, status?: number): CalDavResult<T> {
  const error: CalDavError = { code, message };
  if (status !== undefined) error.status = status;
  return { ok: false, error };
}

/** HTTP-статус → код ошибки клиента. */
export function errorFromStatus(status: number, text: string, context: string): CalDavError {
  let code: CalDavErrorCode = 'server';
  if (status === 401) code = 'auth';
  else if (status === 403 || status === 405) code = 'forbidden';
  else if (status === 412) code = 'conflict';
  else if (status === 404 || status === 410) code = 'not-found';
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  return { code, status, message: `${context}: HTTP ${status}${snippet ? ` — ${snippet}` : ''}` };
}

/** Basic auth без Buffer: base64(utf8(user:pass)). */
export function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

/** webcal:// → https://; прочие схемы без изменений. */
export function normalizeSubscriptionUrl(url: string): string {
  const s = url.trim();
  if (/^webcals?:\/\//i.test(s)) return s.replace(/^webcals?:\/\//i, 'https://');
  return s;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export class CalDavClient {
  private readonly http: HttpClient;
  private readonly parser: XmlParser;
  private readonly newId: () => string;
  private readonly maxRedirects: number;
  private readonly authHeader: string;
  private readonly serverUrl: string;
  /** База для относительных href: после discover — домашняя коллекция (iCloud: pXX-caldav). */
  private baseUrl: string;

  constructor(credentials: CalDavCredentials, deps: CalDavClientDeps) {
    this.http = deps.http;
    this.parser = deps.xmlParser;
    this.newId = deps.newId ?? defaultId;
    this.maxRedirects = deps.maxRedirects ?? 5;
    this.authHeader = basicAuthHeader(credentials.username, credentials.password);
    this.serverUrl = ensureSlash(credentials.serverUrl.trim());
    this.baseUrl = this.serverUrl;
  }

  // -------------------------------------------------------------------------
  // Обнаружение
  // -------------------------------------------------------------------------

  async discover(): Promise<CalDavResult<CalDavDiscovery>> {
    // 1. current-user-principal: сначала корень, затем /.well-known/caldav
    let principal = await this.findPrincipal(this.serverUrl);
    if (!principal.ok && principal.error.code !== 'auth' && principal.error.code !== 'network') {
      const wellKnown = resolveHref('/.well-known/caldav', this.serverUrl);
      const second = await this.findPrincipal(wellKnown);
      if (second.ok) principal = second;
    }
    if (!principal.ok) return principal;
    const principalHref = principal.value;

    // 2. calendar-home-set
    const homeRes = await this.propfind(principalHref, '0', ['c:calendar-home-set']);
    if (!homeRes.ok) return homeRes;
    const homeHref = this.firstHrefProp(homeRes.value.ms, homeRes.value.base, NS_CALDAV, 'calendar-home-set');
    if (!homeHref) return fail('invalid-response', 'calendar-home-set не найден');
    this.baseUrl = homeHref;

    // 3. список календарей
    const list = await this.listCalendars(homeHref);
    if (!list.ok) return list;
    return ok({ principalHref, homeHref, calendars: list.value });
  }

  async listCalendars(homeHref: string): Promise<CalDavResult<CalDavCalendar[]>> {
    const res = await this.propfind(this.abs(homeHref), '1', [
      'd:resourcetype',
      'd:displayname',
      'a:calendar-color',
      'c:supported-calendar-component-set',
      'd:current-user-privilege-set',
      'cs:getctag',
      'd:sync-token',
    ]);
    if (!res.ok) return res;
    const calendars: CalDavCalendar[] = [];
    for (const r of res.value.ms.responses) {
      const cal = this.toCalendar(r);
      if (cal && (cal.components.length === 0 || cal.components.includes('VEVENT'))) calendars.push(cal);
    }
    return ok(calendars);
  }

  private async findPrincipal(url: string): Promise<CalDavResult<string>> {
    const res = await this.propfind(url, '0', ['d:current-user-principal']);
    if (!res.ok) return res;
    const href = this.firstHrefProp(res.value.ms, res.value.base, NS_DAV, 'current-user-principal');
    return href ? ok(href) : fail('invalid-response', 'current-user-principal не найден');
  }

  private firstHrefProp(ms: Multistatus, base: string, ns: string, name: string): string | undefined {
    for (const r of ms.responses) {
      const href = getHrefProp(r, ns, name, base);
      if (href) return href;
    }
    return undefined;
  }

  private toCalendar(r: MultistatusResponse): CalDavCalendar | null {
    const rt = getProp(r, NS_DAV, 'resourcetype');
    if (!rt || !childElements(rt).some((n) => isEl(n, NS_CALDAV, 'calendar'))) return null;

    const compSet = getProp(r, NS_CALDAV, 'supported-calendar-component-set');
    const components = compSet
      ? childElements(compSet)
          .filter((n) => isEl(n, NS_CALDAV, 'comp'))
          .map((n) => (n.getAttribute?.('name') ?? '').toUpperCase())
          .filter((s) => s.length > 0)
      : [];

    const privSet = getProp(r, NS_DAV, 'current-user-privilege-set');
    let allowsModifications = true;
    if (privSet) {
      const names = new Set<string>();
      for (const priv of childElements(privSet)) {
        if (!isEl(priv, NS_DAV, 'privilege')) continue;
        for (const p of childElements(priv)) if (p.namespaceURI === NS_DAV && p.localName) names.add(p.localName);
      }
      allowsModifications = names.has('write') || names.has('write-content') || names.has('all');
    }

    const cal: CalDavCalendar = {
      href: r.href,
      displayName: textOf(getProp(r, NS_DAV, 'displayname')) || decodeLastSegment(r.href),
      components,
      allowsModifications,
    };
    const color = normalizeColor(textOf(getProp(r, NS_APPLE, 'calendar-color')));
    if (color) cal.color = color;
    const ctag = textOf(getProp(r, NS_CS, 'getctag'));
    if (ctag) cal.ctag = ctag;
    const token = textOf(getProp(r, NS_DAV, 'sync-token'));
    if (token) cal.syncToken = token;
    return cal;
  }

  // -------------------------------------------------------------------------
  // События
  // -------------------------------------------------------------------------

  /** calendar-query VEVENT + time-range, без expand (экземпляры разворачивает ICS-модуль). */
  async listEvents(calendarHref: string, range?: CalDavTimeRange): Promise<CalDavResult<CalDavEventResource[]>> {
    const url = this.abs(calendarHref);
    const res = await this.report(url, '1', buildCalendarQuery(range));
    if (!res.ok) return res;
    const events: CalDavEventResource[] = [];
    const missing: string[] = [];
    for (const r of res.value.ms.responses) {
      if (sameResource(r.href, url)) continue;
      if (r.status !== undefined && !isSuccess(r.status)) continue;
      const ics = getProp(r, NS_CALDAV, 'calendar-data')?.textContent ?? '';
      const etag = textOf(getProp(r, NS_DAV, 'getetag')) || undefined;
      if (ics.trim()) events.push(withEtag({ href: r.href, ics }, etag));
      else missing.push(r.href);
    }
    // сервер не вернул calendar-data в calendar-query — дочитать через multiget
    if (missing.length > 0) {
      const extra = await this.multiget(url, missing);
      if (!extra.ok) return extra;
      events.push(...extra.value);
    }
    return ok(events);
  }

  /** REPORT calendar-multiget для списка href (после sync-collection). */
  async multiget(calendarHref: string, hrefs: string[]): Promise<CalDavResult<CalDavEventResource[]>> {
    const url = this.abs(calendarHref);
    const out: CalDavEventResource[] = [];
    for (let i = 0; i < hrefs.length; i += MULTIGET_CHUNK) {
      const chunk = hrefs.slice(i, i + MULTIGET_CHUNK).map((h) => pathOf(this.abs(h)));
      const res = await this.report(url, '1', buildCalendarMultiget(chunk));
      if (!res.ok) return res;
      for (const r of res.value.ms.responses) {
        if (r.status !== undefined && !isSuccess(r.status)) continue;
        const ics = getProp(r, NS_CALDAV, 'calendar-data')?.textContent ?? '';
        if (!ics.trim()) continue;
        out.push(withEtag({ href: r.href, ics }, textOf(getProp(r, NS_DAV, 'getetag')) || undefined));
      }
    }
    return ok(out);
  }

  /** RFC 6578. Пустой токен — начальная синхронизация. */
  async syncCollection(calendarHref: string, syncToken: string): Promise<CalDavResult<CalDavSyncResult>> {
    const url = this.abs(calendarHref);
    const sent = await this.send({
      method: 'REPORT',
      url,
      headers: { Depth: '0', 'Content-Type': XML_CT },
      body: buildSyncCollection(syncToken),
    });
    if (!sent.ok) return sent;
    const { res, finalUrl } = sent.value;
    const fullResync: CalDavSyncResult = {
      fullResyncRequired: true,
      changed: [],
      deleted: [],
      syncToken: '',
      truncated: false,
    };
    if (!isSuccess(res.status)) {
      const root = parseXml(this.parser, res.text);
      if (hasErrorCondition(root, NS_DAV, 'valid-sync-token') || res.status === 403) return ok(fullResync);
      return { ok: false, error: errorFromStatus(res.status, res.text, 'sync-collection') };
    }
    const ms = this.parseMs(res.text, finalUrl);
    if (!ms) return fail('invalid-response', 'sync-collection: ответ не multistatus', res.status);

    const changed: CalDavChangedRef[] = [];
    const deleted: string[] = [];
    let truncated = false;
    for (const r of ms.responses) {
      if (sameResource(r.href, url)) {
        if (r.status === 507) truncated = true;
        continue;
      }
      if (r.status === 404 || r.status === 410) {
        deleted.push(r.href);
        continue;
      }
      const etag = textOf(getProp(r, NS_DAV, 'getetag')) || undefined;
      changed.push(etag ? { href: r.href, etag } : { href: r.href });
    }
    if (!ms.syncToken) return fail('invalid-response', 'sync-collection: нет sync-token', res.status);
    return ok({ fullResyncRequired: false, changed, deleted, syncToken: ms.syncToken, truncated });
  }

  async getEvent(href: string): Promise<CalDavResult<CalDavEventResource>> {
    const url = this.abs(href);
    const sent = await this.send({ method: 'GET', url, headers: { Accept: 'text/calendar' } });
    if (!sent.ok) return sent;
    const { res } = sent.value;
    if (!isSuccess(res.status)) return { ok: false, error: errorFromStatus(res.status, res.text, `GET ${url}`) };
    return ok(withEtag({ href: url, ics: res.text }, res.headers['etag']));
  }

  async putEvent(href: string, ics: string, opts: CalDavPutOptions = {}): Promise<CalDavResult<CalDavPutResult>> {
    const url = this.abs(href);
    const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' };
    if (opts.create) headers['If-None-Match'] = '*';
    else if (opts.etag) headers['If-Match'] = opts.etag;
    const sent = await this.send({ method: 'PUT', url, headers, body: ics });
    if (!sent.ok) return sent;
    const { res } = sent.value;
    if (!isSuccess(res.status)) return { ok: false, error: errorFromStatus(res.status, res.text, `PUT ${url}`) };
    const etag = res.headers['etag'];
    return ok(etag ? { href: url, etag } : { href: url });
  }

  /** 404 — ресурс уже удалён, это успех. */
  async deleteEvent(href: string, etag?: string): Promise<CalDavResult<void>> {
    const url = this.abs(href);
    const headers: Record<string, string> = {};
    if (etag) headers['If-Match'] = etag;
    const sent = await this.send({ method: 'DELETE', url, headers });
    if (!sent.ok) return sent;
    const { res } = sent.value;
    if (isSuccess(res.status) || res.status === 404 || res.status === 410) return ok(undefined);
    return { ok: false, error: errorFromStatus(res.status, res.text, `DELETE ${url}`) };
  }

  /** MKCALENDAR в домашней коллекции; 403/405 — 'forbidden' с кодом. */
  async makeCalendar(homeHref: string, name: string, color?: string): Promise<CalDavResult<CalDavCalendar>> {
    const url = `${ensureSlash(this.abs(homeHref))}${encodeURIComponent(this.newId())}/`;
    const sent = await this.send({
      method: 'MKCALENDAR',
      url,
      headers: { 'Content-Type': XML_CT },
      body: buildMkcalendar(name, color),
    });
    if (!sent.ok) return sent;
    const { res } = sent.value;
    if (!isSuccess(res.status)) return { ok: false, error: errorFromStatus(res.status, res.text, `MKCALENDAR ${url}`) };
    const cal: CalDavCalendar = { href: url, displayName: name, components: ['VEVENT'], allowsModifications: true };
    const c = color ? normalizeColor(color) : undefined;
    if (c) cal.color = c;
    return ok(cal);
  }

  /** Подписка ICS (только чтение): webcal:// → https://, GET без авторизации. */
  async fetchIcsSubscription(url: string): Promise<CalDavResult<string>> {
    const target = normalizeSubscriptionUrl(url);
    if (!/^https?:\/\//i.test(target)) return fail('invalid-response', `Неподдерживаемый адрес: ${url}`);
    const sent = await this.send({ method: 'GET', url: target, headers: { Accept: 'text/calendar' }, auth: false });
    if (!sent.ok) return sent;
    const { res } = sent.value;
    if (!isSuccess(res.status)) return { ok: false, error: errorFromStatus(res.status, res.text, `GET ${target}`) };
    if (!/BEGIN:VCALENDAR/i.test(res.text)) return fail('invalid-response', 'Ответ не является календарём ICS', res.status);
    return ok(res.text);
  }

  // -------------------------------------------------------------------------
  // Транспорт
  // -------------------------------------------------------------------------

  private abs(href: string): string {
    return resolveHref(href, this.baseUrl);
  }

  private parseMs(text: string, base: string): Multistatus | null {
    const root = parseXml(this.parser, text);
    return root ? parseMultistatus(root, base) : null;
  }

  private async propfind(
    url: string,
    depth: '0' | '1',
    props: string[],
  ): Promise<CalDavResult<{ ms: Multistatus; base: string }>> {
    return this.davRequest('PROPFIND', url, depth, buildPropfind(props));
  }

  private async report(url: string, depth: '0' | '1', body: string): Promise<CalDavResult<{ ms: Multistatus; base: string }>> {
    return this.davRequest('REPORT', url, depth, body);
  }

  private async davRequest(
    method: string,
    url: string,
    depth: string,
    body: string,
  ): Promise<CalDavResult<{ ms: Multistatus; base: string }>> {
    const sent = await this.send({ method, url, headers: { Depth: depth, 'Content-Type': XML_CT }, body });
    if (!sent.ok) return sent;
    const { res, finalUrl } = sent.value;
    if (res.status !== 207 && !isSuccess(res.status)) {
      return { ok: false, error: errorFromStatus(res.status, res.text, `${method} ${url}`) };
    }
    const ms = this.parseMs(res.text, finalUrl);
    if (!ms) return fail('invalid-response', `${method} ${url}: ответ не multistatus`, res.status);
    return ok({ ms, base: finalUrl });
  }

  /** Запрос с ручным следованием редиректам (iCloud → pXX-caldav.icloud.com). */
  private async send(opts: SendOptions): Promise<CalDavResult<SendResult>> {
    let url = opts.url;
    let method = opts.method;
    let body = opts.body;
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.auth !== false) headers['Authorization'] = this.authHeader;
      let res: HttpResponse;
      try {
        res = await this.http.request(body !== undefined ? { url, method, headers, body } : { url, method, headers });
      } catch (e) {
        return fail('network', `${method} ${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!isRedirect(res.status)) return ok({ res, finalUrl: url });
      const location = res.headers['location'];
      if (!location) return ok({ res, finalUrl: url });
      if (hop >= this.maxRedirects) return fail('server', `${opts.method} ${opts.url}: слишком много редиректов`, res.status);
      const next = resolveHref(location, url);
      // не отправлять пароль по незащищённому каналу
      if (url.startsWith('https:') && next.startsWith('http:')) {
        return fail('server', `Редирект на незащищённый адрес: ${next}`, res.status);
      }
      url = next;
      if (res.status === 303) {
        method = 'GET';
        body = undefined;
      }
    }
  }
}

function withEtag(ev: CalDavEventResource, etag: string | undefined): CalDavEventResource {
  return etag ? { ...ev, etag } : ev;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function decodeLastSegment(href: string): string {
  const seg = pathOf(href).replace(/\/+$/, '').split('/').pop() ?? '';
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}
