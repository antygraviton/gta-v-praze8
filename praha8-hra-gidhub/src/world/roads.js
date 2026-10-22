import * as THREE from 'three';

const WIDTH = { motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8, residential: 6, unclassified: 6,
  service: 4, living_street: 5, pedestrian: 5, footway: 2, path: 1.5, cycleway: 2.5, track: 3, tram: 0 };

// One merged ribbon mesh per chunk. list = [{pts:[[x,z]...], type}]
export function buildRoads(list) {
  const pos = [], idx = [];
  for (const { pts, type } of list) {
    const w = (WIDTH[type] ?? 4) / 2;
    if (!w || pts.length < 2) continue;
    const y = type === 'footway' || type === 'path' || type === 'cycleway' ? 0.1 : 0.05;
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      pos.push(p[0] - dz * w, y, p[1] + dx * w, p[0] + dz * w, y, p[1] - dx * w);
      if (i) { const k = base + (i - 1) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x555555, side: THREE.DoubleSide }));
}
