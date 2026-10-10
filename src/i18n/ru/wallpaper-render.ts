import type { Dictionary } from '../index';

/** Сообщения рендера и сохранения обоев (модуль `wallpaperRender`, S2.T7). */
export const ruWallpaperRender = {
  errors: {
    render: 'Не удалось нарисовать обои на {date}',
    write: 'Не удалось сохранить файл {path}',
    nothingSaved: 'Не удалось сохранить обои',
  },
} satisfies Dictionary;
