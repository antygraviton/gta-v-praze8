// Core: scene, renderer, camera, physics, game loop and module loader.
// The camera is NOT driven here: Player owns it on foot, VehicleManager while driving.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { events } from './core/events.js';

// Load order matters: world first (provides ctx.world), vehicles before player.
// A missing or broken module is logged and skipped, the game keeps running.
const MODULES = [
  { name: 'world',    path: './world/world.js' },
  { name: 'vehicles', path: './vehicles/VehicleManager.js' },
  { name: 'player',   path: './player/Player.js' },
  { name: 'npc',      path: './npc/NpcManager.js' },
  { name: 'missions', path: './missions/MissionManager.js' },
  { name: 'ui',       path: './ui/UI.js' },
];

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb8d0);
scene.fog = new THREE.Fog(0x9fb8d0, 300, 1800);
scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(200, 400, 150);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 3000);
camera.position.set(0, 3, 10);

const physics = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
physics.broadphase = new CANNON.SAPBroadphase(physics);
physics.allowSleep = true;

const ctx = { scene, camera, renderer, physics, events, world: null };
const active = []; // { name, inst, failed }

async function loadModules() {
  for (const m of MODULES) {
    try {
      const mod = await import(m.path);
      const Cls = mod.default ?? Object.values(mod).find((v) => typeof v === 'function' && v.prototype?.init);
      if (!Cls) throw new Error('no class with init() exported');
      const inst = new Cls();
      active.push({ name: m.name, inst, failed: false });
      await inst.init(ctx);
      console.info(`[core] module "${m.name}" ready`);
    } catch (e) {
      console.warn(`[core] module "${m.name}" skipped:`, e.message ?? e);
      const i = active.findIndex((a) => a.name === m.name);
      if (i >= 0) active.splice(i, 1);
    }
  }
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  physics.step(1 / 60, dt, 3);
  for (const a of active) {
    if (a.failed) continue;
    try { a.inst.update?.(dt); }
    catch (e) { a.failed = true; console.error(`[core] module "${a.name}" crashed in update, disabled:`, e); }
  }
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Glue: event names differ between Player and NPC modules.
events.on('player:state', (s) => s?.position && events.emit('player:position', s.position));
events.on('player:respawned', (e) => events.emit('player:respawn', e));
events.on('game:restart', () => location.reload());
addEventListener('beforeunload', () => { for (const a of active) a.inst.dispose?.(); });

await loadModules();
if (!ctx.world?.ready) { // fallback when data/praha8.geojson is missing
  const g = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x777777 }));
  scene.add(g, new THREE.GridHelper(4000, 400, 0x333333, 0x555555));
  console.warn('[core] no world data, using flat fallback ground. Run: node tools/fetch-osm.mjs');
}
document.getElementById('loading')?.classList.add('done');
events.emit('game:started', {});
requestAnimationFrame(frame);

window.__game = { ctx, active }; // debugging
