# Task: Stale-tab preview and opt-in automatic cleanup

## Description

Make stale-tab cleanup understandable before it closes anything, and let users opt into automatic cleanup. The main toolbar menu must show whether automation is enabled and, when applicable, how many tabs are scheduled to close and at what local time.

Status: user authorized implementation, commits, feature-branch push and opening a review-ready PR on 2026-10-06. Target: **0.6.0**, a feature release after 0.5.3. Merge, release-tag push and store publication are not authorized.

## Background

- Baseline: main commit `d6f8e74b7e2a3cdf03f7934bc999ab96eac52066`, released as 0.5.3.
- Existing requirements: R4 stale tabs, R5 settings, R6 entry points and feedback, R7 safety, R10 distribution. Add numbered subrequirements there during implementation rather than treating this document as evidence of a shipped feature.
- The current toolbar action immediately invokes stale-tab removal. Its threshold is configured separately and defaults to seven days.
- The current planner uses a zero fallback for missing last-access times. That is not acceptable for automatic removal.
- Search has session-only focus tracking. It is not a durable cross-restart tab identity or a background history index.
- This feature closes tabs. It does not archive, discard, hide, bookmark, or preserve their page state.

### Agreed product decisions

1. No separate window or detached popout for stale-tab controls.
2. The toolbar row expands inline, with a right-facing chevron when collapsed and a down-facing chevron when expanded, like Sort tabs.
3. Clicking the row never closes tabs.
4. Main-menu title when enabled: **Stale Tabs (Auto-Close Enabled)**.
5. Main-menu caption, when one or more tabs are expected to qualify: *Closing 6 tabs automatically at 10p.* Use the actual count and scheduled local time.
6. When enabled with zero expected closures, keep the enabled title and omit the caption. When disabled, show **Stale Tabs**, without an automation caption.
7. Do not substitute wording such as "7-day rule", "due", "Auto on", or "~40m".
8. Expanded controls contain the inactivity duration, automation checkbox, eligible count, Review tabs, and an explicit Close N tabs now button.
9. Menu and Settings share the same saved threshold and automation preference.

### Proposed engineering defaults

These complete the specification; they are recommendations rather than additional user quotes: automation starts off; existing thresholds are preserved; the default remains seven days; the first sweep is at the next whole local hour; later sweeps are hourly; private windows are excluded from automation; automatic cleanup always protects pinned and audible tabs regardless of manual-cleanup preferences.

## Technical Requirements

### A. Toolbar presentation and interaction

- Replace the immediate stale-close action with an accessible disclosure button. Keep the current menu style, icons, vanilla JavaScript and CSS; do not add a framework or remote assets.
- Retain the exact agreed title and caption. Use singular "1 tab" and plural "N tabs". English examples: 10p, 10:30p. Honor the user's locale/12-hour or 24-hour convention, and include "tomorrow" or a date when necessary to avoid ambiguity. Never show a countdown or approximate-time marker.
- Format the scheduler's actual next planned timestamp, not a separate UI timer. If scheduling is unavailable, show a truthful inline error instead of claiming a closure time.
- Calculate the automatic caption using eligibility at the next scheduled timestamp, including tabs that will cross the threshold before then. The manual-close count uses eligibility now. Keep these counts distinct.
- Refresh status on menu open, relevant tab/settings events and time progression while visible. Use a bounded fallback refresh where browser popup APIs require it. Release listeners/timers when the popup closes. Avoid focus movement, row rebuilding, or noisy live-region announcements on unchanged values.
- Do not flash a zero count or disabled status while loading. On refresh failure, mark status unavailable and disable actions requiring a valid preview; do not replace unknown data with "0 tabs".
- In the expanded section, show the duration prompt with browser-appropriate wording driven by `ageBasis` ("Close tabs not viewed for [7] [days]" on Firefox, "Close tabs not active for [7] [days]" on Chrome, neutral "not used for" when the basis is unknown), the checkbox "Automatically close stale tabs", a manual eligible count with scope, Review tabs, and Close N tabs now. Hours and days remain supported. Values must be positive integers; reject invalid/overflowing durations in both UI and background.
- Review tabs expands a bounded, scrollable list inside the same menu. Show title, domain, and time since the tab was last used (last viewed on Firefox, last activated on Chrome). This release does not add per-row selection/exemption controls or another search mode.
- Keep the review list and controls usable within browser popup height limits. Expanding stale controls collapses Sort options and vice versa. Tab order is logical; Enter/Space toggles the disclosure; Escape collapses nested review/disclosure before dismissing the menu. Provide labels, aria-expanded/aria-controls and restrained status announcements.
- Keep automation's enabled state and caption visible when controls are collapsed. The caption may wrap; never truncate the count/time or enabled state beyond recognition.
- Changing a valid duration saves the shared preference and refreshes both previews. It never directly closes tabs. A changed threshold invalidates any earlier manual preview authorization.
- Close N tabs now is disabled at zero, while previewing, for invalid input, and during a conflicting close. Match existing busy/success/failure feedback conventions; report actual results, not the originally predicted count.

