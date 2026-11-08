import { userData } from '@src/store/user-data';
import { markChainStageDone } from './chain-state';

export function completeActionPackage(pkg: UserData.ActionPackageData) {
  markChainStageDone(pkg.global.name);
  if (pkg.autoDelete) {
    const index = userData.actionPackages.findIndex(x => x.global.name === pkg.global.name);
    if (index >= 0) {
      userData.actionPackages.splice(index, 1);
    }
  }
  for (let i = userData.triggers.length - 1; i >= 0; i--) {
    const trigger = userData.triggers[i];
    if (trigger.autoDelete && trigger.packageName === pkg.global.name) {
      userData.triggers.splice(i, 1);
    }
  }
}
