# GeDe

A tool that captures a three-tier generative design process — purpose and value propositions (1st Tier), architecture vocabularies (2nd Tier), and an n-dimensional design canvas where **contexts** bind one parameter per dimension, carry justifications, and recurse into child canvases (3rd Tier).

Tables are the record (Numbers-style, edited in place); the circle canvas is their spatial companion.

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/HANDOFF.md](docs/HANDOFF.md) | **Start here when resuming work** — current state, next slice, working agreement, gotchas |
| [docs/SPEC.md](docs/SPEC.md) | Product spec: domain model, invariants, application behavior, milestones |
| [docs/TECH_STACK.md](docs/TECH_STACK.md) | Stack choices, cost analysis, decision log |
| [docs/STYLE_GUIDE.md](docs/STYLE_GUIDE.md) | Visual language, table grammar, canvas responsiveness |
| [docs/SITEMAP.md](docs/SITEMAP.md) | Routes, shell anatomy (header/status bar), navigation styles, keyboard map |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [docs/issues/](docs/issues/) | Lightweight issue tracker (one file per issue) |

## Status

Pre-implementation. Specs locked at SPEC v0.2 / TECH_STACK v1.0; next step is milestone M1 (core model + context register).