### B. Opt-in, settings and scheduling

- New and upgraded installations have automation disabled unless the user has explicitly enabled this feature. Preserve existing stale thresholds and all unrelated settings, identifiers, shortcut assignments, and search behavior.
- The expanded controls and Settings must explain: "Tabs are closed, not archived. Unsaved changes may be lost." Enabling explicitly permits already-stale eligible tabs to close at the first scheduled sweep. Display that sweep's time and projected count before/alongside enabling; do not perform an immediate cleanup.
- Enabling schedules the next whole local hour strictly in the future. An ordinary minute delay is not a user-configurable option. Hourly scheduling must remain correct around midnight, time-zone changes, DST, and system-clock changes.
- Use browser.alarms, with a uniquely named alarm, and add only the alarms permission to the manifests. Use APIs supported by the declared minimum versions, not newer persistence flags.
- Persistent storage holds the feature preference, threshold, and scheduler metadata. Do not rely on in-memory service-worker state for whether automation is enabled or when it should next run.
- Reconcile the alarm on installation/update, background initialization, browser startup, and preference changes. Disabled means no alarm and no automatic removals. An update preserves a previously explicit opt-in; installing this feature for the first time does not enable it.
- On a full browser restart, reconstruct age information and schedule the next future hourly run; do not run a startup bulk-close or replay a backlog. After device sleep without browser exit, a delayed alarm may cause at most one fresh sweep on wake; never replay each missed hour. Document this behavior in help text, not the main status caption.
- Threshold changes retain an existing valid next run while recalculating candidates. Disabling clears the alarm and prevents any further removals not already issued. Re-enabling schedules a new future run.
- Serialize cleanup requests. A manual stale close and an automatic sweep must not race or act on the same outdated preview. Recheck settings while sweeping; a disable or rule change stops the remaining old work.
- Do not begin automatic removal while stale-tab controls/review are open; defer that sweep and show the revised next time. This protects a user actively inspecting or editing the rule without blocking automation merely because the collapsed main menu is open.

### C. Age, scope and protections

