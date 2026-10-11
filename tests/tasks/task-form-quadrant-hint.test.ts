import { afterEach, describe, expect, it } from 'vitest';
import { setLanguageOverride } from '../../src/i18n';
import { quadrantHint } from '../../src/tasks/task-form';

afterEach(() => setLanguageOverride(null));

describe('подпись квадранта в форме задачи (доработка 005, §3)', () => {
  it('русский', () => {
    setLanguageOverride('ru');
    expect(quadrantHint('do')).toBe('Срочно и важно');
    expect(quadrantHint('plan')).toBe('Важно, не срочно');
    expect(quadrantHint('urgent')).toBe('Срочно, менее важно');
    expect(quadrantHint('someday')).toBe('Ни срочно, ни важно');
  });

  it('английский', () => {
    setLanguageOverride('en');
    expect(quadrantHint('do')).toBe('Urgent and important');
    expect(quadrantHint('plan')).toBe('Important, not urgent');
    expect(quadrantHint('urgent')).toBe('Urgent, less important');
    expect(quadrantHint('someday')).toBe('Neither urgent nor important');
  });
});
