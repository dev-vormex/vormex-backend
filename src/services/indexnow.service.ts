const WEB_BASE_URL = (process.env.PUBLIC_WEB_BASE_URL || 'https://www.vormex.in').replace(/\/+$/, '');

export async function submitIndexNow(urls: string[]): Promise<void> {
  const key = String(process.env.INDEXNOW_KEY || '').trim();
  const uniqueUrls = Array.from(new Set(urls.filter((url) => url.startsWith(`${WEB_BASE_URL}/`)))).slice(0, 10_000);
  if (!key || !uniqueUrls.length || process.env.PUBLIC_SEO_ENABLED === 'false') return;

  try {
    const response = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: new URL(WEB_BASE_URL).host,
        key,
        keyLocation: `${WEB_BASE_URL}/indexnow-key.txt`,
        urlList: uniqueUrls,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok && response.status !== 202) {
      console.warn(`IndexNow submission returned ${response.status}.`);
    }
  } catch (error) {
    console.warn('IndexNow submission failed.', error instanceof Error ? error.message : error);
  }
}
