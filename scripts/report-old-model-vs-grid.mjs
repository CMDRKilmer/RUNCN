import { stlIntraTransitSpeedFor } from '../src/features/XIT/FTC/fuel-model.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const calib = resolve(here, '..', 'data', 'ftc-calibration');
const ENGINE = { 1500: 'STL_ENGINE_FUEL_SAVING', 3500: 'STL_ENGINE_FUEL_SAVING', 8000: 'STL_ENGINE_FUEL_SAVING' };
const MASS = { 1500: 825.8, 3500: 898, 8000: 1059 };

console.log('tank    f      实测km/s    旧模型km/s   旧模型/实测');
let worst = 0, rows = 0;
for (const t of [1500, 3500, 8000]) {
  const j = JSON.parse(readFileSync(resolve(calib, 'grid-frvz-tank' + t + '-2026-10-14.json'), 'utf8'));
  for (const s of j.samples) {
    const meas = s.transitKm / s.transitSeconds;
    const ship = {
      mass: MASS[t], operatingEmptyMass: MASS[t], acceleration: 50, ftlMaxSpeed: 1,
      reactorPower: 1, condition: 1, stlEngineOption: ENGINE[t],
    };
    const model = stlIntraTransitSpeedFor(ship, s.fuelUsageFactor);
    const r = model / meas;
    worst = Math.max(worst, Math.abs(r - 1));
    rows++;
    console.log(
      String(t).padStart(5) + s.fuelUsageFactor.toFixed(2).padStart(7) +
      meas.toFixed(0).padStart(12) + model.toFixed(0).padStart(14) + r.toFixed(2).padStart(13),
    );
  }
}
console.log('\nrows=' + rows + '  旧模型最大|误差|=' + (worst * 100).toFixed(1) + '%');
console.log('新模型：无（第4步：5 个候选形式最好 60.8% 误差、参数不可辨识 -> 未改 src/）');
