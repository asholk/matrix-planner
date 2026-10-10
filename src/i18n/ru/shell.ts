import type { Dictionary } from '../index';

/** Оболочка вида: панель вкладок, «+», меню «Добавить», лист формы, выбор даты. */
export const ruShell = {
  tabBar: 'Разделы планировщика',
  tabUnavailable: 'Раздел пока недоступен',
  tabFailed: 'Не удалось показать раздел',
  add: {
    button: 'Добавить',
    title: 'Добавить',
    task: 'Задача',
    event: 'Событие',
    note: 'Заметка',
    unavailable: 'Пока недоступно',
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
