const BASE_URL = (process.env.AI_SMOKE_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
const TOKEN = process.env.AI_SMOKE_TOKEN;

if (!TOKEN) {
  console.error('Missing AI_SMOKE_TOKEN');
  process.exit(1);
}

async function callAI(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'x-request-id': `ai-smoke-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  const requiredHeaders = [
    'x-request-id',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
  ];

  const missingHeaders = requiredHeaders.filter((header) => !response.headers.get(header));

  return {
    json,
    missingHeaders,
    ok: response.ok,
    status: response.status,
  };
}

async function run() {
  const checks = [
    {
      name: 'fix-grammar',
      path: '/api/ai/chat/fix-grammar',
      body: { message: 'i am building vormex ai feature' },
    },
    {
      name: 'change-tone',
      path: '/api/ai/chat/change-tone',
      body: { message: 'Let us connect soon', tone: 'friendly' },
    },
    {
      name: 'translate',
      path: '/api/ai/chat/translate',
      body: { message: 'Nice to meet you', targetLanguage: 'hindi' },
    },
    {
      name: 'expand',
      path: '/api/ai/chat/expand',
      body: { message: 'Let us talk tomorrow', context: 'professional' },
    },
    {
      name: 'career-chat',
      path: '/api/ai/chat/career-chat',
      body: {
        message: 'How should I prepare for a backend developer interview?',
        conversationHistory: [
          { role: 'user', content: 'I am focusing on Node.js roles.' },
          { role: 'assistant', content: 'That is a good focus area.' },
        ],
      },
    },
  ];

  let failures = 0;

  for (const check of checks) {
    const result = await callAI(check.path, check.body);

    if (!result.ok || result.missingHeaders.length > 0) {
      failures += 1;
      console.error(`[FAIL] ${check.name}`, {
        status: result.status,
        missingHeaders: result.missingHeaders,
        body: result.json,
      });
      continue;
    }

    console.log(`[PASS] ${check.name}`, {
      status: result.status,
      bodyKeys: Object.keys(result.json || {}),
    });
  }

  if (failures > 0) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('AI smoke test failed', error);
  process.exit(1);
});
