import { createHash } from 'node:crypto';
import type { RedisService } from './redis.service';
import type { TrackedLocationPoint } from './location-history.service';

// One key, at most 10 stored + 10 native fixes. No authorization or SQL lifecycle
// decision lives here. The JSON schema and TTL remain compatible with readers.
const MERGE_HISTORY = `
local raw = redis.call('GET', KEYS[1])
if raw and string.len(raw) > 32768 then return redis.error_reply('Invalid tracking history size') end
local existing = raw and cjson.decode(raw) or {}
local incoming = cjson.decode(ARGV[1])
local native = cjson.decode(ARGV[2])
local hasBatch = ARGV[3] == '1'
local ttl = tonumber(ARGV[4])
local limit = 10
local function point(p) return type(p) == 'table' end
-- All points are normalized to UTC ISO by LocationHistoryService. Convert the
-- date to an ordinal so duplicate detection works across midnight/year/leap day.
local function stamp(p)
  if not point(p) or type(p.recordedAt) ~= 'string' then return nil end
  local y, m, d, h, mi, s, ms = string.match(p.recordedAt,
    '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.(%d%d%d)Z$')
  if not y then return nil end
  y, m, d, h, mi, s, ms = tonumber(y), tonumber(m), tonumber(d), tonumber(h), tonumber(mi), tonumber(s), tonumber(ms)
  local offsets = {0,31,59,90,120,151,181,212,243,273,304,334}
  if not offsets[m] then return nil end
  local prev = y - 1
  local days = 365 * prev + math.floor(prev/4) - math.floor(prev/100) + math.floor(prev/400) + offsets[m] + d
  if m > 2 and (y % 400 == 0 or (y % 4 == 0 and y % 100 ~= 0)) then days = days + 1 end
  return (((days * 24 + h) * 60 + mi) * 60 + s) * 1000 + ms
end
local at, oldAt = stamp(incoming), stamp(existing.current)
if not at then return redis.error_reply('Invalid tracking timestamp') end
if oldAt and at < oldAt then return 0 end
local samples = {}
if type(existing.samples) == 'table' and #existing.samples > 0 then
  for i = math.max(1, #existing.samples - limit + 1), #existing.samples do
    table.insert(samples, existing.samples[i])
  end
else
  if point(existing.previous) then table.insert(samples, existing.previous) end
  if point(existing.current) then table.insert(samples, existing.current) end
end
local previous
if hasBatch then
  local merged = {}
  for i = math.max(1, #native - limit + 1), #native do merged[native[i].recordedAt] = native[i] end
  -- Persisted observations win conflicting native duplicates; the latest fix wins its own timestamp.
  for _, p in ipairs(samples) do merged[p.recordedAt] = p end
  merged[incoming.recordedAt] = incoming
  samples = {}
  for _, p in pairs(merged) do table.insert(samples, p) end
  table.sort(samples, function(a, b) return a.recordedAt < b.recordedAt end)
else
  local duplicate = false
  if oldAt and math.abs(at - oldAt) <= 20000 then
    local old = existing.current
    local rad = math.pi / 180
    local dlat, dlon = (incoming.latitude - old.latitude) * rad, (incoming.longitude - old.longitude) * rad
    local a = math.sin(dlat/2)^2 + math.cos(old.latitude*rad) * math.cos(incoming.latitude*rad) * math.sin(dlon/2)^2
    a = math.min(1, math.max(0, a))
    duplicate = 6371000 * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a)) <= 3
  end
  if duplicate then
    if #samples > 0 then table.remove(samples) end
    previous = existing.previous
  else
    previous = existing.current
  end
  table.insert(samples, incoming)
end
while #samples > limit do table.remove(samples, 1) end
local result = { previous = samples[#samples-1] or previous or cjson.null,
  current = samples[#samples], samples = samples }
redis.call('SET', KEYS[1], cjson.encode(result), 'EX', ttl)
return 1
`;
const MERGE_HISTORY_SHA = createHash('sha1').update(MERGE_HISTORY).digest('hex');

/** One round trip once Redis knows the script; NOSCRIPT alone permits a retry. */
export async function appendLocationHistory(
  client: Pick<ReturnType<RedisService['getClient']>, 'eval' | 'evalSha'>,
  key: string,
  current: TrackedLocationPoint,
  native: TrackedLocationPoint[],
  hasNativeBatch: boolean,
  ttl: number,
): Promise<void> {
  const options = { keys: [key], arguments: [JSON.stringify(current),
    JSON.stringify(native.slice(-10)), hasNativeBatch ? '1' : '0', String(ttl)] };
  try {
    await client.evalSha(MERGE_HISTORY_SHA, options);
  } catch (error) {
    // Never replay an ambiguous timeout/disconnect/OOM write. A fresh server or
    // failover may have lost its script cache, but NOSCRIPT means no execution.
    if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT ')) throw error;
    await client.eval(MERGE_HISTORY, options);
  }
}
