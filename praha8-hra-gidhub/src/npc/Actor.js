/**
 * Actor = humanoid model + position + health + lightweight "ragdoll".
 * Brains (pedestrians, cops) only call setMove()/stop()/special and damage()/launch().
 *
 * States: alive -> falling -> lying (corpse)        (shot)
 *         alive -> ragdoll -> lying -> (alive again if still healthy)   (hit by a car)
 */
import * as THREE from 'three';
import { createHumanoid } from './HumanoidModel.js';
import { clamp, lerpAngle, rand } from './npcCommon.js';

let nextActorId = 1;
const TWO_PI = Math.PI * 2;
const LYING_HEIGHT = 0.14;

export class Actor {
  constructor(scene, archetype, x, y, z, opts = {}) {
    this.scene = scene;
    this.kind = opts.kind ?? 'civilian'; // 'civilian' | 'cop'
    this.id = `${this.kind}_${nextActorId++}`;
    this.model = createHumanoid(archetype, opts);
    this.group = this.model.root;
    this.group.scale.setScalar(rand(0.95, 1.05));

    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.heading = opts.heading ?? Math.random() * TWO_PI;
    this.moveHeading = this.heading;
    this.moveSpeed = 0;
    this.turnRate = 7;
    this.special = null; // forced pose: 'phone' | 'aim' | 'handsUp' | null (auto walk/run/stand)

    this.health = opts.health ?? 100;
    this.maxHealth = this.health;
    this.state = 'alive';
    this.phase = Math.random() * 6;
    this.timer = 0;
    this.corpseAge = 0;
    this.getUpT = 0;
    this.spin = 0;
    this.expired = false;
    this.userData = {};
    this._rotX = 0;
    this._lyingX = -Math.PI / 2;

    scene.add(this.group);
    this._apply();
  }

  get alive() {
    return this.state === 'alive';
  }

  get dead() {
    return this.health <= 0;
  }

  setMove(heading, speed) {
    this.moveHeading = heading;
    this.moveSpeed = speed;
  }

  stop() {
    this.moveSpeed = 0;
  }

  /** Returns true if this hit killed the actor. */
  damage(amount) {
    if (this.health <= 0) return false;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.corpseAge = 0;
      if (this.state === 'alive') this._startFalling();
      this.model.setPose('dead');
      return true;
    }
    return false;
  }

  /** Throws the actor through the air (hit by a vehicle). Works on dead bodies too. */
  launch(vx, vy, vz) {
    this.state = 'ragdoll';
    this.vel.set(vx, vy, vz);
    this.spin = -rand(6, 10);
    this.moveSpeed = 0;
    this.special = null;
    this.getUpT = 0;
    this.model.setPose('dead');
    this.model.animate(0, 0);
  }

  _startFalling() {
    this.state = 'falling';
    this.timer = 0;
    this.moveSpeed = 0;
    this.special = null;
    this._lyingX = -Math.PI / 2;
  }

  update(dt, ground) {
    const gy = ground(this.pos.x, this.pos.z);
    switch (this.state) {
      case 'alive': {
        this.heading = lerpAngle(this.heading, this.moveHeading, Math.min(1, dt * this.turnRate));
        const sp = this.moveSpeed;
        if (sp > 0.01) {
          this.pos.x += Math.sin(this.heading) * sp * dt;
          this.pos.z += Math.cos(this.heading) * sp * dt;
        }
        this.phase += (4 * Math.min(sp, 2) + 1.2 * Math.max(0, sp - 2)) * dt;
        const pose = this.special ?? (sp < 0.1 ? 'stand' : sp < 3 ? 'walk' : 'run');
        this.model.setPose(pose);
        this.model.animate(this.phase, pose === 'run' ? 1 : clamp(sp / 1.4, 0, 1));
        this.pos.y = gy;
        this._rotX = 0;
        break;
      }
      case 'falling': {
        this.timer += dt;
        const t = Math.min(1, this.timer / 0.55);
        this._rotX = (-Math.PI / 2) * t * t;
        this.pos.y = gy + LYING_HEIGHT * t;
        if (t >= 1) {
          this.state = 'lying';
          this._rotX = this._lyingX;
        }
        break;
      }
      case 'ragdoll': {
        this.vel.y -= 14 * dt;
        this.pos.addScaledVector(this.vel, dt);
        this._rotX += this.spin * dt;
        if (this.pos.y <= gy + LYING_HEIGHT && this.vel.y < 0) {
          if (Math.abs(this.vel.y) > 3.5) {
            this.vel.y *= -0.28;
            this.vel.x *= 0.7;
            this.vel.z *= 0.7;
            this.pos.y = gy + LYING_HEIGHT;
          } else {
            this.state = 'lying';
            this.vel.y = 0;
            this.pos.y = gy + LYING_HEIGHT;
            this._rotX = ((((this._rotX + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
            this._lyingX = Math.random() < 0.5 ? -Math.PI / 2 : Math.PI / 2;
          }
        }
        break;
      }
      case 'lying': {
        this.pos.x += this.vel.x * dt;
        this.pos.z += this.vel.z * dt;
        const decay = Math.exp(-5 * dt);
        this.vel.x *= decay;
        this.vel.z *= decay;
        this.pos.y = gy + LYING_HEIGHT;
        this._rotX += (this._lyingX - this._rotX) * Math.min(1, dt * 10);
        if (this.health > 0) {
          this.getUpT += dt;
          if (this.getUpT > 2.5) {
            this.state = 'alive';
            this.getUpT = 0;
            this._rotX = 0;
            this.pos.y = gy;
          }
        } else {
          this.corpseAge += dt;
          if (this.corpseAge > 25) this.pos.y -= 0.3 * dt; // sink into the ground
          if (this.corpseAge > 28) this.expired = true;
        }
        break;
      }
      default:
    }
    this._apply();
  }

  _apply() {
    this.group.position.copy(this.pos);
    this.group.rotation.set(this._rotX, this.heading, 0);
  }

  remove() {
    this.scene.remove(this.group);
  }
}
