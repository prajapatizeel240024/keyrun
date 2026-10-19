# Round 3: fallbacks, unknown-popup handler, no double submits

After adding CSS fallbacks, the unknown-popup handler, noWaitAfter clicks, and focus-then-type for code boxes.

**120/120 runs passed (100.0%)**, graded against each mock app's database. Silent failures (engine said success, database disagreed): **0**.

Machine: Intel(R) Xeon(R) Processor @ 2.80GHz × 2, 8 GB RAM, linux 6.18.44-fc-v139 (x64); Node v22.22.0, Playwright 1.56.1 (Chromium 141.0.7390.37). 10 runs per workflow, concurrency 3, seed 1, wall time 3 min. Generated 2026-10-19.

| App | Runs | Passed | Success | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| directory | 40 | 40 | 100.0% | 2.7 s | 7.6 s |
| hr | 40 | 40 | 100.0% | 1.8 s | 3.7 s |
| helpdesk | 40 | 40 | 100.0% | 7.7 s | 20.5 s |

| Workflow | Runs | Success | p50 | p95 |
|---|---:|---:|---:|---:|
| directory.create_user | 10 | 100.0% | 3.6 s | 8.4 s |
| directory.remove_user | 10 | 100.0% | 3.8 s | 5.8 s |
| directory.rotate_password | 10 | 100.0% | 2.2 s | 3.5 s |
| directory.sign_in | 10 | 100.0% | 1.7 s | 4.5 s |
| helpdesk.create_user | 10 | 100.0% | 15.6 s | 22.5 s |
| helpdesk.remove_user | 10 | 100.0% | 11.6 s | 20.5 s |
| helpdesk.rotate_password | 10 | 100.0% | 5.1 s | 7.8 s |
| helpdesk.sign_in | 10 | 100.0% | 4.0 s | 10.3 s |
| hr.create_user | 10 | 100.0% | 2.3 s | 2.9 s |
| hr.remove_user | 10 | 100.0% | 2.6 s | 4.7 s |
| hr.rotate_password | 10 | 100.0% | 1.7 s | 3.5 s |
| hr.sign_in | 10 | 100.0% | 1.0 s | 3.7 s |

| Kind of mess (runs where it was in play) | Runs | Success |
|---|---:|---:|
| Field ids/classes change every load | 106 | 100.0% |
| Login form inside an iframe | 80 | 100.0% |
| TOTP second step | 80 | 100.0% |
| Consent overlay blocking clicks (appeared) | 41 | 100.0% |
| Slow single-page app (150 ms – 4.5 s per call) | 40 | 100.0% |
| Session expired mid-task (fired) | 17 | 100.0% |
| Target beyond page 1 of the list | 36 | 100.0% |
| Confirm modal before removal | 24 | 100.0% |
| "What's new" popup (appeared) | 4 | 100.0% |
| A/B copy test renamed the action buttons | 29 | 100.0% |
| Survey popup with no dedicated handler (appeared) | 3 | 100.0% |

No failures in this run.

Locator: 1459 element resolutions; winning strategy share: role 57.5%, label 23.2%, text 10.6%, placeholder 6.2%, css 1.9%, testId 0.7%. 128 resolutions needed a fallback strategy (in 65 runs). Interstitials handled: session_expired 17, cookie_banner 41, announcement 3, unknown_popup 1. Runs with a forced re-login: 17.
