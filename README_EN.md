# @steycr/dsh-rewind

English | [简体中文](./README.md)

A DSH (DeepSeek Harness) conversation-rewind plugin. This fork targets DSH `0.2.0-rc.2` while preserving the edit-before-send and cancel-before-commit flow.

## Features

- Every user message row gains an **edit / rewind** action beside Copy. Clicking it:
  - **interrupts the current turn** if the model is still thinking/streaming;
  - keeps the selected message readable and **mutes the abandoned continuation** without removing it from layout;
  - pre-fills the composer with the message text — **unsent and editable**;
  - **re-attaches any images** from the original message through the official attachment intake;
  - on the next send, the model sees only the retained history plus your new message.
- While a rewind is pending:
  - a banner above the composer explains the state;
  - click ✕ or press `Esc` while the composer is focused to cancel;
  - cancel restores normal transcript styling, clears draft text and attachments, and sends nothing.
- Once sent, the old target and abandoned branch remain in the transcript as muted history, but never enter the model context again.
- Only user messages can be rewound; assistant messages have no rewind entry (the host validates the event type).

## Version compatibility

- **v2.4.1 fork targets DSH 0.2.0-rc.2**: client dependency ordering, module identity, and the rc.2 composer DOM selector are updated; the host APIs used by the rewind core remain present in rc.2.
- The current execution environment does not expose `node` or `dsh`, so this pass is source/API-level verification; an actual Desktop boot remains the final runtime check.
- **Upstream v2.4.0 is verified against dsh 0.1.5-rc.2** while keeping earlier 0.1.x hosts working.
- **v2.4.0 fixes "the model's output was not hidden"** (the main fix here):
  - **Cause**: the plugin shadows only the `user` / `steering` renderers of
    `conversation.chat.node`, so only those rows ever carried a `data-xsj-seq`
    stamp. The model's `assistant-step` output, tool calls and context rows
    render through the shipped renderer and were **never stamped**. The hiding
    pass treated an unstamped row as "no evidence" and therefore visible, so a
    committed range hid the prompt while the answer stayed on screen.
  - **Fix**: an unstamped row is no longer given up on. It inherits the verdict
    of the nearest stamped row **before** it, which is the turn it belongs to;
    only a leading run with no evidence at all falls back to the evidence that
    follows. The forward attribution matters: "hidden if anything later is
    hidden" sweeping in the answer *above* a range is a real regression that was
    hit during development and is now covered by `test/hiding.test.mjs`.
  - **Restore the DOM on driver teardown**: hiding writes to the live DOM, but
    teardown only cleared the timer and observer. Switching sessions or
    remounting the composer left the hidden rows for the next view (blank rows
    out of nowhere). Teardown now releases every row carrying this plugin's
    marker — and only those, leaving any other feature's `display` untouched.
  - **Tell "no data yet" apart from "no ranges"**: on a cold load the driver ran
    before `/state` answered, and the two were indistinguishable, so **every
    load flashed** the rewound tail back into view; if the read failed it stayed
    visible for good, leaving the UI showing messages the model cannot see.
    Sessions now track `fetched` / `fetchFailed`: while no answer has arrived the
    current verdicts are held and a retry is scheduled, and a locally recorded
    mark still applies immediately.
  - **Host: `agent/disposed` no longer strands the patch**: `ensurePatched`
    installs a `deriveMessages` override on the session instance closing over
    `st.ranges`, and disposal used to drop the state record outright, leaving
    that override with no record to unwind it — the session kept filtering its
    model context **permanently**, surviving a plugin reload. Disposal now
    follows the same rule as `evictIfNeeded`: unwind first, then drop.
  - **`ensurePatched` is self-healing**: it no longer trusts the `st.patched`
    flag alone but compares the installed method against the recorded wrapper
    and re-installs when they diverge (idempotent), so a flag that drifts out of
    sync cannot silently stop hiding the tail from the model.
  - **Image references cache hits only**: a reference, once in the append-only
    log, can never disappear, so a hit stays valid; a miss cannot, and caching
    one made `/image` answer 404 for an id the log does reference — surfaced as
    an image silently dropped on rewind.
