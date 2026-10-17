-- consume_hold.lua — take a hold out of the store for good: sold, not released.
--
-- THE RACE THIS PREVENTS. At the expiry instant three things can want the
-- same hold: the confirm (this script), the sweeper (sweep_hold.lua) and a
-- late release (release_hold.lua). Each is one script, and each takes a
-- receipt — this one and the release take the hash, the sweeper takes the
-- index entry — and each removes both, so whoever runs first wins and the
-- other two find nothing. If the sweep won, the quantity is back in the
-- counter and the confirm answers "gone": the customer was late. If the
-- confirm won, the sweeper's ZSCORE finds no entry: nothing to restore. Two
-- commands from the client (EXISTS, then DEL) would let a sweep land in the
-- gap and restore a ticket that is about to be sold.
--
-- No HINCRBY anywhere: the tickets leave "held" for "sold" without passing
-- through "available". The counter already excludes them, and Postgres now
-- subtracts them as order_items instead of as an active hold (TB-010's
-- disjoint sums). Removing the hash and the entry in one step is ADR 0006's
-- constraint on this task: an entry left behind a converted hold would be
-- subtracted by reconcile on every call.
--
-- KEYS[1]  hold hash        ticketbox:v1:hold:<token>
-- KEYS[2]  tier holds zset  ticketbox:v1:tier:<tierId>:holds   member "<token>:<qty>"
-- ARGV[1]  token
-- ARGV[2]  tierId — the caller read it from the hold before this ran; the
--          script checks it still is, so KEYS[2] cannot name the wrong tier
--
-- Returns 1 when consumed; -1 when there is nothing to consume (expired,
-- swept, released, already confirmed — the store cannot tell which and the
-- caller does not need to). On -1, and on an error, nothing is written.
if redis.call('EXISTS', KEYS[1]) == 0 then
  return -1
end
if redis.call('HGET', KEYS[1], 'tierId') ~= ARGV[2] then
  return -1
end
-- The member is built before anything is removed: a hash with no qty
-- raises here, with nothing written, as the sibling scripts promise.
local member = ARGV[1] .. ':' .. redis.call('HGET', KEYS[1], 'qty')
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], member)
return 1
