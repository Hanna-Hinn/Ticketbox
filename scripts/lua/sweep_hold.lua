-- sweep_hold.lua — give an expired hold's tickets back, once.
--
-- THE RACE THIS PREVENTS. By the time a hold may be swept its hash has
-- expired, so the index entry (member "<token>:<qty>", score expiresAt) is
-- the only trace of what was held. The obvious sweep is two commands from
-- the worker: read the entry, HINCRBY the quantity back. Two sweepers —
-- two worker processes, a tick overlapping the next, or a sweep racing a
-- late release — each read "2 tickets, expired" and each add 2 back: the
-- tier gains its tickets twice and oversells from the other direction. In
-- here the entry is the receipt: whoever removes it restores, and the
-- second caller finds no entry and restores nothing. release_hold.lua
-- removes the same entry, so a release and a sweep cannot both pay either.
--
-- KEYS[1]  tier holds zset  ticketbox:v1:tier:<tierId>:holds
-- KEYS[2]  tier hash        ticketbox:v1:tier:<tierId>        { remaining }
-- KEYS[3]  hold hash        ticketbox:v1:hold:<token>         (gone by now, usually)
-- ARGV[1]  member, "<token>:<qty>", exactly as the index holds it
-- ARGV[2]  qty, decoded from the member by the caller
-- ARGV[3]  now, epoch ms, the application's Clock — the clock that set the score
--
-- Returns the new remaining (>= 0) when restored; -1 when there is nothing
-- to sweep (already swept, or released); -2 when the hold's tier has no
-- counter to restore into (evicted — the entry and the hash are removed,
-- nothing is added back, and reconciliation (TB-027) rebuilds the counter
-- from Postgres, which is why the caller still marks the row expired); -3
-- when the hold is not expired yet, whatever the caller thinks. On -1 and
-- -3 nothing is written. The restore (HINCRBY, the one command here that
-- can fail, on a counter that is not an integer) runs BEFORE the removes:
-- Redis does not undo a script's earlier writes when a later one raises,
-- and an entry removed first would take the sweeper's only trace with it.
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then
  return -1
end
if tonumber(score) > tonumber(ARGV[3]) then
  return -3
end
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('DEL', KEYS[3])
  return -2
end
local left = redis.call('HINCRBY', KEYS[2], 'remaining', ARGV[2])
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[3])
return left