- Changes in v2.3.0:
  - Rewind now **re-attaches images**: the host half exposes
    `/api/xsj-rewind/image` to read a message's durable image bytes by
    attachmentId, and the client rebuilds `File` objects and feeds them back
    through the composer's hidden file input, inheriting the shipped image
    count/size validation.
  - **Fixed a cascading render crash on image messages**: the client half of
    `@deepseek-ai/dsh-client-ui-attachment` exports only `apply`/`inject` in
    0.1.5-rc.2 (no `ImageGallery` component), so referencing it threw inside
    any image-bearing user row and the React error boundary widened the damage
    to the surrounding rows — the rewind button vanished across a whole span of
    messages. Images now render through the shipped `renderMessageImages` prop
    (routed to the `conversation.message.images` slot).
  - **Hardened slot registration**: the `slots` service is resolved
    defensively and each seat registers under its own `try/catch`. A single
    registration conflict (e.g. a client HMR rebuild race) previously aborted
    `apply()`, leaving the stylesheet injected with every renderer lost.
  - **Safer DOM hide driver**: an unstamped row no longer inherits a
    neighbour's hidden verdict, so a freshly sent message cannot be hidden
    while its view is still stamping. (**Corrected in v2.4.0**: that same
    conservatism made the model's output permanently un-hideable — see above.)
  - **Serialized image re-attachment** so concurrent rewinds cannot race on the
    same file input.
  - The host half resolves `attachments` at call time (`ctx.get`), so a missing
    attachment provider no longer blocks the mount; the image endpoint alone
    degrades to a 501.
  - Resource bounds: the per-session state table and the image-reference cache
    are capped, and image responses plus attachmentId length are validated.
- Changes in v2.2.0:
  - Adapted to 0.1.5-rc.2: `primitives.MessageText` was removed; the user
    bubble now renders text through the same `projectUserText()` helper the
    shipped bubble uses (reference/session chips included);
  - Client inject declaration updated: dropped the retired
    `@deepseek-ai/dsh-client-runtime`;
  - Dead code and debug scaffolding removed (debug log file, fuzzy session
    resolution, two unused code paths).
- Known symptoms of ≤2.1.2 on dsh 0.1.5-rc.2: user message rows crash while
  rendering, no rewind button — upgrade to ≥2.3.0.

## Security notes

- The four endpoints (`mark` / `cancel` / `state` / `image`) register on the dsh
  web server and therefore **follow dsh's own local-trust model**: `dsh web`
  listens on `127.0.0.1` by default, so they are reachable from this machine
  only and do not pass through dsh's API authentication layer. If you bind dsh
  web to a routable address (e.g. `0.0.0.0`), these endpoints become reachable
  too — restrict them at the network layer (firewall or an authenticating
  reverse proxy) in that case.
- The `/image` endpoint is scoped by the session log: it returns bytes only for
  attachments **that session actually references** (matched by attachmentId
  against the event stream). There is no path-based or arbitrary-id read. The
  bytes come from dsh's `attachments.readImage`, which verifies integrity.
- Limits: 64 KB request bodies, 256-character attachment ids, 64 MB per image
  response.
- The plugin collects and reports nothing; all state stays in the local session
  log.

## Log & recovery

- The session log (an append-only event stream) **never loses a message**.
- Every state change appends a `hook/invoked` event with payload
  `{ source: 'xsj.rewind', phase: 'mark' | 'cancel' | 'commit', targetSeq, hiddenFrom?, hiddenTo?, preview? }`.
  The type is a known-but-unused reserved entry in this build, so the records
  are reload-safe.
- After a process restart, opening a session replays these records to rebuild
  the model-excluded ranges; the client restores the corresponding muted
  abandoned-history presentation.
- The trajectory view does not render this reserved event type; audit the raw
  session JSONL log directly.

## Install

```powershell
# DSH Desktop 0.2.0-rc.2 from this checkout:
dsh plugin --profile desktop add D:\Dev\dsh-rewind

# Or install the GitHub main branch:
dsh plugin --profile desktop add github:steycr/dsh-rewind#main
```

Fully quit and reopen DSH Desktop after installation. For standalone Web, replace `desktop` with `web`.

## Uninstall

```powershell
dsh plugin --profile desktop remove @steycr/dsh-rewind
# restart DSH. Rewind records in session logs are harmless (hook/invoked is a
# known event type).
```

## How it works

- **Model-side truncation**: patches the live `Session` object's
  `deriveMessages()` to skip hidden surface ranges (memoized by a signature of
  surface size / range count / replace generation). The request builder, the
  `llm/stream` reconstruction invariant, and the image check all share this
  one method, so every reader stays consistent. No message event is ever
  added, removed, or rewritten.
- **Interrupt**: on mark, a running agent is cancelled with
  `agent.cancel({ kind: 'user' }, { keepInbox: true })`; queued messages
  survive and continue from the rewind point.
- **Commit point**: inside the `agent/pre-step` waterfall, the first step that
  claims a real input message seals the model-excluded range
  `[targetSeq, current log end]`; the new message is appended afterwards.
- **UI muting**: chat rows carry `data-chat-flow-key`; the client stamps user
  rows with seq values and marks abandoned history with
  `data-xsj-rewind-muted`. CSS changes opacity/pointer interaction only — it
  does not change row height, `scrollHeight`, or DOM order, so rewind
  presentation does not trigger DSH Chat's ResizeObserver/follow-tail policy.
  Pending rewind mutes only the continuation below the selected message;
  after commit the old selected message joins the muted excluded range.
  State-version updates apply in a layout effect without teardown/restore;
  a DOM observer only catches rows mounted later.
- **Rewind icon**: takes over the `user`/`steering` cells of
  `conversation.chat.node` at priority `-1` (the slot system's native
  shadowing), replicating the native bubble and adding the edit / rewind action.


## Porting

The plugin has no npm dependencies: the host half uses only Node builtins and
injected services; the client half pulls `react`,
`@deepseek-ai/dsh-client-ui-primitives`, and
`@deepseek-ai/dsh-client-ui-attachment` from the shell's frozen module table
via `window.__ModuleLoader__`. Clone this repo on any machine and follow
"Install".

## License

[MIT](./LICENSE)
