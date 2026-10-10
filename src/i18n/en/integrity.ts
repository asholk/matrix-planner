import type { Dictionary } from '../index';

/** Integrity module strings: "Needs attention", migrations. */
export const enIntegrity = {
  items: {
    duplicateId: '{count} notes share the same ID. The copy got a new ID; check which version is current',
    duplicateIdReadOnly: '{count} notes share the same ID. No new ID was assigned: changes are temporarily unavailable',
    conflictCopy: 'Looks like a copy created by a sync conflict',
    invalid: 'Invalid properties: {properties}',
    deletedInCalendar: 'The event was deleted in iOS Calendar and moved to the "Удалённые" folder',
    pendingDeletion: 'The event is marked for deletion, but the note still exists',
    schema: {
      newer: 'The data was created by a newer version. Update the plugin',
      invalid: 'The matrix-planner.md note is damaged. Changes are not saved',
      needsMigration: 'The data needs to be updated to the new version',
      migrating: 'The data update is not finished',
    },
  },
  panel: {
    empty: 'No notes need attention.',
    original: 'Original',
    copy: 'Copy',
    open: 'Open',
    keep: 'Keep this version',
    merge: 'Merge manually',
    keepFailed: 'Couldn’t dismiss the item',
    keepDone: 'Item dismissed. Notes weren’t changed',
  },
  migration: {
    failed: 'Couldn’t update the data: {detail}',
    done: 'Data updated',
  },
} satisfies Dictionary;
