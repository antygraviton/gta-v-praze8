/**
 * PedestrianSystem - civilians that walk along sidewalks near the player.
 *
 * Behaviour states: walk, phone (walking/standing while on a phone), idle, cross (crossing the
 * street), flee (run away from a threat), cower (hands up, then flee).
 * Being hit by vehicles / bullets is resolved by NpcManager (hit pass, damageActor).
 *
 * Sidewalks: the nearest road point is pushed sideways by half the road width + ~1.7 m,
 * towards the side the pedestrian is already on. Needs world.getNearestRoad(); without it
 * pedestrians simply wander in open space.
 */
import * as THREE from 'three';
import { Actor } from './Actor.js';
import { CONFIG, rand, pickWeighted, fwd, leftVec } from './npcCommon.js';

const ARCH_WEIGHTS = [
  ['civilian_m', 25],
  ['civilian_f', 25],
  ['casual', 26],
  ['shirtless', 6],
  ['bearded', 6],
];

const _T = new THREE.Vector3();
const _F = new THREE.Vector3();

export class PedestrianSystem {
  constructor(npc) {
    this.npc = npc;
    this.peds = [];
    this._spawnT = 0;
  }

  forEachActor(fn) {
    for (const p of this.peds) fn(p.actor);
  }

  /** Number of living pedestrians within r of (x, z), optionally excluding one id. */
  countNear(x, z, r, excludeId = null) {
    let n = 0;
    const r2 = r * r;
    for (const p of this.peds) {
      const a = p.actor;
      if (!a.alive || a.id === excludeId) continue;
      const dx = a.pos.x - x;
      const dz = a.pos.z - z;
      if (dx * dx + dz * dz <= r2) n++;
    }
    return n;
  }

  /** Something scary happened at (x, z): nearby pedestrians cower or run. */
  alert(x, z, radius) {
    const r2 = radius * radius;
    for (const p of this.peds) {
      const a = p.actor;
      if (!a.alive) continue;
      const dx = a.pos.x - x;
      const dz = a.pos.z - z;
      if (dx * dx + dz * dz <= r2) this._scare(p, x, z, 0.25);
    }
  }

  /** A pedestrian thrown out of a car (carjacking): spawns next to (x, z) and runs from (fromX, fromZ). */
  spawnFleeing(x, z, fromX, fromZ) {
    const p = this._create(x, this.npc.road.ground(x, z), z, Math.random() * Math.PI * 2, 1);
    if (p) this._scare(p, fromX, fromZ, 0);
    return p;
  }

