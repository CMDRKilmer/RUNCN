import { downloadJson, uploadJson } from '@src/utils/json-file';
import { migrateUserData } from '@src/store/user-data-migrations';
import { applyInitialUserData, applyUserData, userData } from '@src/store/user-data';
import { deepToRaw } from '@src/utils/deep-to-raw';
import { backupUserData, getUserDataBackups } from '@src/infrastructure/storage/user-data-backup';
import { userDataStore } from '@src/infrastructure/prun-api/data/user-data';
import dayjs from 'dayjs';
import { isEncryptedApiKeyValue, postSaveSecretKeys, resolveApiKey } from './api-key-gateway';

const fileType = 'rp-user-data';

export function loadUserData() {
  let loaded = false;
  let userDataToLoad = config.userData;
  if (!userDataToLoad) {
    const backups = getUserDataBackups();
    if (backups.length > 0) {
      userDataToLoad = backups[0].data;
    }
  }
  if (userDataToLoad) {
    try {
      const userData = migrateUserData(userDataToLoad);
      applyUserData(userData);
      loaded = true;
    } catch (e) {
      console.error('Error loading user data', e);
      loaded = false;
    }
  }
  if (!loaded) {
    migrateUserData(userData);
    disableFullEquityModeForNewUsers();
  }
  watchUserData();
}

function disableFullEquityModeForNewUsers() {
  const age = dayjs.duration(Date.now() - userDataStore.created.timestamp).asDays();
  userData.fullEquityMode = age >= 90;
}

function watchUserData() {
  let saveQueued = false;

  watch(
    userData,
    () => {
      if (import.meta.env.DEV) {
        // Never log the live object: providerConfigs[*].apiKey holds
        // either an encrypted-at-rest wrapper or (transiently) a
        // plaintext. Either way we only report whether *something* is
        // configured, never the key itself.
        const translation = userData.settings.translation;
        const provider = translation.provider;
        const hasKey = (translation.providerConfigs[provider]?.apiKey ?? '').length > 0;
        console.log('userData changed', {
          provider,
          hasApiKey: hasKey,
          enabled: translation.enabled,
        });
      }
      if (!saveQueued) {
        setTimeout(() => {
          void saveUserData();
          saveQueued = false;
        }, 1000);
        saveQueued = true;
      }
    },
    { deep: true },
  );
}

export async function saveUserData() {
  const data = deepToRaw(userData);
  // The apiKey fields in userData are wrapped ciphertext by default.
  // Pull the plaintext out for any non-empty wrapped key and ship it
  // to the content script in a dedicated, separately-encrypted
  // message. The main userData blob is persisted with the ciphertext
  // values unchanged so reads on the next page load are self
  // contained.
  const configs = (data as { settings?: { translation?: { providerConfigs?: unknown } } })?.settings
    ?.translation?.providerConfigs as Record<string, { apiKey?: string }> | undefined;
  const secretKeys: Record<string, string> = {};
  if (configs !== undefined) {
    for (const id of Object.keys(configs)) {
      const config = configs[id];
      if (config === undefined || typeof config !== 'object' || config === null) {
        continue;
      }
      const wrapped = config.apiKey;
      if (typeof wrapped !== 'string' || wrapped.length === 0) {
        continue;
      }
      if (!isEncryptedApiKeyValue(wrapped)) {
        // Plaintext key (e.g. legacy data). Just ship it as-is.
        secretKeys[id] = wrapped;
        continue;
      }
      const plain = await resolveApiKey(wrapped);
      if (plain.length > 0) {
        secretKeys[id] = plain;
      }
    }
  }
  backupUserData(data);
  await new Promise<void>(resolve => {
    const listener = (e: MessageEvent) => {
      if (e.source !== window) {
        return;
      }
      if (e.data.type === 'rp-user-data-saved') {
        window.removeEventListener('message', listener);
        resolve();
      }
    };
    window.addEventListener('message', listener);
    // Use a specific targetOrigin instead of '*' so a malicious frame in a
    // different origin cannot receive the payload. Page and content script
    // share the same origin (apex.prosperousuniverse.com).
    window.postMessage({ type: 'rp-save-user-data', userData: data }, location.origin);
  });
  if (Object.keys(secretKeys).length > 0) {
    await postSaveSecretKeys(secretKeys);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function restoreBackup(backup: any) {
  const userData = migrateUserData(backup);
  applyUserData(userData);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function downloadBackup(backup: any, timestamp: number) {
  const json = {
    type: fileType,
    data: backup,
  };
  downloadJson(json, `${fileType}-${timestamp}.json`);
}

export function importUserData(onSuccess?: () => void) {
  uploadJson(json => {
    if (json?.type !== fileType) {
      return;
    }
    const userData = migrateUserData(json.data);
    applyUserData(userData);
    onSuccess?.();
  });
}

export function exportUserData() {
  const json = {
    type: fileType,
    data: userData,
  };
  downloadJson(json, `${fileType}-${Date.now()}.json`);
}

export function resetUserData() {
  applyInitialUserData();
  migrateUserData(userData);
}
