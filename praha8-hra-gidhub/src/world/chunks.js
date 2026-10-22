import * as THREE from 'three';
import { project } from './geo.js';
import { buildBuildings } from './buildings.js';
import { buildRoads } from './roads.js';
import { buildTrees } from './trees.js';

export const CHUNK = 500; // meters
export const key = (cx, cz) => cx + ',' + cz;
const cOf = (x, z) => [Math.floor(x / CHUNK), Math.floor(z / CHUNK)];
const ZONE = (t) => t.landuse === 'forest' || t.natural === 'wood' || t.leisure === 'park';

// Sort GeoJSON features into chunk buckets (projected to meters).
export function bucket(geojson) {
  const map = new Map();
  const get = (x, z) => { const [cx, cz] = cOf(x, z), k = key(cx, cz);
    if (!map.has(k)) map.set(k, { cx, cz, b: [], r: [], t: [], z: [] }); return map.get(k); };
  for (const f of geojson.features) {
    const t = f.properties || {}, g = f.geometry;
    if (g.type === 'Point') { if (t.natural === 'tree') { const [x, z] = project(...g.coordinates); get(x, z).t.push([x, z]); } continue; }
    if (g.type === 'Polygon') {
      const ring = g.coordinates[0].slice(0, -1).map(c => project(...c));
      if (ring.length < 3) continue;
      const [x, z] = ring[0];
      if (t.building) {
        const h = parseFloat(t.height) || (parseFloat(t['building:levels']) * 3.2) || 10;
        get(x, z).b.push({ ring, h: Math.max(h, 4) });
      } else if (ZONE(t)) get(x, z).z.push(ring);
    } else if (g.type === 'LineString' && t.highway && t.tunnel !== 'yes') {
      let piece = [], cur = null;
      for (const c of g.coordinates) {
        const p = project(...c), ch = get(p[0], p[1]);
        if (cur && ch !== cur) { piece.push(p); cur.r.push({ pts: piece, type: t.highway }); piece = []; }
        piece.push(p); cur = ch;
      }
      if (piece.length > 1) cur.r.push({ pts: piece, type: t.highway });
    }
  }
  return map;
}

export class Chunk {
  constructor(data) {
    this.data = data;
    this.group = new THREE.Group();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(CHUNK, CHUNK).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x999999 }));
    ground.position.set((data.cx + 0.5) * CHUNK, 0, (data.cz + 0.5) * CHUNK);
    this.group.add(ground);
    for (const m of [buildBuildings(data.b), buildRoads(data.r), buildTrees(data.t, data.z)]) if (m) this.group.add(m);
  }
  dispose() {
    this.group.traverse(o => { o.geometry?.dispose(); if (o.material && o.material.dispose && !o.isInstancedMesh) o.material.dispose(); });
  }
}
