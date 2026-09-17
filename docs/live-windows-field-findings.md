# Live Windows field findings

Date: 2026-09-16

These notes record failures observed during authenticated Windows use of Codex Web GPT/Bivium so they can be handled as separate engineering problems instead of collapsing into generic `stream disconnected` symptoms.

## 1. Bigger Context compaction stage rejected as too long

### Observed behavior

With **Bigger Context (experimental)** enabled, native compaction entered the staged transport path. The owned ChatGPT Temporary Chat visibly received a `<codex_multipart_stage>` payload beginning with the inert-context wrapper used by Bigger Context.

ChatGPT then rejected the staged message in the product UI with a localized equivalent of:

> The message you sent was too long; edit it and send it again.

The outer Codex surface subsequently reported:

```text
Error running remote compact task: stream disconnected before completion:
ChatGPT did not complete the context handoff. Retry the task.
```

### Important distinction

This is separate from the source-owner physical-settlement race addressed by PR #4. In this case the staged browser request itself is rejected before the expected multipart acknowledgement can be produced.

### Negative result from local experiment

A local experiment applied `CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET` (110k) to every fully formatted multipart stage and trimmed old history until all parts fit.

That approach is not correct as a general fix. The existing upstream contract intentionally permits Bigger Context compaction history above the retired inline 110k budget. The experimental patch caused `tests/prompt-contract.test.ts` to fail the contract `Bigger Context compaction preserves history above the retired inline byte budget`; after trimming, one stage still measured about 161k JSON bytes and the experiment failed closed.

### Current safe fallback

Disable **Bigger Context (experimental)**. With Automation + Full Harness/MCP otherwise unchanged, the same workflow proceeds through the ordinary compaction path without reproducing this specific product rejection.

### Future work

- Represent the live ChatGPT product-layer acceptance boundary for staged messages instead of assuming model token/composer estimates are sufficient.
- Repartition or adapt stages before submission when possible.
- Preserve the newest cumulative checkpoint and pending work if fallback trimming is required.
- Distinguish explicit ChatGPT `message too long` rejection from ACK timeout, browser disconnect, and source-settlement failures in diagnostics.
- Add authenticated Windows regression coverage in addition to structural/unit tests.

## 2. Browser operational viewport can be non-operational after acquisition

### Observed behavior

The launcher-owned browser surface could be acquired while its operational viewport was not yet restored, producing failures around browser readiness/recovery.

### Local validation

A local source hotfix sends a launcher `heartbeat` with `refreshViewport: true` before the initial operational-viewport validation and extends the viewport wait from 10s to 30s.

`typecheck` and `tests/browser-worker-contract.test.ts` passed after the change.

### Future work

- Keep viewport restoration observable and bounded.
- Prefer launcher-owned recovery over blind browser reconnect/retry.
- Preserve the no-duplicate-submit invariant when recovery occurs after a prompt has already been accepted.

Related work: PR #7 and PR #12.

## 3. Retained compaction must wait for physical source release

### Observed behavior

A logical browser turn can appear complete before the launcher has physically released its owner. Beginning retained compaction handoff too early can race the old surface.

### Local validation

The production change from PR #4 was cherry-picked locally: wait for `source.physicalSettlement` before opening the compaction transaction. Targeted physical-release, cancellation, deadline, and retained-handoff tests passed locally.

The full `retained-compaction.test.ts` suite also exposed a separate pre-existing Windows hang in one broker/named-pipe lifecycle test; that hang should not be treated as proof that the physical-settlement fix failed.

Related work: PR #4.

## 4. Runtime transactional replacement can hit Windows EPERM cleanup

### Observed behavior

After replacing the packaged source runtime with a locally built coherent `dist/runtime`, the launcher successfully adopted the new runtime, but Windows displayed an `EPERM Permission denied` error while cleaning a transactional directory named like:

```text
5.0.8-win32-x64.previous-<pid>-<timestamp>
```

The current destination runtime hashes already matched the new build.

Inspection showed runtime `bun.exe` processes were still alive. Killing an individual child was insufficient because the launcher respawned it. Exiting Codex Web GPT first, stopping launcher/runtime processes, then removing only the stale transactional `.previous-*` directory allowed a clean restart.

### Future work

- Make post-swap cleanup tolerant of still-closing Windows handles.
- Separate successful activation from best-effort cleanup so a cleanup failure does not imply the new runtime failed to install.
- Consider bounded retry/backoff or deferred cleanup after child-process settlement.

Related area: transactional setup/runtime lifecycle; compare with PR #10.

## 5. Some user-provided text appears to lose body semantics while the title remains recognized

### Observed behavior

During otherwise successful use with Bigger Context disabled, some user-provided text is not fully assimilated by the downstream model while the title/heading is still recognized. This is not yet isolated to one layer.

### Investigation plan

Capture the same turn at four boundaries:

1. Native Codex request as received by Bivium.
2. Parsed/normalized message structure before prompt compilation.
3. Final compiled browser prompt/context records.
4. Visible ChatGPT user message after browser submission.

The first boundary at which body content disappears or changes identifies whether this is:

- native request parsing/metadata,
- prompt compilation/history normalization,
- browser composer insertion,
- or model interpretation despite correct transport.

### Future work

- Add a deterministic regression fixture containing a title plus several body sections, punctuation, line breaks, and long pasted text.
- Assert exact semantic preservation through request parsing and prompt compilation.
- Add browser-level verification that the submitted composer content contains both title and body before send.
- Avoid treating this as a context-window problem until the loss boundary is measured.

Related work: PR #9 is relevant to large request-body handling, but this symptom has not yet been proven to originate there.

## Stable working baseline from this session

The configuration that remained usable after isolating the Bigger Context failure was:

- With Automation
- Full Harness/MCP unchanged
- Bigger Context (experimental): OFF
- Skills as files (experimental): OFF

This should be treated as the live reference configuration while the experimental staged-transport path is hardened.

## Engineering principle from the session

Do not group all of these under `stream disconnected` or generic handoff failure. At minimum, keep separate diagnostic classes for:

- browser/viewport readiness,
- post-submit observation recovery,
- source physical settlement,
- staged-message product rejection,
- checkpoint/ACK failure,
- runtime replacement cleanup,
- and prompt/body semantic preservation.
