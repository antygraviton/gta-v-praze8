/**
 * Procedural vehicle model builder (no external assets).
 *
 * Returns the visual root (follows the chassis body), four separate wheel groups
 * (positioned by Vehicle in world space), a full drivable interior (dashboard,
 * steering wheel, seats, door cards, headliner, instrument cluster canvas, center screen).
 *
 * root (origin = chassis center of mass)
 *   └─ ground (offset -cgHeight so model coordinates are measured from the ground)
 */
import * as THREE from 'three';
import { hullHalfWidth } from './vehicleSpecs.js';

// ---------- small helpers ----------

function stdMat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.1, ...opts });
}

function box(w, h, d, material, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

/** Thin box stretched between two points. */
function beam(a, b, thickness, material) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(thickness, thickness, len), material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.lookAt(b);
  return m;
}

function quadGeometry(a, b, c, d) {
  const g = new THREE.BufferGeometry().setFromPoints([a, b, c, d]);
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function toTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function randomPlateText() {
  const L = 'ABCDEFGHJKLMNPRSTUVXYZ';
  const r = (n) => Math.floor(Math.random() * n);
  return `${1 + r(9)}${L[r(L.length)]}${L[r(L.length)]} ${1000 + r(9000)}`;
}

function plateMaterial(text) {
  const c = makeCanvas(256, 64);
  const g = c.getContext('2d');
  g.fillStyle = '#f5f5f0';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#1f4fa8';
  g.fillRect(0, 0, 28, 64);
  g.fillStyle = '#ffffff';
  g.font = 'bold 15px sans-serif';
  g.textAlign = 'center';
  g.fillText('CZ', 14, 56);
  g.fillStyle = '#111111';
  g.font = 'bold 42px monospace';
  g.fillText(text, 146, 46);
  g.strokeStyle = '#222222';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 253, 61);
  return new THREE.MeshBasicMaterial({ map: toTexture(c) });
}

function quiltedTexture(baseHex, lineHex) {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.fillStyle = baseHex;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = lineHex;
  g.lineWidth = 2;
  for (let i = -128; i < 256; i += 32) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 128, 128); g.stroke();
    g.beginPath(); g.moveTo(i + 128, 0); g.lineTo(i, 128); g.stroke();
  }
  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  return t;
}

function mapTexture() {
  const c = makeCanvas(256, 150);
  const g = c.getContext('2d');
  g.fillStyle = '#0d1824';
  g.fillRect(0, 0, 256, 150);
  g.fillStyle = '#17324a';
  g.beginPath(); g.moveTo(0, 110); g.bezierCurveTo(80, 90, 160, 140, 256, 100); g.lineTo(256, 130); g.bezierCurveTo(160, 160, 80, 120, 0, 140); g.fill();
  g.strokeStyle = '#33506f';
  g.lineWidth = 2;
  for (let i = 0; i < 9; i++) {
    g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32 + 30, 150); g.stroke();
  }
  for (let j = 0; j < 5; j++) {
    g.beginPath(); g.moveTo(0, j * 32 + 10); g.lineTo(256, j * 32 - 6); g.stroke();
  }
  g.strokeStyle = '#4aa3ff';
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(30, 140); g.lineTo(110, 80); g.lineTo(190, 60); g.lineTo(230, 20); g.stroke();
  g.fillStyle = '#3ddc84';
  g.beginPath(); g.moveTo(190, 70); g.lineTo(182, 52); g.lineTo(198, 52); g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 14px sans-serif';
  g.fillText('Karlín', 10, 20);
  g.fillText('08:57', 205, 144);
  return toTexture(c);
}

// ---------- instrument cluster ----------

function drawDial(g, cx, cy, r, frac, ticks, redFrom) {
  const a0 = Math.PI * 0.75;
  const a1 = Math.PI * 2.25;
  const f = Math.max(0, Math.min(frac, 1));
  g.lineWidth = 7;
  g.strokeStyle = '#1c2a38';
  g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
  const split = Math.min(f, redFrom);
  g.strokeStyle = '#37c8ff';
  g.beginPath(); g.arc(cx, cy, r, a0, a0 + (a1 - a0) * split); g.stroke();
  if (f > redFrom) {
    g.strokeStyle = '#ff4040';
    g.beginPath(); g.arc(cx, cy, r, a0 + (a1 - a0) * redFrom, a0 + (a1 - a0) * f); g.stroke();
  }
  g.lineWidth = 2;
  g.strokeStyle = '#8aa0b0';
  for (let i = 0; i <= ticks; i++) {
    const a = a0 + ((a1 - a0) * i) / ticks;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (r - 16), cy + Math.sin(a) * (r - 16));
    g.lineTo(cx + Math.cos(a) * (r - 7), cy + Math.sin(a) * (r - 7));
    g.stroke();
  }
  const a = a0 + (a1 - a0) * f;
  g.strokeStyle = '#ff7a1a';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(cx + Math.cos(a) * r * 0.25, cy + Math.sin(a) * r * 0.25);
  g.lineTo(cx + Math.cos(a) * (r - 20), cy + Math.sin(a) * (r - 20));
  g.stroke();
}

