import { Plugin } from 'obsidian';

/**
 * Точка входа плагина. Только жизненный цикл: модули подключаются
 * сборкой в app/compose-core.ts (S1.T10) и app/compose-planner.ts (S2.T9).
 */
export default class MatrixPlannerPlugin extends Plugin {
  async onload(): Promise<void> {
    // Каркас: функции регистрируются интеграционными задачами.
  }

  onunload(): void {
    // Подписки освобождаются через register*/registerEvent.
  }
}
