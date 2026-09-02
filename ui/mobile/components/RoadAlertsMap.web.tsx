/// <reference types="geojson" />
import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import type { RerouteOption } from '../../shared/api/types';
import { attachHoverLabel } from './mapHoverLabel';
import { OSM_RASTER_STYLE } from './osmStyle';

type Point = { latitude: number; longitude: number };

type Props = {
  driverPosition: Point;
  hazardPosition: Point;
  rejoinPoint?: Point;
  options?: RerouteOption[];
  // Which option (index into `options`) to visually call out -- e.g. the
  // one the driver just tapped in the option list below the map (there's
  // no hover on a touchscreen, so this is tap-driven here rather than the
  // hover-driven desktop equivalent). null/undefined draws every route
  // the same as always.
  highlightedIndex?: number | null;
};

const SOURCE_ID = 'road-alerts-routes';
const LAYER_ID = 'road-alerts-routes-lines';
const HIGHLIGHT_LAYER_ID = 'road-alerts-routes-highlight';
// Same route colors as desktop's RoadRerouteMap.tsx -- expo-maps' native
// side (RoadAlertsMap.tsx, the non-.web version of this component) uses
// the same pair, so all three surfaces (desktop, mobile native, mobile
// web) read as one product.
export const ROUTE_COLORS = ['#1e3a8a', '#f2a52d', '#7c3aed'];

type RouteFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.LineString, { routeIndex: number }>;

// Drawn in reverse (option 0 last, i.e. on top) so the primary route's
// thick dark-blue line wins visually wherever pgr_ksp's options happen to
// overlap or fully coincide -- otherwise a later feature always paints
// over an earlier one at the same pixels, which could silently hide
// option 0 under an alternate.
function toGeoJSON(options: RerouteOption[]): RouteFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: options
      .map((option, index) => ({ option, index }))
      .reverse()
      .map(({ option, index }) => ({
        type: 'Feature',
        geometry: option.geometry,
        properties: { routeIndex: index },
      })),
  };
}

// Ported from desktop's RoadRerouteMap.tsx (same maplibre-gl + OSM raster
// style, same source/layer/marker approach) rather than shared outright --
// ui/shared deliberately excludes anything with maplibre-gl types (see
// ui/shared's own README note), so map integration stays duplicated
// per-app on purpose.
export default function RoadAlertsMap({
  driverPosition,
  hazardPosition,
  rejoinPoint,
  options = [],
  highlightedIndex = null,
}: Props) {
  const containerRef = useRef<View>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current as unknown as HTMLElement | null;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: OSM_RASTER_STYLE,
      center: [driverPosition.longitude, driverPosition.latitude],
      zoom: 13,
    });
    map.addControl(new NavigationControl(), 'top-right');
    map.on('error', (e) => console.error('RoadAlertsMap: map error', e.error));
    mapRef.current = map;

    map.on('load', () => {
      map.addSource(SOURCE_ID, { type: 'geojson', data: toGeoJSON([]) });
      map.addLayer({
        id: LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': 6,
          'line-color': [
            'match',
            ['get', 'routeIndex'],
            0,
            ROUTE_COLORS[0],
            1,
            ROUTE_COLORS[1],
            2,
            ROUTE_COLORS[2],
            /* default */ '#9b9797',
          ],
        },
      });
      // Same "highlight overlay" pattern as desktop's RoadRerouteMap.tsx --
      // a second layer over the same source, filtered to just the tapped
      // option and drawn wider, so it reads as "on top" regardless of the
      // source's fixed feature draw order.
      map.addLayer({
        id: HIGHLIGHT_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': 11,
          'line-color': [
            'match',
            ['get', 'routeIndex'],
            0,
            ROUTE_COLORS[0],
            1,
            ROUTE_COLORS[1],
            2,
            ROUTE_COLORS[2],
            /* default */ '#9b9797',
          ],
        },
        filter: ['==', ['get', 'routeIndex'], -1],
      });
      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Map is created once on mount; points/routes are (re)placed by the
    // effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(toGeoJSON(options));

    const driverMarker = new Marker({ color: '#2fd1ac' })
      .setLngLat([driverPosition.longitude, driverPosition.latitude])
      .addTo(map);
    attachHoverLabel(driverMarker, map, 'You');

    const hazardMarker = new Marker({ color: '#f2543f' })
      .setLngLat([hazardPosition.longitude, hazardPosition.latitude])
      .addTo(map);
    attachHoverLabel(hazardMarker, map, 'Hazard');

    const rejoinMarker = rejoinPoint
      ? new Marker({ color: '#9b9797' }).setLngLat([rejoinPoint.longitude, rejoinPoint.latitude]).addTo(map)
      : null;
    if (rejoinMarker) attachHoverLabel(rejoinMarker, map, 'Estimated rejoin point (not exact)');

    const routePoints: [number, number][] = options.flatMap((option) => option.geometry.coordinates);
    const allPoints: [number, number][] = [
      [driverPosition.longitude, driverPosition.latitude],
      [hazardPosition.longitude, hazardPosition.latitude],
      ...(rejoinPoint ? [[rejoinPoint.longitude, rejoinPoint.latitude] as [number, number]] : []),
      ...routePoints,
    ];
    const bounds = allPoints.reduce(
      (acc, point) => acc.extend(point),
      new LngLatBounds(allPoints[0], allPoints[0])
    );
    map.fitBounds(bounds, { padding: 48, maxZoom: 16 });

    return () => {
      driverMarker.remove();
      hazardMarker.remove();
      rejoinMarker?.remove();
    };
  }, [ready, driverPosition, hazardPosition, rejoinPoint, options]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    if (highlightedIndex == null) {
      map.setFilter(HIGHLIGHT_LAYER_ID, ['==', ['get', 'routeIndex'], -1]);
      map.setPaintProperty(LAYER_ID, 'line-opacity', 1);
    } else {
      map.setFilter(HIGHLIGHT_LAYER_ID, ['==', ['get', 'routeIndex'], highlightedIndex]);
      map.setPaintProperty(LAYER_ID, 'line-opacity', [
        'case',
        ['==', ['get', 'routeIndex'], highlightedIndex],
        1,
        0.25,
      ]);
    }
  }, [ready, highlightedIndex]);

  return <View ref={containerRef} style={{ height: 260, borderRadius: 12, overflow: 'hidden', marginTop: 8 }} />;
}
