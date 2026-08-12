# loom-plugin-template

A starting point for a third-party [Loom](https://github.com/chhetrisushil/loom) plugin. This
example implements a **store** backend and exports a `myStorage()` preset; the same shape works
for any seam (dispatcher, telemetry, renderer, LLM provider, learned policy, …).

## Use it

1. Copy this directory out, rename it `loom-plugin-<name>`, and set `name` in `package.json`.
2. Implement the SPI(s) in `src/index.ts` against your backend.
3. Prove conformance in `src/index.test.ts` with `@loom/conformance` — `loom plugin check`
   looks for exactly that import, so it is the one that makes your plugin checkable.
4. Publish. Keep the npm keyword `loom-plugin` for discoverability.

## Requirements

Depends on the `@loom/*` **SPI** packages — `@loom/event-runtime`, `@loom/snapshot-runtime`,
`@loom/plugin-kit` (the `CustomStorage` contract), and `@loom/conformance` for the test kit.

Those are **not published to npm yet**. Inside this repo they resolve through the root
`pnpm.overrides`, which `link:` them from a sibling `../loom` checkout — so clone loom next to
this repo and `pnpm build` it once, then `pnpm install` here. When you copy this template out,
either publish/vendor the SPI packages or carry the same `link:` overrides into your own
`package.json`.

## The rule of thumb

Contribute only to **existing seams**. Never add a kernel hook, never inject a reducer into the
replay fold. If you need durable custom facts, emit ordinary app events and fold them in a
user-space projection. See the
[plugin docs](https://github.com/chhetrisushil/loom/blob/main/docs/plugins.md).
