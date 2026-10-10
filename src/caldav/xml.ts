/**
 * Построение тел запросов WebDAV/CalDAV и разбор multistatus.
 * DOMParser внедряется (в Obsidian — window.DOMParser, в тестах — @xmldom/xmldom).
 */

export const NS_DAV = 'DAV:';
export const NS_CALDAV = 'urn:ietf:params:xml:ns:caldav';
export const NS_CS = 'http://calendarserver.org/ns/';
export const NS_APPLE = 'http://apple.com/ns/ical/';

const NS_DECL = `xmlns:d="${NS_DAV}" xmlns:c="${NS_CALDAV}" xmlns:cs="${NS_CS}" xmlns:a="${NS_APPLE}"`;
const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n';

// ---------------------------------------------------------------------------
// Минимальные структурные типы DOM (совместимы с браузерным DOM и xmldom)
// ---------------------------------------------------------------------------

export interface XmlNode {
  nodeType: number;
  namespaceURI: string | null;
  localName: string | null;
  childNodes: ArrayLike<XmlNode>;
  textContent: string | null;
  getAttribute?(name: string): string | null;
}

export interface XmlParser {
  parseFromString(source: string, mimeType: string): unknown;
}

const ELEMENT_NODE = 1;

export function childElements(node: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  const list = node.childNodes;
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n && n.nodeType === ELEMENT_NODE) out.push(n);
  }
  return out;
}

export function isEl(node: XmlNode, ns: string, name: string): boolean {
  return node.namespaceURI === ns && node.localName === name;
}

export function findChild(node: XmlNode, ns: string, name: string): XmlNode | undefined {
  return childElements(node).find((n) => isEl(n, ns, name));
}

export function findChildren(node: XmlNode, ns: string, name: string): XmlNode[] {
  return childElements(node).filter((n) => isEl(n, ns, name));
}

export function textOf(node: XmlNode | undefined): string {
  return (node?.textContent ?? '').trim();
}

