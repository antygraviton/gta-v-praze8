// src/player/Player.js
// Player module: on-foot movement, animation, world collisions, interactions, third-person camera.
//
// Module contract: export class with init(ctx), update(dt), dispose().
//   ctx = { scene, camera, renderer, physics, events, world }
//   - ctx.physics may be a cannon-es World or an object exposing it as `.world`.
//   - ctx.world.getGroundHeight(x, z) is used for terrain (falls back to 0).
//   - ctx.world.getNearestRoad(x, z) is optional, only used to tag footsteps as "road".
//
// Controls: WASD move (camera-relative), Shift sprint, Alt walk, C / Ctrl crouch,
//           Space jump, F interact / enter / exit vehicle, mouse look (click canvas), wheel zoom.
//
// ---------------------------------------------------------------------------------------
// EVENTS EMITTED
//   "player:enterVehicle"  { vehicleId, vehicle }          player pressed F next to a vehicle
//   "player:exitVehicle"   { vehicleId, position:{x,y,z} } player left the vehicle
//   "player:interact"      { id, type, data }              F pressed next to a non-vehicle interactable
//   "player:state"         { position, heading, speed, onGround, crouching, sprinting,
//                            inVehicle, health, stamina, dead }   10x per second
//   "player:footstep"      { position, sprinting, surface }  surface: "road" | "ground"
//   "player:jumped"        {}
//   "player:landed"        { impact }                      impact = downward speed in m/s
//   "player:damaged"       { amount, health, source }
//   "player:died"          { source }
//   "player:respawned"     { position }
//   "ui:prompt"            { id, text, key } or { id:null, text:null }   HUD hint "[F] Enter vehicle"
//
// EVENTS HANDLED
//   "interactable:register"   { id, type?, object3D? | position?, radius?, prompt?, event?, data? }
//   "interactable:unregister" { id }
//   "vehicle:spawned"         { id, object3D, radius?, prompt?, exitOffsets? }  auto-registers a vehicle
//   "vehicle:removed"         { id }
//   "player:enterVehicle"     { vehicleId, object3D? }   (external) force the player into a vehicle
//   "player:exitVehicle"      { position? }              (external) force the player out
//   "vehicle:crashed"         { vehicleId?, impact | speed }  damages the player when inside
//   "player:teleport"         { x, y?, z, heading? }
//   "player:setSpawn"         { x, z, heading? }
//   "player:damage"           { amount, source? }
//   "player:heal"             { amount }
//   "game:paused" / "game:resumed"   disables / enables input
// ---------------------------------------------------------------------------------------

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PlayerInput } from './PlayerInput.js';
import { PlayerCamera } from './PlayerCamera.js';
import { PlayerModel } from './PlayerModel.js';

/** cannon-es collision group reserved for the player body. Other modules should not reuse it. */
export const PLAYER_COLLISION_GROUP = 4;

const CFG = {
  radius: 0.35,
  heightStand: 1.8,
  heightCrouch: 1.2,
  eyeStand: 1.55,
  eyeCrouch: 1.0,
  stepHeight: 0.45,        // max obstacle height walked over without jumping
  snapDown: 0.4,           // max drop that keeps the player glued to the ground
  walkSpeed: 1.8,
  runSpeed: 4.8,
  sprintSpeed: 7.5,
  crouchSpeed: 1.7,
  accelGround: 38,
  decelGround: 46,
  accelAir: 7,
  decelAir: 1.5,
  gravity: 22,
  jumpSpeed: 7.2,
  coyoteTime: 0.1,
  maxHealth: 100,
  respawnDelay: 4,
  fallDamageSpeed: 15,     // landing speed above which damage is taken
  fallDamageFactor: 7,
  maxStamina: 100,
  staminaDrain: 20,
  staminaRegen: 15,
  staminaRegenDelay: 1,
  stateInterval: 0.1,
  interactRadius: 2.5,
  vehicleRadius: 3.5,
};

const lerpAngle = (a, b, t) => {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * t;
};

