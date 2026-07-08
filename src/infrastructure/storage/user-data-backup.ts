/* eslint-disable @typescript-eslint/no-explicit-any */

const storageKey = 'refined-prun';
const maxBackups = 5;
const hoursBetweenBackups = 24;

export interface UserDataBackup {
  data: any;
  timestamp: number;
}

interface Backups {
  backups: UserDataBackup[];
}

const refBackups = shallowRef<UserDataBackup[]>(loadBackups());

export function getUserDataBackups() {
  return refBackups.value;
}

function loadBackups() {
  try {
    const json = localStorage.getItem(storageKey);
    if (!json) {
      return [];
    }
    const backups = JSON.parse(json);
    if (!backups?.backups) {
      return [];
    }
    return (backups as Backups).backups;
  } catch {
    return [];
  }
}

function saveBackups(backups: UserDataBackup[]) {
  localStorage.setItem(storageKey, JSON.stringify({ backups }));
  refBackups.value = [...backups];
}

export function backupUserData(data: any) {
  const backups = getUserDataBackups();
  const hasRecentBackup =
    backups.length > 0 && backups[0].timestamp > Date.now() - hoursBetweenBackups * 3600000;
  if (hasRecentBackup) {
    return;
  }
  backups.unshift({
    // Strip credentials before writing to localStorage. Any same-origin
    // script can read localStorage with no effort, so secrets must not live
    // there. Users restoring from backup will need to re-enter API keys.
    data: sanitizeForBackup(data),
    timestamp: Date.now(),
  });
  while (backups.length > maxBackups) {
    backups.pop();
  }
  saveBackups(backups);
}

// Returns a deep clone with all credential-bearing fields blanked out.
function sanitizeForBackup(data: any): any {
  // JSON round-trip gives a plain clone of the already-toRaw'd userData.
  const clone = JSON.parse(JSON.stringify(data));
  if (clone?.settings?.translation?.providerConfigs) {
    for (const id of Object.keys(clone.settings.translation.providerConfigs)) {
      const config = clone.settings.translation.providerConfigs[id];
      if (config && typeof config === 'object') {
        config.apiKey = '';
      }
    }
  }
  if (clone) {
    clone.factionToken = undefined;
    clone.supabaseAuth = undefined;
  }
  return clone;
}

export function deleteUserDataBackup(backup: UserDataBackup) {
  const backups = getUserDataBackups().filter(x => x !== backup);
  saveBackups(backups);
}
