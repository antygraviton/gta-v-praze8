/**
 * One drivable vehicle: cannon-es RaycastVehicle physics + automatic gearbox +
 * aerodynamics + extra gravity while airborne + damage + visual sync.
 *
 * Conventions: +Z forward, +Y up, +X left. Heading 0 = facing +Z.
 * Control inputs (all 0..1, steer -1..1 where +1 = LEFT):
 *   controls = { throttle, brake, steer, handbrake, horn }
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { buildVehicleModel, drawCluster } from './VehicleModel.js';
import { hullHalfWidth } from './vehicleSpecs.js';

let nextId = 1;
const GRAVITY = 9.82;
const RAD_S_TO_RPM = 9.5493; // 60 / (2π)

/**
 * Sign conventions of cannon-es' RaycastVehicle differ between axis setups.
 * These two are auto-calibrated at runtime the first time a car really accelerates / steers,
 * so a wrong guess here only costs a fraction of a second once.
 */
const calib = { engineSign: 1, steerSign: 1, engineChecked: false, steerChecked: false };

const AXIS_X = new CANNON.Vec3(1, 0, 0);
const AXIS_Y = new CANNON.Vec3(0, 1, 0);
const AXIS_Z = new CANNON.Vec3(0, 0, 1);
const T_X = new THREE.Vector3(1, 0, 0);
const T_Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _qs = new THREE.Quaternion();
const _qr = new THREE.Quaternion();

