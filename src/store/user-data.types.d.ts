declare namespace UserData {
  type TimeFormat = 'DEFAULT' | '24H' | '12H';

  type CurrencyPreset = 'DEFAULT' | 'AIC' | 'CIS' | 'ICA' | 'NCC' | 'CUSTOM';
  type CurrencyPosition = 'BEFORE' | 'AFTER';
  type CurrencySpacing = 'HAS_SPACE' | 'NO_SPACE';

  type PricingMethod = 'ASK' | 'BID' | 'AVG' | 'VWAP7D' | 'VWAP30D' | 'DEFAULT' | string;

  interface StoreSortingData {
    modes: SortingMode[];
    active?: string;
    cat?: boolean;
    reverse?: boolean;
  }

  interface SortingMode {
    label: string;
    categories: SortingModeCategory[];
    burn: boolean;
    zero: boolean;
  }

  interface SortingModeCategory {
    name: string;
    materials: string[];
  }

  type TileState = Record<string, unknown>;

  interface Note {
    id: string;
    name: string;
    text: string;
  }

  interface SystemMessages {
    chat: string;
    hideJoined: boolean;
    hideDeleted: boolean;
  }

  interface ActionPackageData {
    groups: MaterialGroupData[];
    actions: ActionData[];
    global: {
      name: string;
    };
    // 一次性操作包：执行成功后自动从列表删除。
    autoDelete?: boolean;
  }

  interface CartItem {
    ticker: string;
    amount: number;
  }

  interface ShoppingCartData {
    name: string;
    exchange: string;
    items: CartItem[];
  }

  type MaterialGroupType = 'Manual' | 'Resupply' | 'Repair';

  interface MaterialGroupData {
    type: MaterialGroupType;
    name?: string;
    days?: number | string;
    advanceDays?: number | string;
    planet?: string;
    useBaseInv?: boolean;
    materials?: Record<string, number>;
    exclusions?: string[];
    consumablesOnly?: boolean;
    includeConsumables?: boolean;
    includeInputs?: boolean;
  }

  type ActionType = 'CX Buy' | 'MTRA' | 'Refuel' | 'OPEN SFC' | 'BRA Repair';

  interface ActionData {
    type: ActionType;

    name?: string;
    group?: string;

    allowUnfilled?: boolean;
    buyPartial?: boolean;
    exchange?: string;
    useCXInv?: boolean;
    priceLimits?: Record<string, number>;

    origin?: string;
    dest?: string;
    // 从选择器仅列出飞船货舱（如卸货包的「从」）。
    originType?: 'SHIP_STORE';

    buyMissingFuel?: boolean;

    destination?: string;
    shipSourceAction?: string;

    // BRA Repair 专用。
    base?: string;
    threshold?: number;
  }

  type TriggerMode = 'CONFIRM' | 'AUTO';

  type TriggerEventType =
    'FLIGHT_ENDED' | 'SUPPLIES_LOW' | 'PRODUCTION_FINISHED' | 'BUILDING_CONDITION' | 'INTERVAL';

  type TriggerEventData =
    | { type: 'FLIGHT_ENDED'; ship?: string }
    | { type: 'SUPPLIES_LOW'; planet?: string }
    | { type: 'PRODUCTION_FINISHED'; planet?: string }
    | { type: 'BUILDING_CONDITION'; planet: string; belowPct: number }
    | { type: 'INTERVAL' };

  interface TriggerData {
    id: string;
    name: string;
    enabled: boolean;
    event: TriggerEventData;
    /** 目标操作包名称。 */
    packageName: string;
    mode: TriggerMode;
    /** 触发冷却（分钟）；INTERVAL 源同时作为周期。 */
    cooldownMin: number;
    createdAt: number;
    lastRun?: number;
    runCount?: number;
    /** 最近一次触发异常（如目标操作包缺失）。 */
    lastResult?: string;
  }

  interface TaskList {
    id: string;
    name: string;
    tasks: Task[];
  }

  interface Task {
    id: string;
    type: TaskType;
    completed?: boolean;
    text?: string;
    dueDate?: number;
    recurring?: number;
    planet?: string;
    days?: number;
    buildingAge?: number;
    subtasks?: Task[];
  }

  type TaskType = 'Text' | 'Resupply' | 'Repair';

  interface CommandList {
    id: string;
    name: string;
    commands: Command[];
  }

  interface Command {
    id: string;
    label: string;
    command: string;
  }

  type ExchangeChartType = 'SMOOTH' | 'ALIGNED' | 'RAW';

  interface BasePlan {
    id: string;
    name: string;
    savedAt: number;
    planet: string;
    permits: number;
    exchange: string;
    buildings: unknown[];
    experts: Record<string, number>;
    cogcIndustry: string;
    customInputPrices: Record<string, number>;
    customOutputPrices: Record<string, number>;
    customWfPrices: Record<string, number>;
  }

  type TranslationProviderId =
    | 'MICROSOFT'
    | 'GOOGLE'
    | 'DEEP'
    | 'HUGGINGFACE'
    | 'CUSTOM'
    | 'DEEPSEEK'
    | 'MINIMAX'
    | 'ZHIPU'
    | 'QWEN'
    | 'MOONSHOT'
    | 'ERNIE'
    | 'HUNYUAN'
    | 'LINGYI'
    | 'STEPFUN'
    | 'OPENAI_LLM'
    | 'ANTHROPIC'
    | 'GEMINI';

  interface TranslationProviderConfig {
    apiKey: string;
    apiUrl: string;
    apiModel: string;
  }

  interface TranslationSettings {
    enabled: boolean;
    provider: TranslationProviderId;
    targetLanguage: string;
    inputTargetLanguage: string;
    providerConfigs: Record<TranslationProviderId, TranslationProviderConfig>;
    apiPreset: string;
    apiRegion: string;
    translatedColor: string;
    showOriginal: boolean;
  }

  interface DarkModeSettings {
    enabled: boolean;
    brightness: number;
    contrast: number;
    sepia: number;
    grayscale: number;
  }

  // 基地别名：siteId → 别名字符串。
  // 玩家在 SFC 目的地输入框键入别名时，会被替换为该基地的行星 naturalId，
  // 从而通过 PrUn 原生搜索定位该基地。
  type BaseAliases = Record<string, string>;
}
