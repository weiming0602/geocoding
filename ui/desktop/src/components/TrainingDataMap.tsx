/// <reference types="geojson" />
import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, NavigationControl, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { AddressInferenceReviewResponse, TrainingAddress, TrainingStatus } from '../../../shared/api/types';
import { OSM_RASTER_STYLE } from '../map/osmStyle';

// Inlined hex, not CSS custom properties: maplibre paint runs in WebGL.
export const STATUS_COLORS: Record<TrainingStatus, string> = {
  right: '#2e7d4f',
  wrong: '#c0392b',
  missed: '#d68910',
  no_building: '#7f8c8d',
};
export const BUILDING_COLORS = {
  truth: '#2e7d4f', // the building E911 says the address is
  wrongPick: '#c0392b', // a building the model picked for an address that isn't its own
  both: '#8e44ad', // the true building of one address and the wrong pick of another
  other: '#9aa0a6',
};

type Props = {
  data: AddressInferenceReviewResponse;
  visible: Set<TrainingStatus>;
  selected: TrainingAddress | null;
  // Bumped on a list-row click so the map flies even to the same address twice.
  focusNonce: number;
  onSelect: (address: TrainingAddress) => void;
};

type Buildings = AddressInferenceReviewResponse['buildings'];

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function buildingRoles(addresses: TrainingAddress[]): Map<string, 'truth' | 'wrongPick' | 'both'> {
  const truth = new Set<string>();
  const wrong = new Set<string>();
  for (const a of addresses) {
    if (a.trueBuilding) truth.add(a.trueBuilding);
    if (a.pickedBuilding && a.pickedBuilding !== a.trueBuilding) wrong.add(a.pickedBuilding);
  }
  const roles = new Map<string, 'truth' | 'wrongPick' | 'both'>();
  for (const id of truth) roles.set(id, wrong.has(id) ? 'both' : 'truth');
  for (const id of wrong) if (!truth.has(id)) roles.set(id, 'wrongPick');
  return roles;
}

function buildingsWithRoles(buildings: Buildings, addresses: TrainingAddress[]): GeoJSON.FeatureCollection {
  const roles = buildingRoles(addresses);
  return {
    type: 'FeatureCollection',
    features: buildings.features.map((f) => ({
      ...(f as unknown as GeoJSON.Feature),
      properties: { ...f.properties, role: roles.get(f.properties.id) ?? 'other' },
    })),
  };
}

function points(addresses: TrainingAddress[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: addresses.map((a) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a.e911.longitude, a.e911.latitude] },
      properties: { id: a.id, status: a.status },
    })),
  };
}

// E911 point -> the building the model picked, for every non-right pick.
function links(addresses: TrainingAddress[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: addresses
      .filter((a) => a.picked && a.status !== 'right')
      .map((a) => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [a.e911.longitude, a.e911.latitude],
            [a.picked!.longitude, a.picked!.latitude],
          ],
        },
        properties: { status: a.status },
      })),
  };
}

export function addressLabel(a: TrainingAddress): string {
  return `${a.number} ${a.street}${a.unit ? `, ${a.unit}` : ''}`;
}

export function describe(a: TrainingAddress): string {
  const where = addressLabel(a);
  switch (a.status) {
    case 'right':
      return `${where}: right building (${a.errorMeters} m from the E911 point)`;
    case 'wrong':
      return `${where}: wrong building, ${a.errorMeters} m from the E911 point (${a.candidates} candidates)`;
    case 'missed':
      return `${where}: the E911 building was not among the ${a.candidates} candidates; ${a.errorMeters} m off`;
    default:
      return `${where}: no footprint within 30 m of the E911 point (no label); ${a.errorMeters} m off`;
  }
}

