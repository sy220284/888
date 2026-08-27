# dsh-recovery-compaction

Recovery strategy for `CONTEXT_WINDOW_EXCEEDED`. It asks the active compaction service for a forced safe reduction and retries only when compaction actually changed the model-visible surface.
