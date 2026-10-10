import type { Dictionary } from '../index';

/** Task operation messages. */
export const enTaskActions = {
  done: {
    uncompleted: 'Task moved back to active',
    postponed: 'Task moved to tomorrow',
    deleted: 'Task moved to trash',
    archived: 'Task moved to archive',
    restored: 'Task restored from archive',
    autoArchived: {
      one: 'Moved {count} task to archive',
      other: 'Moved {count} tasks to archive',
    },
  },
  errors: {
    notArchivable: 'Only completed non-repeating tasks can be archived',
    autoArchive: 'Couldn’t move completed tasks to archive: {reason}',
  },
} satisfies Dictionary;
