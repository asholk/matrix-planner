import type { Dictionary } from '../index';

/** Лист «Статистика» и таблетка серии во вкладке «Задачи». */
export const ruStats = {
  title: 'Статистика',
  streak: {
    label: {
      one: 'день подряд',
      few: 'дня подряд',
      many: 'дней подряд',
      other: 'дня подряд',
    },
    pill: {
      one: 'Серия: {count} день подряд. Открыть статистику',
      few: 'Серия: {count} дня подряд. Открыть статистику',
      many: 'Серия: {count} дней подряд. Открыть статистику',
      other: 'Серия: {count} дня подряд. Открыть статистику',
    },
  },
  week: {
    label: 'выполнено на этой неделе',
  },
  chart: {
    title: 'Выполненные задачи',
    period: 'за 7 дней',
    label: 'Выполненные задачи по дням текущей недели',
    day: {
      one: '{day}: {count} задача',
      few: '{day}: {count} задачи',
      many: '{day}: {count} задач',
      other: '{day}: {count} задачи',
    },
  },
  recent: {
    title: 'Недавно выполненные',
    empty: 'Выполненных задач пока нет',
    item: 'Задача «{title}», выполнена {date}, квадрант «{quadrant}»',
    archived: 'в архиве',
  },
  summary: {
    button: 'Итоги',
    header: 'Итоги недели {range}: выполнено {done}, серия {streak}',
    quadrants: 'по квадрантам',
    days: 'по дням',
    copied: 'Итоги скопированы',
    failed: 'Не удалось поделиться итогами',
    tasks: {
      one: '{count} задача',
      few: '{count} задачи',
      many: '{count} задач',
      other: '{count} задачи',
    },
    dayCount: {
      one: '{count} день',
      few: '{count} дня',
      many: '{count} дней',
      other: '{count} дня',
    },
  },
} satisfies Dictionary;
