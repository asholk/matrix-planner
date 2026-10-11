import type { Dictionary } from '../index';

/** Защита черновика формы (доработка 006, §6): «Сбросить изменения?». */
export const ruSheetGuard = {
  title: 'Сбросить изменения?',
  desc: 'Изменения в форме не сохранены.',
  discard: 'Сбросить',
  keep: 'Продолжить правку',
} satisfies Dictionary;
