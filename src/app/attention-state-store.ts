/**
 * Общий доступ к data.json плагина для настроек и состояния «Требуют внимания».
 *
 * Настройки (`PluginSettingsStore`) и состояние проверки целостности хранятся в одном
 * файле, но в разных ключах. Чтобы запись одного не затирала другое, оба работают
 * через `PluginDataFile`: он держит последний снимок файла и сериализует записи.
 * Настройки не видят ключ `attention` (он вырезается при чтении и возвращается при записи).
 */

import type { AttentionState, AttentionStateStore } from '../integrity/integrity-service';
import type { SettingsDataSource } from '../settings/types';

/** Ключ data.json с состоянием «Требуют внимания». */
export const ATTENTION_DATA_KEY = 'attention';

type DataRecord = Record<string, unknown>;

function isRecord(value: unknown): value is DataRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class PluginDataFile {
  private snapshot: DataRecord | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly source: SettingsDataSource) {}

  /** Содержимое data.json (читается один раз, дальше — снимок последней записи). */
  async read(): Promise<DataRecord> {
    if (this.snapshot === null) {
      const raw = await this.source.loadData();
      // Повторная проверка: снимок мог появиться во время чтения (запись из очереди).
      if (this.snapshot === null) this.snapshot = isRecord(raw) ? raw : {};
    }
    return this.snapshot;
  }

  /** Последовательная запись: `mutate` получает актуальную копию и возвращает новый объект. */
  write(mutate: (current: DataRecord) => DataRecord): Promise<void> {
    const run = async (): Promise<void> => {
      const current = { ...(await this.read()) };
      const next = mutate(current);
      await this.source.saveData(next);
      this.snapshot = next;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Источник для `PluginSettingsStore`: без ключа `attention`, который сохраняется при записи. */
  settingsSource(): SettingsDataSource {
    return {
      loadData: async () => {
        const data = await this.read();
        const rest: DataRecord = { ...data };
        delete rest[ATTENTION_DATA_KEY];
        return rest;
      },
      saveData: (settings: unknown) =>
        this.write((current) => {
          const next: DataRecord = isRecord(settings) ? { ...settings } : {};
          delete next[ATTENTION_DATA_KEY];
          if (current[ATTENTION_DATA_KEY] !== undefined) next[ATTENTION_DATA_KEY] = current[ATTENTION_DATA_KEY];
          return next;
        }),
    };
  }
}

/** Состояние «Требуют внимания» в data.json (ключ `attention`). */
export class DataJsonAttentionStateStore implements AttentionStateStore {
  constructor(private readonly file: PluginDataFile) {}

  async load(): Promise<unknown> {
    const data = await this.file.read();
    const value = data[ATTENTION_DATA_KEY];
    return value === undefined ? null : structuredClone(value);
  }

  save(state: AttentionState): Promise<void> {
    return this.file.write((current) => ({ ...current, [ATTENTION_DATA_KEY]: structuredClone(state) }));
  }
}