- Stale means at least the configured elapsed time since this particular tab was last used—last viewed on Firefox, last activated (selected) on Chrome, so the Chrome clock starts at selection rather than when the tab is left. Equality qualifies. Background reloads and visits to another tab with the same URL must not reset this tab's observed age.
- Establish trusted age from supported, verified browser last-access data and actual tab/window focus events. Newly created, background-opened, restored, duplicated and replaced tabs must not inherit another tab's identity or age.
- Missing, zero, non-finite, future, inconsistent or untrusted timestamps are not proof of old age. Keep those tabs. A same-session first-observed timestamp can establish a conservative minimum age for an otherwise unknown tab; merely checking the tab must not continually reset that baseline.
- At browser restart, use reliable browser-provided restored timestamps where available. Chrome additionally keeps a timestamp-only correction/rollback journal in local storage—holding no tab IDs, URLs, hashes, titles, or private-window activity—so clean restarts preserve ages; otherwise start a conservative observation baseline for that restored tab. An abrupt crash that loses recent activity in both the browser and the extension can still restore an older native age. Do not persist numeric tab IDs across browser sessions or correlate restored tabs solely by URL. Document any browser-specific loss of age continuity; do not silently claim exact week-long tracking if new tests do not support it.
- Before implementing the age adapter, run a focused Firefox/Chromium probe covering selection, window focus, background reload, creation, discard, session restore and full browser restart. This is a verification gate, not a promise that all native timestamps have identical semantics. If the stated age behavior cannot be delivered within this scope, bring back that specific limitation before changing permissions or storage architecture.
- Automated scope is normal browsing windows only. The incognito worker must not schedule a duplicate sweep or write private-tab metadata to persistent storage. Automation excludes private tabs and extension-owned/protected/internal pages; it must not wake sleeping tabs or request website access.
- Always exclude the active tab of every window, pinned tabs, tabs playing audio, and the final surviving tab of any window from automation. Unknown safety state means skip. Re-evaluate immediately before each removal.
- Manual stale cleanup keeps its configured pinned/audio protections and uses the invoking privacy context, never mixing normal and private results. The panel states the applied protections. Automatic protections are stricter when the manual toggles are disabled; explicitly distinguish manual and automatic counts in that case.
- Reuse the same age/eligibility logic for captions, previews and execution, with explicit time/scope/protection-policy inputs. Do not independently approximate counts in the UI.
- There is no reliable universal unsaved-form detector in scope. Do not introduce page-content inspection or promise preservation of forms, scroll position, media state or other page state.

### D. Safe preview and execution

- Opening the disclosure, reviewing candidates, adjusting a threshold, opening Settings or enabling automation must not invoke tabs.remove.
- The manual close operates only on a bounded background-issued preview snapshot. The snapshot binds candidate identities, rule revision, scope/privacy context and tab document identity sufficiently to detect a changed tab. Rendering data in the popup is not authorization to close arbitrary IDs.
- A confirmed close may remove fewer tabs if candidates disappeared, navigated, were viewed, became protected, or moved out of scope. It must never add unpreviewed candidates. A stale/invalid preview requires refresh, not silent regeneration-and-close.
- Immediately re-read each candidate and its window safety state before removal. Process in a way that stops on invalidated context and reports partial success accurately. Do not assume a bulk API call means every requested tab closed.
- A dismissed popup does not cancel a manual close already explicitly accepted; closing the popup before confirmation removes nothing. Expire abandoned previews and bound their storage. Private preview state remains session-only.
- Trust only extension-owned toolbar/settings callers for the new privileged messages, following the existing sender allowlist. Website frames, content scripts and the embedded search frame must not enable automation or trigger stale cleanup.
- Handle a worker interruption conservatively: never blindly replay an in-flight removal or an old preview after restart. Re-read current state before later sweeps. Do not automatically retry a removal whose result is uncertain.
- Report actual closed, skipped and failed counts. Preserve completed results if notification delivery fails. Automatic sweeps are silent when nothing changes; report a real closure batch once and surface execution/scheduling failures without per-tick spam or tab-title disclosure.
- Recovery uses the browser's Reopen Closed Tab capability where available. Do not promise an unlimited recovery window, private-tab recovery, or restoration of unsaved state. No custom archive/undo store in this release.

### E. Other entry points and unchanged behavior

- Retain the existing close-stale command ID and any user binding; add no suggested shortcut. Update its human description and the stale context-menu label to indicate opening stale-tab controls rather than immediate closing.
- Keyboard and context-menu entry points open the existing toolbar popup with the stale section expanded, scoped to the invoking window/privacy context. Consume any one-shot opening intent once; ordinary later toolbar opens must not inherit it.
- Verify programmatic popup opening from actual user gestures in both browsers and declared minimum versions. If popup opening is refused, remove nothing and explain how to open Stale Tabs from the toolbar. Do not silently fall back to a detached window or immediate cleanup.
- Keep the search palette and its host-handoff behavior unchanged. Do not add stale settings there. Leave duplicate cleanup, blank cleanup, sorting, merging, branding, and package identity outside this feature except for required regression-test adjustments.
- Keep the Firefox add-on ID and Chrome listing ID. The only intended permission delta is alarms. Check the actual update/permission behavior and explain it in release notes without assuming whether a browser will prompt.

