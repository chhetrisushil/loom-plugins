# loom-plugin-template

A starting point for a third-party [Loom](https://github.com/chhetrisushil/loom) plugin. This
example implements a **store** backend and exports a `myStorage()` preset; the same shape works
for any seam (dispatcher, telemetry, renderer, LLM provider, …).

## Use it

1. Copy this directory out, rename it `loom-plugin-<name>`, and set `name` in `package.json`.
2. Implement the SPI(s) in `src/index.ts` against your backend.
3. Prove conformance in `src/index.test.ts` with `@loom/testing/conformance`.
4. Publish. Keep the npm keyword `loom-plugin` for discoverability.

## Requirements

Depends on the published `@loom/*` **SPI** packages (`@loom/event-runtime`,
`@loom/snapshot-runtime`, `@loom/testing`). Until those are available to you (published, or linked
from a local Loom checkout), the `@loom/*` imports won't resolve — that's expected for a template.

## The rule of thumb

Contribute only to **existing seams**. Never add a kernel hook, never inject a reducer into the
replay fold. If you need durable custom facts, emit ordinary app events and fold them in a
user-space projection. See the
[plugin docs](https://github.com/chhetrisushil/loom/blob/main/docs/plugins.md).
