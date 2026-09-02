import React from 'react';
import { View } from 'react-native';
import Svg, { Line, Marker, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';

import { colors } from '../../shared/theme';

// 600x900 viewBox -- callers just need a container that can size to any
// width; this ratio keeps the Svg (width/height both "100%", scaled by
// its viewBox) proportional rather than stretched.
export const ROAD_ALERTS_DIAGRAM_ASPECT_RATIO = 600 / 900;

// Ported 1:1 from ui/desktop/src/components/RoadAlertsDiagram.tsx (same
// geometry, same steps) via react-native-svg instead of DOM SVG -- see
// that file's own comment for why "weighted points" (routine-street
// matching) is deliberately left out: weightedPoints is always empty for
// a real account today (no on-device trip-learning exists yet), so this
// diagrams the real, live pipeline only (radius + heading-cone
// filtering, severity, reroute, navigation hand-off).
export default function RoadAlertsDiagram() {
  const textProps = { textAnchor: 'middle' as const, fontSize: 13, fill: colors.text };
  const capProps = { textAnchor: 'middle' as const, fontSize: 11, fill: colors.text, opacity: 0.65 };
  const arrow = { stroke: colors.accent, strokeWidth: 2, markerEnd: 'url(#rad-arrow-mobile)' };

  return (
    <View style={{ width: '100%', aspectRatio: ROAD_ALERTS_DIAGRAM_ASPECT_RATIO }}>
    <Svg viewBox="0 0 600 900" width="100%" height="100%">
      <Marker id="rad-arrow-mobile" viewBox="0 0 10 10" refX={8} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
        <Path d="M0 0 L10 5 L0 10 Z" fill={colors.accent} />
      </Marker>

      {/* 1. Driving */}
      <Rect x={100} y={20} width={400} height={56} rx={10} fill={colors.surface} stroke={colors.divider} />
      <SvgText x={300} y={54} {...textProps}>You start driving</SvgText>
      <Line x1={300} y1={76} x2={300} y2={112} {...arrow} />

      {/* 2. GPS */}
      <Rect x={100} y={116} width={400} height={56} rx={10} fill="#e7f5f0" stroke={colors.accent2} />
      <SvgText x={300} y={150} {...textProps}>App watches your GPS position + heading</SvgText>
      <Line x1={300} y1={172} x2={300} y2={208} {...arrow} />

      {/* 3. 511 fetch */}
      <Rect x={100} y={212} width={400} height={56} rx={10} fill={colors.surface} stroke={colors.divider} />
      <SvgText x={300} y={240} {...textProps}>Checks New England 511 for hazards</SvgText>
      <SvgText x={300} y={257} {...textProps}>within about 10 km of you</SvgText>
      <Line x1={300} y1={268} x2={300} y2={304} {...arrow} />

      {/* 4. Decision diamond */}
      <Polygon points="300,304 460,352 300,400 140,352" fill={colors.accent100} stroke={colors.accent} strokeWidth={1.5} />
      <SvgText x={300} y={348} {...textProps}>Is it ahead of you --</SvgText>
      <SvgText x={300} y={365} {...textProps}>the way you're heading?</SvgText>

      <Line x1={200} y1={378} x2={120} y2={426} {...arrow} />
      <SvgText x={130} y={418} {...textProps} fontSize={12} fontWeight="600">Yes</SvgText>
      <Line x1={400} y1={378} x2={480} y2={426} {...arrow} />
      <SvgText x={470} y={418} {...textProps} fontSize={12} fontWeight="600">No</SvgText>

      {/* Yes box */}
      <Rect x={20} y={430} width={260} height={64} rx={10} fill="#e7f5f0" stroke={colors.accent2} />
      <SvgText x={150} y={458} {...textProps}>Spoken aloud right away,</SvgText>
      <SvgText x={150} y={476} {...textProps}>shown at the top of your list</SvgText>

      {/* No box */}
      <Rect x={320} y={430} width={260} height={64} rx={10} fill={colors.surface} stroke={colors.divider} />
      <SvgText x={450} y={458} {...textProps}>Still shown in your list,</SvgText>
      <SvgText x={450} y={476} {...textProps}>marked "behind you"</SvgText>

      {/* merge lines */}
      <Line x1={150} y1={494} x2={150} y2={520} stroke={colors.accent} strokeWidth={2} />
      <Line x1={450} y1={494} x2={450} y2={520} stroke={colors.accent} strokeWidth={2} />
      <Line x1={150} y1={520} x2={450} y2={520} stroke={colors.accent} strokeWidth={2} />
      <Line x1={300} y1={520} x2={300} y2={546} {...arrow} />

      {/* 5. Tap show a way around */}
      <Rect x={100} y={550} width={400} height={56} rx={10} fill={colors.surface} stroke={colors.divider} />
      <SvgText x={300} y={584} {...textProps}>You tap "Show a way around this"</SvgText>
      <Line x1={300} y1={606} x2={300} y2={642} {...arrow} />

      {/* 6. Reroute compute */}
      <Rect x={100} y={646} width={400} height={72} rx={10} fill="#e7f5f0" stroke={colors.accent2} />
      <SvgText x={300} y={678} {...textProps}>Our own street data (not Google's) finds</SvgText>
      <SvgText x={300} y={696} {...textProps}>up to 3 routes around the hazard</SvgText>
      <Line x1={300} y1={718} x2={300} y2={754} {...arrow} />

      {/* 7. Google Maps handoff */}
      <Rect x={100} y={758} width={400} height={72} rx={10} fill="#efe7fb" stroke="#7c3aed" />
      <SvgText x={300} y={790} {...textProps}>You pick a route, then hand it to</SvgText>
      <SvgText x={300} y={808} {...textProps}>Google Maps for real turn-by-turn directions</SvgText>

      <SvgText x={300} y={856} {...capProps}>
        Registration, comments, and saving an alert aren't shown here -- see the sections above.
      </SvgText>
    </Svg>
    </View>
  );
}
