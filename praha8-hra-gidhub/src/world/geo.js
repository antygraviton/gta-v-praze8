// Projection: lon/lat -> local meters. Origin (0,0,0) = center of Karlin. +X east, -Z north.
const LAT0 = 50.0925, LON0 = 14.4504;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KZ = 110574;
export const project = (lon, lat) => [(lon - LON0) * KX, -(lat - LAT0) * KZ];
