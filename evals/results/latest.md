**600/600 runs passed (100.0%)**, graded against each mock app's database. Silent failures (engine said success, database disagreed): **0**.

Machine: Apple M5 × 10, 32 GB RAM, darwin 25.6.0 (arm64); Node v26.0.0, Playwright 1.56.1 (Chromium 141.0.7390.37). 50 runs per workflow, concurrency 3, seed 1, wall time 13 min. Generated 2026-10-20.

| App | Runs | Passed | Success | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| hr | 200 | 200 | 100.0% | 0.8 s | 1.3 s |
| helpdesk | 200 | 200 | 100.0% | 7.6 s | 22.9 s |
| directory | 200 | 200 | 100.0% | 1.3 s | 2.5 s |

| Workflow | Runs | Success | p50 | p95 |
|---|---:|---:|---:|---:|
| directory.create_user | 50 | 100.0% | 1.4 s | 2.6 s |
| directory.remove_user | 50 | 100.0% | 1.5 s | 2.4 s |
| directory.rotate_password | 50 | 100.0% | 1.3 s | 4.0 s |
| directory.sign_in | 50 | 100.0% | 1.0 s | 1.3 s |
| helpdesk.create_user | 50 | 100.0% | 15.0 s | 30.4 s |
| helpdesk.remove_user | 50 | 100.0% | 10.5 s | 25.2 s |
| helpdesk.rotate_password | 50 | 100.0% | 5.2 s | 9.0 s |
| helpdesk.sign_in | 50 | 100.0% | 3.5 s | 8.5 s |
| hr.create_user | 50 | 100.0% | 1.0 s | 1.4 s |
| hr.remove_user | 50 | 100.0% | 0.9 s | 1.3 s |
| hr.rotate_password | 50 | 100.0% | 0.8 s | 1.3 s |
| hr.sign_in | 50 | 100.0% | 0.5 s | 0.8 s |

| Kind of mess (runs where it was in play) | Runs | Success |
|---|---:|---:|
| Field ids/classes change every load | 535 | 100.0% |
| Login form inside an iframe | 400 | 100.0% |
| TOTP second step | 400 | 100.0% |
| Consent overlay blocking clicks (appeared) | 167 | 100.0% |
| Slow single-page app (150 ms – 4.5 s per call) | 200 | 100.0% |
| Session expired mid-task (fired) | 109 | 100.0% |
| Target beyond page 1 of the list | 177 | 100.0% |
| Confirm modal before removal | 127 | 100.0% |
| "What's new" popup (appeared) | 24 | 100.0% |
| A/B copy test renamed the action buttons | 132 | 100.0% |
| Survey popup with no dedicated handler (appeared) | 14 | 100.0% |

No failures in this run.

Locator: 7535 element resolutions; winning strategy share: role 57.8%, label 23.2%, text 11.1%, placeholder 6.0%, css 1.3%, testId 0.5%. 594 resolutions needed a fallback strategy (in 285 runs). Interstitials handled: announcement 6, session_expired 107, cookie_banner 137, unknown_popup 4. Runs with a forced re-login: 107. Runs that repeated a swallowed click: 0.
