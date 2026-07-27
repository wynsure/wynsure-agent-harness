# Tutorial — build your first agent

In this tutorial you will build **Pantri**, a friendly cooking companion that
turns whatever is in your fridge into a step-by-step meal. It is small enough
to read in one sitting, but exercises every idea that matters: a model, an
agent, two postures with a transition between them, a volatile memory, a
guardrail, and a hook. We will introspect it with the CLI, then drive it from
the HTTP webapp.

> The field-by-field schema for every resource used below lives in
> [`resources.md`](./resources.md). For the conceptual model behind these
> pieces, read [`concepts.md`](./concepts.md) first.

## Prerequisites

The harness resolves the completion provider from environment variables, so a
single `.env` file in your project root wires the "brain". Create one and put
your OpenAI settings in it (the same keys work for any OpenAI-compatible
endpoint):

```bash
# .env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# OPENAI_BASE_URL=   # only if you point at a compatible gateway
```

The CLI auto-discovers any file matching `*.blueprint.yaml` up to three
directory levels deep (skipping `node_modules`, `.git`, `dist`). When you run a
command without a path, it offers an interactive picker of those files.

## Step 1 — a model and an agent that can say hello

Create `pantri.blueprint.yaml` with three resources: a model, an interaction
surface, and the agent. The model has an empty `spec` because every field falls
back to the `OPENAI_*` environment variables. The `InteractSurface` resource is
shipped by the harness and publishes the `interact__*` tools (ask, confirm, todo,
notify, message); the agent references it via `tools: user/*` so it can talk to
a human.

```yaml
apiVersion: agent/v1
kind: OpenAIModel
metadata: { name: model-default }
spec: {}
---
apiVersion: agent/v1
kind: InteractSurface
metadata: { name: user }
spec: {}
---
apiVersion: agent/v1
kind: Agent
metadata: { name: pantri_chef }
spec:
  model: model-default
  tooling:
    - type: toolset
      tools: user/*
  hooks:
    on_completion:
      - type: tooluse
        tool: interact__prompt
  initial_posture: greet
  instruction:
    content: |
      You are Pantri, a warm and practical cooking companion.
      You help people turn what they already have into a tasty meal,
      keeping instructions short and encouraging.
```

Before running anything, validate it:

```bash
agent-blueprint check pantri.blueprint.yaml
```

`check` parses the file, validates every manifest against its schema, checks
that instruction `$ref` files exist, and prints an inventory of the resources,
the labels, the hooks, the guardrails and the tooling. It also lists the
harness catalogue (the built-in presets and tools you are allowed to reference).
You should see the agent, its `initial_posture=greet`, and an `all good`
summary.

Now drive it on the web with the studio command. Note that the `greet` posture
does not exist yet — we will add it next; for this first run, omit
`initial_posture` if you want to see the agent talk without any posture.

```bash
agent-blueprint studio --port 3000
```

Open `http://localhost:3000`, start a session on Pantri, and type "hi" —
Pantri replies using the model.

## Step 2 — two postures and a transition between them

Behavior that changes shape over a conversation lives in **postures**. Let us
give Pantri two: `greet` (introduce yourself and ask what is in the fridge) and
`plan_meal` (propose a recipe from those ingredients). They are connected by a
`route`, which exposes the transition to the model as a callable tool.

```yaml
apiVersion: agent/v1
kind: Posture
metadata: { name: greet }
spec:
  instruction:
    content: |
      Greet the cook, then ask what ingredients they have on hand.
      When they have answered, call the plan_meal tool to move on.
  tooling:
    - type: route
      name: plan_meal
      posture: plan_meal
      description: Move on to proposing a meal from the listed ingredients.
---
apiVersion: agent/v1
kind: Posture
metadata: { name: plan_meal }
spec:
  instruction:
    content: |
      Propose one simple recipe using the ingredients the cook mentioned.
      Keep it to a title, a short ingredient list, and numbered steps.
  tooling:
    - type: route
      name: plan_meal
      posture: greet
      description: Go back to gathering ingredients.
```

Re-run `check`. You will now see both postures, their inline instructions, and
each `→ route` entry with its target. The order of resources in the file does
not matter — references are resolved by name.

A note on transitions: the `plan_meal` route is declared **inside** each
posture's tooling. It is only visible to the model while that posture is active.
There is no way to jump to a posture by its bare name; the route is the door.

