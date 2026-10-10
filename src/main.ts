import { Plugin } from 'obsidian';
import { composeApp, type AppHandle } from './app/compose-planner';

/**
 * Точка входа плагина. Только жизненный цикл: модули подключаются
 * сборкой в app/compose-core.ts (этап 1) и app/compose-planner.ts (этап 2).
 */
export default class MatrixPlannerPlugin extends Plugin {
  core: AppHandle | null = null;

  async onload(): Promise<void> {
    this.core = await composeApp(this);
  }

  onunload(): void {
    // Подписки, вид, команды, обработчик ссылок и индекс освобождаются через register*/registerEvent.
    this.core = null;
  }
}
