-- release_hold.lua — give a hold's tickets back, once.
--
-- THE RACE THIS PREVENTS. The obvious release is three commands from the
-- client: HGET the quantity, HINCRBY it back, DEL the hold — the same
-- read-then-write shape as TB-021's reserve. Two releases of the same
-- token — a double click, a client retry, a release racing the
-- sweeper (TB-026) — each read the quantity and each add it back: the tier
-- gains its tickets twice and oversells from the other direction. In here
-- the existence check and the restore are one step: the second caller
-- finds no key and restores nothing. Deleting the key IS the receipt, so a
-- transport replay (TB-022's lesson) is just a second caller.
--
-- KEYS[1]  hold hash        ticketbox:v1:hold:<token>
-- KEYS[2]  tier hash        ticketbox:v1:tier:<tierId>        { remaining }
-- KEYS[3]  tier holds zset  ticketbox:v1:tier:<tierId>:holds   member "<token>:<qty>" (TB-026)
-- ARGV[1]  token
-- ARGV[2]  tierId — the caller read it from the hold before this ran; the
--          script checks it still is, so KEYS[2] and KEYS[3] cannot name the
--          wrong tier
--
-- Returns the new remaining (>= 0) when released; -1 when there is nothing
-- to release (expired, swept, already released, never existed); -2 when the
-- hold exists but its tier has no counter to restore into (evicted — do
-- not invent one of size qty: refuse, warn, reconcile, TB-027). On -1 and
-- -2 nothing is written — and on an error nothing is written either: the
-- restore (HINCRBY, the one command here that can fail, on a counter that
-- is not an integer or a hold with no qty) runs BEFORE the deletes, because
-- Redis does not undo a script's earlier writes when a later one raises. A
-- hold deleted first would take its tickets and the sweeper's only trace
-- of them with it.
if redis.call('EXISTS', KEYS[1]) == 0 then
  return -1
end
if redis.call('HGET', KEYS[1], 'tierId') ~= ARGV[2] then
  return -1
end
if redis.call('EXISTS', KEYS[2]) == 0 then
  return -2
end
local qty = redis.call('HGET', KEYS[1], 'qty')
local left = redis.call('HINCRBY', KEYS[2], 'remaining', qty)
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[1] .. ':' .. qty)
return left
