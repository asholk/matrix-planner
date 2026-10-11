import type { Dictionary } from '../index';

/** Uploading a wallpaper background from Photos (iOS) or from disk. Module `wallpaperPhoto`. */
export const enWallpaperPhoto = {
  /** Button in the Background section on phones and tablets. */
  pick: 'Choose from Photos',
  /** The same button on desktop. */
  pickDesktop: 'Upload photo',
  pickHint: 'The photo is saved to the {folder} folder',
  loading: 'Loading photo…',
  decodeFailed: "Couldn't open the photo. Choose a JPEG or PNG",
  encodeFailed: "Couldn't prepare the photo. Try another photo",
  readOnly: 'The vault is read-only. The photo wasn\'t saved',
  writeFailed: "Couldn't save the photo: {reason}",
} satisfies Dictionary;
