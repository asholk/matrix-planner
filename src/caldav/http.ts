/**
 * Внедряемый HTTP-клиент. Единственный модуль CalDAV с импортом obsidian.
 */
import { requestUrl } from 'obsidian';

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** Имена заголовков в нижнем регистре. */
  headers: Record<string, string>;
  text: string;
}

export interface HttpClient {
  /** Бросает исключение только при сетевой ошибке; любой HTTP-статус — обычный ответ. */
  request(req: HttpRequest): Promise<HttpResponse>;
}

export function lowerCaseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v);
  return out;
}

/** HTTP через `requestUrl` (обходит CORS, работает на мобильных). */
export function createObsidianHttp(): HttpClient {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const res = await requestUrl({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        throw: false,
      });
      let text = '';
      try {
        text = res.text;
      } catch {
        // тело не декодируется как текст — для CalDAV не нужно
      }
      return { status: res.status, headers: lowerCaseHeaders(res.headers), text };
    },
  };
}
