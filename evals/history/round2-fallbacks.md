# Round 2: CSS fallbacks and the unknown-popup handler

Two Directory sign-ins still failed: a double form submit (fixed in round 3).

**118/120 runs passed (98.3%)**, graded against each mock app's database. Silent failures (engine said success, database disagreed): **0**.

Machine: Intel(R) Xeon(R) Processor @ 2.80GHz × 2, 8 GB RAM, linux 6.18.44-fc-v139 (x64); Node v22.22.0, Playwright 1.56.1 (Chromium 141.0.7390.37). 10 runs per workflow, concurrency 3, seed 1, wall time 4 min. Generated 2026-10-19.

| App | Runs | Passed | Success | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| hr | 40 | 40 | 100.0% | 2.0 s | 3.8 s |
| directory | 40 | 38 | 95.0% | 3.4 s | 16.3 s |
| helpdesk | 40 | 40 | 100.0% | 7.5 s | 24.1 s |

| Workflow | Runs | Success | p50 | p95 |
|---|---:|---:|---:|---:|
| directory.create_user | 10 | 100.0% | 4.2 s | 7.2 s |
| directory.remove_user | 10 | 100.0% | 3.7 s | 9.1 s |
| directory.rotate_password | 10 | 80.0% | 3.5 s | 16.8 s |
| directory.sign_in | 10 | 100.0% | 1.6 s | 5.1 s |
| helpdesk.create_user | 10 | 100.0% | 13.3 s | 24.7 s |
| helpdesk.remove_user | 10 | 100.0% | 11.6 s | 18.4 s |
| helpdesk.rotate_password | 10 | 100.0% | 4.3 s | 8.6 s |
| helpdesk.sign_in | 10 | 100.0% | 5.0 s | 8.2 s |
| hr.create_user | 10 | 100.0% | 2.8 s | 4.3 s |
| hr.remove_user | 10 | 100.0% | 2.7 s | 3.8 s |
| hr.rotate_password | 10 | 100.0% | 1.9 s | 3.4 s |
| hr.sign_in | 10 | 100.0% | 0.7 s | 0.9 s |

| Kind of mess (runs where it was in play) | Runs | Success |
|---|---:|---:|
| Field ids/classes change every load | 106 | 99.1% |
| Login form inside an iframe | 80 | 97.5% |
| TOTP second step | 80 | 97.5% |
| Consent overlay blocking clicks (appeared) | 41 | 95.1% |
| Slow single-page app (150 ms – 4.5 s per call) | 40 | 100.0% |
| Session expired mid-task (fired) | 17 | 100.0% |
| Target beyond page 1 of the list | 36 | 100.0% |
| Confirm modal before removal | 24 | 100.0% |
| "What's new" popup (appeared) | 4 | 100.0% |
| A/B copy test renamed the action buttons | 29 | 93.1% |
| Survey popup with no dedicated handler (appeared) | 3 | 100.0% |

| Most common failure reasons | Count | Where | Example |
|---|---:|---|---|
| `element_not_found` | 2 | directory.rotate_password | login[6]: no match for role=link[Members] \| testId=nav-members |

Locator: 1448 element resolutions; winning strategy share: role 57.6%, label 23.0%, text 10.8%, placeholder 6.2%, css 1.9%, testId 0.6%. 126 resolutions needed a fallback strategy (in 63 runs). Interstitials handled: session_expired 17, cookie_banner 41, announcement 3, unknown_popup 2. Runs with a forced re-login: 17.