const DRIVE_SPLIT = {
  fwd: [0.5, 0.5, 0, 0],
  rwd: [0, 0, 0.5, 0.5],
  awd: [0.28, 0.28, 0.22, 0.22],
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class Vehicle {
  /**
   * @param {object} ctx      game context (scene, events, world ...)
   * @param {CANNON.World} world
   * @param {object} spec     entry of VEHICLE_SPECS
   * @param {{x?:number,y?:number,z?:number,heading?:number,color?:number,ai?:boolean,id?:string,material?:CANNON.Material,plate?:string}} opts
   */
  constructor(ctx, world, spec, opts = {}) {
    this.ctx = ctx;
    this.world = world;
    this.spec = spec;
    this.id = opts.id ?? `${spec.id}_${nextId++}`;
    this.type = spec.id;

    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0, horn: false };
    this.occupied = false; // true while the player drives it
    this.ai = !!opts.ai; // true if another module drives it via setControls()
    this.engineOn = this.ai;
    this.lightsOn = false;
    this.health = 100;
    this.destroyed = false;

    this.gear = 1;
    this.reverse = false;
    this.shiftTimer = 0;
    this.rpm = spec.engine.idle;
    this.speed = 0; // signed forward speed, m/s
    this.lateral = 0; // signed lateral speed, m/s (+ = left)
    this.slip = 0; // 0..1 tire slip amount
    this.steer = 0; // smoothed steering input -1..1
    this.steerAngle = 0; // actual front wheel angle, rad
    this.rollAngle = 0; // wheel spin angle for visuals
    this.groundWheels = 0;
    this.upright = 1;
    this.accel = { x: 0, z: 0 }; // smoothed local acceleration (for head sway)

    this.onCrash = null; // set by the manager
    this.sound = null; // set by the manager
    this.clusterActive = false;
    this._clusterT = 0;
    this._lastCrash = -10;
    this._brakeLit = false;
    this._cal = { t: 0, v0: 0, dir: 1, st: 0 };

    this._prevVel = new CANNON.Vec3();
    this._f = new CANNON.Vec3();
    this._l = new CANNON.Vec3();
    this._u = new CANNON.Vec3();
    this._tmp = new CANNON.Vec3();

    // ---------- visuals ----------
    this.model = buildVehicleModel(spec, { color: opts.color, plate: opts.plate });
    ctx.scene.add(this.model.root);
    this.model.wheels.forEach((w) => ctx.scene.add(w));

    // ---------- physics ----------
    const hullHalf = hullHalfWidth(spec);
    const b = spec.body;
    const half = new CANNON.Vec3(hullHalf * 0.92, 0.3, (b.zFront - b.zRear) / 2 - 0.2);
    this.chassis = new CANNON.Body({
      mass: spec.mass,
      material: opts.material,
      linearDamping: 0.01,
      angularDamping: 0.4,
    });
    this.chassis.addShape(new CANNON.Box(half));
    this.chassis.position.set(opts.x ?? 0, opts.y ?? spec.cgHeight + 0.4, opts.z ?? 0);
    this.chassis.quaternion.setFromAxisAngle(AXIS_Y, opts.heading ?? 0);

    this.vehicle = new CANNON.RaycastVehicle({
      chassisBody: this.chassis,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    });

    const R = spec.wheelRadius;
    const sus = spec.suspension;
    const yc = R - spec.cgHeight + sus.rest * 0.75; // wheel hub height at rest equals the radius
    const tw = spec.track / 2;
    const wb = spec.wheelbase / 2;
    const base = {
      radius: R,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      suspensionStiffness: sus.stiffness,
      suspensionRestLength: sus.rest,
      frictionSlip: spec.grip,
      dampingRelaxation: sus.damping,
      dampingCompression: sus.compression,
      maxSuspensionForce: 1e6,
      rollInfluence: sus.roll,
      maxSuspensionTravel: sus.travel,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true,
    };
    // order: 0 front-left, 1 front-right, 2 rear-left, 3 rear-right (left = +x)
    [[tw, wb], [-tw, wb], [tw, -wb], [-tw, -wb]].forEach(([x, z]) => {
      this.vehicle.addWheel({ ...base, chassisConnectionPointLocal: new CANNON.Vec3(x, yc, z) });
    });
    this.vehicle.addToWorld(world);

    this.chassis.addEventListener('collide', (e) => this._onCollide(e));
    this._syncVisuals();
  }

  // ---------- public api ----------

  /** For AI / other modules: assign control inputs. */
  setControls(c) {
    Object.assign(this.controls, c);
  }

  getPosition(out = new THREE.Vector3()) {
    return out.set(this.chassis.position.x, this.chassis.position.y, this.chassis.position.z);
  }

  /** Horizontal forward direction (unit vector). */
  getForward(out = new THREE.Vector3()) {
    this.chassis.vectorToWorldFrame(AXIS_Z, this._f);
    return out.set(this._f.x, 0, this._f.z).normalize();
  }

  /** Where the player is put when leaving the car (left of the driver door). */
  getExitPoint() {
    this.model.root.updateMatrixWorld(true);
    const p = this.model.root.localToWorld(this.model.exitLocal.clone());
    const f = this.getForward();
    return { x: p.x, y: p.y, z: p.z, heading: Math.atan2(f.x, f.z) };
  }

  /** Puts the car back on its wheels (flipped / stuck). */
  respawnUpright() {
    const f = this.getForward();
    const heading = Math.atan2(f.x, f.z);
    this.chassis.position.y += 1.5;
    this.chassis.quaternion.setFromAxisAngle(AXIS_Y, heading);
    this.chassis.velocity.set(0, 0, 0);
    this.chassis.angularVelocity.set(0, 0, 0);
  }

  getTelemetry() {
    const e = this.spec.engine;
    return {
      id: this.id,
      type: this.type,
      speedKmh: Math.abs(this.speed) * 3.6,
      rpm: this.rpm,
      redline: e.redline,
      gear: this.reverse ? 'R' : this.gear,
      throttle: this.controls.throttle,
      brake: this.controls.brake,
      health: this.health,
      lights: this.lightsOn,
      slip: this.slip,
    };
  }

  toggleLights() {
    this.lightsOn = !this.lightsOn;
    this.model.setHeadlights(this.lightsOn);
  }

  // ---------- per-frame ----------

  update(dt) {
    dt = Math.min(Math.max(dt, 1e-4), 0.05);
    const s = this.spec;
    const e = s.engine;
    const ch = this.chassis;
    const c = this.controls;
    const R = s.wheelRadius;
    const wi = this.vehicle.wheelInfos;

    // ----- state -----
    ch.vectorToWorldFrame(AXIS_Z, this._f);
    ch.vectorToWorldFrame(AXIS_X, this._l);
    ch.vectorToWorldFrame(AXIS_Y, this._u);
    const v = ch.velocity;
    const vf = v.dot(this._f);
    const vl = v.dot(this._l);
    const spd = v.length();
    this.speed = vf;
    this.lateral = vl;
    this.upright = this._u.y;

    let grounded = 0;
    let minSkid = 1;
    for (const w of wi) {
      if (w.isInContact) {
        grounded++;
        minSkid = Math.min(minSkid, w.skidInfo ?? 1);
      }
    }
    this.groundWheels = grounded;
    this.slip = Math.max(1 - minSkid, clamp((Math.abs(vl) - 2) / 6, 0, 1));

    // local acceleration (head sway)
    const ax = (v.x - this._prevVel.x) / dt;
    const ay = (v.y - this._prevVel.y) / dt;
    const az = (v.z - this._prevVel.z) / dt;
    this._prevVel.copy(v);
    const alx = ax * this._l.x + ay * this._l.y + az * this._l.z;
    const alz = ax * this._f.x + ay * this._f.y + az * this._f.z;
    const k = Math.min(1, dt * 6);
    this.accel.x += (clamp(alx, -30, 30) - this.accel.x) * k;
    this.accel.z += (clamp(alz, -30, 30) - this.accel.z) * k;

    const driven = (this.occupied || this.ai) && this.health > 0;
    const engineAlive = this.engineOn && this.health > 0;

    // ----- drivetrain -----
    let thr = driven && engineAlive ? clamp(c.throttle, 0, 1) : 0;
    let brk = driven ? clamp(c.brake, 0, 1) : 0;
    const hand = driven ? clamp(c.handbrake, 0, 1) : 0;

    if (!this.reverse && thr < 0.05 && brk > 0.05 && vf < 1.0) this.reverse = true;
    if (this.reverse && thr > 0.05 && vf > -1.0) this.reverse = false;
    const driveIn = this.reverse ? (engineAlive && driven ? brk : 0) : thr;
    const brakeIn = this.reverse ? thr : brk;

    const wheelRpm = (Math.abs(vf) / R) * RAD_S_TO_RPM;
    let ratio = this.reverse ? e.reverse : e.gears[this.gear - 1];
    if (!this.reverse) {
      this.shiftTimer = Math.max(0, this.shiftTimer - dt);
      if (this.shiftTimer === 0) {
        const rpmNow = wheelRpm * ratio * e.final;
        if (this.gear < e.gears.length && rpmNow > e.redline * (0.58 + 0.36 * driveIn)) {
          this.gear++;
          this.shiftTimer = 0.28;
        } else if (this.gear > 1 && rpmNow < e.redline * (0.2 + 0.2 * driveIn)) {
          this.gear--;
          this.shiftTimer = 0.18;
        }
      }
      ratio = e.gears[this.gear - 1];
    } else {
      this.gear = 1;
    }
    const rpmWheel = wheelRpm * ratio * e.final;
    let engRpm = Math.max(rpmWheel, e.idle + driveIn * (e.redline * 0.45 - e.idle));
    engRpm = Math.min(engRpm, e.redline);
    if (!engineAlive) engRpm = 0;
    this.rpm += (engRpm - this.rpm) * Math.min(1, dt * 12);

    const x = engRpm / e.redline;
    const curve = Math.max(0.2, 1 - Math.pow((x - e.peakAt) / 0.65, 2));
    const torque = e.peakTorque * curve * s.torqueScale;
    let force = (torque * driveIn * ratio * e.final * 0.85) / R;
    if (rpmWheel >= e.redline || this.shiftTimer > 0 || !engineAlive) force = 0;
    const over = Math.abs(vf) * 3.6 - s.maxSpeedKmh;
    if (over > 0) force *= Math.max(0, 1 - over / 8);
    const signedForce = (this.reverse ? -1 : 1) * force;

    const split = DRIVE_SPLIT[s.drive] ?? DRIVE_SPLIT.awd;
    for (let i = 0; i < 4; i++) {
      this.vehicle.applyEngineForce(calib.engineSign * signedForce * split[i], i);
    }

    // ----- brakes -----
    let engineBrake = 0;
    if (driven && driveIn < 0.02 && brakeIn < 0.02 && Math.abs(vf) > 0.5) engineBrake = 0.06;
    let holdBrake = 0;
    if (Math.abs(vf) < 0.5 && driveIn < 0.02 && brakeIn < 0.02) holdBrake = 1.5;
    if (!driven) holdBrake = 2; // parked: hold the car

    const front = (brakeIn * s.brake * 1.15 + engineBrake + holdBrake) * s.mass;
    let rear = (brakeIn * s.brake * 0.85 + engineBrake + holdBrake) * s.mass;
    if (hand > 0) rear = Math.max(rear, hand * s.mass * 6);
    this.vehicle.setBrake(front, 0);
    this.vehicle.setBrake(front, 1);
    this.vehicle.setBrake(rear, 2);
    this.vehicle.setBrake(rear, 3);
    const rearGrip = s.grip * (1 - 0.55 * hand);
    wi[2].frictionSlip = rearGrip;
    wi[3].frictionSlip = rearGrip;

    // ----- steering -----
    const target = driven ? clamp(c.steer, -1, 1) : 0;
    const rate = Math.sign(target) !== Math.sign(this.steer) || Math.abs(target) < 0.01 ? 5.0 : 3.0;
    const dS = target - this.steer;
    this.steer += clamp(dS, -rate * dt, rate * dt);
    const fac = 1 / (1 + Math.pow(Math.abs(vf) / s.steerSpeed, 2));
    this.steerAngle = this.steer * s.maxSteer * Math.max(fac, 0.12);
    this.vehicle.setSteeringValue(calib.steerSign * this.steerAngle, 0);
    this.vehicle.setSteeringValue(calib.steerSign * this.steerAngle, 1);

    // ----- aerodynamics, rolling resistance, downforce, extra gravity -----
    if (spd > 0.1) {
      const drag = 0.5 * 1.225 * s.cdA * spd * spd;
      const rolling = grounded > 0 ? s.mass * GRAVITY * 0.012 : 0;
      const total = Math.min(drag + rolling, (s.mass * spd) / dt * 0.5);
      this._tmp.set((-v.x / spd) * total, (-v.y / spd) * total * 0.2, (-v.z / spd) * total);
      ch.applyForce(this._tmp);
    }
    if (grounded > 0 && s.downforce > 0) {
      this._tmp.set(0, -s.downforce * spd * spd, 0);
      ch.applyForce(this._tmp);
    }
    if (grounded === 0) {
      // cars feel floaty in the air: pull them down harder than world gravity
      this._tmp.set(0, -s.mass * GRAVITY * (s.airGravity - 1), 0);
      ch.applyForce(this._tmp);
    }

    // safety net: fell through the world
    const gh = this.ctx.world?.getGroundHeight?.(ch.position.x, ch.position.z) ?? 0;
    if (ch.position.y < gh - 6) {
      ch.position.y = gh + s.cgHeight + 1;
      ch.velocity.set(0, 0, 0);
      ch.angularVelocity.set(0, 0, 0);
    }

    if (driven) this._calibrate(dt, signedForce, vf);

    // ----- visuals -----
    this.rollAngle += (vf / R) * dt;
    this.rollAngle %= Math.PI * 2;
    const braking = brakeIn > 0.1 || hand > 0.1;
    if (braking !== this._brakeLit) {
      this._brakeLit = braking;
      this.model.setBrakeLights(braking);
    }
    this._syncVisuals();

    if (this.clusterActive) {
      this._clusterT -= dt;
      if (this._clusterT <= 0) {
        this._clusterT = 0.066;
        drawCluster(this.model.cluster, {
          speedKmh: Math.abs(vf) * 3.6,
          rpm: this.rpm,
          redline: e.redline,
          maxKmh: Math.min(s.maxSpeedKmh, 300),
          gearLabel: this.reverse ? 'R' : String(this.gear),
        });
      }
    }
  }

  // ---------- internals ----------

  _syncVisuals() {
    const ch = this.chassis;
    const root = this.model.root;
    root.position.set(ch.position.x, ch.position.y, ch.position.z);
    root.quaternion.set(ch.quaternion.x, ch.quaternion.y, ch.quaternion.z, ch.quaternion.w);
    const wi = this.vehicle.wheelInfos;
    for (let i = 0; i < 4; i++) {
      const w = wi[i];
      const p = w.chassisConnectionPointLocal;
      _v.set(p.x, p.y - w.suspensionLength, p.z).applyQuaternion(root.quaternion).add(root.position);
      const mesh = this.model.wheels[i];
      mesh.position.copy(_v);
      _qs.setFromAxisAngle(T_Y, i < 2 ? this.steerAngle : 0);
      _qr.setFromAxisAngle(T_X, this.rollAngle);
      mesh.quaternion.copy(root.quaternion).multiply(_qs).multiply(_qr);
    }
    this.model.steeringSpin.rotation.z = -this.steer * 4.0;
  }

  /** Detects wrong force / steering sign conventions once and fixes them (see `calib`). */
  _calibrate(dt, signedForce, vf) {
    const cal = this._cal;
    if (!calib.engineChecked && Math.abs(signedForce) > 500 && this.groundWheels >= 2) {
      if (cal.t === 0) {
        cal.v0 = vf;
        cal.dir = Math.sign(signedForce);
      }
      cal.t += dt;
      if (cal.t > 0.5) {
        const dv = (vf - cal.v0) * cal.dir;
        if (dv > 0.8) calib.engineChecked = true;
        else if (dv < -0.8) {
          calib.engineSign *= -1;
          calib.engineChecked = true;
          console.warn('[vehicles] engine force sign auto-corrected');
        }
        cal.t = 0;
      }
    } else {
      cal.t = 0;
    }

    if (!calib.steerChecked && vf > 4 && Math.abs(this.steer) > 0.6) {
      cal.st += dt;
      if (cal.st > 0.6) {
        const yaw = this.chassis.angularVelocity.y * Math.sign(this.steer);
        if (yaw > 0.15) calib.steerChecked = true;
        else if (yaw < -0.15) {
          calib.steerSign *= -1;
          calib.steerChecked = true;
          console.warn('[vehicles] steering sign auto-corrected');
        }
        cal.st = 0;
      }
    } else {
      cal.st = 0;
    }
  }

  _onCollide(ev) {
    const impact = Math.abs(ev.contact.getImpactVelocityAlongNormal());
    const now = performance.now() / 1000;
    if (impact < 6 || now - this._lastCrash < 0.5) return;
    this._lastCrash = now;
    this.health = Math.max(0, this.health - impact * impact * 0.3);
    this.model.damage(1 - this.health / 100);
    const info = {
      id: this.id,
      type: this.type,
      impact,
      speedKmh: Math.abs(this.speed) * 3.6,
      health: this.health,
      driver: this.occupied,
      position: { x: this.chassis.position.x, y: this.chassis.position.y, z: this.chassis.position.z },
    };
    this.ctx.events.emit('vehicle:crashed', info);
    if (this.onCrash) this.onCrash(info);
    if (this.health <= 0 && !this.destroyed) {
      this.destroyed = true;
      this.engineOn = false;
      this.ctx.events.emit('vehicle:destroyed', { id: this.id, type: this.type, position: info.position });
    }
  }

  dispose() {
    this.vehicle.removeFromWorld(this.world);
    this.ctx.scene.remove(this.model.root);
    this.model.wheels.forEach((w) => this.ctx.scene.remove(w));
    this.model.dispose();
    if (this.sound) {
      this.sound.dispose();
      this.sound = null;
    }
  }
}
