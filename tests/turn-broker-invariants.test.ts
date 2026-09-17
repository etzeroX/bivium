import { describe, expect, test } from "bun:test";
import {
  assertTurnBrokerInvariant,
  type TurnBrokerInvariantSnapshot,
} from "../src/adapters/chatgpt-web/turn-broker";

function snapshot(
  overrides: Partial<TurnBrokerInvariantSnapshot> = {},
): TurnBrokerInvariantSnapshot {
  return {
    ownership: "pending",
    pendingRegistered: true,
    bindingRegistered: false,
    queuedCallIds: [],
    deliveredCallIds: [],
    invocationCallIds: [],
    activities: [],
    completedActivities: [],
    activityRevision: 0,
    compactionRequested: false,
    hasCompactionResult: false,
    completionCommitted: false,
    safe: undefined,
    ...overrides,
  };
}

describe("TurnBroker lifecycle invariants", () => {
  test("accepts prepared, retained, tool-use, tool-results, compaction, and completion states", () => {
    const states: TurnBrokerInvariantSnapshot[] = [
      snapshot(),
      snapshot({ ownership: "bound", pendingRegistered: false, bindingRegistered: true }),
      snapshot({
        ownership: "bound",
        pendingRegistered: false,
        bindingRegistered: true,
        queuedCallIds: ["queued"],
        invocationCallIds: ["queued"],
        activities: ["activity-a"],
        activityRevision: 1,
      }),
      snapshot({
        ownership: "bound",
        pendingRegistered: false,
        bindingRegistered: true,
        deliveredCallIds: ["delivered"],
        invocationCallIds: ["delivered"],
        completedActivities: ["activity-a"],
        activityRevision: 2,
      }),
      snapshot({
        ownership: "bound",
        pendingRegistered: false,
        bindingRegistered: true,
        deliveredCallIds: ["already-delivered"],
        invocationCallIds: ["already-delivered"],
        compactionRequested: true,
        hasCompactionResult: true,
      }),
      snapshot({
        ownership: "bound",
        pendingRegistered: false,
        bindingRegistered: true,
        completionCommitted: true,
        completionRevision: 4,
        activityRevision: 4,
      }),
    ];

    for (const state of states) expect(() => assertTurnBrokerInvariant(state)).not.toThrow();
  });

  test("requires exact pending or retained binding ownership", () => {
    expect(() => assertTurnBrokerInvariant(snapshot({ bindingRegistered: true })))
      .toThrow("pending channel is registered as bound");
    expect(() => assertTurnBrokerInvariant(snapshot({
      ownership: "bound",
      pendingRegistered: false,
      bindingRegistered: false,
    }))).toThrow("bound channel has no registered binding");
  });

  test("partitions every invocation into exactly one delivery state", () => {
    expect(() => assertTurnBrokerInvariant(snapshot({
      queuedCallIds: ["call"],
      deliveredCallIds: ["call"],
      invocationCallIds: ["call"],
    }))).toThrow("both queued and delivered");
    expect(() => assertTurnBrokerInvariant(snapshot({ invocationCallIds: ["orphan"] })))
      .toThrow("has no queued or delivered owner");
    expect(() => assertTurnBrokerInvariant(snapshot({ queuedCallIds: ["missing"] })))
      .toThrow("queued call has no pending invocation");
  });

  test("prevents completed activity resurrection and post-fence work", () => {
    expect(() => assertTurnBrokerInvariant(snapshot({
      activities: ["same"],
      completedActivities: ["same"],
      activityRevision: 2,
    }))).toThrow("both active and completed");
    expect(() => assertTurnBrokerInvariant(snapshot({
      activities: ["activity"],
      activityRevision: 0,
    }))).toThrow("activity revision trails");
    expect(() => assertTurnBrokerInvariant(snapshot({
      completionCommitted: true,
      completionRevision: 1,
      activityRevision: 1,
      activities: ["late"],
    }))).toThrow("completion has live work");
    expect(() => assertTurnBrokerInvariant(snapshot({
      completionCommitted: true,
      completionRevision: 1,
      activityRevision: 2,
    }))).toThrow("completion revision changed after commit");
  });

  test("requires compaction control and Zero Risk state transitions to be complete", () => {
    expect(() => assertTurnBrokerInvariant(snapshot({ compactionRequested: true })))
      .toThrow("compaction request has no control result");
    expect(() => assertTurnBrokerInvariant(snapshot({ hasCompactionResult: true })))
      .toThrow("compaction result exists before compaction");
    expect(() => assertTurnBrokerInvariant(snapshot({
      compactionRequested: true,
      hasCompactionResult: true,
      queuedCallIds: ["late"],
      invocationCallIds: ["late"],
    }))).toThrow("compaction retains queued calls");
    expect(() => assertTurnBrokerInvariant(snapshot({
      safe: {
        state: "awaiting_start",
        launcherSent: true,
        connectorStarted: true,
        hasFinalAnswer: false,
      },
    }))).toThrow("awaiting Zero Risk turn is fully authorized");
    expect(() => assertTurnBrokerInvariant(snapshot({
      safe: {
        state: "completed",
        launcherSent: true,
        connectorStarted: true,
        hasFinalAnswer: false,
      },
    }))).toThrow("completed Zero Risk turn has no final answer");
  });
});