export default function TrainingDataMap({ data, visible, selected, focusNonce, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const [ready, setReady] = useState(false);
  const byIdRef = useRef(new Map<string, TrainingAddress>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const shown = useMemo(() => data.addresses.filter((a) => visible.has(a.status)), [data, visible]);
  byIdRef.current = new Map(data.addresses.map((a) => [a.id, a]));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = new MapLibreMap({ container, style: OSM_RASTER_STYLE, center: [-70.1, 43.86], zoom: 12 });
    map.addControl(new NavigationControl(), 'top-right');
    mapRef.current = map;

    map.on('load', () => {
      for (const id of ['buildings', 'links', 'points', 'selected-buildings', 'selected-m0']) {
        map.addSource(id, { type: 'geojson', data: emptyCollection() });
      }
      const roleColor = [
        'match',
        ['get', 'role'],
        'truth',
        BUILDING_COLORS.truth,
        'wrongPick',
        BUILDING_COLORS.wrongPick,
        'both',
        BUILDING_COLORS.both,
        BUILDING_COLORS.other,
      ] as unknown as string;
      map.addLayer({
        id: 'buildings-fill',
        type: 'fill',
        source: 'buildings',
        paint: {
          'fill-color': roleColor,
          'fill-opacity': ['match', ['get', 'role'], 'other', 0.25, 0.5] as unknown as number,
        },
      });
      map.addLayer({
        id: 'buildings-outline',
        type: 'line',
        source: 'buildings',
        paint: { 'line-color': roleColor, 'line-width': 1 },
      });
      map.addLayer({
        id: 'links',
        type: 'line',
        source: 'links',
        paint: {
          'line-color': ['match', ['get', 'status'], 'wrong', STATUS_COLORS.wrong, 'missed', STATUS_COLORS.missed, STATUS_COLORS.no_building] as unknown as string,
          'line-width': 1.5,
          'line-dasharray': [2, 1.5],
          'line-opacity': 0.8,
        },
      });
      map.addLayer({
        id: 'selected-buildings',
        type: 'line',
        source: 'selected-buildings',
        paint: {
          'line-color': ['match', ['get', 'which'], 'truth', BUILDING_COLORS.truth, BUILDING_COLORS.wrongPick] as unknown as string,
          'line-width': 4,
        },
      });
      map.addLayer({
        id: 'points',
        type: 'circle',
        source: 'points',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 17, 6] as unknown as number,
          'circle-color': [
            'match',
            ['get', 'status'],
            'right',
            STATUS_COLORS.right,
            'wrong',
            STATUS_COLORS.wrong,
            'missed',
            STATUS_COLORS.missed,
            STATUS_COLORS.no_building,
          ] as unknown as string,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
        },
      });
      map.addLayer({
        id: 'selected-m0',
        type: 'circle',
        source: 'selected-m0',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#2c3e50',
        },
      });

      map.on('mouseenter', 'points', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'points', () => (map.getCanvas().style.cursor = ''));
      map.on('click', 'points', (e) => {
        const id = e.features?.[0]?.properties?.id;
        const address = typeof id === 'string' ? byIdRef.current.get(id) : undefined;
        if (address) onSelectRef.current(address);
      });
      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // Town data: footprints, and the view fitted to its addresses.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const bounds = new LngLatBounds();
    for (const a of data.addresses) bounds.extend([a.e911.longitude, a.e911.latitude]);
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 30, animate: false });
  }, [data, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('buildings') as GeoJSONSource).setData(buildingsWithRoles(data.buildings, shown));
    (map.getSource('points') as GeoJSONSource).setData(points(shown));
    (map.getSource('links') as GeoJSONSource).setData(links(shown));
  }, [data, shown, ready]);

  // The selected address: its E911 building (green) and pick (red) drawn
  // thick, today's interpolated point (white ring), and a popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    popupRef.current?.remove();
    const selectedBuildings = (map.getSource('selected-buildings') as GeoJSONSource);
    const m0 = map.getSource('selected-m0') as GeoJSONSource;
    if (!selected) {
      selectedBuildings.setData(emptyCollection());
      m0.setData(emptyCollection());
      return;
    }
    const features: GeoJSON.Feature[] = [];
    for (const f of data.buildings.features) {
      const id = f.properties.id;
      if (id === selected.trueBuilding) features.push({ ...(f as unknown as GeoJSON.Feature), properties: { which: 'truth' } });
      else if (id === selected.pickedBuilding) features.push({ ...(f as unknown as GeoJSON.Feature), properties: { which: 'pick' } });
    }
    selectedBuildings.setData({ type: 'FeatureCollection', features });
    m0.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [selected.interpolated.longitude, selected.interpolated.latitude] },
          properties: {},
        },
      ],
    });
    popupRef.current = new Popup({ offset: 10, closeButton: false, maxWidth: '280px' })
      .setLngLat([selected.e911.longitude, selected.e911.latitude])
      .setText(describe(selected))
      .addTo(map);
  }, [selected, data, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !selected || focusNonce === 0) return;
    const bounds = new LngLatBounds([selected.e911.longitude, selected.e911.latitude], [selected.e911.longitude, selected.e911.latitude]);
    if (selected.picked) bounds.extend([selected.picked.longitude, selected.picked.latitude]);
    bounds.extend([selected.interpolated.longitude, selected.interpolated.latitude]);
    map.fitBounds(bounds, { padding: 80, maxZoom: 18 });
    // Only a row click (focusNonce) moves the map; a map click doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce, ready]);

  return <div ref={containerRef} style={{ height: 560, borderRadius: 'var(--radius-lg)', overflow: 'hidden' }} />;
}
