/// <reference types="geojson" />
import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, NavigationControl, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';

import { OSM_RASTER_STYLE } from '../map/osmStyle';

export type MarkerPoint = {
  address: string;
  latitude: number;
  longitude: number;
  // Index into the full (unfiltered) results list this marker came from
  // -- markers only exist for successful results, so a marker's position
  // in this array isn't its row's position in the results list. This is
  // what lets a map click be matched back to the right table row.
  resultIndex: number;
};

type FocusRequest = { index: number; nonce: number };

type Props = {
  markers: MarkerPoint[];
  // Highlighting only, set from either direction (a row click or a
  // marker click) -- never pans/zooms the map on its own.
  selectedIndex?: number | null;
  // Pans/zooms to the given marker -- row-click direction only. `nonce`
  // (Date.now() at request time) forces the effect to re-fire even when
  // the same row is clicked twice in a row, since a repeated `index`
  // value alone wouldn't otherwise change.
  focusRequest?: FocusRequest | null;
  // Map-click direction only -- never fired for a highlight-only change.
  onMarkerClick?: (resultIndex: number) => void;
};

const SIZES = { Compact: 220, Default: 320, Large: 560 } as const;
type SizeName = keyof typeof SIZES;

const SOURCE_ID = 'batch-results';
const LAYER_ID = 'batch-results-points';
const DEFAULT_RADIUS = 6;
const SELECTED_RADIUS = 10;
const DEFAULT_COLOR = '#3fb1ce';
// Same value as --color-accent in styles.css -- maplibre's paint
// expressions run in WebGL, not CSS, so a custom property string can't
// be handed to setPaintProperty directly; this is that value inlined.
const SELECTED_COLOR = '#b68235';

type PointFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Point, { address: string; resultIndex: number }>;

function toGeoJSON(markers: MarkerPoint[]): PointFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: markers.map((point) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
      properties: { address: point.address, resultIndex: point.resultIndex },
    })),
  };
}

// Plotted via a GeoJSON source + circle layer, not one maplibre-gl
// Marker (a real DOM element) per point -- markers work fine up to a
// few hundred, but the browser has to position/repaint a DOM node per
// point on every pan/zoom, which bogs down well before real batches
// (thousands of addresses) would need. A GeoJSON layer draws every
// point in the same WebGL canvas pass as the base map, so it scales to
// many thousands of points with no per-point DOM cost -- the tradeoff
// is that hover has to go through the map's own feature-picking
// (mouseenter/mouseleave scoped to LAYER_ID + queryRenderedFeatures)
// instead of a per-marker DOM element, unlike mapHoverLabel.ts's
// Marker-based approach (still used by the single-result map, MapView.tsx).
export default function BatchMapView({ markers, selectedIndex = null, focusRequest = null, onMarkerClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [size, setSize] = useState<SizeName>('Default');
  const [ready, setReady] = useState(false);
  // The 'load' listener (and the click handler registered inside it) is
  // set up once per map instance -- reading the callback through a ref
  // (kept current every render) means a new onMarkerClick identity from
  // the parent never needs the whole map to be torn down and rebuilt.
  const onMarkerClickRef = useRef(onMarkerClick);
  onMarkerClickRef.current = onMarkerClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({ container, style: OSM_RASTER_STYLE, center: [0, 0], zoom: 1 });
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
        if (typeof resultIndex === 'number') onMarkerClickRef.current?.(resultIndex);
      });

      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Map is created once on mount; markers are (re)placed by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(toGeoJSON(markers));

    if (markers.length === 0) return;

    if (markers.length === 1) {
      map.setCenter([markers[0].longitude, markers[0].latitude]);
      map.setZoom(15);
      return;
    }

    const bounds = markers.reduce(
      (acc, point) => acc.extend([point.longitude, point.latitude]),
      new LngLatBounds(
        [markers[0].longitude, markers[0].latitude],
        [markers[0].longitude, markers[0].latitude]
      )
    );
    map.fitBounds(bounds, { padding: 40, maxZoom: 16 });
  }, [markers, ready]);

  // Highlighting only -- rebuilds the paint expressions' literal
  // comparison value each time, rather than using feature-state (which
  // would need a stable per-feature id); never pans/zooms on its own, so
  // a marker click's own selection change doesn't fight the pan/zoom the
  // click itself may have already caused.
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

  // Row-click direction only -- pans/zooms to the requested marker. Keyed
  // on the whole focusRequest object (not just its index) so clicking the
  // same row twice in a row still re-triggers this, since nonce changes
  // every time even when index doesn't.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focusRequest) return;
    const marker = markers.find((m) => m.resultIndex === focusRequest.index);
    if (!marker) return;
    map.flyTo({ center: [marker.longitude, marker.latitude], zoom: Math.max(map.getZoom(), 15) });
  }, [focusRequest, ready, markers]);

  // MapLibre renders to a fixed-size canvas -- it doesn't notice its
  // container growing/shrinking on its own, so resize() has to be
  // called explicitly whenever the height changes (after the browser
  // has actually applied the new height, hence requestAnimationFrame
  // rather than calling it synchronously in the same tick).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const frame = requestAnimationFrame(() => map.resize());
    return () => cancelAnimationFrame(frame);
  }, [size]);

  if (markers.length === 0) return null;

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          height: SIZES[size],
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-divider)',
          overflow: 'hidden',
        }}
      />
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
        {(Object.keys(SIZES) as SizeName[]).map((name) => (
          <button
            key={name}
            className={size === name ? 'btn btn-primary' : 'btn btn-secondary'}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setSize(name)}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
