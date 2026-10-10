import type { Dictionary } from '../index';

/** Wallpaper rendering and saving messages (module `wallpaperRender`, S2.T7). */
export const enWallpaperRender = {
  errors: {
    render: 'Couldn’t draw the wallpaper for {date}',
    write: 'Couldn’t save the file {path}',
    nothingSaved: 'Couldn’t save the wallpaper',
  },
} satisfies Dictionary;
