/// <reference types="geojson" />
import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, NavigationControl, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  AddressInferenceReviewResponse,
  SuggestedNumber,
  TrainingAddress,
  TrainingStatus,
} from '../../../shared/api/types';
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
// Tax lot outlines: warm, thin, under the footprints.
export const PARCEL_COLOR = '#d35400';
// Suggested numbers (houses E911 never numbered), by kind: never an E911
// color. 'none' = the neighbors leave no free number (drawn hollow/dashed).
export type SuggestionKind = 'second' | 'lot' | 'none';
export const SUGGESTION_COLORS: Record<SuggestionKind, string> = {
  second: '#2471a3', // second house on a numbered lot, number suggested
  lot: '#0e9aa7', // house on a lot with no E911 number, number suggested
  none: '#34495e', // no free number between its neighbors
};
export const SUGGESTION_COLOR = SUGGESTION_COLORS.second;
export function suggestionKind(s: SuggestedNumber): SuggestionKind {
  if (s.number == null) return 'none';
  return s.tier === 'second house' ? 'second' : 'lot';
}
const kindColor = [
  'match',
  ['get', 'kind'],
  'second',
  SUGGESTION_COLORS.second,
  'lot',
  SUGGESTION_COLORS.lot,
  SUGGESTION_COLORS.none,
] as unknown as string;

type Props = {
  data: AddressInferenceReviewResponse;
  visible: Set<TrainingStatus>;
  selected: TrainingAddress | null;
  // Bumped on a list-row click so the map flies even to the same address twice.
  focusNonce: number;
  onSelect: (address: TrainingAddress) => void;
  suggestions: SuggestedNumber[];
  selectedSuggestion: SuggestedNumber | null;
  onSelectSuggestion: (suggestion: SuggestedNumber) => void;
  showParcels: boolean;
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

export function describeParcel(p: { lot?: string | null; address?: string | null; updated?: string | null }): string {
  const address = p.address ? p.address : 'no address on the tax roll';
  return `Tax lot ${p.lot ?? '?'}: ${address}${p.updated ? ` (tax roll ${p.updated})` : ''}`;
}

export function describeSuggestion(s: SuggestedNumber): string {
  const between =
    s.before != null && s.after != null
      ? `between ${s.before} and ${s.after}`
      : s.before != null || s.after != null
        ? `past ${s.before ?? s.after}`
        : 'no neighbors';
  const what = s.tier === 'second house' ? 'second house on a numbered lot' : 'house on a lot with no E911 number';
  return s.number != null
    ? `Suggested ${s.number} ${s.street} (${what}; ${between}). Not in E911.`
    : `No number suggested on ${s.street}: ${s.reason} (${what}).`;
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

function suggestionPoints(suggestions: SuggestedNumber[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: suggestions.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.longitude, s.latitude] },
      properties: { building: s.building, kind: suggestionKind(s) },
    })),
  };
}

// The suggested houses' own footprints, colored by kind.
function suggestionFootprints(buildings: Buildings, suggestions: SuggestedNumber[]): GeoJSON.FeatureCollection {
  const kinds = new Map(suggestions.map((s) => [s.building, suggestionKind(s)]));
  return {
    type: 'FeatureCollection',
    features: buildings.features
      .filter((f) => kinds.has(f.properties.id))
      .map((f) => ({
        ...(f as unknown as GeoJSON.Feature),
        properties: { building: f.properties.id, kind: kinds.get(f.properties.id) },
      })),
  };
}

