# @kanop.ai/agent-harness

A declarative runtime for LLM agents. Describe an agent — its model, persona,
states, tools and safety rules — in a single YAML **blueprint**, and the
harness turns it into inspectable, replayable behavior you can drive from an
HTTP server or a batch job without changing the file.

This package holds the runtime (blueprint loading, sessions, fragments,
activities). The companion CLI lives in
[`@kanop.ai/agent-blueprint-cli`](../agent-blueprint-cli).

## Install

```bash
npm install @kanop.ai/agent-harness @kanop.ai/agent-blueprint-cli
```

The agent's "brain" is resolved from environment variables, so drop a `.env`
next to your blueprint:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# OPENAI_BASE_URL=   # any OpenAI-compatible endpoint
```

Blueprint files are any file matching `*.blueprint.yaml`. The CLI discovers
them up to three directory levels deep (skipping `node_modules`, `.git`,
`dist`); when a command takes no path, it offers an interactive picker.

## Introspect a blueprint

The fastest way to understand a blueprint is to `check` it. `check` parses the
file, validates every resource against its schema, verifies instruction
references, and prints an inventory: resources, labels, tooling entries, hooks,
guardrails.

```bash
# light inspection (no network, no MCP connections)
agent-blueprint check path/to/my.blueprint.yaml

# deep inspection — instantiates the blueprint's resources (like a session
# would), connects McpStdio transports and lists the exact tools each one
# publishes
agent-blueprint check path/to/my.blueprint.yaml --deep
```

`--deep` (alias `-d`) is how you confirm the real tool names an MCP server
publishes before referencing them in a `toolset` entry.

## Run a blueprint

```bash
# HTTP API + bundled webapp dashboard
agent-blueprint studio --port 3000
```

## Commands at a glance

| Command | Purpose |
|---|---|
| `agent-blueprint check [blueprint] [--deep/-d]` | Validate and inspect a blueprint (schema, refs, tooling, hooks, guardrails). |
| `agent-blueprint studio [--port/-p] [--host] [--webapp]` | Serve the HTTP API and webapp dashboard. |
| `agent-blueprint docs [--output/-o FILE]` | Generate the Markdown reference of every registered resource kind. |

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | `OpenAIModel` | API key (falls back from `spec.apiKey`). |
| `OPENAI_MODEL` | `OpenAIModel` | Model name (falls back from `spec.model`). |
| `OPENAI_BASE_URL` | `OpenAIModel` | Endpoint (falls back from `spec.baseURL`). |
| `OPENAI_REASONING_EFFORT` | `OpenAIModel` | Reasoning effort `none\|minimal\|low\|medium\|high\|xhigh\|max` (falls back from `spec.reasoningEffort`; unset = not sent). |
| `OLLAMA_BASE_URL` / `OLLAMA_API_KEY` | `OllamaModel` | Ollama daemon URL and optional bearer. |
| `AZURE_OPENAI_API_KEY` | `AzureFoundryModel` | Key for `auth: apiKey` mode. |
| `HARNESS_BLUEPRINT_DIRS` | discovery | `;`-separated roots to scan for blueprints (default: current directory). |
| `HARNESS_WEBAPP_DIST` | `studio` | Override path to the webapp `dist` folder. |
| `PORT` / `HOST` | `studio` | Listen port / interface (default `3000` / `localhost`). |

## Documentation

- **[`docs/concepts.md`](./docs/concepts.md)** — the mental model: the
  declarative blueprint, the manifest→object lifecycle, how the tool surface is
  assembled, the run loop, and why the thread is the single source of truth.
- **[`docs/tutorial.md`](./docs/tutorial.md)** — build a cooking-companion
  agent step by step and introspect/run it with the CLI.
- **[`docs/resources.md`](./docs/resources.md)** — the exhaustive field
  reference for every resource kind (also reproducible via
  `agent-blueprint docs`).
- **[`docs/architecture.spec.md`](./docs/architecture.spec.md)** — the deeper
  specification: layers, the manifest→object cycle, the activity model,
  serialization.
