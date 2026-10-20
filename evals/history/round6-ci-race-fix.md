# Round 6: load a blank page before signing in again (50 x 12)

The CI race was gone. One Directory password change was lost: a "What's new" popup swallowed the "Save password" click, and the engine did not repeat clicks that save a change yet (fixed in round 7).

**599/600 runs passed (99.8%)**, graded against each mock app's database. Silent failures (engine said success, database disagreed): **0**.

Machine: Apple M5 × 10, 32 GB RAM, darwin 25.6.0 (arm64); Node v26.0.0, Playwright 1.56.1 (Chromium 141.0.7390.37). 50 runs per workflow, concurrency 3, seed 1, wall time 14 min. Generated 2026-10-20.

| App | Runs | Passed | Success | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| hr | 200 | 200 | 100.0% | 0.9 s | 1.5 s |
| helpdesk | 200 | 200 | 100.0% | 7.5 s | 23.3 s |
| directory | 200 | 199 | 99.5% | 1.3 s | 2.4 s |

| Workflow | Runs | Success | p50 | p95 |
|---|---:|---:|---:|---:|
| directory.create_user | 50 | 100.0% | 1.4 s | 2.2 s |
| directory.remove_user | 50 | 100.0% | 1.7 s | 4.0 s |
| directory.rotate_password | 50 | 98.0% | 1.3 s | 2.2 s |
| directory.sign_in | 50 | 100.0% | 1.0 s | 1.1 s |
| helpdesk.create_user | 50 | 100.0% | 15.7 s | 26.5 s |
| helpdesk.remove_user | 50 | 100.0% | 10.5 s | 27.3 s |
| helpdesk.rotate_password | 50 | 100.0% | 5.4 s | 10.2 s |
| helpdesk.sign_in | 50 | 100.0% | 3.9 s | 8.1 s |
| hr.create_user | 50 | 100.0% | 1.0 s | 1.5 s |
| hr.remove_user | 50 | 100.0% | 1.0 s | 1.6 s |
| hr.rotate_password | 50 | 100.0% | 0.8 s | 1.4 s |
| hr.sign_in | 50 | 100.0% | 0.5 s | 0.8 s |

| Kind of mess (runs where it was in play) | Runs | Success |
|---|---:|---:|
| Field ids/classes change every load | 535 | 99.8% |
| Login form inside an iframe | 400 | 99.8% |
| TOTP second step | 400 | 99.8% |
| Consent overlay blocking clicks (appeared) | 165 | 100.0% |
| Slow single-page app (150 ms – 4.5 s per call) | 200 | 100.0% |
| Session expired mid-task (fired) | 109 | 100.0% |
| Target beyond page 1 of the list | 177 | 100.0% |
| Confirm modal before removal | 127 | 100.0% |
| "What's new" popup (appeared) | 24 | 95.8% |
| A/B copy test renamed the action buttons | 132 | 100.0% |
| Survey popup with no dedicated handler (appeared) | 14 | 100.0% |

| Most common failure reasons | Count | Where | Example |
|---|---:|---|---|
| `assertion_failed` | 1 | directory.rotate_password | steps[5]: expected role=status with "Password changed"; saw no role=status |

Locator: 7537 element resolutions; winning strategy share: role 57.9%, label 23.3%, text 11.1%, placeholder 6.0%, css 1.2%, testId 0.5%. 582 resolutions needed a fallback strategy (in 283 runs). Interstitials handled: unknown_popup 3, session_expired 108, cookie_banner 137, announcement 6. Runs with a forced re-login: 108. Runs that repeated a swallowed click: 1.
