# Development bundle redistribution policy

Development bundles may include only project-owned files and third-party artifacts whose licenses and distribution terms permit redistribution. All other tools remain installer references to official HTTPS sources and must be integrity-checked before execution.

The default public bundle therefore contains the Harness bootstrap layer, profile/tool metadata, and checksum manifests. Node, Rust, Python, uv, platform compilers, Git, and PowerShell are acquired from their official distribution channels unless a future license review explicitly adds a redistributable binary artifact.
