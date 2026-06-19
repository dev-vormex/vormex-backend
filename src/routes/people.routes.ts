import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import {
  getPeople,
  getSuggestions,
  getPeopleFromSameCollege,
  getPeopleNearMe,
  getFilterOptions,
  searchColleges,
  getCollegeLogo,
  passDiscoverySuggestion,
  rewindDiscoveryPass,
  getSavedDiscoverySearches,
  createSavedDiscoverySearchController,
  updateSavedDiscoverySearchController,
  deleteSavedDiscoverySearchController,
} from '../controllers/people.controller';
import {
  clearPeopleYouKnow,
  getPeopleYouKnow,
  importPeopleYouKnow,
  markPeopleYouKnowInviteSent,
} from '../controllers/people-contacts.controller';

const router = Router();

/**
 * People Discovery Routes
 * 
 * GET /api/people - Search and filter people (public with optional auth)
 * GET /api/people/suggestions - Get personalized suggestions (protected)
 * GET /api/people/same-college - Get people from same college (protected)
 * GET /api/people/near-me - Get people nearby (protected)
 * GET /api/people/filter-options - Get available filter options (public)
 * GET /api/people/colleges - Search colleges on the platform (protected)
 */

// Filter options should be first to avoid path conflicts (optional auth - works for both logged in and anonymous)
router.get('/filter-options', optionalAuth, getFilterOptions);
router.get('/college-logo', getCollegeLogo);

// Protected routes
router.get('/contacts', authenticate, getPeopleYouKnow);
router.post('/contacts/import', authenticate, importPeopleYouKnow);
router.delete('/contacts', authenticate, clearPeopleYouKnow);
router.post('/contacts/:entryId/invite', authenticate, markPeopleYouKnowInviteSent);
router.get('/saved-searches', authenticate, getSavedDiscoverySearches);
router.post('/saved-searches', authenticate, createSavedDiscoverySearchController);
router.patch('/saved-searches/:id', authenticate, updateSavedDiscoverySearchController);
router.delete('/saved-searches/:id', authenticate, deleteSavedDiscoverySearchController);
router.post('/discovery/pass', authenticate, passDiscoverySuggestion);
router.post('/discovery/rewind', authenticate, rewindDiscoveryPass);
router.get('/suggestions', authenticate, getSuggestions);
router.get('/same-college', authenticate, getPeopleFromSameCollege);
router.get('/near-me', authenticate, getPeopleNearMe);
router.get('/colleges', authenticate, searchColleges);

// Main people search (optional auth for personalized results)
router.get('/', optionalAuth, getPeople);

export default router;