export class Player {
  /**
   * @param {object} [options]
   * @param {{x:number,z:number}} [options.spawn] initial position (default: map centre)
   * @param {number} [options.heading] initial facing angle in radians
   * @param {object} [options.outfit] colour overrides, see PlayerModel
   */
  constructor(options = {}) {
    this.options = { spawn: { x: 0, z: 0 }, heading: 0, outfit: {}, ...options };

    // Kinematic state
    this.pos = new THREE.Vector3();   // feet position
    this.vel = new THREE.Vector3();   // metres per second (y = vertical)
    this.heading = this.options.heading;
    this.onGround = false;
    this.crouching = false;
    this.sprinting = false;
    this.inVehicle = false;
    this.dead = false;

    // Stats
    this.health = CFG.maxHealth;
    this.stamina = CFG.maxStamina;
    this._exhausted = false;
    this._staminaDelay = 0;
    this._respawnTimer = 0;
    this._hitCooldown = 0;
    this._coyote = 0;
    this._stateTimer = 0;
    this._ringTimer = 0;
    this._paused = false;
    this._ready = false;
    this._snapCamera = true;
    this._spawn = { x: this.options.spawn.x, z: this.options.spawn.z, heading: this.options.heading };

    // Interaction
    this._interactables = new Map();
    this._focus = null;
    this._promptId = undefined;
    this._vehicle = null;   // { id, object3D, rec }

    // Scratch objects (avoid per-frame allocation)
    this._unsubs = [];
    this._F = new THREE.Vector3();
    this._R = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._from = new CANNON.Vec3();
    this._to = new CANNON.Vec3();
    this._res = new CANNON.RaycastResult();
    this._rayOpts = {
      collisionFilterGroup: -1,
      collisionFilterMask: ~PLAYER_COLLISION_GROUP, // ray ignores the player's own body
      skipBackfaces: true,
    };
  }

  // =====================================================================================
  // Lifecycle
  // =====================================================================================

  init(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    this.events = ctx.events;
    this.world = ctx.world;
    this.cworld = ctx.physics && ctx.physics.world ? ctx.physics.world : ctx.physics;
    this._canRay = !!this.cworld && typeof this.cworld.raycastClosest === 'function';

    // Visual
    this.model = new PlayerModel(this.options.outfit);
    this.scene.add(this.model.root);

    // Input + camera
    const dom = ctx.renderer && ctx.renderer.domElement;
    this.input = new PlayerInput(dom, {}, (locked) => this.events.emit('player:pointerLock', { locked }));
    this.input.attach();
    this.cam = new PlayerCamera(
      this.camera,
      (from, to) => this._cameraRay(from, to),
      (x, z) => this._worldGround(x, z)
    );

    // Physics body so vehicles can hit the player (kinematic: we move it, it pushes dynamic bodies).
    this._setupBody();

    // Spawn
    this._placeAt(this._spawn.x, undefined, this._spawn.z, this._spawn.heading);
    this.cam.snap(this.heading + Math.PI); // camera behind the player (player faces +heading)

    this._bindEvents();
    this._ready = true;
  }

  update(dt) {
    if (!this._ready) return;
    dt = Math.min(Math.max(dt, 0), 0.05);
    const inp = this.input;
    this._hitCooldown = Math.max(0, this._hitCooldown - dt);

    if (this.inVehicle) {
      this._updateInVehicle(dt);
    } else if (this.dead) {
      this._updateDead(dt);
    } else {
      this._updateOnFoot(dt);
    }

    // Model sync
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.heading;
    if (!this.inVehicle) {
      const hSpeed = Math.hypot(this.vel.x, this.vel.z);
      const stepped = this.model.update(dt, {
        speed: this.dead ? 0 : hSpeed,
        grounded: this.onGround,
        crouch: this.crouching ? 1 : 0,
        dead: this.dead,
      });
      if (stepped) this._emitFootstep();
    }

    this._syncBody();
    this._broadcastState(dt);
    inp.endFrame();
  }

  dispose() {
    this._ready = false;
    for (const off of this._unsubs) { try { off(); } catch (_) { /* ignore */ } }
    this._unsubs.length = 0;
    if (this.input) this.input.detach();
    if (this.body && this.cworld && this.cworld.removeBody) this.cworld.removeBody(this.body);
    if (this.model) this.model.dispose();
    if (this._promptId) this.events.emit('ui:prompt', { id: null, text: null });
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
    this._interactables.clear();
    this._vehicle = null;
  }

  // =====================================================================================
  // Public helpers (other modules should prefer events)
  // =====================================================================================

  get position() { return this.pos; }

