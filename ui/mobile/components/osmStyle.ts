import type { StyleSpecification } from 'maplibre-gl';

// MapLibre's own demotiles style has no street-level detail outside a
// handful of demo areas. OpenStreetMap's raster tiles have full worldwide
// coverage and need no API key (fine for this dev tool's traffic level;
// swap for a hosted vector style/API key before any real production use).
export const OSM_RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};
