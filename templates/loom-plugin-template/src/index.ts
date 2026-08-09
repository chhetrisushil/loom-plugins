// A third-party Loom store plugin. It implements the published SPIs
// (`EventStore` + `SnapshotStore`) and exports a **preset** returning the shape
// `defineConfig({ storage })` accepts — so an app wires it exactly like a
// first-party backend, with no privileged `kind:`.
//
// Replace the bodies below with your real backend. Keep the *shape*: a preset that
// constructs your stores and returns `{ kind: "custom", ... }`.

import type { EventStore } from "@loom/event-runtime";
import type { CustomStorage } from "@loom/plugin-kit";
import type { SnapshotStore } from "@loom/snapshot-runtime";

export interface MyStorageOptions {
  /** e.g. a connection string, a directory, an API token — whatever your backend needs. */
  url: string;
  /** Provision a branch registry for fork/branch (optional). */
  branching?: boolean;
}

/**
 * `defineConfig({ storage })` preset for your backend. Constructs the stores eagerly
 * (an app only imports this plugin when it wants this backend, so there is nothing to
 * lazy-load). Returns {@link CustomStorage} — the same descriptor every store plugin returns,
 * first- or third-party. Name the TYPE rather than re-declaring its shape inline: a copied
 * shape silently stops matching when the contract evolves, whereas the imported type turns
 * that into a compile error.
 */
export function myStorage(options: MyStorageOptions): CustomStorage {
  return {
    kind: "custom",
    eventStore: new MyEventStore(options.url),
    snapshotStore: new MySnapshotStore(options.url),
    // ...(options.branching === true && { branchRegistry: new MyBranchRegistry(options.url) }),
  };
}

// --- Implement the SPIs against your backend. Prove them with the conformance kit
// (see index.test.ts). These stubs exist only so the template type-checks. ---

export class MyEventStore implements EventStore {
  constructor(private readonly url: string) {}
  append(): Promise<void> {
    throw new Error(`not implemented (${this.url})`);
  }
  read(): Promise<never[]> {
    throw new Error("not implemented");
  }
  readFrom(): Promise<never[]> {
    throw new Error("not implemented");
  }
  subscribe(): Promise<() => void> {
    throw new Error("not implemented");
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class MySnapshotStore implements SnapshotStore {
  constructor(private readonly url: string) {}
  save(): Promise<void> {
    throw new Error(`not implemented (${this.url})`);
  }
  loadLatest(): Promise<null> {
    throw new Error("not implemented");
  }
  loadAt(): Promise<null> {
    throw new Error("not implemented");
  }
  loadLatestBefore(): Promise<null> {
    throw new Error("not implemented");
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