  damage(amount, source = 'unknown') {
    if (this.dead || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this.events.emit('player:damaged', { amount, health: this.health, source });
    if (this.health <= 0) this._die(source);
  }

  heal(amount) {
    if (this.dead) return;
    this.health = Math.min(CFG.maxHealth, this.health + amount);
  }

  teleport(x, y, z, heading) {
    if (this.inVehicle) this._leaveVehicleState();
    this._placeAt(x, y, z, heading);
    this.cam.snap(this.heading + Math.PI);
  }

  // =====================================================================================
  // On-foot update
  // =====================================================================================

  _updateOnFoot(dt) {
    const inp = this.input;
    const cam = this.cam;

    // Camera look
    cam.look(inp.lookX, inp.lookY);
    cam.zoom(inp.wheel);

    // Wish direction relative to camera
    const axis = inp.axis();
    const F = cam.getForward(this._F);
    const R = cam.getRight(this._R);
    let wx = F.x * axis.z + R.x * axis.x;
    let wz = F.z * axis.z + R.z * axis.x;
    const wl = Math.hypot(wx, wz);
    const wantsMove = wl > 0.01;
    if (wl > 1) { wx /= wl; wz /= wl; }

    // Stance and speed
    this.crouching = inp.down('crouch') && this.onGround;
    const canSprint = !this._exhausted && this.stamina > 0 && this.onGround && !this.crouching;
    this.sprinting = wantsMove && inp.down('sprint') && canSprint;
    let target = CFG.runSpeed;
    if (this.crouching) target = CFG.crouchSpeed;
    else if (this.sprinting) target = CFG.sprintSpeed;
    else if (inp.down('walk')) target = CFG.walkSpeed;

    // Stamina
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - CFG.staminaDrain * dt);
      this._staminaDelay = CFG.staminaRegenDelay;
      if (this.stamina <= 0) this._exhausted = true;
    } else {
      this._staminaDelay -= dt;
      if (this._staminaDelay <= 0) this.stamina = Math.min(CFG.maxStamina, this.stamina + CFG.staminaRegen * dt);
      if (this._exhausted && this.stamina > 25) this._exhausted = false;
    }

    // Horizontal velocity: accelerate toward the wish velocity
    const accel = wantsMove
      ? (this.onGround ? CFG.accelGround : CFG.accelAir)
      : (this.onGround ? CFG.decelGround : CFG.decelAir);
    const tx = wx * target;
    const tz = wz * target;
    const dvx = tx - this.vel.x;
    const dvz = tz - this.vel.z;
    const dl = Math.hypot(dvx, dvz);
    const step = accel * dt;
    if (dl <= step) { this.vel.x = tx; this.vel.z = tz; }
    else { this.vel.x += (dvx / dl) * step; this.vel.z += (dvz / dl) * step; }

    // Face movement direction
    if (wantsMove) this.heading = lerpAngle(this.heading, Math.atan2(wx, wz), 1 - Math.exp(-14 * dt));

    // Jump (with a short coyote window after leaving a ledge)
    this._coyote = this.onGround ? CFG.coyoteTime : this._coyote - dt;
    if (inp.pressed('jump') && this._coyote > 0 && !this.crouching) {
      this.vel.y = CFG.jumpSpeed;
      this.onGround = false;
      this._coyote = 0;
      this.events.emit('player:jumped', {});
    }

    this._moveAndCollide(dt);

    // Interaction
    this._updateInteraction();
    if (inp.pressed('interact')) this._interact();

