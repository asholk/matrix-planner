/**
 * Пункты меню элемента вкладки «Календарь» (долгое нажатие, ПКМ, клавиатура). Чистый модуль.
 *
 * - задача — те же пункты, что на вкладке «Задачи» (`buildTaskMenu`, `task-menu.ts`);
 * - событие-заметка — «Открыть заметку», «Изменить», «Перенести на завтра» (вся серия), «Удалить»;
 * - быстрая заметка — «Открыть заметку», «Удалить»;
 * - событие из «Календаря» iOS — «Открыть» (просмотр).
 */

import type { DayItem } from '../model/types';

export type CalendarMenuAction = 'open-note' | 'edit' | 'postpone' | 'delete' | 'view';

export interface CalendarMenuEntry {
  action: CalendarMenuAction;
  /** Ключ i18n подписи. */
  labelKey: string;
  icon: string;
  section: 'open' | 'schedule' | 'danger';
  warning: boolean;
}

const OPEN_NOTE: CalendarMenuEntry = { action: 'open-note', labelKey: 'calendar.menu.openNote', icon: 'file-text', section: 'open', warning: false };
const DELETE: CalendarMenuEntry = { action: 'delete', labelKey: 'calendar.menu.delete', icon: 'trash-2', section: 'danger', warning: true };

/** Пункты для события, заметки и внешнего события; задача — `null` (меню задачи). */
export function calendarItemMenu(item: Pick<DayItem, 'source'>): CalendarMenuEntry[] | null {
  switch (item.source) {
    case 'task':
      return null;
    case 'event':
      return [
        OPEN_NOTE,
        { action: 'edit', labelKey: 'calendar.menu.edit', icon: 'pencil', section: 'open', warning: false },
        { action: 'postpone', labelKey: 'calendar.menu.postpone', icon: 'calendar-clock', section: 'schedule', warning: false },
        DELETE,
      ];
    case 'note':
      return [OPEN_NOTE, DELETE];
    case 'external':
      return [{ action: 'view', labelKey: 'calendar.menu.view', icon: 'eye', section: 'open', warning: false }];
  }
}
