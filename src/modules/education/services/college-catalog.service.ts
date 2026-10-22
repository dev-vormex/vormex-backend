/** Stable import surface; implementations live in focused responsibility modules. */
export {
  CollegeSuggestionSource,
  CollegeCatalogEntry,
  CollegeSuggestion,
  normalizeCollegeQuery,
  normalizeCollegeKey,
  buildCollegeLogoUrl,
  fetchCollegeLogoImage,
  searchCatalogColleges,
} from './college-catalog/normalize-college-query.service';
export { fetchGooglePlacesSchoolSuggestions } from './college-catalog/fetch-google-places-school-suggestions.service';
export {
  fetchCollegeDbSuggestions,
  fetchDirectoryCollegeSuggestions,
  mergeCollegeSuggestions,
} from './college-catalog/fetch-college-db-suggestions.service';
