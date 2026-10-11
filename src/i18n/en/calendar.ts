import type { Dictionary } from '../index';

/** Calendar tab: header, week strip, day list, timeline, month. */
export const enCalendar = {
  loading: 'Loading calendar…',
  header: {
    toolbar: 'Calendar controls',
    chooseMonth: 'Choose month and year, currently {value}',
    today: 'Today',
    goToday: 'Go to today',
    sources: 'Sources',
    modes: 'Calendar view',
    prevWeek: 'Previous week',
    nextWeek: 'Next week',
    prevMonth: 'Previous month',
    nextMonth: 'Next month',
    closePicker: 'Close date picker',
  },
  modes: {
    list: 'List',
    timeline: 'Timeline',
    month: 'Month',
  },
  sources: {
    tasks: 'Tasks',
    events: 'Events',
    notes: 'Notes',
    external: 'iOS Calendar',
  },
  relative: {
    today: 'Today',
    tomorrow: 'Tomorrow',
    yesterday: 'Yesterday',
  },
  am: 'AM',
  pm: 'PM',
  week: {
    label: 'Week',
    today: 'today',
    completed: 'has completed tasks',
    notes: 'has notes',
  },
  day: {
    label: 'Items for {date}',
    connect: 'Connect',
    connectLabel: 'Open iOS Calendar settings',
  },
  item: {
    task: 'Task “{title}”',
    event: 'Event “{title}”',
    external: 'Calendar event “{title}”',
    note: 'Note “{title}”',
    allDay: 'all day',
    range: '{start}–{end}',
    done: 'completed',
    notDone: 'not completed',
    readOnly: 'view only',
    recurring: 'repeats',
    continues: 'continued',
    planner: 'Planner',
    complete: 'Complete task “{title}”',
    uncomplete: 'Mark task “{title}” as not completed',
  },
  timeline: {
    label: 'Day timeline',
    now: 'Now',
  },
  month: {
    label: 'Month {value}',
    more: '{count} more',
  },
  menu: {
    openNote: 'Open note',
    edit: 'Edit',
    postpone: 'Move to tomorrow',
    delete: 'Delete',
    view: 'Open',
  },
  notices: {
    eventPostponed: 'Event moved to tomorrow',
    eventDeleted: 'Event deleted',
    noteDeleted: 'Note moved to trash',
  },
} satisfies Dictionary;
