"""Per-call subscriber that applies supervisor notes to a running engine."""

import asyncio
import json
from typing import TYPE_CHECKING, Any, Optional

from loguru import logger

from api.services.supervisor import store
from api.services.supervisor.redis_client import create_pubsub_connection

if TYPE_CHECKING:
    from api.services.workflow.pipecat_engine import PipecatEngine


class SupervisorListener:
    """Keeps a call's engine in sync with the notes stored for its run.

    Runs in the process that owns the pipeline. Failures are logged and never
    propagate: a broken supervisor channel must not affect the call itself.
    """

    def __init__(self, engine: "PipecatEngine", run_id: int):
        self._engine = engine
        self._run_id = run_id
        self._connection = None
        self._pubsub = None
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        try:
            self._connection = create_pubsub_connection()
            self._pubsub = self._connection.pubsub()
            # Subscribe before loading so a note posted in between is not lost.
            await self._pubsub.subscribe(store.control_channel(self._run_id))
            notes = await store.list_notes(self._run_id)
            if notes:
                await self._engine.set_supervisor_notes(notes)
            self._task = asyncio.create_task(
                self._listen(), name=f"supervisor-listener:{self._run_id}"
            )
        except Exception as e:
            logger.warning(
                f"Supervisor listener unavailable for run {self._run_id}: {e}"
            )
            await self._close_connection()

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        await self._close_connection()

    async def _listen(self) -> None:
        try:
            async for message in self._pubsub.listen():
                if message.get("type") != "message":
                    continue
                await self._handle(message.get("data"))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(f"Supervisor listener crashed for run {self._run_id}")

    async def _handle(self, raw: Any) -> None:
        try:
            signal = json.loads(raw)
        except (TypeError, ValueError):
            return
        if not isinstance(signal, dict):
            return
        try:
            notes = await store.list_notes(self._run_id)
            await self._engine.set_supervisor_notes(
                notes,
                change=signal.get("change"),
                note=signal.get("note"),
                respond_now=bool(signal.get("respond_now")),
            )
        except Exception:
            logger.exception(
                f"Failed to apply supervisor notes for run {self._run_id}"
            )

    async def _close_connection(self) -> None:
        try:
            if self._pubsub is not None:
                await self._pubsub.unsubscribe()
                await self._pubsub.aclose()
            if self._connection is not None:
                await self._connection.aclose()
        except Exception as e:
            logger.debug(f"Failed to close supervisor listener for {self._run_id}: {e}")
        finally:
            self._pubsub = None
            self._connection = None
