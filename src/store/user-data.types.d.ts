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

  type MaterialGroupType = 'Manual' | 'Resupply' | 'Repair' | 'Paste';

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
    materialFilter?: string;
  }

  type ActionType = 'CX Buy' | 'MTRA' | 'Refuel' | 'CONT Ship' | 'CONT Trade' | 'GovBurn Data';

  interface ActionData {
    type: ActionType;

    deleted?: boolean;
    name?: string;
    group?: string;
    skippable?: boolean;

    allowUnfilled?: boolean;
    buyPartial?: boolean;
    exchange?: string;
    useCXInv?: boolean;
    priceLimits?: Record<string, number>;

    origin?: string;
    dest?: string;

    buyMissingFuel?: boolean;

    // MTRA specific
    postToAgent?: boolean;
    noSfc?: boolean;
    sfcDestination?: string;
    printOffloadJson?: boolean;
    offloadGroups?: string[];
    agentGroups?: string[];
    finishOnly?: boolean;
    repairGroups?: string[];
    braPlanet?: string;

    contOrigin?: string;
    contDest?: string;
    paymentPerTon?: number;
    autoProvision?: boolean;
    autoTrade?: boolean;
    durationDays?: number;
    daysToFulfill?: number;
    currency?: string;
    contractNote?: string;
    contLocation?: string;
    contTradeType?: string;
    planet?: string;
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

  interface LinkedBuffersPreset {
    id: string;
    name: string;
    commands: LinkedBuffersCommand[];
    lastBufferSize?: [number, number];
    controlPosition?: [number, number];
    childLayouts?: LinkedBuffersChildLayout[];
  }

  interface LinkedBuffersCommand {
    id: string;
    label: string;
    template: string;
  }

  interface LinkedBuffersChildLayout {
    commandId: string;
    left: number;
    top: number;
    width: number;
    height: number;
  }

  interface GovBurnContrib {
    own?: number;
    any?: number;
  }

  interface GovBurnUpkeep {
    ticker: string;
    stored: number;
    amount: number;
    duration: number;
    nextTick: number;
  }

  interface GovBurnBuilding {
    ticker: string;
    type: string;
    projectId: string;
    level: number;
    upkeeps?: GovBurnUpkeep[];
    upkeepsCapturedAt?: number;
    contribHistory?: Record<string, GovBurnContrib>;
  }

  interface GovBurnCogc {
    dueDate: number;
    materials: { ticker: string; amount: number; currentAmount: number }[];
  }

  interface GovBurnPlanet {
    naturalId: string;
    name: string;
    capturedAt: number;
    buildings: GovBurnBuilding[];
    cogc?: GovBurnCogc;
  }

  type GovBurnPlanetConfig = Record<string, number>;
}
