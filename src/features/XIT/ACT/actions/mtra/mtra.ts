import { act } from '@src/features/XIT/ACT/act-registry';
import Edit from '@src/features/XIT/ACT/actions/mtra/Edit.vue';
import Configure from '@src/features/XIT/ACT/actions/mtra/Configure.vue';
import { MTRA_TRANSFER } from '@src/features/XIT/ACT/action-steps/MTRA_TRANSFER';
import { SHPI_UNLOAD } from '@src/features/XIT/ACT/action-steps/SHPI_UNLOAD';
import { POST_AGENT } from '@src/features/XIT/ACT/action-steps/POST_AGENT';
import { LOG_JSON } from '@src/features/XIT/ACT/action-steps/LOG_JSON';
import { OPEN_SFC } from '@src/features/XIT/ACT/action-steps/OPEN_SFC';
import { OPEN_BRA } from '@src/features/XIT/ACT/action-steps/OPEN_BRA';
import { atSameLocation, deserializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { Config, CX_BUY_ONLY_DEST } from '@src/features/XIT/ACT/actions/mtra/config';
import { AssertFn, configurableValue } from '@src/features/XIT/ACT/shared-types';
import { generateAgentIds } from '@src/features/XIT/ACT/agent-sync';
import { getPlanetName } from '@src/core/planet-name';

act.addAction<Config>({
  type: 'MTRA',
  shortDescription: 'Transfer materials between storages at the same location',
  description: (action, config) => {
    if (!action.group || !action.origin || !action.dest) {
      return '--';
    }

    const origin =
      action.origin == configurableValue
        ? (config?.origin ?? 'configured location')
        : action.origin;
    const dest =
      action.dest == configurableValue
        ? (config?.destination ?? 'configured location')
        : action.dest;
    if (dest === CX_BUY_ONLY_DEST) {
      return `CX Buy only [${action.group}] from ${origin} (no transfer)`;
    }
    return `Transfer group [${action.group}] from ${origin} to ${dest}`;
  },
  editComponent: Edit,
  configureComponent: Configure,
  needsConfigure: data => {
    return data.origin === configurableValue || data.dest === configurableValue;
  },
  isValidConfig: (data, config) => {
    return (
      (data.origin !== configurableValue || config.origin !== undefined) &&
      (data.dest !== configurableValue || config.destination !== undefined)
    );
  },
  generateSteps: async ctx => {
    const { data, config, packageName, log, getMaterialGroup, getMaterialGroupPlanet, emitStep } =
      ctx;
    const assert: AssertFn = ctx.assert;

    const PRUNPLANNER_PACKAGES = [
      'PRUNplanner Supply Cart',
      'PRUNplanner Construct',
      'PRUNplanner Transfer',
      'PRUNplanner Burn Supply',
    ];

    // Assert-narrowed locals (rebound so nested helpers keep the non-undefined type).
    const materialsMaybe = await getMaterialGroup(data.group);
    assert(materialsMaybe, 'Invalid material group');
    const materials = materialsMaybe;

    const serializedOrigin = data.origin === configurableValue ? config?.origin : data.origin;
    const originMaybe = deserializeStorage(serializedOrigin);
    assert(originMaybe, 'Invalid origin');
    const origin = originMaybe;

    const serializedDest = data.dest === configurableValue ? config?.destination : data.dest;
    if (serializedDest === CX_BUY_ONLY_DEST) {
      return;
    }
    const destMaybe = deserializeStorage(serializedDest);
    assert(destMaybe, 'Invalid destination');
    const dest = destMaybe;

    const isSameLocation = atSameLocation(origin, dest);
    assert(isSameLocation, 'Origin and destination are not at the same location');

    // A finishOnly action re-runs the ship's finish steps (offload JSONs, agent
    // posts, SFC) after all transfer actions; the transfers themselves were
    // already emitted by the matching non-finishOnly action.
    function emitTransferSteps() {
      // Full cargo hold covered by the group → unload via SHPI instead of per-ticker MTRA.
      // SHPI unload has no partial-transfer feedback, so only take this path when
      // the destination store can hold the entire cargo; otherwise fall back to
      // per-ticker MTRA transfers and their per-ticker capacity warnings.
      const originItems = origin.items.filter(x => x.quantity);
      const epsilon = 0.000001;
      const destFits =
        origin.weightLoad <= dest.weightCapacity - dest.weightLoad + epsilon &&
        origin.volumeLoad <= dest.volumeCapacity - dest.volumeLoad + epsilon;
      const fullCargoOffload =
        origin.type === 'SHIP_STORE' &&
        dest.type === 'STORE' &&
        destFits &&
        originItems.length > 0 &&
        originItems.every(x => (materials[x.quantity!.material.ticker] ?? 0) >= x.quantity!.amount);
      if (fullCargoOffload) {
        log.info('Group covers the entire cargo hold — unloading via SHPI instead of MTRA');
        emitStep(SHPI_UNLOAD({ shipId: origin.addressableId }));
      } else {
        for (const ticker of Object.keys(materials)) {
          emitStep(
            MTRA_TRANSFER({
              from: origin.id,
              to: dest.id,
              ticker,
              amount: materials[ticker],
            }),
          );
        }
      }
    }

    async function emitFinishSteps() {
      // Single-group Auto Offload post (no multi-group lists). Multi-stop dispatch
      // posts per-stop packages in the offloadGroups/agentGroups branch below.
      if (
        dest.type === 'SHIP_STORE' &&
        data.postToAgent &&
        !data.offloadGroups &&
        !data.agentGroups
      ) {
        emitStep(
          POST_AGENT({
            pkg: {
              global: { name: 'Auto Offload' },
              groups: [
                {
                  type: 'Manual' as UserData.MaterialGroupType,
                  name: data.group,
                  materials,
                },
              ],
              actions: [
                {
                  type: 'MTRA' as UserData.ActionType,
                  name: data.group,
                  group: data.group,
                  origin: serializedDest,
                  dest: configurableValue,
                },
              ],
            } as UserData.ActionPackageData,
          }),
        );
      }

      if (dest.type === 'SHIP_STORE') {
        const needsPrint = !!data.printOffloadJson;
        const needsSfc = !data.noSfc && !PRUNPLANNER_PACKAGES.includes(packageName);

        const buildOffloadPkg = (
          groupMaterials: Record<string, number>,
          planet: string | undefined,
        ) => {
          const name = 'Auto Offload';
          return {
            global: { name },
            groups: [
              {
                type: 'Manual' as UserData.MaterialGroupType,
                name,
                materials: groupMaterials,
              },
            ],
            actions: [
              {
                type: 'MTRA' as UserData.ActionType,
                name,
                group: name,
                origin: serializedDest,
                dest: planet ? `${getPlanetName(planet)} Base` : configurableValue,
              },
            ],
          } as UserData.ActionPackageData;
        };

        // Shared group-planet for single-group print/SFC fallback (not used by
        // the multi-group path, which resolves each group itself).
        const printGroups = data.offloadGroups ?? [];
        const agentGroups = data.agentGroups ?? (data.postToAgent ? printGroups : []);
        const hasMultiGroups = printGroups.length > 0 || agentGroups.length > 0;

        let planet: string | undefined;
        if (!hasMultiGroups) {
          // Only call getMaterialGroupPlanet when print/SFC need it (it warns if
          // the group has no planet); share the result across both branches.
          const needGroupPlanet = needsPrint || (needsSfc && data.sfcDestination === undefined);
          planet = needGroupPlanet ? getMaterialGroupPlanet(data.group) : undefined;
        }

        if (hasMultiGroups) {
          // One offload package per group name (union of print + agent lists).
          // LOG_JSON only for printGroups; POST_AGENT only for agentGroups.
          // Multi-stop agent posts get chain ids so XIT AGENT can SFC to the next stop.
          let ids: string[] | undefined;
          if (agentGroups.length > 0) {
            ids = ctx.preview
              ? Array.from({ length: agentGroups.length }, (_, i) => `preview-${i + 1}`)
              : await generateAgentIds(agentGroups.length, ctx.state.reservedAgentIds);
          }
          for (const name of [...new Set([...printGroups, ...agentGroups])]) {
            const groupMats = await getMaterialGroup(name);
            if (!groupMats) {
              log.warning(`Skipping offload for missing material group [${name}]`);
              continue;
            }
            const groupPlanet = getMaterialGroupPlanet(name);
            const offloadPkg = buildOffloadPkg(groupMats, groupPlanet);
            if (groupPlanet && data.repairGroups?.includes(name)) {
              // Survives agent-channel sync - unmapped keys pass through compaction.
              offloadPkg.actions[0]!.braPlanet = groupPlanet;
            }
            if (printGroups.includes(name)) {
              emitStep(LOG_JSON({ pkg: offloadPkg }));
            }
            if (ids && agentGroups.includes(name)) {
              emitStep(POST_AGENT({ pkg: offloadPkg, id: ids[agentGroups.indexOf(name)] }));
            }
          }
        } else if (needsPrint) {
          emitStep(LOG_JSON({ pkg: buildOffloadPkg(materials, planet) }));
        }

        if (needsSfc) {
          emitStep(
            OPEN_SFC({
              shipId: dest.addressableId,
              destination: data.sfcDestination ?? planet,
            }),
          );
        }
      }
    }

    if (!data.finishOnly) {
      emitTransferSteps();
    }

    // Repair reminder for DISPATCH-generated offload packages (see braPlanet in
    // user-data.types): after the offload transfers, before the chain SFC.
    if (data.braPlanet) {
      emitStep(OPEN_BRA({ planet: data.braPlanet }));
    }

    await emitFinishSteps();
  },
});
