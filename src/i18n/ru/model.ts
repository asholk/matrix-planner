import type { Dictionary } from '../index';

/**
 * Строки модели: относительные даты, названия правил и проблемы свойств.
 * Регистрируется как модуль `model` (ключи дат — `DATE_LABEL_KEYS` в `src/model/dates.ts`).
 */
export const ruModel = {
  dates: {
    today: 'Сегодня',
    tomorrow: 'Завтра',
    yesterday: 'Вчера',
    dayMonth: '{day} {month}',
    dayMonthYear: '{day} {month} {year}',
    dateTime: '{date} {time}',
    am: 'AM',
    pm: 'PM',
    monthsShort: {
      m1: 'янв.',
      m2: 'февр.',
      m3: 'мар.',
      m4: 'апр.',
      m5: 'мая',
      m6: 'июн.',
      m7: 'июл.',
      m8: 'авг.',
      m9: 'сент.',
      m10: 'окт.',
      m11: 'нояб.',
      m12: 'дек.',
    },
  },
  repeat: {
    none: 'Никогда',
    daily: 'Каждый день',
    weekly: 'Каждую неделю',
    monthly: 'Каждый месяц',
    yearly: 'Каждый год',
  },
  remind: {
    none: 'Нет',
    at: 'В момент события',
    '5m': 'За 5 минут',
    '15m': 'За 15 минут',
    '30m': 'За 30 минут',
    '1h': 'За 1 час',
    '1d': 'За 1 день',
  },
  priority: {
    normal: 'Обычный',
    high: 'Высокий',
  },
  issues: {
    missing: 'Нет обязательного свойства «{property}»',
    'invalid-type': 'Свойство «{property}» имеет неверный тип',
    'invalid-value': 'Недопустимое значение свойства «{property}»',
    'invalid-date': 'Свойство «{property}» не распознано как дата',
    inconsistent: 'Свойство «{property}» противоречит другим свойствам',
  },
} satisfies Dictionary;
