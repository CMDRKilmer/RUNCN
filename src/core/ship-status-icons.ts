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

export function getShipStatusLabel(segmentType: string) {
  return shipStatusLabelBySegmentType[segmentType] ?? segmentType;
}
