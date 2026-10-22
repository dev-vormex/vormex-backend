#!/usr/bin/env node

// This isolated process loads the real API composition without binding a port
// or running database queries. Only the external startup boundary is stubbed.
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const http = require('node:http');
const socketIO = require('socket.io');

require('dotenv').config = () => ({ parsed: {} });
Object.assign(process.env, {
  NODE_ENV: 'development',
  PORT: '5001',
  DATABASE_URL: 'postgresql://contract:contract@localhost:5432/contract',
  DIRECT_URL: 'postgresql://contract:contract@localhost:5432/contract',
  READ_DATABASE_URL: '',
  GITHUB_CLIENT_ID: 'contract-client',
  GITHUB_CLIENT_SECRET: 'contract-secret',
  GITHUB_CALLBACK_URL: 'http://localhost:5001/api/integrations/github/callback',
  FRONTEND_URL: 'http://localhost:3000',
  JWT_SECRET: 'contract-only-jwt-secret-at-least-32-characters',
  AUTH_CSRF_SECRET: 'contract-only-csrf-secret-at-least-32-characters',
  ENCRYPTION_KEY: 'a'.repeat(64),
  API_REDIS_MODE: 'false',
  REDIS_REQUIRED: 'false',
  CRITICAL_REDIS_REQUIRED: 'false',
  CACHE_REDIS_REQUIRED: 'false',
  REDIS_URL: '',
  CRITICAL_REDIS_URL: '',
  CACHE_REDIS_URL: '',
  PROXIMITY_REDIS_URL: '',
  TRUST_PROXY: 'true',
  MCP_ENABLED: 'true',
  FIREBASE_PROJECT_ID: '',
  FIREBASE_CLIENT_EMAIL: '',
  FIREBASE_PRIVATE_KEY: '',
});

// Stop startup at its existing schema check; never execute a database query.
PrismaClient.prototype.$queryRaw = function () {
  return new Promise(() => {});
};

const createServer = http.createServer;
let app;
http.createServer = function (listener, ...args) {
  app = listener;
  return createServer.call(this, listener, ...args);
};

const OriginalSocketServer = socketIO.Server;
let io;
socketIO.Server = class extends OriginalSocketServer {
  constructor(...args) {
    super(...args);
    io = this;
  }
};

require(path.join(process.cwd(), 'dist/index.js'));

function flattenLayers(stack, parent = '') {
  return stack.flatMap((layer, index) => {
    const position = parent ? `${parent}.${index}` : String(index);
    return [
      [
        position,
        layer.name,
        String(layer.regexp),
        layer.keys,
        layer.route
          ? [layer.route.path, layer.route.methods, layer.route.stack.map((handler) => [handler.method, handler.name])]
          : null,
      ],
      ...(layer.handle.stack ? flattenLayers(layer.handle.stack, position) : []),
    ];
  });
}

async function capture() {
  const events = [];
  const socket = {
    id: 'contract',
    data: {},
    conn: { transport: { name: 'websocket' }, on() {} },
    use() {},
    on(event) {
      events.push(event);
    },
    emit() {},
  };
  for (const listener of io.listeners('connection')) await listener(socket);
  return {
    trustProxy: app.get('trust proxy'),
    http: flattenLayers(app._router.stack),
    socket: {
      events,
      authenticationMiddlewareCount: io.sockets._fns.length,
      transports: io.engine.opts.transports,
      maxHttpBufferSize: io.engine.opts.maxHttpBufferSize,
      allowUpgrades: io.engine.opts.allowUpgrades,
    },
  };
}

void capture()
  .then((contract) => {
    fs.writeFileSync(process.argv[2], JSON.stringify(contract));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
