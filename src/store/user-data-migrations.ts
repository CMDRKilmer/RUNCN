/* eslint-disable @typescript-eslint/no-explicit-any */
import { migrateVersionedUserData } from '@src/store/user-data-versioned-migrations';
import removeArrayElement from '@src/utils/remove-array-element';

type Migration = [id: string, migration: (userData: any) => void];
// 检查点标记表示其之前的所有迁移已应用。
// 如果用户数据包含检查点 ID，则可以裁剪之前的单独 ID。
// 新的检查点会替代旧的检查点。
type Checkpoint = [id: string];
type MigrationEntry = Migration | Checkpoint;

function isCheckpoint(entry: MigrationEntry): entry is Checkpoint {
  return entry.length === 1;
}

// 新的迁移应添加到列表顶部。
// 日期仅供参考，不影响迁移顺序。
const migrations: MigrationEntry[] = [
  [
    '09.08.2026 Merge GOVBURN config into govburn field',
    userData => {
      // 旧结构：govburn: { planets } + 顶层 govburnConfig: { planets }
      // 新结构：govburn: { planets, config: { planets, resupplyDays, red, yellow } }
      const oldConfig = userData.govburnConfig;
      const govburn = userData.govburn ?? {};
      govburn.planets ??= {};
      govburn.config = {
        planets: oldConfig?.planets ?? govburn.config?.planets ?? {},
        resupplyDays: govburn.config?.resupplyDays ?? 30,
        red: govburn.config?.red ?? 3,
        yellow: govburn.config?.yellow ?? 7,
      };
      delete userData.govburnConfig;
    },
  ],
  [
    '29.07.2026 Rebind 琉璃 sidebar entry to XIT ORG',
    userData => {
      const sidebar: [string, string][] = userData.settings.sidebar;
      const idx = sidebar.findIndex(([, cmd]: [string, string]) => cmd === 'XIT FACTION');
      if (idx >= 0) {
        sidebar[idx][1] = 'XIT ORG';
      }
    },
  ],
  [
    '15.07.2026 Convert dark mode to invert mode',
    userData => {
      const dm = userData.settings.darkMode;
      if (!dm) {
        return;
      }
      // 反色模式不再使用配色覆盖字段。
      delete dm.background;
      delete dm.text;
      delete dm.selectionBackground;
      delete dm.selectionText;
      dm.enabled ??= false;
      dm.brightness ??= 100;
      dm.contrast ??= 100;
      dm.sepia ??= 0;
      dm.grayscale ??= 0;
    },
  ],
  [
    '15.07.2026 Add dark mode settings',
    userData => {
      if (!userData.settings.darkMode) {
        userData.settings.darkMode = {
          enabled: false,
          brightness: 100,
          contrast: 100,
          sepia: 0,
          grayscale: 0,
        };
      } else {
        userData.settings.darkMode.enabled ??= false;
        userData.settings.darkMode.brightness ??= 100;
        userData.settings.darkMode.contrast ??= 100;
        userData.settings.darkMode.sepia ??= 0;
        userData.settings.darkMode.grayscale ??= 0;
      }
    },
  ],
  [
    '08.07.2026 Migrate to per-provider API configs',
    userData => {
      const translation = userData.settings.translation;
      if (!translation) {
        return;
      }
      if (!translation.providerConfigs) {
        translation.providerConfigs = {};
      }
      const providerIds: UserData.TranslationProviderId[] = [
        'MICROSOFT',
        'GOOGLE',
        'DEEP',
        'HUGGINGFACE',
        'CUSTOM',
        'DEEPSEEK',
        'MINIMAX',
        'ZHIPU',
        'QWEN',
        'MOONSHOT',
        'ERNIE',
        'HUNYUAN',
        'LINGYI',
        'STEPFUN',
        'OPENAI_LLM',
        'ANTHROPIC',
        'GEMINI',
      ];
      for (const providerId of providerIds) {
        if (!translation.providerConfigs[providerId]) {
          translation.providerConfigs[providerId] = {
            apiKey: translation.apiKey ?? '',
            apiUrl: translation.apiUrl ?? '',
            apiModel: translation.apiModel ?? '',
          };
        }
      }
      delete translation.apiKey;
      delete translation.apiUrl;
      delete translation.apiModel;
    },
  ],
  [
    '07.07.2026 Add translation settings',
    userData => {
      if (!userData.settings.translation) {
        userData.settings.translation = {
          enabled: true,
          provider: 'MICROSOFT',
          targetLanguage: 'zh',
          inputTargetLanguage: 'zh',
          apiKey: '',
          apiUrl: '',
          apiModel: '',
          apiPreset: 'AZURE_GLOBAL',
          apiRegion: '',
          showOriginal: false,
        };
      } else {
        userData.settings.translation.showOriginal ??= false;
        userData.settings.translation.inputTargetLanguage ??=
          userData.settings.translation.targetLanguage ?? 'zh';
        userData.settings.translation.apiPreset ??= 'AZURE_GLOBAL';
        userData.settings.translation.apiRegion ??= '';
        userData.settings.translation.apiUrl ??= '';
        userData.settings.translation.apiModel ??= '';
        userData.settings.translation.translatedColor ??= '#28a745';
      }
    },
  ],
  [
    '03.04.2026 Rename default cart name',
    userData => {
      if (!userData.cart) {
        return;
      }

      if (!userData.cart.name || userData.cart.name === '购物车') {
        userData.cart.name = 'Shopping Cart';
      }
    },
  ],
  [
    '03.04.2026 Add shopping cart',
    userData => {
      if (!userData.cart) {
        userData.cart = {
          name: '购物车',
          exchange: '',
          items: [],
        };
      } else {
        userData.cart.name ??= '购物车';
        userData.cart.exchange ??= '';
        userData.cart.items ??= [];
      }

      const sidebar: [string, string][] = userData.settings.sidebar;
      if (!sidebar.some(([, cmd]: [string, string]) => cmd === 'XIT CART')) {
        const factionIdx = sidebar.findIndex(([, cmd]: [string, string]) => cmd === 'XIT FACTION');
        const targetIdx = factionIdx >= 0 ? factionIdx + 1 : sidebar.length;
        sidebar.splice(targetIdx, 0, ['购物车', 'XIT CART']);
      }
    },
  ],
  [
    '03.04.2026 Remove ship refuel actions',
    userData => {
      for (const pkg of userData.actionPackages ?? []) {
        pkg.actions = (pkg.actions ?? []).filter(
          (action: { type?: string }) => action.type !== 'Refuel',
        );
      }
    },
  ],
  [
    '25.03.2026 Rename BURN to 消耗',
    userData => {
      const sidebar: [string, string][] = userData.settings.sidebar;
      const idx = sidebar.findIndex(([, cmd]: [string, string]) => cmd === 'XIT BURN');
      if (idx >= 0) sidebar[idx][0] = '消耗';
    },
  ],
  [
    '21.03.2026 Translate sidebar entries',
    userData => {
      const sidebar: [string, string][] = userData.settings.sidebar;
      const setIdx = sidebar.findIndex(([, cmd]: [string, string]) => cmd === 'XIT SET');
      if (setIdx >= 0) sidebar[setIdx][0] = '设置';

      const helpIdx = sidebar.findIndex(([, cmd]: [string, string]) => cmd === 'XIT HELP');
      if (helpIdx >= 0) sidebar[helpIdx][0] = '帮助';

      const facIdx = sidebar.findIndex(([, cmd]: [string, string]) => cmd === 'XIT FACTION');
      if (facIdx >= 0) sidebar[facIdx][0] = '琉璃';
    },
  ],
  [
    '21.03.2026 Replace JH with 计划 and add 组织 sidebar entry',
    userData => {
      const sidebar: [string, string][] = userData.settings.sidebar;
      const jhIdx = sidebar.findIndex(([, cmd]: [string, string]) => cmd === 'XIT JH');
      if (jhIdx >= 0) {
        sidebar[jhIdx][0] = '计划';
      }
      if (!sidebar.some(([, cmd]: [string, string]) => cmd === 'XIT FACTION')) {
        const targetIdx = jhIdx >= 0 ? jhIdx + 1 : sidebar.length;
        sidebar.splice(targetIdx, 0, ['琉璃', 'XIT ORG']);
      }
    },
  ],
  [
    '18.03.2026 Add mutedDesktopNotifications',
    userData => {
      if (!userData.settings.mutedDesktopNotifications) {
        userData.settings.mutedDesktopNotifications = [];
      }
    },
  ],
  [
    '17.03.2026 Add lastAutoProductionDate',
    userData => {
      userData.lastAutoProductionDate = undefined;
    },
  ],
  [
    '17.03.2026 Add supabaseAuth',
    userData => {
      userData.supabaseAuth = undefined;
    },
  ],
  [
    '16.03.2026 Add JH sidebar entry',
    userData => {
      const sidebar: [string, string][] = userData.settings.sidebar;
      if (!sidebar.some(([, cmd]: [string, string]) => cmd === 'XIT JH')) {
        const helpIdx = sidebar.findIndex(([, cmd]: [string, string]) => cmd === 'XIT HELP');
        sidebar.splice(helpIdx >= 0 ? helpIdx + 1 : sidebar.length, 0, ['计划', 'XIT JH']);
      }
    },
  ],
  [
    '15.03.2026 Add factionCache',
    userData => {
      userData.factionCache = undefined;
    },
  ],
  [
    '15.03.2026 Add factionToken',
    userData => {
      userData.factionToken = undefined;
    },
  ],
  ['10.03.2026 Checkpoint'],
  [
    '10.03.2026 Remove funny-rations',
    userData => {
      removeFeature(userData, 'funny-rations');
    },
  ],
  [
    '24.01.2026 Remove cxpc-default-1y',
    userData => {
      removeFeature(userData, 'cxpc-default-1y');
    },
  ],
  [
    '02.02.2026 Add full equity mode',
    userData => {
      userData.fullEquityMode = true;
    },
  ],
  [
    '25.12.2025 Rename features',
    userData => {
      renameFeature(userData, 'custom-item-sorting', 'inv-custom-item-sorting');
      renameFeature(userData, 'item-markers', 'inv-item-markers');
      renameFeature(userData, 'show-space-remaining', 'inv-show-space-remaining');
    },
  ],
  [
    '25.12.2025 Add audio volume',
    userData => {
      userData.settings.audioVolume = 0.4;
    },
  ],
];

