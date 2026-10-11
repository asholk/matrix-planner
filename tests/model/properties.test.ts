import { describe, expect, it } from 'vitest';
import fixtures from '../../fixtures/properties.json';
import {
  applyFrontmatterPatch,
  createPlannerNoteParser,
  normalizeHexColor,
  parseMarker,
  parseMatrix,
  parsePlannerNote,
  taskToFrontmatter,
} from '../../src/model/properties';
import { planComplete } from '../../src/model/task-rules';
import type { FrontmatterRecord, Language, PropertyIssue, Task } from '../../src/model/types';

interface NoteCase {
  name: string;
  path: string;
  frontmatter: FrontmatterRecord | null;
  expected: Record<string, unknown> & { kind: string | null; issues?: Array<{ property: string; code: string }> };
}
interface MatrixCase {
  name: string;
  path: string | null;
  language: string;
  frontmatter: FrontmatterRecord | null;
  expected: { quadrants: unknown[]; issues: Array<{ property: string; code: string }> };
}
interface MarkerCase {
  name: string;
  frontmatter: FrontmatterRecord | null;
  expected: Record<string, unknown>;
}

function issueCodes(issues: readonly PropertyIssue[]): Array<{ property: string; code: string }> {
  return issues.map(({ property, code }) => ({ property, code }));
}

function titleOf(path: string): string {
  return path.split('/').pop()!.replace(/\.md$/, '');
}

describe('properties fixtures: notes', () => {
  for (const c of fixtures.notes as unknown as NoteCase[]) {
    it(c.name, () => {
      const parsed = parsePlannerNote({
        path: c.path,
        title: titleOf(c.path),
        mtime: 1,
        frontmatter: c.frontmatter,
        archived: false,
        deletedInCalendar: false,
      });
      if (c.expected.kind === null) {
        expect(parsed).toBeNull();
        return;
      }
      expect(parsed).not.toBeNull();
      const { issues, ...rest } = c.expected;
      expect(parsed).toMatchObject(rest);
      if (issues) expect(issueCodes(parsed!.issues)).toEqual(issues);
    });
  }
});

describe('properties fixtures: matrix', () => {
  for (const c of fixtures.matrix as unknown as MatrixCase[]) {
    it(c.name, () => {
      const config = parseMatrix(c.path, c.frontmatter, c.language as Language);
      expect(config.quadrants).toEqual(c.expected.quadrants);
      expect(issueCodes(config.issues)).toEqual(c.expected.issues);
      expect(config.byKey.someday).toEqual(config.quadrants[3]);
      expect(config.path).toBe(c.path);
    });
  }
});

describe('properties fixtures: marker', () => {
  for (const c of fixtures.marker as unknown as MarkerCase[]) {
    it(c.name, () => {
      expect(parseMarker(c.frontmatter)).toMatchObject(c.expected);
    });
  }

  it('old schema needs migration, below minimum is invalid', () => {
    const fm = { root: 'Планировщик', schema: 2, vault_id: 'v' };
    expect(parseMarker(fm, { current: 3, minSupported: 2 }).status).toBe('needs-migration');
    expect(parseMarker({ ...fm, schema: 1 }, { current: 3, minSupported: 2 }).status).toBe('invalid');
  });
});

