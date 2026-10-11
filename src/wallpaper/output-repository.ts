/**
 * Файлы обоев в `<корень>/Обои/<профиль>/`: `lock-ГГГГ-ММ-ДД.png`, `lock.png` и `lock-expired.png`.
 * Запись — `NoteRepository.writeBinary` (создание или замена; файл с теми же байтами
 * не переписывается), удаление — `trash`.
 * Очистка трогает только свои датированные файлы профиля; прочие файлы
 * (например `shortcut-last-run.txt` быстрой команды) не меняются.
 */

import type { NoteRepository } from '../app/contracts';
import { compareDates } from '../model/dates';
import type { LocalDateString, OpResult, VaultPath } from '../model/types';
import { EXPIRED_FILE_NAME, LOCK_FILE_NAME, datedFileName, parseDatedFileName, sameBytes } from './render-plan';

export type OutputRepositoryDeps = Pick<NoteRepository, 'paths' | 'exists' | 'writeBinary' | 'listFolder' | 'trash'> &
  Partial<Pick<NoteRepository, 'readBinary'>>;

export interface CleanupResult {
  removed: VaultPath[];
  failed: { path: VaultPath; detail: string }[];
}

function baseName(path: VaultPath): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export class WallpaperOutputRepository {
  constructor(private readonly repository: OutputRepositoryDeps) {}

  folder(profileId: string): VaultPath {
    return this.repository.paths.wallpaperProfile(profileId);
  }

  datedPath(profileId: string, date: LocalDateString): VaultPath {
    return `${this.folder(profileId)}/${datedFileName(date)}`;
  }

  lockPath(profileId: string): VaultPath {
    return `${this.folder(profileId)}/${LOCK_FILE_NAME}`;
  }

  exists(path: VaultPath): boolean {
    return this.repository.exists(path);
  }

  expiredPath(profileId: string): VaultPath {
    return `${this.folder(profileId)}/${EXPIRED_FILE_NAME}`;
  }

  writeDated(profileId: string, date: LocalDateString, png: ArrayBuffer): Promise<OpResult> {
    return this.writeIfChanged(this.datedPath(profileId, date), png);
  }

  writeLock(profileId: string, png: ArrayBuffer): Promise<OpResult> {
    return this.writeIfChanged(this.lockPath(profileId), png);
  }

  writeExpired(profileId: string, png: ArrayBuffer): Promise<OpResult> {
    return this.writeIfChanged(this.expiredPath(profileId), png);
  }

  /** Читает файл профиля. */
  read(path: VaultPath): Promise<OpResult<ArrayBuffer>> {
    if (!this.repository.readBinary) return Promise.resolve({ ok: false, error: { code: 'unsupported', detail: path } });
    return this.repository.readBinary(path);
  }

  /**
   * Запись, если байты отличаются от файла в хранилище (`changed: false` — пропущено):
   * одинаковые PNG не попадают в синхронизацию и не меняют время файла.
   */
  async writeIfChanged(path: VaultPath, png: ArrayBuffer): Promise<OpResult> {
    if (this.repository.readBinary && this.repository.exists(path)) {
      const current = await this.repository.readBinary(path).catch(() => null);
      if (current?.ok && sameBytes(current.value, png)) return { ok: true, value: undefined, changed: false };
    }
    return this.repository.writeBinary(path, png);
  }

  /** Удаляет датированный файл (например, устаревший файл на сегодня, если новый не записался). */
  async removeDated(profileId: string, date: LocalDateString): Promise<OpResult> {
    const path = this.datedPath(profileId, date);
    if (!this.repository.exists(path)) return { ok: true, value: undefined, changed: false };
    return this.repository.trash(path);
  }

  /** Удаляет `lock-ГГГГ-ММ-ДД.png` с датой раньше `today` в папке профиля (без вложенных папок). */
  async cleanup(profileId: string, today: LocalDateString): Promise<CleanupResult> {
    const result: CleanupResult = { removed: [], failed: [] };
    const listing = await this.repository.listFolder(this.folder(profileId));
    if (!listing.ok) {
      // Папки ещё нет — удалять нечего.
      if (listing.error.code !== 'not-found') {
        result.failed.push({ path: this.folder(profileId), detail: listing.error.detail ?? listing.error.code });
      }
      return result;
    }
    for (const path of listing.value.files) {
      const date = parseDatedFileName(baseName(path));
      if (date === null || compareDates(date, today) >= 0) continue;
      const trashed = await this.repository.trash(path);
      // Уже удалён на другом устройстве — тоже результат.
      if (trashed.ok || trashed.error.code === 'not-found') result.removed.push(path);
      else result.failed.push({ path, detail: trashed.error.detail ?? trashed.error.code });
    }
    return result;
  }
}