/** Redraws the instrument cluster canvas. t = { speedKmh, rpm, redline, maxKmh, gearLabel } */
export function drawCluster(cl, t) {
  const g = cl.ctx;
  const w = cl.canvas.width;
  const h = cl.canvas.height;
  g.fillStyle = '#05080c';
  g.fillRect(0, 0, w, h);
  drawDial(g, 100, 100, 76, t.rpm / t.redline, 8, 0.86);
  drawDial(g, w - 100, 100, 76, t.speedKmh / t.maxKmh, 10, 2);
  g.fillStyle = '#e8f4ff';
  g.textAlign = 'center';
  g.font = 'bold 64px sans-serif';
  g.fillText(String(Math.round(t.speedKmh)), w / 2, 110);
  g.font = '18px sans-serif';
  g.fillStyle = '#7fa3bd';
  g.fillText('km/h', w / 2, 134);
  g.font = 'bold 34px sans-serif';
  g.fillStyle = '#3ddc84';
  g.fillText(t.gearLabel, w / 2, 176);
  cl.texture.needsUpdate = true;
}

// ---------- wheels ----------

function buildWheel(spec) {
  const R = spec.wheelRadius;
  const w = spec.wheelWidth;
  const group = new THREE.Group();
  const tyreMat = stdMat(0x131313, { roughness: 0.92 });
  const rimMat = stdMat(spec.rim.color, { metalness: 0.8, roughness: 0.3 });
  const discMat = stdMat(0x2a2b2e, { metalness: 0.5, roughness: 0.5 });

  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(R, R, w, 24), tyreMat);
  tyre.rotation.z = Math.PI / 2;
  group.add(tyre);

  const disc = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.66, R * 0.66, w + 0.004, 20), discMat);
  disc.rotation.z = Math.PI / 2;
  group.add(disc);

  for (let i = 0; i < spec.rim.spokes; i++) {
    const pivot = new THREE.Group();
    pivot.rotation.x = (i / spec.rim.spokes) * Math.PI * 2;
    const spoke = box(w * 0.55, R * 0.62, 0.04, rimMat, 0, R * 0.36, 0);
    pivot.add(spoke);
    group.add(pivot);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.16, R * 0.16, w + 0.01, 12), rimMat);
  hub.rotation.z = Math.PI / 2;
  group.add(hub);
  return group;
}

// ---------- main builder ----------

