export interface DataExplorerParameters {
  sourceId?: string;
  endpoint?: string;
  connectionEnabled: boolean;
}

export function parseDataExplorerParameters(parameters: string[]): DataExplorerParameters {
  const endpoint = parameters.find(x => /^wss?:\/\//i.test(x));
  const jsonOnly = parameters.some(x => x.toUpperCase() === 'JSON');
  const sourceId = parameters.find(x => x !== endpoint && x.toUpperCase() !== 'JSON');
  return { sourceId, endpoint, connectionEnabled: !jsonOnly };
}
