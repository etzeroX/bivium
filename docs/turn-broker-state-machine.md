# TurnBroker state machine

TurnBroker is the capability and ownership boundary between one browser turn and its Codex Native
MCP work. The browser lifecycle, retained-conversation lifecycle, and broker lifecycle are related,
but they are not interchangeable: reconnecting an observer never creates a new broker token, and
replacing a browser turn must retire the old token before a replacement can own work.

The implementation remains event-driven rather than using one large state enum. The enforced
snapshot in `turn-broker.ts` formalizes the product states below and rejects combinations that no
valid transition can produce.

## States and transitions

| Product state | Broker representation | Allowed next transitions |
| --- | --- | --- |
| Prepared | Token is in `channels` and `pending`; no binding owns it | Sent/claimed, cancellation, replacement |
| Sent (Zero Risk) | `safe.awaiting_start`; launcher and connector authorization may arrive in either order | Running after both authorizations, cancellation |
| Retained | One stable `bindingId` owns the token; later claims reuse that binding | Tool use, compaction, completion, cancellation |
| Tool use queued | Invocation exists in `queuedCallIds` only | Delivered, compaction interception, cancellation |
| Tool use delivered | Invocation exists in `deliveredCallIds` only; reconnects receive the same call id | Tool result, compaction drain, cancellation |
| Tool result | Exact delivered invocation is removed and its waiting MCP call is resolved | More tool use, completion, compaction |
| Compacting | `compactionRequested` and its immutable control result exist; queued calls are resolved by that result | Delivered result drain, completion, replacement |
| Completion fenced | No activity lease or invocation exists at an observed `activityRevision` | Commit only if the revision is unchanged, otherwise retry the fence |
| Completed | Completion revision is committed, or Zero Risk has accepted its final answer | Retirement/replacement; no new claim or cleanup mutation |
| Cancelled/replaced | Token and binding are removed, waiters reject, and bounded tombstones identify stale handles | A replacement registers a new token; the retired token never reactivates |

Browser reattach is deliberately not a broker transition. It may resume observation only when the
conversation, logical response, and turn identities still match. It continues with the same token,
binding, delivered call ids, and completion fence. A mismatched identity takes the replacement path.

## Enforced ownership invariants

1. A live channel has exactly one ownership location: either the pending-token map or one exact
   token/binding pair. A retained claim is idempotent and never manufactures a second binding.
2. Every pending invocation has exactly one delivery owner: queued or delivered. The sets are
   disjoint, contain no duplicates, and contain no id without its invocation.
3. Only a delivered call can accept a tool result. Delivery remains at-least-once across owner
   reconnects until that exact result removes the invocation.
4. Active and completed activity ids are disjoint. Their revision is monotonic; a cleanup that beats
   an ambiguous claim leaves a tombstone so the delayed claim cannot resurrect work.
5. Completion commits only with no activities or invocations and an unchanged revision. After
   commit, delayed activity cleanup is acknowledged as retired and cannot mutate the fence.
6. Compaction always has a control result before it becomes observable and owns no queued calls.
   Already-delivered calls may drain, while later calls receive the same compaction control result.
7. A Zero Risk turn runs only after both local Sent confirmation and connector start. It completes
   only with a non-empty final answer and no live activity or invocation.
8. Cancellation and replacement delete live ownership before rejecting work. Tombstones are
   diagnostic only and cannot be reclaimed as capabilities.

These checks run after stable state mutations. They do not weaken existing nonce, environment,
binding, compaction, or completion checks; an impossible state fails closed with an invariant error.
