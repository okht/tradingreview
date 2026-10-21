# Workspace shell verification

## Implemented

- Removed the page-wide header and visible product branding.
- Two white rounded panels sit on a muted blue-gray gradient. The middle color was sampled from the supplied reference image: #648596.
- The sidebar collapses to a 72px icon rail and resizes from 220px to 360px. Width and collapse preferences are local and persistent.
- The five supplied avatar images are available from the top-left avatar picker; selection persists locally.
- Connection and authorization actions use the existing pale-green feature button style. Red actions use #c32e50 with white foreground.
- Removed the redundant settings footer close action and bottom workspace/save-status block. The top-right dialog close and actual storage error alerts remain available.
- Increased message/composer maximum width from 820px to 960px and reduced the outer panel gap/padding to 8px.
- The new-review button alone uses the sampled dark green #3d6c26 with a white label/icon. Other feature actions keep their pale-green style.
- Removed the entire composer caption row, replaced outward upload arrows on import entry points with an inward import icon, and placed saved/pending method labels beside the method title.
- Account-import URL and credential inputs use compact outlined icon fields in a responsive two-column group.

## Reference evidence

REA 6.7.0 analyzed the installed Feishu history-list JavaScript module from main-window.asar: 703,339 bytes, 293 modules, zero parse failures. Metadata and source hashes are retained outside the product in ../references/rea-feishu. These are static observations of a specific history-list view; the full desktop shell geometry is interpreted from the supplied screenshots. No Feishu program assets or source are included in the product bundle.

## Verification

- Sidebar preference and resize boundary tests: 3/3 passed.
- Browser: collapse/expand; keyboard width 248 to 264 and back; pointer drag 248 to 292; double-click reset to 248; refresh persistence.
- Browser: all five avatar options visible; selecting avatar 3 survives refresh; selection restored after QA.
- Browser: model connection button uses pale-green feature style; settings footer has no second close button; manual evidence connection action is present.
- Local Vite and cloud Vinext builds pass. JSX/CSS parsing and git diff --check pass.
- Browser action QA uses isolated synthetic records on port 8790; no actual review or method was deleted.
