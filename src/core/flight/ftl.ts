// Coefficients currently supported by the natural FTL trial data.
export const fuelPerPowerPc = 0.003003;
export const minSpeedPcPerSecond = 0.0005;

export function naturalJumpSpeed(
  ftlMaxSpeed: number,
  minReactorUsage: number,
  reactorUsage: number,
) {
  const fraction = (reactorUsage - minReactorUsage) / (1 - minReactorUsage);
  return minSpeedPcPerSecond * (ftlMaxSpeed / minSpeedPcPerSecond) ** fraction;
}

export function naturalJumpFuel(distancePc: number, power: number, reactorUsage: number) {
  return Math.floor(fuelPerPowerPc * distancePc * power * reactorUsage);
}

export function naturalChargeSeconds(
  emitterChargeTime: number,
  maxOverchargeTime: number,
  reactorUsage: number,
) {
  return (emitterChargeTime + maxOverchargeTime) * reactorUsage;
}
