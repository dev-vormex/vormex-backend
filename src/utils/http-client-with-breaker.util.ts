import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { thirdPartyHttpCounter } from '../infrastructure/metrics/registry';

export type CircuitBreakerStateName = 'closed' | 'open' | 'half_open';
export type ThirdPartyHttpOutcome = 'success' | 'failure' | 'timeout' | 'open';

export interface HttpBreakerPolicy {
  failureThreshold?: number;
  cooldownMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface CircuitState {
  state: CircuitBreakerStateName;
  consecutiveFailures: number;
  openedAt: number;
  halfOpenProbeInFlight: boolean;
}

export class ThirdPartyHttpError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly code: 'third_party_timeout' | 'third_party_circuit_open' | 'third_party_request_failed';
  readonly retryable: boolean;

  constructor(params: {
    provider: string;
    operation: string;
    code: ThirdPartyHttpError['code'];
    message: string;
    retryable?: boolean;
  }) {
    super(params.message);
    this.name = 'ThirdPartyHttpError';
    this.provider = params.provider;
    this.operation = params.operation;
    this.code = params.code;
    this.retryable = params.retryable ?? true;
  }
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const circuits = new Map<string, CircuitState>();

function circuitKey(provider: string, operation: string): string {
  return `${provider}:${operation}`;
}

function getCircuit(provider: string, operation: string): CircuitState {
  const key = circuitKey(provider, operation);
  const existing = circuits.get(key);
  if (existing) return existing;

  const created: CircuitState = {
    state: 'closed',
    consecutiveFailures: 0,
    openedAt: 0,
    halfOpenProbeInFlight: false,
  };
  circuits.set(key, created);
  return created;
}

function metric(provider: string, operation: string, outcome: ThirdPartyHttpOutcome): void {
  thirdPartyHttpCounter.inc({ provider, operation, outcome });
}

function openCircuit(state: CircuitState): void {
  state.state = 'open';
  state.openedAt = Date.now();
  state.halfOpenProbeInFlight = false;
}

function closeCircuit(state: CircuitState): void {
  state.state = 'closed';
  state.consecutiveFailures = 0;
  state.openedAt = 0;
  state.halfOpenProbeInFlight = false;
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof ThirdPartyHttpError) {
    return error.code === 'third_party_timeout';
  }

  if (axios.isAxiosError(error)) {
    return error.code === 'ECONNABORTED'
      || error.code === 'ETIMEDOUT'
      || error.code === 'ERR_CANCELED'
      || /timeout/i.test(error.message || '');
  }

  return error instanceof Error && /timeout|timed out|aborted/i.test(error.message);
}

function withTimeout<T>(
  promise: Promise<T>,
  provider: string,
  operation: string,
  requestTimeoutMs: number
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ThirdPartyHttpError({
        provider,
        operation,
        code: 'third_party_timeout',
        message: `${provider} ${operation} timed out after ${requestTimeoutMs}ms`,
      }));
    }, requestTimeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function isThirdPartyHttpError(error: unknown): error is ThirdPartyHttpError {
  return error instanceof ThirdPartyHttpError;
}

export async function executeWithCircuitBreaker<T>(
  provider: string,
  operation: string,
  fn: () => Promise<T>,
  policy: HttpBreakerPolicy = {}
): Promise<T> {
  const failureThreshold = policy.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const cooldownMs = policy.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const requestTimeoutMs = policy.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const state = getCircuit(provider, operation);
  const now = Date.now();

  if (state.state === 'open') {
    if (now - state.openedAt < cooldownMs) {
      metric(provider, operation, 'open');
      throw new ThirdPartyHttpError({
        provider,
        operation,
        code: 'third_party_circuit_open',
        message: `${provider} ${operation} circuit is open`,
      });
    }

    state.state = 'half_open';
  }

  if (state.state === 'half_open') {
    if (state.halfOpenProbeInFlight) {
      metric(provider, operation, 'open');
      throw new ThirdPartyHttpError({
        provider,
        operation,
        code: 'third_party_circuit_open',
        message: `${provider} ${operation} circuit is probing recovery`,
      });
    }
    state.halfOpenProbeInFlight = true;
  }

  try {
    const result = await withTimeout(fn(), provider, operation, requestTimeoutMs);
    closeCircuit(state);
    metric(provider, operation, 'success');
    return result;
  } catch (error) {
    state.halfOpenProbeInFlight = false;
    state.consecutiveFailures += 1;

    const timeout = isTimeoutError(error);
    metric(provider, operation, timeout ? 'timeout' : 'failure');

    if (state.state === 'half_open' || state.consecutiveFailures >= failureThreshold) {
      openCircuit(state);
    }

    if (error instanceof ThirdPartyHttpError) {
      throw error;
    }

    throw error;
  }
}

function getAbortSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

export async function requestWithBreaker<T = unknown>(
  provider: string,
  operation: string,
  config: AxiosRequestConfig,
  policy: HttpBreakerPolicy = {}
): Promise<AxiosResponse<T>> {
  const connectTimeoutMs = policy.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const requestTimeoutMs = policy.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const method = String(config.method || 'GET').toUpperCase();
  const url = String(config.url || '');
  const requestConfig: AxiosRequestConfig = {
    ...config,
    timeout: Math.min(connectTimeoutMs, requestTimeoutMs),
    signal: config.signal || getAbortSignal(requestTimeoutMs),
  };
  delete requestConfig.method;
  delete requestConfig.url;
  delete requestConfig.data;

  return executeWithCircuitBreaker(
    provider,
    operation,
    () => {
      if (method === 'GET') return axios.get<T>(url, requestConfig);
      if (method === 'POST') return axios.post<T>(url, config.data, requestConfig);
      if (method === 'PUT') return axios.put<T>(url, config.data, requestConfig);
      if (method === 'DELETE') return axios.delete<T>(url, requestConfig);
      return axios.request<T>({
        ...requestConfig,
        method,
        url,
        data: config.data,
      });
    },
    { ...policy, requestTimeoutMs }
  );
}

export async function fetchWithBreaker(
  provider: string,
  operation: string,
  input: string | URL,
  init: RequestInit = {},
  policy: HttpBreakerPolicy = {}
): Promise<Response> {
  const requestTimeoutMs = policy.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return executeWithCircuitBreaker(
    provider,
    operation,
    () => fetch(input, {
      ...init,
      signal: init.signal || getAbortSignal(requestTimeoutMs),
    }),
    { ...policy, requestTimeoutMs }
  );
}

export function resetHttpCircuitBreakersForTests(): void {
  circuits.clear();
}
