import type { Dictionary } from '../index';

/** Quick notes (spec §3.5, §4.3). */
export const enNotes = {
  titleCreate: 'New note',
  titleEdit: 'Note',
  fields: {
    title: 'Title',
    body: 'Text',
    date: 'Date',
  },
  addDate: 'Add date',
  clearDate: 'Clear date',
  chooseDate: 'Change date',
  titleRequired: 'Enter a note title',
  loadingBody: 'Loading text…',
  bodyLoadFailed: 'Could not read the note text. It will stay unchanged',
  errors: {
    notFound: 'Note not found. It may not be synced yet',
  },
} satisfies Dictionary;
