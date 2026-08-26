/// <reference types="geojson" />
import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { colors } from '../../shared/theme';
import { attachHoverLabel } from './mapHoverLabel';
import { OSM_RASTER_STYLE } from './osmStyle';

export type PlacePoint = {
  address: string;
  name: string;
  latitude: number;
  longitude: number;
  // Index into the full results list -- lets a map click be matched back
  // to the right list row (see BatchGeocodeMap.web.tsx's identical field).
  resultIndex: number;
};

type FocusRequest = { index: number; nonce: number };

type Props = {
  // The search-origin point (GPS or a resolved "near <place>" clause) --
  // shown as its own real maplibre Marker, distinct from the GeoJSON-layer
  // result points below (see ui/desktop's FindPlacesMapView, this
  // component's desktop counterpart, for the identical split).
  center?: { latitude: number; longitude: number } | null;
  places: PlacePoint[];
  selectedIndex?: number | null;
  focusRequest?: FocusRequest | null;
  onPlaceClick?: (resultIndex: number) => void;
};

const SOURCE_ID = 'find-places-results';
const LAYER_ID = 'find-places-results-points';
const DEFAULT_RADIUS = 6;
const SELECTED_RADIUS = 10;
const DEFAULT_COLOR = '#3fb1ce';

// A NaN coordinate handed to maplibre (setLngLat, map center, bounds)
// throws synchronously and (with no error boundary in this app) blanks
// the whole page -- validated at this component's boundary rather than
// trusted from the caller, since it can arrive from GPS, a resolved
// "near <place>" clause, or an upstream response, not just a map click
// (see ui/desktop's FindPlacesMapView, this component's identical guard).
function isFiniteCenter(center: { latitude: number; longitude: number } | null): center is {
  latitude: number;
  longitude: number;
} {
  return center !== null && Number.isFinite(center.latitude) && Number.isFinite(center.longitude);
}

type PointFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Point, { address: string; resultIndex: number }>;

function toGeoJSON(points: PlacePoint[]): PointFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((point) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
      properties: { address: point.address, resultIndex: point.resultIndex },
    })),
  };
}

// A hybrid of GeocodeMap.web.tsx (a single real Marker for the search
// center) and BatchGeocodeMap.web.tsx (a GeoJSON circle layer for many
// result points, click-linked to a list) -- Find Places needs both at
// once, same split as ui/desktop's FindPlacesMapView.
export default function FindPlacesMap({
  center = null,
  places,
  selectedIndex = null,
  focusRequest = null,
  onPlaceClick,
}: Props) {
  const containerRef = useRef<View>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const centerMarkerRef = useRef<Marker | null>(null);
  const centerPopupRef = useRef<Popup | null>(null);
  const [ready, setReady] = useState(false);
  const onPlaceClickRef = useRef(onPlaceClick);
  onPlaceClickRef.current = onPlaceClick;

  useEffect(() => {
    const container = containerRef.current as unknown as HTMLElement | null;
    if (!container) return;

    const validCenter = isFiniteCenter(center) ? center : null;
    const map = new MapLibreMap({
      container,
      style: OSM_RASTER_STYLE,
      center: validCenter ? [validCenter.longitude, validCenter.latitude] : [0, 0],
      zoom: validCenter ? 13 : 1,
    });
    map.addControl(new NavigationControl(), 'top-right');
    map.on('error', (e) => console.error('FindPlacesMap: map error', e.error));
    mapRef.current = map;

    map.on('load', () => {
      map.addSource(SOURCE_ID, { type: 'geojson', data: toGeoJSON([]) });
      map.addLayer({
        id: LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        paint: {
          'circle-radius': DEFAULT_RADIUS,
          'circle-color': DEFAULT_COLOR,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      const popup = new Popup({ offset: 12, closeButton: false, closeOnClick: false });
      map.on('mouseenter', LAYER_ID, (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const feature = e.features?.[0];
        if (!feature || feature.geometry.type !== 'Point') return;
        const [lng, lat] = feature.geometry.coordinates as [number, number];
        popup
          .setLngLat([lng, lat])
          .setText(String(feature.properties?.address ?? ''))
          .addTo(map);
      });
      map.on('mouseleave', LAYER_ID, () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });
      map.on('click', LAYER_ID, (e) => {
        const feature = e.features?.[0];
        const resultIndex = feature?.properties?.resultIndex;
        if (typeof resultIndex === 'number') onPlaceClickRef.current?.(resultIndex);
      });

      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      centerMarkerRef.current = null;
      centerPopupRef.current = null;
      setReady(false);
    };
    // Map is created once on mount; center/places updates are handled by
    // the effects below so we don't tear down and rebuild on every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!isFiniteCenter(center)) {
      centerMarkerRef.current?.remove();
      centerMarkerRef.current = null;
      centerPopupRef.current = null;
      return;
    }

    if (!centerMarkerRef.current) {
      centerMarkerRef.current = new Marker({ color: '#555555' })
        .setLngLat([center.longitude, center.latitude])
        .addTo(map);
      centerPopupRef.current = attachHoverLabel(centerMarkerRef.current, map, 'Search center');
    } else {
      centerMarkerRef.current.setLngLat([center.longitude, center.latitude]);
    }
  }, [center]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(toGeoJSON(places));

    if (places.length === 0) return;

    const bounds = places.reduce(
      (acc, point) => acc.extend([point.longitude, point.latitude]),
      new LngLatBounds([places[0].longitude, places[0].latitude], [places[0].longitude, places[0].latitude])
    );
    if (isFiniteCenter(center)) bounds.extend([center.longitude, center.latitude]);
    map.fitBounds(bounds, { padding: 40, maxZoom: 16 });
  }, [places, ready]);

  // Highlighting only -- see BatchGeocodeMap.web.tsx's identical effect/comment.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const selected = selectedIndex ?? -1;
    map.setPaintProperty(LAYER_ID, 'circle-radius', [
      'case',
      ['==', ['get', 'resultIndex'], selected],
      SELECTED_RADIUS,
      DEFAULT_RADIUS,
    ]);
    map.setPaintProperty(LAYER_ID, 'circle-color', [
      'case',
      ['==', ['get', 'resultIndex'], selected],
      colors.accent,
      DEFAULT_COLOR,
    ]);
  }, [selectedIndex, ready]);

  // List-tap direction only -- see BatchGeocodeMap.web.tsx's identical effect/comment.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focusRequest) return;
    const place = places.find((p) => p.resultIndex === focusRequest.index);
    if (!place) return;
    map.flyTo({ center: [place.longitude, place.latitude], zoom: Math.max(map.getZoom(), 15) });
  }, [focusRequest, ready, places]);

  return <View ref={containerRef} style={{ height: 280, borderRadius: 8, overflow: 'hidden' }} />;
}
