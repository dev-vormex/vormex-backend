/** Stable import surface; implementations live in focused responsibility modules. */
export {
  FREE_DISCOVERY_SUGGESTIONS_PER_DAY,
  DISCOVERY_SOURCE_FOR_YOU,
  DISCOVERY_SOURCE_PEOPLE_SEARCH,
  DiscoveryAccess,
  SuggestionQuotaState,
  searchVariants,
  normalizeIntentValues,
  hasPremiumPeopleDiscoveryFilters,
  buildPremiumRequiredDiscoveryResponse,
  getDiscoveryAccess,
  getSuggestionQuotaState,
  recordSuggestionImpressions,
  recordPeopleSearchAppearances,
  getActiveDiscoveryPassTargetIds,
  passDiscoveryUser,
  rewindLastDiscoveryPass,
  hasActiveDiscoveryPasses,
} from './discovery-power/free-discovery-suggestions-per-day.service';
export {
  getNearbyDiscoveryUserIds,
  buildPeopleDiscoveryWhere,
} from './discovery-power/get-nearby-discovery-user-ids.service';
export {
  sanitizeSavedSearchFilters,
  listSavedDiscoverySearches,
  createSavedDiscoverySearch,
  updateSavedDiscoverySearch,
  deleteSavedDiscoverySearch,
  buildSavedSearchDigestCopy,
  runSavedDiscoverySearchDigest,
} from './discovery-power/sanitize-saved-search-filters.service';
