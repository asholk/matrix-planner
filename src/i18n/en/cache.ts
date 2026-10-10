import type { Dictionary } from '../index';

/** Calendar cache and companion system JSON strings. */
export const enCache = {
  notice: {
    noCache: 'Connect the companion to see iOS Calendar events',
    outOfRange: 'iOS Calendar events for this period aren’t loaded',
    corrupt: 'Couldn’t read iOS Calendar events: the “_system/calendar-cache.json” file is damaged',
    unsupportedVersion: 'iOS Calendar events were saved by a newer companion version. Update the plugin',
    stale: 'iOS Calendar events haven’t been updated for a while. Last update: {value}',
  },
  errors: {
    tombstonesCorrupt: 'The “_system/tombstones.json” file is damaged. The deletion mark wasn’t saved',
    tombstonesNewer: 'The “_system/tombstones.json” file was saved by a newer companion version. Update the plugin',
    companionCorrupt: 'The “_system/companion.json” file is damaged. The wallpaper status wasn’t saved',
    companionNewer: 'The “_system/companion.json” file was saved by a newer companion version. Update the plugin',
  },
} satisfies Dictionary;
