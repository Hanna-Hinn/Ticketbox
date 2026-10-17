-- create_hold.lua — reserve qty tickets from a tier under a hold token.
--
-- THE RACE THIS PREVENTS. The naive version (TB-021) was three commands
-- from the client: HGET remaining, compare in TypeScript, HINCRBY -qty.
-- Each command is atomic; the sequence is not. Between the HGET's reply
-- and the HINCRBY's write sits a round trip, and in that gap Redis answers
-- every other caller's HGET with the same number. 200 concurrent callers
-- each read 10, each passed the check, each decremented: remaining -390,
-- 195 holds sold from 10 tickets (docs/NOTES.md § TB-021). Redis runs a
-- script to completion before it reads the next command from any client,
-- so in here the read, the comparison and the decrement are one step: the
-- sixth caller reads 0, not 10.
--
-- KEYS[1]  tier hash        ticketbox:v1:tier:<tierId>        { remaining }
-- KEYS[2]  hold hash        ticketbox:v1:hold:<token>         { tierId, qty, createdAt, expiresAt }
-- KEYS[3]  tier holds zset  ticketbox:v1:tier:<tierId>:holds  token -> expiresAt ms (the sweeper's index, TB-026)
-- ARGV[1]  qty
-- ARGV[2]  token
-- ARGV[3]  tierId
-- ARGV[4]  createdAt, epoch ms, from the application's Clock
-- ARGV[5]  expiresAt, epoch ms, the same Clock — the instant the client counts down to
-- ARGV[6]  ttlMs, for the hold key's PEXPIRE (Redis's clock from now; the one thing not on the app's clock)
--
-- Returns the new remaining (>= 0) when reserved; -1 when insufficient;
-- -2 when the tier has no counter at all (never seeded, or lost — reconcile,
-- TB-027). On -1 and -2 nothing is written.
--
-- Not idempotent: the same token twice decrements twice. Tokens are
-- generated, never retried; an idempotent POST /holds is TB-030's lesson.
local remaining = redis.call('HGET', KEYS[1], 'remaining')
if not remaining then
  return -2
end
local qty = tonumber(ARGV[1])
if tonumber(remaining) < qty then
  return -1
end
local left = redis.call('HINCRBY', KEYS[1], 'remaining', -qty)
redis.call('HSET', KEYS[2], 'tierId', ARGV[3], 'qty', ARGV[1], 'createdAt', ARGV[4], 'expiresAt', ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[6])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[2])
return left