/** Разбор XML; null — не XML или ошибка разбора. */
export function parseXml(parser: XmlParser, text: string): XmlNode | null {
  if (!text.trim()) return null;
  try {
    const doc = parser.parseFromString(text, 'application/xml') as { documentElement?: XmlNode | null } | null;
    const root = doc?.documentElement ?? null;
    if (!root || root.localName === 'parsererror') return null;
    // браузерный DOMParser вкладывает parsererror внутрь документа
    if (childElements(root).some((n) => n.localName === 'parsererror')) return null;
    return root;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Построение тел
// ---------------------------------------------------------------------------

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Свойства в виде 'd:displayname', 'c:calendar-home-set' и т. п. */
export function buildPropfind(props: string[]): string {
  const inner = props.map((p) => `<${p}/>`).join('');
  return `${XML_HEAD}<d:propfind ${NS_DECL}><d:prop>${inner}</d:prop></d:propfind>`;
}

/** Дата в формате iCalendar UTC: 20261011T000000Z. */
export function formatIcsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function buildCalendarQuery(range?: { start: Date; end: Date }): string {
  const timeRange = range
    ? `<c:time-range start="${formatIcsUtc(range.start)}" end="${formatIcsUtc(range.end)}"/>`
    : '';
  return (
    `${XML_HEAD}<c:calendar-query ${NS_DECL}>` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${timeRange}</c:comp-filter></c:comp-filter></c:filter>` +
    `</c:calendar-query>`
  );
}

export function buildCalendarMultiget(hrefs: string[]): string {
  const list = hrefs.map((h) => `<d:href>${escapeXml(h)}</d:href>`).join('');
  return (
    `${XML_HEAD}<c:calendar-multiget ${NS_DECL}>` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop>${list}</c:calendar-multiget>`
  );
}

export function buildSyncCollection(syncToken: string): string {
  const token = syncToken ? `<d:sync-token>${escapeXml(syncToken)}</d:sync-token>` : '<d:sync-token/>';
  return (
    `${XML_HEAD}<d:sync-collection ${NS_DECL}>${token}<d:sync-level>1</d:sync-level>` +
    `<d:prop><d:getetag/></d:prop></d:sync-collection>`
  );
}

export function buildMkcalendar(name: string, color?: string): string {
  const colorProp = color ? `<a:calendar-color>${escapeXml(toAppleColor(color))}</a:calendar-color>` : '';
  return (
    `${XML_HEAD}<c:mkcalendar ${NS_DECL}><d:set><d:prop>` +
    `<d:displayname>${escapeXml(name)}</d:displayname>${colorProp}` +
    `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>` +
    `</d:prop></d:set></c:mkcalendar>`
  );
}

// ---------------------------------------------------------------------------
// Цвета
// ---------------------------------------------------------------------------

/** '#RRGGBBAA' / '#RRGGBB' / '#RGB' → '#RRGGBB'; иначе undefined. */
export function normalizeColor(raw: string): string | undefined {
  const s = raw.trim();
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return `#${m[1]!.toUpperCase()}`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return `#${m[1]!}${m[1]!}${m[2]!}${m[2]!}${m[3]!}${m[3]!}`.toUpperCase();
  return undefined;
}

function toAppleColor(color: string): string {
  const c = normalizeColor(color);
  return c ? `${c}FF` : color;
}

// ---------------------------------------------------------------------------
// Разбор multistatus
// ---------------------------------------------------------------------------

export interface PropStat {
  status: number;
  props: XmlNode[];
}

export interface MultistatusResponse {
  /** Абсолютный URL. */
  href: string;
  /** Статус на уровне response (например 404 для удалённых в sync-collection). */
  status?: number;
  propstats: PropStat[];
}

export interface Multistatus {
  responses: MultistatusResponse[];
  syncToken?: string;
}

/** 'HTTP/1.1 200 OK' → 200. */
export function parseStatusLine(line: string): number | undefined {
  const m = /^\s*HTTP\/\S+\s+(\d{3})/i.exec(line);
  return m ? Number(m[1]) : undefined;
}

/** Относительный href → абсолютный URL относительно адреса запроса. */
export function resolveHref(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export function parseMultistatus(root: XmlNode, baseUrl: string): Multistatus | null {
  if (!isEl(root, NS_DAV, 'multistatus')) return null;
  const responses: MultistatusResponse[] = [];
  for (const r of findChildren(root, NS_DAV, 'response')) {
    const hrefText = textOf(findChild(r, NS_DAV, 'href'));
    if (!hrefText) continue;
    const statusEl = findChild(r, NS_DAV, 'status');
    const propstats: PropStat[] = findChildren(r, NS_DAV, 'propstat').map((ps) => {
      const prop = findChild(ps, NS_DAV, 'prop');
      return {
        status: parseStatusLine(textOf(findChild(ps, NS_DAV, 'status'))) ?? 200,
        props: prop ? childElements(prop) : [],
      };
    });
    responses.push({
      href: resolveHref(hrefText, baseUrl),
      status: statusEl ? parseStatusLine(textOf(statusEl)) : undefined,
      propstats,
    });
  }
  const tokenEl = findChild(root, NS_DAV, 'sync-token');
  return { responses, syncToken: tokenEl ? textOf(tokenEl) : undefined };
}

/** Свойство из propstat со статусом 2xx. */
export function getProp(resp: MultistatusResponse, ns: string, name: string): XmlNode | undefined {
  for (const ps of resp.propstats) {
    if (ps.status < 200 || ps.status >= 300) continue;
    const found = ps.props.find((p) => isEl(p, ns, name));
    if (found) return found;
  }
  return undefined;
}

/** Значение вида <d:current-user-principal><d:href>…</d:href></d:current-user-principal>. */
export function getHrefProp(resp: MultistatusResponse, ns: string, name: string, baseUrl: string): string | undefined {
  const prop = getProp(resp, ns, name);
  if (!prop) return undefined;
  const href = textOf(findChild(prop, NS_DAV, 'href'));
  return href ? resolveHref(href, baseUrl) : undefined;
}

/** Есть ли в теле ошибки (DAV:error) указанное условие, например valid-sync-token. */
export function hasErrorCondition(root: XmlNode | null, ns: string, name: string): boolean {
  if (!root || !isEl(root, NS_DAV, 'error')) return false;
  return childElements(root).some((n) => isEl(n, ns, name));
}

/** Сравнение URL коллекций без учёта завершающего слеша и порта по умолчанию. */
export function sameResource(a: string, b: string): boolean {
  const norm = (s: string): string => {
    try {
      const u = new URL(s);
      return `${u.protocol}//${u.host}${decodeURIComponent(u.pathname)}`.replace(/\/+$/, '');
    } catch {
      return s.replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}
