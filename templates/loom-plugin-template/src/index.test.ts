// Prove your store satisfies the SPI with the published conformance kit. This is
// what makes "plugin" a checkable category rather than a claim — run it in your CI.
//
// Uncomment once your MyEventStore / MySnapshotStore are implemented:
//
// import {
//   runEventStoreConformance,
//   runSnapshotStoreConformance,
// } from "@loom/conformance";
// import { MyEventStore, MySnapshotStore } from "./index";
//
// runEventStoreConformance(() => new MyEventStore(":memory:"));
// runSnapshotStoreConformance(() => new MySnapshotStore(":memory:"));

import { describe, expect, it } from "vitest";
import { myStorage } from "./index";

describe("myStorage preset", () => {
  it("returns a custom storage descriptor", () => {
    const s = myStorage({ url: ":memory:" });
    expect(s.kind).toBe("custom");
    expect(s.eventStore).toBeDefined();
    expect(s.snapshotStore).toBeDefined();
  });
});
