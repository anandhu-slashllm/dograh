"""Shared Redis connection for the supervisor feature."""

import asyncio

import redis.asyncio as aioredis

from api.constants import REDIS_URL

_client: aioredis.Redis | None = None
_lock = asyncio.Lock()


async def get_redis() -> aioredis.Redis:
    """Return the process-wide Redis client, creating it on first use.

    Pub/sub subscribers must not share this connection; they open their own
    with ``create_pubsub_connection``.
    """
    global _client
    if _client is None:
        async with _lock:
            if _client is None:
                _client = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _client


def create_pubsub_connection() -> aioredis.Redis:
    """Open a dedicated connection for a long-lived pub/sub subscription."""
    return aioredis.from_url(REDIS_URL, decode_responses=True)
