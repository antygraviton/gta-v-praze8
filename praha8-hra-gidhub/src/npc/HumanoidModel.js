/**
 * Procedural low-poly humanoids. Geometry and materials are shared between all instances.
 * Origin = point between the feet on the ground, facing +Z, ~1.75 m tall.
 *
 * Poses: stand, walk, run, phone, aim, handsUp, sit, dead.
 * Call model.setPose(name) then model.animate(phase, amplitude) every frame.
 */
import * as THREE from 'three';
import { pick } from './npcCommon.js';

const geoCache = new Map();
const matCache = new Map();

const geo = (key, make) => {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
};

const mat = (color, rough = 0.85) => {
  const key = `${color}_${rough}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
    matCache.set(key, m);
  }
  return m;
};

export function disposeHumanoidCache() {
  geoCache.forEach((g) => g.dispose());
  matCache.forEach((m) => m.dispose());
  geoCache.clear();
  matCache.clear();
}

const SKIN = [0xf1c9a5, 0xd9a47c, 0xa8744f, 0x7a4b2e, 0x4e2f1d];
const HAIR = [0x111111, 0x3a2a1a, 0x6b4a2b, 0xc9a24a, 0x8a8a8a];
const TOPS = [0x3b6ea5, 0xa83232, 0x2f7d4f, 0xd9d9d9, 0x222222, 0xc9a227, 0x7b4fa3, 0xe07b39];
const PANTS = [0x2b3a55, 0x1d1d1f, 0x4a4036, 0x5c6672, 0x30405a];

/** Archetype table. */
const ARCH = {
  civilian_m: { tops: TOPS, pants: PANTS },
  casual: { tops: TOPS, pants: [0x2b3a55, 0x3a5a8a, 0x1d1d1f] },
  civilian_f: { tops: [0x1e1e1e, 0xc23b5a, 0xe8d8c8, 0x3b6ea5], pantsColor: 0xb8392b, skirt: true, female: true, longHair: true, hairPick: [0xc9a24a, 0x3a2a1a, 0x111111, 0xe0c27a] },
  shirtless: { topSkin: true, pants: [0xb8a98a, 0xa89878], hairColor: 0x111111 },
  bearded: { topColor: 0xd9cfb8, longShirt: true, longSleeve: true, pants: [0x3b5a8a], beard: true, longHair: true, hairPick: [0x3a2a1a, 0x6b4a2b] },
  cop: { topColor: 0x1c2a44, pantsColor: 0x14203a, longSleeve: false, hat: true, badge: true, belt: true, hairColor: 0x2a2018 },
};

function part(shape, material, sx, sy, sz, x, y, z) {
  const m = new THREE.Mesh(shape, material);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  return m;
}

export function createHumanoid(archetype = 'casual', opts = {}) {
  const A = ARCH[archetype] ?? ARCH.casual;
  const skin = opts.skin ?? pick(SKIN);
  const topColor = A.topSkin ? skin : A.topColor ?? pick(A.tops);
  const pantsColor = A.pantsColor ?? pick(A.pants);
  const hairColor = A.hairColor ?? pick(A.hairPick ?? HAIR);
  const female = !!A.female;

  const skinM = mat(skin);
  const topM = mat(topColor);
  const pantsM = mat(pantsColor);
  const shoeM = mat(0x161616);
  const hairM = mat(hairColor);
  const darkM = mat(0x0c0c0e, 0.5);

  const BOX = geo('box', () => new THREE.BoxGeometry(1, 1, 1));
  const SPH = geo('sph', () => new THREE.SphereGeometry(1, 12, 10));
  const CYL = geo('cyl', () => new THREE.CylinderGeometry(1, 1, 1, 12));
  const CAP = geo('cap', () => new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2));

  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const body = new THREE.Group();
  root.add(body);

  const bw = female ? 0.38 : 0.44;
  body.add(part(BOX, topM, bw, 0.58, 0.24, 0, 1.2, 0)); // torso
  body.add(part(BOX, pantsM, bw - 0.04, 0.18, 0.23, 0, 0.93, 0)); // pelvis
  if (A.skirt) body.add(part(CYL, pantsM, 0.22, 0.3, 0.17, 0, 0.8, 0));
  if (A.longShirt) body.add(part(BOX, topM, bw + 0.02, 0.5, 0.26, 0, 0.75, 0));
  if (A.belt) {
    body.add(part(BOX, darkM, bw + 0.02, 0.06, 0.26, 0, 0.95, 0));
    body.add(part(BOX, darkM, 0.08, 0.16, 0.1, -0.24, 0.88, 0));
  }
  if (A.badge) body.add(part(BOX, mat(0xd4b13a, 0.4), 0.05, 0.06, 0.01, 0.1, 1.38, 0.125));

  const makeLeg = (side) => {
    const g = new THREE.Group();
    g.position.set(side * 0.1, 0.9, 0);
    g.add(part(BOX, pantsM, 0.17, 0.86, 0.2, 0, -0.43, 0));
    g.add(part(BOX, shoeM, 0.18, 0.08, 0.28, 0, -0.88, 0.04));
    body.add(g);
    return g;
  };
  const legL = makeLeg(1);
  const legR = makeLeg(-1);

  const makeArm = (side) => {
    const sh = new THREE.Group();
    sh.position.set(side * (bw / 2 + 0.06), 1.46, 0);
    const sleeve = A.topSkin ? skinM : topM;
    sh.add(part(BOX, sleeve, 0.1, 0.3, 0.12, 0, -0.15, 0));
    const el = new THREE.Group();
    el.position.y = -0.3;
    el.add(part(BOX, A.longSleeve ? topM : skinM, 0.09, 0.28, 0.1, 0, -0.14, 0));
    el.add(part(BOX, skinM, 0.08, 0.08, 0.09, 0, -0.31, 0));
    sh.add(el);
    body.add(sh);
    return { sh, el };
  };
  const armL = makeArm(1);
  const armR = makeArm(-1);

  const phone = part(BOX, darkM, 0.04, 0.1, 0.015, 0, -0.3, 0.06);
  phone.visible = false;
  armR.el.add(phone);
  const gun = part(BOX, darkM, 0.05, 0.1, 0.18, 0, -0.34, 0.08);
  gun.visible = false;
  armR.el.add(gun);

  // head
  body.add(part(CYL, skinM, 0.045, 0.08, 0.045, 0, 1.52, 0));
  body.add(part(SPH, skinM, 0.105, 0.12, 0.11, 0, 1.63, 0));
  if (A.hat) {
    body.add(part(CYL, mat(0x101a30), 0.125, 0.06, 0.125, 0, 1.75, 0));
    body.add(part(BOX, darkM, 0.2, 0.015, 0.13, 0, 1.72, 0.07));
  } else if (archetype === 'shirtless') {
    body.add(part(BOX, hairM, 0.03, 0.05, 0.16, 0, 1.76, 0)); // mohawk strip
  } else {
    body.add(part(CAP, hairM, 0.115, 0.11, 0.12, 0, 1.65, 0));
  }
  if (A.longHair) body.add(part(BOX, hairM, 0.26, female ? 0.42 : 0.36, 0.08, 0, 1.52, -0.09));
  if (A.beard) body.add(part(BOX, hairM, 0.12, 0.1, 0.06, 0, 1.57, 0.09));

  let pose = 'stand';

  const api = {
    root,
    body,
    height: 1.75,
    get pose() {
      return pose;
    },
    setPose(p) {
      if (p === pose) return;
      pose = p;
      gun.visible = p === 'aim';
      phone.visible = p === 'phone';
    },
    /** phase = walk cycle angle (rad), amp = 0..1 stride amplitude */
    animate(phase, amp) {
      const s = Math.sin(phase);
      const swing = pose === 'run' ? 1.3 : 0.75;
      let lL = 0, lR = 0, aLx = 0, aRx = 0, eL = -0.08, eR = -0.08, aLz = 0.04, aRz = -0.04;
      body.rotation.x = 0;
      switch (pose) {
        case 'run':
          body.rotation.x = 0.22;
          lL = s * swing * amp; lR = -lL;
          aLx = -lL * 0.9; aRx = -lR * 0.9;
          eL = eR = -0.9 * amp;
          break;
        case 'walk':
        case 'stand':
          lL = s * swing * amp; lR = -lL;
          aLx = -lL * 0.8; aRx = -lR * 0.8;
          break;
        case 'phone':
          lL = s * swing * amp; lR = -lL;
          aLx = -lL * 0.8;
          aRx = -0.8; eR = -2.0; aRz = 0.35;
          break;
        case 'aim':
          lL = s * swing * amp; lR = -lL;
          aRx = -1.5; eR = -0.05;
          aLx = -1.35; eL = -0.2; aLz = -0.15;
          break;
        case 'handsUp':
          aLx = aRx = -2.9; eL = eR = -0.25; aLz = 0.2; aRz = -0.2;
          break;
        case 'sit':
          lL = lR = -1.45;
          aLx = aRx = -1.05; eL = eR = -0.4;
          break;
        case 'dead':
          lL = 0.1; lR = -0.2;
          aLx = 0.3; aRx = -0.2; eL = eR = -0.3; aLz = 0.6; aRz = -0.5;
          break;
        default:
      }
      legL.rotation.x = lL;
      legR.rotation.x = lR;
      armL.sh.rotation.set(aLx, 0, aLz);
      armR.sh.rotation.set(aRx, 0, aRz);
      armL.el.rotation.x = eL;
      armR.el.rotation.x = eR;
    },
  };
  api.animate(0, 0);
  return api;
}

/**
 * Puts a seated humanoid into a vehicle's driver seat (vehicles module model).
 * Returns { model, remove() }. Call remove() before the vehicle is despawned.
 */
export function attachDriver(vehicle, archetype) {
  const m = createHumanoid(archetype);
  m.setPose('sit');
  m.animate(0, 0);
  const s = vehicle.spec;
  const sc = 0.8;
  m.root.scale.setScalar(sc);
  // head center ends up at eye height; hips sit in the seat
  m.root.position.set(s.eye.x, s.eye.y - 1.63 * sc, s.eye.z - 0.02);
  vehicle.model.ground.add(m.root);
  return {
    model: m,
    remove() {
      vehicle.model.ground.remove(m.root);
    },
  };
}
