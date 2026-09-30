// Scenarios for e2e/vehicle-qa.mjs: player reports, replayed.
//
// Cars are the city fleet's indices (server/src/city_fleet.rs DEFAULT_FLEET):
// 0 monster truck (63, 8), 1 desert runner (-63, -8), 2 derby sedan (8, 63),
// 3 circuit special (-8, -63), 4 buggy (63, -8); each faces downtown.
//
// Steps: {resetCity}, {joinBeside: car, offset: [dx,0,dz]}, {aimAt: car},
// {fire: {count, intervalMs, reaim: car}}, {meteor: car}, {enter: car},
// {driveTo: {car, to: car | [x,y,z], speed, maxMs, arrive}}, {wait: ms}.
// Checks: {car, drawnFlicker: {max}}, {car, carFlicker: {max}},
// {car, spinFlicker: {max}} (loose parts turning A -> B -> A three or more
// times: rocking, drawn in two places), {car, partsOff: {min, max}}, {car, wheelsOn: true}.
export const scenarios = {
  'cannonball-wreck': {
    description: 'Report 2026-09-29: shoot a car with cannonballs several times; loose parts must not be drawn in two places',
    shotMode: 'cannonball',
    cars: [1],
    steps: [
      { resetCity: true },
      { joinBeside: 1, offset: [0, 0, -12] },
      { aimAt: 1 },
      { fire: { count: 4, intervalMs: 1500, reaim: 1 }, label: 'shot' },
      { wait: 6000 },
    ],
    checks: [
      { car: 1, partsOff: { min: 5 } },
      { car: 1, drawnFlicker: { max: 3 } },
      { car: 1, spinFlicker: { max: 0 } },
      { car: 1, carFlicker: { max: 0 } },
    ],
  },
  'rifle-wreck': {
    description: 'Rifle a car repeatedly; whatever breaks must not flicker',
    shotMode: 'rifle',
    cars: [1],
    steps: [
      { resetCity: true },
      { joinBeside: 1, offset: [0, 0, -10] },
      { aimAt: 1 },
      { fire: { count: 40, intervalMs: 120, reaim: 1 } },
      { wait: 4000 },
    ],
    checks: [
      { car: 1, drawnFlicker: { max: 3 } },
      { car: 1, carFlicker: { max: 0 } },
    ],
  },
  'meteor-wreck': {
    description: "Drop the city's meteor on a car beside the player; the wreck must be drawn steadily",
    cars: [4],
    steps: [
      { resetCity: true },
      { joinBeside: 4, offset: [0, 0, -16] },
      { meteor: 4 },
      { wait: 9000 },
    ],
    checks: [
      { car: 4, partsOff: { min: 50 } },
      { car: 4, drawnFlicker: { max: 3 } },
      { car: 4, spinFlicker: { max: 0 } },
    ],
  },
  'drive-over-wreck': {
    description: 'Report 2026-09-29: wreck the buggy with cannonballs, then drive the monster truck over its debris; its wheels must stay on',
    shotMode: 'cannonball',
    cars: [0, 4],
    steps: [
      { resetCity: true },
      { joinBeside: 4, offset: [0, 0, -12] },
      { aimAt: 4 },
      { fire: { count: 4, intervalMs: 1500, reaim: 4 }, label: 'wrecked' },
      { wait: 3000 },
      { joinBeside: 0, offset: [2.5, 0, 0] },
      { enter: 0 },
      { driveTo: { car: 0, to: 4, speed: 8, maxMs: 12000, arrive: 2 }, label: 'at wreck' },
      { driveTo: { car: 0, to: [63, 0.5, -30], speed: 8, maxMs: 8000 } },
    ],
    checks: [
      { car: 4, partsOff: { min: 5 } },
      { car: 0, wheelsOn: true },
      { car: 0, partsOff: { max: 2 } },
    ],
  },
};
