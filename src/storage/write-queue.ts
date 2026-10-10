/**
 * Локальная очередь записей: задания с одним ключом (путь файла) выполняются строго
 * последовательно, разные ключи — параллельно. Ошибка задания не останавливает очередь.
 *
 * Вложенный `run` с тем же ключом изнутри задания приведёт к взаимной блокировке — не делайте так.
 */

import type { WriteQueue } from '../app/contracts';

export class KeyedWriteQueue implements WriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(job);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Есть ли незавершённые задания по ключу (или по любому ключу). */
  isBusy(key?: string): boolean {
    return key === undefined ? this.tails.size > 0 : this.tails.has(key);
  }

  /** Ждёт завершения всех заданий, поставленных до вызова. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()]);
    }
  }
}

export function createWriteQueue(): KeyedWriteQueue {
  return new KeyedWriteQueue();
}