    // Camera
    const eye = this.crouching ? CFG.eyeCrouch : CFG.eyeStand;
    const sprintAmt = this.sprinting ? 1 : 0;
    this.cam.update(dt, this.pos, eye, sprintAmt);
  }

  /** Horizontal sweep, then vertical resolution against terrain and physics bodies. */
  _moveAndCollide(dt) {
    const px0 = this.pos.x;
    const pz0 = this.pos.z;

    // Horizontal sweep
    this._sweep(this.vel.x * dt, this.vel.z * dt);

    // Derive actual velocity after sliding / blocking (only when something blocked us)
    if (dt > 0) {
      const ax = (this.pos.x - px0) / dt;
      const az = (this.pos.z - pz0) / dt;
      if (Math.hypot(this.vel.x - ax, this.vel.z - az) > 0.01) { this.vel.x = ax; this.vel.z = az; }
    }

    // Push out of any geometry we ended up inside (cheap when standing still)
    this._ringTimer -= dt;
    if (Math.hypot(this.vel.x, this.vel.z) > 0.1 || this._ringTimer <= 0) {
      this._depenetrate();
      this._ringTimer = 0.15;
    }

    // Vertical
    const x = this.pos.x;
    const z = this.pos.z;
    const prevY = this.pos.y;
    const reach = CFG.stepHeight + 0.3 + Math.max(0, -this.vel.y * dt);
    const ground = this._sampleGround(x, prevY, z, reach);

    if (this.onGround && this.vel.y <= 0) {
      if (prevY - ground <= CFG.snapDown) {
        this.pos.y = ground;       // stick to slopes / curbs / stairs
        this.vel.y = 0;
      } else {
        this.onGround = false;     // walked off a ledge
      }
    }

    if (!this.onGround) {
      const impact = -this.vel.y;
      this.vel.y -= CFG.gravity * dt;
      const ny = this.pos.y + this.vel.y * dt;

      // Head bump
      if (this.vel.y > 0 && this._cast(x, prevY + this._height(), z, x, prevY + this._height() + this.vel.y * dt + 0.05, z)) {
        this.vel.y = 0;
      }

      if (this.vel.y <= 0 && ny <= ground) {
        const landSpeed = Math.max(impact, -this.vel.y);
        this.pos.y = ground;
        this.vel.y = 0;
        this.onGround = true;
        this._onLanded(landSpeed);
      } else {
        this.pos.y = ny;
      }
    }
  }

  _onLanded(impact) {
    if (impact > 3) this.events.emit('player:landed', { impact });
    if (impact > CFG.fallDamageSpeed) {
      this.damage((impact - CFG.fallDamageSpeed) * CFG.fallDamageFactor, 'fall');
    }
  }

  // =====================================================================================
  // Collision queries (cannon-es raycasts)
  // =====================================================================================

  _height() {
    return this.crouching ? CFG.heightCrouch : CFG.heightStand;
  }

  _rayHeights() {
    const h = this._height();
    return [CFG.stepHeight + 0.05, h * 0.55, h - 0.2];
  }

  _worldGround(x, z) {
    const h = this.world && this.world.getGroundHeight ? this.world.getGroundHeight(x, z) : 0;
    return Number.isFinite(h) ? h : 0;
  }

  /** Raycast helper. Returns true on hit; details in this._res. */
  _cast(fx, fy, fz, tx, ty, tz) {
    if (!this._canRay) return false;
    this._from.set(fx, fy, fz);
    this._to.set(tx, ty, tz);
    this._res.reset();
    this.cworld.raycastClosest(this._from, this._to, this._rayOpts, this._res);
    return this._res.hasHit;
  }

  _cameraRay(from, to) {
    return this._cast(from.x, from.y, from.z, to.x, to.y, to.z) ? this._res.distance : null;
  }

  /** Highest walkable surface under (x, z): terrain or a physics body top within reach. */
  _sampleGround(x, y, z, reach) {
    let g = this._worldGround(x, z);
    if (this._cast(x, y + CFG.stepHeight, z, x, y - reach, z)) {
      const hy = this._res.hitPointWorld.y;
      if (hy > g) g = hy;
    }
    return g;
  }

  /** Move horizontally by (dx, dz), sliding along walls. Up to 3 iterations for corners. */
  _sweep(dx, dz) {
    const R = CFG.radius;
    const y = this.pos.y;
    const hs = this._rayHeights();
    let px = this.pos.x;
    let pz = this.pos.z;
    let mx = dx;
    let mz = dz;

    for (let i = 0; i < 3; i++) {
      const len = Math.hypot(mx, mz);
      if (len < 1e-5) break;
      const ux = mx / len;
      const uz = mz / len;

      let best = Infinity;
      let nx = 0;
      let nz = 0;
      for (let k = 0; k < hs.length; k++) {
        const h = hs[k];
        if (this._cast(px, y + h, pz, px + ux * (len + R), y + h, pz + uz * (len + R))) {
          const d = this._res.distance;
          if (d < best) {
            best = d;
            nx = this._res.hitNormalWorld.x;
            nz = this._res.hitNormalWorld.z;
          }
        }
      }

      if (best === Infinity) { px += mx; pz += mz; mx = mz = 0; break; }

      const nl = Math.hypot(nx, nz);
      if (nl < 0.2) { px += mx; pz += mz; mx = mz = 0; break; } // floor-like surface, not a wall
      nx /= nl; nz /= nl;
      if (nx * ux + nz * uz > 0) { nx = -nx; nz = -nz; }          // normal must face the player

      const travel = Math.min(len, Math.max(0, best - R - 0.01));
      px += ux * travel;
      pz += uz * travel;
      const rem = len - travel;
      const rx = ux * rem;
      const rz = uz * rem;
      const dot = rx * nx + rz * nz;
      mx = rx - nx * dot;   // remaining motion projected on the wall plane
      mz = rz - nz * dot;
    }

    this.pos.x = px;
    this.pos.z = pz;
  }

  /** Cast a ring of short rays around the capsule and push out of anything closer than the radius. */
  _depenetrate() {
    if (!this._canRay) return;
    const R = CFG.radius;
    const h = this._height();
    const levels = [CFG.stepHeight + 0.05, h * 0.6];
    let pushX = 0;
    let pushZ = 0;
    for (let l = 0; l < levels.length; l++) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const ox = Math.sin(a);
        const oz = Math.cos(a);
        const y = this.pos.y + levels[l];
        if (this._cast(this.pos.x, y, this.pos.z, this.pos.x + ox * R, y, this.pos.z + oz * R)) {
          const pen = R - this._res.distance;
          pushX -= ox * pen;
          pushZ -= oz * pen;
        }
      }
    }
    const pl = Math.hypot(pushX, pushZ);
    if (pl > 1e-4) {
      const s = Math.min(pl, 0.2) / pl;
      this.pos.x += pushX * s;
      this.pos.z += pushZ * s;
    }
  }

  // =====================================================================================
  // Physics body (lets vehicles collide with the player)
  // =====================================================================================

  _setupBody() {
    this.body = null;
    if (!this.cworld || typeof this.cworld.addBody !== 'function') return;
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
    body.addShape(new CANNON.Sphere(0.4), new CANNON.Vec3(0, 0.45, 0));
    body.addShape(new CANNON.Sphere(0.4), new CANNON.Vec3(0, 1.3, 0));
    body.collisionFilterGroup = PLAYER_COLLISION_GROUP;
    body.collisionFilterMask = -1;
    body.userData = { type: 'player' };
    body.addEventListener('collide', (e) => this._onBodyCollide(e));
    this.cworld.addBody(body);
    this.body = body;
  }

  _syncBody() {
    if (!this.body) return;
    this.body.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.body.velocity.set(this.vel.x, this.vel.y, this.vel.z);
    // While in a vehicle (or dead) the body must not interfere with anything.
    this.body.collisionFilterMask = this.inVehicle || this.dead ? 0 : -1;
  }

  _onBodyCollide(e) {
    if (this.inVehicle || this.dead || this._hitCooldown > 0) return;
    const other = e.body;
    if (!other || other.mass === 0) return;
    const sp = other.velocity.length();
    if (sp < 5) return;
    this._hitCooldown = 0.5;
    this.damage((sp - 4) * 6, 'vehicle');
    // Knock back along the other body's travel direction
    this.vel.x = other.velocity.x * 0.7;
    this.vel.z = other.velocity.z * 0.7;
    this.vel.y = Math.max(this.vel.y, 3);
    this.onGround = false;
  }

  // =====================================================================================
  // Interaction & vehicles
  // =====================================================================================

  _recPosition(rec, out) {
    if (rec.object3D) { rec.object3D.getWorldPosition(out); return true; }
    if (rec.position) { out.set(rec.position.x, rec.position.y || 0, rec.position.z); return true; }
    return false;
  }

  _updateInteraction() {
    let best = null;
    let bestD = Infinity;
    const p = this._tmp;
    for (const rec of this._interactables.values()) {
      if (!this._recPosition(rec, p)) continue;
      const dx = p.x - this.pos.x;
      const dz = p.z - this.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < rec.radius * rec.radius && Math.abs(p.y - this.pos.y) < 3 && d2 < bestD) {
        best = rec;
        bestD = d2;
      }
    }
    this._focus = best;
    this._setPrompt(best ? best.id : null, best ? best.prompt : null);
  }

  _setPrompt(id, text) {
    if (this._promptId === id) return;
    this._promptId = id;
    this.events.emit('ui:prompt', id ? { id, text, key: 'F' } : { id: null, text: null });
  }

  _interact() {
    const rec = this._focus;
    if (!rec) return;
    if (rec.type === 'vehicle') {
      this._enterVehicle(rec);
    } else {
      this.events.emit(rec.event || 'player:interact', { id: rec.id, type: rec.type, data: rec.data });
    }
  }

  _enterVehicle(rec) {
    if (this.inVehicle || this.dead) return;
    this._enterVehicleState(rec);
    this.events.emit('player:enterVehicle', { vehicleId: rec.id, vehicle: rec.data || null });
  }

  _enterVehicleState(rec) {
    this.inVehicle = true;
    this._vehicle = { id: rec.id, object3D: rec.object3D || null, rec };
    this.vel.set(0, 0, 0);
    this.crouching = false;
    this.sprinting = false;
    this.model.setVisible(false);
    this._setPrompt('exit', 'Exit vehicle');
  }

  _leaveVehicleState() {
    this.inVehicle = false;
    this._vehicle = null;
    this.vel.set(0, 0, 0);
    this.model.setVisible(true);
    this._setPrompt(null, null);
    this._snapCamera = true;
  }

  _updateInVehicle(dt) {
    const veh = this._vehicle;
    if (veh && veh.object3D) veh.object3D.getWorldPosition(this.pos);
    this.onGround = true;
    if (this.input.pressed('interact')) this._exitVehicle();
  }

  /** Put the player beside the vehicle (first free side) and hand control back. */
  _exitVehicle(data = {}) {
    if (!this.inVehicle) return;
    const veh = this._vehicle;
    const id = veh ? veh.id : null;
    const obj = veh ? veh.object3D : null;
    const out = this._tmp2;
    let heading = this.heading;

    if (data.position) {
      out.set(data.position.x, data.position.y !== undefined ? data.position.y : this.pos.y, data.position.z);
    } else if (obj) {
      const base = new THREE.Vector3();
      obj.getWorldPosition(base);
      obj.getWorldQuaternion(this._quat);
      const offsets = (veh.rec && veh.rec.exitOffsets) || [[-2.2, 0, 0], [2.2, 0, 0], [0, 0, -4], [0, 0, 4]];
      let chosen = null;
      for (const o of offsets) {
        const c = new THREE.Vector3(o[0], o[1], o[2]).applyQuaternion(this._quat).add(base);
        if (!this._cast(base.x, base.y + 0.9, base.z, c.x, base.y + 0.9, c.z)) { chosen = c; break; }
      }
      if (!chosen) {
        const o = offsets[0];
        chosen = new THREE.Vector3(o[0], o[1] + 2.5, o[2]).applyQuaternion(this._quat).add(base);
      }
      out.copy(chosen);
      heading = Math.atan2(chosen.x - base.x, chosen.z - base.z); // step away from the car
    } else {
      out.copy(this.pos);
    }

    const gy = this._sampleGround(out.x, out.y, out.z, 3);
    this._leaveVehicleState();      // state first, so our own event below is ignored by the handler
    this.pos.set(out.x, Math.max(gy, Math.min(out.y, gy + 3)), out.z);
    this.heading = heading;
    this.onGround = false;
    this.cam.snap(this.cam.yaw);
    this.events.emit('player:exitVehicle', { vehicleId: id, position: { x: this.pos.x, y: this.pos.y, z: this.pos.z } });
  }

  // =====================================================================================
  // Death / respawn
  // =====================================================================================

  _die(source) {
    if (this.dead) return;
    if (this.inVehicle) this._exitVehicle();
    this.dead = true;
    this.health = 0;
    this.vel.set(0, 0, 0);
    this.crouching = false;
    this.sprinting = false;
    this._respawnTimer = CFG.respawnDelay;
    this._setPrompt(null, null);
    this.events.emit('player:died', { source });
  }

  _updateDead(dt) {
    this.vel.x = this.vel.z = 0;
    // Keep lying on the ground (terrain may move under us only via teleport)
    this.cam.look(this.input.lookX, this.input.lookY);
    this.cam.update(dt, this.pos, 0.6, 0);
    this._respawnTimer -= dt;
    if (this._respawnTimer <= 0) this._respawn();
  }

  _respawn() {
    this.dead = false;
    this.health = CFG.maxHealth;
    this.stamina = CFG.maxStamina;
    this._exhausted = false;
    this._placeAt(this._spawn.x, undefined, this._spawn.z, this._spawn.heading);
    this.cam.snap(this.heading + Math.PI);
    this.events.emit('player:respawned', { position: { x: this.pos.x, y: this.pos.y, z: this.pos.z } });
  }

  // =====================================================================================
  // Placement, events, state broadcast
  // =====================================================================================

  _placeAt(x, y, z, heading) {
    const gy = this._worldGround(x, z);
    this.pos.set(x, y === undefined ? gy : y, z);
    this.vel.set(0, 0, 0);
    if (heading !== undefined) this.heading = heading;
    this.onGround = y === undefined;
    this._snapCamera = true;
    this.cam.snap(this.cam.yaw);
  }

  _emitFootstep() {
    let surface = 'ground';
    const w = this.world;
    if (w && typeof w.getNearestRoad === 'function') {
      const r = w.getNearestRoad(this.pos.x, this.pos.z);
      if (r && Number.isFinite(r.distance) && r.distance < (r.width ? r.width / 2 : 3)) surface = 'road';
    }
    this.events.emit('player:footstep', {
      position: { x: this.pos.x, y: this.pos.y, z: this.pos.z },
      sprinting: this.sprinting,
      surface,
    });
  }

  _broadcastState(dt) {
    this._stateTimer -= dt;
    if (this._stateTimer > 0) return;
    this._stateTimer = CFG.stateInterval;
    this.events.emit('player:state', {
      position: { x: this.pos.x, y: this.pos.y, z: this.pos.z },
      heading: this.heading,
      speed: Math.hypot(this.vel.x, this.vel.z),
      onGround: this.onGround,
      crouching: this.crouching,
      sprinting: this.sprinting,
      inVehicle: this.inVehicle,
      health: this.health,
      stamina: this.stamina,
      dead: this.dead,
    });
  }

  _on(name, fn) {
    const r = this.events.on(name, fn);
    if (typeof r === 'function') this._unsubs.push(r);
    else this._unsubs.push(() => { if (this.events.off) this.events.off(name, fn); });
  }

  _register(d) {
    if (!d || d.id === undefined) return;
    const isVehicle = d.type === 'vehicle';
    this._interactables.set(d.id, {
      id: d.id,
      type: d.type || 'generic',
      object3D: d.object3D || null,
      position: d.position || null,
      radius: d.radius || (isVehicle ? CFG.vehicleRadius : CFG.interactRadius),
      prompt: d.prompt || (isVehicle ? 'Enter vehicle' : 'Interact'),
      event: d.event || null,
      data: d.data !== undefined ? d.data : d,
      exitOffsets: d.exitOffsets || null,
    });
  }

  _bindEvents() {
    this._on('interactable:register', (d) => this._register(d));
    this._on('interactable:unregister', (d) => { if (d) this._interactables.delete(d.id); });

    // Convenience for the vehicles module: spawned vehicles become enterable automatically.
    this._on('vehicle:spawned', (d) => {
      if (d && d.id !== undefined && d.object3D) this._register({ ...d, type: 'vehicle', data: d });
    });
    this._on('vehicle:removed', (d) => {
      if (!d) return;
      this._interactables.delete(d.id);
      if (this.inVehicle && this._vehicle && this._vehicle.id === d.id) this._exitVehicle();
    });

    // External control of vehicle state (missions, police, scripted scenes)
    this._on('player:enterVehicle', (d) => {
      if (this.inVehicle || this.dead || !d) return;
      const rec = this._interactables.get(d.vehicleId) ||
        { id: d.vehicleId, object3D: d.object3D || null, data: d };
      this._enterVehicleState(rec);
    });
    this._on('player:exitVehicle', (d) => {
      if (this.inVehicle) this._exitVehicle(d || {});
    });
    this._on('vehicle:crashed', (d) => {
      if (!this.inVehicle || !d) return;
      if (d.vehicleId !== undefined && this._vehicle && d.vehicleId !== this._vehicle.id) return;
      const impact = d.impact !== undefined ? d.impact : d.speed || 0;
      this.damage(Math.max(0, impact - 10) * 2.5, 'crash');
    });

    this._on('player:teleport', (d) => {
      if (d) this.teleport(d.x, d.y, d.z, d.heading);
    });
    this._on('player:setSpawn', (d) => {
      if (d) this._spawn = { x: d.x, z: d.z, heading: d.heading !== undefined ? d.heading : this._spawn.heading };
    });
    this._on('player:damage', (d) => { if (d) this.damage(d.amount, d.source); });
    this._on('player:heal', (d) => { if (d) this.heal(d.amount); });

    this._on('game:paused', () => { this._paused = true; this.input.setEnabled(false); });
    this._on('game:resumed', () => { this._paused = false; this.input.setEnabled(true); });
  }
}

export default Player;
