/**
 * Пароль CalDAV (пароль приложения Apple ID) и локальное состояние синхронизации.
 *
 * Пароль хранится только на устройстве: в `app.secretStorage` (Obsidian 1.11.4+), иначе —
 * в `app.saveLocalStorage` (локальное хранилище Obsidian для этого хранилища). В data.json
 * и в заметки он не пишется (data.json синхронизируется), в консоль не выводится.
 */

import type { App } from 'obsidian';

/** Ключи локального хранилища (Obsidian сам добавляет к ним идентификатор хранилища). */
const PASSWORD_KEY = 'matrix-planner-caldav-password';
const SECRET_ID_KEY = 'matrix-planner-caldav-secret-id';
/** Идентификатор секрета по умолчанию: строчные буквы, цифры и дефисы. */
export const DEFAULT_SECRET_ID = 'matrix-planner-caldav';

/** Часть `App`, нужная для хранения: в старых версиях Obsidian `secretStorage` нет. */
export interface CredentialHost {
  secretStorage?: {
    setSecret(id: string, secret: string): void;
    getSecret(id: string): string | null;
  };
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
}

export function hostOf(app: App): CredentialHost {
  return app;
}

export function hasSecretStorage(host: CredentialHost): boolean {
  const storage = host.secretStorage;
  return !!storage && typeof storage.getSecret === 'function' && typeof storage.setSecret === 'function';
}

export interface PasswordStore {
  getPassword(): string | null;
  /** `null` или пустая строка — удалить пароль. */
  setPassword(password: string | null): void;
  /** Пароль хранится в хранилище секретов Obsidian. */
  usesSecretStorage(): boolean;
  /** Идентификатор секрета, выбранный в `SecretComponent` (только для хранилища секретов). */
  getSecretId(): string;
  setSecretId(id: string | null): void;
}

function safeLoad(host: CredentialHost, key: string): unknown {
  try {
    return host.loadLocalStorage(key);
  } catch {
    return null;
  }
}

function safeSave(host: CredentialHost, key: string, value: unknown): void {
  try {
    host.saveLocalStorage(key, value);
  } catch {
    // Локальное хранилище недоступно (приватный режим) — пароль просто не запоминается.
  }
}

export class LocalPasswordStore implements PasswordStore {
  constructor(private readonly host: CredentialHost) {}

  usesSecretStorage(): boolean {
    return hasSecretStorage(this.host);
  }

  getSecretId(): string {
    const id = safeLoad(this.host, SECRET_ID_KEY);
    return typeof id === 'string' && id !== '' ? id : DEFAULT_SECRET_ID;
  }

  setSecretId(id: string | null): void {
    safeSave(this.host, SECRET_ID_KEY, id && id !== '' ? id : null);
  }

  getPassword(): string | null {
    if (this.usesSecretStorage()) {
      try {
        const secret = this.host.secretStorage?.getSecret(this.getSecretId()) ?? null;
        if (secret) return secret;
      } catch {
        // Хранилище секретов недоступно — пробуем локальное хранилище.
      }
    }
    const value = safeLoad(this.host, PASSWORD_KEY);
    return typeof value === 'string' && value !== '' ? value : null;
  }

  setPassword(password: string | null): void {
    const value = password && password.trim() !== '' ? password.trim() : null;
    if (this.usesSecretStorage()) {
      try {
        this.host.secretStorage?.setSecret(this.getSecretId(), value ?? '');
        // Пароль из запасного хранилища больше не нужен.
        safeSave(this.host, PASSWORD_KEY, null);
        return;
      } catch {
        // Не удалось записать секрет — запасной вариант ниже.
      }
    }
    safeSave(this.host, PASSWORD_KEY, value);
  }
}

// ---------------------------------------------------------------------------
// Локальное состояние синхронизации (не в хранилище заметок)
// ---------------------------------------------------------------------------

/** Ключ состояния синхронизации с id хранилища Планировщика (`vault_id` маркера). */
export function syncStateKey(vaultId: string | null): string {
  return `matrix-planner-caldav-state-${vaultId ?? 'default'}`;
}

/** Хранилище JSON-состояния на устройстве. */
export interface LocalJsonStore {
  load(): unknown;
  save(value: unknown): void;
}

export function createLocalJsonStore(host: CredentialHost, key: () => string): LocalJsonStore {
  return {
    load: () => safeLoad(host, key()),
    save: (value) => safeSave(host, key(), value),
  };
}
