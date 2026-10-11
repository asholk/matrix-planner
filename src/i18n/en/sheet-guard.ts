import type { Dictionary } from '../index';

/** Unsaved form guard (update 006, §6): "Discard changes?". */
export const enSheetGuard = {
  title: 'Discard changes?',
  desc: 'Your changes in this form aren’t saved.',
  discard: 'Discard',
  keep: 'Keep editing',
} satisfies Dictionary;
