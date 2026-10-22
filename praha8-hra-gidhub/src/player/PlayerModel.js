// src/player/PlayerModel.js
// Procedural low-poly humanoid (about 1.85 m tall) with code-driven animation.
// No external assets. Model faces +Z when root.rotation.y = 0. Origin = feet.
//
// Animation states (blended): idle, walk / jog / sprint, crouch, air (jump / fall), dead.

import * as THREE from 'three';

const DEFAULT_OUTFIT = {
  skin: 0xc99a74,
  hair: 0x2a2018,
  shirt: 0x4a6572,
  pants: 0x2f3340,
  shoes: 0xe6e6e6,
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

export class PlayerModel {
  constructor(outfit = {}) {
    const o = { ...DEFAULT_OUTFIT, ...outfit };
    this.mats = {
      skin: new THREE.MeshLambertMaterial({ color: o.skin }),
      hair: new THREE.MeshLambertMaterial({ color: o.hair }),
      shirt: new THREE.MeshLambertMaterial({ color: o.shirt }),
      pants: new THREE.MeshLambertMaterial({ color: o.pants }),
      shoes: new THREE.MeshLambertMaterial({ color: o.shoes }),
    };
    this._geoms = [];

    this.root = new THREE.Group();
    this.root.name = 'PlayerModel';
    this.body = new THREE.Group(); // rotated as a whole when dead
    this.root.add(this.body);

    this.hips = new THREE.Group();
    this.hips.position.y = 0.95;
    this.body.add(this.hips);
    this._box(0.38, 0.2, 0.22, this.mats.pants, this.hips, 0, 0, 0);

    // Torso + head + arms
    this.torso = new THREE.Group();
    this.torso.position.y = 0.08;
    this.hips.add(this.torso);
    this._box(0.42, 0.54, 0.24, this.mats.shirt, this.torso, 0, 0.27, 0);

    this.head = new THREE.Group();
    this.head.position.y = 0.58;
    this.torso.add(this.head);
    this._box(0.07, 0.08, 0.07, this.mats.skin, this.head, 0, 0.04, 0); // neck
    const headMesh = this._sphere(0.115, this.mats.skin, this.head, 0, 0.15, 0);
    headMesh.scale.set(0.95, 1.1, 1.0);
    const hair = this._sphere(0.122, this.mats.hair, this.head, 0, 0.17, -0.015);
    hair.scale.set(0.97, 0.95, 1.0);
    this._box(0.04, 0.05, 0.04, this.mats.skin, this.head, 0, 0.14, 0.115); // nose marks the front

    this.arms = [this._buildArm(+1), this._buildArm(-1)];
    this.legs = [this._buildLeg(+1), this._buildLeg(-1)];

    // Animation state
    this.phase = 0;
    this._t = 0;
    this._lastStepIndex = 0;
    this._airW = 0;
    this._crouchW = 0;
    this._deadW = 0;
  }

  // ---- construction helpers ----

  _box(w, h, d, mat, parent, x, y, z) {
    const g = new THREE.BoxGeometry(w, h, d);
    this._geoms.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  _sphere(r, mat, parent, x, y, z) {
    const g = new THREE.SphereGeometry(r, 12, 10);
    this._geoms.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  _buildArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.27, 0.5, 0);
    this.torso.add(shoulder);
    this._box(0.1, 0.3, 0.1, this.mats.shirt, shoulder, 0, -0.15, 0);
    const elbow = new THREE.Group();
    elbow.position.y = -0.3;
    shoulder.add(elbow);
    this._box(0.09, 0.26, 0.09, this.mats.skin, elbow, 0, -0.13, 0);
    this._box(0.08, 0.08, 0.08, this.mats.skin, elbow, 0, -0.3, 0);
    return { side, shoulder, elbow };
  }

  _buildLeg(side) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.1, -0.05, 0);
    this.hips.add(hip);
    this._box(0.16, 0.45, 0.17, this.mats.pants, hip, 0, -0.225, 0);
    const knee = new THREE.Group();
    knee.position.y = -0.45;
    hip.add(knee);
    this._box(0.14, 0.45, 0.15, this.mats.pants, knee, 0, -0.225, 0);
    this._box(0.13, 0.08, 0.28, this.mats.shoes, knee, 0, -0.41, 0.05);
    return { side, hip, knee };
  }

  // ---- public API ----

  setVisible(v) {
    this.root.visible = !!v;
  }

  /** Change clothing colours at runtime, e.g. { shirt: 0xff0000 }. */
  setOutfit(outfit) {
    for (const k of Object.keys(outfit)) {
      if (this.mats[k]) this.mats[k].color.set(outfit[k]);
    }
  }

  /**
   * Advance the animation.
   * @param {number} dt seconds
   * @param {{speed:number, grounded:boolean, crouch:number, dead:boolean}} s
   *   speed = horizontal speed in m/s, crouch = 0..1 target
   * @returns {boolean} true on the frame a footstep lands (for sound events)
   */
  update(dt, s) {
    const k = (rate) => 1 - Math.exp(-rate * dt);
    this._t += dt;
    this._crouchW += (s.crouch - this._crouchW) * k(12);
    this._airW += ((s.grounded ? 0 : 1) - this._airW) * k(14);
    this._deadW += ((s.dead ? 1 : 0) - this._deadW) * k(6);

    const speed = s.speed;
    const alive = 1 - this._deadW;
    const moveW = clamp(speed / 0.8, 0, 1) * (1 - this._airW) * alive;
    const run = clamp((speed - 2.5) / 4.5, 0, 1);
    const cw = this._crouchW;

    this.phase += dt * (4.2 + speed * 1.7) * (moveW > 0.01 ? 1 : 0);
    const amp = (0.35 + 0.65 * clamp(speed / 7, 0, 1)) * (1 - 0.5 * cw);
    const crouchAngle = cw * 1.0;

    // Legs
    for (const leg of this.legs) {
      const ph = this.phase + (leg.side > 0 ? 0 : Math.PI);
      let thigh = -Math.sin(ph) * amp * moveW - crouchAngle;
      let knee = Math.max(0, Math.cos(ph)) * amp * 1.3 * moveW + crouchAngle;
      // Air pose: one leg forward and bent, one trailing.
      const airThigh = leg.side > 0 ? -0.6 : 0.25;
      const airKnee = leg.side > 0 ? 0.9 : 0.3;
      thigh = lerp(thigh, airThigh, this._airW);
      knee = lerp(knee, airKnee, this._airW);
      leg.hip.rotation.x = thigh;
      leg.knee.rotation.x = knee;
    }

    // Arms swing opposite to the leg on the same side
    for (const arm of this.arms) {
      const ph = this.phase + (arm.side > 0 ? 0 : Math.PI);
      const idle = Math.sin(this._t * 1.5 + (arm.side > 0 ? 0 : 1.3)) * 0.03;
      let swing = Math.sin(ph) * amp * 0.85 * moveW + idle * (1 - moveW);
      let elbow = -(0.25 + 0.9 * run) * moveW - 0.12 * cw;
      swing = lerp(swing, -0.5, this._airW);
      elbow = lerp(elbow, -0.5, this._airW);
      arm.shoulder.rotation.x = swing - 0.2 * cw;
      arm.shoulder.rotation.z = arm.side * (0.06 + this._airW * 0.5);
      arm.elbow.rotation.x = elbow;
    }

    // Hips: height from crouch, bobbing from gait
    const bob = (1 - Math.abs(Math.sin(this.phase))) * 0.04 * moveW * (0.5 + run);
    this.hips.position.y = 0.05 + 0.45 * (1 + Math.cos(crouchAngle)) + bob;
    this.hips.position.z = -0.4 * Math.sin(crouchAngle);

    // Torso: lean into the run, twist with the stride, breathe when idle
    this.torso.rotation.x = 0.04 + run * 0.28 * moveW + cw * 0.35 + this._airW * 0.08;
    this.torso.rotation.y = Math.sin(this.phase) * 0.12 * moveW;
    this.torso.scale.y = 1 + Math.sin(this._t * 1.8) * 0.008 * (1 - moveW);
    this.head.rotation.x = -this.torso.rotation.x * 0.5;
    this.head.rotation.y = -this.torso.rotation.y;

    // Death: fall backwards and lie on the ground
    this.body.rotation.x = -this._deadW * Math.PI / 2;
    this.body.position.y = this._deadW * 0.12;

    // Footstep detection: every half cycle
    const stepIndex = Math.floor(this.phase / Math.PI);
    let stepped = false;
    if (stepIndex !== this._lastStepIndex) {
      this._lastStepIndex = stepIndex;
      stepped = moveW > 0.5 && s.grounded;
    }
    return stepped;
  }

  dispose() {
    for (const g of this._geoms) g.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
    this._geoms.length = 0;
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}
