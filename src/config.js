export const FIXED_DT = 1 / 120;
export const TOTAL_LAPS = 3;

// Positions are normalized along the closed spline so guidance stays valid when
// the render sample count changes. TrackSystem expands them to sample indices and
// metres after the curve has been measured.
export const ROUTE_GUIDANCE = {
  brakePoints: [
    { id: 'brake-01', progress: 0.285, targetSpeedKmh: 165, turnId: 'turn-01' },
    { id: 'brake-02', progress: 0.475, targetSpeedKmh: 135, turnId: 'turn-02' },
    { id: 'brake-03', progress: 0.565, targetSpeedKmh: 125, turnId: 'turn-03' },
    { id: 'brake-04', progress: 0.690, targetSpeedKmh: 120, turnId: 'turn-04' },
    { id: 'brake-05', progress: 0.875, targetSpeedKmh: 115, turnId: 'turn-05' },
  ],
  turns: [
    { id: 'turn-01', progress: 0.335, direction: 'right', severity: 'hard', targetSpeedKmh: 110 },
    { id: 'turn-02', progress: 0.505, direction: 'right', severity: 'medium', targetSpeedKmh: 125 },
    { id: 'turn-03', progress: 0.610, direction: 'left', severity: 'medium', targetSpeedKmh: 115 },
    { id: 'turn-04', progress: 0.735, direction: 'right', severity: 'hard', targetSpeedKmh: 105 },
    { id: 'turn-05', progress: 0.925, direction: 'right', severity: 'hard', targetSpeedKmh: 100 },
  ],
  markers: {
    enabled: true,
    lateralOffset: 9.0,
    poleHeight: 2.2,
    boardWidth: 1.9,
    boardHeight: 0.9,
    boardDepth: 0.12,
  },
};

const baseTire = {
  mu: 1.05,
  longStiffness: 10.5,
  lateralStiffness: 7.2,
  rollingResistance: 0.014,
};

const baseSuspension = {
  restLength: 0.31,
  travel: 0.18,
  springRate: 34000,
  damperBump: 4200,
  damperRebound: 5200,
  antiRoll: 8500,
};

