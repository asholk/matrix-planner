import type { Dictionary } from '../index';

/**
 * Model strings: relative dates, repeat rules and property issues.
 * Registered as the `model` module (date keys — `DATE_LABEL_KEYS` in `src/model/dates.ts`).
 */
export const enModel = {
  dates: {
    today: 'Today',
    tomorrow: 'Tomorrow',
    yesterday: 'Yesterday',
    dayMonth: '{month} {day}',
    dayMonthYear: '{month} {day}, {year}',
    dateTime: '{date} {time}',
    am: 'AM',
    pm: 'PM',
    monthsShort: {
      m1: 'Jan',
      m2: 'Feb',
      m3: 'Mar',
      m4: 'Apr',
      m5: 'May',
      m6: 'Jun',
      m7: 'Jul',
      m8: 'Aug',
      m9: 'Sep',
      m10: 'Oct',
      m11: 'Nov',
      m12: 'Dec',
    },
  },
  repeat: {
    none: 'Never',
    daily: 'Every day',
    weekly: 'Every week',
    monthly: 'Every month',
    yearly: 'Every year',
  },
  remind: {
    none: 'None',
    at: 'At time of event',
    '5m': '5 minutes before',
    '15m': '15 minutes before',
    '30m': '30 minutes before',
    '1h': '1 hour before',
    '1d': '1 day before',
  },
  priority: {
    normal: 'Normal',
    high: 'High',
  },
  issues: {
    missing: 'Required property "{property}" is missing',
    'invalid-type': 'Property "{property}" has the wrong type',
    'invalid-value': 'Property "{property}" has an invalid value',
    'invalid-date': 'Property "{property}" is not a valid date',
    inconsistent: 'Property "{property}" conflicts with other properties',
  },
} satisfies Dictionary;
