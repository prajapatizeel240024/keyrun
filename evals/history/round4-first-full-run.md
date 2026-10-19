# Round 4: first full run (50 x 12)

One run lost to a click swallowed by a consent wall. Fixed in round 5 (the numbers in the README).

**599/600 runs passed (99.8%)**, graded against each mock app's database. Silent failures (engine said success, database disagreed): **0**.

Machine: Intel(R) Xeon(R) Processor @ 2.80GHz × 2, 8 GB RAM, linux 6.18.44-fc-v139 (x64); Node v22.22.0, Playwright 1.56.1 (Chromium 141.0.7390.37). 50 runs per workflow, concurrency 3, seed 1, wall time 16 min. Generated 2026-10-19.

| App | Runs | Passed | Success | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| hr | 200 | 200 | 100.0% | 1.7 s | 4.0 s |
| helpdesk | 200 | 200 | 100.0% | 7.3 s | 23.2 s |
| directory | 200 | 199 | 99.5% | 2.3 s | 6.2 s |

| Workflow | Runs | Success | p50 | p95 |
|---|---:|---:|---:|---:|
| directory.create_user | 50 | 100.0% | 3.0 s | 6.4 s |
| directory.remove_user | 50 | 98.0% | 2.9 s | 7.7 s |
| directory.rotate_password | 50 | 100.0% | 2.1 s | 4.6 s |
| directory.sign_in | 50 | 100.0% | 1.5 s | 4.4 s |
| helpdesk.create_user | 50 | 100.0% | 14.0 s | 24.6 s |
| helpdesk.remove_user | 50 | 100.0% | 10.4 s | 23.2 s |
| helpdesk.rotate_password | 50 | 100.0% | 5.2 s | 10.9 s |
| helpdesk.sign_in | 50 | 100.0% | 4.3 s | 8.0 s |
| hr.create_user | 50 | 100.0% | 2.6 s | 4.3 s |
| hr.remove_user | 50 | 100.0% | 2.0 s | 4.4 s |
| hr.rotate_password | 50 | 100.0% | 1.4 s | 2.3 s |
| hr.sign_in | 50 | 100.0% | 0.7 s | 1.3 s |

| Kind of mess (runs where it was in play) | Runs | Success |
|---|---:|---:|
| Field ids/classes change every load | 535 | 100.0% |
| Login form inside an iframe | 400 | 99.8% |
| TOTP second step | 400 | 99.8% |
| Consent overlay blocking clicks (appeared) | 208 | 99.5% |
| Slow single-page app (150 ms – 4.5 s per call) | 200 | 100.0% |
| Session expired mid-task (fired) | 107 | 100.0% |
| Target beyond page 1 of the list | 177 | 100.0% |
| Confirm modal before removal | 127 | 99.2% |
| "What's new" popup (appeared) | 21 | 100.0% |
| A/B copy test renamed the action buttons | 132 | 100.0% |
| Survey popup with no dedicated handler (appeared) | 10 | 100.0% |

| Most common failure reasons | Count | Where | Example |
|---|---:|---|---|
| `element_not_found` | 1 | directory.remove_user | login[4]: no match for label=Digit 1 \| css=input[data-otp='1'] in frame iframe[title='Sign in to Directory'] |

Locator: 7515 element resolutions; winning strategy share: role 57.2%, label 22.7%, text 11.1%, placeholder 6.0%, css 2.2%, testId 0.8%. 674 resolutions needed a fallback strategy (in 345 runs). Interstitials handled: cookie_banner 202, unknown_popup 9, announcement 18, session_expired 106. Runs with a forced re-login: 106.
