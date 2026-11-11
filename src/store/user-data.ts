import { deepFreeze } from '@src/utils/deep-freeze';

export const initialUserData = deepFreeze({
  firstLoad: Date.now(),
  tileState: {} as Record<string, UserData.TileState | undefined>,
  settings: {
    mode: undefined as 'BASIC' | 'FULL' | undefined,
    disabled: [] as string[],
    time: 'DEFAULT' as UserData.TimeFormat,
    defaultChartType: 'SMOOTH' as UserData.ExchangeChartType,
    currency: {
      preset: 'DEFAULT' as UserData.CurrencyPreset,
      custom: '$',
      position: 'BEFORE' as UserData.CurrencyPosition,
      spacing: 'NO_SPACE' as UserData.CurrencySpacing,
    },
    financial: {
      mmMaterials: 'IDC,EDC',
      ignoredMaterials: 'HEX,JUI',
    },
    pricing: {
      exchange: 'UNIVERSE',
      method: 'DEFAULT' as UserData.PricingMethod,
      materialPriceTooltips: false,
    },
    burn: {
      red: 3,
      yellow: 7,
      resupply: 16,
      planetResupply: {} as Record<string, number>,
    },
    repair: {
      threshold: 60,
      offset: 10,
      planetOverrides: {} as Record<string, { threshold?: number; offset?: number }>,
    },
    repairBoard: {
      useOptimal: true,
      targetDays: 90,
      dueSoonDays: 7,
      arrivalDays: 0,
      subtractStore: true,
    },
    repairPlan: {},
    sidebar: [
      ['基地', 'BS'],
      ['总部', 'XIT HQUC'],
      ['合同', 'XIT CONTS'],
      ['通讯', 'COM'],
      ['集团', 'CORP'],
      ['交易所', 'CXL'],
      ['财务', 'XIT FIN'],
      ['舰队', 'FLT'],
      ['库存', 'INV'],
      ['星图', 'MU'],
      ['生产线', 'PROD'],
      ['排行', 'LEAD'],
      ['指令集', 'CMDS'],
      ['脚本', 'XIT ACT'],
      ['消耗', 'XIT BURN'],
      ['维护', 'XIT REP'],
      ['设置', 'XIT SET'],
      ['帮助', 'XIT HELP'],
      ['计划', 'XIT JH'],
      ['琉璃', 'XIT ORG'],
      ['购物车', 'XIT CART'],
    ] as [string, string][],
    refuel: {
      enabled: false,
    },
    // BSN 产物自动装船：默认关闭。开启后基地有船停靠时会静默搬走产物，
    // 属于会改变库存的自动化，必须用户显式打开。
    autoLoadProducts: {
      enabled: false,
    },
    triggers: {
      autoEnabled: false,
    },
    nx: {
      enabled: false,
      targets: {} as Record<string, { sf: number; ff: number }>,
    },
    buffers: [] as [string, number, number][],
    audioVolume: 0.4,
    mutedDesktopNotifications: [] as string[],
    translation: {
      enabled: true,
      provider: 'MICROSOFT',
      targetLanguage: 'zh',
      inputTargetLanguage: 'zh',
      providerConfigs: {} as Record<
        UserData.TranslationProviderId,
        UserData.TranslationProviderConfig
      >,
      apiPreset: 'AZURE_GLOBAL',
      apiRegion: '',
      translatedColor: '#28a745',
      showOriginal: false,
    } as UserData.TranslationSettings,
    theme: 'default' as UserData.ThemeId,
    themeFontSize: 'large' as 'standard' | 'large',
    themeBorders: 'theme' as 'theme' | 'on' | 'off',
    // INV / SHPI 紧凑排列开关：默认原版，点击窗口右上按钮才开启，刷新后保持。
    invCompact: false,
    // BLU：被隐藏的造船蓝图（存蓝图 naturalId，取不到时存 id）与
    // 「是否显示隐藏蓝图」开关。显隐固定持久化，只有手动点按钮才改变。
    hiddenBlueprints: [] as string[],
    showHiddenBlueprints: false,
  },
  sorting: {} as Record<string, UserData.StoreSortingData>,
  balanceHistory: {
    v1: [],
    v2: [],
  } as UserData.BalanceHistory,
  fullEquityMode: true,
  notes: [] as UserData.Note[],
  actionPackages: [] as UserData.ActionPackageData[],
  triggers: [] as UserData.TriggerData[],
  basePlans: [] as UserData.BasePlan[],
  systemMessages: [] as UserData.SystemMessages[],
  todo: [] as UserData.TaskList[],
  cart: {
    name: '购物车',
    exchange: '',
    items: [] as UserData.CartItem[],
  },
  baseAliases: {} as UserData.BaseAliases,
  baseProducts: {} as UserData.BaseProducts,
  baseGroups: {} as UserData.BaseGroups,
  chainRuns: {} as Record<string, UserData.ChainRun>,
  tabs: {
    order: [] as string[],
    hidden: [] as string[],
    locked: [] as string[],
  },
  commandLists: [] as UserData.CommandList[],
  screenVariables: {} as Record<string, string>,

  // 在 user-data-migrations.ts 中使用
  migrations: undefined,
});

export const userData = reactive({} as typeof initialUserData);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyUserData(newData: any) {
  newData.balanceHistory.v1 = shallowReactive(newData.balanceHistory.v1);
  newData.balanceHistory.v2 = shallowReactive(newData.balanceHistory.v2);
  Object.assign(userData, newData);
}

export function applyInitialUserData() {
  applyUserData(structuredClone(initialUserData));
}

applyInitialUserData();

export function clearBalanceHistory() {
  userData.balanceHistory.v1.length = 0;
  userData.balanceHistory.v2.length = 0;
}
