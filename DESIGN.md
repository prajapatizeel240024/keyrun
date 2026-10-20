# Keyrun design notes

The main decisions, why I made them, what the evals caught, and what I'd change before this touched a real customer.

## The shape of it

There are three places code runs, and they trust each other differently.

- **The device** (the user's laptop) is trusted. It holds the X25519 private key, decrypts credentials, runs the browser, and keeps a journal of what it has done.
- **The control plane** is *not* trusted with secrets. It queues tasks, stores workflows, enforces policies and shows history. It stores ciphertext, public keys and non-secret params. If someone dumps its database, they get no passwords.
- **The target apps** are whatever the user signs into. Here, three mock portals whose databases double as the eval's answer key.

Most of the decisions below follow from one question: *what can a compromised or buggy server make the device do?*

## Decisions

### Workflows are data, not code

A workflow is JSON (validated with zod): a `login` block and a `steps` block made of `navigate`, `fill`, `click`, `select`, `check`, `press`, `wait`, `assert`, plus three control steps: `findInPages` (walk a paginated list looking for a row), `if`, and `end` (finish early with "succeeded" or "no change needed").

Data rather than code because the recorder has to write it, a non-coder has to edit it, the server has to store and version it, and the device has to run it without running arbitrary code from the server. Secrets show up only as placeholders (`{{secrets.password}}`, `{{totp}}`); params (`{{params.email}}`) are the only values the server sends.

### Finding elements

Each target lists several strategies and the engine always tries them in the same order: **role → label → placeholder → text → test id → CSS**. A strategy wins only if it matches **exactly one visible** element. If every strategy matches several, the step fails with `ambiguous_element` instead of guessing; clicking "the first Remove button" is how you delete the wrong user. Containers (`within: the row that has this email`, `within: the dialog named "Remove…"`) narrow things down.

A step retries resolve + act together with exponential backoff (150 ms doubling to a 2 s cap, with jitter) until its timeout (15 s by default), clearing interstitials between attempts. Each attempt has a short action timeout (2.5 s) so a click blocked by an overlay fails fast and gets retried after the overlay is dealt with, rather than hanging.

The eval records which strategy won every resolution. Role wins most of the time; the CSS and test-id fallbacks are what kept runs alive when an A/B test renamed the buttons.

### Interstitials, checkpoints and "effect" steps

Known interstitials are a small registry: session expired, consent wall, "What's new" popup, and (after the eval showed I needed one) an unknown-popup fallback that only presses non-committal buttons like "No thanks" or "Close", and only after an action has already failed. The registry is checked before every step and between retries.

"Session expired" is the interesting one. The engine re-runs the `login` block and resumes at the last step marked `checkpoint` (usually "go to the people list"), because whatever page you were on is gone. That re-check is safe because the lifecycle workflows start by checking state. But it creates a subtle problem: if the session dies just *after* the "Create" click, the resumed run finds the user and would report "no change needed" even though this run created them. Steps that commit a change are marked `effect: true`, and a no-op after an effect is reported as success.

### Exactly-once effects on top of at-least-once delivery

Delivery is at least once on purpose; exactly-once delivery isn't something you get across a network and a sleeping laptop. Instead there are four layers that each catch a different failure:

1. **Idempotency key on enqueue.** Queuing the same request twice returns the original task. Reusing a key for a *different* request is a 409, not a silent merge.
2. **Fenced leases.** Every claim gets a new `lease_id`. Heartbeats and results must carry it, so a device that wakes up after its lease was handed to someone else can't overwrite the result (`stale_report_rejected` shows up in the history).
3. **The device journal.** Before acting, the agent appends `started` (fsync'd); after, `done` with the result. If a task comes back and the journal says `done`, the agent re-reports the stored result without opening a browser.
4. **Workflows that check before acting.** If the journal only says `started` (the device died mid-run, or another device has the task), the workflow looks first: create only if missing, remove only if present.

Password rotation is the hard case: the new password exists only on the device, and dying between "the app accepted it" and "the vault stored it" would lose it. So the new password is sealed to the device's own key and written to the journal *before* the browser touches the app. On a retry, the agent first tries to sign in with the pending password; if that works, the rotation already happened and it just stores the new credential version. `test/agent.test.ts` kills the agent at exactly that moment and checks that the app saw exactly one password change and the vault ends up with the password the app accepts.

### The queue lives in Postgres

`SELECT … FOR UPDATE SKIP LOCKED` on a `tasks` table, with an `events` table for history. It's boring and it's enough: one fewer moving part, transactional with the rest of the state, and easy to inspect. Claims only consider apps whose allowed-hours window is open and tasks whose credential is sealed to the claiming device. Failed attempts that look transient are requeued with backoff (5 s, 10 s, …); a task whose lease keeps expiring is marked `dead` after `max_attempts` instead of looping forever. A device that sees the window is closed (by its own clock) gives the lease back without burning an attempt.

### Credentials: what the server can and can't do

Each credential is JSON (`username`, `password`, optional TOTP seed, and the origins it may be used on) encrypted with XChaCha20-Poly1305 under a fresh random data key. That data key is sealed (`crypto_box_seal`) to each device's X25519 public key. The server gets the ciphertext, the nonce and the sealed keys.

| A server that is compromised or buggy could… | …and here's what stops it |
|---|---|
| Read passwords from its database | It only has ciphertext. The no-plaintext test scans every row of every table for every secret in six encodings |
| Swap two credentials' ciphertexts, or serve an old version | The AAD binds ciphertext to credential id, app and version, so decryption fails instead of typing the wrong password |
| Repoint an app at a phishing page | The allowed origins live *inside* the encrypted credential, written by the device. The agent refuses to run if the app URL isn't on them, and the engine refuses to type a secret into any frame whose origin isn't |
| Ask for a secret as a task param | The server rejects params that look like secrets (`password`, `token`, `otp`, …) |
| Learn secrets from failure reports | Only a reason code and a short detail leave the device, and the agent scrubs known secret values from both. Screenshots and traces stay on the device |
| Overwrite a credential | Updates are compare-and-swap on the version, and only a device that holds the credential can write one |

### Keeping secrets out of traces

"Save a trace on every failure" and "never leak a secret" pull against each other. Playwright traces record the arguments of every call (including the text you `fill`), DOM snapshots with input values (password fields too), and network bodies (a login POST).

So the trace is recorded in parts. Tracing stops completely before any step that types a secret, and starts again only when no input on the page still holds a secret value and every request sent while it was stopped has finished. My first version used Playwright's trace *chunks* for this; the trace test unzipped a failure trace and found the password in `trace.network`, because network recording keeps going between chunks. Full stop/start fixed it. The cost is gaps in the trace around the sign-in steps, which I think is the right trade.

### Policies

Per app: an allowed-hours window (in the app's own time zone, overnight windows allowed, optional weekdays) and a list of task kinds that need approval. Approval is four-eyes: the requester can't approve their own task. The window is enforced when tasks are handed out *and* again on the device, so a server that ignores it still can't make the agent act out of hours.

### Evals

- **The answer key is the app's database.** The engine's own claim of success is never trusted. A run where the engine says "succeeded" but the database disagrees is a *silent failure*, counted separately because it's the worst kind.
- **Mess is sampled per run from a seed.** Reruns see the same scenarios, so a change in the numbers means a change in the code (or real timing), not a different dice roll.
- **Mess is counted only when it happened.** A consent wall with a 2 s delay doesn't count if the run finished in 1.5 s; the mock apps report when client-side mess actually appears.
- **The gate is strict.** Any drop in any rate fails the build (`--tolerance` exists if you need it). Every "flaky" failure I hit while building this turned out to be a real race worth fixing, so I'd rather be told.

## What the evals caught

| Round | Change | Result (10 runs × 12 workflows) |
|---|---|---|
| 0 | Engine v1 against the original mess | 72/72 on a 6-run smoke test. Too easy, so I added two kinds of mess the engine wasn't designed for: A/B-tested button labels and a surprise survey popup |
| 1 | Same engine, harder mess | **100/120 (83.3%)**. 18 × `element_not_found`: HR and Helpdesk workflows only knew the button by its label. 2 × `action_failed`: the survey sat on top of the button. Directory survived the label change because its workflows had test-id fallbacks |
| 2 | CSS fallbacks on the commit buttons, and the unknown-popup handler | **118/120 (98.3%)**. Two Directory sign-ins failed with "That code is not valid". The trace showed two separate loads of the OTP page with empty boxes. The likely story: under load, Playwright's wait for the navigation a click starts timed out *after* the click had happened, my retry clicked "Next" again, the second form post replaced the OTP page, and the code went into a page that no longer existed |
| 3 | Clicks no longer wait on navigations they start (`noWaitAfter`); code boxes get focused directly instead of clicked, and typing is checked | **120/120** |
| 4 | First full run, 50 × 12 | **599/600 (99.8%)**. One Directory removal never got past sign-in. The screenshot shows the username and password still filled in and "Next" never pressed, and the run had dismissed a consent wall: the wall appeared at the exact moment of the click and swallowed it, while Playwright reported the click as done |
| 5 | Swallowed-click recovery: if the step after a plain click can't find its target for 3 s, the clicked element is still there, and the page made no request since the click, click it once more. Not for `effect` steps; round 7 added a stricter rule for those | **600/600**, no silent failures. Two runs needed the repeated click. These were the numbers in the README until round 6 |
| 6 | Load a blank page before signing in again. GitHub CI ran round 5's code and lost one Helpdesk removal: after the session expired and the agent signed in again, a request from the old session came back late saying "not signed in", and the app jumped to its login page. The old page was still open because the login URL only differed after the `#` | A stress test of that run failed 3 times in 45 before the fix and 0 times in 90 after. Full run on an Apple M5 laptop: **599/600**, no silent failures. The one failure is a different problem: a "What's new" popup swallowed the "Save password" click, and back then the engine never repeated a click that saves a change (see round 7) |
| 7 | Repeat a swallowed click that saves a change once, but only with proof the first press never reached the app: the next step's target never appeared, the button is still there and enabled, nothing went out since the click (no page load, XHR/fetch, WebSocket message or EventSource; beacons don't count), and a popup had to be dismissed after it. Round 6 lost a Directory password change this way: a "What's new" popup showed up 65 ms after the page loaded and swallowed "Save password" | Replaying that run 300 times: 300 passed (before the fix it failed about once in 150). Full run on the Apple M5 laptop: **600/600**, no silent failures. These are the numbers in the README |

The reports for rounds 1 to 6 are in [`evals/history/`](evals/history/). The latest run's report and per-run records (seed, mess in play, outcome, duration, strategy wins) are in `evals/results/`.

That double submit in round 2 is the bug I'm happiest the eval found. Against an app that allows duplicates (Mock HR does, on purpose), the same race would have created a user twice and the answer key would have flagged a silent failure. It's also why the round 5 fix is so careful about *when* it repeats a click.

Two more bugs were caught by tests rather than the eval:

- The trace test found the password in `trace.network` (the chunk leak described above).
- The recorder test was flaky: about one run in six, a replayed recording "succeeded" but the user was still there. A recorded workflow ends on its last click, and the engine closed the browser while that click's form post was still in flight. Now every run waits for in-flight page loads and API calls to finish before it reports anything, and the recorder marks the last click as the `effect`. I'd still tell anyone recording a workflow to add an `assert` at the end; the editor says so.

## What I'd change in production

**A real client, not a folder on disk.**
- Ship the agent as a browser extension plus a small native host, or as an Electron app. The extension version can run inside the user's real browser profile, which matters for "sign the user in": the end state is a session in *their* browser, not in a headless one. The native host holds keys and talks to the OS.
- Keep the device private key in the OS keychain, TPM or Secure Enclave, non-exportable where possible, instead of a 0600 file.
- Move secret handling out of JavaScript strings, which can't be wiped from memory. libsodium buffers are zeroed here; the strings handed to Playwright are not.

**Device attestation.**
- Today a device is enrolled by anyone with the admin token. In production, enrollment should go through the user's SSO session plus platform attestation (TPM key attestation on Windows, Secure Enclave / App Attest on Apple, Play Integrity / key attestation on Android), so the server knows the key really lives in hardware on a managed device. Tie it to MDM where the customer has one.
- Short-lived device tokens with refresh, or mTLS with the attested key, instead of a long-lived bearer token.

**Key management and rotation.**
- *Device keys*: rotate on a schedule and on demand. A new device key means re-sealing every data key it holds (cheap: 80 bytes per credential), done on the device.
- *Revocation*: deleting a lost device's sealed keys stops future access, but it may already hold plaintext it decrypted. So revocation should also queue password rotations for every credential that device could read. The rotation flow already exists for exactly this.
- *Data keys*: already fresh per credential version. Add a key-version field to the AAD so the envelope format itself can change later.
- *Recovery*: if the only device is lost, the credentials are gone. That's correct for E2E, but customers will want an org recovery key or threshold escrow (say, 2 of 3 admins). That's a product decision as much as a crypto one.
- *Public-key trust*: when a device shares a credential with another device, it trusts the server to return the right public key. A malicious server could hand back its own. Fix with key transparency (an append-only log of device keys that clients audit) or out-of-band fingerprint checks for sensitive orgs.

**Don't trust workflows from the server blindly either.** Origin binding stops the worst case, but a compromised server could still push a workflow that clicks "Delete all users" inside the right app. Workflows should be signed by an org admin key and verified on the device, and approvals should cover the exact workflow version that will run.

**The rest of the server.** SSO for the dashboard, roles beyond "admin", per-tenant isolation (Postgres row-level security), audit-log export, rate limits, and push (websocket or `LISTEN/NOTIFY`) instead of the agent polling every 1.5 s.

**The engine.** Adaptive per-app timeouts learned from eval p95s; nested iframes and shadow DOM (the engine handles one iframe level); a "hand it back to the human" path for CAPTCHAs and unknown 2FA prompts; and selector repair suggestions (possibly model-assisted) that a person approves, rather than the agent silently changing what it clicks.

**Evals.** A nightly run with more seeds and real-world latency profiles, flake quarantine with an owner, and a confidence-interval-based gate once the suite is big enough that strict comparison gets noisy.

## If I'd been short on time

In order, what I'd cut first: the Chrome extension (the CLI recorder covers the same ground), the web editor's form view (keep the JSON view and validation), the TOTP replay protection and six-box code input in the mocks, and the per-mess "did it actually appear" beacons (count configured mess instead, and say so). I would not cut the answer-key grading, the journal, or the no-plaintext test; they're the point.

## Known gaps

- One level of iframe. Shadow DOM isn't handled beyond what Playwright's role and text selectors pierce for free.
- The engine trusts the app's own success message plus the eval's database check. In production you'd want a post-condition per workflow that re-reads state from the app (for example, search for the user after creating them) instead of trusting a toast.
- Multi-device sharing works at the crypto level (`resealForDevice`, tested) but there's no UI or agent command for it yet. Rotations re-seal to the rotating device only.
- The demo enrolls devices with the admin token. See attestation above.
- Repeating a swallowed click that saves a change relies on seeing that nothing was sent. Playwright can't see traffic that a service worker or a shared worker sends for the page, so an app that saves that way could, in a rare race, get the same change twice.
