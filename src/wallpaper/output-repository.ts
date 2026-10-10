/**
 * Файлы обоев в `<корень>/Обои/<профиль>/`: `lock-ГГГГ-ММ-ДД.png` и `lock.png`.
 * Запись — `NoteRepository.writeBinary` (создание или замена), удаление — `trash`.
 * Очистка трогает только свои датированные файлы профиля; прочие файлы
 * (например `shortcut-last-run.txt` быстрой команды) не меняются.
 */

import type { NoteRepository } from '../app/contracts';
import { compareDates } from '../model/dates';
import type { LocalDateString, OpResult, VaultPath } from '../model/types';
import { LOCK_FILE_NAME, datedFileName, parseDatedFileName } from './render-plan';

export type OutputRepositoryDeps = Pick<NoteRepository, 'paths' | 'exists' | 'writeBinary' | 'listFolder' | 'trash'>;

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

  writeDated(profileId: string, date: LocalDateString, png: ArrayBuffer): Promise<OpResult> {
    return this.repository.writeBinary(this.datedPath(profileId, date), png);
  }

  writeLock(profileId: string, png: ArrayBuffer): Promise<OpResult> {
    return this.repository.writeBinary(this.lockPath(profileId), png);
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
