import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createSaveFeedback, type NoticeAction } from '../../src/caldav/sync-feedback';
import { setLanguageOverride } from '../../src/i18n';

describe('caldav/sync-feedback', () => {
  let configured: boolean;
  let notices: Array<{ message: string; action: NoticeAction }>;
  let opened: number;

  beforeEach(() => {
    setLanguageOverride('ru');
    configured = false;
    notices = [];
    opened = 0;
  });
  afterEach(() => setLanguageOverride(null));

  function feedback() {
    return createSaveFeedback({
      isConfigured: () => configured,
      notify: (message, action) => notices.push({ message, action }),
      openSettings: () => opened++,
    });
  }

  it('синхронизация не настроена — одна подсказка за сессию со ссылкой на настройки', () => {
    const fb = feedback();
    fb.afterSave('event');
    fb.afterSave('event');
    fb.afterSave('task', true);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toBe(
      'Событие сохранено в Obsidian. Чтобы оно появилось в «Календаре» iOS, подключите iCloud: Настройки → Календарь iOS',
    );
    expect(notices[0].action.label).toBe('Открыть настройки');
    notices[0].action.run();
    expect(opened).toBe(1);
  });

  it('задача без срока не подсказывает; задача со сроком — своим текстом', () => {
    const fb = feedback();
    fb.afterSave('task', false);
    expect(notices).toEqual([]);
    fb.afterSave('task', true);
    expect(notices[0].message).toMatch(/^Задача сохранена в Obsidian/);
  });

  it('синхронизация настроена — тихо', () => {
    configured = true;
    feedback().afterSave('event');
    expect(notices).toEqual([]);
  });
});
