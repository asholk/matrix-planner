/**
 * Генерация ссылок `obsidian://planner` и `shortcuts://x-callback-url` (ТЗ §4.5, §4.8).
 * Чистый модуль: название хранилища передаётся параметром, без `obsidian` и DOM.
 * Каждое значение кодируется `encodeURIComponent` (кириллица, пробелы, `&`, `?`, `=`, `#`).
 */

import type { LinkBuilder, ParsedLinkResult } from '../app/contracts';
import type { PlannerLink } from '../model/types';
import { linkToParams, parseLinkParams, PROTOCOL_ACTION } from './parameters';

export const PLANNER_URL_PREFIX = `obsidian://${PROTOCOL_ACTION}`;
export const SHORTCUT_RUN_PREFIX = 'shortcuts://x-callback-url/run-shortcut';

export const URL_ERROR_KEYS = {
  notPlanner: 'protocol.errors.notPlannerLink',
  malformed: 'protocol.errors.malformed',
} as const;

function toQuery(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

/** Параметр ссылок возврата быстрой команды: профиль, для которого она запущена. */
export const PROFILE_PARAM = 'profile';

/** Привязка запуска быстрой команды к профилю обоев. */
export interface ShortcutRunOptions {
  profileId?: string | null;
}

/** `LinkBuilder`, ссылка запуска которого может нести профиль. */
export interface ProfileLinkBuilder extends LinkBuilder {
  shortcutRunUrl(shortcutName: string, options?: ShortcutRunOptions): string;
}

/** `obsidian://planner?vault=…&…` — `vault` всегда первым; `extra` — после параметров ссылки. */
export function buildPlannerUrl(vaultName: string, link: PlannerLink, extra: ReadonlyArray<readonly [string, string]> = []): string {
  return `${PLANNER_URL_PREFIX}?${toQuery([['vault', vaultName], ...linkToParams(link), ...extra])}`;
}

/**
 * `shortcuts://x-callback-url/run-shortcut?name=…&x-success=…&x-error=…`.
 * Ссылки возврата целиком кодируются как значения параметров, поэтому их
 * собственные `?`/`&`/`=` и уже закодированное название хранилища не смешиваются с внешними.
 */
export function buildShortcutRunUrl(vaultName: string, shortcutName: string, options: ShortcutRunOptions = {}): string {
  // Профиль запуска: подтверждение пишется в него, даже если профиль сменили до возврата.
  const extra: Array<[string, string]> = options.profileId ? [[PROFILE_PARAM, options.profileId]] : [];
  return `${SHORTCUT_RUN_PREFIX}?${toQuery([
    ['name', shortcutName],
    ['x-success', buildPlannerUrl(vaultName, { action: 'wallpaper-done' }, extra)],
    ['x-error', buildPlannerUrl(vaultName, { action: 'wallpaper-failed' }, extra)],
  ])}`;
}

/**
 * Разбирает строку запроса в объект параметров (как их передаёт Obsidian).
 * `null` — некорректное `%`-кодирование. Повторный ключ: побеждает последний.
 */
export function parseQuery(query: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (query === '') return out;
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch {
      return null;
    }
  }
  return out;
}

export type ParsedPlannerUrl =
  | { ok: true; vault: string | null; params: Record<string, string>; result: ParsedLinkResult }
  | { ok: false; messageKey: string };

/** Полный разбор ссылки `obsidian://planner?…` (для тестов и проверки ссылок компаньона). */
export function parsePlannerUrl(url: string): ParsedPlannerUrl {
  const qIndex = url.indexOf('?');
  const head = qIndex === -1 ? url : url.slice(0, qIndex);
  if (head.toLowerCase() !== PLANNER_URL_PREFIX) return { ok: false, messageKey: URL_ERROR_KEYS.notPlanner };
  const hashIndex = url.indexOf('#', qIndex);
  const query = qIndex === -1 ? '' : url.slice(qIndex + 1, hashIndex === -1 ? undefined : hashIndex);
  const parsed = parseQuery(query);
  if (parsed === null) return { ok: false, messageKey: URL_ERROR_KEYS.malformed };
  // Как в Obsidian: имя обработчика лежит в `action`, параметр запроса его перекрывает.
  const params: Record<string, string> = { action: PROTOCOL_ACTION, ...parsed };
  return { ok: true, vault: parsed.vault ?? null, params, result: parseLinkParams(params) };
}

/** `LinkBuilder` поверх текущего названия хранилища (`app.vault.getName()`). */
export function createLinkBuilder(getVaultName: () => string): ProfileLinkBuilder {
  return {
    build: (link) => buildPlannerUrl(getVaultName(), link),
    shortcutRunUrl: (shortcutName, options) => buildShortcutRunUrl(getVaultName(), shortcutName, options),
  };
}
