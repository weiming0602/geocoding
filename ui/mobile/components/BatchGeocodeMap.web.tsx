/// <reference types="geojson" />
import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, NavigationControl, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors, radius, space } from '../../shared/theme';
import { OSM_RASTER_STYLE } from './osmStyle';

export type MarkerPoint = {
  address: string;
  latitude: number;
  longitude: number;
  // Index into the full (unfiltered) results list this marker came from
  // -- markers only exist for successful results, so a marker's position
  // in this array isn't its row's position in the results list. This is
  // what lets a map click be matched back to the right list row.
  resultIndex: number;
};

type FocusRequest = { index: number; nonce: number };

type Props = {
  markers: MarkerPoint[];
  // Highlighting only, set from either direction (a list-row tap or a
  // marker click) -- never pans/zooms the map on its own.
  selectedIndex?: number | null;
  // Pans/zooms to the given marker -- list-tap direction only. `nonce`
  // (Date.now() at request time) forces the effect to re-fire even when
  // the same row is tapped twice in a row, since a repeated `index` value
  // alone wouldn't otherwise change.
  focusRequest?: FocusRequest | null;
  // Map-click direction only -- never fired for a highlight-only change.
  onMarkerClick?: (resultIndex: number) => void;
};

const SIZES = { Compact: 190, Default: 280, Large: 480 } as const;
type SizeName = keyof typeof SIZES;

const SOURCE_ID = 'batch-results';
const LAYER_ID = 'batch-results-points';
const DEFAULT_RADIUS = 6;
const SELECTED_RADIUS = 10;
const DEFAULT_COLOR = '#3fb1ce';

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
// Marker (a real DOM element) per point -- see the same rationale in
// ui/desktop/src/components/BatchMapView.tsx. Hover goes through the
// map's own feature-picking (mouseenter/mouseleave scoped to LAYER_ID)
// instead of mapHoverLabel.ts's per-Marker DOM approach, which is still
// used by the single-result map (GeocodeMap.web.tsx).
export default function BatchGeocodeMap({ markers, selectedIndex = null, focusRequest = null, onMarkerClick }: Props) {
  const containerRef = useRef<View>(null);
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
    const container = containerRef.current as unknown as HTMLElement | null;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: OSM_RASTER_STYLE,
      center: [0, 0],
      zoom: 1,
    });
    map.addControl(new NavigationControl(), 'top-right');
    mapRef.current = map;
    // Surfaced rather than left silent -- a style/tile-load failure here
    // previously had no visible symptom at all beyond a missing map, which
    // is exactly the kind of silent failure worth logging instead of
    // swallowing (see the maplibre-gl worker script issue this uncovered,
    // documented in public/README.md).
    map.on('error', (e) => console.error('BatchGeocodeMap: map error', e.error));

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
      colors.accent,
      DEFAULT_COLOR,
    ]);
  }, [selectedIndex, ready]);

  // List-tap direction only -- pans/zooms to the requested marker. Keyed
  // on the whole focusRequest object (not just its index) so tapping the
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
    <View>
      <View
        ref={containerRef}
        style={{ height: SIZES[size], borderRadius: 8, overflow: 'hidden' }}
      />
      <View style={styles.sizeRow}>
        {(Object.keys(SIZES) as SizeName[]).map((name) => (
          <TouchableOpacity
            key={name}
            onPress={() => setSize(name)}
            style={[styles.sizeButton, size === name && styles.sizeButtonActive]}
          >
            <Text style={[styles.sizeButtonText, size === name && styles.sizeButtonTextActive]}>
              {name}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sizeRow: {
    flexDirection: 'row',
    gap: space[2],
    marginTop: space[2],
  },
  sizeButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  sizeButtonActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  sizeButtonText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
  },
  sizeButtonTextActive: {
    color: colors.bg,
  },
});
