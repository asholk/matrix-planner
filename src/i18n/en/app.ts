import type { Dictionary } from '../index';

/** Core commands, ribbon icon and composition messages. */
export const enApp = {
  ribbon: {
    open: 'Open planner',
  },
  commands: {
    openTasks: 'Open tasks',
    createTask: 'Create task',
    createTaskInQuadrant: 'Create task in “{quadrant}” quadrant',
    completeActiveTask: 'Complete task in active note',
    postponeActiveTask: 'Postpone task in active note to tomorrow',
    checkIntegrity: 'Check data integrity',
    openCalendar: 'Open calendar',
    openLockscreen: 'Open lock screen',
    createEvent: 'Create event',
    createNote: 'Create note',
    updateLockscreen: 'Update lock screen',
  },
  settings: {
    sync: {
      name: 'Obsidian Sync',
      desc: 'If this vault syncs with Obsidian Sync, turn on “Other file types” in its settings. Otherwise the “_system/*.json” service files (calendar cache, deleted events, companion status) won’t reach your other devices.',
    },
  },
  notices: {
    taskCompleted: 'Task completed',
    integrityClean: 'No problems found',
    integrityFound: {
      one: '{count} item needs attention. See the planner settings',
      other: '{count} items need attention. See the planner settings',
    },
    integrityFailed: 'Could not check data integrity',
    migrationFailed: 'Could not update data to the new version. Changes are blocked',
    viewUnavailable: 'Could not open the planner',
  },
} satisfies Dictionary;
