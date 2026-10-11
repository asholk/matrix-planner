import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockElement } from '../__mocks__/obsidian';
import { registerDictionary, setLanguageOverride } from '../../src/i18n';
import { ruTasks } from '../../src/i18n/ru/tasks';
import { enTasks } from '../../src/i18n/en/tasks';
import { renderTaskCard, type TaskCardHandlers } from '../../src/tasks/task-card';
import type { TaskCardModel } from '../../src/tasks/tasks-presenter';

registerDictionary('ru', 'tasks', ruTasks);
registerDictionary('en', 'tasks', enTasks);

const handlers: TaskCardHandlers = {
  onToggle: () => undefined,
  onOpen: () => undefined,
  onMenu: () => undefined,
  onContextMenu: () => undefined,
  onPointerDown: () => undefined,
  consumeClick: () => false,
};

function card(over: Partial<TaskCardModel> = {}): TaskCardModel {
  return {
    key: 'A',
    taskId: 'A',
    path: 'Планировщик/Задачи/A.md',
    title: 'Собрать чемодан',
    quadrant: 'do',
    highPriority: false,
    recurring: false,
    dueLabel: null,
    overdue: false,
    done: false,
    completedLabel: null,
    instanceDate: null,
    ...over,
  };
}

function render(model: TaskCardModel): MockElement {
  const parent = new MockElement();
  renderTaskCard(parent as unknown as HTMLElement, model, { quadrantTitle: 'Важно и срочно', showQuadrantDot: false, busy: false }, handlers);
  return parent;
}

beforeEach(() => setLanguageOverride('ru'));
afterEach(() => setLanguageOverride(null));

describe('карточка задачи: чек-лист (доработка 008)', () => {
  it('бейдж «2/5» со значком list-checks в строке мета', () => {
    const el = render(card({ checklist: { done: 2, total: 5 }, dueLabel: 'Завтра' }));
    const badge = el.findAllByClass('mp-task-checklist')[0];
    expect(badge).toBeDefined();
    expect(badge?.parent?.hasClass('mp-task-meta')).toBe(true);
    expect(badge?.hasClass('is-complete')).toBe(false);
    expect(badge?.findAllByClass('mp-task-checklist-icon')[0]?.getAttribute('data-icon')).toBe('list-checks');
    expect(badge?.findAllByClass('mp-task-checklist-count')[0]?.getText()).toBe('2/5');
    // Подпись для диктора — в aria-label карточки.
    const main = el.findAllByClass('mp-task-main')[0];
    expect(main?.getAttribute('aria-label')).toContain('Выполнено пунктов: 2 из 5');
  });

  it('все пункты выполнены — приглушённый стиль', () => {
    const el = render(card({ checklist: { done: 3, total: 3 } }));
    expect(el.findAllByClass('mp-task-checklist')[0]?.hasClass('is-complete')).toBe(true);
  });

  it('без чек-листа бейджа нет (и строки мета без срока тоже)', () => {
    const el = render(card({ checklist: null }));
    expect(el.findAllByClass('mp-task-checklist')).toHaveLength(0);
    expect(el.findAllByClass('mp-task-meta')).toHaveLength(0);
  });

  it('English label', () => {
    setLanguageOverride('en');
    const el = render(card({ checklist: { done: 1, total: 4 } }));
    expect(el.findAllByClass('mp-task-main')[0]?.getAttribute('aria-label')).toContain('1 of 4 items done');
  });
});
