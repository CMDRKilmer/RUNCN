import { starsStore } from '@src/infrastructure/prun-api/data/stars';
import { getSystemLineFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import {
  ensureOrbitData,
  snapshotOrbitInputs,
  getNativePlanetEnvironment,
} from '@src/infrastructure/fio/orbit';
import { routesStore } from '@src/infrastructure/fio/routes';
import type { FlightInputs } from '@src/infrastructure/fio/flight-formula';
import { fetchPlanetEnv } from '@src/infrastructure/fio/planet-environment';
import { resolveFormulaEndpoint } from './formula-endpoint';

export async function loadFormulaInputs(from: string, to: string, useGateways: boolean) {
  // 端点解析（含「SFC 把空间站规范化成星系 id」的反查）见 formula-endpoint.ts。
  const endpoints = await Promise.all([resolveFormulaEndpoint(from), resolveFormulaEndpoint(to)]);
  // FTC 通过网关加载器预读。共享输入组装只取已入库的连接。
  const gateways = useGateways ? routesStore.getAllGateways().map(x => ({ ...x })) : [];
  const gateBodies = gateways.flatMap(x =>
    x.planetId === undefined ? [] : [{ naturalId: x.planetId, systemId: x.systemId }],
  );
  await ensureOrbitData([...endpoints, ...gateBodies].map(x => x.naturalId));
  const environment = await Promise.all(
    endpoints.map(async x => ({
      env: getNativePlanetEnvironment(x.naturalId) ?? (await fetchPlanetEnv(x.naturalId)),
    })),
  );
  const stars = (starsStore.all.value ?? []).flatMap(x => {
    const naturalId = getSystemLineFromAddress(x.address)?.entity.naturalId;
    return naturalId === undefined
      ? []
      : [
          {
            naturalId,
            systemId: x.systemId,
            position: { ...x.position },
            connections: [...x.connections],
          },
        ];
  });
  const input: FlightInputs = {
    orbit: snapshotOrbitInputs(endpoints),
    environment,
    stars,
    gateways,
    gatewayConnections: useGateways ? routesStore.getGatewayConnections().map(x => ({ ...x })) : [],
    gatewayEndpoints: Object.fromEntries(
      gateways.flatMap(x =>
        x.planetId === undefined
          ? []
          : [
              [
                x.naturalId,
                snapshotOrbitInputs([{ naturalId: x.planetId, systemId: x.systemId }]).endpoints[0],
              ],
            ],
      ),
    ),
  };
  return {
    input,
    origin: endpoints[0].encoded,
    destination: endpoints[1].encoded,
    from: endpoints[0].naturalId,
    to: endpoints[1].naturalId,
  };
}
