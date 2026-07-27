# @kanop.ai/agent-blueprint-harness

A declarative runtime for LLM agents. Describe an agent — its model, persona,
states, tools and safety rules — in a single YAML **blueprint**, and the
harness turns it into inspectable, replayable behavior you can drive from an
HTTP server or a batch job without changing the file.

This package holds the runtime (blueprint loading, sessions, fragments,
activities).

## Install

```bash
npm install @kanop.ai/agent-blueprint-harness
```

The agent's "brain" is resolved from environment variables, so drop a `.env`
next to your blueprint:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# OPENAI_BASE_URL=   # any OpenAI-compatible endpoint
```

Blueprint files are any file matching `*.blueprint.yaml`.

## Documentation

- **[`docs/concepts.md`](./docs/concepts.md)** — the mental model: the
  declarative blueprint, the manifest→object lifecycle, how the tool surface is
  assembled, the run loop, and why the thread is the single source of truth.
- **[`docs/tutorial.md`](./docs/tutorial.md)** — build a cooking-companion
  agent step by step.
- **[`docs/resources.md`](./docs/resources.md)** — the exhaustive field
  reference for every resource kind.

Deeper design specifications (activities, hooks & guardrails) live under the repository root [`docs/`](../../docs/) folder.
