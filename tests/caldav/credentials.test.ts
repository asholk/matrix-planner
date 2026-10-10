import { describe, expect, it } from 'vitest';
import { DEFAULT_SECRET_ID, LocalPasswordStore, syncStateKey, type CredentialHost } from '../../src/caldav/credentials';
import { createDefaultSettings } from '../../src/settings/defaults';
import { normalizeSettings } from '../../src/settings/settings-store';

function host(withSecrets: boolean): CredentialHost & { local: Map<string, unknown>; secrets: Map<string, string> } {
  const local = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const result: CredentialHost & { local: Map<string, unknown>; secrets: Map<string, string> } = {
    local,
    secrets,
    loadLocalStorage: (key) => local.get(key) ?? null,
    saveLocalStorage: (key, value) => {
      if (value === null) local.delete(key);
      else local.set(key, value);
    },
  };
  if (withSecrets) {
    result.secretStorage = {
      setSecret: (id, secret) => secrets.set(id, secret),
      getSecret: (id) => secrets.get(id) ?? null,
    };
  }
  return result;
}

describe('caldav/credentials', () => {
  it('хранилище секретов Obsidian, если оно есть', () => {
    const h = host(true);
    const store = new LocalPasswordStore(h);
    expect(store.usesSecretStorage()).toBe(true);
    store.setPassword(' abcd-efgh ');
    expect(h.secrets.get(DEFAULT_SECRET_ID)).toBe('abcd-efgh');
    expect([...h.local.values()]).not.toContain('abcd-efgh');
    expect(store.getPassword()).toBe('abcd-efgh');
    store.setSecretId('my-icloud');
    h.secrets.set('my-icloud', 'other');
    expect(store.getPassword()).toBe('other');
  });

  it('иначе — локальное хранилище устройства', () => {
    const h = host(false);
    const store = new LocalPasswordStore(h);
    expect(store.getPassword()).toBeNull();
    store.setPassword('secret');
    expect(store.getPassword()).toBe('secret');
    store.setPassword('');
    expect(store.getPassword()).toBeNull();
  });

  it('ключ состояния зависит от id хранилища', () => {
    expect(syncStateKey('abc')).not.toBe(syncStateKey('def'));
    expect(syncStateKey(null)).toContain('default');
  });
});

describe('настройки calendarSync', () => {
  it('значения по умолчанию', () => {
    expect(createDefaultSettings().calendarSync).toEqual({
      enabled: false,
      provider: 'icloud',
      serverUrl: '',
      username: '',
      writeCalendarHref: null,
      readCalendarHrefs: [],
      tasksToCalendar: true,
      completedTasksToCalendar: false,
      intervalMinutes: 15,
      icsSubscriptions: [],
    });
  });

  it('нормализация: неверные значения заменяются, пароль не появляется', () => {
    const settings = normalizeSettings({
      calendarSync: {
        enabled: 'yes',
        provider: 'google',
        username: ' me@icloud.com ',
        intervalMinutes: 1,
        readCalendarHrefs: ['a', 'a', 5],
        icsSubscriptions: [{ url: ' https://x/a.ics ', name: 'A', color: 'red' }, { url: '' }, 'bad'],
        future: 1,
      },
    });
    expect(settings.calendarSync).toMatchObject({
      enabled: false,
      provider: 'icloud',
      username: 'me@icloud.com',
      intervalMinutes: 15,
      readCalendarHrefs: ['a'],
      icsSubscriptions: [{ url: 'https://x/a.ics', name: 'A', color: '#8e8e93' }],
      future: 1,
    });
    expect(JSON.stringify(settings)).not.toContain('password');
  });
});
