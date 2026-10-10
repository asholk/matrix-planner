import type { Dictionary } from '../index';

/**
 * Строки календарной логики (модуль `calendar-model`, ключи — `CALENDAR_MODEL_KEYS`
 * в `src/calendar/day-items.ts`). Регистрирует потребитель (вкладка «Календарь»).
 */
export const ruCalendarModel = {
  coverage: {
    noCache: 'Подключите календарь iOS в настройках',
    outOfRange: 'События «Календаря» iOS за этот период не загружены',
  },
  emptyDay: 'Здесь пока ничего нет. Нажмите +, чтобы спланировать этот день',
  emptyDayDesktop: 'Здесь пока ничего нет. Выберите +, чтобы спланировать этот день',
  itemCount: {
    one: '{count} элемент',
    few: '{count} элемента',
    many: '{count} элементов',
    other: '{count} элемента',
  },
  blocks: {
    allDay: 'Весь день',
    notes: 'Заметки',
  },
  more: '+{count}',
} satisfies Dictionary;
