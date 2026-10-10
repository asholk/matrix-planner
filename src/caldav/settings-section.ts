/**
 * Раздел настроек «Календарь iOS»: учётная запись CalDAV (iCloud или другой сервер),
 * календари для записи и показа, задачи в календаре, интервал, подписки ICS,
 * «Синхронизировать сейчас» и состояние последней синхронизации.
 */

import * as obsidian from 'obsidian';
import { Setting, type App } from 'obsidian';
import type { Notifier, SettingsSection, SettingsStore } from '../app/contracts';
import type { CalendarSyncSettings, IcsSubscriptionSetting } from '../model/types';
import { SETTINGS_SECTION_ORDER } from '../settings/settings-tab';
import { normalizeSyncInterval } from '../settings/settings-store';
import { t } from '../i18n';
import type { PasswordStore } from './credentials';
import type { CalendarSyncEngine, CalendarSyncStatus } from './sync-engine';

/** Значение выпадающего списка «Создать „Планировщик“». */
const CREATE_OPTION = '__create__';
const APPLE_ACCOUNT_URL = 'https://account.apple.com';
const SUBSCRIPTION_URL_RE = /^(https?|webcals?):\/\/\S+$/i;
const DEFAULT_SUBSCRIPTION_COLOR = '#8e8e93';

/** `SecretComponent` есть с Obsidian 1.11.4 — проверяется во время работы. */
interface SecretComponentLike {
  setValue(value: string): unknown;
  onChange(callback: (value: string | null) => unknown): unknown;
}
type SecretComponentCtor = new (app: App, containerEl: HTMLElement) => SecretComponentLike;

function secretComponentCtor(): SecretComponentCtor | null {
  const ctor = (obsidian as unknown as { SecretComponent?: SecretComponentCtor }).SecretComponent;
  return typeof ctor === 'function' ? ctor : null;
}

export interface CalendarSyncSectionDeps {
  app: App;
  settings: Pick<SettingsStore, 'get' | 'update'>;
  engine: Pick<
    CalendarSyncEngine,
    'getStatus' | 'onStatusChange' | 'getKnownCalendars' | 'testConnection' | 'createPlannerCalendar' | 'syncNow'
  >;
  passwords: PasswordStore;
  notifier: Notifier;
}

