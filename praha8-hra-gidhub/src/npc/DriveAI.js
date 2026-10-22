/**
 * DriveController - drives one AI vehicle by calling vehicle.setControls().
 *
 * Modes (set with setMode):
 *   { type: 'road' }                                   follow the road in the right lane
 *   { type: 'chase', target, vel, speed, ram, ignoreId } drive at a point (police)
 *   { type: 'stop' }                                   brake and hold
 *
 * Road following: a look-ahead point in front of the car is snapped to the nearest road
 * (world.getNearestRoad) and the car steers to the right lane of that road point.
 * Obstacles (cars, pedestrians, the player) come from npc.obstacles, built by NpcManager.
 */
import * as THREE from 'three';
import { clamp, leftVec } from './npcCommon.js';

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();

export class DriveController {
  /**
   * @param {object} npc     NpcManager (needs .road and .obstacles)
   * @param {object} vehicle Vehicle from the vehicles module
   * @param {{maxSpeed?:number, lane?:number}} opts  lane = right-lane offset as a fraction of road width
   */
  constructor(npc, vehicle, opts = {}) {
    this.npc = npc;
    this.v = vehicle;
    this.maxSpeed = opts.maxSpeed ?? 13;
    this.lane = opts.lane ?? 0.25;
    this.mode = { type: 'road' };
    this.aim = null;
    this.desired = this.maxSpeed;
    this.navT = 0;
    this.stuck = 0;
    this.reverseT = 0;
    this.revSteer = 1;
    this.blockedT = 0;
    this.honkT = 0;
    this.idleT = 0; // seconds spent (almost) standing still
    this.err = 0;
  }

  setMode(mode) {
    this.mode = mode;
  }

  update(dt) {
    const v = this.v;
    if (!v.ai || v.destroyed) return;
    v.getPosition(_p);
    v.getForward(_f);
    const px = _p.x, pz = _p.z, fx = _f.x, fz = _f.z;
    const speed = v.speed;

    // ----- aim point (re-evaluated ~7x per second) -----
    this.navT -= dt;
    if (this.navT <= 0 || !this.aim) {
      this.navT = 0.15;
      this._computeAim(px, pz, fx, fz, speed);
    }

    // ----- steering -----
    const ax = this.aim.x - px;
    const az = this.aim.z - pz;
    const dist = Math.hypot(ax, az) || 1;
    const dotF = (ax * fx + az * fz) / dist;
    const dotL = (ax * fz - az * fx) / dist; // left = (fz, -fx)
    const err = Math.atan2(dotL, dotF);
    this.err = err;
    let steer = clamp(err * 1.8, -1, 1);

    // ----- target speed -----
    let target = this.desired * (1 - Math.min(0.75, Math.abs(err) * 0.7));
    target = Math.min(target, this._obstacleSpeed(px, pz, fx, fz, speed, dt));

    // ----- pedals -----
    let thr = 0;
    let brk = 0;
    if (this.reverseT > 0) {
      // back out of a jam: brake input at standstill engages reverse in the vehicle
      this.reverseT -= dt;
      brk = 1;
      steer = -this.revSteer;
    } else {
      const dv = target - speed;
      if (dv > 0.3) thr = clamp(dv * 0.35, 0.15, 1);
      else if (dv < -1.0 && speed > 1.5) brk = clamp(-dv * 0.25, 0.1, 1);
      // otherwise coast; the vehicle holds the brake itself when standing still
    }

    // ----- stuck detection -----
    if (this.reverseT <= 0 && target > 2 && Math.abs(speed) < 0.5) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 2.5) {
      this.reverseT = 1.4;
      this.revSteer = err >= 0 ? 1 : -1;
      this.stuck = 0;
    }
    this.idleT = Math.abs(speed) < 0.5 ? this.idleT + dt : 0;

    this.honkT = Math.max(0, this.honkT - dt);
    v.setControls({ throttle: thr, brake: brk, steer, handbrake: 0, horn: this.honkT > 0 });
  }

  _computeAim(px, pz, fx, fz, speed) {
    const m = this.mode;
    if (m.type === 'stop') {
      this.aim = { x: px + fx * 10, z: pz + fz * 10 };
      this.desired = 0;
      return;
    }
    if (m.type === 'chase') {
      const dx = m.target.x - px;
      const dz = m.target.z - pz;
      const d = Math.hypot(dx, dz);
      const lead = clamp(d / 25, 0, 1.2);
      this.aim = { x: m.target.x + (m.vel?.x ?? 0) * lead, z: m.target.z + (m.vel?.z ?? 0) * lead };
      this.desired = m.speed ?? this.maxSpeed;
      return;
    }
    // road following
    const road = this.npc.road;
    const L = clamp(Math.abs(speed) * 0.8 + 6, 8, 26);
    const qx = px + fx * L;
    const qz = pz + fz * L;
    const r = road.nearest(qx, qz);
    if (!r || r.distance > r.width * 0.7 + 6) {
      // off the road: head back to the nearest road point slowly
      const r0 = road.nearest(px, pz);
      if (r0) {
        this.aim = { x: r0.x, z: r0.z };
        this.desired = Math.min(this.maxSpeed, 5);
      } else {
        this.aim = { x: qx, z: qz };
        this.desired = Math.min(this.maxSpeed, 4);
      }
      return;
    }
    let h = r.heading;
    if (Math.sin(h) * fx + Math.cos(h) * fz < 0) h += Math.PI; // travel direction
    const [lx, lz] = leftVec(h);
    const off = r.width * this.lane;
    this.aim = { x: r.x - lx * off, z: r.z - lz * off }; // right lane
    this.desired = this.maxSpeed;
  }

  /** Highest safe speed given obstacles in front of the car. */
  _obstacleSpeed(px, pz, fx, fz, speed, dt) {
    const look = Math.min(40, 8 + Math.max(0, speed) * 1.6);
    const ignoreId = this.mode.ignoreId;
    let safe = Infinity;
    let blocker = null;
    for (const o of this.npc.obstacles) {
      if (o.id === this.v.id || o.id === ignoreId) continue;
      const dx = o.x - px;
      const dz = o.z - pz;
      const lz = dx * fx + dz * fz;
      if (lz < 0.5 || lz > look + o.r) continue;
      const lx = dx * fz - dz * fx;
      const lim = o.r + 1.1 + lz * 0.04;
      if (Math.abs(lx) > lim) continue;
      const gap = lz - o.r - 2.2;
      const leader = Math.max(0, o.vx * fx + o.vz * fz);
      const s = Math.sqrt(2 * 4 * Math.max(0, gap - 1.5)) + leader * 0.8;
      if (s < safe) {
        safe = s;
        blocker = o;
      }
    }
    if (blocker && safe < 1.0) {
      this.blockedT += dt;
      if (this.blockedT > 3 && blocker.kind !== 'vehicle' && this.honkT <= 0) this.honkT = 0.5;
    } else {
      this.blockedT = Math.max(0, this.blockedT - dt);
    }
    return safe;
  }
}
