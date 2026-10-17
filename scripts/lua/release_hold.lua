-- release_hold.lua — give a hold's tickets back, once.
--
-- THE RACE THIS PREVENTS. The obvious release is two commands from the
-- client: HINCRBY the quantity back, then DEL the hold. Two releases of the
-- same token — a double click, a client retry, a release racing the
-- sweeper (TB-026) — each read the quantity and each add it back: the tier
-- gains its tickets twice and oversells from the other direction. In here
-- the existence check and the restore are one step: the second caller
-- finds no key and restores nothing. Deleting the key IS the receipt, so a
-- transport replay (TB-022's lesson) is just a second caller.
--
-- KEYS[1]  hold hash        ticketbox:v1:hold:<token>
-- KEYS[2]  tier hash        ticketbox:v1:tier:<tierId>        { remaining }
-- KEYS[3]  tier holds zset  ticketbox:v1:tier:<tierId>:holds
-- ARGV[1]  token
--
-- Returns the new remaining (>= 0) when released; -1 when there is nothing
-- to release (expired, swept, already released, never existed); -2 when the
-- hold exists but its tier has no counter to restore into (evicted — do
-- not invent one of size qty: refuse, warn, reconcile, TB-027). On -1 and
-- -2 nothing is written.
if redis.call('EXISTS', KEYS[1]) == 0 then
  return -1
end
if redis.call('EXISTS', KEYS[2]) == 0 then
  return -2
end
local qty = tonumber(redis.call('HGET', KEYS[1], 'qty'))
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return redis.call('HINCRBY', KEYS[2], 'remaining', qty)
