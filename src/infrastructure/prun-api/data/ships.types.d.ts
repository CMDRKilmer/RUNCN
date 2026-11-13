declare namespace PrunApi {
  interface Ship {
    id: string;
    idShipStore: string;
    idStlFuelStore: string;
    idFtlFuelStore: string;
    registration: string;
    name: string;
    commissioningTime: DateTime;
    blueprintNaturalId: string;
    address: Address | null;
    flightId: string | null;
    acceleration: number;
    thrust: number;
    mass: number;
    operatingEmptyMass: number;
    volume: number;
    reactorPower: number;
    emitterPower: number;
    stlFuelStoreId: string;
    stlFuelFlowRate: number;
    ftlFuelStoreId: string;
    operatingTimeStl: TimeSpan;
    operatingTimeFtl: TimeSpan;
    condition: number;
    lastRepair: DateTime | null;
    repairMaterials: MaterialAmount[];
    status: string;
    // 游戏 2026-11-11 新增「航线（RT）」后加的字段：船被分配到航线时是 route id，
    // 未分配为 null。航线船的到站装卸由服务器执行，第三方脚本必须让路。
    assignedRoute?: string | null;
  }
}
