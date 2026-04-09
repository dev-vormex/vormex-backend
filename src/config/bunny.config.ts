export const bunnyConfig = {
  storage: {
    zoneName: process.env.BUNNY_STORAGE_ZONE_NAME!,
    apiKey: process.env.BUNNY_STORAGE_API_KEY!,
    region: process.env.BUNNY_STORAGE_REGION || 'sg',
    hostname: process.env.BUNNY_STORAGE_HOSTNAME || 'sg.storage.bunnycdn.com',
  },
  cdn: {
    hostname: process.env.BUNNY_CDN_HOSTNAME!,
    pullZoneUrl: process.env.BUNNY_PULL_ZONE_URL || 'https://vormex.b-cdn.net',
  },
};

