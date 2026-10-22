import assert from 'node:assert/strict';
import test from 'node:test';
import { positiveIntEnv, roundedPositiveIntEnv, parsePositiveInt } from '../config/env.util';
import { parseRetryAfterSeconds } from '../infrastructure/http/retry-after.util';
import { normalizeOptionalText, normalizeStringList } from '../modules/profiles/utils/profile-fields.util';
import { asTrimmedString } from '../shared/utils/text-value.util';
import { AgentOrchestratorService } from '../modules/agent/services/orchestrator/orchestrator-context.service';

test('shared numeric parsing preserves distinct flooring, rounding, and integer-prefix rules', () => {
  const key = 'VORMEX_REFACTOR_TEST_INTEGER';
  const previous = process.env[key];
  try {
    process.env[key] = '1.6';
    assert.equal(positiveIntEnv(key, 9), 1);
    assert.equal(roundedPositiveIntEnv(key, 9), 2);
    assert.equal(parsePositiveInt('12junk', 9), 12);
    process.env[key] = '12junk';
    assert.equal(positiveIntEnv(key, 9), 9);
    assert.equal(roundedPositiveIntEnv(key, 9), 9);
    process.env[key] = '-1';
    assert.equal(positiveIntEnv(key, 9), 9);
    assert.equal(roundedPositiveIntEnv(key, 9), 9);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('shared text helpers preserve capitalization rules and reject non-string inputs', () => {
  assert.equal(asTrimmedString('  Mixed Case  '), 'Mixed Case');
  assert.equal(normalizeOptionalText('  Mixed Case  '), 'mixed case');
  assert.equal(asTrimmedString({ text: 'value' }), null);
  assert.equal(normalizeOptionalText('  '), null);
  assert.deepEqual(normalizeStringList([' React ', 'react', ' TypeScript ', null]), ['react', 'typescript']);
});

test('shared Retry-After parsing preserves arrays, seconds, dates, and unavailable values', () => {
  assert.equal(parseRetryAfterSeconds(['1.5', '100']), 2);
  assert.equal(parseRetryAfterSeconds(2.2), 3);
  assert.equal(parseRetryAfterSeconds('invalid'), undefined);
  assert.equal(parseRetryAfterSeconds(0), undefined);
  assert.equal(parseRetryAfterSeconds('2000-01-01T00:00:00Z'), 1);
});

test('extracted voice operations retain the service instance, dynamic collaborators, and response shape', async () => {
  const service = new AgentOrchestratorService();
  const calls: string[] = [];
  service.transcribeAudio = async function () {
    assert.equal(this, service);
    calls.push('transcribe');
    return 'transcribed input';
  };
  service.runTurn = async function (userId, sessionId, turn, requestId) {
    assert.equal(this, service);
    assert.equal(userId, 'user');
    assert.equal(sessionId, 'session');
    assert.equal(turn.inputText, 'transcribed input');
    assert.equal(requestId, 'request');
    calls.push('turn');
    return { assistantMessage: 'reply', preservedField: 'value' } as any;
  };
  service.synthesizeSpeech = async function (text) {
    assert.equal(this, service);
    assert.equal(text, 'reply');
    calls.push('speech');
    return { audioBase64: 'audio', audioMimeType: 'audio/mpeg' };
  };
  const params = {
    userId: 'user',
    sessionId: 'session',
    turn: { inputText: 'original input' } as any,
    audioBuffer: Buffer.from('input'),
    fileName: 'input.mp3',
    mimeType: 'audio/mpeg',
    requestId: 'request',
  };
  assert.deepEqual(await service.runVoiceTurn(params), {
    assistantMessage: 'reply',
    preservedField: 'value',
    transcript: 'transcribed input',
    audioBase64: 'audio',
    audioMimeType: 'audio/mpeg',
  });
  assert.deepEqual(calls, ['transcribe', 'turn', 'speech']);
  calls.length = 0;
  assert.deepEqual(await service.runVoiceTurn({ ...params, synthesizeAudio: false }), {
    assistantMessage: 'reply',
    preservedField: 'value',
    transcript: 'transcribed input',
    audioBase64: null,
    audioMimeType: null,
  });
  assert.deepEqual(calls, ['transcribe', 'turn']);
  const failure = new Error('transcription unavailable');
  service.transcribeAudio = async () => {
    throw failure;
  };
  await assert.rejects(service.runVoiceTurn(params), (error) => error === failure);
});
