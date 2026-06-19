import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import {
  isMetricsIpAllowed,
  requireMetricsIpAllowList,
} from '../middleware/metrics.middleware';

function buildResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return response;
}

test('metrics IP allow-list allows local and private networks by default', () => {
  assert.equal(isMetricsIpAllowed('127.0.0.1'), true);
  assert.equal(isMetricsIpAllowed('::1'), true);
  assert.equal(isMetricsIpAllowed('10.10.0.5'), true);
  assert.equal(isMetricsIpAllowed('172.16.4.2'), true);
  assert.equal(isMetricsIpAllowed('192.168.1.20'), true);
});

test('metrics IP allow-list rejects public unauthenticated access before auth', () => {
  const req = { ip: '8.8.8.8' } as Request;
  const res = buildResponse() as Response & ReturnType<typeof buildResponse>;
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  requireMetricsIpAllowList(req, res, next);

  assert.equal(nextCalled, false);
  assert.equal([401, 403, 404].includes(res.statusCode), true);
  assert.equal(res.statusCode, 403);
});

test('metrics IP allow-list can be configured for scraper networks', () => {
  const original = process.env.METRICS_ALLOWED_NETWORKS;
  process.env.METRICS_ALLOWED_NETWORKS = '203.0.113.0/24';
  try {
    assert.equal(isMetricsIpAllowed('203.0.113.42'), true);
    assert.equal(isMetricsIpAllowed('127.0.0.1'), false);
  } finally {
    if (original === undefined) {
      delete process.env.METRICS_ALLOWED_NETWORKS;
    } else {
      process.env.METRICS_ALLOWED_NETWORKS = original;
    }
  }
});
