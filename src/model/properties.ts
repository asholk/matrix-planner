/**
 * Разбор и валидация свойств заметок Планировщика (ТЗ §3.1–3.6, §3.9).
 *
 * Правила:
 * - заметка относится к Планировщику только при `type: task|event|note`;
 * - без обязательных свойств (`id`; у задачи — `quadrant`; у события — `start`)
 *   получается `InvalidPlannerNote` (раздел «Требуют внимания»);
 * - прочие невалидные значения заменяются значениями по умолчанию, проблема пишется в `issues`;
 * - неизвестные свойства попадают в `extra` и при записи не трогаются:
 *   изменения применяются точечно (`applyFrontmatterPatch`) поверх исходного frontmatter.
 */

import type { PlannerNoteParser } from '../app/contracts';
import {
  EVENT_COLORS,
  ITEM_KINDS,
  MIN_SUPPORTED_SCHEMA,
  PRIORITIES,
  QUADRANT_KEYS,
  REMIND_OFFSETS,
  REPEAT_RULES,
  SCHEMA_VERSION,
  type EventProperties,
  type FloatingDateTime,
  type FrontmatterRecord,
  type InvalidPlannerNote,
  type ItemKind,
  type Language,
  type MarkerProperties,
  type MarkerState,
  type MatrixConfig,
  type NoteProperties,
  type ParsedNote,
  type PlannerEvent,
  type PropertyIssue,
  type QuadrantConfig,
  type QuadrantKey,
  type QuickNote,
  type Task,
  type TaskProperties,
  type VaultPath,
} from './types';
import { addDays, addMinutes, compareFloating, formatFloating, isValidTimeZone, parseFloating } from './dates';
import { buildMatrixConfig, defaultQuadrant, EVENT_DEFAULTS, TASK_DEFAULTS } from './defaults';

// ---------------------------------------------------------------------------
// Известные свойства
// ---------------------------------------------------------------------------

/** Порядок ключей при создании заметки (совпадает с примерами ТЗ). */
export const TASK_KEYS = [
  'type',
  'id',
  'quadrant',
  'due',
  'repeat',
  'repeat_anchor',
  'remind',
  'priority',
  'done',
  'completed',
  'completions',
  'created',
] as const satisfies readonly (keyof TaskProperties)[];

export const EVENT_KEYS = [
  'type',
  'id',
  'start',
  'end',
  'all_day',
  'tz',
  'repeat',
  'color',
  'icon',
  'calendar_id',
  'url',
] as const satisfies readonly (keyof EventProperties)[];

export const NOTE_KEYS = ['type', 'id', 'date'] as const satisfies readonly (keyof NoteProperties)[];

export const MARKER_KEYS = ['root', 'schema', 'vault_id', 'migrating'] as const satisfies readonly (keyof MarkerProperties)[];

const KNOWN_KEYS: Record<ItemKind, ReadonlySet<string>> = {
  task: new Set(TASK_KEYS),
  event: new Set(EVENT_KEYS),
  note: new Set(NOTE_KEYS),
};

// ---------------------------------------------------------------------------
// Чтение отдельных значений
// ---------------------------------------------------------------------------

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

class Reader {
  readonly issues: PropertyIssue[] = [];

  constructor(private readonly fm: FrontmatterRecord) {}

  has(key: string): boolean {
    return !isEmpty(this.fm[key]);
  }

  raw(key: string): unknown {
    return this.fm[key];
  }

  issue(property: string, code: PropertyIssue['code'], value?: unknown): void {
    const entry: PropertyIssue = { property, code };
    if (value !== undefined) entry.value = value;
    this.issues.push(entry);
  }

