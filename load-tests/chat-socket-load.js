#!/usr/bin/env node

/**
 * Socket.IO chat load test for the Vormex backend.
 *
 * Exercises the realtime send path end-to-end: connect + authenticate,
 * chat:join, chat:typing relay, chat:send_message ack, cross-socket
 * chat:new_message delivery, and chat:delivered receipts. Reports latency
 * percentiles per stage plus duplicate-delivery counts (which must stay 0 —
 * the outbox replay is deduped server-side).
 *
 * Requires socket.io-client (devDependency of this repo). Run from the repo
 * root so the module resolves.
 *
 * Users come in pairs: token[0]<->token[1], token[2]<->token[3], ...
 * Fresh users are BASIC trust tier; for capacity tests raise the DM limit in
 * the target environment (staging only): TRUST_LIMIT_DM_BASIC=100000
 */

const { io } = require('socket.io-client');

const DEFAULT_BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const CONNECT_TIMEOUT_MS = 15_000;
const ACK_TIMEOUT_MS = 10_000;
const DRAIN_WAIT_MS = 3_000;

function printHelp() {
  console.log(`
Vormex chat socket load test.

Usage:
  LOAD_TEST_TOKENS="t1,t2" node load-tests/chat-socket-load.js --duration 30 --message-rate 1

Options:
  --base-url <url>        API base URL. Default: ${DEFAULT_BASE_URL}
  --duration <seconds>    Send phase length. Default: 30
  --message-rate <n>      Messages per second per pair. Default: 1
  --typing <true|false>   Emit a typing burst before each message. Default: true
  --max-ack-p95 <ms>      Fail if send-ack p95 exceeds this.
  --max-error-rate <pct>  Fail if failed sends exceed this percentage.
  --help                  Show this help.

Tokens:
  LOAD_TEST_TOKENS="token1,token2,..."  (even count; consecutive tokens pair up)
  Create staging users/tokens with: node load-tests/create-tokens.js --count 4
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const [rawKey, inlineValue] = current.slice(2).split('=', 2);
    const nextValue = argv[index + 1];
    const value = inlineValue !== undefined
      ? inlineValue
      : nextValue && !nextValue.startsWith('--')
        ? nextValue
        : 'true';
    args[rawKey] = value;
    if (inlineValue === undefined && value === nextValue) index += 1;
  }
  return args;
}

function toPositiveNumber(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return parsed;
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(fraction * sortedValues.length) - 1)
  );
  return sortedValues[index];
}

function summarize(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    label,
    count: sorted.length,
    avg: sorted.length ? Math.round(total / sorted.length) : 0,
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    p99: Math.round(percentile(sorted, 0.99)),
    max: sorted.length ? Math.round(sorted[sorted.length - 1]) : 0,
  };
}

function printSummaryRow(summary) {
  console.log(
    `  ${summary.label.padEnd(22)} n=${String(summary.count).padEnd(6)} ` +
    `avg=${String(summary.avg).padEnd(6)} p50=${String(summary.p50).padEnd(6)} ` +
    `p95=${String(summary.p95).padEnd(6)} p99=${String(summary.p99).padEnd(6)} max=${summary.max} (ms)`
  );
}

async function restRequest(baseUrl, token, method, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': 'vormex-chat-socket-load/1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> HTTP ${response.status} ${json.error || json.message || ''}`);
  }
  return json;
}

