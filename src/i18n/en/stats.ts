import type { Dictionary } from '../index';

/** Statistics sheet and the streak pill on the Tasks tab. */
export const enStats = {
  title: 'Statistics',
  streak: {
    label: {
      one: 'day in a row',
      other: 'days in a row',
    },
    pill: {
      one: 'Streak: {count} day in a row. Open statistics',
      other: 'Streak: {count} days in a row. Open statistics',
    },
  },
  week: {
    label: 'completed this week',
  },
  chart: {
    title: 'Completed tasks',
    period: 'last 7 days',
    label: 'Completed tasks by day of the current week',
    day: {
      one: '{day}: {count} task',
      other: '{day}: {count} tasks',
    },
  },
  recent: {
    title: 'Recently completed',
    empty: 'No completed tasks yet',
    item: 'Task “{title}”, completed {date}, quadrant “{quadrant}”',
    archived: 'archived',
  },
  summary: {
    button: 'Summary',
    header: 'Week summary {range}: {done} completed, {streak} streak',
    quadrants: 'by quadrant',
    days: 'by day',
    copied: 'Summary copied',
    failed: 'Could not share the summary',
    tasks: {
      one: '{count} task',
      other: '{count} tasks',
    },
    dayCount: {
      one: '{count}-day',
      other: '{count}-day',
    },
  },
} satisfies Dictionary;
