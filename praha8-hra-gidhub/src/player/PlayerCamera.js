// src/player/PlayerCamera.js
// Third-person over-the-shoulder camera with a collision-aware spring arm.
// Convention: yaw = 0 looks toward -Z. Increasing yaw turns the camera to the left.
// Only used while the player is on foot; vehicles own the camera while driving.

import * as THREE from 'three';

const TMP_F = new THREE.Vector3();
const TMP_R = new THREE.Vector3();

export class PlayerCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera shared camera from ctx
   * @param {(from:THREE.Vector3, to:THREE.Vector3)=>number|null} rayFn distance to first obstacle or null
   * @param {(x:number,z:number)=>number} groundFn terrain height
   */
  constructor(camera, rayFn, groundFn) {
    this.camera = camera;
    this.rayFn = rayFn;
    this.groundFn = groundFn;

    this.yaw = 0;
    this.pitch = 0.3;
    this.distance = 3.4;
    this.minDistance = 1.6;
    this.maxDistance = 7.5;
    this.shoulder = 0.45;          // right-shoulder offset in metres
    this.sensitivity = 0.0022;     // radians per pixel
    this.invertY = false;
    this.minPitch = -0.35;
    this.maxPitch = 1.25;
    this.baseFov = 62;
    this.sprintFovBoost = 7;

    this._pivot = new THREE.Vector3();
    this._hasPivot = false;
    this._collDist = this.distance;
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._end = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
  }

  /** Horizontal forward direction of the camera (unit, y = 0). */
  getForward(out) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Horizontal right direction of the camera (unit, y = 0). */
  getRight(out) {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /** Re-seat the camera immediately (after teleport / leaving a vehicle). */
  snap(yaw = this.yaw) {
    this.yaw = yaw;
    this._hasPivot = false;
  }

  /** Apply mouse movement in pixels. */
  look(dx, dy) {
    this.yaw -= dx * this.sensitivity;
    this.pitch += dy * this.sensitivity * (this.invertY ? -1 : 1);
    this.pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.pitch));
    // keep yaw bounded to avoid float drift
    if (this.yaw > Math.PI * 2 || this.yaw < -Math.PI * 2) this.yaw %= Math.PI * 2;
  }

  /** Apply mouse wheel delta. */
  zoom(wheel) {
    if (!wheel) return;
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance + wheel * 0.004));
  }

  /**
   * @param {number} dt seconds
   * @param {THREE.Vector3} target player feet position
   * @param {number} eyeHeight pivot height above the feet
   * @param {number} sprint 0..1 sprint amount (widens FOV)
   */
  update(dt, target, eyeHeight, sprint = 0) {
    const cam = this.camera;
    const pivotY = target.y + eyeHeight;
    if (!this._hasPivot) {
      this._pivot.set(target.x, pivotY, target.z);
      this._collDist = this.distance;
      this._hasPivot = true;
    } else {
      // x/z follow rigidly (no lag while orbiting); y is smoothed to hide steps and crouching.
      this._pivot.x = target.x;
      this._pivot.z = target.z;
      this._pivot.y += (pivotY - this._pivot.y) * (1 - Math.exp(-14 * dt));
    }

    const f = this.getForward(TMP_F);
    const r = this.getRight(TMP_R);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);

    // Spring arm starts at the shoulder-offset pivot and goes backwards / upwards.
    const o = this._origin.copy(this._pivot).addScaledVector(r, this.shoulder);
    const dir = this._dir.set(-f.x * cp, sp, -f.z * cp);

    this._end.copy(o).addScaledVector(dir, this.distance);
    const hit = this.rayFn ? this.rayFn(o, this._end) : null;
    const allowed = hit === null || hit === undefined ? this.distance : Math.max(0.35, hit - 0.25);

    // Shorten instantly (never clip through walls), lengthen smoothly.
    if (allowed < this._collDist) this._collDist = allowed;
    else this._collDist += (allowed - this._collDist) * (1 - Math.exp(-6 * dt));

    cam.position.copy(o).addScaledVector(dir, this._collDist);

    // Never go below the terrain.
    if (this.groundFn) {
      const g = this.groundFn(cam.position.x, cam.position.z);
      if (cam.position.y < g + 0.25) cam.position.y = g + 0.25;
    }

    // Look parallel to the arm so the character sits slightly left of the crosshair.
    this._lookAt.copy(cam.position).addScaledVector(dir, -10);
    cam.lookAt(this._lookAt);

    if (cam.isPerspectiveCamera) {
      const fov = this.baseFov + this.sprintFovBoost * sprint;
      if (Math.abs(cam.fov - fov) > 0.01) {
        cam.fov += (fov - cam.fov) * (1 - Math.exp(-6 * dt));
        cam.updateProjectionMatrix();
      }
    }
  }
}
