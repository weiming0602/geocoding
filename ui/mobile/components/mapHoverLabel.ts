import { Map as MapLibreMap, Marker, Popup } from 'maplibre-gl';

/**
 * Shows `text` in a popup above a marker while the pointer hovers over it.
 * Returns the Popup so callers whose marker persists across renders (e.g.
 * a single-result map that just moves) can update the label via
 * `popup.setText(...)` instead of recreating the marker.
 */
export function attachHoverLabel(marker: Marker, map: MapLibreMap, text: string): Popup {
  const popup = new Popup({ offset: 25, closeButton: false, closeOnClick: false }).setText(text);
  const element = marker.getElement();

  element.addEventListener('mouseenter', () => {
    popup.setLngLat(marker.getLngLat()).addTo(map);
  });
  element.addEventListener('mouseleave', () => {
    popup.remove();
  });

  return popup;
}
