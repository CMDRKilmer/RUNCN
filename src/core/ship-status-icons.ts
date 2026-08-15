export const stationaryShipStatusIcon = '⦁';

export const shipStatusIconBySegmentType: Record<string, string> = {
  TAKE_OFF: '↑',
  DEPARTURE: '↗',
  TRANSIT: '⟶',
  CHARGE: '±',
  JUMP: '➾',
  FLOAT: '↑',
  APPROACH: '↘',
  LANDING: '↓',
  LOCK: '⟴',
  DECAY: '⟴',
  JUMP_GATEWAY: '⟴',
};

// Chinese text labels for the FLT status cell. The in-game `ShipStatus.*` i18n
// keys are overridden with arrow icons by the `flt-flight-status-icons` feature,
// so we keep a separate text-only map for our own panel.
export const shipStatusLabelBySegmentType: Record<string, string> = {
  TAKE_OFF: '起飞',
  DEPARTURE: '离港',
  TRANSIT: '转移',
  CHARGE: '充能',
  JUMP: '跃迁',
  FLOAT: '漂浮',
  APPROACH: '进近',
  LANDING: '着陆',
  LOCK: '对锁',
  DECAY: '场衰',
  JUMP_GATEWAY: '跃门',
};

export const shipStatusI18nIconReplacements = [
  {
    key: 'ships.status.stationary',
    icon: stationaryShipStatusIcon,
  },
  {
    key: 'ShipStatus.takeoff',
    icon: shipStatusIconBySegmentType.TAKE_OFF,
  },
  {
    key: 'ShipStatus.departure',
    icon: shipStatusIconBySegmentType.DEPARTURE,
  },
  {
    key: 'ShipStatus.transit',
    icon: shipStatusIconBySegmentType.TRANSIT,
  },
  {
    key: 'ShipStatus.charge',
    icon: shipStatusIconBySegmentType.CHARGE,
  },
  {
    key: 'ShipStatus.jump',
    icon: shipStatusIconBySegmentType.JUMP,
  },
  {
    key: 'ShipStatus.float',
    icon: shipStatusIconBySegmentType.FLOAT,
  },
  {
    key: 'ShipStatus.approach',
    icon: shipStatusIconBySegmentType.APPROACH,
  },
  {
    key: 'ShipStatus.landing',
    icon: shipStatusIconBySegmentType.LANDING,
  },
  {
    key: 'ShipStatus.lock',
    icon: shipStatusIconBySegmentType.LOCK,
  },
  {
    key: 'ShipStatus.decay',
    icon: shipStatusIconBySegmentType.DECAY,
  },
  {
    key: 'ShipStatus.jumpgateway',
    icon: shipStatusIconBySegmentType.JUMP_GATEWAY,
  },
] as const;

export function getShipStatusIcon(segmentType: string) {
  return shipStatusIconBySegmentType[segmentType] ?? '?';
}

export function getShipStatusLabel(segmentType: string) {
  return shipStatusLabelBySegmentType[segmentType] ?? segmentType;
}
