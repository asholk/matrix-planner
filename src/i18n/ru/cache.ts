import type { Dictionary } from '../index';

/** Строки календарного кэша и служебных JSON компаньона. */
export const ruCache = {
  notice: {
    noCache: 'Подключите компаньон, чтобы видеть события «Календаря» iOS',
    outOfRange: 'События «Календаря» iOS за этот период не загружены',
    corrupt: 'Не удалось прочитать события «Календаря» iOS: файл «_system/calendar-cache.json» повреждён',
    unsupportedVersion: 'События «Календаря» iOS записаны более новой версией компаньона. Обновите плагин',
    stale: 'События «Календаря» iOS давно не обновлялись. Последнее обновление: {value}',
  },
  errors: {
    tombstonesCorrupt: 'Файл «_system/tombstones.json» повреждён. Метка удаления не записана',
    tombstonesNewer: 'Файл «_system/tombstones.json» записан более новой версией компаньона. Обновите плагин',
    companionCorrupt: 'Файл «_system/companion.json» повреждён. Статус обоев не записан',
    companionNewer: 'Файл «_system/companion.json» записан более новой версией компаньона. Обновите плагин',
  },
} satisfies Dictionary;
