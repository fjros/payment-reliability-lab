# Primary references

Checked during bootstrap on 17 September 2026. Consult the actual versions selected during implementation. These links support design research, not a claim that the project already implements the referenced systems.

- [Role motivating the exercise](https://careers.ethena.fi/jobs/8157767-senior-staff-software-engineer-ethena-pay): context for the chosen reliability/API/testing/agent themes; not an internal architecture specification.
- [Claude Code project memory](https://code.claude.com/docs/en/memory): root CLAUDE.md and scoped instructions.
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices): verification criteria and iterative implementation.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp): current client configuration and connection behavior.
- [Claude Code skills](https://code.claude.com/docs/en/skills): reusable project skill structure and discovery.
- [MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture): host/client/server boundaries and capabilities.
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): select an actual compatible release; do not hand-roll the protocol.
- [Node.js release policy](https://nodejs.org/en/about/previous-releases): Node 24 baseline.
- [PostgreSQL numeric types](https://www.postgresql.org/docs/current/datatype-numeric.html): exact numeric representation and limits.
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html): concurrency and locking semantics.
- [Testcontainers Node usage](https://node.testcontainers.org/quickstart/usage/): real-dependency test lifecycle.
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests): an example of a provider-specific idempotency contract, not a promise to reproduce Stripe’s precise policy.
- [Stripe webhooks](https://docs.stripe.com/webhooks): duplicate delivery, ordering and signature considerations. The simulator has its own explicit contract.
- [AWS transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html): durable intent and the dual-write problem. v1 uses database-backed jobs; no separate broker is required.

Most detailed behavior in this repository is an original design proposal for this synthetic lab. Review it critically, preserve stated invariants, and record justified refinements rather than copying vendor examples wholesale.
