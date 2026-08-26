/// <reference types="geojson" />
import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';

import { attachHoverLabel } from '../map/mapHoverLabel';
import { OSM_RASTER_STYLE } from '../map/osmStyle';

export type PlacePoint = {
  address: string;
  name: string;
  latitude: number;
  longitude: number;
  // Index into the full results list -- lets a map click be matched
  // back to the right table row (see BatchMapView's identical field).
  resultIndex: number;
};

type FocusRequest = { index: number; nonce: number };

type Props = {
  // The search-origin point (a map click, GPS, or a resolved "near
  // <place>" clause) -- shown as its own real maplibre Marker, distinct
  // from the GeoJSON-layer result points below, since there's always at
  // most one of it and it's set via a plain map click rather than ever
  // being clicked-on itself.
  center?: { latitude: number; longitude: number } | null;
  onCenterClick?: (coordinates: { latitude: number; longitude: number }) => void;
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
// Same value as --color-accent in styles.css -- maplibre's paint
// expressions run in WebGL, not CSS, so a custom property string can't
// be handed to setPaintProperty directly; this is that value inlined
// (see BatchMapView's identical constant/comment).
const SELECTED_COLOR = '#b68235';

const DEFAULT_CENTER: [number, number] = [-98.5, 39.8];

// A NaN coordinate handed to maplibre (setLngLat, map center, bounds)
// throws synchronously and (with no error boundary in this app) blanks
// the whole page -- validated at this component's boundary rather than
// trusted from the caller, since it can arrive from GPS, a resolved
// "near <place>" clause, or an upstream response, not just a map click.
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

// A hybrid of MapView (a single real Marker for a point the user picks by
// clicking) and BatchMapView (a GeoJSON circle layer for many result
// points, click-linked to a list) -- Find Places needs both at once: one
// search-origin point, plus every place result found near it.
export default function FindPlacesMapView({
  center = null,
  onCenterClick,
  places,
  selectedIndex = null,
  focusRequest = null,
  onPlaceClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const centerMarkerRef = useRef<Marker | null>(null);
  const centerPopupRef = useRef<Popup | null>(null);
  const [ready, setReady] = useState(false);
  const onCenterClickRef = useRef(onCenterClick);
  onCenterClickRef.current = onCenterClick;
  const onPlaceClickRef = useRef(onPlaceClick);
  onPlaceClickRef.current = onPlaceClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const validCenter = isFiniteCenter(center) ? center : null;
    const map = new MapLibreMap({
      container,
      style: OSM_RASTER_STYLE,
      center: validCenter ? [validCenter.longitude, validCenter.latitude] : DEFAULT_CENTER,
      zoom: validCenter ? 13 : 3,
    });
    map.addControl(new NavigationControl(), 'top-right');
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

      // Registered on the map itself (not scoped to LAYER_ID), so it
      // fires for every click including ones that also hit a result
      // marker -- querying rendered features at the click point is what
      // actually distinguishes the two (a layer-specific listener's own
      // preventDefault() does NOT suppress this generic listener, tested
      // directly against maplibre-gl's real click dispatch). Registered
      // inside 'load', after LAYER_ID exists, since queryRenderedFeatures
      // against a not-yet-added layer throws.
      map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: [LAYER_ID] });
        if (hits.length > 0) return;
        onCenterClickRef.current?.({ latitude: e.lngLat.lat, longitude: e.lngLat.lng });
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

  // Highlighting only -- see BatchMapView's identical effect/comment.
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
      SELECTED_COLOR,
      DEFAULT_COLOR,
    ]);
  }, [selectedIndex, ready]);

  // Row-click direction only -- see BatchMapView's identical effect/comment.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focusRequest) return;
    const place = places.find((p) => p.resultIndex === focusRequest.index);
    if (!place) return;
    map.flyTo({ center: [place.longitude, place.latitude], zoom: Math.max(map.getZoom(), 15) });
  }, [focusRequest, ready, places]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        height: 420,
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-divider)',
        background: 'var(--color-surface)',
        overflow: 'hidden',
        cursor: onCenterClick ? 'crosshair' : 'default',
      }}
    />
  );
}
