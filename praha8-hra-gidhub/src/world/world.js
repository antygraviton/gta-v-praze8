import { bucket, Chunk, CHUNK, key } from './chunks.js';

// World module: loads Prague 8 GeoJSON, streams 500 m chunks around the camera.
export class World {
  constructor({ url = './data/praha8.geojson', loadRadius = 1500, keepRadius = 2200 } = {}) {
    this.url = url; this.loadRadius = loadRadius; this.keepRadius = keepRadius;
    this.buckets = new Map(); this.chunks = new Map(); this.ready = false;
  }
  async init(ctx) {
    this.ctx = ctx; ctx.world = this;
    this.buckets = bucket(await (await fetch(this.url)).json());
    this.ready = true;
    ctx.events.emit('world:ready', { chunks: this.buckets.size });
  }
  update(dt) {
    if (!this.ready) return;
    const { x, z } = this.ctx.camera.position;
    for (const [k, c] of this.chunks) {
      const d = c.data;
      if (Math.hypot((d.cx + 0.5) * CHUNK - x, (d.cz + 0.5) * CHUNK - z) > this.keepRadius) {
        this.ctx.scene.remove(c.group); c.dispose(); this.chunks.delete(k);
      }
    }
    // Build at most one chunk per frame, nearest first.
    let best = null, bd = this.loadRadius;
    for (const [k, d] of this.buckets) {
      if (this.chunks.has(k)) continue;
      const dist = Math.hypot((d.cx + 0.5) * CHUNK - x, (d.cz + 0.5) * CHUNK - z);
      if (dist < bd) { bd = dist; best = [k, d]; }
    }
    if (best) { const c = new Chunk(best[1]); this.chunks.set(best[0], c); this.ctx.scene.add(c.group); }
  }
  getGroundHeight(x, z) { return 0; } // flat for now; swap in heightmap later
  getNearestRoad(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    let best = null;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const b = this.buckets.get(key(cx + i, cz + j)); if (!b) continue;
      for (const { pts, type } of b.r) for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1], dx = bx - ax, dz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        const px = ax + t * dx, pz = az + t * dz, d = Math.hypot(x - px, z - pz);
        if (!best || d < best.distance) best = { x: px, z: pz, distance: d, type };
      }
    }
    return best;
  }
  dispose() { for (const c of this.chunks.values()) { this.ctx.scene.remove(c.group); c.dispose(); } this.chunks.clear(); }
}