function removeFeature(userData: any, feature: string) {
  removeArrayElement(userData.settings.disabled, feature);
}

function renameFeature(userData: any, oldName: string, newName: string) {
  const disabled = userData.settings.disabled;
  const index = disabled.indexOf(oldName);
  if (index !== -1) {
    disabled[index] = newName;
  }
}

export function migrateUserData(userData: any) {
  // 迁移按从新到旧排序，但我们需要按顺序执行。
  const orderedMigrations = migrations.slice().reverse();
  if (userData.version !== undefined) {
    migrateVersionedUserData(userData);
    delete userData.version;
    // 版本迁移后，应运行所有命名迁移。
    // 将迁移列表设为空数组会触发此操作。
    userData.migrations = [];
  }
  if (userData.migrations === undefined) {
    // 初始用户数据已经迁移过，因此只需将所有迁移添加到列表。
    userData.migrations = compactIds(
      orderedMigrations,
      orderedMigrations.map(x => x[0]),
    );
    return userData;
  }

  const performed = new Set<string>(userData.migrations);
  for (let i = orderedMigrations.length - 1; i >= 0; i--) {
    const entry = orderedMigrations[i];
    if (isCheckpoint(entry) && performed.has(entry[0])) {
      for (let j = 0; j < i; j++) {
        performed.add(orderedMigrations[j][0]);
      }
      break;
    }
  }

  for (const entry of orderedMigrations) {
    const id = entry[0];
    if (performed.has(id)) {
      continue;
    }
    if (!isCheckpoint(entry)) {
      entry[1](userData);
    }
    performed.add(id);
    userData.migrations.push(id);
  }

  userData.migrations = compactIds(orderedMigrations, userData.migrations);
  return userData;
}