## Dependencies

- Existing vanilla-JS WebExtension code, webextension-polyfill, Vitest and native Firefox/Chromium test harnesses. No new package dependency is planned.
- Firefox 115+ and Chrome 127+ as currently declared. Minimum-version validation is required for newly used APIs; raising those minimums requires a separate decision.
- Browser alarms, tabs, windows and storage APIs; no server, account, telemetry, background content index, or additional website access.
- Existing GitHub Actions CI/release workflow and configured store credentials. Store listing text/images require signed-in dashboard access separately from package upload.

## Implementation Approach

Implement in ordered slices, each with its own regression tests; do not run overlapping writers against the same files.

1. **Age and eligibility:** verify native timestamp behavior; introduce deterministic stale planning with an injected clock; fix unknown-age handling; add scope/protection/next-run count tests.
2. **Preview and execution:** add bounded authorized snapshots, revalidation, one-shot consumption, partial-result accounting and manual/automatic serialization; test stale targets and interruption cases.
3. **Scheduler and settings:** add disabled-default preference and alarm reconciliation, opt-in/disable behavior, startup/wake handling and normal/private isolation. Tests cover worker restarts and absent alarms.
4. **Toolbar and entry points:** implement exact agreed copy, inline disclosure/review, shared settings, main-screen projections, keyboard/context opening and accessible busy/error states. Test popup dismissal and out-of-order preview replies.
5. **Integrated browser verification and release preparation:** update requirements/design/task status/README, capture real UI evidence, validate package contents and prepare release/store notes.

Expected source areas: src/core.js; src/background.js and a narrowly scoped stale-cleanup service/scheduler module if separation improves testability; src/popup.html/js/css; src/options.html/js; src/manifest.firefox.json; src/manifest.chrome.json. Extend the existing test and browser-fixture patterns. Avoid changing unrelated search internals solely to share a helper.

## Acceptance Criteria

### 1. Inspectable cleanup and main-menu status

- Given a fresh install or upgrade from 0.5.3, when the toolbar opens, then auto-close is off and opening Stale Tabs closes nothing.
- Given automation enabled with six projected candidates and a next local run at 10p, when the menu opens, then it shows "Stale Tabs (Auto-Close Enabled)" and "Closing 6 tabs automatically at 10p." One candidate uses "1 tab"; zero omits only the caption.
- Given valid or invalid duration edits and changing tab state, when previews return in any order, then only the latest valid preview controls the count/action; invalid/failed previews cannot close tabs.
- Given keyboard-only use, narrow popup dimensions and light/dark themes, when expanding/reviewing/collapsing, then all labels/actions remain visible and usable, focus stays predictable, and no new window opens. Verify unit behavior and rendered pixels in both real browsers.

### 2. Accurate age and conservative safety

- Given timestamps at, just below and just above the threshold, when planning now or for the next run, then inclusion matches elapsed time exactly and duplicate URLs remain separate tabs.
- Given unknown/future/invalid age, private/extension pages or active/pinned/audible/last-in-window tabs, when automatic cleanup plans and executes, then none are removed; unknown age is never converted into ancient age.
- Given native background reload, tab creation/discard/restore and browser/worker restarts, when age is recalculated, then it follows the tested age policy, never associates a reused ID with old metadata, and does not load sleeping tabs. Document any conservative restored-age reset.
- Given normal and private browser contexts together, when alarms and menus run, then automatic cleanup occurs only once in the normal context and no private metadata becomes persistent or appears in normal previews.

### 3. Deliberate and bounded removal

