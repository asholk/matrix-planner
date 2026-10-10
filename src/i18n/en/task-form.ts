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
} satisfies Dictionary;
