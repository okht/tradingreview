# 2026-10-22 UI controls verification

## Changes

- Historical reviews and saved trading methods now expose rename/delete actions in a compact overflow menu.
- Method deletion removes the library item while preserving review messages and historical research records.
- Initial capital uses comma grouping, preserves decimal input, and maintains the caret during middle edits and normalization.
- Date-only ranges use calendar selection. Evidence timestamps allow date-only input with optional hour/minute selectors. Imported finer timestamps survive unchanged confirmation.
- Removed the empty-home decorative icon and redundant method/result copy; method descriptions are inside trading rules.

## Checks

- Full test suite: 354/354 passed before the final money caret fix.
- Final money-input tests: 6/6 passed, including leading-zero normalization and middle deletion/insertion.
- Local Vite build and cloud Vinext build passed after the final fix; git diff --check passed.
- Browser QA used isolated synthetic data on port 8790: review rename, method rename, refresh persistence, deletion confirmation and cancellation.
- Browser input `1234567.50` displayed `1,234,567.50`. Deleting the decimal point in `0.50` then inserting `2` produced `250`, preserving the intended caret position.
- Browser QA confirmed range calendar selection, end-date constraints, optional evidence hour/minute selection, and date-only confirmation.
- Destructive state transitions are covered by unit tests. No user review or method was deleted during browser QA.
