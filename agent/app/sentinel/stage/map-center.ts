/** The map camera's center, kept by Stage so the rail (plan "Add drone") can place things in view. */
let center: [number, number] | null = null;

export function setMapCenter(lon: number, lat: number) {
  center = [lon, lat];
}

export function getMapCenter(): [number, number] | null {
  return center;
}