## Step 3 — give the model a memory

Let Pantri remember the ingredients across the conversation so it does not ask
twice. A `Memory` resource publishes `<name>__set` and `<name>__get` tools, but
— like every tool source — it is invisible until a `toolset` entry selects it.

```yaml
apiVersion: agent/v1
kind: Memory
metadata: { name: pantry }
spec: {}
---
apiVersion: agent/v1
kind: Posture
metadata: { name: plan_meal }
spec:
  instruction:
    content: |
      Propose one simple recipe using the ingredients the cook mentioned.
      Before suggesting a meal, call pantry__set to record the ingredients,
      then keep it to a title, a short ingredient list, and numbered steps.
  tooling:
    - type: route
      name: plan_meal
      posture: greet
      description: Go back to gathering ingredients.
    - type: toolset
      tools: pantry/*        # expose both pantry__set and pantry__get
```

The memory is **volatile and private to the context**: it lives for the
conversation, is never shared between sessions, and is never replayed from the
thread. It is the right place for scratch state the model manages itself.

## Step 4 — keep the model honest with a guardrail and a hook

Two declarative primitives add a control layer without a line of imperative
code.

A **guardrail** is an assertion evaluated before a tool call runs. Let us
require that the cook has recorded at least one ingredient before Pantri is
allowed to do anything beyond greeting — we read the memory through the
`memory.*` scope in the assertion expression.

A **hook** is an automation tied to a thread event. Let us nudge the cook every
time a tool errors, so a technical hiccup never looks like silence.

```yaml
apiVersion: agent/v1
kind: Posture
metadata: { name: plan_meal }
spec:
  instruction:
    content: |
      Propose one simple recipe using the ingredients the cook mentioned.
      Call pantry__set to record the ingredients before suggesting a meal.
  tooling:
    - type: route
      name: plan_meal
      posture: greet
    - type: toolset
      tools: pantry/*
  guardrails:
    - name: needs-ingredients
      appliesTo: "*"
      assertion: "!!memory.ingredients"
      message: "Cannot plan a meal yet — record the ingredients with pantry__set first."
---
apiVersion: agent/v1
kind: Agent
metadata: { name: pantri_chef }
spec:
  model: model-default
  tooling:
    - type: toolset
      tools: user/*
  initial_posture: greet
  instruction:
    content: |
      You are Pantri, a warm and practical cooking companion.
  hooks:
    on_tool_error:
      - type: tooluse
        tool: interact__notify
        args:
          message: "Small hiccup on my side — let me try another way."
          level: warn
```

Run `check` once more. The guardrail shows up under the posture as
`guardrails:plan_meal:needs-ingredients`, and the hook under the agent as
`hooks:pantri_chef:...`. Nothing executes yet — `check` only inspects. To run
it, launch the TUI again and watch the guardrail refuse any tool call in
`plan_meal` until the model has stored `ingredients`.

## Step 5 — serve it on the web

The same blueprint runs unchanged behind an HTTP server with a bundled webapp
dashboard.

```bash
agent-blueprint studio --port 3000
```

Open `http://localhost:3000`. The webapp discovers your `*.blueprint.yaml`
files, lets you start a session against Pantri, and shows the conversation, the
context inspector (posture, skills, fragments) and a single bottom input slot
for both chatting and steering. Because interactions delegate to the
`user-board` environment the host registers, the blueprint needs no changes.

## Step 6 — a closer look with deep introspection

The `--deep` flag goes one step further than `check`: it actually **loads** the
blueprint, which means it connects any `McpStdio` transports and lists the
exact tools they publish. If you later attach an MCP server (say, a recipe
database), deep-check is how you confirm its tool names before referencing them
in a `toolset`:

```bash
agent-blueprint check pantri.blueprint.yaml --deep
```

Pantri has no MCP server, so `--deep` simply confirms the load succeeds and
reports the resource count. Add a `kind: McpStdio` resource and you will see a
per-resource tool list printed under each connection.

## Where to go next

- The complete reference for every field of every kind: [`resources.md`](./resources.md).
- Generate that reference yourself at any time with `agent-blueprint docs`.
- The deeper specifications — activities, hooks & guardrails, the studio
  protocol — live under the repository `docs/` folder
  (`activities.spec.md`, `hooks-guardrails.spec.md`, `studio.spec.md`).