- Given a previewed set, when the user explicitly selects Close N tabs now, then only those candidates can close after fresh checks. A newly eligible tab outside the snapshot remains open.
- Given a previewed tab is viewed, navigated, pinned, made audible, moved or removed, when close is requested, then affected candidates are kept/skipped and no replacement IDs are silently introduced.
- Given a partial API failure, notification failure, duplicate close message, overlapping alarm or worker interruption, when execution settles/resumes, then confirmed results remain accurate and uncertain removals are not replayed.
- Given an unauthorized sender or malformed/replayed/expired preview, when it requests settings changes or removal, then it is rejected without side effects. Cover these cases with background tests.

### 4. Opt-in lifecycle and scheduling

- Given automation off, when enabled with eligible old tabs, then nothing closes immediately and the first scheduled sweep is in the future. Given disable during a batch, then no new removals are issued after the disable is observed.
- Given browser startup, extension update, missing alarm or suspended worker, when initialization runs, then the preference and one correct schedule are restored without enabling new users or duplicating sweeps.
- Given sleep, DST/time-zone/clock changes and rule changes, when the schedule is reconciled, then the displayed next time matches scheduler state, no backlog replays, and freshly checked eligibility governs any delayed run.
- Given an open stale review/editor at an alarm, when the sweep would start, then it defers and updates the caption. Verify a real scheduled alarm in both browsers, not only direct handler calls or mocked timers.

### 5. Release acceptance

- Given the final candidate, when the full unit suite, both builds, extension lint, packaging and native-browser regressions run, then they pass on the exact candidate commit. Compare archive contents to built files and check every version is 0.6.0.
- Given a disposable 0.5.3 profile with saved settings and custom shortcuts, when upgraded, then its state remains intact, automation stays disabled, and the new menu works. Verify enable/disable and persisted opt-in across subsequent reload/restart.
- Given real Firefox/Chromium evidence and independent safety/UX review, when release readiness is assessed, then no blocking finding remains. Capture off, enabled-with-candidates, enabled-zero, expanded-review and error states, plus a short enable/sweep/result recording. Do not claim macOS or minimum-version execution without running it.
- Given explicit publication approval and green CI, when the tested merge commit is tagged and the release workflow runs, then both store steps actually execute and succeed; a skipped publishing step or a green build alone is not successful submission. Public availability in both stores is checked separately.

## Release Plan and Approval Gates

1. Work on feat/stale-tab-cleanup from current main, outside disposable scratch worktrees. Track implementation tasks in docs/tasks.md. Do not apply the archived pre-0.5.3 branding stash.
2. After implementation approval, build through the acceptance criteria. Show the actual main-menu and expanded-control experience before calling UI acceptance complete. Preserve independently reviewed source and test evidence.
3. Proposed version: 0.6.0. Change package.json and the package-lock root metadata together; the existing build injects the version into both manifests. Do not alter dependency versions or rerun icon generation unnecessarily.
4. Prepare release notes describing optional automatic closure, the new manual preview flow, unchanged custom bindings, alarms permission, protections, scheduling/recovery caveats, and any verified browser-specific age limitation. Update store copy without "formerly" language and capture the changed menu for the upload kit.
5. With commit/PR authorization, commit specific relevant files, push the named feature branch and open a focused PR. Exclude .kiro, scratch data, profiles, local logs and generated distribution/store assets from source commits. Attach appropriate evidence through the supported PR path.
6. Merge only after CI, independent review and required product acceptance pass, and after explicit merge/publication authorization. A later instruction to "build, merge, and release 0.6.0" can authorize these phases together; do not repeatedly ask for already authorized steps.
7. Tag the actual merged, verified commit v0.6.0 and push that tag through the normal release path only with publication authorization. No direct push to main, tag replacement, or duplicate store submission.
8. Follow .github/workflows/release.yml through tests/build/lint, both ZIPs, GitHub release creation, Firefox signing/listed publication, and Chrome upload/auto-publish. Inspect each publishing step; record exact run and release URLs.
9. Monitor each public store until 0.6.0 is confirmed or the authorized bounded watch expires. Report submitted, approved/published, and publicly available as separate states. Do not resubmit merely because public review is slow.
10. Store descriptions/screenshots are a separate delivery step: prepare the kit and apply through an authorized signed-in dashboard, or hand the user exact fields/files if agent access is unavailable. Do not confuse successful package publication with completed listing updates.
11. Finish by reporting the merged commit, test evidence, package identities, both submission/publication states, outstanding manual store work and any unverified platforms. Synchronize the main checkout without discarding unrelated changes.

