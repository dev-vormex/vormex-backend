import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import {
  buildCollegeLogoUrl,
  fetchGooglePlacesSchoolSuggestions,
  mergeCollegeSuggestions,
  searchCatalogColleges,
} from '../services/college-catalog.service';

test('buildCollegeLogoUrl returns a safe favicon URL for valid domains', () => {
  assert.equal(
    buildCollegeLogoUrl('vit.ac.in'),
    'https://www.google.com/s2/favicons?domain=vit.ac.in&sz=128'
  );
  assert.equal(buildCollegeLogoUrl('not a domain'), null);
});

test('searchCatalogColleges matches names and aliases', () => {
  const results = searchCatalogColleges('Vellore Institute', 5);
  assert.ok(results.some((college) => college.name === 'VIT Vellore'));
});

test('searchCatalogColleges includes Narayana fallbacks with logos', () => {
  const results = searchCatalogColleges('narayana', 10);
  const juniorCollege = results.find((college) => college.name === 'Narayana Junior Colleges');
  const schools = results.find((college) => college.name === 'Narayana Schools');

  assert.ok(juniorCollege);
  assert.equal(juniorCollege?.kind, 'Junior college');
  assert.equal(juniorCollege?.domain, 'narayanajuniorcolleges.com');
  assert.ok(juniorCollege?.logoUrl?.includes('narayanajuniorcolleges.com'));
  assert.ok(schools);
  assert.equal(schools?.domain, 'narayanaschools.in');
});

test('mergeCollegeSuggestions keeps platform counts and enriches known colleges with logos', () => {
  const catalog = searchCatalogColleges('VIT', 5);
  const results = mergeCollegeSuggestions(
    [{ name: 'VIT Vellore', count: 7 }],
    [],
    [],
    catalog,
    [],
    5
  );

  assert.equal(results[0].name, 'VIT Vellore');
  assert.equal(results[0].count, 7);
  assert.equal(results[0].source, 'platform');
  assert.equal(results[0].domain, 'vit.ac.in');
  assert.ok(results[0].logoUrl?.includes('vit.ac.in'));
});

test('mergeCollegeSuggestions ranks India provider results before platform counts', () => {
  const results = mergeCollegeSuggestions(
    [{ name: 'VIT Vellore', count: 99 }],
    [],
    [{
      id: 'provider-vit-ap',
      name: 'VIT-AP University',
      count: 0,
      logoUrl: null,
      domain: null,
      country: 'India',
      state: 'Andhra Pradesh',
      city: 'Amaravati',
      kind: 'University',
      source: 'collegedb',
    }],
    [],
    [],
    5
  );

  assert.equal(results[0].name, 'VIT-AP University');
  assert.equal(results[0].source, 'collegedb');
});

test('mergeCollegeSuggestions ranks Google Places results first', () => {
  const results = mergeCollegeSuggestions(
    [{ name: 'VIT Vellore', count: 99 }],
    [{
      id: 'google-vit-ap',
      name: 'VIT-AP University',
      count: 0,
      logoUrl: null,
      domain: null,
      country: 'India',
      state: 'Andhra Pradesh',
      city: 'Amaravati',
      kind: 'University',
      source: 'google_places',
    }],
    [{
      id: 'provider-vit-ap',
      name: 'VIT-AP University',
      count: 0,
      logoUrl: null,
      domain: null,
      country: 'India',
      state: 'Andhra Pradesh',
      city: 'Amaravati',
      kind: 'University',
      source: 'collegedb',
    }],
    [],
    [],
    5
  );

  assert.equal(results[0].name, 'VIT-AP University');
  assert.equal(results[0].source, 'google_places');
});

