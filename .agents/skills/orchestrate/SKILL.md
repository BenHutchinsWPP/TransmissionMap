---
name: orchestrate
description: >
  Split a large, divisible task across fresh sub-agents: plan it, dispatch
  bounded work packets to cheap models in parallel waves, review the combined
  diff with a strong one. Use when the user says "orchestrate", "delegate
  this", "use subagents", "run these in parallel", "spread this across
  agents", or asks to resume an earlier orchestration. Do NOT use for small or
  tightly coupled tasks — delegation costs planning, packaging, and review
  time, and one agent finishing directly is usually cheaper.
---

# Orchestrate

Correctness first, cost second. Never trade a right answer for a cheap one.

## When not to orchestrate

If one agent can finish safely with less total work, say so and just do it.
Only override that when the user explicitly asked for orchestration.

## Model choice

- `haiku`: pattern-following single-file edits, searches, mechanical checks —
  tasks where the packet fully specifies the answer.
- `sonnet`: bounded multi-file implementation that requires reading and
  adapting code.
- Strongest available model: plan review and final review only.
- `Explore` agent: read-only fan-out searches.

The test is the packet: if executing it takes judgment, tier up. If a model
or the Agent tool is unavailable, do the role yourself with the same
contracts.

## 1. Preflight

Verify state before trusting it. If resuming, check the handoff's claims
against the actual files and test results — an interrupted worker may have
left work half-applied. Restate the target, acceptance criteria, and
non-goals.

## 2. Research

Delegate bounded discovery when it saves the planner's context. Prefer repo
docs, greppable anchors, and targeted excerpts over broad file reads. Research
returns facts with file references, open questions, and confidence — not
implementation.

## 3. Plan

Write the plan: acceptance criteria, files in scope, subtasks with
dependencies and write ownership, parallel waves, non-goals.

Size tasks against spawn overhead — every worker costs a cold start, a
packet, and return processing. One packet = one bounded outcome, roughly 1–3
files, a done-condition checkable by one command. Ten trivial tasks cost more
than three real ones; a packet that needs more than a screen of instructions
means split the task or tier up.

Then hand the plan to a fresh strong reviewer and ask it to *challenge* scope,
task boundaries, dependencies, and missing risks. Do not ask it to approve.

## 4. Dispatch

Workers inherit no conversation, but they do get the repo's CLAUDE.md — carry
only the task-relevant footguns into the packet, never a copy of the rules.
One complete packet per worker:

- objective and acceptance criteria
- scope as `file:line-range` and greppable anchors — pointers, not pasted
  file contents; the worker reads narrowly itself
- prior findings, footguns, invariants
- forbidden actions, spelled out: no refactoring adjacent code, no unrelated
  fixes, no files outside ownership, never commit or push
- required checks, with output pasted into the return — a summarized
  "passed" is worthless
- the return contract below

Write for a weak model: a packet is a work order — mechanical, exact files,
exact anchors, the expected shape of the change. If you can't write it that
concretely, the plan isn't done or the task belongs a tier up. Never send
your expected answer or a speculative diagnosis — you will get it parroted
back. A blocked or surprised worker stops and reports; it never improvises
past ambiguity.

Required return format:

```text
Task: T<n>
Status: done | blocked
Changed: <files or none>
Checks: <command + pasted output>
Result: <brief outcome>
Risks: <remaining concern or none>
```

## 5. Waves

Parallel only when tasks are read-only or write disjoint files. Shared files,
shared generated artifacts, mutable external state, or an unresolved design
decision all mean serial. If write sets can't be made disjoint, the Agent
tool's `isolation: "worktree"` is the escape hatch — but merging worktrees
isn't free, so prefer serial in the shared workspace.

Assign ownership before dispatch; a worker that finds unexpected edits in its
files stops and reports rather than overwriting. Dispatch a wave's workers in
one message (parallel Agent calls); they run in the background and notify on
completion — don't poll, and never fabricate a pending result.

Inspect the actual diff and check output after each wave; re-run the repo's
cheap gate once per wave, not per task. Never accept a "done" claim on its
own. A task the next wave depends on gets reviewed *before* dependents
dispatch — a bad foundation is the most expensive thing a cheap model can
produce. Re-plan when evidence invalidates an assumption — finishing a stale
plan is not progress.

## Failed workers

One corrected retry via SendMessage to the same agent — its context is
intact, so a correction costs a fraction of a cold respawn. If the retry
fails, escalate the task one tier (haiku → sonnet → do it yourself). Never
loop a failing cheap model; that is how orchestration ends up costing more
than direct work.

## 6. Verify and review

Run the repo's required checks plus focused checks for changed logic. Review
the *combined* diff, not isolated task outputs: confirm parallel work composes
and unrelated working-tree changes survived.

Give a fresh strong reviewer the goal, acceptance criteria, final diff, and
verification evidence. Findings ordered by severity with exact locations,
covering correctness, unmet or over-built requirements, security and
data-loss, integration, missing verification, and over-engineering. Fix
material findings, rerun affected checks, review again only if behavior
changed.

## 7. Handoff

Checkpoint with `/handoff` before dispatch and after each wave — it already
persists goal, decisions, pending work, constraints, and changed files. Put
the task table (IDs, states, ownership) in its pending-work field so a resume
can rebuild the waves. Summarize outcome, verification, and remaining risks
for the user.

## Recovery

A worker that times out stays unfinished until you inspect its files and
checks — decide from evidence, and never dispatch a second writer to the same
files while the first may still be live.
