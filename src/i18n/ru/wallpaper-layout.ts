import type { Dictionary } from '../index';

/**
 * Подписи на обоях экрана блокировки (раскладка S2.T4).
 * Регистрируется как модуль `wallpaperLayout`; строки собирает `createWallpaperStrings` из `src/wallpaper/layout.ts`.
 */
export const ruWallpaperLayout = {
  // Начиная с воскресенья, как `Date.getDay()`.
  weekdayShort: {
    d0: 'В',
    d1: 'П',
    d2: 'В',
    d3: 'С',
    d4: 'Ч',
    d5: 'П',
    d6: 'С',
  },
  monthNames: {
    m1: 'Январь',
    m2: 'Февраль',
    m3: 'Март',
    m4: 'Апрель',
    m5: 'Май',
    m6: 'Июнь',
    m7: 'Июль',
    m8: 'Август',
    m9: 'Сентябрь',
    m10: 'Октябрь',
    m11: 'Ноябрь',
    m12: 'Декабрь',
  },
  monthShort: {
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
  /** Плашка на запасных обоях после 7 дней без Obsidian. */
  expired: 'Обои устарели — откройте Obsidian',
  /** Срок на устаревших обоях: без «Сегодня»/«Завтра». */
  dueDate: '{day} {month}',
  emptyQuadrant: 'Нет задач',
  yearProgress: '{percent}% года позади',
  daysLeft: {
    one: 'Остался {count} день',
    few: 'Осталось {count} дня',
    many: 'Осталось {count} дней',
    other: 'Осталось {count} дня',
  },
  moreItems: '+{count}',
} satisfies Dictionary;
