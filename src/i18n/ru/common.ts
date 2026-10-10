import type { Dictionary } from '../index';

/** Общие строки: вкладки, квадранты, кнопки, ошибки операций. */
export const ruCommon = {
  pluginName: 'Matrix planner',
  viewTitle: 'Планировщик',
  tabs: {
    tasks: 'Задачи',
    calendar: 'Календарь',
    lockscreen: 'Блокировка',
  },
  quadrants: {
    do: 'Важно и срочно',
    plan: 'Важно',
    urgent: 'Срочно',
    someday: 'Когда-нибудь',
  },
  items: {
    task: 'Задача',
    event: 'Событие',
    note: 'Заметка',
  },
  actions: {
    done: 'Готово',
    cancel: 'Отмена',
    save: 'Сохранить',
    delete: 'Удалить',
    open: 'Открыть',
    openNote: 'Открыть заметку',
    add: 'Добавить',
    close: 'Закрыть',
    today: 'Сегодня',
    retry: 'Повторить',
  },
  errors: {
    notFound: 'Задача не найдена. Возможно, она ещё не синхронизирована',
    readOnly: 'Данные созданы более новой версией. Обновите плагин',
    stale: 'Данные изменились. Обновите вид и повторите действие',
    invalid: 'Проверьте заполнение полей',
    outsideRoot: 'Путь находится вне папки Планировщика',
    writeFailed: 'Не удалось сохранить изменения',
    trashFailed: 'Не удалось удалить заметку',
    tombstoneFailed: 'Не удалось записать метку удаления',
    notReady: 'Данные ещё загружаются',
    unsupported: 'Недоступно на этом устройстве',
    unknown: 'Что-то пошло не так',
  },
  status: {
    savedOnDevice: 'Сохранено на этом устройстве',
    pendingSave: 'Ожидает сохранения',
  },
} satisfies Dictionary;
