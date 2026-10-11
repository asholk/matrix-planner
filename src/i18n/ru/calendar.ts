import type { Dictionary } from '../index';

/** Вкладка «Календарь»: шапка, лента недели, список дня, временная шкала, месяц. */
export const ruCalendar = {
  loading: 'Загрузка календаря…',
  header: {
    toolbar: 'Управление календарём',
    chooseMonth: 'Выбрать месяц и год, сейчас {value}',
    today: 'Сегодня',
    goToday: 'Перейти к сегодняшнему дню',
    sources: 'Источники',
    modes: 'Вид календаря',
    prevWeek: 'Предыдущая неделя',
    nextWeek: 'Следующая неделя',
    prevMonth: 'Предыдущий месяц',
    nextMonth: 'Следующий месяц',
    closePicker: 'Закрыть выбор даты',
  },
  modes: {
    list: 'Список',
    timeline: 'Временная шкала',
    month: 'Месяц',
  },
  sources: {
    tasks: 'Задачи',
    events: 'События',
    notes: 'Заметки',
    external: 'Календарь iOS',
  },
  relative: {
    today: 'Сегодня',
    tomorrow: 'Завтра',
    yesterday: 'Вчера',
  },
  am: 'AM',
  pm: 'PM',
  week: {
    label: 'Неделя',
    today: 'сегодня',
    completed: 'есть выполненные задачи',
    notes: 'есть заметки',
  },
  day: {
    label: 'Элементы дня {date}',
    connect: 'Подключить',
    connectLabel: 'Открыть настройки календаря iOS',
  },
  item: {
    task: 'Задача «{title}»',
    event: 'Событие «{title}»',
    external: 'Событие «{title}» из календаря',
    note: 'Заметка «{title}»',
    allDay: 'весь день',
    range: '{start}–{end}',
    done: 'выполнена',
    notDone: 'не выполнена',
    readOnly: 'только просмотр',
    recurring: 'повторяется',
    continues: 'продолжение',
    planner: 'Планировщик',
    complete: 'Выполнить задачу «{title}»',
    uncomplete: 'Вернуть в работу задачу «{title}»',
  },
  timeline: {
    label: 'Временная шкала дня',
    now: 'Сейчас',
  },
  month: {
    label: 'Месяц {value}',
    more: 'Ещё {count}',
  },
  menu: {
    openNote: 'Открыть заметку',
    edit: 'Изменить',
    postpone: 'Перенести на завтра',
    delete: 'Удалить',
    view: 'Открыть',
  },
  notices: {
    eventPostponed: 'Событие перенесено на завтра',
    eventDeleted: 'Событие удалено',
    noteDeleted: 'Заметка удалена в корзину',
  },
} satisfies Dictionary;
