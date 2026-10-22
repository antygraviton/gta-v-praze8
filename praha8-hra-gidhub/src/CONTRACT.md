# Shared contract
Units: 1 = 1 m, Y up, origin = center of Karlin. Heading 0 = +Z. Module = class with init(ctx), update(dt), dispose().
ctx = { scene, camera, renderer, physics (cannon-es World), events, world }; vehicles also set ctx.vehicles.
Camera: Player on foot, VehicleManager in a car. Core never touches it.

Events (emitter -> data)
- world:ready {chunks} (world)
- player:enterVehicle {vehicleId|id, vehicle} / player:exitVehicle {vehicleId|id, position} (player, vehicles)
- player:state (Player), player:position (bridged in main.js),  player:damaged, player:died, player:respawned (player)
- wanted:changed 0-5 (npc), mission:started / mission:completed (missions), vehicle:crashed (vehicles)
- ui:prompt {id,text,key}, game:started, game:restart (core)