export const CARS = [
  {
    id: 'mx5', name: 'MAZDA MX-5 NA', file: 'mazda-miata-mx5-na.glb',
    speed: 185, accel: 68, grip: 82, mass: 990, power: 116, torque: 136,
    wheelbase: 2.27, trackWidth: 1.42, wheelRadius: 0.29, steer: 0.46,
    idle: 850, redline: 7000, peakRpm: 5500, gears: [3.136, 1.888, 1.330, 1.000, 0.814],
    finalDrive: 4.30, drivetrain: 'RWD', cdA: 0.66, brakeTorque: 2450,
    suspension: { ...baseSuspension, springRate: 28500, damperBump: 3500, damperRebound: 4300, antiRoll: 6200 },
    tire: { ...baseTire, mu: 0.98, lateralStiffness: 6.6 },
    model: { targetLength: 4.05, yaw: 0, groundOffset: 0.66 },
    audio: { family: 'i4', cylinders: 4, low: 118, mid: 920, high: 2450, drive: 1.25 },
  },
  {
    id: 'm3e30', name: 'BMW M3 E30', file: 'bmw-m3-e30.glb',
    speed: 230, accel: 78, grip: 86, mass: 1200, power: 200, torque: 240,
    wheelbase: 2.56, trackWidth: 1.43, wheelRadius: 0.31, steer: 0.43,
    idle: 900, redline: 7250, peakRpm: 4750, gears: [3.720, 2.400, 1.770, 1.260, 1.000],
    finalDrive: 3.25, drivetrain: 'RWD', cdA: 0.68, brakeTorque: 3100,
    suspension: { ...baseSuspension, springRate: 32000, antiRoll: 7600 },
    tire: { ...baseTire, mu: 1.04, lateralStiffness: 7.0 },
    model: { targetLength: 4.35, yaw: 0, groundOffset: 0.68 },
    audio: { family: 'i4', cylinders: 4, low: 126, mid: 1080, high: 2700, drive: 1.35 },
  },
  {
    id: 'gt3rs', name: 'PORSCHE GT3 RS', file: 'porsche-gt3-rs.glb',
    speed: 296, accel: 96, grip: 98, mass: 1450, power: 525, torque: 465,
    wheelbase: 2.46, trackWidth: 1.62, wheelRadius: 0.335, steer: 0.41,
    idle: 900, redline: 9000, peakRpm: 6300, gears: [3.750, 2.290, 1.720, 1.340, 1.110, 0.960, 0.840],
    finalDrive: 4.25, drivetrain: 'RWD', cdA: 0.862, brakeTorque: 4550,
    suspension: { ...baseSuspension, restLength: 0.27, springRate: 44000, damperBump: 5200, damperRebound: 6500, antiRoll: 12500 },
    tire: { ...baseTire, mu: 1.27, longStiffness: 12.5, lateralStiffness: 8.8 },
    model: { targetLength: 4.55, yaw: 0, groundOffset: 0.64 },
    audio: { family: 'flat6', cylinders: 6, low: 102, mid: 760, high: 3180, drive: 1.42 },
  },
  {
    id: 'lp700', name: 'LAMBORGHINI LP700', file: 'lamborghini-aventador-lp700.glb',
    speed: 350, accel: 99, grip: 91, mass: 1680, power: 700, torque: 690,
    wheelbase: 2.70, trackWidth: 1.72, wheelRadius: 0.345, steer: 0.39,
    idle: 850, redline: 8500, peakRpm: 5500, gears: [3.910, 2.440, 1.810, 1.460, 1.190, 0.970, 0.840],
    finalDrive: 3.73, drivetrain: 'AWD', cdA: 0.72, brakeTorque: 4850,
    suspension: { ...baseSuspension, restLength: 0.28, springRate: 46500, damperBump: 5400, damperRebound: 6800, antiRoll: 13200 },
    tire: { ...baseTire, mu: 1.18, longStiffness: 12.0, lateralStiffness: 8.2 },
    model: { targetLength: 4.78, yaw: 0, groundOffset: 0.65 },
    audio: { family: 'v12', cylinders: 12, low: 94, mid: 690, high: 3900, drive: 1.48 },
  },
  {
    id: 'amggt3', name: 'MERCEDES AMG GT3', file: 'mercedes-amg-gt3.glb',
    speed: 310, accel: 95, grip: 97, mass: 1285, power: 550, torque: 650,
    wheelbase: 2.63, trackWidth: 1.76, wheelRadius: 0.33, steer: 0.40,
    idle: 1000, redline: 7600, peakRpm: 5200, gears: [2.920, 2.080, 1.590, 1.270, 1.060, 0.900],
    finalDrive: 3.67, drivetrain: 'RWD', cdA: 0.96, brakeTorque: 5200,
    suspension: { ...baseSuspension, restLength: 0.25, springRate: 53000, damperBump: 6200, damperRebound: 7600, antiRoll: 15800 },
    tire: { ...baseTire, mu: 1.34, longStiffness: 13.0, lateralStiffness: 9.2 },
    model: { targetLength: 4.72, yaw: 0, groundOffset: 0.63 },
    audio: { family: 'v8', cylinders: 8, low: 82, mid: 620, high: 2260, drive: 1.62 },
  },
  {
    id: 'm5g90', name: 'BMW M5 G90', file: 'bmw-m5-g90.glb',
    speed: 305, accel: 94, grip: 89, mass: 2435, power: 727, torque: 1000,
    wheelbase: 3.01, trackWidth: 1.70, wheelRadius: 0.36, steer: 0.37,
    idle: 700, redline: 7200, peakRpm: 2500, gears: [5.000, 3.200, 2.143, 1.720, 1.314, 1.000, 0.823, 0.640],
    finalDrive: 3.15, drivetrain: 'AWD', cdA: 0.70, brakeTorque: 5850,
    suspension: { ...baseSuspension, restLength: 0.30, springRate: 51500, damperBump: 5900, damperRebound: 7300, antiRoll: 14500 },
    tire: { ...baseTire, mu: 1.12, longStiffness: 11.5, lateralStiffness: 7.7 },
    model: { targetLength: 5.10, yaw: 0, groundOffset: 0.72 },
    audio: { family: 'v8', cylinders: 8, low: 76, mid: 540, high: 1880, drive: 1.58 },
  },
];

export const TRACK_CONFIG = {
  name: '龙湾国际赛道',
  width: 14,
  runoff: 4.5,
  barrierOffset: 11.6,
  samples: 1024,
  checkpoints: 10,
  routeGuidance: ROUTE_GUIDANCE,
  points: [
    [-320, 0, 0], [-110, 0, 0], [115, 0, 0], [325, 0, 0],
    [405, 0, -32], [445, 0, -108], [428, 0, -178], [365, 0, -228],
    [270, 0, -250], [178, 0, -224], [92, 0, -182], [8, 0, -214],
    [-78, 0, -278], [-185, 0, -298], [-292, 0, -260], [-372, 0, -198],
    [-428, 0, -120], [-446, 0, -48], [-424, 0, 12], [-385, 0, 28],
  ],
};

export const SURFACES = {
  asphalt: { grip: 1, rolling: 1, label: 'SPORT' },
  kerb: { grip: 0.94, rolling: 1.25, label: 'KERB' },
  gravel: { grip: 0.58, rolling: 4.2, label: 'GRAVEL' },
  grass: { grip: 0.48, rolling: 3.2, label: 'GRASS' },
};
