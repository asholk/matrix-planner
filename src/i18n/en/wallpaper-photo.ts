import type { Dictionary } from '../index';

/** Uploading a wallpaper background from Photos (iOS) or from disk. Module `wallpaperPhoto`. */
export const enWallpaperPhoto = {
  pick: 'Choose from Photos',
  pickDesktop: 'Upload photo',
  pickHint: 'The photo is saved to the {folder} folder',
  loading: 'Loading photo…',
  loaded: 'Photo uploaded',
  heic: 'The photo is in HEIC/HEIF format, which this device can’t open. On iPhone, set Settings → Camera → Formats → Most Compatible, or choose the photo through Files.',
  unsupported: 'The {format} format isn’t supported. Choose a JPEG, PNG, or WebP photo.',
  notImage: 'This isn’t a photo, or its format isn’t supported. Choose a JPEG, PNG, or WebP.',
  empty: 'The file is empty. Choose another photo.',
  corrupt: 'The {format} file is damaged and can’t be opened. Choose another photo.',
  tooSmall: 'The photo is smaller than the screen ({width} × {height}, at least {needWidth} × {needHeight} needed) and will look blurry.',
  useAnyway: 'Use anyway',
  chooseOther: 'Choose another',
  tooLarge: 'The photo is too large ({megapixels} MP): there wasn’t enough memory to shrink it. Choose a smaller photo or take a screenshot of it.',
  encodeFailed: 'Couldn’t prepare the photo: {reason}',
  readOnly: 'The vault is read-only. The photo wasn’t saved',
  writeFailed: 'Couldn’t save the photo: {reason}',
} satisfies Dictionary;
