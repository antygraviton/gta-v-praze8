/**
 * Vehicle specifications.
 *
 * Units: meters, kilograms, Newton-meters, radians.
 * Model frame ("ground frame"): +Z = forward, +Y = up, +X = vehicle LEFT, Y = 0 is the ground at rest.
 * All cars are left-hand drive (driver sits on the +X side).
 *
 * body: side-profile key points (z, y) used to build the hull and the cabin
 *   zFront / zRear : nose and tail
 *   bottomY        : underside height
 *   noseY          : bonnet height at the nose tip
 *   hoodY          : bonnet height at the windshield base (also the door beltline)
 *   trunkY         : rear deck height at the rear window base
 *   rearTopY       : rear deck height at the tail
 *   floorY         : cabin floor height
 *   roofY          : roof height
 *   z1 / z2        : windshield base / windshield top (A-pillar top)
 *   z3 / z4        : roof end / rear window base
 */

/** Half width of the hull (wheels stick out ~6 cm on each side). */
export const hullHalfWidth = (s) => s.track / 2 + s.wheelWidth / 2 - 0.06;

export const VEHICLE_SPECS = {
  // Small green city hatchback
  citycar: {
    id: 'citycar',
    label: 'City car',
    color: 0x62c026,
    paint: { metalness: 0.35, roughness: 0.3 },
    plate: true,
    mass: 929,
    wheelbase: 2.42,
    track: 1.43,
    wheelRadius: 0.285,
    wheelWidth: 0.165,
    rim: { color: 0x1b1b1d, spokes: 5 },
    cgHeight: 0.5,
    drive: 'fwd',
    body: {
      zFront: 1.78, zRear: -1.78, bottomY: 0.2, noseY: 0.66, hoodY: 0.84,
      trunkY: 0.9, rearTopY: 0.86, floorY: 0.3, roofY: 1.46,
      z1: 0.72, z2: 0.1, z3: -1.2, z4: -1.58,
    },
    bPillarZ: -0.3,
    rearSeat: true,
    interior: { dark: 0x1c1d20, seat: 0x2d3035, accent: 0x5b5f66, quilted: false },
    eye: { x: 0.36, y: 1.17, z: -0.42 },
    steeringWheel: { x: 0.36, y: 0.93, z: 0.2, radius: 0.17, tilt: 0.5 },
    screen: { w: 0.2, h: 0.12, y: 0.09 },
    engine: {
      idle: 900, redline: 6200, peakTorque: 95, peakAt: 0.55,
      gears: [3.45, 1.93, 1.27, 0.93, 0.74], reverse: 3.3, final: 4.2,
    },
    torqueScale: 1,
    cdA: 0.66,
    maxSpeedKmh: 165,
    maxSteer: 0.55,
    steerSpeed: 16,
    brake: 2.8,
    grip: 1.5,
    airGravity: 1.8,
    downforce: 0,
    suspension: { stiffness: 30, damping: 2.4, compression: 4.2, rest: 0.28, travel: 0.25, roll: 0.05 },
    chase: { dist: 6.0, height: 2.3 },
    sound: { pitch: 1.5, wave: 'sawtooth', brightness: 0.9 },
  },

  // Sport sedan with a quilted leather interior
  sedan: {
    id: 'sedan',
    label: 'Sport sedan',
    color: 0x1f2a3a,
    paint: { metalness: 0.5, roughness: 0.22 },
    plate: true,
    mass: 1700,
    wheelbase: 2.84,
    track: 1.59,
    wheelRadius: 0.34,
    wheelWidth: 0.235,
    rim: { color: 0xa5a9ae, spokes: 10 },
    cgHeight: 0.55,
    drive: 'awd',
    body: {
      zFront: 2.35, zRear: -2.33, bottomY: 0.15, noseY: 0.66, hoodY: 0.9,
      trunkY: 0.96, rearTopY: 0.92, floorY: 0.3, roofY: 1.4,
      z1: 0.95, z2: 0.3, z3: -0.95, z4: -1.55,
    },
    bPillarZ: -0.3,
    rearSeat: true,
    interior: { dark: 0x17181a, seat: 0x26282c, accent: 0xb9bcc2, quilted: true },
    eye: { x: 0.37, y: 1.18, z: -0.18 },
    steeringWheel: { x: 0.37, y: 0.96, z: 0.43, radius: 0.18, tilt: 0.45 },
    screen: { w: 0.3, h: 0.17, y: 0.2 },
    engine: {
      idle: 800, redline: 6500, peakTorque: 510, peakAt: 0.55,
      gears: [4.7, 3.1, 2.1, 1.7, 1.3, 1.0, 0.84, 0.67], reverse: 3.4, final: 3.15,
    },
    torqueScale: 0.8,
    cdA: 0.6,
    maxSpeedKmh: 270,
    maxSteer: 0.5,
    steerSpeed: 20,
    brake: 3.4,
    grip: 1.85,
    airGravity: 1.7,
    downforce: 0.4,
    suspension: { stiffness: 34, damping: 2.6, compression: 4.6, rest: 0.3, travel: 0.27, roll: 0.04 },
    chase: { dist: 6.8, height: 2.4 },
    sound: { pitch: 3, wave: 'sawtooth', brightness: 1.0 },
  },

  // Black two-seat hypercar
  hypercar: {
    id: 'hypercar',
    label: 'Hypercar',
    color: 0x08080a,
    paint: { metalness: 0.6, roughness: 0.12 },
    plate: false,
    mass: 1900,
    wheelbase: 2.8,
    track: 1.7,
    wheelRadius: 0.37,
    wheelWidth: 0.3,
    rim: { color: 0xb9bec4, spokes: 6 },
    cgHeight: 0.5,
    drive: 'awd',
    body: {
      zFront: 2.4, zRear: -2.4, bottomY: 0.17, noseY: 0.62, hoodY: 0.84,
      trunkY: 0.98, rearTopY: 0.78, floorY: 0.27, roofY: 1.2,
      z1: 0.8, z2: 0.2, z3: -1.1, z4: -1.6,
    },
    bPillarZ: null,
    rearSeat: false,
    interior: { dark: 0x0e0f11, seat: 0x1b1b1e, accent: 0xa03020, quilted: false },
    eye: { x: 0.38, y: 1.04, z: -0.28 },
    steeringWheel: { x: 0.38, y: 0.9, z: 0.28, radius: 0.17, tilt: 0.4 },
    screen: { w: 0.2, h: 0.11, y: 0.1 },
    engine: {
      idle: 1000, redline: 7000, peakTorque: 1500, peakAt: 0.6,
      gears: [3.9, 2.7, 2.0, 1.55, 1.2, 0.95, 0.78], reverse: 3.5, final: 3.0,
    },
    torqueScale: 0.6,
    cdA: 0.72,
    maxSpeedKmh: 420,
    maxSteer: 0.42,
    steerSpeed: 26,
    brake: 4.6,
    grip: 2.4,
    airGravity: 1.6,
    downforce: 2.2,
    suspension: { stiffness: 42, damping: 3.0, compression: 5.2, rest: 0.26, travel: 0.22, roll: 0.03 },
    chase: { dist: 7.2, height: 2.3 },
    sound: { pitch: 4, wave: 'sawtooth', brightness: 1.15 },
  },
};
