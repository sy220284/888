# Environment profile contract

Profiles are additive and ordered from the smallest practical development surface to the full repository surface:

`minimal -> test -> native`, with `python` extending `minimal`, and `full = native + python + optional cross-platform tools`.

A profile may only add tools, dependency scopes, or checks. It must not silently remove requirements inherited from a parent profile. CI smoke tests should validate at least `test` on Linux and the platform-specific native surface on the platforms where native code is expected to run.