function compactIds(orderedEntries: MigrationEntry[], appliedIds: string[]): string[] {
  const applied = new Set(appliedIds);

  // 查找所有前置条目均已应用的最新检查点。
  // 已应用的旧检查点表示其之前的所有内容都已隐式应用。
  let latestCheckpointIndex = -1;
  for (let i = orderedEntries.length - 1; i >= 0; i--) {
    const entry = orderedEntries[i];
    if (!isCheckpoint(entry) || !applied.has(entry[0])) {
      continue;
    }
    let complete = true;
    for (let j = i - 1; j >= 0; j--) {
      if (isCheckpoint(orderedEntries[j]) && applied.has(orderedEntries[j][0])) {
        break;
      }
      if (!applied.has(orderedEntries[j][0])) {
        complete = false;
        break;
      }
    }
    if (complete) {
      latestCheckpointIndex = i;
      break;
    }
  }

  if (latestCheckpointIndex === -1) {
    return appliedIds;
  }

  const removable = new Set<string>();
  for (let i = 0; i < latestCheckpointIndex; i++) {
    removable.add(orderedEntries[i][0]);
  }

  const checkpointId = orderedEntries[latestCheckpointIndex][0];
  const result: string[] = [checkpointId];
  for (const id of appliedIds) {
    if (!removable.has(id) && id !== checkpointId) {
      result.push(id);
    }
  }
  return result;
}
