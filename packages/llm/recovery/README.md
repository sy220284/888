# dsh-recovery

Cross-provider/context recovery seam for failed model requests. Provider-local backoff remains in `dsh-llm-retry`; recovery strategies run only after downstream retry declines.

Strategies are disposable Cordis effects, ordered by priority, and a winning decision is persisted as `recovery/decision` before the agent retries. The service never owns a second message history or Agent runtime.
