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

  type ActionType = 'CX Buy' | 'MTRA' | 'Refuel' | 'OPEN SFC' | 'DEPART' | 'BRA Repair' | 'CX Sell';

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
    // DEPART 专用：要自动发船的飞船注册号。
    registration?: string;

    // BRA Repair 专用。
    base?: string;
    threshold?: number;

    // CX Sell 专用。
    ticker?: string;
    amount?: number;
    /** LIMIT=挂单售卖（压至卖价第 rank 名）；FILL=填单售卖（按买一价立即成交）。 */
    sellMode?: 'LIMIT' | 'FILL';
    /** 挂单排名（1=卖价第一名，默认 1）：压过第 rank 名卖价一档。 */
    rank?: number;
  }

  type TriggerMode = 'CONFIRM' | 'AUTO' | 'MANUAL';

  type TriggerEventType =
    'FLIGHT_ENDED' | 'SUPPLIES_LOW' | 'PRODUCTION_FINISHED' | 'BUILDING_CONDITION' | 'INTERVAL';

  type TriggerEventData =
    | { type: 'FLIGHT_ENDED'; ship?: string; planet?: string }
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
    /** 一次性触发器：其操作包执行成功后自动删除（FLEET 到港卸货）。 */
    autoDelete?: boolean;
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

  // 基地产物列表：siteId → ticker 数组。
  // 用于 XIT FLEET 产业链环线的「最终产物提取」读取：在 BSN 面板中手动指定
  // 哪些 ticker 算作本基地的「最终产物」（不参与链上输送，提取后运回出发地）。
  // 未设置时，chain-planner 回落到 burn 推断（output > 0 且无下游边）。
  type BaseProducts = Record<string, string[]>;

  // 基地供应链分组：siteId → 分组名数组。
  // 在 BSN 面板为每基地标注所属分组（自由文本、逗号/空格分隔，数量不限）。
  // XIT FLEET 产业链环线据此按「分组」载入基地，取代按船只分配基地的方式。
  type BaseGroups = Record<string, string[]>;

  // 环线执行记录：以 shipId 为键，供 FLEET 环线页签展示「正在执行的环线」进度。
  // stops.pkgName 为净化后的站点操作包名，用于关联 FLIGHT_ENDED 触发器与操作包
  // 判定各站状态（包被 autoDelete 移除即完成）。
  // 环线快照载荷：页面刷新后仍可按规划样式显示「当前阶段载重/操作」。
  interface ChainRunLoad {
    weight: number;
    volume: number;
  }

  // 环线单站/出发/归航进度状态（持久化到运行记录，删除 ACT/触发器后仍可展示）。
  type ChainRunStopState = 'done' | 'arrived' | 'transit' | 'pending';

  interface ChainRunStop {
    naturalId: string;
    planetName: string;
    pkgName: string;
    // 持久化的站点进度状态（新版本环线写入；旧记录无此字段时回退推导）。
    state?: ChainRunStopState;
    // 计划快照（新版本环线写入）：还原阶段装卸量与阶段载重。
    plan?: {
      unloadAt: Record<string, number>;
      loadAt: Record<string, number>;
      // 每项提取的目的地标签（如下游星球名 / 出发地），用于表格展示。
      loadTo?: Record<string, string>;
      loadOnArrival: ChainRunLoad;
      loadOnDeparture: ChainRunLoad;
      clipped?: boolean;
    };
  }

  interface ChainRunPlan {
    capacity: ChainRunLoad;
    originLoadOnDeparture: ChainRunLoad;
    loadOnReturn: ChainRunLoad;
    purchaseBill: Record<string, number>;
    originPickup: Record<string, number>;
    finalUnload: Record<string, number>;
    finalUnloadNotes?: Record<string, string>;
  }

  interface ChainRun {
    shipId: string;
    shipName: string;
    startedAt: number;
    originNaturalId: string;
    stops: ChainRunStop[];
    finalPkgName?: string;
    // 当前阶段脚本名：主包执行成功后据此把「出发」标记为完成。
    mainPkgName?: string;
    originState?: ChainRunStopState;
    finalState?: ChainRunStopState;
    // 执行时的计划快照（持久化）：页面刷新后仍显示阶段载重而非实时载重。
    plan?: ChainRunPlan;
  }
}
