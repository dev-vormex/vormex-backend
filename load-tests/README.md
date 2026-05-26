# Backend Load Testing

This folder contains a no-dependency load-test runner for the Vormex Express API.

## What To Test First

Use separate tests for separate bottlenecks:

- `health-live`: raw API process/network overhead, no database.
- `health-ready`: database connection overhead through Prisma.
- `public-read`: anonymous feed/discovery traffic.
- `auth-read`: logged-in app-home traffic.

The backend currently has a general API rate limit of 120 requests/minute per IP and 600 requests/minute per authenticated user. For larger staging tests, use several test users/tokens or temporarily raise limits in a staging-only config.

## Start The Backend

From `vormex-backend`:

```bash
npm run dev
```

The default backend URL in this repo is `http://localhost:5000`.

## Run Basic Tests

Liveness only:

```bash
node load-tests/simple-load.js --scenario health-live --duration 30 --concurrency 20
```

Database readiness:

```bash
node load-tests/simple-load.js --scenario health-ready --duration 30 --concurrency 20
```

Public read traffic:

```bash
node load-tests/simple-load.js --scenario public-read --duration 60 --concurrency 30
```

Rate-limit-respecting public read traffic from one IP:

```bash
node load-tests/simple-load.js --scenario public-read --duration 60 --concurrency 5 --target-rps 2
```

Owned staging/local capacity test with virtual source IPs:

```bash
node load-tests/simple-load.js --scenario public-read --duration 60 --concurrency 30 --virtual-ips 30
```

Authenticated read traffic:

```bash
LOAD_TEST_TOKEN="<jwt>" node load-tests/simple-load.js --scenario auth-read --duration 60 --concurrency 30
```

Use multiple tokens to avoid measuring one user's rate limit instead of backend capacity:

```bash
LOAD_TEST_TOKENS="token1,token2,token3" node load-tests/simple-load.js --scenario auth-read --duration 120 --concurrency 60
```

Create up to 5 staging users/tokens:

```bash
node load-tests/create-tokens.js --count 5
```

Then paste the printed `LOAD_TEST_TOKENS="..."` before the authenticated test:

```bash
LOAD_TEST_TOKENS="token1,token2,token3,token4,token5" \
node load-tests/simple-load.js --scenario auth-read --duration 120 --concurrency 30 --virtual-ips 30
```

## Get A Token

Use a token from your logged-in web/mobile session, or register a staging user:

```bash
curl -s -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"load-test@example.com","password":"LoadTest123!","name":"Load Test"}'
```

The response includes `token`; put that value in `LOAD_TEST_TOKEN`.

## Custom Scenario

Copy `custom-scenario.example.json` and edit the requests:

```bash
node load-tests/simple-load.js --file load-tests/custom-scenario.example.json --duration 60 --concurrency 20
```

Each request supports:

- `name`: label in the report.
- `method`: HTTP method.
- `path`: API path joined to `--base-url`.
- `url`: full URL, if you do not want to use `--base-url`.
- `headers`: request headers.
- `body`: JSON object or raw string body.
- `auth`: set `false` to skip bearer token on one request.
- `weight`: higher means this request is selected more often.

## Useful Thresholds

Fail the command if p95 or error rate is too high:

```bash
node load-tests/simple-load.js \
  --scenario public-read \
  --duration 60 \
  --concurrency 30 \
  --max-p95 500 \
  --max-error-rate 1
```

## Reading Results

Watch these values:

- `Throughput`: requests per second.
- `Failed`: non-2xx/3xx responses plus network errors.
- `p95` / `p99`: tail latency. These matter more than average latency.
- `Status counts`: `429` means rate limit, `503` means readiness/database trouble, `5xx` means backend errors.
- `--target-rps`: use this when you want a realistic request rate from one IP instead of max-speed pressure.
- `--virtual-ips`: use this only against your own local/staging backend to test backend capacity beyond the per-IP limiter.

For real staging tests, also watch:

- `GET /metrics`
- API CPU and memory
- Postgres CPU, connections, slow queries
- Redis CPU, memory, and queue backlog
- Worker logs and queue lag
