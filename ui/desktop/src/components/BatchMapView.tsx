/// <reference types="geojson" />
import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, NavigationControl, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';

import { OSM_RASTER_STYLE } from '../map/osmStyle';

export type MarkerPoint = {
  address: string;
  latitude: number;
  longitude: number;
};

const SIZES = { Compact: 220, Default: 320, Large: 560 } as const;
type SizeName = keyof typeof SIZES;

const SOURCE_ID = 'batch-results';
const LAYER_ID = 'batch-results-points';

type PointFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Point, { address: string }>;

function toGeoJSON(markers: MarkerPoint[]): PointFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: markers.map((point) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
      properties: { address: point.address },
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
export default function BatchMapView({ markers }: { markers: MarkerPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [size, setSize] = useState<SizeName>('Default');
  const [ready, setReady] = useState(false);

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
          'circle-radius': 6,
          'circle-color': '#3fb1ce',
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