test('fetchGooglePlacesSchoolSuggestions searches India broadly and filters education results', async () => {
  const originalPost = axios.post;
  const originalGet = axios.get;
  const originalGooglePlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  const originalGoogleMapsKey = process.env.GOOGLE_MAPS_API_KEY;
  const originalEnabled = process.env.GOOGLE_PLACES_SCHOOL_SEARCH_ENABLED;
  const calls: Array<{ method: 'get' | 'post'; url: string; body?: any; options: any }> = [];

  process.env.GOOGLE_PLACES_API_KEY = 'test-google-key';
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_PLACES_SCHOOL_SEARCH_ENABLED;
  (axios as any).post = async (url: string, body: any, options: any) => {
    calls.push({ method: 'post', url, body, options });

    if (url.includes('places:autocomplete')) {
      return {
        data: {
          suggestions: [
            {
              placePrediction: {
                placeId: 'google-vit-ap',
                text: { text: 'VIT-AP University, Amaravati, Andhra Pradesh, India' },
                structuredFormat: {
                  mainText: { text: 'VIT-AP University' },
                  secondaryText: { text: 'Amaravati, Andhra Pradesh, India' },
                },
                types: ['university', 'point_of_interest'],
              },
            },
            {
              placePrediction: {
                placeId: 'google-vita-store',
                text: { text: 'Vita Store, Mumbai, Maharashtra, India' },
                structuredFormat: {
                  mainText: { text: 'Vita Store' },
                  secondaryText: { text: 'Mumbai, Maharashtra, India' },
                },
                types: ['store', 'point_of_interest'],
              },
            },
          ],
        },
      };
    }

    return {
      data: {
        places: [
          {
            id: 'google-vit-ap',
            displayName: { text: 'VIT-AP University' },
            formattedAddress: 'Amaravati, Andhra Pradesh, India',
            primaryType: 'university',
            types: ['university', 'point_of_interest'],
            websiteUri: 'https://vitap.ac.in/',
          },
          {
            id: 'google-vita-store',
            displayName: { text: 'Vita Store' },
            formattedAddress: 'Mumbai, Maharashtra, India',
            primaryType: 'store',
            types: ['store', 'point_of_interest'],
          },
        ],
      },
    };
  };
  (axios as any).get = async (url: string, options: any) => {
    calls.push({ method: 'get', url, options });
    return {
      data: {
        id: 'google-vit-ap',
        displayName: { text: 'VIT-AP University' },
        formattedAddress: 'Amaravati, Andhra Pradesh, India',
        primaryType: 'university',
        types: ['university', 'point_of_interest'],
        websiteUri: 'https://vitap.ac.in/',
      },
    };
  };

  try {
    const results = await fetchGooglePlacesSchoolSuggestions('vit-a', 10);
    const autocompleteCall = calls.find((call) => call.url.includes('places:autocomplete'));
    const textSearchCall = calls.find((call) => call.url.includes('places:searchText'));
    const vitAp = results.find((college) => college.name === 'VIT-AP University');

    assert.ok(autocompleteCall);
    assert.ok(textSearchCall);
    assert.equal(Object.prototype.hasOwnProperty.call(autocompleteCall.body, 'includedPrimaryTypes'), false);
    assert.deepEqual(autocompleteCall.body.includedRegionCodes, ['in']);
    assert.ok(textSearchCall.body.textQuery.includes('educational institution India'));
    assert.ok(calls.some((call) => call.body?.textQuery?.includes('junior college India')));
    assert.ok(calls.some((call) => call.body?.textQuery?.includes('school India')));
    assert.ok(textSearchCall.body.locationRestriction);
    assert.equal(textSearchCall.options.headers['X-Goog-FieldMask'].includes('places.websiteUri'), true);
    assert.ok(calls.some((call) => call.method === 'get' && call.url.includes('/places/google-vit-ap')));
    assert.equal(
      calls.some((call) => call.method === 'get' && call.options.headers['X-Goog-FieldMask'].includes('websiteUri')),
      true
    );
    assert.ok(vitAp);
    assert.equal(vitAp?.domain, 'vitap.ac.in');
    assert.ok(vitAp?.logoUrl?.includes('vitap.ac.in'));
    assert.equal(results.some((college) => college.name === 'Vita Store'), false);
  } finally {
    (axios as any).post = originalPost;
    (axios as any).get = originalGet;
    if (originalGooglePlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = originalGooglePlacesKey;
    if (originalGoogleMapsKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalGoogleMapsKey;
    if (originalEnabled === undefined) delete process.env.GOOGLE_PLACES_SCHOOL_SEARCH_ENABLED;
    else process.env.GOOGLE_PLACES_SCHOOL_SEARCH_ENABLED = originalEnabled;
  }
});
