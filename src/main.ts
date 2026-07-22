import { finishApiInitialization, initializeApi } from '@src/infrastructure/prun-api';
import { initializeUI } from '@src/infrastructure/prun-ui';
import { initializeUserData } from '@src/store';
import { initAudioInterceptor } from '@src/infrastructure/prun-ui/audio-interceptor';
import { usersStore } from '@src/infrastructure/prun-api/data/users';
import { companyStore } from '@src/infrastructure/prun-api/data/company';
import * as boardApi from '@src/infrastructure/org-api/board';
import PmmgMigrationGuide from '@src/components/PmmgMigrationGuide.vue';

// 启用扩展时上报当前 PrUn 用户在线（ORG NON_ORG 统计的来源）。
// 时机：initializeApi 完成（companyStore + usersStore 已稳定）→ features.init() 之前。
// 失败不阻塞扩展加载。
async function reportExtensionUserOnStartup() {
  const prunUsername = usersStore.all.value?.[0]?.username;
  const companyCode = companyStore.value?.code;
  if (!prunUsername || !companyCode) {
    return;
  }
  try {
    await boardApi.reportUser({
      prunUsername,
      companyCode,
      displayName: prunUsername,
    });
  } catch (err) {
    console.warn('[ORG] Failed to report extension user:', err);
  }
}

async function main() {
  try {
    initAudioInterceptor();
    await initializeApi();
    await initializeUI();

    if (window['PMMG_COLLECTOR_HAS_RUN']) {
      createFragmentApp(PmmgMigrationGuide).before(await $(document, C.App.container));
      finishApiInitialization();
      return;
    }

    console.log(`Refined PrUn ${config.version}`);
    initializeUserData();
    void reportExtensionUserOnStartup();
    features.init();
    xit.init();
  } finally {
    finishApiInitialization();
  }
}

void main();
