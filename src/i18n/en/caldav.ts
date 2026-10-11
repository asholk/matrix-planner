import type { Dictionary } from '../index';

/** iOS Calendar sync (CalDAV, iCloud) and ICS subscriptions. */
export const enCaldav = {
  plannerCalendar: 'Planner',
  commands: {
    sync: 'Sync calendar',
    confirmDeletion: 'Confirm deleting events from the calendar',
  },
  notices: {
    auth: 'Cannot sign in to the calendar. Check your Apple ID and app-specific password',
    network: 'Cannot reach the calendar server. Sync will retry later',
    failed: 'Cannot sync the calendar',
    synced: 'Calendar synced',
    notConfigured: 'Enter your Apple ID and app-specific password in the iOS Calendar settings',
    disabled: 'Calendar sync is turned off',
    calendarCreated: 'Calendar "{name}" created',
    calendarCreateFailed: 'Cannot create calendar "{name}"',
    authCaldav: 'Cannot sign in to the calendar. Check your username and password',
    notConfiguredCaldav: 'Enter the server address, username and password in the iOS Calendar settings',
    enabled: 'iOS Calendar sync is turned on',
    enabledCaldav: 'Calendar sync is turned on',
    pushNetwork: 'Cannot send changes to the calendar: the server is unreachable. Will retry later',
    savedEvent: 'Event saved in Obsidian. To see it in the iOS Calendar, connect iCloud: Settings → iOS Calendar',
    savedTask: 'Task saved in Obsidian. To see it in the iOS Calendar, connect iCloud: Settings → iOS Calendar',
    openSettings: 'Open settings',
    confirmDeletion: {
      one: 'Deleting {count} event from the calendar needs confirmation in the iOS Calendar settings',
      other: 'Deleting {count} events from the calendar needs confirmation in the iOS Calendar settings',
    },
  },
  settings: {
    heading: 'iOS Calendar',
    intro:
      'Events, tasks with a due date and reminders appear in the iPhone Calendar via iCloud or another CalDAV server, and events from the selected calendars appear in the planner. Works on desktop, iPhone and Android.',
    enabled: {
      name: 'Sync',
      desc: 'Sync iOS Calendar from this device',
    },
    provider: {
      name: 'Server',
      icloud: 'iCloud',
      caldav: 'Other CalDAV server',
    },
    serverUrl: {
      name: 'Server address',
      desc: 'For example, https://cloud.example.com/remote.php/dav',
    },
    username: {
      icloud: 'Apple ID',
      caldav: 'Username',
      desc: 'Stored in the plugin settings',
    },
    password: {
      icloud: 'App-specific password',
      caldav: 'Password',
      desc: 'Stored only on this device and never in the vault',
      help: 'Create an app-specific password at account.apple.com → Sign-In and Security → App-Specific Passwords',
      placeholder: 'xxxx-xxxx-xxxx-xxxx',
      saved: 'Password saved',
      missing: 'No password set',
    },
    test: {
      name: 'Test connection',
      button: 'Test',
      running: 'Testing…',
      found: 'Calendars found: {count}',
    },
    writeCalendar: {
      name: 'Calendar to write to',
      desc: 'Where planner events and tasks are written',
      auto: 'Find or create "Planner"',
      create: 'Create "Planner"',
      unknown: 'Test the connection to choose a calendar',
    },
    readCalendars: {
      heading: 'Calendars to download',
      desc: 'Events from these calendars are written to _system/calendar-cache.json and synced to every device with the vault',
      allHint: 'While no calendar is selected, all calendars are downloaded',
      empty: 'Test the connection to see the calendars',
      readOnly: 'View only',
    },
    tasks: {
      name: 'Tasks in calendar',
      desc: 'Tasks with a due date appear in the calendar to write to. iOS shows the reminders',
    },
    completed: {
      name: 'Completed tasks in calendar',
      desc: 'A 15-minute event at the completion time',
    },
    interval: {
      name: 'Sync interval',
      desc: 'In minutes, from 5 to 1440',
    },
    subscriptions: {
      heading: 'ICS subscriptions',
      desc: 'View-only calendars from a webcal:// or https:// link',
      namePlaceholder: 'Name',
      urlPlaceholder: 'https://example.com/calendar.ics',
      add: 'Add subscription',
      remove: 'Remove subscription',
      invalidUrl: 'Enter an https:// or webcal:// link',
    },
    pending: {
      name: {
        one: 'Confirmation required: {count} event',
        other: 'Confirmation required: {count} events',
      },
      desc: 'These events were deleted in the planner. To avoid deleting many events by accident, confirm deleting them from the calendar',
      button: 'Delete',
    },
    syncNow: {
      name: 'Sync now',
      button: 'Sync',
    },
    status: {
      name: 'Status',
      never: 'Not synced yet',
      running: 'Syncing…',
      ok: 'Synced: {time}',
      auth: 'Sign-in failed. Check your Apple ID and app-specific password',
      authCaldav: 'Sign-in failed. Check your username and password',
      network: 'Cannot reach the server, will retry later',
      server: 'Calendar server error',
      cache: 'Cannot write the calendar cache',
      notConfigured: 'Username or password is missing',
      lastOk: 'Last successful sync: {time}',
      pushed: 'Changes last sent: {time}',
    },
  },
} satisfies Dictionary;
