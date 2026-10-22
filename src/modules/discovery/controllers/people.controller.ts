/** Stable import surface; implementations are grouped by responsibility. */
export { getPeople } from './people/directory.controller';
export { searchPeople } from './people/search.controller';
export { getSuggestions, passDiscoverySuggestion, rewindDiscoveryPass } from './people/suggestions.controller';
export { getPeopleFromSameCollege, searchColleges, getCollegeLogo } from './people/campus.controller';
export { getPeopleNearMe, getFilterOptions } from './people/nearby.controller';
export {
  getSavedDiscoverySearches,
  createSavedDiscoverySearchController,
  updateSavedDiscoverySearchController,
  deleteSavedDiscoverySearchController,
} from './people/saved-searches.controller';
