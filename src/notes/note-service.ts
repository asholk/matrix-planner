/**
 * Операции быстрых заметок (ТЗ §3.5, §4.3): создание в `Заметки/`, правка названия,
 * текста и даты, удаление в корзину. `create` возвращает путь — форма открывает
 * созданную заметку в редакторе.
 */

import type { IdGenerator, NoteIndex, NoteRepository, NoteService } from '../app/contracts';
import type { ItemId, NoteDraft, NoteProperties, OpResult, ParsedNote, QuickNote, VaultPath } from '../model/types';
import { isValidDate } from '../model/dates';
import { applyFrontmatterPatch, noteToFrontmatter, parseQuickNote } from '../model/properties';
import { errorResult, okResult } from '../storage/note-repository';
import { registerDictionary } from '../i18n';
import { ruNotes } from '../i18n/ru/notes';
import { enNotes } from '../i18n/en/notes';

export function registerNoteDictionaries(): void {
  registerDictionary('ru', 'notes', ruNotes);
  registerDictionary('en', 'notes', enNotes);
}
registerNoteDictionaries();

export interface NoteServiceDeps {
  repository: NoteRepository;
  index: NoteIndex;
  ids: IdGenerator;
  /** Сколько ждать обновления индекса после записи (мс). */
  waitTimeoutMs?: number;
}

const DEFAULT_WAIT_MS = 2000;

/** Имя невалидного поля или `null`. */
export function invalidNoteField(patch: Partial<NoteDraft>, requireTitle: boolean): keyof NoteDraft | null {
  if (patch.title !== undefined || requireTitle) {
    if (typeof patch.title !== 'string' || patch.title.trim() === '') return 'title';
  }
  if (patch.body !== undefined && typeof patch.body !== 'string') return 'body';
  if (patch.date !== undefined && patch.date !== null && !isValidDate(patch.date)) return 'date';
  return null;
}

function noteMatches(id: ItemId, date?: string | null) {
  return (item: ParsedNote): boolean =>
    item.kind === 'note' && item.id === id && (date === undefined || item.props.date === date);
}

export class VaultNoteService implements NoteService {
  constructor(private readonly deps: NoteServiceDeps) {}

  async create(draft: NoteDraft): Promise<OpResult<VaultPath>> {
    const invalid = invalidNoteField(draft, true);
    if (invalid) return errorResult('invalid', invalid);
    const id = this.deps.ids.next();
    const props: NoteProperties = { type: 'note', id, date: draft.date ?? null };
    const created = await this.deps.repository.create({
      folder: this.deps.repository.paths.notes,
      title: draft.title.trim(),
      frontmatter: noteToFrontmatter(props),
      body: draft.body ?? '',
    });
    if (!created.ok) return created;
    // Заметка открывается в редакторе сразу; индекс догонит по событию `changed`.
    await this.wait(created.value, noteMatches(id));
    return okResult(created.value, true);
  }

  async update(id: ItemId, patch: Partial<NoteDraft>): Promise<OpResult> {
    const invalid = invalidNoteField(patch, false);
    if (invalid) return errorResult('invalid', invalid);
    const found = this.find(id);
    if (!found.ok) return found;
    const note = found.value;
    let path = note.path;
    let changed = false;

    if (patch.date !== undefined) {
      const date = patch.date;
      const box: { mismatch: boolean | null } = { mismatch: null };
      const result = await this.deps.repository.updateFrontmatter(path, (frontmatter) => {
        const current = parseQuickNote({ path, title: note.title, mtime: note.mtime, frontmatter, archived: false, deletedInCalendar: false });
        box.mismatch = current.kind !== 'note' || current.id !== id;
        if (!box.mismatch) applyFrontmatterPatch<NoteProperties>(frontmatter, { date });
      });
      if (!result.ok) return result;
      if (box.mismatch === null) return errorResult('unknown', 'frontmatter callback was not called');
      if (box.mismatch) return errorResult('stale', 'id-mismatch');
      changed = result.changed;
    }

    if (patch.body !== undefined) {
      const body = patch.body;
      const result = await this.deps.repository.updateBody(path, () => body);
      if (!result.ok) return result;
      changed = changed || result.changed;
    }

    const title = patch.title?.trim();
    if (title !== undefined && title !== note.title) {
      const renamed = await this.deps.repository.rename(path, title);
      if (!renamed.ok) return renamed;
      path = renamed.value;
      changed = changed || renamed.changed;
    }

    if (changed) await this.wait(path, noteMatches(id, patch.date));
    return okResult(undefined, changed);
  }

  async delete(id: ItemId): Promise<OpResult> {
    const found = this.find(id);
    if (!found.ok) return found;
    return this.deps.repository.trash(found.value.path);
  }

  private find(id: ItemId): OpResult<QuickNote> {
    if (!this.deps.index.isReady()) return errorResult('not-ready');
    const item = this.deps.index.getById(id);
    if (!item || item.kind !== 'note') return errorResult('not-found', id, undefined, 'notes.errors.notFound');
    return okResult(item, false);
  }

  private async wait(path: VaultPath, predicate: (item: ParsedNote) => boolean): Promise<ParsedNote | null> {
    const item = await this.deps.index.waitFor(path, predicate, this.deps.waitTimeoutMs ?? DEFAULT_WAIT_MS);
    return item && predicate(item) ? item : null;
  }
}
