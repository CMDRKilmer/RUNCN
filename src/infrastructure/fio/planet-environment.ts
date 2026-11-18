// 行星环境数据（半径 km / 气压）内置静态 JSON（FIO 全量导出，避免运行时查询）。
type PlanetEnvEntry = { r: number; p?: number };
let planetEnvData: Record<string, PlanetEnvEntry> | undefined;
let planetEnvLoading: Promise<void> | undefined;
let warnedFailure = false;

async function loadPlanetEnv(): Promise<void> {
  if (planetEnvData !== undefined) {
    return;
  }
  if (planetEnvLoading !== undefined) {
    return planetEnvLoading;
  }
  planetEnvLoading = (async () => {
    try {
      const resp = await fetch(config.url.planetEnv);
      planetEnvData = (await resp.json()) as Record<string, PlanetEnvEntry>;
    } catch (error) {
      // 失败**不**永久缓存：数据文件可能只是暂时读不到（离线安装、热重载），
      // 下一次调用重新尝试。缺数据对调用方仍表现为「没有环境」。
      if (!warnedFailure) {
        warnedFailure = true;
        console.warn('Failed to load planet environment data:', error);
      }
    } finally {
      planetEnvLoading = undefined;
    }
  })();
  return planetEnvLoading;
}

// 从内置数据查行星环境（半径 km + 气压）。找不到（空间站/星系/无数据）返回 undefined。
export async function fetchPlanetEnv(
  naturalId: string,
): Promise<{ radiusKm: number; pressure?: number } | undefined> {
  await loadPlanetEnv();
  const env = planetEnvData?.[naturalId.toUpperCase()];
  if (env === undefined) {
    return undefined;
  }
  return { radiusKm: env.r, pressure: env.p };
}
