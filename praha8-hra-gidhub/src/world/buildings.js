import * as THREE from 'three';

// One merged mesh per chunk: flat-shaded extruded footprints, no textures.
export function buildBuildings(list) {
  const pos = [];
  for (const { ring, h } of list) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n];
      pos.push(ax, 0, az, bx, 0, bz, bx, h, bz, ax, 0, az, bx, h, bz, ax, h, az);
    }
    const vs = ring.map(([x, z]) => new THREE.Vector2(x, z));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(vs, []))
      pos.push(vs[a].x, h, vs[a].y, vs[b].x, h, vs[b].y, vs[c].x, h, vs[c].y);
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xcccccc, side: THREE.DoubleSide }));
}