  /** Значение из набора; пусто — `fallback` без проблемы. */
  enumValue<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const value = this.fm[key];
    if (isEmpty(value)) return fallback;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if ((allowed as readonly string[]).includes(normalized)) return normalized as T;
      this.issue(key, 'invalid-value', value);
    } else {
      this.issue(key, 'invalid-type', value);
    }
    return fallback;
  }

  bool(key: string, fallback: boolean): boolean {
    const value = this.fm[key];
    if (isEmpty(value)) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    this.issue(key, 'invalid-type', value);
    return fallback;
  }

  floating(key: string): FloatingDateTime | null {
    const value = this.fm[key];
    if (isEmpty(value)) return null;
    const parsed = parseFloating(value);
    if (!parsed) this.issue(key, 'invalid-date', value);
    return parsed;
  }

  date(key: string): string | null {
    return this.floating(key)?.date ?? null;
  }

  /** Строка или `null`; числа приводятся к строке. */
  string(key: string): string | null {
    const value = this.fm[key];
    if (isEmpty(value)) return null;
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    this.issue(key, 'invalid-type', value);
    return null;
  }

  /** Обязательный ID: непустая строка. */
  id(): string | null {
    const value = this.fm.id;
    if (isEmpty(value)) {
      this.issue('id', 'missing');
      return null;
    }
    if (typeof value !== 'string') {
      this.issue('id', 'invalid-type', value);
      return null;
    }
    return value.trim();
  }

  /** Список дат: уникальные, по возрастанию; невалидные элементы отбрасываются с проблемой. */
  dateList(key: string): string[] {
    const value = this.fm[key];
    if (isEmpty(value)) return [];
    const items: unknown[] = Array.isArray(value) ? value : [value];
    if (!Array.isArray(value)) this.issue(key, 'invalid-type', value);
    const result = new Set<string>();
    for (const item of items) {
      if (isEmpty(item)) continue;
      const parsed = parseFloating(item);
      if (parsed) result.add(parsed.date);
      else this.issue(key, 'invalid-date', item);
    }
    return [...result].sort();
  }
}

/** Свойство `type` → вид заметки; `null` — не заметка Планировщика. */
export function detectItemKind(frontmatter: FrontmatterRecord | null | undefined): ItemKind | null {
  const value = frontmatter?.type;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return (ITEM_KINDS as readonly string[]).includes(normalized) ? (normalized as ItemKind) : null;
}

/** Неизвестные свойства для вида заметки (копия). */
export function extractExtra(kind: ItemKind, frontmatter: FrontmatterRecord): FrontmatterRecord {
  const known = KNOWN_KEYS[kind];
  const extra: FrontmatterRecord = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!known.has(key)) extra[key] = value;
  }
  return extra;
}

// ---------------------------------------------------------------------------
// Разбор заметок
// ---------------------------------------------------------------------------

export interface ParseNoteInput {
  path: VaultPath;
  title: string;
  mtime: number;
  frontmatter: FrontmatterRecord | null;
  /** Заметка лежит в архиве задач. */
  archived: boolean;
  /** Заметка лежит в `События/Удалённые/`. */
  deletedInCalendar: boolean;
}

function invalidNote(input: ParseNoteInput, kind: ItemKind, issues: PropertyIssue[]): InvalidPlannerNote {
  return {
    kind: 'invalid',
    path: input.path,
    title: input.title,
    mtime: input.mtime,
    declaredType: kind,
    frontmatter: { ...(input.frontmatter ?? {}) },
    issues,
  };
}

