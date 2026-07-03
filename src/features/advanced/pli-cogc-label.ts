import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

function formatCogcLabel(programType?: string | null) {
  if (!programType) {
    return 'CoGC (Inactive)';
  }

  let localized = getI18nValue(`CoGCProgram.${programType}_SHORT`);
  localized ??= programType
    .replace(/^(ADVERTISING|WORKFORCE)_/, '')
    .replace(/^\w/, c => c.toUpperCase())
    .replace(/\w+$/, c => c.toLowerCase());
  return `CoGC (${localized})`;
}

function onTileReady(tile: PrunTile) {
  const localizedLabel = getI18nValue('PlanetaryProjects.COGC', 'Chamber of Global Commerce');
  subscribe($$(tile.anchor, C.PlanetaryProjectsList.row), async row => {
    const link = await $(row, C.Link.link);
    if (link.textContent !== localizedLabel) {
      return;
    }
    const planet = planetsStore.find(tile.parameter);
    if (!planet) {
      return;
    }

    link.textContent = formatCogcLabel(planet.cogcProgramType);
  });
}

function init() {
  tiles.observe('PLI', onTileReady);
}

features.add(import.meta.url, init, 'PLI：将"全球商业商会"行标签替换为"CoGC ({program type})"。');
