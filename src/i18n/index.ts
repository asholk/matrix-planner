/**
 * Локализация. Каждый модуль регистрирует свои словари:
 *   registerDictionary('ru', 'tasks', ruTasks);
 *   t('tasks.empty');
 * Ключ = `<модуль>.<путь>`; вложенные объекты словаря разворачиваются через точку.
 * Язык: язык Obsidian `ru*` → ru, иначе en. Нет ключа в текущем языке → en → ru → сам ключ.
 */

import { getLanguage } from 'obsidian';
import type { Language } from '../model/types';
import { ruCommon } from './ru/common';
import { enCommon } from './en/common';

/** Значение словаря: строка или вложенная группа. */
export interface Dictionary {
  [key: string]: string | Dictionary;
}

export type TranslationParams = Record<string, string | number>;

const FALLBACK_ORDER: readonly Language[] = ['en', 'ru'];

const tables: Record<Language, Map<string, string>> = {
  ru: new Map(),
  en: new Map(),
};

let overrideLanguage: Language | null = null;

/** Разворачивает вложенный словарь в плоские ключи `prefix.a.b`. */
function flatten(prefix: string, dict: Dictionary, out: Map<string, string>): void {
  for (const [key, value] of Object.entries(dict)) {
    const fullKey = `${prefix}.${key}`;
    if (typeof value === 'string') out.set(fullKey, value);
    else flatten(fullKey, value, out);
  }
}

/** Регистрирует (или заменяет) словарь модуля для языка. */
export function registerDictionary(language: Language, module: string, dict: Dictionary): void {
  const table = tables[language];
  const prefix = `${module}.`;
  for (const key of [...table.keys()]) {
    if (key.startsWith(prefix)) table.delete(key);
  }
  flatten(module, dict, table);
}

/** Чистая функция выбора языка по коду локали. */
export function resolveLanguage(code: string | null | undefined): Language {
  return code && code.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function detectObsidianLanguage(): string | null {
  try {
    return getLanguage();
  } catch {
    return null;
  }
}

export function getCurrentLanguage(): Language {
  return overrideLanguage ?? resolveLanguage(detectObsidianLanguage());
}

/** Принудительный язык (тесты, отладка); `null` — снова по Obsidian. */
export function setLanguageOverride(language: Language | null): void {
  overrideLanguage = language;
}

function lookup(key: string, language: Language): string | undefined {
  const own = tables[language].get(key);
  if (own !== undefined) return own;
  for (const fallback of FALLBACK_ORDER) {
    if (fallback === language) continue;
    const value = tables[fallback].get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Подставляет `{name}`; неизвестные плейсхолдеры остаются как есть. */
export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Перевод по ключу `<модуль>.<путь>`. */
export function t(key: string, params?: TranslationParams): string {
  const value = lookup(key, getCurrentLanguage());
  return interpolate(value ?? key, params);
}

/** Есть ли ключ хотя бы в одном языке. */
export function hasTranslation(key: string): boolean {
  return tables.ru.has(key) || tables.en.has(key);
}

/**
 * Множественное число: ищет `<key>.<категория>` по `Intl.PluralRules`
 * (ru: one/few/many/other; en: one/other), затем `<key>.other`.
 * Параметр `{count}` подставляется автоматически.
 */
export function tPlural(key: string, count: number, params?: TranslationParams): string {
  const language = getCurrentLanguage();
  const category = new Intl.PluralRules(language).select(count);
  const value = lookup(`${key}.${category}`, language) ?? lookup(`${key}.other`, language);
  return interpolate(value ?? key, { count, ...params });
}

registerDictionary('ru', 'common', ruCommon);
registerDictionary('en', 'common', enCommon);
