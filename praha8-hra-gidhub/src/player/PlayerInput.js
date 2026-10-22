// Keyboard + mouse input for the on-foot player. Pointer lock on canvas click.
const KEYS = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'], crouch: ['KeyC', 'ControlLeft'], walk: ['AltLeft'],
  jump: ['Space'], interact: ['KeyF'],
};

export class PlayerInput {
  constructor(dom, bindings = {}, onLock = () => {}) {
    this.dom = dom || document.body;
    this.keys = { ...KEYS, ...bindings };
    this.onLock = onLock;
    this.enabled = true;
    this.held = new Set(); this.hit = new Set();
    this.lookX = 0; this.lookY = 0; this.wheel = 0;
    this._h = {
      kd: (e) => { if (!e.repeat) this.hit.add(e.code); this.held.add(e.code); },
      ku: (e) => this.held.delete(e.code),
      mm: (e) => { if (this.enabled && document.pointerLockElement === this.dom) { this.lookX += e.movementX; this.lookY += e.movementY; } },
      wh: (e) => { this.wheel += e.deltaY; },
      cl: () => { if (this.enabled && document.pointerLockElement !== this.dom) this.dom.requestPointerLock?.(); },
      pl: () => this.onLock(document.pointerLockElement === this.dom),
      bl: () => this.held.clear(),
    };
  }
  attach() {
    const h = this._h;
    addEventListener('keydown', h.kd); addEventListener('keyup', h.ku); addEventListener('blur', h.bl);
    addEventListener('mousemove', h.mm); addEventListener('wheel', h.wh, { passive: true });
    this.dom.addEventListener('click', h.cl); document.addEventListener('pointerlockchange', h.pl);
  }
  detach() {
    const h = this._h;
    removeEventListener('keydown', h.kd); removeEventListener('keyup', h.ku); removeEventListener('blur', h.bl);
    removeEventListener('mousemove', h.mm); removeEventListener('wheel', h.wh);
    this.dom.removeEventListener('click', h.cl); document.removeEventListener('pointerlockchange', h.pl);
  }
  setEnabled(v) {
    this.enabled = v;
    if (!v) { this.held.clear(); this.hit.clear(); this.lookX = this.lookY = this.wheel = 0; if (document.pointerLockElement === this.dom) document.exitPointerLock(); }
  }
  down(a) { return this.enabled && this.keys[a].some((k) => this.held.has(k)); }
  pressed(a) { return this.enabled && this.keys[a].some((k) => this.hit.has(k)); }
  /** x = right (+1), z = forward (+1) */
  axis() { return { x: +this.down('right') - +this.down('left'), z: +this.down('forward') - +this.down('back') }; }
  endFrame() { this.hit.clear(); this.lookX = this.lookY = this.wheel = 0; }
}
