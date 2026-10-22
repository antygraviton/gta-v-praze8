/**
 * Shared helpers of the NPC module: tunable config, math helpers, a tolerant adapter
 * for world.getNearestRoad(), a player tracker (fed only by events) and a view culler.
 *
 * Heading convention (same as the vehicles module): heading 0 = facing +Z,
 * forward = (sin h, cos h), left = (cos h, -sin h)  (+X is the left side).
 */
import * as THREE from 'three';

export const CONFIG = {
  pedestrians: { target: 26, spawnMin: 30, spawnMax: 80, despawn: 110 },
  traffic: { target: 9, spawnMin: 70, spawnMax: 140, despawn: 190, speed: [10, 15] },
  police: {
    carsPerLevel: [0, 1, 2, 3, 4, 5],
    chaseSpeed: [0, 20, 24, 28, 31, 34], // m/s per wanted level
    footSpeed: 5.2,
    shootRange: 45,
    maxFoot: [0, 3, 5, 7, 9, 11],
  },
  wanted: {
    levelHeat: [15, 45, 85, 135, 200], // heat needed for levels 1..5
    maxHeat: 260,
    unseenBeforeDecay: 12, // seconds without any cop seeing the player
    seeDistFoot: 60,
    seeDistCar: 80,
    points: {
      pedestrianHit: 12,
      pedestrianKilled: 30,
      assault: 8,
      copHit: 40,
      copKilled: 80,
      gunFired: 6,
      carjack: 18,
      vehicleCollision: 8,
      policeCarStolen: 45,
    },
  },
};

// ---------- math ----------

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function pickWeighted(pairs) {
  let total = 0;
  for (const [, w] of pairs) total += w;
  let r = Math.random() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

export function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** forward unit vector [x, z] of a heading */
export const fwd = (h) => [Math.sin(h), Math.cos(h)];
/** left unit vector [x, z] of a heading */
export const leftVec = (h) => [Math.cos(h), -Math.sin(h)];

// ---------- road query ----------

/**
 * Normalizes world.getNearestRoad(x, z). Expected result:
 *   { x, z, heading, width, distance }
 * (heading = road direction in radians, 0 = +Z; width = full road width in meters;
 *  distance = from the query point to the road center line). Alternative shapes such as
 *  { point:{x,z}, direction:{x,z} } are accepted. If no heading is given it is estimated.
 */
export class RoadQuery {
  constructor(world) {
    this.world = world;
    this._headingCache = new Map();
  }

  get available() {
    return typeof this.world?.getNearestRoad === 'function';
  }

  ground(x, z) {
    const f = this.world?.getGroundHeight;
    if (typeof f !== 'function') return 0;
    const y = f.call(this.world, x, z);
    return typeof y === 'number' && Number.isFinite(y) ? y : 0;
  }

  _raw(x, z) {
    if (!this.available) return null;
    let r;
    try {
      r = this.world.getNearestRoad(x, z);
    } catch (e) {
      return null;
    }
    if (!r) return null;
    const rx = r.x ?? r.point?.x ?? r.position?.x;
    const rz = r.z ?? r.point?.z ?? r.position?.z;
    if (typeof rx !== 'number' || typeof rz !== 'number') return null;
    return { src: r, x: rx, z: rz, distance: r.distance ?? Math.hypot(rx - x, rz - z) };
  }

  nearest(x, z) {
    const raw = this._raw(x, z);
    if (!raw) return null;
    const r = raw.src;
    let h = r.heading ?? r.angle;
    const dir = r.direction ?? r.tangent;
    if (typeof h !== 'number' && dir) h = Math.atan2(dir.x, dir.z ?? dir.y);
    const out = { x: raw.x, z: raw.z, heading: h, width: r.width ?? 7, distance: raw.distance };
    if (typeof out.heading !== 'number') out.heading = this._estimateHeading(out);
    return out;
  }

  _estimateHeading(r) {
    const key = `${Math.round(r.x / 4)},${Math.round(r.z / 4)}`;
    const cached = this._headingCache.get(key);
    if (cached !== undefined) return cached;
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 8;
      const [fx, fz] = fwd(a);
      const p = this._raw(r.x + fx * 10, r.z + fz * 10);
      const q = this._raw(r.x - fx * 10, r.z - fz * 10);
      if (!p || !q) continue;
      const score = p.distance + q.distance;
      if (score < bestScore) {
        bestScore = score;
        best = a;
      }
    }
    if (this._headingCache.size > 4000) this._headingCache.clear();
    this._headingCache.set(key, best);
    return best;
  }
}

// ---------- player tracker ----------

/** Knows where the player is, using only events (and the camera as a last resort). */
export class PlayerTracker {
  constructor(events, camera) {
    this.events = events;
    this.camera = camera;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.vehicle = null;
    this.dead = false;
    this._prev = new THREE.Vector3();
    this._foot = null;
    this._init = false;
    this._offs = [];
    this._on('player:position', (p) => {
      if (!this._foot) this._foot = new THREE.Vector3();
      this._foot.set(p.x, p.y ?? 0, p.z);
    });
    this._on('player:enterVehicle', (e) => {
      this.vehicle = e?.vehicle ?? null;
    });
    this._on('player:exitVehicle', (e) => {
      this.vehicle = null;
      if (e?.position) {
        if (!this._foot) this._foot = new THREE.Vector3();
        this._foot.set(e.position.x, e.position.y ?? 0, e.position.z);
      }
    });
    this._on('player:died', () => { this.dead = true; });
    this._on('player:respawn', () => { this.dead = false; });
  }

  get inVehicle() {
    return !!this.vehicle;
  }

  get speedAbs() {
    return this.vehicle ? Math.abs(this.vehicle.speed) : this.vel.length();
  }

  update(dt) {
    this._prev.copy(this.pos);
    if (this.vehicle) {
      this.vehicle.getPosition(this.pos);
    } else if (this._foot) {
      this.pos.copy(this._foot);
    } else {
      this.camera.getWorldPosition(this.pos);
      this.pos.y -= 1.6;
    }
    if (!this._init) {
      this._prev.copy(this.pos);
      this._init = true;
    }
    if (this.vehicle?.chassis) {
      const v = this.vehicle.chassis.velocity;
      this.vel.set(v.x, v.y, v.z);
    } else if (dt > 0) {
      this.vel.subVectors(this.pos, this._prev).divideScalar(dt);
    }
    if (this.vel.length() > 80) this.vel.set(0, 0, 0); // teleport spike
  }

  _on(name, fn) {
    this.events.on(name, fn);
    this._offs.push([name, fn]);
  }

  dispose() {
    for (const [n, f] of this._offs) this.events.off?.(n, f);
    this._offs.length = 0;
  }
}

// ---------- view culling ----------

export class ViewCuller {
  constructor(camera) {
    this.camera = camera;
    this.frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._inv = new THREE.Matrix4();
    this._s = new THREE.Sphere();
  }

  update() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    this._inv.copy(cam.matrixWorld).invert();
    this._m.multiplyMatrices(cam.projectionMatrix, this._inv);
    this.frustum.setFromProjectionMatrix(this._m);
  }

  visible(x, y, z, radius = 2) {
    this._s.center.set(x, y, z);
    this._s.radius = radius;
    return this.frustum.intersectsSphere(this._s);
  }
}
