import type { Dictionary } from '../index';

/** View shell: tab bar, "+", add menu, form sheet, date picker. */
export const enShell = {
  tabBar: 'Planner sections',
  tabUnavailable: 'This section is not available yet',
  tabFailed: 'Could not show this section',
  add: {
    button: 'Add',
    title: 'Add',
    task: 'Task',
    event: 'Event',
    note: 'Note',
    unavailable: 'Not available yet',
  },
  sheet: {
    close: 'Close',
    submit: 'Done',
    busy: 'Saving…',
  },
  datePicker: {
    label: 'Choose a date',
    prevMonth: 'Previous month',
    nextMonth: 'Next month',
    prevYear: 'Previous year',
    nextYear: 'Next year',
    chooseMonth: 'Choose month and year',
    backToDays: 'Back to days',
    today: 'Today',
    tomorrow: 'Tomorrow',
    nextWeek: 'In a week',
    clear: 'Clear date',
    selected: 'selected',
    todayMark: 'today',
  },
} satisfies Dictionary;