export function parseTask(input: ParseNoteInput): Task | InvalidPlannerNote {
  const fm = input.frontmatter ?? {};
  const r = new Reader(fm);
  const id = r.id();
  let quadrant: QuadrantKey | null = null;
  if (!r.has('quadrant')) r.issue('quadrant', 'missing');
  else {
    const value = r.enumValue<QuadrantKey | ''>('quadrant', QUADRANT_KEYS, '');
    if (value !== '') quadrant = value;
  }
  if (id === null || quadrant === null) return invalidNote(input, 'task', r.issues);

  const due = r.floating('due');
  let repeat = r.enumValue('repeat', REPEAT_RULES, TASK_DEFAULTS.repeat);
  if (repeat !== 'none' && due === null) {
    // Повтор без срока не работает: считаем задачу неповторяющейся.
    r.issue('repeat', 'inconsistent', fm.repeat);
    repeat = 'none';
  }
  const anchor = r.date('repeat_anchor');
  const remind = r.enumValue('remind', REMIND_OFFSETS, TASK_DEFAULTS.remind);
  const priority = r.enumValue('priority', PRIORITIES, TASK_DEFAULTS.priority);
  const done = r.bool('done', false);
  const completedValue = r.floating('completed');
  const completions = r.dateList('completions');
  const createdValue = r.floating('created');

  const props: TaskProperties = {
    type: 'task',
    id,
    quadrant,
    due: due ? formatFloating(due) : null,
    repeat,
    repeat_anchor: anchor,
    remind,
    priority,
    done,
    completed: completedValue ? formatFloating(completedValue) : null,
    completions,
    created: createdValue ? formatFloating(createdValue) : null,
  };

  return {
    kind: 'task',
    id,
    path: input.path,
    title: input.title,
    mtime: input.mtime,
    props,
    extra: extractExtra('task', fm),
    issues: r.issues,
    quadrant,
    due,
    repeat,
    repeatAnchor: anchor ?? due?.date ?? null,
    remind,
    priority,
    done: repeat === 'none' ? done : false,
    completed: props.completed,
    completions,
    created: props.created,
    archived: input.archived,
  };
}

export function parseEvent(input: ParseNoteInput): PlannerEvent | InvalidPlannerNote {
  const fm = input.frontmatter ?? {};
  const r = new Reader(fm);
  const id = r.id();
  let parsedStart: FloatingDateTime | null = null;
  if (r.has('start')) parsedStart = r.floating('start');
  else r.issue('start', 'missing');
  if (id === null || parsedStart === null) return invalidNote(input, 'event', r.issues);

  let allDay = r.bool('all_day', false);
  if (!allDay && parsedStart.time === null) {
    // Дата без времени у обычного события — показываем как событие на весь день.
    r.issue('all_day', 'inconsistent', fm.all_day);
    allDay = true;
  }
  const start: FloatingDateTime = allDay ? { date: parsedStart.date, time: null } : parsedStart;

  const defaultEnd = (): FloatingDateTime =>
    allDay ? { date: addDays(start.date, 1), time: null } : addMinutes(start, EVENT_DEFAULTS.durationMinutes);
  let end: FloatingDateTime;
  if (!r.has('end')) {
    r.issue('end', 'missing');
    end = defaultEnd();
  } else {
    const parsed = r.floating('end');
    if (!parsed) end = defaultEnd();
    else if (allDay) {
      end = { date: parsed.date, time: null };
      if (end.date <= start.date) {
        r.issue('end', 'inconsistent', fm.end);
        end = defaultEnd();
      }
    } else if (parsed.time === null || compareFloating(parsed, start) < 0) {
      r.issue('end', 'inconsistent', fm.end);
      end = defaultEnd();
    } else {
      end = parsed;
    }
  }

  let tz = r.string('tz');
  if (tz !== null && !isValidTimeZone(tz)) {
    r.issue('tz', 'invalid-value', fm.tz);
    tz = null;
  }
  const repeat = r.enumValue('repeat', REPEAT_RULES, EVENT_DEFAULTS.repeat);
  const color = r.enumValue('color', EVENT_COLORS, EVENT_DEFAULTS.color);
  const icon = r.string('icon');
  const calendarId = r.string('calendar_id');
  const url = r.string('url');

  const props: EventProperties = {
    type: 'event',
    id,
    start: formatFloating(start),
    end: formatFloating(end),
    all_day: allDay,
    tz,
    repeat,
    color,
    icon,
    calendar_id: calendarId,
    url,
  };

  return {
    kind: 'event',
    id,
    path: input.path,
    title: input.title,
    mtime: input.mtime,
    props,
    extra: extractExtra('event', fm),
    issues: r.issues,
    start,
    end,
    allDay,
    tz,
    repeat,
    color,
    icon,
    calendarId,
    url,
    deletedInCalendar: input.deletedInCalendar,
  };
}

