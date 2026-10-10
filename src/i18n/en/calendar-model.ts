import type { Dictionary } from '../index';

/** Calendar logic strings (module `calendar-model`, keys — `CALENDAR_MODEL_KEYS` in `src/calendar/day-items.ts`). */
export const enCalendarModel = {
  coverage: {
    noCache: 'Connect the companion app to see iOS Calendar events',
    outOfRange: 'iOS Calendar events for this period aren’t loaded',
  },
  emptyDay: 'Nothing here yet. Tap + to plan this day',
  emptyDayDesktop: 'Nothing here yet. Select + to plan this day',
  itemCount: {
    one: '{count} item',
    other: '{count} items',
  },
  blocks: {
    allDay: 'All day',
    notes: 'Notes',
  },
  more: '+{count}',
} satisfies Dictionary;
