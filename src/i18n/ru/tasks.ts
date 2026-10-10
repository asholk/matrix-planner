import type { Dictionary } from '../index';

/** Вкладка «Задачи»: шапка, фильтры, квадранты, карточки, меню. */
export const ruTasks = {
  greeting: {
    morning: 'Доброе утро',
    afternoon: 'Добрый день',
    evening: 'Добрый вечер',
  },
  subtitle: 'Чем займёмся сегодня?',
  loading: 'Загрузка задач…',
  controls: {
    label: 'Вид задач',
    done: 'Выполнено',
    doneCount: 'Выполнено {count}',
    doneClose: 'Закрыть фильтр «Выполнено»',
    grid: 'Сетка',
    list: 'Список',
    byQuadrant: 'По квадрантам',
    byDate: 'По датам',
  },
  quadrant: {
    add: 'Создать задачу в квадранте «{quadrant}»',
    count: {
      one: '{count} задача',
      few: '{count} задачи',
      many: '{count} задач',
      other: '{count} задачи',
    },
  },
  empty: 'Здесь пока нет задач',
  emptyDone: 'Здесь пока нет выполненных задач',
  emptyList: 'Незавершённых задач нет',
  emptyDoneList: 'Выполненных задач нет',
  groups: {
    overdue: 'Просрочено',
    noDate: 'Без срока',
  },
  card: {
    complete: 'Выполнить задачу «{title}»',
    uncomplete: 'Вернуть в работу задачу «{title}»',
    more: 'Действия с задачей «{title}»',
    dragHandle: 'Перетащить задачу',
    highPriority: 'высокий приоритет',
    repeat: 'повторяется',
    overdue: 'просрочена',
    notDone: 'не выполнена',
    done: 'выполнена',
    noDue: 'без срока',
    completedAt: '{date}, {time}',
    label: 'Задача «{title}»',
    quadrant: 'квадрант «{quadrant}»',
  },
  menu: {
    openNote: 'Открыть заметку',
    moveTo: 'Перенести в квадрант «{quadrant}»',
    postpone: 'Перенести на завтра',
    delete: 'Удалить',
    uncomplete: 'Вернуть в работу',
  },
  notices: {
    deleted: 'Задача удалена в корзину',
    moved: 'Задача перенесена в квадрант «{quadrant}»',
  },
} satisfies Dictionary;
