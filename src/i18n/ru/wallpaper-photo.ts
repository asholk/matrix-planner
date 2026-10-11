import type { Dictionary } from '../index';

/** Загрузка фона обоев из Фото (iOS) или с диска. Модуль `wallpaperPhoto`. */
export const ruWallpaperPhoto = {
  /** Кнопка в разделе «Фон» на телефоне и планшете. */
  pick: 'Выбрать из Фото',
  /** Та же кнопка на компьютере. */
  pickDesktop: 'Загрузить фото',
  pickHint: 'Фото сохраняется в папку {folder}',
  loading: 'Загрузка фото…',
  decodeFailed: 'Не удалось открыть фото. Выберите JPEG или PNG',
  encodeFailed: 'Не удалось подготовить фото. Попробуйте другое фото',
  readOnly: 'Хранилище доступно только для чтения. Фото не сохранено',
  writeFailed: 'Не удалось сохранить фото: {reason}',
} satisfies Dictionary;
