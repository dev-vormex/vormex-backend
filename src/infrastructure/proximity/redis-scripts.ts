import type Redis from 'ioredis';

const HEARTBEAT_SCRIPT = `
local currentGeneration = tonumber(redis.call('HGET', KEYS[1], 'generation') or '0')
local currentSequence = tonumber(redis.call('HGET', KEYS[1], 'sequence') or '0')
local currentSample = redis.call('HGET', KEYS[1], 'sampleId') or ''
local incomingGeneration = tonumber(ARGV[1])
local incomingSequence = tonumber(ARGV[2])
local incomingSample = ARGV[3]
if currentGeneration > incomingGeneration then return {'out_of_order'} end
if currentGeneration == incomingGeneration and currentSequence > incomingSequence then return {'out_of_order'} end
if currentGeneration == incomingGeneration and currentSequence == incomingSequence and currentSequence > 0 then
  if currentSample == incomingSample then return {'duplicate'} end
  return {'conflict'}
end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'sample_duplicate'} end
local oldGeo = redis.call('HGET', KEYS[1], 'geoKey')
local oldCohort = redis.call('HGET', KEYS[1], 'cohortKey')
local oldPresenceRaw = redis.call('GET', KEYS[3])
if oldPresenceRaw then
  local decodedOk, oldPresence = pcall(cjson.decode, oldPresenceRaw)
  if decodedOk and oldPresence and oldPresence.mode and oldPresence.shard then
    local presenceGeo = 'proximity:v1:geo:' .. oldPresence.mode .. ':' .. oldPresence.shard
    local presenceCohort = presenceGeo .. ':c:' .. tostring(oldPresence.cohort or 0)
    if presenceGeo ~= KEYS[4] then redis.call('ZREM', presenceGeo, ARGV[4]) end
    if presenceCohort ~= KEYS[5] then redis.call('ZREM', presenceCohort, ARGV[4]) end
    if oldPresence.shard ~= string.sub(KEYS[6], string.len('proximity:v1:lastSeen:') + 1) then
      redis.call('ZREM', 'proximity:v1:lastSeen:' .. oldPresence.shard, ARGV[4])
    end
  end
end
if oldGeo and oldGeo ~= KEYS[4] then redis.call('ZREM', oldGeo, ARGV[4]) end
if oldCohort and oldCohort ~= KEYS[5] then redis.call('ZREM', oldCohort, ARGV[4]) end
redis.call('GEOADD', KEYS[4], ARGV[5], ARGV[6], ARGV[4])
redis.call('GEOADD', KEYS[5], ARGV[5], ARGV[6], ARGV[4])
redis.call('HSET', KEYS[1], 'generation', ARGV[1], 'sequence', ARGV[2], 'sampleId', ARGV[3], 'geoKey', KEYS[4], 'cohortKey', KEYS[5])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[11]))
redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[8]))
redis.call('SET', KEYS[3], ARGV[9], 'EX', tonumber(ARGV[7]))
redis.call('ZADD', KEYS[6], ARGV[10], ARGV[4])
redis.call('SADD', KEYS[7], KEYS[6])
redis.call('SET', KEYS[8], ARGV[12], 'EX', tonumber(ARGV[8]))
return {'accepted'}
`;

export type AtomicHeartbeatResult = 'accepted' | 'duplicate' | 'sample_duplicate' | 'out_of_order' | 'conflict';

export async function atomicHeartbeat(redis: Redis, input: {
  sessionKey: string; sampleKey: string; presenceKey: string; geoKey: string; cohortKey: string;
  lastSeenKey: string; shardsKey: string; responseKey: string; generation: number; sequence: number; sampleId: string;
  userId: string; longitude: number; latitude: number; ttlSeconds: number; idempotencyTtlSeconds: number;
  presenceJson: string; serverSeenAtMs: number; sessionTtlSeconds: number; responseJson: string;
}): Promise<AtomicHeartbeatResult> {
  const result = await redis.eval(HEARTBEAT_SCRIPT, 8,
    input.sessionKey, input.sampleKey, input.presenceKey, input.geoKey, input.cohortKey,
    input.lastSeenKey, input.shardsKey, input.responseKey, String(input.generation), String(input.sequence), input.sampleId,
    input.userId, String(input.longitude), String(input.latitude), String(input.ttlSeconds),
    String(input.idempotencyTtlSeconds), input.presenceJson, String(input.serverSeenAtMs), String(input.sessionTtlSeconds),
    input.responseJson);
  return String((result as string[])[0]) as AtomicHeartbeatResult;
}
