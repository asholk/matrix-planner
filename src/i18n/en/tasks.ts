import type { Dictionary } from '../index';

/** Tasks tab: header, filters, quadrants, cards, menu. */
export const enTasks = {
  loading: 'Loading tasks…',
  controls: {
    label: 'Task view',
    done: 'Completed',
    doneCount: 'Completed {count}',
    doneClose: 'Close the completed filter',
    grid: 'Grid',
    list: 'List',
    byQuadrant: 'By quadrant',
    byDate: 'By date',
  },
  quadrant: {
    add: 'Create task in "{quadrant}"',
    count: {
      one: '{count} task',
      other: '{count} tasks',
    },
  },
  empty: 'No tasks here yet',
  emptyDone: 'No completed tasks here yet',
  emptyList: 'No open tasks',
  emptyDoneList: 'No completed tasks',
  groups: {
    overdue: 'Overdue',
    noDate: 'No date',
  },
  card: {
    complete: 'Complete task "{title}"',
    uncomplete: 'Restore task "{title}"',
    more: 'Actions for task "{title}"',
    dragHandle: 'Drag task',
    highPriority: 'high priority',
    repeat: 'repeats',
    overdue: 'overdue',
    notDone: 'not completed',
    done: 'completed',
    noDue: 'no date',
    completedAt: '{date}, {time}',
    label: 'Task "{title}"',
    quadrant: 'quadrant "{quadrant}"',
  },
  menu: {
    openNote: 'Open note',
    moveTo: 'Move to "{quadrant}"',
    postpone: 'Move to tomorrow',
    delete: 'Delete',
    uncomplete: 'Restore',
  },
  notices: {
    deleted: 'Task moved to trash',
    moved: 'Task moved to "{quadrant}"',
  },
} satisfies Dictionary;
