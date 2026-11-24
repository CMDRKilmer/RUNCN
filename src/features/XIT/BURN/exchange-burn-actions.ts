import { shallowRef } from 'vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { userData } from '@src/store/user-data';

export const pendingExchangeBurnQuote = shallowRef<string>();

export function exchangeBurnParameters(exchange: string, production: boolean, workforce: boolean) {
  const source = production ? (workforce ? '' : ' PROD') : workforce ? ' WF' : ' NONE';
  return `CX ${exchange}${source}`;
}

export function openExchangeBurnGenerator(
  exchange: string,
  production: boolean,
  workforce: boolean,
) {
  void showBuffer(`XIT BURNGEN ${exchangeBurnParameters(exchange, production, workforce)}`);
}

export function openExchangeBurnAct(
  exchange: string,
  materials: Record<string, number>,
  name = `BURN CX ${exchange} Buy`,
) {
  if (Object.keys(materials).length === 0) {
    return;
  }
  const group = 'Resupply';
  const pkg: UserData.ActionPackageData = {
    global: { name },
    groups: [{ type: 'Manual', name: group, materials }],
    actions: [{ type: 'CX Buy', name: 'CX Buy', group, exchange, useCXInv: false }],
  };
  const existing = userData.actionPackages.findIndex(x => x.global.name === name);
  if (existing === -1) {
    userData.actionPackages.push(pkg);
  } else {
    userData.actionPackages[existing] = pkg;
  }
  void showBuffer(`XIT ACT_${name.replaceAll(' ', '_')}`);
}
