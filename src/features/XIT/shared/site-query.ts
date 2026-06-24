import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { convertToPlanetNaturalId } from '@src/core/planet-natural-id';
import { findWithQuery } from '@src/utils/find-with-query';

export interface SiteQueryOptions {
  includeOverall?: boolean;
  overallSite?: PrunApi.Site;
}

export interface SiteQueryResult {
  sites: PrunApi.Site[];
  includeOverall?: boolean;
  overallOnly: boolean;
}

export function createSiteFinder(overallSite?: PrunApi.Site) {
  return function findSites(term: string, parts: string[]) {
    if (term === 'all') {
      return sitesStore.all.value;
    }

    if (term === 'overall' && overallSite) {
      return overallSite;
    }

    const naturalId = convertToPlanetNaturalId(term, parts);
    return sitesStore.getByPlanetNaturalId(naturalId);
  };
}

export function querySites(parameters: string[], options: SiteQueryOptions = {}): SiteQueryResult {
  const { includeOverall: shouldIncludeOverall, overallSite } = options;
  const allSites = sitesStore.all.value ?? [];
  const findSites = createSiteFinder(overallSite);

  if (parameters.length === 0) {
    return {
      sites: allSites,
      includeOverall: shouldIncludeOverall ?? false,
      overallOnly: false,
    };
  }

  const result = findWithQuery(parameters, findSites);
  let matches = result.include;
  if (result.includeAll) {
    matches = allSites;
  }
  if (result.excludeAll) {
    matches = [];
  }
  matches = matches.filter(x => !result.exclude.has(x));
  const nonOverallMatches = overallSite ? matches.filter(x => x !== overallSite) : matches;
  const overallIncluded =
    shouldIncludeOverall &&
    (nonOverallMatches.length > 1 ||
      matches.length !== nonOverallMatches.length ||
      result.includeAll);
  const overallExcluded = (overallSite && result.exclude.has(overallSite)) || result.excludeAll;

  let includeOverall = overallIncluded && !overallExcluded;
  let overallOnly = false;
  let overallOnlySites = allSites;
  if (overallSite && matches.length === 1 && matches[0] === overallSite && !overallExcluded) {
    overallOnlySites = allSites.filter(x => !result.exclude.has(x));
    includeOverall = true;
    overallOnly = true;
  }

  return {
    sites: overallOnly ? overallOnlySites : nonOverallMatches,
    includeOverall,
    overallOnly,
  };
}
