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
    },
    burn: {
      red: 3,
      yellow: 7,
      resupply: 16,
    },
    repair: {
      threshold: 60,
      offset: 10,
    },
    sidebar: [
      ['BS', 'BS'],
      ['CONT', 'XIT CONTS'],
      ['COM', 'COM'],
      ['CORP', 'CORP'],
      ['CXL', 'CXL'],
      ['FIN', 'XIT FIN'],
      ['FLT', 'FLT'],
      ['INV', 'INV'],
      ['MAP', 'MU'],
      ['PROD', 'PROD'],
      ['LEAD', 'LEAD'],
      ['CMDS', 'CMDS'],
      ['ACT', 'XIT ACT'],
      ['报告', 'XIT BURN'],
      ['REP', 'XIT REP'],
      ['设置', 'XIT SET'],
      ['帮助', 'XIT HELP'],
      ['计划', 'XIT JH'],
      ['琉璃', 'XIT FACTION'],
      ['\u8d2d\u7269\u8f66', 'XIT CART'],
    ] as [string, string][],
    buffers: [] as [string, number, number][],
    audioVolume: 0.4,
    mutedDesktopNotifications: [] as string[],
    translation: {
      enabled: true,
      provider: 'LIBRE',
      targetLanguage: 'zh',
      apiKey: '',
      apiUrl: 'https://translate.argosopentech.com',
      fontSize: 14,
      backgroundColor: '#2a2a2a',
    } as UserData.TranslationSettings,
  },
  sorting: {} as Record<string, UserData.StoreSortingData>,
  balanceHistory: {
    v1: [],
    v2: [],
  } as UserData.BalanceHistory,
  fullEquityMode: true,
  notes: [] as UserData.Note[],
  actionPackages: [] as UserData.ActionPackageData[],
  basePlans: [] as UserData.BasePlan[],
  systemMessages: [] as UserData.SystemMessages[],
  todo: [] as UserData.TaskList[],
  cart: {
    name: 'Shopping Cart',
    exchange: '',
    items: [] as UserData.CartItem[],
  },
  tabs: {
    order: [] as string[],
    hidden: [] as string[],
    locked: [] as string[],
  },
  commandLists: [] as UserData.CommandList[],
  factionToken: undefined as string | undefined,
  factionCache: undefined as
    | { cachedAt: number; members?: unknown[]; balance?: number; bulletins?: unknown[] }
    | undefined,
  factionLastSeenBulletinAt: undefined as string | undefined,
  supabaseAuth: undefined as Record<string, string> | undefined,
  lastAutoProductionDate: undefined as string | undefined,
  lastShipReportSnapshot: undefined as string | undefined,

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
