// PROTOTYPE NpcManager: pedestrians only. No traffic, police or wanted logic yet (wanted stays 0).
import { PedestrianSystem } from './PedestrianSystem.js';
import { PlayerTracker, RoadQuery, ViewCuller } from './npcCommon.js';

export default class NpcManager {
  init(ctx) {
    this.ctx = ctx; this.scene = ctx.scene; this.events = ctx.events;
    this.player = new PlayerTracker(ctx.events, ctx.camera);
    this.road = new RoadQuery(ctx.world);
    this.view = new ViewCuller(ctx.camera);
    this.vehicles = new Map(); // id -> Vehicle, read by PedestrianSystem
    this.obstacles = [];
    this.peds = new PedestrianSystem(this);
    ctx.events.emit('wanted:changed', 0);
  }
  update(dt) {
    this.vehicles.clear();
    for (const v of this.ctx.vehicles?.getAll() ?? []) this.vehicles.set(v.id, v);
    this.player.update(dt);
    this.view.update();
    this.peds.update(dt);
  }
  dispose() { this.peds?.dispose(); this.player?.dispose(); }
}
