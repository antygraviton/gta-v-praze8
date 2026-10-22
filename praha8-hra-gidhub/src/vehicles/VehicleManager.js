/**
 * VehicleManager - entry point of the vehicles module.
 *
 *   import VehicleManager from './vehicles/VehicleManager.js';
 *   const vehicles = new VehicleManager();
 *   vehicles.init(ctx);          // ctx = { scene, camera, renderer, physics, events, world }
 *   vehicles.update(dt);         // every frame
 *   vehicles.dispose();
 *
 * Requirements on other modules:
 *  - ctx.physics is a cannon-es World (or an object with `.world`). main.js steps it every frame.
 *  - The physics world has a ground collider. If the world module does NOT provide one, set
 *    `ctx.world.hasPhysicsGround = false` (default) and this module adds a flat plane at y = 0.
 *    If the world module has its own ground collider, set `ctx.world.hasPhysicsGround = true`.
 *  - The player module emits "player:position" {x, y, z} every frame while on foot
 *    (used to find the nearest car for entering). Falls back to the camera position.
 *
 * Events emitted:  player:enterVehicle {vehicle,id,type}
 *                  player:exitVehicle  {vehicle,id,position:{x,y,z},heading}
 *                  vehicle:crashed     {id,type,impact,speedKmh,health,driver,position}
 *                  vehicle:destroyed   {id,type,position}
 *                  vehicle:spawned     {vehicle,id,type}
 *                  vehicle:telemetry   {speedKmh,rpm,redline,gear,throttle,brake,health,lights,slip,view}
 *                  vehicle:exitDenied  {id}      (car too fast to leave)
 * Events consumed: vehicle:spawn {type,x,z,heading,color,ai}   (spawns a car, replies vehicle:spawned)
 *                  vehicle:despawn {id}
 *                  vehicle:requestEnter {id}    (e.g. from missions)
 *                  player:position {x,y,z}
 *
 * Keys: W/S or Up/Down = gas/brake+reverse, A/D or Left/Right = steer, Space = handbrake,
 *       E = enter/exit, C = camera (cockpit / chase), H = horn, L = lights, R = flip car upright.
 *       Mouse (pointer lock or drag) = look around inside the cockpit.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Vehicle } from './Vehicle.js';
import { VEHICLE_SPECS } from './vehicleSpecs.js';
import { EngineSound } from './EngineSound.js';

const DEFAULT_SPAWNS = [
  { type: 'citycar', x: 8, z: 4, heading: 0 },
  { type: 'sedan', x: 8, z: 12, heading: 0 },
  { type: 'hypercar', x: 8, z: 20, heading: 0 },
];

const ENTER_DISTANCE = 3.5;
const MAX_EXIT_SPEED = 8; // m/s
const MAX_VOICES = 5;
const AUDIBLE_DISTANCE = 70;

const Y180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export default class VehicleManager {
  constructor(options = {}) {
    this.options = { spawnDefaults: true, createGroundPlane: true, spawns: DEFAULT_SPAWNS, ...options };
    this.vehicles = [];
    this.active = null;
    this.view = 'cockpit'; // 'cockpit' | 'chase'
    this.keys = new Set();
    this.playerPos = null;
    this._offs = [];
    this._listeners = [];
    this.audio = null;
    this._head = { yaw: 0, pitch: 0, lastInput: 0 };
    this._sway = new THREE.Vector3();
    this._camYaw = 0;
    this._blend = null;
    this._dragging = false;
    this._savedCam = null;
  }

  // ------------------------------------------------------------------ lifecycle

  init(ctx) {
    this.ctx = ctx;
    this.events = ctx.events;
    this.world = ctx.physics?.world ?? ctx.physics;
    if (!this.world || typeof this.world.addBody !== 'function') {
      throw new Error('VehicleManager: ctx.physics must be a cannon-es World (or { world })');
    }
    ctx.vehicles = this; // lets NPC / mission modules query cars: ctx.vehicles.getAll()

    // gravity must exist; cars need it
    if (Math.abs(this.world.gravity.y) < 1) this.world.gravity.set(0, -9.82, 0);

    this.chassisMaterial = new CANNON.Material('vehicleChassis');
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.chassisMaterial, this.world.defaultMaterial, { friction: 0.12, restitution: 0.08 }),
    );

    if (this.options.createGroundPlane && !ctx.world?.hasPhysicsGround) {
      this.groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
      this.groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      this.world.addBody(this.groundBody);
    }

    this._on('player:position', (p) => {
      if (!this.playerPos) this.playerPos = new THREE.Vector3();
      this.playerPos.set(p.x, p.y ?? 0, p.z);
    });
    this._on('vehicle:spawn', (req) => this.spawn(req.type, req));
    this._on('vehicle:despawn', ({ id }) => this.despawn(id));
    this._on('vehicle:requestEnter', ({ id }) => {
      const v = this.getById(id);
      if (v) this.enter(v);
    });

    this._listen(window, 'keydown', (e) => this._onKeyDown(e));
    this._listen(window, 'keyup', (e) => this.keys.delete(e.code));
    this._listen(window, 'blur', () => this.keys.clear());
    this._listen(window, 'mousemove', (e) => this._onMouseMove(e));
    this._listen(window, 'mousedown', (e) => {
      this._initAudio();
      if (e.button === 0) this._dragging = true;
    });
    this._listen(window, 'mouseup', () => (this._dragging = false));

    if (this.options.spawnDefaults) {
      for (const s of this.options.spawns) this.spawn(s.type, s);
    }
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    const a = this.active;
    if (a) this._applyKeys(a);

    for (const v of this.vehicles) {
      v.clusterActive = v === a && this.view === 'cockpit';
      v.update(dt);
    }

    if (a) {
      this._updateCamera(dt);
      const t = a.getTelemetry();
      t.view = this.view;
      this.events.emit('vehicle:telemetry', t);
    }
    this._updateAudio();
  }

  dispose() {
    if (this.active) this._restoreCamera();
    for (const v of this.vehicles) v.dispose();
    this.vehicles.length = 0;
    this.active = null;
    for (const [name, fn] of this._offs) this.events.off?.(name, fn);
    for (const [target, type, fn] of this._listeners) target.removeEventListener(type, fn);
    this._offs.length = 0;
    this._listeners.length = 0;
    if (this.groundBody) this.world.removeBody(this.groundBody);
    if (this.audio) {
      this.audio.ctx.close?.();
      this.audio = null;
    }
    if (this.ctx?.vehicles === this) delete this.ctx.vehicles;
  }

  // ------------------------------------------------------------------ public api

  /** Spawns a vehicle. opts: { x, z, heading, color, ai, id, plate, onRoad } */
  spawn(type, opts = {}) {
    const spec = VEHICLE_SPECS[type];
    if (!spec) {
      console.warn(`[vehicles] unknown vehicle type "${type}"`);
      return null;
    }
    let x = opts.x ?? 0;
    let z = opts.z ?? 0;
    let heading = opts.heading ?? 0;
    if (opts.onRoad) {
      try {
        const r = this.ctx.world?.getNearestRoad?.(x, z);
        if (r && typeof r.x === 'number' && typeof r.z === 'number') {
          x = r.x;
          z = r.z;
          if (typeof r.heading === 'number') heading = r.heading;
        }
      } catch (err) {
        /* world module not ready: keep the requested position */
      }
    }
    const gy = this.ctx.world?.getGroundHeight?.(x, z) ?? 0;
    const v = new Vehicle(this.ctx, this.world, spec, {
      ...opts, x, z, heading, y: gy + spec.cgHeight + 0.35, material: this.chassisMaterial,
    });
    v.onCrash = (info) => this._playCrash(info);
    this.vehicles.push(v);
    this.events.emit('vehicle:spawned', { vehicle: v, id: v.id, type: v.type });
    return v;
  }

  despawn(id) {
    const i = this.vehicles.findIndex((v) => v.id === id);
    if (i < 0) return;
    const v = this.vehicles[i];
    if (v === this.active) this.exit(true);
    v.dispose();
    this.vehicles.splice(i, 1);
  }

  getAll() { return this.vehicles; }
  getActive() { return this.active; }
  getById(id) { return this.vehicles.find((v) => v.id === id) ?? null; }

  getNearest(x, z, maxDist = Infinity) {
    let best = null;
    let bd = maxDist;
    for (const v of this.vehicles) {
      const d = Math.hypot(v.chassis.position.x - x, v.chassis.position.z - z);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  enter(v) {
    if (this.active || !v || v.destroyed) return false;
    this._initAudio();
    this.active = v;
    v.occupied = true;
    v.engineOn = true;
    this.keys.clear();
    this._head.yaw = this._head.pitch = 0;
    const cam = this.ctx.camera;
    this._savedCam = { fov: cam.fov, near: cam.near };
    this._blend = { t: 0, pos: cam.position.clone(), quat: cam.quaternion.clone() };
    this._camYaw = Math.atan2(v.getForward().x, v.getForward().z);
    this.events.emit('player:enterVehicle', { vehicle: v, id: v.id, type: v.type });
    return true;
  }

  exit(force = false) {
    const v = this.active;
    if (!v) return false;
    if (!force && Math.abs(v.speed) > MAX_EXIT_SPEED) {
      this.events.emit('vehicle:exitDenied', { id: v.id });
      return false;
    }
    const p = v.getExitPoint();
    const gy = this.ctx.world?.getGroundHeight?.(p.x, p.z);
    if (typeof gy === 'number') p.y = gy;
    else p.y = 0;
    v.occupied = false;
    v.engineOn = v.ai;
    v.controls.throttle = v.controls.brake = v.controls.steer = v.controls.handbrake = 0;
    v.controls.horn = false;
    this.active = null;
    this._restoreCamera();
    this.events.emit('player:exitVehicle', {
      vehicle: v, id: v.id, position: { x: p.x, y: p.y, z: p.z }, heading: p.heading,
    });
    return true;
  }

  // ------------------------------------------------------------------ input

  _onKeyDown(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    this._initAudio();
    if (e.repeat) {
      if (this.active && /^(Space|Arrow)/.test(e.code)) e.preventDefault();
      return;
    }
    this.keys.add(e.code);
    if (this.active && /^(Space|Arrow)/.test(e.code)) e.preventDefault();

    switch (e.code) {
      case 'KeyE':
        if (this.active) this.exit();
        else this._tryEnter();
        break;
      case 'KeyC':
        if (this.active) {
          this.view = this.view === 'cockpit' ? 'chase' : 'cockpit';
          this._blend = { t: 0, pos: this.ctx.camera.position.clone(), quat: this.ctx.camera.quaternion.clone() };
        }
        break;
      case 'KeyL':
        if (this.active) this.active.toggleLights();
        break;
      case 'KeyR':
        if (this.active) this.active.respawnUpright();
        break;
      default:
    }
  }

  _tryEnter() {
    const pos = this.playerPos ?? this.ctx.camera.position;
    const v = this.getNearest(pos.x, pos.z, ENTER_DISTANCE);
    if (v) this.enter(v);
  }

  _applyKeys(v) {
    const k = this.keys;
    const c = v.controls;
    c.throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    c.brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    c.steer = (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    c.handbrake = k.has('Space') ? 1 : 0;
    c.horn = k.has('KeyH');
  }

  _onMouseMove(e) {
    if (!this.active || this.view !== 'cockpit') return;
    if (!document.pointerLockElement && !this._dragging) return;
    this._head.yaw = clamp(this._head.yaw - e.movementX * 0.0022, -2.0, 2.0);
    this._head.pitch = clamp(this._head.pitch - e.movementY * 0.0022, -0.6, 0.7);
    this._head.lastInput = performance.now();
  }

  // ------------------------------------------------------------------ camera

  _updateCamera(dt) {
    const v = this.active;
    const cam = this.ctx.camera;
    v.model.root.updateMatrixWorld(true);
    const speedKmh = Math.abs(v.speed) * 3.6;

    let pos;
    const quat = new THREE.Quaternion();
    let fov;

    if (this.view === 'cockpit') {
      const h = this._head;
      if (performance.now() - h.lastInput > 2000) {
        const d = Math.exp(-dt * 1.5);
        h.yaw *= d;
        h.pitch *= d;
      }
      // head sway from acceleration
      const sx = clamp(-v.accel.x * 0.005, -0.06, 0.06);
      const sz = clamp(-v.accel.z * 0.005, -0.06, 0.06);
      this._sway.x += (sx - this._sway.x) * Math.min(1, dt * 8);
      this._sway.z += (sz - this._sway.z) * Math.min(1, dt * 8);
      const eye = v.model.eye.clone();
      eye.x += this._sway.x;
      eye.z += this._sway.z;
      pos = v.model.root.localToWorld(eye);
      const headQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(h.pitch, h.yaw, 0, 'YXZ'));
      quat.copy(v.model.root.quaternion).multiply(Y180).multiply(headQ);
      fov = 76 + Math.min(10, speedKmh * 0.05);
      cam.near = Math.min(this._savedCam?.near ?? 0.1, 0.06);
    } else {
      const f = v.getForward();
      const yaw = Math.atan2(f.x, f.z);
      this._camYaw = lerpAngle(this._camYaw, yaw, 1 - Math.exp(-dt * 2.5));
      const { dist, height } = v.spec.chase;
      const vp = v.getPosition();
      const target = new THREE.Vector3(
        vp.x - Math.sin(this._camYaw) * dist, vp.y + height, vp.z - Math.cos(this._camYaw) * dist,
      );
      pos = cam.position.clone().lerp(target, 1 - Math.exp(-dt * 8));
      const look = new THREE.Vector3(
        vp.x + Math.sin(this._camYaw) * 2, vp.y + 1.2, vp.z + Math.cos(this._camYaw) * 2,
      );
      const m = new THREE.Matrix4().lookAt(pos, look, new THREE.Vector3(0, 1, 0));
      quat.setFromRotationMatrix(m);
      fov = 62 + Math.min(12, speedKmh * 0.06);
      cam.near = this._savedCam?.near ?? cam.near;
    }

    // short blend when entering or switching view
    if (this._blend) {
      this._blend.t += dt / 0.35;
      const k = Math.min(1, this._blend.t);
      const s = k * k * (3 - 2 * k);
      pos = this._blend.pos.clone().lerp(pos, s);
      const q = this._blend.quat.clone().slerp(quat, s);
      quat.copy(q);
      if (k >= 1) this._blend = null;
    }

    cam.position.copy(pos);
    cam.quaternion.copy(quat);
    cam.fov += (fov - cam.fov) * Math.min(1, dt * 5);
    cam.updateProjectionMatrix();
  }

  _restoreCamera() {
    const cam = this.ctx.camera;
    if (this._savedCam) {
      cam.fov = this._savedCam.fov;
      cam.near = this._savedCam.near;
      cam.updateProjectionMatrix();
      this._savedCam = null;
    }
    this._blend = null;
  }

  // ------------------------------------------------------------------ audio

  _initAudio() {
    if (this.audio) {
      if (this.audio.ctx.state === 'suspended') this.audio.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const actx = new AC();
    const master = actx.createGain();
    master.gain.value = 0.6;
    master.connect(actx.destination);
    this.audio = { ctx: actx, master };
  }

  _updateAudio() {
    if (!this.audio) return;
    const cam = this.ctx.camera;
    const camPos = cam.position;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);

    const cands = [];
    for (const v of this.vehicles) {
      if (!v.engineOn && !v.controls.horn) continue;
      const d = v.getPosition().distanceTo(camPos);
      if (v === this.active || d < AUDIBLE_DISTANCE) cands.push({ v, d });
    }
    cands.sort((a, b) => a.d - b.d);
    const chosen = new Set(cands.slice(0, MAX_VOICES).map((c) => c.v));

    for (const v of this.vehicles) {
      if (!chosen.has(v) && v.sound) {
        v.sound.dispose();
        v.sound = null;
      }
    }
    for (const { v, d } of cands.slice(0, MAX_VOICES)) {
      if (!v.sound) v.sound = new EngineSound(this.audio.ctx, this.audio.master, v.spec.sound);
      const inside = v === this.active && this.view === 'cockpit';
      let volume;
      let pan = 0;
      if (v === this.active) {
        volume = inside ? 0.9 : 0.7;
      } else {
        const f = clamp(1 - d / AUDIBLE_DISTANCE, 0, 1);
        volume = f * f * 0.8;
        const rel = v.getPosition().sub(camPos).normalize();
        pan = clamp(rel.dot(right), -1, 1);
      }
      v.sound.update({
        rpm: v.rpm,
        redline: v.spec.engine.redline,
        throttle: v.controls.throttle,
        speed: v.speed,
        slip: v.slip,
        volume: v.engineOn ? volume : 0,
        pan,
        muffle: inside ? 0.6 : 1,
      });
      v.sound.setHorn(!!v.controls.horn);
    }
  }

  _playCrash(info) {
    if (!this.audio) return;
    const actx = this.audio.ctx;
    const cam = this.ctx.camera.position;
    const d = Math.hypot(info.position.x - cam.x, info.position.z - cam.z);
    const vol = clamp(info.impact / 25, 0.1, 1) * clamp(1 - d / 120, 0, 1);
    if (vol <= 0) return;
    const len = 0.5;
    const buf = actx.createBuffer(1, Math.floor(actx.sampleRate * len), actx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
    const src = actx.createBufferSource();
    src.buffer = buf;
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900 + info.impact * 80;
    const g = actx.createGain();
    g.gain.value = vol;
    src.connect(lp);
    lp.connect(g);
    g.connect(this.audio.master);
    src.start();
  }

  // ------------------------------------------------------------------ helpers

  _on(name, fn) {
    this.events.on(name, fn);
    this._offs.push([name, fn]);
  }

  _listen(target, type, fn) {
    target.addEventListener(type, fn);
    this._listeners.push([target, type, fn]);
  }
}
