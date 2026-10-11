import type { Dictionary } from '../index';

/** Task form (spec §4.3, frames 02–06). Repeat and reminder labels live in the `model` dictionary. */
export const enTaskForm = {
  titleCreate: 'New task',
  titleEdit: 'Task',
  fields: {
    title: 'Title',
    body: 'Notes',
    date: 'Date',
    time: 'Time',
    repeat: 'Repeat',
    remind: 'Reminder',
    priority: 'High priority',
    quadrant: 'Quadrant',
    duration: 'Duration',
  },
  /** Duration options: `{n}` is the number. */
  duration: {
    none: 'Not set',
    minutes: '{n} min',
    hours: '{n} h',
    decimal: '.',
  },
  addDate: 'Add date',
  addTime: 'Add time',
  clearDate: 'Clear date',
  clearTime: 'Remove time',
  chooseDate: 'Change date',
  remindAtHint: 'For a task without a time, the reminder arrives at {time}',
  titleRequired: 'Enter a task title',
  quadrantTile: 'Quadrant “{title}”',
  loadingBody: 'Loading notes…',
  bodyLoadFailed: 'Could not read the task notes. They will stay unchanged',
  saved: 'Task saved',
  delete: 'Delete',
  deleteLabel: 'Delete task',
  deleteConfirm: 'Select again to delete',
  deleted: 'Task moved to trash',
  deletedUndo: 'Task deleted',
  undo: 'Undo',
  /** Checklist made of Markdown tasks in the note body (update 008). */
  checklist: {
    title: 'Checklist',
    add: 'Add item',
    remove: 'Delete item',
    removeItem: 'Delete item "{text}"',
    check: 'Complete item "{text}"',
    progress: '{done} of {total} items done',
    empty: 'Untitled item',
  },
  /** Caption of the selected quadrant next to "Quadrant" (frames 04, 05). */
  quadrantHint: {
    do: 'Urgent and important',
    plan: 'Important, not urgent',
    urgent: 'Urgent, less important',
    someday: 'Neither urgent nor important',
  },
} satisfies Dictionary;
