# Round 1: engine v1 against the harder mess (label drift + survey popup)

Before any fixes. HR and Helpdesk workflows only knew the commit buttons by their labels, and nothing handled the survey.

**100/120 runs passed (83.3%)**, graded against each mock app's database. Silent failures (engine said success, database disagreed): **0**.

Machine: Intel(R) Xeon(R) Processor @ 2.80GHz × 2, 8 GB RAM, linux 6.18.44-fc-v139 (x64); Node v22.22.0, Playwright 1.56.1 (Chromium 141.0.7390.37). 10 runs per workflow, concurrency 3, seed 1, wall time 5 min. Generated 2026-10-19.

| App | Runs | Passed | Success | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| hr | 40 | 31 | 77.5% | 1.8 s | 17.0 s |
| directory | 40 | 38 | 95.0% | 2.2 s | 17.7 s |
| helpdesk | 40 | 31 | 77.5% | 8.5 s | 31.1 s |

| Workflow | Runs | Success | p50 | p95 |
|---|---:|---:|---:|---:|
| directory.create_user | 10 | 100.0% | 3.5 s | 6.4 s |
| directory.remove_user | 10 | 90.0% | 2.6 s | 18.7 s |
| directory.rotate_password | 10 | 90.0% | 2.4 s | 17.7 s |
| directory.sign_in | 10 | 100.0% | 1.4 s | 4.1 s |
| helpdesk.create_user | 10 | 90.0% | 14.0 s | 36.8 s |
| helpdesk.remove_user | 10 | 50.0% | 20.2 s | 31.1 s |
| helpdesk.rotate_password | 10 | 70.0% | 8.0 s | 18.5 s |
| helpdesk.sign_in | 10 | 100.0% | 3.9 s | 7.3 s |
| hr.create_user | 10 | 50.0% | 16.6 s | 17.3 s |
| hr.remove_user | 10 | 80.0% | 2.7 s | 16.4 s |
| hr.rotate_password | 10 | 80.0% | 1.8 s | 16.3 s |
| hr.sign_in | 10 | 100.0% | 0.6 s | 0.9 s |

| Kind of mess (runs where it was in play) | Runs | Success |
|---|---:|---:|
| Field ids/classes change every load | 106 | 81.1% |
| Login form inside an iframe | 80 | 86.3% |
| TOTP second step | 80 | 86.3% |
| Consent overlay blocking clicks (appeared) | 45 | 77.8% |
| Slow single-page app (150 ms – 4.5 s per call) | 40 | 77.5% |
| Session expired mid-task (fired) | 17 | 76.5% |
| Target beyond page 1 of the list | 36 | 66.7% |
| Confirm modal before removal | 24 | 66.7% |
| "What's new" popup (appeared) | 3 | 100.0% |

| Most common failure reasons | Count | Where | Example |
|---|---:|---|---|
| `element_not_found` | 18 | hr.remove_user, hr.rotate_password, hr.create_user, helpdesk.create_user, helpdesk.rotate_password, helpdesk.remove_user | steps[4]: no match for role=button[Remove person] within (role=dialog[Remove]) |
| `action_failed` | 2 | directory.rotate_password, directory.remove_user | steps[4]: action on role=button[Save password] \| testId=pw-save kept failing: locator.click: Timeout 2500ms exceeded. |

Locator: 1419 element resolutions; winning strategy share: role 57.7%, label 24.2%, text 11.0%, placeholder 6.3%, testId 0.6%, css 0.2%. 101 resolutions needed a fallback strategy (in 48 runs). Interstitials handled: session_expired 17, cookie_banner 44, announcement 2. Runs with a forced re-login: 17.
