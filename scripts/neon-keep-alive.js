#!/usr/bin/env node
/**
 * Keeps Neon development database warm to prevent auto-suspend (P1001 errors).
 * Run this in a separate terminal while developing: node scripts/neon-keep-alive.js
 *
 * Neon free tier suspends after ~5 min of inactivity. This pings every 4 min.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

async function ping() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log(`[${new Date().toLocaleTimeString()}] Neon DB ping OK`);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Ping failed:`, err.message);
  }
}

console.log('Neon keep-alive running (pings every 4 min). Press Ctrl+C to stop.\n');
ping();
setInterval(ping, INTERVAL_MS);