  update(dt) {
    const { player, road } = this.npc;
    const cfg = CONFIG.pedestrians;
    this._spawnT -= dt;
    if (this._spawnT <= 0 && this.peds.length < cfg.target) {
      this._spawnT = 0.35;
      this._trySpawn();
    }
    const ground = (x, z) => road.ground(x, z);
    const far2 = cfg.despawn * cfg.despawn;
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      const a = p.actor;
      const dx = a.pos.x - player.pos.x;
      const dz = a.pos.z - player.pos.z;
      if (dx * dx + dz * dz > far2 || a.expired) {
        this._remove(i);
        continue;
      }
      if (a.alive) this._think(p, dt);
      a.update(dt, ground);
    }
  }

  dispose() {
    for (let i = this.peds.length - 1; i >= 0; i--) this._remove(i);
  }

  // ------------------------------------------------------------------ spawning

  _trySpawn() {
    const { player, road, view } = this.npc;
    const cfg = CONFIG.pedestrians;
    const ang = Math.random() * Math.PI * 2;
    const d = rand(cfg.spawnMin, cfg.spawnMax);
    let x = player.pos.x + Math.sin(ang) * d;
    let z = player.pos.z + Math.cos(ang) * d;
    const side = Math.random() < 0.5 ? 1 : -1;
    let heading = Math.random() * Math.PI * 2;
    if (road.available) {
      const r = road.nearest(x, z);
      if (!r || r.distance > 45) return;
      const [lx, lz] = leftVec(r.heading);
      const off = r.width / 2 + 1.7 + rand(0, 1.1);
      x = r.x + lx * side * off;
      z = r.z + lz * side * off;
      heading = r.heading + (Math.random() < 0.5 ? 0 : Math.PI);
    }
    const y = road.ground(x, z);
    if (view.visible(x, y + 1, z, 1.5)) return; // never pop in front of the camera
    for (const p of this.peds) {
      if (Math.abs(p.actor.pos.x - x) < 1.5 && Math.abs(p.actor.pos.z - z) < 1.5) return;
    }
    this._create(x, y, z, heading, side);
  }

  _create(x, y, z, heading, side) {
    const actor = new Actor(this.npc.scene, pickWeighted(ARCH_WEIGHTS), x, y, z, {
      kind: 'civilian', heading, health: 100,
    });
    const p = {
      actor,
      state: 'walk',
      timer: rand(5, 25),
      target: null,
      retarget: 0,
      speed: rand(1.1, 1.6),
      side,
      offJitter: rand(0, 1.1),
      scanT: rand(0, 0.3),
      threat: null,
    };
    if (Math.random() < 0.18) {
      p.state = 'phone';
      actor.special = 'phone';
    }
    this.peds.push(p);
    return p;
  }

  _remove(i) {
    this.peds[i].actor.remove();
    this.peds.splice(i, 1);
  }

  // ------------------------------------------------------------------ brain

  _think(p, dt) {
    const a = p.actor;
    p.timer -= dt;
    p.scanT -= dt;
    if (p.scanT <= 0) {
      p.scanT = 0.25 + Math.random() * 0.15;
      this._scanThreats(p);
    }

    switch (p.state) {
      case 'walk':
      case 'phone': {
        p.retarget -= dt;
        if (!p.target || p.retarget <= 0 || this._reached(a, p.target, 1.2)) {
          this._pickTarget(p);
          p.retarget = rand(0.8, 1.6);
        }
        const speed = p.state === 'phone' ? p.speed * 0.6 : p.speed;
        this._moveTo(a, p.target, speed);
        if (p.timer <= 0) {
          p.timer = rand(10, 30);
          const roll = Math.random();
          if (roll < 0.25) {
            p.state = 'idle';
            p.timer = rand(3, 8);
            a.special = Math.random() < 0.5 ? 'phone' : null; // stand and talk on the phone
          } else if (roll < 0.45) {
            this._startCross(p);
          } else if (p.state === 'walk' && roll < 0.55) {
            p.state = 'phone';
            a.special = 'phone';
          } else if (p.state === 'phone' && roll < 0.75) {
            p.state = 'walk';
            a.special = null;
          }
        }
        break;
      }
      case 'idle':
        a.stop();
        if (p.timer <= 0) {
          p.state = a.special === 'phone' ? 'phone' : 'walk';
          p.timer = rand(10, 30);
          p.target = null;
        }
        break;
      case 'cross':
        this._moveTo(a, p.target, 1.8);
        if (this._reached(a, p.target, 1.0) || p.timer <= 0) {
          p.state = 'walk';
          p.target = null;
          p.timer = rand(10, 30);
        }
        break;
      case 'flee': {
        const away = Math.atan2(a.pos.x - p.threat.x, a.pos.z - p.threat.z) + Math.sin(p.timer * 3) * 0.35;
        a.special = null;
        a.setMove(away, 4.6);
        if (p.timer <= 0) {
          p.state = 'walk';
          p.target = null;
          p.timer = rand(8, 20);
        }
        break;
      }
      case 'cower':
        a.stop();
        a.special = 'handsUp';
        if (p.timer <= 0) {
          p.state = 'flee';
          p.timer = rand(4, 7);
          a.special = null;
        }
        break;
      default:
    }
  }

  _moveTo(a, target, speed) {
    if (!target) {
      a.stop();
      return;
    }
    a.setMove(Math.atan2(target.x - a.pos.x, target.z - a.pos.z), speed);
  }

  _reached(a, t, r) {
    return Math.hypot(t.x - a.pos.x, t.z - a.pos.z) < r;
  }

  _scare(p, x, z, cowerChance) {
    p.threat = { x, z };
    p.actor.special = null;
    if (Math.random() < cowerChance) {
      p.state = 'cower';
      p.timer = rand(1.5, 3);
    } else {
      p.state = 'flee';
      p.timer = rand(4, 7);
    }
  }

  /** Pedestrian in the path of a fast vehicle: run. */
  _scanThreats(p) {
    if (p.state === 'flee' || p.state === 'cower') return;
    const a = p.actor;
    for (const v of this.npc.vehicles.values()) {
      const sp = v.speed;
      if (Math.abs(sp) < 4.5 || !v.chassis) continue;
      v.getPosition(_T);
      const dx = a.pos.x - _T.x;
      const dz = a.pos.z - _T.z;
      if (dx * dx + dz * dz > 225) continue;
      v.getForward(_F);
      const dir = sp > 0 ? 1 : -1;
      const lz = (dx * _F.x + dz * _F.z) * dir;
      if (lz < 0 || lz > 14) continue;
      if (Math.abs(dx * _F.z - dz * _F.x) > 3.2) continue;
      this._scare(p, _T.x, _T.z, 0.1);
      return;
    }
  }

  _pickTarget(p) {
    const a = p.actor;
    const road = this.npc.road;
    const r = road.available ? road.nearest(a.pos.x, a.pos.z) : null;
    if (!r || r.distance > 40) {
      const h = a.heading + rand(-0.7, 0.7);
      p.target = { x: a.pos.x + Math.sin(h) * 10, z: a.pos.z + Math.cos(h) * 10 };
      return;
    }
    let hw = r.heading;
    if (Math.sin(hw) * Math.sin(a.heading) + Math.cos(hw) * Math.cos(a.heading) < 0) hw += Math.PI;
    const [dx, dz] = fwd(hw);
    const q = road.nearest(a.pos.x + dx * 9, a.pos.z + dz * 9) ?? r;
    let nx = a.pos.x - r.x;
    let nz = a.pos.z - r.z;
    const nl = Math.hypot(nx, nz);
    if (nl < 0.6) {
      const [lx, lz] = leftVec(hw);
      nx = lx * p.side;
      nz = lz * p.side;
    } else {
      nx /= nl;
      nz /= nl;
    }
    const off = q.width / 2 + 1.7 + p.offJitter;
    p.target = { x: q.x + nx * off, z: q.z + nz * off };
  }

  _roadClear(x, z) {
    for (const v of this.npc.vehicles.values()) {
      if (Math.abs(v.speed) < 2 || !v.chassis) continue;
      v.getPosition(_T);
      if (Math.hypot(_T.x - x, _T.z - z) < 30) return false;
    }
    return true;
  }

  _startCross(p) {
    const a = p.actor;
    const road = this.npc.road;
    const r = road.available ? road.nearest(a.pos.x, a.pos.z) : null;
    if (!r || r.distance > 14 || !this._roadClear(a.pos.x, a.pos.z)) return;
    let nx = a.pos.x - r.x;
    let nz = a.pos.z - r.z;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const off = r.width / 2 + 1.7 + p.offJitter;
    p.target = { x: r.x - nx * off, z: r.z - nz * off };
    p.state = 'cross';
    p.actor.special = null;
    p.timer = Math.hypot(p.target.x - a.pos.x, p.target.z - a.pos.z) / 1.6 + 4;
  }
}
