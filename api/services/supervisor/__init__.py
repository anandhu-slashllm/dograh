"""Live supervisor notes: steer an in-progress call and watch it live.

A supervisor posts notes for a workflow run. Notes live in Redis so that the
API process serving the supervisor and the process running the call's pipeline
(which may differ when FASTAPI_WORKERS > 1) share them. The pipeline process
subscribes to a per-run control channel and folds the notes into the current
node's system prompt. Realtime feedback events for the run are mirrored to a
per-run Redis channel so the supervisor console can stream the transcript of
any call, including telephony calls that have no browser WebSocket.
"""
