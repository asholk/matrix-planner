/**
 * Типы клиента CalDAV (RFC 4791, RFC 6578). Без зависимостей от obsidian и DOM.
 */

export type CalDavErrorCode =
  | 'auth' // 401 — неверный Apple ID / пароль приложения
  | 'network' // запрос не дошёл до сервера
  | 'forbidden' // 403 / 405 — сервер запрещает операцию
  | 'conflict' // 412 — etag не совпал (событие изменено на другом устройстве)
  | 'not-found' // 404 там, где ресурс обязателен
  | 'invalid-response' // ответ не разбирается (не XML, нет нужных свойств)
  | 'server'; // прочие коды

export interface CalDavError {
  code: CalDavErrorCode;
  /** HTTP-статус, если ответ был получен. */
  status?: number;
  /** Техническое описание для консоли (не для интерфейса). */
  message: string;
}

/** Результат операции клиента: исключения наружу не бросаются. */
export type CalDavResult<T> = { ok: true; value: T } | { ok: false; error: CalDavError };

export interface CalDavCredentials {
  /** Адрес сервера, например https://caldav.icloud.com. */
  serverUrl: string;
  username: string;
  password: string;
}

export interface CalDavCalendar {
  /** Абсолютный URL коллекции (со слешем в конце, как вернул сервер). */
  href: string;
  displayName: string;
  /** Цвет '#RRGGBB' (альфа-канал Apple отброшен). */
  color?: string;
  /** Поддерживаемые компоненты (VEVENT, VTODO…); пусто — сервер не сообщил. */
  components: string[];
  /** Есть право записи (DAV:write / write-content / all). */
  allowsModifications: boolean;
  ctag?: string;
  syncToken?: string;
}

export interface CalDavDiscovery {
  principalHref: string;
  homeHref: string;
  /** Только календари с поддержкой VEVENT. */
  calendars: CalDavCalendar[];
}

export interface CalDavTimeRange {
  start: Date;
  end: Date;
}

export interface CalDavEventResource {
  /** Абсолютный URL ресурса .ics. */
  href: string;
  etag?: string;
  ics: string;
}

export interface CalDavChangedRef {
  href: string;
  etag?: string;
}

export interface CalDavSyncResult {
  /** Токен устарел/недействителен — нужна полная выборка через listEvents. */
  fullResyncRequired: boolean;
  changed: CalDavChangedRef[];
  deleted: string[];
  /** Новый токен (при fullResyncRequired — пустая строка). */
  syncToken: string;
  /** Сервер вернул не все изменения (507) — повторить запрос с новым токеном. */
  truncated: boolean;
}

export interface CalDavPutOptions {
  /** Обновление существующего ресурса: If-Match. */
  etag?: string;
  /** Создание нового ресурса: If-None-Match: *. */
  create?: boolean;
}

export interface CalDavPutResult {
  href: string;
  /** Новый etag, если сервер его вернул (иначе прочитать GET). */
  etag?: string;
}