describe('unknown properties are preserved', () => {
  it('patch after completion keeps unknown keys and their order', () => {
    const frontmatter: FrontmatterRecord = {
      type: 'task',
      id: '01JA7Q3K8Z6Y2V5N4M0C1B2D3E',
      quadrant: 'do',
      due: '2026-10-10',
      repeat: 'daily',
      tags: ['work', 'health'],
      'custom field': { nested: true },
      done: false,
      completions: [],
    };
    const task = parsePlannerNote({
      path: 'Планировщик/Задачи/Зарядка.md',
      title: 'Зарядка',
      mtime: 1,
      frontmatter,
      archived: false,
      deletedInCalendar: false,
    }) as Task;
    expect(task.extra).toEqual({ tags: ['work', 'health'], 'custom field': { nested: true } });

    const outcome = planComplete(task.props, { now: { date: '2026-10-10', time: '09:00' } });
    if (outcome.kind !== 'change') throw new Error('expected change');
    const copy = structuredClone(frontmatter);
    applyFrontmatterPatch(copy, outcome.patch);

    expect(copy.tags).toEqual(['work', 'health']);
    expect(copy['custom field']).toEqual({ nested: true });
    expect(copy.completions).toEqual(['2026-10-10']);
    expect(copy.due).toBe('2026-10-11');
    expect(Object.keys(copy).slice(0, Object.keys(frontmatter).length)).toEqual(Object.keys(frontmatter));
    expect(copy.repeat_anchor).toBe('2026-10-10');
  });

  it('invalid note keeps the whole frontmatter', () => {
    const fm = { type: 'task', quadrant: 'do', foo: 'bar' };
    const parsed = parsePlannerNote({ path: 'a.md', title: 'a', mtime: 1, frontmatter: fm, archived: false, deletedInCalendar: false });
    expect(parsed).toMatchObject({ kind: 'invalid', frontmatter: fm });
  });
});

describe('item id', () => {
  const input = (id: unknown) => ({
    path: 'a.md',
    title: 'a',
    mtime: 1,
    frontmatter: { type: 'task', id, quadrant: 'do' },
    archived: false,
    deletedInCalendar: false,
  });

  it('lowercase ULID is canonicalized to uppercase without issues', () => {
    const parsed = parsePlannerNote(input(' 01ja7q3k8z6y2v5n4m0c1b2d3e '));
    expect(parsed).toMatchObject({ kind: 'task', id: '01JA7Q3K8Z6Y2V5N4M0C1B2D3E' });
    expect(parsed && parsed.kind === 'task' ? issueCodes(parsed.issues) : null).toEqual([]);
  });

  it('non-ULID id is an issue, the note is kept', () => {
    const parsed = parsePlannerNote(input('my-task'));
    expect(parsed).toMatchObject({ kind: 'task', id: 'my-task' });
    expect(parsed && parsed.kind === 'task' ? issueCodes(parsed.issues) : null).toEqual([{ property: 'id', code: 'invalid-value' }]);
  });
});

describe('serialization and helpers', () => {
  it('writes task properties in specification order', () => {
    const fm = taskToFrontmatter({
      type: 'task',
      id: 'ID',
      quadrant: 'plan',
      due: '2026-10-11T09:00',
      repeat: 'none',
      repeat_anchor: null,
      remind: 'at',
      priority: 'high',
      duration: null,
      done: false,
      completed: null,
      completions: [],
      created: '2026-10-10T13:20',
    });
    expect(Object.keys(fm)).toEqual([
      'type', 'id', 'quadrant', 'due', 'repeat', 'repeat_anchor', 'remind', 'priority', 'done', 'completed', 'completions', 'created',
    ]);
  });

  it('accepts Date values from YAML timestamps', () => {
    const parsed = parsePlannerNote({
      path: 'x.md',
      title: 'x',
      mtime: 1,
      frontmatter: { type: 'task', id: 'ID', quadrant: 'do', due: new Date(Date.UTC(2026, 9, 11, 9, 0)) },
      archived: true,
      deletedInCalendar: false,
    }) as Task;
    expect(parsed.due).toEqual({ date: '2026-10-11', time: '09:00' });
    expect(parsed.archived).toBe(true);
  });

  it('normalizes hex colors', () => {
    expect(normalizeHexColor('#abc')).toBe('#AABBCC');
    expect(normalizeHexColor('#e5484d')).toBe('#E5484D');
    expect(normalizeHexColor('red')).toBeNull();
  });

  it('parser contract uses the configured language for matrix defaults', () => {
    const parser = createPlannerNoteParser({ language: () => 'en' });
    expect(parser.parseMatrix(null, null).byKey.do.title).toBe('Important and urgent');
    expect(parser.parse({ path: 'n.md', title: 'n', mtime: 1, frontmatter: null, archived: false, deletedInCalendar: false })).toBeNull();
  });
});