export default function TrainingDataMap({
  data,
  visible,
  selected,
  focusNonce,
  onSelect,
  suggestions,
  selectedSuggestion,
  onSelectSuggestion,
  showParcels,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const parcelPopupRef = useRef<Popup | null>(null);
  const [ready, setReady] = useState(false);
  const byIdRef = useRef(new Map<string, TrainingAddress>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const suggestionByIdRef = useRef(new Map<string, SuggestedNumber>());
  suggestionByIdRef.current = new Map(suggestions.map((s) => [s.building, s]));
  const onSelectSuggestionRef = useRef(onSelectSuggestion);
  onSelectSuggestionRef.current = onSelectSuggestion;

  const shown = useMemo(() => data.addresses.filter((a) => visible.has(a.status)), [data, visible]);
  byIdRef.current = new Map(data.addresses.map((a) => [a.id, a]));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = new MapLibreMap({ container, style: OSM_RASTER_STYLE, center: [-70.1, 43.86], zoom: 12 });
    map.addControl(new NavigationControl(), 'top-right');
    mapRef.current = map;

    map.on('load', () => {
      for (const id of ['parcels', 'selected-parcel', 'buildings', 'links', 'points', 'selected-buildings', 'selected-m0', 'suggestions', 'suggestion-footprints', 'selected-suggestion']) {
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
      // Tax lots first, so every footprint and dot draws over them. The
      // near-transparent fill is what a click inside a lot hits.
      map.addLayer({
        id: 'parcels-fill',
        type: 'fill',
        source: 'parcels',
        paint: { 'fill-color': PARCEL_COLOR, 'fill-opacity': 0.02 },
      });
      map.addLayer({
        id: 'parcels-outline',
        type: 'line',
        source: 'parcels',
        paint: {
          'line-color': PARCEL_COLOR,
          'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 17, 1.5] as unknown as number,
          'line-opacity': 0.8,
        },
      });
      map.addLayer({
        id: 'selected-parcel',
        type: 'line',
        source: 'selected-parcel',
        paint: { 'line-color': PARCEL_COLOR, 'line-width': 3.5 },
      });
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

      // Suggested numbers: a blue dot on the house (hollow when the
      // neighbors leave no free number), its outline blue when selected.
      map.addLayer({
        id: 'suggestion-fill',
        type: 'fill',
        source: 'suggestion-footprints',
        paint: {
          'fill-color': kindColor,
          'fill-opacity': ['match', ['get', 'kind'], 'none', 0.15, 0.55] as unknown as number,
        },
      });
      map.addLayer({
        id: 'suggestion-outline',
        type: 'line',
        source: 'suggestion-footprints',
        filter: ['!=', ['get', 'kind'], 'none'],
        paint: { 'line-color': kindColor, 'line-width': 2 },
      });
      map.addLayer({
        id: 'suggestion-outline-none',
        type: 'line',
        source: 'suggestion-footprints',
        filter: ['==', ['get', 'kind'], 'none'],
        paint: { 'line-color': SUGGESTION_COLORS.none, 'line-width': 2, 'line-dasharray': [2, 1.5] },
      });
      map.addLayer({
        id: 'selected-suggestion',
        type: 'line',
        source: 'selected-suggestion',
        paint: { 'line-color': '#f1c40f', 'line-width': 4 },
      });
      map.addLayer({
        id: 'suggestions',
        type: 'circle',
        source: 'suggestions',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 17, 7] as unknown as number,
          'circle-color': ['match', ['get', 'kind'], 'none', '#ffffff', kindColor] as unknown as string,
          'circle-stroke-width': ['match', ['get', 'kind'], 'none', 2, 1] as unknown as number,
          'circle-stroke-color': ['match', ['get', 'kind'], 'none', SUGGESTION_COLORS.none, '#ffffff'] as unknown as string,
        },
      });
      map.on('mouseenter', 'suggestions', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'suggestions', () => (map.getCanvas().style.cursor = ''));
      map.on('click', 'suggestions', (e) => {
        const id = e.features?.[0]?.properties?.building;
        const suggestion = typeof id === 'string' ? suggestionByIdRef.current.get(id) : undefined;
        if (suggestion) onSelectSuggestionRef.current(suggestion);
      });

      // A click inside a lot (not on a dot) names the lot and its tax-roll address.
      map.on('click', (e) => {
        if (map.queryRenderedFeatures(e.point, { layers: ['points', 'suggestions'] }).length > 0) return;
        const lot = map.queryRenderedFeatures(e.point, { layers: ['parcels-fill'] })[0];
        parcelPopupRef.current?.remove();
        const highlight = map.getSource('selected-parcel') as GeoJSONSource;
        if (!lot) {
          highlight.setData(emptyCollection());
          return;
        }
        highlight.setData({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: lot.geometry, properties: {} }],
        });
        parcelPopupRef.current = new Popup({ closeButton: true, maxWidth: '280px' })
          .setLngLat(e.lngLat)
          .setText(describeParcel(lot.properties as { lot?: string; address?: string; updated?: string }))
          .addTo(map);
        parcelPopupRef.current.on('close', () => highlight.setData(emptyCollection()));
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
    (map.getSource('parcels') as GeoJSONSource).setData(
      (data.parcels as unknown as GeoJSON.FeatureCollection | undefined) ?? emptyCollection()
    );
  }, [data, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const visibility = showParcels ? 'visible' : 'none';
    for (const id of ['parcels-fill', 'parcels-outline', 'selected-parcel']) map.setLayoutProperty(id, 'visibility', visibility);
    if (!showParcels) parcelPopupRef.current?.remove();
  }, [showParcels, ready]);

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

  // After the address effect: picking a suggestion clears the address
  // (whose effect removes its popup) and then opens this one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('suggestions') as GeoJSONSource).setData(suggestionPoints(suggestions));
    (map.getSource('suggestion-footprints') as GeoJSONSource).setData(suggestionFootprints(data.buildings, suggestions));
  }, [suggestions, data, ready]);

  // The selected suggestion: its house outlined, a popup, and the map moved there.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource('selected-suggestion') as GeoJSONSource;
    if (!selectedSuggestion) {
      source.setData(emptyCollection());
      if (!selected) popupRef.current?.remove();
      return;
    }
    const house = data.buildings.features.find((f) => f.properties.id === selectedSuggestion.building);
    source.setData({
      type: 'FeatureCollection',
      features: house ? [{ ...(house as unknown as GeoJSON.Feature), properties: {} }] : [],
    });
    const at: [number, number] = [selectedSuggestion.longitude, selectedSuggestion.latitude];
    popupRef.current = new Popup({ offset: 10, closeButton: false, maxWidth: '280px' })
      .setLngLat(at)
      .setText(describeSuggestion(selectedSuggestion))
      .addTo(map);
    if (map.getZoom() < 16) map.flyTo({ center: at, zoom: 17 });
  }, [selectedSuggestion, selected, data, ready]);

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