export function parseQuickNote(input: ParseNoteInput): QuickNote | InvalidPlannerNote {
  const fm = input.frontmatter ?? {};
  const r = new Reader(fm);
  const id = r.id();
  if (id === null) return invalidNote(input, 'note', r.issues);
  const date = r.date('date');
  return {
    kind: 'note',
    id,
    path: input.path,
    title: input.title,
    mtime: input.mtime,
    props: { type: 'note', id, date },
    extra: extractExtra('note', fm),
    issues: r.issues,
    date,
  };
}

/** `null` — заметка не относится к Планировщику. */
export function parsePlannerNote(input: ParseNoteInput): ParsedNote | null {
  const kind = detectItemKind(input.frontmatter);
  switch (kind) {
    case 'task':
      return parseTask(input);
    case 'event':
      return parseEvent(input);
    case 'note':
      return parseQuickNote(input);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Матрица (ТЗ §3.6)
// ---------------------------------------------------------------------------

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#abc` → `#AABBCC`; `null` — не цвет. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_RE.test(trimmed)) return null;
  const hex = trimmed.slice(1);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return `#${full.toUpperCase()}`;
}

/**
 * Свойство `quadrants` из `Матрица.md`. Всегда 4 квадранта: отсутствующие или
 * невалидные поля берутся по умолчанию (`language` — для названий по умолчанию).
 */
export function parseMatrix(path: VaultPath | null, frontmatter: FrontmatterRecord | null, language: Language = 'ru'): MatrixConfig {
  const issues: PropertyIssue[] = [];
  const found = new Map<QuadrantKey, QuadrantConfig>();
  const raw = frontmatter?.quadrants;

  if (path !== null && (raw === undefined || raw === null)) issues.push({ property: 'quadrants', code: 'missing' });
  else if (raw !== undefined && raw !== null && !Array.isArray(raw)) issues.push({ property: 'quadrants', code: 'invalid-type', value: raw });

  if (Array.isArray(raw)) {
    raw.forEach((entry: unknown, index) => {
      const prop = `quadrants[${index}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        issues.push({ property: prop, code: 'invalid-type', value: entry });
        return;
      }
      const record = entry as Record<string, unknown>;
      const keyValue = typeof record.key === 'string' ? record.key.trim().toLowerCase() : record.key;
      if (!(QUADRANT_KEYS as readonly unknown[]).includes(keyValue)) {
        issues.push({ property: `${prop}.key`, code: 'invalid-value', value: record.key });
        return;
      }
      const key = keyValue as QuadrantKey;
      if (found.has(key)) {
        issues.push({ property: `${prop}.key`, code: 'inconsistent', value: record.key });
        return;
      }
      const fallback = defaultQuadrant(key, language);
      let title = fallback.title;
      if (typeof record.title === 'string' && record.title.trim() !== '') title = record.title.trim();
      else if (!isEmpty(record.title)) issues.push({ property: `${prop}.title`, code: 'invalid-type', value: record.title });
      let color = fallback.color;
      if (!isEmpty(record.color)) {
        const normalized = normalizeHexColor(record.color);
        if (normalized) color = normalized;
        else issues.push({ property: `${prop}.color`, code: 'invalid-value', value: record.color });
      }
      let icon = fallback.icon;
      if (typeof record.icon === 'string' && record.icon.trim() !== '') icon = record.icon.trim();
      else if (!isEmpty(record.icon)) issues.push({ property: `${prop}.icon`, code: 'invalid-type', value: record.icon });
      found.set(key, { key, title, color, icon });
    });
    for (const key of QUADRANT_KEYS) {
      if (!found.has(key)) issues.push({ property: `quadrants.${key}`, code: 'missing' });
    }
  }

  return buildMatrixConfig(
    path,
    QUADRANT_KEYS.map((key) => found.get(key) ?? defaultQuadrant(key, language)),
    issues,
  );
}

// ---------------------------------------------------------------------------
// Маркер и схема (ТЗ §3.1, §3.9)
// ---------------------------------------------------------------------------

export interface SchemaRange {
  current: number;
  minSupported: number;
}

export const PLUGIN_SCHEMA_RANGE: SchemaRange = { current: SCHEMA_VERSION, minSupported: MIN_SUPPORTED_SCHEMA };

/**
 * Свойства маркера → состояние схемы:
 * схема новее — `newer`; старше поддерживаемой или повреждена — `invalid`;
 * старше текущей — `needs-migration`; флаг `migrating` — `migrating`.
 */
export function parseMarker(frontmatter: FrontmatterRecord | null, range: SchemaRange = PLUGIN_SCHEMA_RANGE): MarkerState {
  if (!frontmatter) return { status: 'invalid', marker: null, issues: [{ property: 'schema', code: 'missing' }] };
  const r = new Reader(frontmatter);
  const root = typeof frontmatter.root === 'string' ? frontmatter.root.trim() : null;
  if (root === null) r.issue('root', isEmpty(frontmatter.root) ? 'missing' : 'invalid-type', frontmatter.root);

  let schema: number | null = null;
  const rawSchema = frontmatter.schema;
  if (isEmpty(rawSchema)) r.issue('schema', 'missing');
  else {
    const n = typeof rawSchema === 'string' ? Number(rawSchema.trim()) : rawSchema;
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) schema = n;
    else r.issue('schema', 'invalid-value', rawSchema);
  }

  const vaultId = r.string('vault_id');
  if (vaultId === null && !r.has('vault_id')) r.issue('vault_id', 'missing');
  const migrating = r.bool('migrating', false);

  if (schema === null || root === null) return { status: 'invalid', marker: null, issues: r.issues };
  const marker: MarkerProperties = { root, schema, vault_id: vaultId ?? '', migrating };

  let status: MarkerState['status'];
  if (schema > range.current) status = 'newer';
  else if (schema < range.minSupported) status = 'invalid';
  else if (migrating) status = 'migrating';
  else if (schema < range.current) status = 'needs-migration';
  else status = 'ok';
  return { status, marker, issues: r.issues };
}

// ---------------------------------------------------------------------------
// Запись свойств
// ---------------------------------------------------------------------------

function ordered<T extends object>(props: T, keys: readonly (keyof T)[]): FrontmatterRecord {
  const out: FrontmatterRecord = {};
  for (const key of keys) {
    const value = props[key];
    out[key as string] = Array.isArray(value) ? [...(value as unknown[])] : value;
  }
  return out;
}

/** Свойства новой задачи в порядке ТЗ. */
export function taskToFrontmatter(props: TaskProperties): FrontmatterRecord {
  return ordered(props, TASK_KEYS);
}

export function eventToFrontmatter(props: EventProperties): FrontmatterRecord {
  return ordered(props, EVENT_KEYS);
}

export function noteToFrontmatter(props: NoteProperties): FrontmatterRecord {
  return ordered(props, NOTE_KEYS);
}

export function markerToFrontmatter(props: MarkerProperties): FrontmatterRecord {
  return ordered(props, MARKER_KEYS);
}

export function matrixToFrontmatter(quadrants: readonly QuadrantConfig[]): FrontmatterRecord {
  return { quadrants: quadrants.map((q) => ({ key: q.key, title: q.title, color: q.color, icon: q.icon })) };
}

/**
 * Точечно применяет изменения к frontmatter (например, внутри `processFrontMatter`).
 * Ключи со значением `undefined` пропускаются; остальные свойства, включая неизвестные, не меняются.
 */
export function applyFrontmatterPatch<P extends object>(frontmatter: FrontmatterRecord, patch: Partial<P>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    frontmatter[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
  }
}

// ---------------------------------------------------------------------------
// Реализация контракта PlannerNoteParser
// ---------------------------------------------------------------------------

export interface PlannerNoteParserOptions {
  /** Язык названий квадрантов по умолчанию (`Матрица.md` отсутствует или неполна). */
  language?: () => Language;
}

export function createPlannerNoteParser(options: PlannerNoteParserOptions = {}): PlannerNoteParser {
  return {
    parse: (input) => parsePlannerNote(input),
    parseMatrix: (path, frontmatter) => parseMatrix(path, frontmatter, options.language?.() ?? 'ru'),
  };
}
