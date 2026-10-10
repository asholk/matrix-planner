import type { Dictionary } from '../index';

/** Storage layer strings: read-only mode, marker, default names. */
export const enStorage = {
  untitled: 'Untitled',
  readOnly: {
    newer: 'Data was created by a newer version. Update the plugin',
    invalid: 'The matrix-planner.md note is damaged. Changes are not saved',
    migrating: 'Data is being updated. Changes are temporarily unavailable',
    needsMigration: 'Data needs to be updated. Changes are temporarily unavailable',
    unknown: 'Data is still loading',
  },
  marker: {
    body: 'Matrix planner service note. The companion app uses it to find the planner folder. Do not rename or delete it.',
  },
} satisfies Dictionary;
