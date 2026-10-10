/**
 * Значения по умолчанию модели (ТЗ §3, §6). Чистый модуль без `obsidian`.
 */

import {
  QUADRANT_KEYS,
  type EventColor,
  type IconName,
  type Language,
  type MatrixConfig,
  type Priority,
  type PropertyIssue,
  type QuadrantConfig,
  type QuadrantKey,
  type RemindOffset,
  type RepeatRule,
  type VaultPath,
} from './types';

/** Цвета и значки квадрантов по умолчанию (ТЗ §6). */
export const DEFAULT_QUADRANT_STYLE: Readonly<Record<QuadrantKey, { color: string; background: string; icon: IconName }>> = {
  do: { color: '#E5484D', background: '#FDECEC', icon: 'flame' },
  plan: { color: '#3E8BF0', background: '#E8F1FD', icon: 'calendar-days' },
  urgent: { color: '#F2B33D', background: '#FDF4E2', icon: 'zap' },
  someday: { color: '#8E8E93', background: '#EEF0F3', icon: 'menu' },
};

/**
 * Названия квадрантов по умолчанию. Это данные `Матрица.md` (пользователь может их менять),
 * поэтому они здесь, а не в словаре i18n; совпадают с `common.quadrants`.
 */
export const DEFAULT_QUADRANT_TITLES: Readonly<Record<Language, Readonly<Record<QuadrantKey, string>>>> = {
  ru: { do: 'Важно и срочно', plan: 'Важно', urgent: 'Срочно', someday: 'Когда-нибудь' },
  en: { do: 'Important and urgent', plan: 'Important', urgent: 'Urgent', someday: 'Someday' },
};

export function defaultQuadrant(key: QuadrantKey, language: Language = 'ru'): QuadrantConfig {
  const style = DEFAULT_QUADRANT_STYLE[key];
  return { key, title: DEFAULT_QUADRANT_TITLES[language][key], color: style.color, icon: style.icon };
}

export function defaultQuadrants(language: Language = 'ru'): QuadrantConfig[] {
  return QUADRANT_KEYS.map((key) => defaultQuadrant(key, language));
}

/** Собирает `MatrixConfig` из 4 квадрантов в порядке `QUADRANT_KEYS`. */
export function buildMatrixConfig(
  path: VaultPath | null,
  quadrants: readonly QuadrantConfig[],
  issues: PropertyIssue[] = [],
): MatrixConfig {
  const byKey = {} as Record<QuadrantKey, QuadrantConfig>;
  for (const q of quadrants) byKey[q.key] = q;
  return {
    path,
    quadrants: QUADRANT_KEYS.map((key) => byKey[key]),
    byKey,
    issues,
  };
}

export function defaultMatrixConfig(language: Language = 'ru', path: VaultPath | null = null): MatrixConfig {
  return buildMatrixConfig(path, defaultQuadrants(language));
}

/** Значения свойств задачи, если они не заданы. */
export const TASK_DEFAULTS: Readonly<{
  quadrant: QuadrantKey;
  repeat: RepeatRule;
  remind: RemindOffset;
  priority: Priority;
}> = {
  quadrant: 'do',
  repeat: 'none',
  remind: 'none',
  priority: 'normal',
};

/** Значения свойств события, если они не заданы. */
export const EVENT_DEFAULTS: Readonly<{ color: EventColor; repeat: RepeatRule; durationMinutes: number }> = {
  color: 'blue',
  repeat: 'none',
  durationMinutes: 60,
};
