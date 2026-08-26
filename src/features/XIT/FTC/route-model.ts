import { starsStore, getStarNaturalId } from '@src/infrastructure/prun-api/data/stars';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { getSystemLineFromAddress } from '@src/infrastructure/prun-api/data/addresses';

// 航线几何基础（XIT FTC 燃料计算器使用）。
// 提供起终点解析、恒星坐标位置与三维距离；航线规划与燃料模型见
// route-planner.ts / fuel-model.ts。

// 将任意航点 naturalId 解析为所属星系 id：恒星级 id 直接命中，
// 空间站查其地址的 SYSTEM 行，行星去掉一颗卫星后缀，卫星再剥离
// 小写字母开头的后缀。
export function resolveSystemId(naturalId: string): string | undefined {
  const upper = naturalId.trim().toUpperCase();
  if (upper === '') {
    return undefined;
  }
  const star = starsStore.getByNaturalId(upper);
  if (star) {
    return getStarNaturalId(star);
  }
  const station = stationsStore.getByNaturalId(upper);
  const systemLine = station ? getSystemLineFromAddress(station.address) : undefined;
  if (systemLine) {
    return systemLine.entity.naturalId;
  }
  const byPlanet = starsStore.getByPlanetNaturalId(upper);
  if (byPlanet) {
    return getStarNaturalId(byPlanet);
  }
  const stripped = upper.replace(/[a-z][a-z0-9]*$/, '');
  if (stripped !== upper) {
    const moonStar = starsStore.getByNaturalId(stripped);
    if (moonStar) {
      return getStarNaturalId(moonStar);
    }
  }
  return undefined;
}

export function getStarPosition(systemId: string): PrunApi.Position | undefined {
  return starsStore.getByNaturalId(systemId)?.position;
}

export function distance3d(a: PrunApi.Position, b: PrunApi.Position) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
