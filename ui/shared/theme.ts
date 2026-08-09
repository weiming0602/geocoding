// Plain-data mirror of the Meridian design handoff's styles.css tokens
// (:root custom properties). ui/desktop uses styles.css directly (the
// idiomatic web approach, and the handoff's own stated source of truth);
// this file exists because React Native's StyleSheet can't consume CSS
// custom properties at all, so ui/mobile needs the same values as plain
// JS. Safe to share (unlike the map helpers) since it has zero
// dependencies -- just strings and numbers, no class-identity issue.
//
// Keep in sync with ui/desktop/src/styles.css by hand -- there is no
// build step generating one from the other.

export const colors = {
  bg: '#f3f2f2',
  surface: '#eae9e9',
  text: '#201f1d',
  accent: '#b68235',
  // Deep teal/verdigris -- a genuinely different hue from accent, not
  // another shade of brown, for real two-color contrast.
  accent2: '#3a7d68',
  divider: 'rgba(32, 31, 29, 0.16)',

  neutral100: '#f8f4f4',
  neutral200: '#eae7e7',
  neutral300: '#d7d3d3',
  neutral400: '#bab6b6',
  neutral500: '#9b9797',
  neutral600: '#7d7979',
  neutral700: '#605d5d',
  neutral800: '#444141',
  neutral900: '#2d2b2b',

  accent100: '#fff3e4',
  accent200: '#ffe3bf',
  accent300: '#facb8d',
  accent400: '#e1ad66',
  accent500: '#c28d41',
  accent600: '#a06f24',
  accent700: '#7d5411',
  accent800: '#5a3b0a',
  accent900: '#3a270d',

  errorText: '#a4402a',
} as const;

// Font family names as registered with expo-font / useFonts in App.tsx --
// must match exactly. Falls back to the platform default if fonts
// haven't loaded yet (e.g. first paint).
export const fonts = {
  heading: 'CormorantGaramond_600SemiBold',
  headingFallback: 'System',
  body: 'Lora_400Regular',
  bodyFallback: 'System',
} as const;

// styles.css's --space-* values (px), pre-rounded.
export const space = {
  1: 5,
  2: 9,
  3: 14,
  4: 18,
  6: 28,
  8: 37,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 18,
} as const;
