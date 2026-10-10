import type { Dictionary } from '../index';

/** Common strings: tabs, quadrants, buttons, operation errors. */
export const enCommon = {
  pluginName: 'Matrix planner',
  viewTitle: 'Planner',
  tabs: {
    tasks: 'Tasks',
    calendar: 'Calendar',
    lockscreen: 'Lock screen',
  },
  quadrants: {
    do: 'Important and urgent',
    plan: 'Important',
    urgent: 'Urgent',
    someday: 'Someday',
  },
  items: {
    task: 'Task',
    event: 'Event',
    note: 'Note',
  },
  actions: {
    done: 'Done',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    open: 'Open',
    openNote: 'Open note',
    add: 'Add',
    close: 'Close',
    today: 'Today',
    retry: 'Retry',
  },
  errors: {
    notFound: 'Item not found. It may not be synced yet',
    readOnly: 'Data was created by a newer version. Update the plugin',
    stale: 'Data has changed. Refresh the view and try again',
    invalid: 'Check the fields',
    outsideRoot: 'The path is outside the planner folder',
    writeFailed: 'Could not save changes',
    trashFailed: 'Could not delete the note',
    tombstoneFailed: 'Could not record the deletion mark',
    notReady: 'Data is still loading',
    unsupported: 'Not available on this device',
    unknown: 'Something went wrong',
  },
  status: {
    savedOnDevice: 'Saved on this device',
    pendingSave: 'Waiting to be saved',
  },
} satisfies Dictionary;
