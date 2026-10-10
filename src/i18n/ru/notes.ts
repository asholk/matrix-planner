import type { Dictionary } from '../index';

/** Быстрые заметки (ТЗ §3.5, §4.3). */
export const ruNotes = {
  titleCreate: 'Новая заметка',
  titleEdit: 'Заметка',
  fields: {
    title: 'Название',
    body: 'Текст',
    date: 'Дата',
  },
  addDate: 'Добавить дату',
  clearDate: 'Очистить дату',
  chooseDate: 'Изменить дату',
  titleRequired: 'Введите название заметки',
  loadingBody: 'Загрузка текста…',
  bodyLoadFailed: 'Не удалось прочитать текст заметки. Он не изменится',
  errors: {
    notFound: 'Заметка не найдена. Возможно, она ещё не синхронизирована',
  },
} satisfies Dictionary;
