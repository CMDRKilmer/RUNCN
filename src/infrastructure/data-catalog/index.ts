import { DataCatalog } from '@src/core/data-query/catalog';
import {
  DataQuery,
  DataQueryResult,
  DataSourceSummary,
  DataQueryFilter,
} from '@src/core/data-query/types';

// 当前为空 catalog —— game-sources/tile-sources 需独立 PR 适配 RUNCN store API。
// XIT/DATA 已可启动但 sources 为空列表。
export const dataCatalog = new DataCatalog([]);

export function parseFilterValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export type { DataQuery, DataQueryFilter, DataQueryResult, DataSourceSummary };
