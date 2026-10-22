import type { Request, Response } from 'express';

/** Minimal HTTP boundary for exercising controllers without a listener or database. */
export function controllerRequest(body: Record<string, unknown> = {}, query = {}, params = {}) {
  return { user: { userId: 'user-1' }, body, query, params } as Request<Record<string, string>> & {
    user: { userId: string };
  };
}

export function controllerResponse() {
  const state: { status: number; body: unknown } = { status: 200, body: undefined };
  const response = {
    status(code: number) {
      state.status = code;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  };
  return { state, response: response as unknown as Response };
}
