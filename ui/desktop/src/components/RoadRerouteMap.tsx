/// <reference types="geojson" />
import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';

import { attachHoverLabel } from '../map/mapHoverLabel';
import { OSM_RASTER_STYLE } from '../map/osmStyle';

type Point = { latitude: number; longitude: number };

export type RerouteOption = {
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  distanceMeters: number | null;
  durationSeconds: number | null;
};

type Props = {
  driverPosition: Point;
  hazardPosition: Point;
  rejoinPoint: Point;
  options: RerouteOption[];
  // Which option (index into `options`) to visually call out -- e.g. the
  // one the driver is currently hovering in the option list below the
  // map. null/undefined draws every route the same as always.
  highlightedIndex?: number | null;
};

const SOURCE_ID = 'road-reroute-routes';
const LAYER_ID = 'road-reroute-routes-lines';
const HIGHLIGHT_LAYER_ID = 'road-reroute-routes-highlight';
// One per ROUTE_OPTION_COUNT (roadReroute.js) -- was missing a 3rd color
// until now, so a genuine 3rd option silently fell through to this
// layer's own "no match" default (the same gray as the rejoin marker),
// which is likely a real part of why 3 options could look like fewer.
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

// GeoJSON line layer for the route paths (new API surface for this app --
// see BatchMapView.tsx for the proven source/setData/fitBounds skeleton
// this otherwise follows) + plain DOM Markers for the three fixed points
// (driver/hazard/rejoin), same as MapView.tsx's single-marker approach --
// there are only ever 3 of them, so no need for BatchMapView's
// WebGL-circle-layer scaling trick.
export default function RoadRerouteMap({
  driverPosition,
  hazardPosition,
  rejoinPoint,
  options,
  highlightedIndex = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: OSM_RASTER_STYLE,
      center: [driverPosition.longitude, driverPosition.latitude],
      zoom: 13,
    });
    map.addControl(new NavigationControl(), 'top-right');
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
      // A second layer over the same source, filtered (via setFilter, in
      // the effect below) to just the hovered option's feature and drawn
      // wider -- guarantees the hovered route reads as "on top" even
      // where two options fully coincide, since draw order otherwise
      // follows the source's fixed feature order (see toGeoJSON's own
      // comment), not hover state. Filtered to match nothing until a
      // driver actually hovers an option.
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
    attachHoverLabel(driverMarker, map, 'Your position');

    const hazardMarker = new Marker({ color: '#f2543f' })
      .setLngLat([hazardPosition.longitude, hazardPosition.latitude])
      .addTo(map);
    attachHoverLabel(hazardMarker, map, 'Hazard');

    const rejoinMarker = new Marker({ color: '#9b9797' })
      .setLngLat([rejoinPoint.longitude, rejoinPoint.latitude])
      .addTo(map);
    attachHoverLabel(rejoinMarker, map, 'Estimated rejoin point (not exact)');

    const routePoints: [number, number][] = options.flatMap((option) => option.geometry.coordinates);
    const allPoints: [number, number][] = [
      [driverPosition.longitude, driverPosition.latitude],
      [hazardPosition.longitude, hazardPosition.latitude],
      [rejoinPoint.longitude, rejoinPoint.latitude],
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
      rejoinMarker.remove();
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
      // Other options fade back (not hidden) so the driver can still see
      // there's more than one path, just not which one is "live" right now.
      map.setPaintProperty(LAYER_ID, 'line-opacity', [
        'case',
        ['==', ['get', 'routeIndex'], highlightedIndex],
        1,
        0.25,
      ]);
    }
  }, [ready, highlightedIndex]);

  return (
    <div
      ref={containerRef}
      style={{
        height: 360,
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-divider)',
        overflow: 'hidden',
      }}
    />
  );
}
