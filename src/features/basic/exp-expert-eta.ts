import { expertsStore } from '@src/infrastructure/prun-api/data/experts';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { timestampEachMinute } from '@src/utils/dayjs';
import { formatEta } from '@src/utils/format';
import { createReactiveDiv } from '@src/utils/reactive-element';
import { calculateEta, getTotalExperts, MS_IN_DAY } from '@src/core/experts';

const orderedExpertiseRows = [
  'AGRICULTURE',
  'CHEMISTRY',
  'CONSTRUCTION',
  'ELECTRONICS',
  'FOOD_INDUSTRIES',
  'FUEL_REFINING',
  'MANUFACTURING',
  'METALLURGY',
  'RESOURCE_EXTRACTION',
];

function onTileReady(tile: PrunTile) {
  const site = sitesStore.getById(tile.parameter)!;

  subscribe($$(tile.anchor, 'tr'), tr => {
    if (_$(tr, 'th')) {
      const header = document.createElement('th');
      header.textContent = '预计时间';
      tr.append(header);
      return;
    }
    const parent = tr.parentElement!;
    const index = Array.from(parent.children).indexOf(tr);
    if (index >= orderedExpertiseRows.length) {
      return;
    }
    const expertise = orderedExpertiseRows[index];
    onExpertRowReady(tr, expertise, site.siteId);
  });
}

function onExpertRowReady(row: HTMLTableRowElement, expertise: string, siteId: string) {
  const expertEntry = computed(() => {
    const experts = expertsStore.getBySiteId(siteId);
    return experts?.experts.find(x => x.category === expertise)?.entry;
  });

  const expertLines = computed(() => {
    const production = productionStore.getBySiteId(siteId);
    return production?.filter(line =>
      line.efficiencyFactors.some(x => x.type === 'EXPERTS' && x.expertiseCategory === expertise),
    );
  });

  const eta = computed(() => {
    const entry = expertEntry.value;
    const lines = expertLines.value;
    return entry && lines ? calculateEta(entry, lines) : undefined;
  });

  const text = computed(() => {
    const entry = expertEntry.value;
    const lines = expertLines.value;
    if (!entry || !lines) {
      return '--';
    }

    if (getTotalExperts(entry) >= entry.limit) {
      return 'Maxed';
    }

    if (!eta.value) {
      return '--';
    }

    if (eta.value.type === 'precise') {
      return `${formatEta(timestampEachMinute.value, eta.value.ms)}`;
    }

    if (eta.value.type === 'estimate') {
      return isFinite(eta.value.ms) ? `~${(eta.value.ms / MS_IN_DAY).toFixed(1)}d` : '∞';
    }

    return '--';
  });

  const div = createReactiveDiv(row, text);
  div.style.whiteSpace = 'pre-wrap';
  const td = document.createElement('td');
  td.append(div);
  row.append(td);
}

function init() {
  tiles.observe('EXP', onTileReady);
}

features.add(import.meta.url, init, 'EXP：显示下一位专家出现的预计时间。');
