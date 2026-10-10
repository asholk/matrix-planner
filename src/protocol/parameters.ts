/**
 * Разбор и проверка параметров ссылок `obsidian://planner` (ТЗ §4.8).
 * Чистый модуль: без `obsidian`, DOM и i18n — ошибки возвращаются ключами.
 *
 * Obsidian передаёт в обработчик уже раскодированные параметры запроса плюс
 * `action` — имя обработчика (`planner`), которое может перекрыть одноимённый параметр
 * запроса. Поэтому действие передаётся в `do=` (генерируемые ссылки), а `action=`
 * принимается для совместимости; `action=planner` считается отсутствующим действием.
 * `vault` не проверяется (маршрутизирует сам Obsidian).
 */

import type { ParsedLinkResult } from '../app/contracts';
import { isValidDate } from '../model/dates';
import { isUlid } from '../model/ids';
import { QUADRANT_KEYS } from '../model/types';
import type { PlannerLink, PlannerTabId, QuadrantKey } from '../model/types';

/** Имя обработчика протокола: `obsidian://planner`. */
export const PROTOCOL_ACTION = 'planner';

/** Параметр действия в генерируемых ссылках (`action` занят именем обработчика). */
export const ACTION_PARAM = 'do';

export const PLANNER_VIEWS: readonly PlannerTabId[] = ['tasks', 'calendar', 'lockscreen'];

export const LINK_ACTIONS = ['new-task', 'open', 'wallpaper-done', 'wallpaper-failed'] as const;
export type LinkAction = (typeof LINK_ACTIONS)[number];

/** Ключи i18n ошибок разбора (словарь `protocol`). */
export const LINK_ERROR_KEYS = {
  missingAction: 'protocol.errors.missingAction',
  unknownAction: 'protocol.errors.unknownAction',
  invalidView: 'protocol.errors.invalidView',
  invalidQuadrant: 'protocol.errors.invalidQuadrant',
  invalidDate: 'protocol.errors.invalidDate',
  missingId: 'protocol.errors.missingId',
  invalidId: 'protocol.errors.invalidId',
} as const;

function fail(messageKey: string): ParsedLinkResult {
  return { ok: false, messageKey };
}

/** Значение параметра: пустая строка и флаг без значения (`'true'` от Obsidian для `?x`) — разные случаи. */
function readParam(params: Readonly<Record<string, string | undefined>>, key: string): string | null {
  const value = params[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function isPlannerView(value: string): value is PlannerTabId {
  return (PLANNER_VIEWS as readonly string[]).includes(value);
}

export function isQuadrantKey(value: string): value is QuadrantKey {
  return (QUADRANT_KEYS as readonly string[]).includes(value);
}

function isLinkAction(value: string): value is LinkAction {
  return (LINK_ACTIONS as readonly string[]).includes(value);
}

/**
 * Проверяет параметры и возвращает разобранную ссылку.
 * Лишние параметры игнорируются; `view` без `action` — переключение вкладки.
 */
export function parseLinkParams(params: Readonly<Record<string, string | undefined>>): ParsedLinkResult {
  // `do` — основной параметр; `action` — совместимость (если не перекрыт именем обработчика).
  const rawAction = readParam(params, ACTION_PARAM) ?? readParam(params, 'action');
  const action = rawAction === PROTOCOL_ACTION ? null : rawAction;

  if (action === null) {
    const view = readParam(params, 'view');
    if (view === null) return fail(LINK_ERROR_KEYS.missingAction);
    if (!isPlannerView(view)) return fail(LINK_ERROR_KEYS.invalidView);
    return { ok: true, link: { action: 'view', view } };
  }

  if (!isLinkAction(action)) return fail(LINK_ERROR_KEYS.unknownAction);

  switch (action) {
    case 'new-task': {
      const quadrant = readParam(params, 'quadrant');
      if (quadrant !== null && !isQuadrantKey(quadrant)) return fail(LINK_ERROR_KEYS.invalidQuadrant);
      const date = readParam(params, 'date');
      if (date !== null && !isValidDate(date)) return fail(LINK_ERROR_KEYS.invalidDate);
      return { ok: true, link: { action: 'new-task', quadrant: quadrant as QuadrantKey | null, date } };
    }
    case 'open': {
      const id = readParam(params, 'id');
      if (id === null) return fail(LINK_ERROR_KEYS.missingId);
      // Crockford base32 нечувствителен к регистру.
      const normalized = id.toUpperCase();
      if (!isUlid(normalized)) return fail(LINK_ERROR_KEYS.invalidId);
      return { ok: true, link: { action: 'open', id: normalized } };
    }
    case 'wallpaper-done':
      return { ok: true, link: { action: 'wallpaper-done' } };
    case 'wallpaper-failed':
      return { ok: true, link: { action: 'wallpaper-failed' } };
  }
}

/** Параметры запроса для ссылки (без `vault`), в порядке ТЗ. */
export function linkToParams(link: PlannerLink): Array<[string, string]> {
  switch (link.action) {
    case 'view':
      return [['view', link.view]];
    case 'new-task': {
      const out: Array<[string, string]> = [[ACTION_PARAM, 'new-task']];
      if (link.quadrant !== null) out.push(['quadrant', link.quadrant]);
      if (link.date !== null) out.push(['date', link.date]);
      return out;
    }
    case 'open':
      return [[ACTION_PARAM, 'open'], ['id', link.id]];
    case 'wallpaper-done':
      return [[ACTION_PARAM, 'wallpaper-done']];
    case 'wallpaper-failed':
      return [[ACTION_PARAM, 'wallpaper-failed']];
  }
}
