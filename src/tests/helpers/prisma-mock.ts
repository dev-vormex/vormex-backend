import type { TestContext } from 'node:test';

/** Prisma delegate proxies expose undefined descriptors; mock their writable methods directly. */
export function mockPrismaMethod<T extends object, K extends keyof T, F extends (...args: never[]) => unknown>(
  t: TestContext,
  delegate: T,
  method: K,
  implementation: F
) {
  const original = delegate[method];
  const mock = t.mock.fn(implementation);
  Object.assign(delegate, { [method]: mock });
  t.after(() => Object.assign(delegate, { [method]: original }));
  return mock;
}
