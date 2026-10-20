# Round 5: swallowed-click recovery (50 x 12)

No failures, on the same 2-vCPU machine as rounds 1 to 4. GitHub CI later ran this code and lost one run to the race fixed in round 6.

**600/600 runs passed (100.0%)**, graded against each mock app's database. Silent failures (engine said success, database disagreed): **0**.

Machine: Intel(R) Xeon(R) Processor @ 2.80GHz × 2, 8 GB RAM, linux 6.18.44-fc-v139 (x64); Node v22.22.0, Playwright 1.56.1 (Chromium 141.0.7390.37). 50 runs per workflow, concurrency 3, seed 1, wall time 17 min. Generated 2026-10-19.

| App | Runs | Passed | Success | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| hr | 200 | 200 | 100.0% | 1.8 s | 4.2 s |
| helpdesk | 200 | 200 | 100.0% | 7.4 s | 23.0 s |
| directory | 200 | 200 | 100.0% | 2.5 s | 7.4 s |

| Workflow | Runs | Success | p50 | p95 |
|---|---:|---:|---:|---:|
| directory.create_user | 50 | 100.0% | 3.3 s | 7.5 s |
| directory.remove_user | 50 | 100.0% | 3.1 s | 7.9 s |
| directory.rotate_password | 50 | 100.0% | 2.4 s | 6.5 s |
| directory.sign_in | 50 | 100.0% | 1.6 s | 2.7 s |
| helpdesk.create_user | 50 | 100.0% | 14.2 s | 26.4 s |
| helpdesk.remove_user | 50 | 100.0% | 11.9 s | 24.1 s |
| helpdesk.rotate_password | 50 | 100.0% | 5.4 s | 9.0 s |
| helpdesk.sign_in | 50 | 100.0% | 4.2 s | 7.6 s |
| hr.create_user | 50 | 100.0% | 2.9 s | 5.0 s |
| hr.remove_user | 50 | 100.0% | 2.1 s | 5.5 s |
| hr.rotate_password | 50 | 100.0% | 1.6 s | 2.9 s |
| hr.sign_in | 50 | 100.0% | 1.0 s | 1.3 s |

| Kind of mess (runs where it was in play) | Runs | Success |
|---|---:|---:|
| Field ids/classes change every load | 535 | 100.0% |
| Login form inside an iframe | 400 | 100.0% |
| TOTP second step | 400 | 100.0% |
| Consent overlay blocking clicks (appeared) | 211 | 100.0% |
| Slow single-page app (150 ms – 4.5 s per call) | 200 | 100.0% |
| Session expired mid-task (fired) | 109 | 100.0% |
| Target beyond page 1 of the list | 177 | 100.0% |
| Confirm modal before removal | 127 | 100.0% |
| "What's new" popup (appeared) | 29 | 100.0% |
| A/B copy test renamed the action buttons | 132 | 100.0% |
| Survey popup with no dedicated handler (appeared) | 15 | 100.0% |

No failures in this run.

Locator: 7534 element resolutions; winning strategy share: role 57.0%, label 22.8%, text 11.2%, placeholder 6.0%, css 2.2%, testId 0.8%. 678 resolutions needed a fallback strategy (in 348 runs). Interstitials handled: cookie_banner 202, unknown_popup 11, announcement 21, session_expired 107. Runs with a forced re-login: 107. Runs that repeated a swallowed click: 2.