export function buildVehicleModel(spec, opts = {}) {
  const b = spec.body;
  const hullHalf = hullHalfWidth(spec);
  const hullW = hullHalf * 2;
  const cw = hullW - 0.24; // cabin (glass) width
  const belt = b.hoodY;
  const ix = spec.interior;
  const color = opts.color ?? spec.color;

  const root = new THREE.Group();
  const ground = new THREE.Group();
  ground.position.y = -spec.cgHeight;
  root.add(ground);

  // materials
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color, metalness: spec.paint.metalness, roughness: spec.paint.roughness,
    clearcoat: 1, clearcoatRoughness: 0.1,
  });
  const trimMat = stdMat(0x0e0f11, { roughness: 0.8 });
  const darkMat = stdMat(ix.dark);
  const accentMat = stdMat(ix.accent, { metalness: 0.6, roughness: 0.35 });
  let seatMat;
  if (ix.quilted) {
    seatMat = stdMat(0xffffff, { map: quiltedTexture('#2a2c30', '#8c8f95'), roughness: 0.6 });
  } else {
    seatMat = stdMat(ix.seat, { roughness: 0.8 });
  }
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a1016, metalness: 0.2, roughness: 0.05, transparent: true,
    opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
  });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xe8eeff, emissive: 0xcfe0ff, emissiveIntensity: 0.25 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1010, emissiveIntensity: 0.3 });

  // ----- hull (extruded side profile, with a cabin "tub") -----
  const shape = new THREE.Shape();
  shape.moveTo(b.zRear, b.bottomY);
  shape.lineTo(b.zRear, b.rearTopY);
  shape.lineTo(b.z4, b.trunkY);
  shape.lineTo(b.z4, b.floorY);
  shape.lineTo(b.z1, b.floorY);
  shape.lineTo(b.z1, b.hoodY);
  shape.lineTo(b.zFront, b.noseY);
  shape.lineTo(b.zFront, b.bottomY);
  shape.closePath();
  const bev = 0.07;
  const depth = hullW - 2 * bev;
  const hullGeo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelOffset: -bev,
    bevelSegments: 3, curveSegments: 1, steps: 1,
  });
  hullGeo.translate(0, 0, -depth / 2);
  hullGeo.rotateY(-Math.PI / 2); // shape x -> world z, extrusion -> world x
  ground.add(new THREE.Mesh(hullGeo, bodyMat));

  // ----- door walls and beltline caps -----
  const doorLen = b.z1 - b.z4;
  const doorMidZ = (b.z1 + b.z4) / 2;
  for (const s of [1, -1]) {
    ground.add(box(0.06, belt - b.floorY, doorLen, bodyMat, s * (hullHalf - 0.03), (belt + b.floorY) / 2, doorMidZ));
    ground.add(box(hullHalf - cw / 2, 0.04, doorLen, bodyMat, s * (hullHalf + cw / 2) / 2, belt - 0.02, doorMidZ));
    // inner door card + armrest
    ground.add(box(0.05, belt - b.floorY - 0.02, doorLen - 0.1, darkMat, s * (hullHalf - 0.09), (belt + b.floorY) / 2, doorMidZ));
    ground.add(box(0.09, 0.06, 0.5, accentMat, s * (hullHalf - 0.13), belt - 0.14, spec.eye.z));
  }

  // ----- greenhouse: glass, pillars, roof -----
  const topHalf = cw / 2 - 0.12;
  const rearBase = b.trunkY;
  const windshield = new THREE.Mesh(
    quadGeometry(
      new THREE.Vector3(cw / 2, belt, b.z1), new THREE.Vector3(-cw / 2, belt, b.z1),
      new THREE.Vector3(-topHalf, b.roofY, b.z2), new THREE.Vector3(topHalf, b.roofY, b.z2),
    ), glassMat);
  const rearWindow = new THREE.Mesh(
    quadGeometry(
      new THREE.Vector3(cw / 2, rearBase, b.z4), new THREE.Vector3(-cw / 2, rearBase, b.z4),
      new THREE.Vector3(-topHalf, b.roofY, b.z3), new THREE.Vector3(topHalf, b.roofY, b.z3),
    ), glassMat);
  ground.add(windshield, rearWindow);

  const sideShape = new THREE.Shape();
  sideShape.moveTo(b.z1, belt);
  sideShape.lineTo(b.z2, b.roofY);
  sideShape.lineTo(b.z3, b.roofY);
  sideShape.lineTo(b.z4, rearBase);
  sideShape.closePath();
  for (const s of [1, -1]) {
    const geo = new THREE.ShapeGeometry(sideShape);
    geo.rotateY(-Math.PI / 2); // shape x -> world z
    const m = new THREE.Mesh(geo, glassMat);
    m.position.x = s * (cw / 2 - 0.02);
    ground.add(m);

    const P = (x, y, z) => new THREE.Vector3(x, y, z);
    // A pillar, C pillar, roof rail
    ground.add(beam(P(s * cw / 2, belt, b.z1), P(s * (cw / 2 - 0.04), b.roofY, b.z2), 0.09, trimMat));
    ground.add(beam(P(s * cw / 2, rearBase, b.z4), P(s * (cw / 2 - 0.04), b.roofY, b.z3), 0.15, trimMat));
    ground.add(beam(P(s * (cw / 2 - 0.04), b.roofY, b.z2), P(s * (cw / 2 - 0.04), b.roofY, b.z3), 0.07, trimMat));
    if (spec.bPillarZ != null) {
      ground.add(beam(P(s * cw / 2, belt, spec.bPillarZ), P(s * (cw / 2 - 0.04), b.roofY, spec.bPillarZ), 0.11, trimMat));
    }
  }
  const roofLen = b.z2 - b.z3;
  const roofMidZ = (b.z2 + b.z3) / 2;
  ground.add(box(cw - 0.04, 0.05, roofLen, bodyMat, 0, b.roofY + 0.025, roofMidZ));
  ground.add(box(cw - 0.1, 0.02, roofLen, darkMat, 0, b.roofY - 0.015, roofMidZ)); // headliner

  // ----- interior -----
  const eye = spec.eye;
  const xd = eye.x; // driver x

  // floor, rear bulkhead, parcel shelf
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(hullW - 0.12, doorLen - 0.05), darkMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, b.floorY + 0.01, doorMidZ);
  ground.add(floor);
  ground.add(box(hullW - 0.1, belt - b.floorY, 0.04, darkMat, 0, (belt + b.floorY) / 2, b.z4 + 0.03));
  ground.add(box(cw - 0.1, 0.03, 0.4, darkMat, 0, belt - 0.02, b.z4 + 0.2));

  // dashboard
  const dashD = 0.42;
  ground.add(box(cw - 0.06, 0.16, dashD, darkMat, 0, belt - 0.06, b.z1 - dashD / 2));
  ground.add(box(cw - 0.06, belt - 0.14 - b.floorY, 0.2, darkMat, 0, (b.floorY + belt - 0.14) / 2, b.z1 - 0.1));
  ground.add(box(0.5, 0.1, 0.22, darkMat, xd, belt + 0.17, b.z1 - 0.28)); // binnacle hood
  // wheel-well covers where wheels reach into the cabin
  const R = spec.wheelRadius;
  const wb = spec.wheelbase / 2;
  for (const zw of [wb, -wb]) {
    if (zw > b.z4 && zw < b.z1) {
      for (const s of [1, -1]) {
        const h = 2 * R + 0.03 - b.floorY;
        ground.add(box(spec.wheelWidth + 0.1, h, 2 * R + 0.14, darkMat, s * (spec.track / 2), b.floorY + h / 2, zw));
      }
    }
  }

  // screens (made to face the driver's eye)
  const eyeWorld = new THREE.Vector3(eye.x, eye.y - spec.cgHeight, eye.z);
  const cluster = { canvas: makeCanvas(512, 192) };
  cluster.ctx = cluster.canvas.getContext('2d');
  cluster.texture = toTexture(cluster.canvas);
  const clusterMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.128), new THREE.MeshBasicMaterial({ map: cluster.texture }));
  clusterMesh.position.set(xd, belt + 0.075, b.z1 - 0.34);
  ground.add(clusterMesh);
  ground.updateMatrixWorld(true);
  clusterMesh.lookAt(eyeWorld);

  const sc = spec.screen;
  const centerScreen = new THREE.Mesh(new THREE.PlaneGeometry(sc.w, sc.h), new THREE.MeshBasicMaterial({ map: mapTexture() }));
  centerScreen.position.set(0, belt + sc.y + sc.h / 2, b.z1 - 0.2);
  ground.add(centerScreen);
  ground.updateMatrixWorld(true);
  centerScreen.lookAt(eyeWorld);
  ground.add(box(sc.w + 0.02, sc.h + 0.02, 0.02, darkMat, 0, belt + sc.y + sc.h / 2, b.z1 - 0.19));

  // center console + shifter
  const consoleZ0 = b.z1 - 0.4;
  const consoleZ1 = eye.z - 0.1;
  ground.add(box(0.26, 0.22, consoleZ0 - consoleZ1, darkMat, 0, b.floorY + 0.17, (consoleZ0 + consoleZ1) / 2));
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), accentMat);
  knob.position.set(0, b.floorY + 0.36, consoleZ0 - 0.25);
  ground.add(knob);

  // pedals
  ground.add(box(0.09, 0.02, 0.16, accentMat, xd + 0.04, b.floorY + 0.14, b.z1 - 0.3));
  ground.add(box(0.07, 0.02, 0.18, accentMat, xd - 0.12, b.floorY + 0.14, b.z1 - 0.3));

  // seats
  const seatX = [xd, -xd];
  for (const sx of seatX) {
    const baseZ = eye.z - 0.05;
    const base = box(0.5, 0.14, 0.52, seatMat, sx, b.floorY + 0.28, baseZ);
    const back = box(0.5, 0.6, 0.12, seatMat, sx, b.floorY + 0.62, eye.z - 0.38);
    back.rotation.x = -0.18;
    const head = box(0.24, 0.2, 0.1, seatMat, sx, b.floorY + 1.0, eye.z - 0.42);
    ground.add(base, back, head);
  }
  if (spec.rearSeat) {
    ground.add(box(cw - 0.2, 0.14, 0.5, seatMat, 0, b.floorY + 0.28, eye.z - 0.95));
    const rb = box(cw - 0.2, 0.55, 0.12, seatMat, 0, b.floorY + 0.58, eye.z - 1.25);
    rb.rotation.x = -0.18;
    ground.add(rb);
  }

  // rear-view mirror
  ground.add(box(0.22, 0.06, 0.03, darkMat, 0, belt + (b.roofY - belt) * 0.82, b.z1 + (b.z2 - b.z1) * 0.82 - 0.06));

  // steering wheel (outer: tilt, inner: rotates with steering)
  const sw = spec.steeringWheel;
  const swOuter = new THREE.Group();
  swOuter.position.set(sw.x, sw.y, sw.z);
  swOuter.rotation.x = sw.tilt;
  const swSpin = new THREE.Group();
  swOuter.add(swSpin);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(sw.radius, 0.018, 8, 28), stdMat(0x101012, { roughness: 0.6 }));
  swSpin.add(rim);
  const swHub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.04, 14), accentMat);
  swHub.rotation.x = Math.PI / 2;
  swSpin.add(swHub);
  swSpin.add(box(sw.radius * 2, 0.026, 0.02, darkMat, 0, 0, 0));
  swSpin.add(box(0.026, sw.radius, 0.02, darkMat, 0, -sw.radius / 2, 0));
  ground.add(swOuter);

  // ----- exterior details -----
  const wheelX = spec.track / 2;
  // lights
  const headW = spec.id === 'hypercar' ? 0.34 : 0.3;
  for (const s of [1, -1]) {
    ground.add(box(headW, 0.08, 0.06, headMat, s * (hullHalf - 0.3), b.noseY - 0.03, b.zFront - 0.02));
    ground.add(box(0.4, 0.08, 0.05, tailMat, s * (hullHalf - 0.3), b.rearTopY - 0.1, b.zRear + 0.01));
    // mirrors
    ground.add(box(0.06, 0.1, 0.16, bodyMat, s * (hullHalf + 0.07), belt + 0.08, b.z1 - 0.22));
  }
  // grille / intake
  if (spec.id === 'hypercar') {
    ground.add(box(0.64, 0.34, 0.06, trimMat, 0, b.noseY - 0.18, b.zFront - 0.01));
    const badge = new THREE.Mesh(new THREE.CircleGeometry(0.035, 16), stdMat(0xc01818, { emissive: 0x300000 }));
    badge.position.set(0, b.noseY - 0.02, b.zFront + 0.025);
    ground.add(badge);
  } else {
    ground.add(box(hullW * 0.55, 0.14, 0.05, trimMat, 0, b.noseY - 0.2, b.zFront - 0.01));
  }
  if (spec.id === 'citycar') {
    ground.add(box(hullW - 0.06, 0.16, 0.07, trimMat, 0, b.bottomY + 0.1, b.zFront - 0.02));
    ground.add(box(hullW - 0.06, 0.16, 0.07, trimMat, 0, b.bottomY + 0.1, b.zRear + 0.02));
  }
  // plates
  if (spec.plate) {
    const text = opts.plate ?? randomPlateText();
    const pf = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.11), plateMaterial(text));
    pf.position.set(0, b.bottomY + 0.2, b.zFront + 0.003);
    const pr = pf.clone();
    pr.rotation.y = Math.PI;
    pr.position.set(0, b.bottomY + 0.28, b.zRear - 0.003);
    ground.add(pf, pr);
  }

  // ----- wheels (separate groups, positioned in world space by Vehicle) -----
  const wheels = [];
  for (let i = 0; i < 4; i++) wheels.push(buildWheel(spec));

  // ----- api -----
  let brakeOn = false;
  let lightsOn = false;
  return {
    root,
    ground,
    wheels,
    cluster,
    steeringSpin: swSpin,
    bodyMat,
    eye: new THREE.Vector3(eye.x, eye.y - spec.cgHeight, eye.z),
    exitLocal: new THREE.Vector3(hullHalf + 0.85, -spec.cgHeight, 0.2),
    wheelX,
    setBrakeLights(on) {
      if (on === brakeOn) return;
      brakeOn = on;
      tailMat.emissiveIntensity = on ? 3 : lightsOn ? 1 : 0.3;
    },
    setHeadlights(on) {
      lightsOn = on;
      headMat.emissiveIntensity = on ? 2.5 : 0.25;
      tailMat.emissiveIntensity = brakeOn ? 3 : on ? 1 : 0.3;
    },
    damage(fraction) {
      // fraction 0..1: darken the paint as the car gets wrecked
      const k = 1 - 0.7 * fraction;
      bodyMat.color.setHex(color).multiplyScalar(k);
    },
    dispose() {
      const killMat = (m) => {
        if (m.map) m.map.dispose();
        m.dispose();
      };
      const walk = (o) => o.traverse((n) => {
        if (n.geometry) n.geometry.dispose();
        if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(killMat);
      });
      walk(root);
      wheels.forEach(walk);
    },
  };
}
