import { Plugin } from 'obsidian';
import { composeCore, type CoreHandle } from './app/compose-core';

/**
 * Точка входа плагина. Только жизненный цикл: модули подключаются
 * сборкой в app/compose-core.ts (этап 1) и app/compose-planner.ts (этап 2, S2.T9).
 */
export default class MatrixPlannerPlugin extends Plugin {
  core: CoreHandle | null = null;

  async onload(): Promise<void> {
    this.core = await composeCore(this);
  }

  onunload(): void {
    // Подписки, вид, команды и индекс освобождаются через register*/registerEvent.
    this.core = null;
  }
}
