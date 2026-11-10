import os, time, asyncio, redis.asyncio as redis

LEASE_KEY = "athena:lease"
INSTANCE_ID = os.getenv("INSTANCE_ID", "unknown")   # "laptop" or "railway"
TTL = 30          # seconds before a heartbeat is considered stale
RENEW = 10        # heartbeat interval

def _client():
    return redis.from_url(os.environ["REDIS_URL"], decode_responses=True)

async def _try_claim(r):
    # SET NX: only succeeds if nobody holds the lease
    return await r.set(LEASE_KEY, INSTANCE_ID, nx=True, ex=TTL)

async def _renew(r):
    # only extend if we still own it
    if (await r.get(LEASE_KEY)) == INSTANCE_ID:
        await r.expire(LEASE_KEY, TTL)
        return True
    return False

async def acquire_lease(timeout=None):
    """Block until this instance owns the lease."""
    r = _client()
    waited = 0
    while True:
        if await _try_claim(r) or await _renew(r):
            await r.close()
            return
        if timeout and waited >= timeout:
            await r.close()
            raise TimeoutError("could not acquire lease")
        await asyncio.sleep(2)
        waited += 2
