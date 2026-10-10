import type { Dictionary } from '../index';

/** Settings tab strings (spec §4.6). Headings never include the word "settings". */
export const enSettings = {
  headings: {
    calendar: 'Calendar',
    lockscreen: 'Lock screen',
    companion: 'Companion',
    data: 'Data',
  },
  current: 'Current: {value}',
  general: {
    rootFolder: {
      name: 'Root folder',
      desc: 'Folder with planner tasks, events and notes. Existing notes are not moved when you change it.',
      errors: {
        empty: 'Enter a folder',
        'dot-segment': 'The path can’t contain “.” or “..”',
        hidden: 'Folders starting with a dot aren’t synced. Choose another name',
        'invalid-chars': 'The folder name contains invalid characters: {chars}',
        reserved: 'This name is reserved',
      },
    },
    archive: {
      name: 'Move completed tasks to archive',
      desc: 'Completed non-repeating tasks are moved to the “Задачи/Архив” folder.',
      never: 'Never',
      afterDays: 'After N days',
    },
    archiveDays: {
      name: 'Days before archiving',
      desc: 'Days after completion, from {min} to {max}.',
      error: 'Enter a whole number from {min} to {max}',
    },
    reminderTime: {
      name: 'Reminder time for tasks without time',
      desc: 'Used for the “At time of event” reminder when a task only has a date.',
      error: 'Enter time as HH:MM',
    },
  },
  calendar: {
    weekStart: {
      name: 'Week starts on',
      auto: 'Automatic (region)',
      monday: 'Monday',
      sunday: 'Sunday',
    },
    timeFormat: {
      name: 'Time format',
      auto: 'Automatic (device)',
      h24: '24-hour',
      h12: '12-hour',
      current24: '24-hour',
      current12: '12-hour',
    },
    defaultCalendar: {
      name: 'Calendar for new events',
      desc: 'Used by default in the event form.',
      planner: 'Planner',
      unavailable: 'Unavailable calendar',
    },
    visible: {
      name: 'Visible calendars',
      desc: 'Calendars whose events appear on the Calendar tab.',
      planner: 'Planner',
      birthdays: 'Birthdays',
      noCache: 'iCloud calendars appear here after sync. Turn it on in the “iOS Calendar” section.',
    },
  },
  lockscreen: {
    template: {
      name: 'Template',
      matrix: 'Matrix',
      calendar: 'Calendar',
    },
    profile: {
      name: 'Device profile',
      desc: 'Wallpaper size and folder name in “Обои”. Automatic usually works.',
      auto: 'Automatic',
      custom: 'Profile {id}',
    },
    shortcut: {
      name: 'Shortcut name',
      desc: 'The shortcut in the Shortcuts app that sets the wallpaper on iPhone and iPad.',
      error: 'Enter a shortcut name',
    },
  },
  companion: {
    note: 'A companion app for iPhone widgets is in development. Calendar sync is set up in the “iOS Calendar” section.',
  },
  data: {
    check: {
      name: 'Check integrity',
      desc: 'Finds duplicates, conflicted copies and notes with invalid properties. Nothing is deleted.',
      button: 'Check',
      running: 'Checking…',
      failed: 'Couldn’t check integrity',
      found: {
        one: 'Found {count} issue',
        other: 'Found {count} issues',
      },
      clean: 'No issues found',
    },
    attention: {
      name: 'Needs attention',
      notChecked: 'No check has been run yet.',
      empty: 'No notes need attention.',
      checkedAt: 'Last check: {value}',
      openNote: 'Open note',
    },
  },
  errors: {
    saveFailed: 'Couldn’t save options',
  },
} satisfies Dictionary;