/** Текст состояния синхронизации для настроек. */
export function syncStatusText(status: CalendarSyncStatus, formatTime: (iso: string) => string): string {
  if (status.running) return t('caldav.settings.status.running');
  const lastOk = status.lastSyncAt ? t('caldav.settings.status.ok', { time: formatTime(status.lastSyncAt) }) : null;
  if (!status.error) return lastOk ?? t('caldav.settings.status.never');
  const key = status.error.kind === 'not-configured' ? 'notConfigured' : status.error.kind;
  const error = t(`caldav.settings.status.${key}`);
  return status.lastSyncAt ? `${error}. ${t('caldav.settings.status.lastOk', { time: formatTime(status.lastSyncAt) })}` : error;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function calendarSyncSection(deps: CalendarSyncSectionDeps): SettingsSection {
  const cleanups: Array<() => void> = [];

  const update = (mutate: (draft: CalendarSyncSettings) => void): Promise<void> =>
    deps.settings.update((draft) => mutate(draft.calendarSync)).catch((error: unknown) => {
      console.error('[matrix-planner] Cannot save calendar sync settings', error);
    });

  const render = (containerEl: HTMLElement): void => {
    const root = containerEl.createDiv({ cls: 'mp-caldav-settings' });
    let statusSetting: Setting | null = null;

    const refreshStatus = (): void => {
      statusSetting?.setDesc(syncStatusText(deps.engine.getStatus(), formatTime));
    };

    const draw = (): void => {
      root.empty();
      statusSetting = null;
      const sync = deps.settings.get().calendarSync;
      const icloud = sync.provider === 'icloud';

      new Setting(root).setName(t('caldav.settings.heading')).setHeading();
      new Setting(root).setDesc(t('caldav.settings.intro'));

      new Setting(root)
        .setName(t('caldav.settings.enabled.name'))
        .setDesc(t('caldav.settings.enabled.desc'))
        .addToggle((toggle) =>
          toggle.setValue(sync.enabled).onChange(async (value) => {
            await update((draft) => {
              draft.enabled = value;
            });
            draw();
          }),
        );

      new Setting(root).setName(t('caldav.settings.provider.name')).addDropdown((dropdown) =>
        dropdown
          .addOption('icloud', t('caldav.settings.provider.icloud'))
          .addOption('caldav', t('caldav.settings.provider.caldav'))
          .setValue(sync.provider)
          .onChange(async (value) => {
            await update((draft) => {
              draft.provider = value === 'caldav' ? 'caldav' : 'icloud';
            });
            draw();
          }),
      );

      if (!icloud) {
        new Setting(root)
          .setName(t('caldav.settings.serverUrl.name'))
          .setDesc(t('caldav.settings.serverUrl.desc'))
          .addText((text) =>
            text.setValue(sync.serverUrl).onChange((value) => {
              void update((draft) => {
                draft.serverUrl = value.trim();
              });
            }),
          );
      }

      new Setting(root)
        .setName(t(icloud ? 'caldav.settings.username.icloud' : 'caldav.settings.username.caldav'))
        .setDesc(t('caldav.settings.username.desc'))
        .addText((text) =>
          text.setValue(sync.username).onChange((value) => {
            void update((draft) => {
              draft.username = value.trim();
            });
          }),
        );

      renderPassword(root, icloud);

      new Setting(root)
        .setName(t('caldav.settings.test.name'))
        .addButton((button) =>
          button.setButtonText(t('caldav.settings.test.button')).onClick(async () => {
            button.setDisabled(true).setButtonText(t('caldav.settings.test.running'));
            const result = await deps.engine.testConnection();
            if (result.ok) deps.notifier.show(t('caldav.settings.test.found', { count: result.calendars.length }));
            else deps.notifier.show(errorNotice(result.kind));
            draw();
          }),
        );

      renderWriteCalendar(root, sync);
      renderReadCalendars(root, sync);

      new Setting(root)
        .setName(t('caldav.settings.tasks.name'))
        .setDesc(t('caldav.settings.tasks.desc'))
        .addToggle((toggle) =>
          toggle.setValue(sync.tasksToCalendar).onChange((value) => {
            void update((draft) => {
              draft.tasksToCalendar = value;
            });
          }),
        );
      new Setting(root)
        .setName(t('caldav.settings.completed.name'))
        .setDesc(t('caldav.settings.completed.desc'))
        .addToggle((toggle) =>
          toggle.setValue(sync.completedTasksToCalendar).onChange((value) => {
            void update((draft) => {
              draft.completedTasksToCalendar = value;
            });
          }),
        );
      new Setting(root)
        .setName(t('caldav.settings.interval.name'))
        .setDesc(t('caldav.settings.interval.desc'))
        .addText((text) => {
          text.inputEl.type = 'number';
          text.setValue(String(sync.intervalMinutes)).onChange((value) => {
            const minutes = normalizeSyncInterval(Number(value.trim()));
            if (minutes === null) return;
            void update((draft) => {
              draft.intervalMinutes = minutes;
            });
          });
        });

      renderSubscriptions(root, sync.icsSubscriptions);

      new Setting(root).setName(t('caldav.settings.syncNow.name')).addButton((button) =>
        button
          .setButtonText(t('caldav.settings.syncNow.button'))
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            await deps.engine.syncNow({ manual: true });
            button.setDisabled(false);
          }),
      );
      statusSetting = new Setting(root).setName(t('caldav.settings.status.name'));
      refreshStatus();
    };

    const renderPassword = (el: HTMLElement, icloud: boolean): void => {
      const setting = new Setting(el)
        .setName(t(icloud ? 'caldav.settings.password.icloud' : 'caldav.settings.password.caldav'))
        .setDesc(t('caldav.settings.password.desc'));
      if (icloud) {
        const help = setting.descEl.createDiv();
        help.createEl('a', { text: t('caldav.settings.password.help'), href: APPLE_ACCOUNT_URL });
      }
      const Secret = deps.passwords.usesSecretStorage() ? secretComponentCtor() : null;
      if (Secret) {
        // Пароль хранится в хранилище секретов Obsidian; в настройках — только имя секрета.
        const secret = new Secret(deps.app, setting.controlEl);
        secret.setValue(deps.passwords.getSecretId());
        secret.onChange((id) => deps.passwords.setSecretId(id));
        return;
      }
      setting.addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.setPlaceholder(deps.passwords.getPassword() ? t('caldav.settings.password.saved') : t('caldav.settings.password.placeholder'));
        text.onChange((value) => {
          if (value.trim() !== '') deps.passwords.setPassword(value);
        });
      });
    };

    const renderWriteCalendar = (el: HTMLElement, sync: CalendarSyncSettings): void => {
      const writable = deps.engine.getKnownCalendars().filter((calendar) => calendar.allowsModifications);
      const setting = new Setting(el).setName(t('caldav.settings.writeCalendar.name')).setDesc(t('caldav.settings.writeCalendar.desc'));
      if (writable.length === 0) setting.setDesc(`${t('caldav.settings.writeCalendar.desc')}. ${t('caldav.settings.writeCalendar.unknown')}`);
      setting.addDropdown((dropdown) => {
        dropdown.addOption('', t('caldav.settings.writeCalendar.auto'));
        for (const calendar of writable) dropdown.addOption(calendar.href, calendar.displayName);
        const current = sync.writeCalendarHref;
        if (current && !writable.some((calendar) => calendar.href === current)) dropdown.addOption(current, current);
        if (writable.length > 0) dropdown.addOption(CREATE_OPTION, t('caldav.settings.writeCalendar.create'));
        dropdown.setValue(current ?? '');
        dropdown.onChange(async (value) => {
          if (value === CREATE_OPTION) {
            await deps.engine.createPlannerCalendar();
            draw();
            return;
          }
          await update((draft) => {
            draft.writeCalendarHref = value === '' ? null : value;
          });
        });
      });
    };

    const renderReadCalendars = (el: HTMLElement, sync: CalendarSyncSettings): void => {
      new Setting(el).setName(t('caldav.settings.readCalendars.heading')).setDesc(t('caldav.settings.readCalendars.desc')).setHeading();
      const calendars = deps.engine.getKnownCalendars();
      if (calendars.length === 0) {
        new Setting(el).setDesc(t('caldav.settings.readCalendars.empty'));
        return;
      }
      const all = sync.readCalendarHrefs.length === 0;
      if (all) new Setting(el).setDesc(t('caldav.settings.readCalendars.allHint'));
      for (const calendar of calendars) {
        const setting = new Setting(el).setName(calendar.displayName);
        if (!calendar.allowsModifications) setting.setDesc(t('caldav.settings.readCalendars.readOnly'));
        setting.addToggle((toggle) =>
          toggle.setValue(all || sync.readCalendarHrefs.includes(calendar.href)).onChange(async (value) => {
            await update((draft) => {
              const current = draft.readCalendarHrefs.length === 0 ? calendars.map((item) => item.href) : [...draft.readCalendarHrefs];
              const next = value ? [...new Set([...current, calendar.href])] : current.filter((href) => href !== calendar.href);
              // Выбраны все — пустой список («все», включая новые календари).
              draft.readCalendarHrefs = next.length === calendars.length ? [] : next;
            });
            draw();
          }),
        );
      }
    };

    const renderSubscriptions = (el: HTMLElement, subscriptions: readonly IcsSubscriptionSetting[]): void => {
      new Setting(el).setName(t('caldav.settings.subscriptions.heading')).setDesc(t('caldav.settings.subscriptions.desc')).setHeading();
      for (const subscription of subscriptions) {
        new Setting(el)
          .setName(subscription.name || subscription.url)
          .setDesc(subscription.url)
          .addExtraButton((button) =>
            button
              .setIcon('trash-2')
              .setTooltip(t('caldav.settings.subscriptions.remove'))
              .onClick(async () => {
                await update((draft) => {
                  draft.icsSubscriptions = draft.icsSubscriptions.filter((item) => item.url !== subscription.url);
                });
                draw();
              }),
          );
      }
      let name = '';
      let url = '';
      new Setting(el)
        .addText((text) =>
          text.setPlaceholder(t('caldav.settings.subscriptions.namePlaceholder')).onChange((value) => {
            name = value;
          }),
        )
        .addText((text) =>
          text.setPlaceholder(t('caldav.settings.subscriptions.urlPlaceholder')).onChange((value) => {
            url = value;
          }),
        )
        .addButton((button) =>
          button.setButtonText(t('caldav.settings.subscriptions.add')).onClick(async () => {
            const trimmed = url.trim();
            if (!SUBSCRIPTION_URL_RE.test(trimmed)) {
              deps.notifier.show(t('caldav.settings.subscriptions.invalidUrl'));
              return;
            }
            await update((draft) => {
              if (draft.icsSubscriptions.some((item) => item.url === trimmed)) return;
              draft.icsSubscriptions = [...draft.icsSubscriptions, { name: name.trim(), url: trimmed, color: DEFAULT_SUBSCRIPTION_COLOR }];
            });
            draw();
          }),
        );
    };

    draw();
    cleanups.push(deps.engine.onStatusChange(() => refreshStatus()));
  };

  return {
    order: SETTINGS_SECTION_ORDER.calendar + 1,
    render,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

function errorNotice(kind: string): string {
  if (kind === 'auth') return t('caldav.notices.auth');
  if (kind === 'network') return t('caldav.notices.network');
  if (kind === 'not-configured') return t('caldav.notices.notConfigured');
  return t('caldav.notices.failed');
}
