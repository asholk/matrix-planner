import type { Dictionary } from '../index';

/** Оболочка вида: панель вкладок, «+», меню «Добавить», лист формы, выбор даты. */
export const ruShell = {
  tabBar: 'Разделы планировщика',
  tabUnavailable: 'Раздел пока недоступен',
  tabFailed: 'Не удалось показать раздел',
  /** Кнопка главного меню Obsidian на панели вкладок. */
  menu: 'Меню',
  sidebar: {
    left: 'Левая боковая панель',
    right: 'Правая боковая панель',
  },
  add: {
    button: 'Добавить',
    title: 'Добавить',
    task: 'Задача',
    event: 'Событие',
    note: 'Заметка',
    unavailable: 'Пока недоступно',
  },
  settings: {
    unavailable: 'Не удалось открыть настройки. Откройте их через меню Obsidian',
  },
  sheet: {
    close: 'Закрыть',
    submit: 'Готово',
    busy: 'Сохранение…',
  },
  datePicker: {
    label: 'Выбор даты',
    prevMonth: 'Предыдущий месяц',
    nextMonth: 'Следующий месяц',
    prevYear: 'Предыдущий год',
    nextYear: 'Следующий год',
    chooseMonth: 'Выбрать месяц и год',
    backToDays: 'Вернуться к дням',
    today: 'Сегодня',
    tomorrow: 'Завтра',
    nextWeek: 'Через неделю',
    clear: 'Очистить дату',
    selected: 'выбрано',
    todayMark: 'сегодня',
  },
} satisfies Dictionary;
