import assert from 'node:assert/strict';
import { readImplementationFile as readFileSync } from './helpers/implementation-source';
import path from 'node:path';
import test from 'node:test';
import { isPublicOutboundAddress } from '../infrastructure/http/safe-outbound-http.util';

test('link preview outbound filtering rejects local, private, mapped, and transition addresses', () => {
  const blocked = [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
  ];
  blocked.forEach((address) => assert.equal(isPublicOutboundAddress(address), false, address));

  assert.equal(isPublicOutboundAddress('8.8.8.8'), true);
  assert.equal(isPublicOutboundAddress('2606:4700:4700::1111'), true);
});

test('refresh rotation inherits the consumed generation so logout-all wins races', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src/modules/auth/services/auth-session.service.ts'),
    'utf8'
  );
  assert.match(source, /userSessionVersion: existing\.userSessionVersion \|\| 0/);
  assert.match(source, /await incrementUserSessionVersion\(userId\)/);
});
