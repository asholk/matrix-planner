/**
 * Обратная связь после сохранения события или задачи в форме: если синхронизация с
 * «Календарём» iOS не настроена — один раз за сессию подсказка со ссылкой на настройки.
 * Ошибки адресной отправки показывает движок синхронизации, успех — без уведомления.
 */

import { Notice } from 'obsidian';
import { registerDictionary, t } from '../i18n';
import { ruCaldav } from '../i18n/ru/caldav';
import { enCaldav } from '../i18n/en/caldav';

registerDictionary('ru', 'caldav', ruCaldav);
registerDictionary('en', 'caldav', enCaldav);

export interface NoticeAction {
  label: string;
  run(): void;
}

export interface SaveFeedbackDeps {
  /** Синхронизация включена и заданы учётные данные. */
  isConfigured(): boolean;
  notify(message: string, action: NoticeAction): void;
  /** Открыть вкладку «Настройки» вида. */
  openSettings(): void;
}

export interface SaveFeedback {
  /** `goesToCalendar` — элемент попадает в календарь (у задачи есть срок). */
  afterSave(kind: 'event' | 'task', goesToCalendar?: boolean): void;
}

export function createSaveFeedback(deps: SaveFeedbackDeps): SaveFeedback {
  let hinted = false;
  return {
    afterSave(kind, goesToCalendar = true) {
      if (hinted || !goesToCalendar || deps.isConfigured()) return;
      hinted = true;
      deps.notify(t(kind === 'event' ? 'caldav.notices.savedEvent' : 'caldav.notices.savedTask'), {
        label: t('caldav.notices.openSettings'),
        run: () => deps.openSettings(),
      });
    },
  };
}

/** Длительность уведомления с действием (мс): его нужно успеть прочитать и нажать. */
const ACTION_NOTICE_MS = 12_000;

/** Уведомление Obsidian с текстом и ссылкой-действием. */
export function showActionNotice(message: string, action: NoticeAction): void {
  const fragment = createFragment();
  fragment.createDiv({ text: message });
  const link = fragment.createEl('a', { text: action.label, href: '#' });
  const notice = new Notice(fragment, ACTION_NOTICE_MS);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    notice.hide();
    action.run();
  });
}
