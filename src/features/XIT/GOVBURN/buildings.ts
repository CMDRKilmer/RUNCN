// GOVBURN/buildings 占位。
// 真正的 GOVBURN 命令（15 文件、6 个 userData 类型）需独立 PR 迁移。
// 此文件被 ACT/actions/govburn-data/govburn-data.ts 引用以满足类型检查。
export const getPlanetGovBurn = (_planetNaturalId: string) => undefined;
export const updatePlanetGovBurn = (_planetNaturalId: string, _data: unknown) => {};
export interface PopiBuilding {
  ticker: string;
  type: string;
  projectName: string;
}
export const popiBuildings: PopiBuilding[] = [];
