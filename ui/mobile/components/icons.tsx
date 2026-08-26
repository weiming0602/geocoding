import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

// Ported 1:1 from ui/desktop/src/components/icons.tsx -- same path data,
// same 24x24 viewBox/stroke style, so mobile's menu icons match desktop's
// exactly rather than introducing a second, different-looking icon set.
// Kept as its own file (not shared via ui/shared) for the same reason
// maplibre-gl map code stays duplicated per-app: react-native-svg's
// <Svg>/<Path> aren't DOM SVG elements, so there's nothing to share
// beyond the path coordinates themselves.
export type IconName =
  | 'overview'
  | 'geocode'
  | 'reverseGeocode'
  | 'findPlaces'
  | 'roadAlerts'
  | 'importAddresses'
  | 'batch'
  | 'planQuota'
  | 'pricing'
  | 'progress'
  | 'help';

type IconProps = { name: IconName; size?: number; color?: string };

export function Icon({ name, size = 20, color = 'currentColor' }: IconProps) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (name) {
    case 'overview':
      return (
        <Svg width={size} height={size} {...common}>
          <Path d="M4 11.5 12 4l8 7.5" />
          <Path d="M6 10v9a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-9" />
        </Svg>
      );
    case 'geocode':
      return (
        <Svg width={size} height={size} {...common}>
          <Path d="M12 21s7-7.05 7-11.5A7 7 0 0 0 5 9.5C5 13.95 12 21 12 21Z" />
          <Circle cx={12} cy={9.5} r={2.4} />
        </Svg>
      );
    case 'reverseGeocode':
      return (
        <Svg width={size} height={size} {...common}>
          <Circle cx={12} cy={12} r={7} />
          <Circle cx={12} cy={12} r={1.6} fill={color} stroke="none" />
          <Path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </Svg>
      );
    case 'findPlaces':
      return (
        <Svg width={size} height={size} {...common}>
          <Circle cx={12} cy={12} r={9} />
          <Path d="M15.2 8.8 13 13l-4.2 2.2L11 11l4.2-2.2Z" />
        </Svg>
      );
    case 'roadAlerts':
      return (
        <Svg width={size} height={size} {...common}>
          <Path d="M12 3.5 21 19.5H3L12 3.5Z" />
          <Path d="M12 9.5v4.4" />
          <Circle cx={12} cy={16.6} r={1} fill={color} stroke="none" />
        </Svg>
      );
    case 'importAddresses':
      return (
        <Svg width={size} height={size} {...common}>
          <Path d="M12 3v11" />
          <Path d="M8 10.5 12 14.5 16 10.5" />
          <Path d="M4.5 16.5v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
        </Svg>
      );
    case 'batch':
      return (
        <Svg width={size} height={size} {...common}>
          <Path d="M12 3 3 8l9 5 9-5-9-5Z" />
          <Path d="M3 12l9 5 9-5" />
          <Path d="M3 16l9 5 9-5" />
        </Svg>
      );
    case 'planQuota':
      return (
        <Svg width={size} height={size} {...common}>
          <Path d="M4 15a8 8 0 1 1 16 0" />
          <Path d="M12 15 15.5 10" />
          <Circle cx={12} cy={15} r={1.4} fill={color} stroke="none" />
        </Svg>
      );
    case 'pricing':
      return (
        <Svg width={size} height={size} {...common}>
          <Path d="M11.6 3.5H19a1.5 1.5 0 0 1 1.5 1.5v7.4a1.5 1.5 0 0 1-.44 1.06l-8 8a1.5 1.5 0 0 1-2.12 0l-7.4-7.4a1.5 1.5 0 0 1 0-2.12l8-8a1.5 1.5 0 0 1 1.06-.44Z" />
          <Circle cx={15.5} cy={8.5} r={1.5} fill={color} stroke="none" />
        </Svg>
      );
    case 'progress':
      return (
        <Svg width={size} height={size} {...common}>
          <Path d="M4 19V10" />
          <Path d="M10 19V5" />
          <Path d="M16 19v-7" />
          <Path d="M4 19h16" />
        </Svg>
      );
    case 'help':
      return (
        <Svg width={size} height={size} {...common}>
          <Circle cx={12} cy={12} r={9} />
          <Path d="M9.6 9.3a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1 .9-1 1.7" />
          <Circle cx={12} cy={16.6} r={1} fill={color} stroke="none" />
        </Svg>
      );
  }
}
