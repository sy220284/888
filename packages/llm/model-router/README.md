# dsh-model-router

Durable model fallback routing. A recovery decision appends `model/route-selected`; the next `agent/request` attempt reuses that exact provider/model, and the ordinary `request/header` records the effective route for replay.

Fallback only runs after provider-local retry has declined. A configured target must currently have a registered provider adapter, and a step never revisits a route it already tried.
