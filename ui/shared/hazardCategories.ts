import type { HazardCategory } from './api/types';

// Plain emoji, not a custom icon set -- both apps already render whatever
// the platform gives them for text (no bundled icon font shared between
// them the way styles.css's icon-nav SVGs are desktop-only), and emoji
// render consistently enough across web/iOS/Android for a small
// at-a-glance marker like this. Keep in sync with roadSignals.js's
// HAZARD_CATEGORIES by hand -- same reasoning as api/types.ts already
// mirroring that module's shapes.
export const HAZARD_CATEGORY_ICONS: Record<HazardCategory, string> = {
  hazmat: '🧪',
  accident: '🚨',
  construction: '🚧',
  closure: '⛔',
  congestion: '🚗',
  obstruction: '⚠️',
  weather: '🌧️',
  other: '⚠️',
};

export const HAZARD_CATEGORY_LABELS: Record<HazardCategory, string> = {
  hazmat: 'Hazardous material',
  accident: 'Accident',
  construction: 'Construction',
  closure: 'Closure',
  congestion: 'Congestion',
  obstruction: 'Obstruction',
  weather: 'Weather',
  other: 'Hazard',
};
