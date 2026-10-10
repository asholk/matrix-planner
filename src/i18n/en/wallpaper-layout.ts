import type { Dictionary } from '../index';

/**
 * Lock screen wallpaper captions (layout S2.T4).
 * Registered as the `wallpaperLayout` module; strings are built by `createWallpaperStrings` in `src/wallpaper/layout.ts`.
 */
export const enWallpaperLayout = {
  // Starting with Sunday, like `Date.getDay()`.
  weekdayShort: {
    d0: 'S',
    d1: 'M',
    d2: 'T',
    d3: 'W',
    d4: 'T',
    d5: 'F',
    d6: 'S',
  },
  monthNames: {
    m1: 'January',
    m2: 'February',
    m3: 'March',
    m4: 'April',
    m5: 'May',
    m6: 'June',
    m7: 'July',
    m8: 'August',
    m9: 'September',
    m10: 'October',
    m11: 'November',
    m12: 'December',
  },
  emptyQuadrant: 'No tasks',
  yearProgress: '{percent}% of the year passed',
  daysLeft: {
    one: '{count} day left',
    other: '{count} days left',
  },
  moreItems: '+{count}',
} satisfies Dictionary;
