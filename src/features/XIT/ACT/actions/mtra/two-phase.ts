// The two-phase MTRA protocol used by DISPATCH: a load action (noSfc - transfer
// only) per ship, then a finish action (finishOnly - offload JSONs, agent posts,
// SFC) after all ships' transfers. Kept next to mtra.ts, which interprets these
// flags in generateSteps.
export interface TwoPhaseMtraOptions {
  loadName: string;
  finishName: string;
  group: string;
  origin: string;
  dest: string;
  sfcDestination: string;
  offloadGroups: string[];
  agentGroups: string[];
  repairGroups: string[];
}

export function buildTwoPhaseMtraActions(opts: TwoPhaseMtraOptions): {
  load: UserData.ActionData;
  finish: UserData.ActionData;
} {
  return {
    load: {
      type: 'MTRA',
      name: opts.loadName,
      group: opts.group,
      origin: opts.origin,
      dest: opts.dest,
      noSfc: true,
    },
    finish: {
      type: 'MTRA',
      name: opts.finishName,
      group: opts.group,
      origin: opts.origin,
      dest: opts.dest,
      finishOnly: true,
      sfcDestination: opts.sfcDestination,
      ...(opts.offloadGroups.length > 0 ? { offloadGroups: opts.offloadGroups } : {}),
      ...(opts.agentGroups.length > 0 ? { agentGroups: opts.agentGroups } : {}),
      ...(opts.repairGroups.length > 0 ? { repairGroups: opts.repairGroups } : {}),
    },
  };
}
