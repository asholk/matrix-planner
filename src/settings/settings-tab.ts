/**
 * Вкладка настроек (ТЗ §4.6): общие параметры без заголовка, затем разделы
 * «Календарь», «Экран блокировки», «Компаньон», «Данные» через `setHeading()`.
 * Данные других модулей (кэш календаря, компаньон, целостность) приходят через
 * `SettingsTabDeps`; недостающие сервисы просто сужают показываемую часть.
 */

import { Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type { App, Plugin, SettingDefinitionItem } from 'obsidian';
import type { SettingsSection } from '../app/contracts';
import { getCurrentLanguage, registerDictionary, t, tPlural } from '../i18n';
import { enSettings } from '../i18n/en/settings';
import { ruSettings } from '../i18n/ru/settings';
import { DEFAULT_ROOT_FOLDER } from '../model/types';
import type { CachedCalendar, IntegrityReport, Language, PlannerSettings, Unsubscribe } from '../model/types';
import { ARCHIVE_DAYS_MAX, ARCHIVE_DAYS_MIN, DEFAULT_ARCHIVE_DAYS } from './defaults';
import { normalizeArchiveDays, normalizeShortcutName, normalizeTime, validateRootFolder } from './settings-store';
import type { RootFolderValidation, SettingsTabDeps } from './types';

registerDictionary('ru', 'settings', ruSettings);
registerDictionary('en', 'settings', enSettings);

/** Порядок встроенных разделов (см. `SettingsSection.order`). */
export const SETTINGS_SECTION_ORDER = {
  general: 0,
  calendar: 10,
  lockscreen: 20,
  companion: 30,
  data: 40,
} as const;

/** Задержка, после которой правка с напоминанием считается не подхваченной компаньоном. */
export const REMINDER_PENDING_DELAY_MS = 60_000;

/**
 * Баннер «Напоминание будет запланировано…»: правка с напоминанием была позже последнего
 * обновления компаньона, и с неё прошло больше минуты.
 */
export function isReminderSchedulingPending(lastCompanionUpdate: string | null, lastReminderEditMs: number | null, nowMs: number): boolean {
  if (lastReminderEditMs === null) return false;
  if (nowMs - lastReminderEditMs <= REMINDER_PENDING_DELAY_MS) return false;
  const updateMs = lastCompanionUpdate ? Date.parse(lastCompanionUpdate) : Number.NaN;
  return Number.isNaN(updateMs) || updateMs < lastReminderEditMs;
}

/** Текст ошибки проверки корневой папки. */
export function rootFolderErrorText(result: RootFolderValidation): string | null {
  if (result.ok) return null;
  return t(`settings.general.rootFolder.errors.${result.error}`, { chars: result.chars ?? '' });
}

type Track = (cleanup: () => void) => void;

export class PlannerSettingTab extends PluginSettingTab {
  private readonly renderer: PlannerSettingsRenderer;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly deps: SettingsTabDeps,
  ) {
    super(app, plugin);
    this.renderer = new PlannerSettingsRenderer(deps);
  }

  /**
   * Декларативные определения (Obsidian 1.13+). Пустой список означает, что Obsidian
   * рисует вкладку через `display()`: плагин поддерживает версии с 1.8.7, где декларативного
   * API нет, а разделы вкладки живые (подписки на календари, компаньон, целостность).
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  display(): void {
    this.renderer.render(this.containerEl);
  }

  hide(): void {
    this.renderer.dispose();
    super.hide();
  }
}

/**
 * Разделы настроек в произвольном контейнере: вкладка настроек Obsidian и вкладка
 * «Настройки» вида используют разные экземпляры (у каждого свои подписки).
 */
export class PlannerSettingsRenderer {
  /** Очистка подписок и панелей текущего показа. */
  private cleanups: Array<() => void> = [];
  /** Последнее N для «Через N дней», чтобы не терять его при переключении на «Никогда». */
  private archiveDays = DEFAULT_ARCHIVE_DAYS;
  /** Номер показа: меняется при `render`/`dispose`, чтобы поздний `save` не перерисовал закрытую панель. */
  private generation = 0;
  private shown = false;
  private containerEl: HTMLElement | null = null;

  constructor(private readonly deps: SettingsTabDeps) {}

  /** Полная отрисовка в `containerEl` (содержимое заменяется). */
  render(containerEl: HTMLElement): void {
    this.containerEl = containerEl;
    this.renderTab();
  }

  /** Снять подписки; содержимое контейнера остаётся до следующей отрисовки. */
  dispose(): void {
    this.generation += 1;
    this.shown = false;
    this.disposeAll();
  }

  /** Полная отрисовка; её же вызывает перерисовка после сохранения. */
  private renderTab(): void {
    const containerEl = this.containerEl;
    if (!containerEl) return;
    this.disposeAll();
    this.generation += 1;
    this.shown = true;
    containerEl.empty();
    containerEl.addClass('mp-settings');

    const builtIn: SettingsSection[] = [
      { order: SETTINGS_SECTION_ORDER.general, render: (el) => this.renderGeneral(el) },
      { order: SETTINGS_SECTION_ORDER.calendar, render: (el) => this.mountLive(el, (inner) => this.renderCalendar(inner), this.deps.calendars ? (refresh) => this.deps.calendars?.onChange(refresh) : undefined) },
      { order: SETTINGS_SECTION_ORDER.lockscreen, render: (el) => this.renderLockscreen(el) },
      { order: SETTINGS_SECTION_ORDER.companion, render: (el) => this.mountLive(el, (inner) => this.renderCompanion(inner), this.deps.companion ? (refresh) => this.deps.companion?.onChange(refresh) : undefined) },
    ];
    if (this.deps.integrity) {
      const integrity = this.deps.integrity;
      builtIn.push({
        order: SETTINGS_SECTION_ORDER.data,
        render: (el) => this.mountLive(el, (inner, track) => this.renderData(inner, track), (refresh) => integrity.onChange(refresh)),
      });
    }

    // Стабильная сортировка: при равном `order` встроенный раздел идёт первым.
    const sections = [...builtIn, ...(this.deps.sections ?? [])]
      .map((section, index) => ({ section, index }))
      .sort((a, b) => a.section.order - b.section.order || a.index - b.index)
      .map(({ section }) => section);

    for (const section of sections) {
      const sectionEl = containerEl.createDiv({ cls: 'mp-settings-section' });
      try {
        section.render(sectionEl);
      } catch (error) {
        console.error('[matrix-planner] Ошибка отрисовки раздела настроек', error);
      }
      if (section.dispose) this.cleanups.push(() => section.dispose?.());
    }
  }

  /** Перерисовка после сохранения — только если панель всё ещё показана тем же показом. */
  private redisplayLater(): () => void {
    const generation = this.generation;
    return () => {
      if (this.shown && this.generation === generation) this.renderTab();
    };
  }

  // -------------------------------------------------------------------------
  // Общие
  // -------------------------------------------------------------------------

  private renderGeneral(el: HTMLElement): void {
    const settings = this.deps.store.get();

    const root = new Setting(el).setName(t('settings.general.rootFolder.name')).setDesc(t('settings.general.rootFolder.desc'));
    const rootError = root.descEl.createDiv({ cls: 'mp-settings-error' });
    root.addText((text) => {
      text.setPlaceholder(DEFAULT_ROOT_FOLDER).setValue(settings.rootFolder);
      text.onChange((value) => {
        showError(rootError, text.inputEl, rootFolderErrorText(validateRootFolder(value)));
      });
      // Сохраняем по завершении ввода, чтобы не менять корень на каждую букву.
      text.inputEl.addEventListener('change', () => {
        const result = validateRootFolder(text.getValue());
        showError(rootError, text.inputEl, rootFolderErrorText(result));
        if (!result.ok) return;
        text.setValue(result.value);
        if (result.value !== this.deps.store.get().rootFolder) {
          void this.save((draft) => {
            draft.rootFolder = result.value;
          });
        }
      });
    });

    const archive = settings.archive;
    if (archive.mode === 'after-days') this.archiveDays = archive.days;
    new Setting(el)
      .setName(t('settings.general.archive.name'))
      .setDesc(t('settings.general.archive.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('never', t('settings.general.archive.never'))
          .addOption('after-days', t('settings.general.archive.afterDays'))
          .setValue(archive.mode)
          .onChange((mode) => {
            const days = this.archiveDays;
            void this.save((draft) => {
              draft.archive = mode === 'after-days' ? { mode: 'after-days', days } : { mode: 'never' };
            }).then(this.redisplayLater());
          });
      });

    if (archive.mode === 'after-days') {
      const days = new Setting(el)
        .setName(t('settings.general.archiveDays.name'))
        .setDesc(t('settings.general.archiveDays.desc', { min: ARCHIVE_DAYS_MIN, max: ARCHIVE_DAYS_MAX }))
        .setClass('mp-settings-subitem');
      const daysError = days.descEl.createDiv({ cls: 'mp-settings-error' });
      days.addText((text) => {
        text.inputEl.setAttribute('type', 'number');
        text.inputEl.setAttribute('min', String(ARCHIVE_DAYS_MIN));
        text.inputEl.setAttribute('max', String(ARCHIVE_DAYS_MAX));
        const validate = (value: string): number | null => {
          const valid = normalizeArchiveDays(value);
          showError(daysError, text.inputEl, valid === null ? t('settings.general.archiveDays.error', { min: ARCHIVE_DAYS_MIN, max: ARCHIVE_DAYS_MAX }) : null);
          return valid;
        };
        text.setValue(String(archive.days)).onChange((value) => void validate(value));
        // Сохраняем по завершении ввода: иначе «3» при наборе «30» запустит архив.
        text.inputEl.addEventListener('change', () => {
          const valid = validate(text.getValue());
          if (valid === null) return;
          this.archiveDays = valid;
          const current = this.deps.store.get().archive;
          if (current.mode === 'after-days' && current.days === valid) return;
          void this.save((draft) => {
            draft.archive = { mode: 'after-days', days: valid };
          });
        });
      });
    }

    const reminder = new Setting(el).setName(t('settings.general.reminderTime.name')).setDesc(t('settings.general.reminderTime.desc'));
    const reminderError = reminder.descEl.createDiv({ cls: 'mp-settings-error' });
    reminder.addText((text) => {
      text.inputEl.setAttribute('type', 'time');
      text.setValue(settings.reminderTimeForDateOnly).onChange((value) => {
        const time = normalizeTime(value);
        showError(reminderError, text.inputEl, time === null ? t('settings.general.reminderTime.error') : null);
        if (time === null) return;
        void this.save((draft) => {
          draft.reminderTimeForDateOnly = time;
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Календарь
  // -------------------------------------------------------------------------

  private renderCalendar(el: HTMLElement): void {
    const settings = this.deps.store.get();
    heading(el, t('settings.headings.calendar'));

    const weekStart = new Setting(el).setName(t('settings.calendar.weekStart.name'));
    const format = this.deps.format?.get();
    if (format) {
      const day = format.weekStart === 1 ? t('settings.calendar.weekStart.monday') : t('settings.calendar.weekStart.sunday');
      weekStart.setDesc(t('settings.current', { value: day }));
    }
    weekStart.addDropdown((dropdown) => {
      dropdown
        .addOption('auto', t('settings.calendar.weekStart.auto'))
        .addOption('monday', t('settings.calendar.weekStart.monday'))
        .addOption('sunday', t('settings.calendar.weekStart.sunday'))
        .setValue(settings.weekStart)
        .onChange((value) => {
          if (value !== 'auto' && value !== 'monday' && value !== 'sunday') return;
          void this.save((draft) => {
            draft.weekStart = value;
          }).then(this.redisplayLater());
        });
    });

    const timeFormat = new Setting(el).setName(t('settings.calendar.timeFormat.name'));
    if (format) {
      timeFormat.setDesc(t('settings.current', { value: format.hour12 ? t('settings.calendar.timeFormat.current12') : t('settings.calendar.timeFormat.current24') }));
    }
    timeFormat.addDropdown((dropdown) => {
      dropdown
        .addOption('auto', t('settings.calendar.timeFormat.auto'))
        .addOption('24h', t('settings.calendar.timeFormat.h24'))
        .addOption('12h', t('settings.calendar.timeFormat.h12'))
        .setValue(settings.timeFormat)
        .onChange((value) => {
          if (value !== 'auto' && value !== '24h' && value !== '12h') return;
          void this.save((draft) => {
            draft.timeFormat = value;
          }).then(this.redisplayLater());
        });
    });

    new Setting(el)
      .setName(t('settings.calendar.showTasksInIos.name'))
      .setDesc(t('settings.calendar.showTasksInIos.desc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.showTasksInIosCalendar).onChange((value) => {
          void this.save((draft) => {
            draft.showTasksInIosCalendar = value;
          });
        }),
      );

    new Setting(el)
      .setName(t('settings.calendar.writeCompleted.name'))
      .setDesc(t('settings.calendar.writeCompleted.desc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.writeCompletedTasksToCalendar).onChange((value) => {
          void this.save((draft) => {
            draft.writeCompletedTasksToCalendar = value;
          });
        }),
      );

    const calendars: readonly CachedCalendar[] = this.deps.calendars?.getCalendars() ?? [];

    new Setting(el)
      .setName(t('settings.calendar.defaultCalendar.name'))
      .setDesc(t('settings.calendar.defaultCalendar.desc'))
      .addDropdown((dropdown) => {
        // Пустой ключ — локальный календарь «Планировщик».
        dropdown.addOption('', t('settings.calendar.defaultCalendar.planner'));
        const writable = calendars.filter((calendar) => calendar.allowsModifications);
        for (const calendar of writable) dropdown.addOption(calendar.calendarId, calendar.title);
        const current = settings.defaultEventCalendarId;
        if (current !== null && !writable.some((calendar) => calendar.calendarId === current)) {
          dropdown.addOption(current, t('settings.calendar.defaultCalendar.unavailable'));
        }
        dropdown.setValue(current ?? '').onChange((value) => {
          void this.save((draft) => {
            draft.defaultEventCalendarId = value === '' ? null : value;
          });
        });
      });

    new Setting(el).setName(t('settings.calendar.visible.name')).setDesc(t('settings.calendar.visible.desc')).setClass('mp-settings-group');
    this.calendarToggle(el, t('settings.calendar.visible.planner'), null, settings.visibleCalendars.planner, (value) => (draft) => {
      draft.visibleCalendars.planner = value;
    });
    this.calendarToggle(el, t('settings.calendar.visible.birthdays'), null, settings.visibleCalendars.birthdays, (value) => (draft) => {
      draft.visibleCalendars.birthdays = value;
    });
    const external = calendars.filter((calendar) => calendar.kind !== 'birthdays');
    for (const calendar of external) {
      const enabled = settings.visibleCalendars.calendarIds.includes(calendar.calendarId);
      this.calendarToggle(el, calendar.title, calendar.color, enabled, (value) => (draft) => {
        const ids = draft.visibleCalendars.calendarIds.filter((id) => id !== calendar.calendarId);
        if (value) ids.push(calendar.calendarId);
        draft.visibleCalendars.calendarIds = ids;
      });
    }
    if (external.length === 0) {
      el.createDiv({ cls: 'mp-settings-note', text: t('settings.calendar.visible.noCache') });
    }
  }

  private calendarToggle(
    el: HTMLElement,
    name: string,
    color: string | null,
    value: boolean,
    mutation: (value: boolean) => (draft: PlannerSettings) => void,
  ): void {
    const setting = new Setting(el).setName(name).setClass('mp-settings-subitem');
    if (color) {
      setting.setClass('mp-settings-calendar');
      setting.settingEl.setCssProps({ '--mp-calendar-color': color });
    }
    setting.addToggle((toggle) =>
      toggle.setValue(value).onChange((next) => {
        void this.save(mutation(next));
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Экран блокировки
  // -------------------------------------------------------------------------

  private renderLockscreen(el: HTMLElement): void {
    const wallpaper = this.deps.store.get().wallpaper;
    heading(el, t('settings.headings.lockscreen'));

    new Setting(el).setName(t('settings.lockscreen.template.name')).addDropdown((dropdown) => {
      dropdown
        .addOption('matrix', t('settings.lockscreen.template.matrix'))
        .addOption('calendar', t('settings.lockscreen.template.calendar'))
        .setValue(wallpaper.template)
        .onChange((value) => {
          if (value !== 'matrix' && value !== 'calendar') return;
          void this.save((draft) => {
            draft.wallpaper.template = value;
          });
        });
    });

    const profiles = this.deps.wallpaperProfiles?.list() ?? [];
    const profile = new Setting(el).setName(t('settings.lockscreen.profile.name'));
    const autoProfile = this.deps.wallpaperProfiles?.resolveAuto?.() ?? null;
    profile.setDesc(
      wallpaper.profile === 'auto' && autoProfile
        ? `${t('settings.lockscreen.profile.desc')} ${t('settings.current', { value: autoProfile.label })}`
        : t('settings.lockscreen.profile.desc'),
    );
    profile.addDropdown((dropdown) => {
      dropdown.addOption('auto', t('settings.lockscreen.profile.auto'));
      for (const item of profiles) dropdown.addOption(item.id, item.label);
      if (wallpaper.profile !== 'auto' && !profiles.some((item) => item.id === wallpaper.profile)) {
        dropdown.addOption(wallpaper.profile, t('settings.lockscreen.profile.custom', { id: wallpaper.profile }));
      }
      dropdown.setValue(wallpaper.profile).onChange((value) => {
        void this.save((draft) => {
          draft.wallpaper.profile = value;
        }).then(this.redisplayLater());
      });
    });

    const shortcut = new Setting(el).setName(t('settings.lockscreen.shortcut.name')).setDesc(t('settings.lockscreen.shortcut.desc'));
    const shortcutError = shortcut.descEl.createDiv({ cls: 'mp-settings-error' });
    shortcut.addText((text) => {
      text.setValue(wallpaper.shortcutName);
      text.onChange((value) => {
        showError(shortcutError, text.inputEl, normalizeShortcutName(value) === null ? t('settings.lockscreen.shortcut.error') : null);
      });
      text.inputEl.addEventListener('change', () => {
        const name = normalizeShortcutName(text.getValue());
        showError(shortcutError, text.inputEl, name === null ? t('settings.lockscreen.shortcut.error') : null);
        if (name === null || name === this.deps.store.get().wallpaper.shortcutName) return;
        text.setValue(name);
        void this.save((draft) => {
          draft.wallpaper.shortcutName = name;
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Компаньон
  // -------------------------------------------------------------------------

  private renderCompanion(el: HTMLElement): void {
    heading(el, t('settings.headings.companion'));
    const state = this.deps.companion?.getState() ?? null;

    const lastEdit = this.deps.lastReminderEditAt?.() ?? null;
    const lastUpdate = state?.status === 'ok' ? state.lastUpdate : null;
    if (isReminderSchedulingPending(lastUpdate, lastEdit, this.now())) {
      const banner = el.createDiv({ cls: 'mp-settings-banner', attr: { role: 'status' } });
      setIcon(banner.createSpan({ cls: 'mp-settings-banner-icon' }), 'bell');
      banner.createSpan({ text: t('settings.companion.reminderBanner') });
    }

    const status = new Setting(el).setName(t('settings.companion.status.name'));
    const lines: string[] = [];
    if (!state) {
      lines.push(t('settings.companion.status.unavailable'));
    } else if (state.status === 'missing') {
      lines.push(t('settings.companion.status.missing'));
    } else if (state.status === 'corrupt') {
      lines.push(t('settings.companion.status.corrupt'));
    } else {
      const formatted = state.lastUpdate ? this.formatInstant(state.lastUpdate) : null;
      lines.push(formatted ? t('settings.companion.status.lastUpdate', { value: formatted }) : t('settings.companion.status.lastUpdateNever'));
      lines.push(state.primaryDevice ? t('settings.companion.status.primaryDevice', { value: state.primaryDevice }) : t('settings.companion.status.primaryDeviceNone'));
    }
    for (const line of lines) status.descEl.createDiv({ text: line });

    new Setting(el).setName(t('settings.companion.instructions.name')).setDesc(t('settings.companion.instructions.desc'));

    const open = this.deps.openCompanion;
    if (open) {
      new Setting(el).setName(t('settings.companion.open.name')).addButton((button) =>
        button.setButtonText(t('settings.companion.open.button')).onClick(() => open()),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Данные
  // -------------------------------------------------------------------------

  private renderData(el: HTMLElement, track: Track): void {
    const integrity = this.deps.integrity;
    if (!integrity) return;
    heading(el, t('settings.headings.data'));

    new Setting(el)
      .setName(t('settings.data.check.name'))
      .setDesc(t('settings.data.check.desc'))
      .addButton((button) => {
        button.setButtonText(t('settings.data.check.button')).onClick(async () => {
          button.setDisabled(true).setButtonText(t('settings.data.check.running'));
          try {
            const result = await integrity.check();
            if (!result.ok) {
              this.notify(t('settings.data.check.failed'));
            } else {
              const count = result.value.items.length;
              this.notify(count === 0 ? t('settings.data.check.clean') : tPlural('settings.data.check.found', count));
            }
          } catch (error) {
            console.error('[matrix-planner] Ошибка проверки целостности', error);
            this.notify(t('settings.data.check.failed'));
          } finally {
            button.setDisabled(false).setButtonText(t('settings.data.check.button'));
          }
        });
      });

    const report = integrity.getLastReport();
    const attention = new Setting(el).setName(t('settings.data.attention.name')).setClass('mp-settings-group');
    attention.setDesc(report ? t('settings.data.attention.checkedAt', { value: this.formatInstant(report.checkedAt) ?? report.checkedAt }) : t('settings.data.attention.notChecked'));

    const listEl = el.createDiv({ cls: 'mp-settings-attention' });
    const panel = this.deps.attentionPanel;
    if (panel) {
      const handle = panel(listEl);
      if (handle) track(() => handle.dispose());
      return;
    }
    this.renderAttentionList(listEl, report);
  }

  /** Простой список «Требуют внимания», пока не подключена панель модуля целостности. */
  private renderAttentionList(listEl: HTMLElement, report: IntegrityReport | null): void {
    if (!report) return;
    if (report.items.length === 0) {
      listEl.createDiv({ cls: 'mp-settings-note', text: t('settings.data.attention.empty') });
      return;
    }
    const openNote = this.deps.openNote;
    const list = listEl.createEl('ul', { cls: 'mp-settings-attention-list' });
    for (const item of report.items) {
      const row = list.createEl('li', { cls: 'mp-settings-attention-item' });
      row.createDiv({ cls: 'mp-settings-attention-message', text: t(item.messageKey, item.messageParams) });
      for (const path of item.paths) {
        const pathRow = row.createDiv({ cls: 'mp-settings-attention-path' });
        pathRow.createSpan({ text: path });
        if (openNote) {
          const button = pathRow.createEl('button', { cls: 'mp-settings-attention-open', text: t('settings.data.attention.openNote') });
          button.addEventListener('click', () => openNote(path));
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Служебное
  // -------------------------------------------------------------------------

  /**
   * Рисует раздел и перерисовывает его по событию источника. Очистка внутренних
   * ресурсов (`track`) выполняется перед каждой перерисовкой и при скрытии вкладки.
   */
  private mountLive(
    el: HTMLElement,
    render: (el: HTMLElement, track: Track) => void,
    subscribe?: (refresh: () => void) => Unsubscribe | undefined,
  ): void {
    let inner: Array<() => void> = [];
    const disposeInner = (): void => {
      runAll(inner);
      inner = [];
    };
    const draw = (): void => {
      disposeInner();
      el.empty();
      render(el, (cleanup) => inner.push(cleanup));
    };
    draw();
    const unsubscribe = subscribe?.(() => draw());
    this.cleanups.push(() => {
      unsubscribe?.();
      disposeInner();
    });
  }

  /** Изменить и сохранить настройки; ошибка записи — уведомление. Возвращает успех. */
  private async save(mutate: (draft: PlannerSettings) => void): Promise<boolean> {
    try {
      await this.deps.store.update(mutate);
      return true;
    } catch (error) {
      console.error('[matrix-planner] Не удалось сохранить настройки', error);
      this.notify(t('settings.errors.saveFailed'));
      return false;
    }
  }

  private notify(message: string): void {
    if (this.deps.notifier) this.deps.notifier.show(message);
    else new Notice(message);
  }

  private now(): number {
    return this.deps.clock ? this.deps.clock.now().getTime() : Date.now();
  }

  private language(): Language {
    return this.deps.format?.get().language ?? getCurrentLanguage();
  }

  private hour12(): boolean | undefined {
    const format = this.deps.format?.get();
    if (format) return format.hour12;
    const setting = this.deps.store.get().timeFormat;
    return setting === 'auto' ? undefined : setting === '12h';
  }

  /** «10 окт., 13:32» в языке и формате времени пользователя; `null` — неразборчивая дата. */
  private formatInstant(iso: string): string | null {
    return formatInstant(iso, this.language(), this.hour12());
  }

  private disposeAll(): void {
    const cleanups = this.cleanups;
    this.cleanups = [];
    runAll(cleanups);
  }
}

/** Форматирует момент времени для подписей настроек. */
export function formatInstant(iso: string, language: Language, hour12?: boolean): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
  if (hour12 !== undefined) options.hour12 = hour12;
  return new Intl.DateTimeFormat(language, options).format(new Date(ms));
}

function heading(el: HTMLElement, name: string): void {
  new Setting(el).setName(name).setHeading();
}

function showError(errorEl: HTMLElement, inputEl: HTMLElement, message: string | null): void {
  errorEl.setText(message ?? '');
  if (message) inputEl.setAttribute('aria-invalid', 'true');
  else inputEl.removeAttribute('aria-invalid');
}

function runAll(cleanups: Array<() => void>): void {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      console.error('[matrix-planner] Ошибка очистки настроек', error);
    }
  }
}
