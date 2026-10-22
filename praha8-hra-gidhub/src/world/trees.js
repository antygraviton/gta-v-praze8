import * as THREE from 'three';

const mat = new THREE.MeshBasicMaterial({ color: 0x22aa22 });
const geo = new THREE.CylinderGeometry(0.25, 0.25, 6, 5);

// Tree markers: single trees = green sticks, forests/parks = green outline loops.
export function buildTrees(points, zones) {
  const g = new THREE.Group();
  if (points.length) {
    const m = new THREE.InstancedMesh(geo, mat, points.length);
    const d = new THREE.Object3D();
    points.forEach(([x, z], i) => { d.position.set(x, 3, z); d.updateMatrix(); m.setMatrixAt(i, d.matrix); });
    g.add(m);
  }
  for (const ring of zones) {
    const p = ring.flatMap(([x, z]) => [x, 0.3, z]);
    const l = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p, 3)), mat);
    g.add(l);
  }
  return g.children.length ? g : null;
}
