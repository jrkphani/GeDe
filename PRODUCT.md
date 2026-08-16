# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

GeDe is for experienced operators working across product strategy, systems architecture, service design, and domain expertise. They use it together when a design problem needs a shared model rather than disconnected documents or workshops.

## Product Purpose

GeDe turns a generative design method into a shared workspace. Teams move from purpose and value propositions, through architecture vocabulary, into design contexts that bind one parameter from each dimension and record why that combination matters.

Success means the team can build, inspect, discuss, and evolve one coherent design model together: the model makes relationships visible, preserves the rationale behind decisions, and supports deliberate generation of further options.

## Positioning

GeDe’s distinctive mechanism is its three-tier, n-dimensional context model: Foundation and Architecture feed a recursive Design canvas where every context binds a complete parameter tuple, carries a justification, and can open a child canvas for refinement. The table register and circle canvas are two live projections of the same auditable model.

## Operating Context

Teams work in projects containing Foundation, Architecture, and Design lanes. They create and rank value propositions, define and nest architecture entries, promote these entries into design dimensions and parameters, and bind contexts across dimensions. Contexts can recurse indefinitely; coverage shows which parameter combinations are documented or unexplored.

Operators use inline tables, a spatial canvas, keyboard shortcuts, undo/redo, export/import, and collaboration features to make and review decisions together.

## Capabilities and Constraints

- Projects can contain multiple root canvases and recursively nested child canvases.
- A complete context binds exactly one parameter for every dimension of its canvas; drafts are allowed.
- Canvas geometry is derived from the context tree and bindings and is never persisted as positional data.
- The system supports a shared workspace, collaboration, presence, and workspace membership.
- Auditability is non-negotiable: decisions, bindings, justifications, coverage, and recoverable changes must remain inspectable.
- The application is local-first and sync-ready, using a Postgres-compatible data model and migrations from the outset.
- Architecture-source links propagate vocabulary into Design while retaining provenance.

## Brand Commitments

- Name: GeDe.
- Voice: precise, calm, operator-facing, and concise; never tutorial-like or patronizing.
- Existing visual identity is established in the implementation and must be preserved unless explicitly redesigned.

## Evidence on Hand

- Product behavior and domain invariants: [docs/SPEC.md](docs/SPEC.md).
- Technical decisions and deployment model: [docs/TECH_STACK.md](docs/TECH_STACK.md).
- Navigation and interaction map: [docs/SITEMAP.md](docs/SITEMAP.md).
- Incumbent visual language: [docs/STYLE_GUIDE.md](docs/STYLE_GUIDE.md), [src/styles/tokens.css](src/styles/tokens.css), and [src/styles/base.css](src/styles/base.css).
- No customer testimonials, market benchmarks, or external proof claims are established here; future work must not fabricate them.

## Product Principles

1. One shared model is more valuable than a collection of disconnected design artifacts.
2. Rationale is part of a decision, not an afterthought.
3. The model must make relationships and unexplored possibilities inspectable.
4. Expert operators should work quickly without being constrained by a prescribed sequence.
5. Collaboration and auditability are product invariants, not optional add-ons.

## Accessibility & Inclusion

The workspace must remain operable with keyboard navigation, visible focus, assistive-technology labels and announcements, reduced motion, and responsive layouts. Accessibility must hold for both the table and canvas projections of the design model.
