import type { Dictionary } from '../index';

/** Форма задачи (ТЗ §4.3, кадры 02–06). Названия повторов и напоминаний — в словаре `model`. */
export const ruTaskForm = {
  titleCreate: 'Новая задача',
  titleEdit: 'Задача',
  fields: {
    title: 'Название',
    body: 'Заметки',
    date: 'Дата',
    time: 'Время',
    repeat: 'Повтор',
    remind: 'Напоминание',
    priority: 'Высокий приоритет',
    quadrant: 'Квадрант',
  },
  addDate: 'Добавить дату',
  addTime: 'Добавить время',
  clearDate: 'Очистить дату',
  clearTime: 'Убрать время',
  chooseDate: 'Изменить дату',
  remindAtHint: 'Для задачи без времени напоминание придёт в {time}',
  titleRequired: 'Введите название задачи',
  quadrantTile: 'Квадрант «{title}»',
  loadingBody: 'Загрузка заметок…',
  bodyLoadFailed: 'Не удалось прочитать заметки задачи. Они не изменятся',
  saved: 'Задача сохранена',
} satisfies Dictionary;
