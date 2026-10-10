import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCurrentLanguage,
  hasTranslation,
  interpolate,
  registerDictionary,
  resolveLanguage,
  setLanguageOverride,
  t,
  tPlural,
} from '../src/i18n';
import { mockState, resetMockState } from './__mocks__/obsidian';

describe('i18n', () => {
  beforeEach(() => {
    resetMockState();
    setLanguageOverride(null);
  });

  afterEach(() => {
    setLanguageOverride(null);
  });

  describe('выбор языка', () => {
    it('ru и региональные варианты → ru', () => {
      expect(resolveLanguage('ru')).toBe('ru');
      expect(resolveLanguage('ru-RU')).toBe('ru');
      expect(resolveLanguage('RU')).toBe('ru');
    });

    it('прочие языки и пустое значение → en', () => {
      expect(resolveLanguage('en')).toBe('en');
      expect(resolveLanguage('de')).toBe('en');
      expect(resolveLanguage('uk')).toBe('en');
      expect(resolveLanguage('')).toBe('en');
      expect(resolveLanguage(null)).toBe('en');
      expect(resolveLanguage(undefined)).toBe('en');
    });

    it('берёт язык Obsidian через getLanguage()', () => {
      mockState.language = 'ru';
      expect(getCurrentLanguage()).toBe('ru');
      expect(t('common.tabs.tasks')).toBe('Задачи');
      mockState.language = 'en';
      expect(getCurrentLanguage()).toBe('en');
      expect(t('common.tabs.tasks')).toBe('Tasks');
    });

    it('override имеет приоритет над языком Obsidian', () => {
      mockState.language = 'en';
      setLanguageOverride('ru');
      expect(t('common.actions.done')).toBe('Готово');
    });
  });

  describe('словари и fallback', () => {
    it('общие словари зарегистрированы на обоих языках', () => {
      setLanguageOverride('ru');
      expect(t('common.quadrants.do')).toBe('Важно и срочно');
      setLanguageOverride('en');
      expect(t('common.quadrants.do')).toBe('Important and urgent');
    });

    it('нет ключа в ru → en', () => {
      registerDictionary('en', 'test-fallback', { onlyEn: 'Only English' });
      setLanguageOverride('ru');
      expect(t('test-fallback.onlyEn')).toBe('Only English');
    });

    it('нет ключа в en → ru', () => {
      registerDictionary('ru', 'test-fallback-ru', { onlyRu: 'Только русский' });
      setLanguageOverride('en');
      expect(t('test-fallback-ru.onlyRu')).toBe('Только русский');
    });

    it('нет ключа нигде → сам ключ', () => {
      setLanguageOverride('ru');
      expect(t('missing.module.key')).toBe('missing.module.key');
      expect(hasTranslation('missing.module.key')).toBe(false);
    });

    it('вложенные группы разворачиваются через точку', () => {
      registerDictionary('ru', 'nested', { a: { b: { c: 'глубоко' } } });
      setLanguageOverride('ru');
      expect(t('nested.a.b.c')).toBe('глубоко');
      expect(hasTranslation('nested.a.b.c')).toBe(true);
    });

    it('повторная регистрация модуля заменяет его словарь', () => {
      registerDictionary('ru', 'replace', { old: 'старое', kept: 'есть' });
      registerDictionary('ru', 'replace', { kept: 'новое' });
      setLanguageOverride('ru');
      expect(t('replace.kept')).toBe('новое');
      expect(t('replace.old')).toBe('replace.old');
    });

    it('модули с общим префиксом имени не затирают друг друга', () => {
      registerDictionary('ru', 'cal', { x: 'один' });
      registerDictionary('ru', 'calendar-test', { x: 'два' });
      registerDictionary('ru', 'cal', { x: 'три' });
      setLanguageOverride('ru');
      expect(t('calendar-test.x')).toBe('два');
      expect(t('cal.x')).toBe('три');
    });
  });

  describe('параметры', () => {
    it('подставляет параметры', () => {
      registerDictionary('ru', 'params', { greet: 'Привет, {name}! Задач: {count}' });
      setLanguageOverride('ru');
      expect(t('params.greet', { name: 'Аня', count: 3 })).toBe('Привет, Аня! Задач: 3');
    });

    it('неизвестные плейсхолдеры остаются как есть', () => {
      expect(interpolate('{a} и {b}', { a: 1 })).toBe('1 и {b}');
      expect(interpolate('без параметров')).toBe('без параметров');
    });

    it('повторяющийся параметр подставляется везде', () => {
      expect(interpolate('{x}-{x}', { x: 'y' })).toBe('y-y');
    });
  });

  describe('множественное число', () => {
    beforeEach(() => {
      registerDictionary('ru', 'plural', {
        items: { one: '{count} элемент', few: '{count} элемента', many: '{count} элементов', other: '{count} элемента' },
      });
      registerDictionary('en', 'plural', {
        items: { one: '{count} item', other: '{count} items' },
      });
    });

    it('русские формы', () => {
      setLanguageOverride('ru');
      expect(tPlural('plural.items', 1)).toBe('1 элемент');
      expect(tPlural('plural.items', 2)).toBe('2 элемента');
      expect(tPlural('plural.items', 5)).toBe('5 элементов');
      expect(tPlural('plural.items', 21)).toBe('21 элемент');
      expect(tPlural('plural.items', 11)).toBe('11 элементов');
    });

    it('английские формы', () => {
      setLanguageOverride('en');
      expect(tPlural('plural.items', 1)).toBe('1 item');
      expect(tPlural('plural.items', 0)).toBe('0 items');
      expect(tPlural('plural.items', 2)).toBe('2 items');
    });
  });
});