### Recovery and rollback

- Users can immediately disable automatic cleanup; that stops future sweeps and does not require a store release. Closing cannot be fully rolled back; use native recently closed tabs where available, without promising unsaved-state recovery.
- A shipped defect requires a higher-version corrective release through review, not moving the existing release tag. If necessary, that corrective release forces automation off and clears its alarm. No remote kill switch exists or is added by this feature.

## Out of Scope

Arc-style archive/unarchive; full session preservation; custom undo history; automatic duplicate/blank cleanup; website-specific exclusions; private-window automation; cloud synchronization; new shortcuts; branding changes; redesigning the search palette; changing minimum browser versions without approval.

## Verification Commands

Run the repository's existing commands from its package root: npm test; npm run build; npm run lint; npm run package; npm run test:browsers. Add focused stale-cleanup browser cases to the existing harness and retain action-feedback/search/host-handoff regressions. Use disposable profiles and loopback fixtures; never test automatic closure against the user's real browsing session. Check host headroom before full browser runs.

## References

- Chrome alarms: https://developer.chrome.com/docs/extensions/reference/api/alarms
- Browser Tab metadata: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab
- Toolbar popup opening: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/action/openPopup
- Chrome action API: https://developer.chrome.com/docs/extensions/reference/api/action
- Local baseline: docs/prd.md, docs/design.md, docs/tasks.md, src/core.js, src/background.js, src/search-service.js, src/popup.html/js, src/options.html/js, both manifests, and .github/workflows/release.yml.

## Implementation Interface (2026-10-06)

The parent owns background/service/core integration; the UI worker owns popup/options files and UI tests; the browser worker owns the timestamp probe and its isolated fixtures. All new messages use the existing trusted popup/options sender gate. No content-script caller is allowed.

- `getStaleState({ windowId })` returns `{ ageBasis: 'viewed' | 'activated', settings: { staleThresholdMs, autoCloseStaleEnabled, skipPinned, skipAudible }, auto: { enabled, available, nextRunAt, count, error }, preview: { id, tabs: [{ id, title, url, lastViewedAt }], count, windowCount, unknownCount } }`. `ageBasis` names the age semantics so the UI can word the threshold prompt, review-row ages and manual-close scope per browser (`viewed` on Firefox, `activated` on Chrome); the UI defaults to neutral wording when the field is absent, so older/mocked replies without it stay backward-compatible. `preview.tabs[].lastViewedAt` keeps its name as a compatibility alias for the per-basis last-activity time. `nextRunAt` is the next future planned time even while disabled, so enabling can be explained. A private-window caller receives no normal-tab count (`auto.available=false`). Unexpected failures return the established `{ error, message }` shape. Preview IDs expire and are bound to their invoking context.
- `setStaleRule({ windowId, settings: { staleThresholdMs?, autoCloseStaleEnabled? } })` validates and saves only these keys, reconciles scheduling, and returns `{ message }`. The client then fetches fresh state. Existing generic `saveSettings` must route these fields through the same validation/reconciliation, preventing a Settings bypass.
- `closeStalePreview({ windowId, previewId })` returns `{ message, closed, skipped, failed, error?, notificationError? }`. It is an explicit user action with the existing popup busy/success/failure pattern. No arbitrary tab IDs are accepted from the UI.
- `staleEditor({ windowId, editorId?, open })` acquires/renews/releases a short-lived editor lease and returns `{ editorId }`. Acquire when the inline stale controls or stale Settings editor are active; renew every five seconds; release on collapse/pagehide. The lease expires after 15 seconds without renewal so lost views never disable automation indefinitely. Scope leases to normal/private context and the issuing client ID.
- `consumeStaleIntent({ windowId })` returns `{ open: boolean }`, consuming a short-lived one-shot intent set by keyboard/context-menu entry points. Ordinary toolbar opens do not inherit an already consumed intent.
- UI polling is bounded to once per five seconds while visible, in addition to relevant tab/storage events. Only the latest response may update state; pause refresh during explicit close. Event listeners/timers must be removed on pagehide. Collapsed popup initialization is additive and must not break unrelated actions when stale-state loading fails.

