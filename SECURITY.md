# Security policy

Tool manifests and server responses may contain sensitive descriptions or data. Use synthetic fixtures and review reports before sharing them. Adapter exception messages are deliberately excluded from findings/transcripts. Manifest size, supported keywords, bounds, regex witness syntax, and generated cardinalities are validated before execution, but callers remain responsible for isolating any real transport adapter.

Report vulnerabilities privately through GitHub Security Advisories. Include the affected version, a minimal synthetic manifest, adapter type, and expected/observed result. Never include credentials. Supported line: `0.1.x`; no response SLA is promised.