function connectClient(baseUrl, token, index) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      auth: { token },
      reconnection: true,
      reconnectionAttempts: 5,
      timeout: CONNECT_TIMEOUT_MS,
    });

    const failTimer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`client ${index}: socket:authenticated not received within ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    socket.on('socket:authenticated', ({ userId }) => {
      clearTimeout(failTimer);
      resolve({ socket, userId, token, index });
    });

    socket.on('connect_error', (error) => {
      clearTimeout(failTimer);
      socket.disconnect();
      reject(new Error(`client ${index}: connect_error ${error.message}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const baseUrl = args['base-url'] || DEFAULT_BASE_URL;
  const durationSeconds = toPositiveNumber(args.duration, 30, '--duration');
  const messageRate = toPositiveNumber(args['message-rate'], 1, '--message-rate');
  const typingEnabled = (args.typing || 'true') !== 'false';
  const maxAckP95 = args['max-ack-p95'] ? toPositiveNumber(args['max-ack-p95'], 0, '--max-ack-p95') : null;
  const maxErrorRate = args['max-error-rate'] !== undefined
    ? Number(args['max-error-rate'])
    : null;

  const tokens = (process.env.LOAD_TEST_TOKENS || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length < 2) {
    throw new Error('Provide at least 2 tokens in LOAD_TEST_TOKENS (see --help).');
  }
  if (tokens.length % 2 !== 0) {
    console.error(`warning: odd token count; ignoring the last token (${tokens.length} provided)`);
    tokens.pop();
  }

  console.log(`Connecting ${tokens.length} sockets to ${baseUrl} ...`);
  const clients = await Promise.all(tokens.map((token, index) => connectClient(baseUrl, token, index)));
  console.log(`All sockets authenticated (${clients.map((client) => client.userId.slice(0, 8)).join(', ')}).`);

  // Pair up and create/get one conversation per pair.
  const pairs = [];
  for (let index = 0; index < clients.length; index += 2) {
    const sender = clients[index];
    const receiver = clients[index + 1];
    const conversation = await restRequest(
      baseUrl,
      sender.token,
      'POST',
      '/api/chat/conversations',
      { participantId: receiver.userId }
    );
    const conversationId = conversation.id || conversation.conversation?.id;
    if (!conversationId) {
      throw new Error(`pair ${index / 2}: could not resolve conversation id from response`);
    }
    sender.socket.emit('chat:join', { conversationId });
    receiver.socket.emit('chat:join', { conversationId });
    pairs.push({ a: sender, b: receiver, conversationId });
  }
  console.log(`${pairs.length} conversation(s) ready. Sending for ${durationSeconds}s at ${messageRate} msg/s per pair ...`);

  // Metrics
  const ackLatencies = [];
  const deliveryLatencies = [];
  const typingLatencies = [];
  const receiptLatencies = [];
  const sendErrors = [];
  let sentCount = 0;
  let ackedCount = 0;
  let deliveredCount = 0;
  let duplicateDeliveries = 0;
  let socketErrorCount = 0;

  const pendingSends = new Map(); // clientMessageId -> { sentAtMs, delivered: count }
  const pendingTyping = new Map(); // conversationId:userId -> emittedAtMs
  const inFlight = new Set();

  for (const pair of pairs) {
    for (const [self, peer] of [[pair.a, pair.b], [pair.b, pair.a]]) {
      self.socket.on('chat:new_message', (data) => {
        const message = data?.message;
        if (!message || data.conversationId !== pair.conversationId) return;
        if (message.senderId === self.userId) return;
        const pending = message.clientMessageId ? pendingSends.get(message.clientMessageId) : null;
        if (pending) {
          pending.delivered += 1;
          if (pending.delivered === 1) {
            deliveredCount += 1;
            deliveryLatencies.push(Date.now() - pending.sentAtMs);
          } else {
            duplicateDeliveries += 1;
          }
        }
        // Behave like a real client: ack delivery so sender receipts flow.
        self.socket.emit('chat:delivered', {
          conversationId: pair.conversationId,
          messageId: message.id,
        });
      });

      self.socket.on('chat:user_typing', (payload) => {
        if (payload?.conversationId !== pair.conversationId || !payload.isTyping) return;
        const key = `${pair.conversationId}:${payload.userId}`;
        const emittedAt = pendingTyping.get(key);
        if (emittedAt) {
          pendingTyping.delete(key);
          typingLatencies.push(Date.now() - emittedAt);
        }
      });

      self.socket.on('chat:messages_delivered', (payload) => {
        if (payload?.conversationId !== pair.conversationId) return;
        const marker = pendingSends.get(`receipt:${pair.conversationId}:${peer.userId}`);
        if (marker) {
          receiptLatencies.push(Date.now() - marker.sentAtMs);
          pendingSends.delete(`receipt:${pair.conversationId}:${peer.userId}`);
        }
      });

      self.socket.on('error', () => {
        socketErrorCount += 1;
      });
    }
  }

  let messageCounter = 0;
  const sendMessage = (pair, sender, receiver) => {
    messageCounter += 1;
    const clientMessageId = `chat-load-${process.pid}-${messageCounter}`;
    const sentAtMs = Date.now();
    pendingSends.set(clientMessageId, { sentAtMs, delivered: 0 });
    pendingSends.set(`receipt:${pair.conversationId}:${receiver.userId}`, { sentAtMs });
    sentCount += 1;

    if (typingEnabled) {
      pendingTyping.set(`${pair.conversationId}:${sender.userId}`, Date.now());
      sender.socket.emit('chat:typing', { conversationId: pair.conversationId, isTyping: true });
    }

    const sendPromise = new Promise((resolve) => {
      sender.socket.timeout(ACK_TIMEOUT_MS).emit(
        'chat:send_message',
        {
          conversationId: pair.conversationId,
          content: `load test message ${messageCounter}`,
          contentType: 'text',
          clientMessageId,
        },
        (timeoutError, response) => {
          if (timeoutError) {
            sendErrors.push('ack timeout');
          } else if (!response || response.ok !== true) {
            sendErrors.push(response?.error || 'ack not ok');
          } else {
            ackedCount += 1;
            ackLatencies.push(Date.now() - sentAtMs);
          }
          if (typingEnabled) {
            sender.socket.emit('chat:typing', { conversationId: pair.conversationId, isTyping: false });
          }
          resolve();
        }
      );
    });

    inFlight.add(sendPromise);
    sendPromise.finally(() => inFlight.delete(sendPromise));
  };

  // Send loop: alternate direction each tick, staggered per pair.
  const intervalMs = Math.max(20, Math.round(1000 / messageRate));
  const timers = pairs.map((pair, pairIndex) => {
    let tick = 0;
    return setInterval(() => {
      tick += 1;
      const forward = tick % 2 === 1;
      sendMessage(pair, forward ? pair.a : pair.b, forward ? pair.b : pair.a);
    }, intervalMs + pairIndex * 7);
  });

  await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
  timers.forEach((timer) => clearInterval(timer));

  // Drain: wait for outstanding acks/deliveries.
  await Promise.allSettled([...inFlight]);
  await new Promise((resolve) => setTimeout(resolve, DRAIN_WAIT_MS));

  clients.forEach((client) => client.socket.disconnect());

  // Report
  const failedCount = sendErrors.length;
  const errorRate = sentCount > 0 ? (failedCount / sentCount) * 100 : 0;
  const lostDeliveries = Math.max(0, ackedCount - deliveredCount);

  console.log('\n===== chat socket load report =====');
  console.log(`  sockets                ${clients.length} (${pairs.length} pair(s))`);
  console.log(`  sent                   ${sentCount}`);
  console.log(`  acked                  ${ackedCount}`);
  console.log(`  failed sends           ${failedCount} (${errorRate.toFixed(2)}%)`);
  console.log(`  delivered to peer      ${deliveredCount}`);
  console.log(`  duplicate deliveries   ${duplicateDeliveries}  <- must be 0`);
  console.log(`  missing deliveries     ${lostDeliveries} (acked but never seen by peer before drain end)`);
  console.log(`  socket error events    ${socketErrorCount}`);
  printSummaryRow(summarize('send -> ack', ackLatencies));
  printSummaryRow(summarize('send -> peer delivery', deliveryLatencies));
  if (typingEnabled) printSummaryRow(summarize('typing relay', typingLatencies));
  printSummaryRow(summarize('delivered receipt', receiptLatencies));
  if (failedCount > 0) {
    const reasons = sendErrors.reduce((acc, reason) => acc.set(reason, (acc.get(reason) || 0) + 1), new Map());
    console.log('  failure reasons:');
    for (const [reason, count] of reasons) console.log(`    ${count}x ${reason}`);
  }

  let failed = false;
  if (maxAckP95 !== null) {
    const ackP95 = summarize('ack', ackLatencies).p95;
    if (ackP95 > maxAckP95) {
      console.error(`THRESHOLD FAILED: ack p95 ${ackP95}ms > ${maxAckP95}ms`);
      failed = true;
    }
  }
  if (maxErrorRate !== null && errorRate > maxErrorRate) {
    console.error(`THRESHOLD FAILED: error rate ${errorRate.toFixed(2)}% > ${maxErrorRate}%`);
    failed = true;
  }
  if (duplicateDeliveries > 0) {
    console.error('THRESHOLD FAILED: duplicate deliveries detected (realtime dedupe regression)');
    failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
