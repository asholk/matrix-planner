import type { Dictionary } from '../index';

/** Сообщения операций с задачами. */
export const ruTaskActions = {
  done: {
    uncompleted: 'Задача возвращена в работу',
    postponed: 'Задача перенесена на завтра',
    deleted: 'Задача перемещена в корзину',
    archived: 'Задача перенесена в архив',
    restored: 'Задача возвращена из архива',
    autoArchived: {
      one: 'Перенесена в архив {count} задача',
      few: 'Перенесено в архив {count} задачи',
      many: 'Перенесено в архив {count} задач',
      other: 'Перенесено в архив {count} задачи',
    },
  },
  errors: {
    notArchivable: 'В архив переносятся только выполненные задачи без повтора',
    autoArchive: 'Не удалось перенести выполненные задачи в архив: {reason}',
  },
} satisfies Dictionary;