## Metadata

- Complexity: High (destructive background actions, tab-age semantics, browser lifecycle and cross-browser UI).
- Labels: webextension, stale-tabs, optional-automation, accessibility, release.
- Required Skills: vanilla frontend development, WebExtension lifecycle and permissions, pure-logic testing, native-browser verification, code review and release handling.
- Implementation/commit/push/PR approval: granted on 2026-10-06. Merge/tag/store publication: not authorized.

## Candidate verification and accepted Chrome policy (2026-10-06)

The candidate is implemented locally at version 0.6.0, not published. Parent verification passed 1,125 unit tests, both builds/packages and lint with zero errors, notices or warnings. Each browser ZIP contains 59 files identical to its build. Dependency declarations are unchanged and alarms remains the only added permission. Final native stale checks passed Firefox 157.0.1 88/88 and Chromium 145 94/94; the integrated Chromium age/journal suite passed 36/36. Full existing browser regressions passed 374 Firefox and 398 Chromium checks this turn before the final stale-result-message-only wording change. Final source and harness hashes match the evidence saved under artifacts/age-hardening-final/. The Chrome differential-age fixture was repaired for the new age model; none of its failed assertions was waived. Synthetic age corrections, accelerated clocks/schedules and injected transport/storage failures are labelled separately from native events.

The user approved Chrome last-activated semantics on 2026-10-06. Firefox remains last-viewed; each window's active tab stays protected regardless of its age. Chrome native lastAccessed carries age across clean restarts, and a bounded timestamp-only journal in storage.local corrects known older restored values only toward a younger age. It contains no tab IDs, URLs, hashes, titles or private activity and uses no extra permission. Firefox adds no durable age store, and Chrome private age observations remain session-only. Activation during awaited close checks skips the candidate. Journal writes precede session anchor advancement; failed writes retain retryable evidence and defer automatic cleanup.

The integrated Chromium checks observed age continuity over three clean restarts, journal survival through a test-owned SIGKILL crash, the dirty marker under an injected write failure, and unchanged durable journal contents during real split-incognito activity. Crash immunity is not promised: if an abrupt crash loses recent activity in both Chrome and ATV, a restored inactive tab can appear too old and qualify early. An hour of startup grace would not prove that age correct. The UI reports Activated on Chrome and Viewed on Firefox through ageBasis, while preserving the approved main-menu caption and enabled title. Tests simulate long elapsed times; they are not a real seven-day soak. Independent source review found no remaining blockers, and its additional write-ordering suggestion was implemented with four regression tests.

The candidate is now committed and open in [PR #16](https://github.com/adlio/tabvacuum/pull/16); live CI/review status is tracked there. Final PR preparation after test cleanup passed 1,137 unit tests across 19 files, both builds/packages and lint. The full seven-suite local browser gate passed 1,084 checks, including the search suites after the final wording change; all 111 final-evidence hashes matched before the implementation commit. This handoff only updates documentation afterward. Merge/tag/store publication remain unauthorized. Unverified cases include physical macOS/Windows behavior, declared minimum browser versions, full Firefox restart with the signed add-on (temporary add-ons do not survive it), native deferral exactly at a whole-hour alarm with an editor open, and a real seven-day soak. The separate timestamp probe verified Firefox restored native values, not production add-on installation persistence.
