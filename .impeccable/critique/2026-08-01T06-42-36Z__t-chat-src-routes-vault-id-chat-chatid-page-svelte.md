---
target: vault-chat chat surface (+page.svelte, Chat.svelte, ExportMenu.svelte, ScopeIndicator.svelte, SourceTree.svelte)
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-01T06-42-36Z
slug: t-chat-src-routes-vault-id-chat-chatid-page-svelte
---
Method: dual-agent (A: ae717859019263da7 · B: ac1af737d30f1aef1)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Streaming/thinking-panel states are well signaled; scope-change PATCH failures are silently swallowed ("best-effort" per code comment) with no toast or retry. |
| 2 | Match Between System and Real World | 3 | Domain copy fits the audience; tooltips explain tradeoffs in plain language. |
| 3 | User Control and Freedom | 2 | No undo for "hiçbiri" (select-none), which can zero out all 778 sources in one click; no message edit/retract. |
| 4 | Consistency and Standards | 2 | Three concrete breaks in one header row: native `<select>`/checkbox vs. every themed control elsewhere, a bare "⬇" glyph vs. Lucide icons on both sides of it, and the export trigger has no focus-visible ring while its neighbors do. |
| 5 | Error Prevention | 1 | Zero confirmation dialogs on this surface; select-none is one unconfirmed click, and the live instance was observed sitting in that exact zero-source state. |
| 6 | Recognition Rather Than Recall | 3 | Tree, model labels, and icon rail are recognition-friendly; but model/think settings sit at the opposite end of the screen from where they're used. |
| 7 | Flexibility and Efficiency of Use | 1 | Enter-to-send is the only accelerator on the whole surface — no shortcut for stop, model switch, tree focus, or export. |
| 8 | Aesthetic and Minimalist Design | 2 | Clean at 1440px; degrades at 900/700px as citation cards wrap and the header control cluster reads as clutter against the sparse transcript. |
| 9 | Error Recovery | 2 | `errorMessage` mostly plain-language but leaks a raw HTTP status code in one path; scope-PATCH failures aren't surfaced at all. |
| 10 | Help and Documentation | 1 | No contextual help beyond native hover `title` attributes — invisible until hover, not touch-friendly. |
| **Total** | | **20/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment (Assessment A)**: Mostly specific, undermined by a handful of un-designed control clusters that are exactly what you flagged. The transcript itself is genuinely authored for this product — `ChatBubble.svelte`'s bubble pair, the collapsible "Düşünme süreci" panel, per-message source chips, and the narrow-scope recovery link ("Kapsamı genişlet?") all read as RAG-native, not a reskinned generic chat template. Where it drops back to browser/shadcn defaults: the model `<select>` and think-checkbox (bare native controls), the export trigger (a literal Unicode glyph), and the empty state (one line of muted text where DESIGN.md's own spec calls for a Fraunces headline + illustration + one action — a written spec gap, not a taste call).

**Deterministic scan (Assessment B)**: `detect.mjs` on the 6 target files found exactly **1 finding** — a `layout-transition` warning on `.panel-left`'s `transition: width` (`+page.svelte:157`), confirmed real (not a false positive; DESIGN.md's motion tokens document durations, not which properties are approved to animate). Everything else you and the LLM review flagged — the bare glyph, the unstyled native controls, missing focus-visible, header/footer placement — sits outside what the mechanical scanner checks; it caught the layout-thrash issue and nothing else in this surface. The LLM review caught materially more here than the deterministic pass alone would have.

**Hard measurements (Assessment B, live browser)**: `.panel-left` renders at a pixel-identical **220px in both themes and at all three tested widths** — it does not respond to viewport at all:

| Viewport | Sidebar width | Sidebar % of window | Chat column |
|---|---|---|---|
| 1440px | 220px | 15.3% | 1164px |
| 900px | 220px | 24.4% | 624px |
| 700px | 220px | 31.4% | 424px |

This confirms the sidebar is fixed and non-responsive, but it does not reach the ~60% figure you described even at 700px — worth clarifying what window width you're actually seeing this at (see Questions below), since the fix differs depending on whether this is a narrower-than-700px window or the visual *weight* of 778 unstyled rows reading as "too much" independent of literal width.

## Overall Impression

The transcript itself is the strongest part of this surface and is genuinely on-brand. Everything wrapped around it — the header control cluster, the export trigger, the empty state — is where the observatory identity currently lapses back into default web-form chrome. All three of your reports are confirmed real by both independent reviewers; none were false alarms.

## What's Working

1. **The transcript/citation system is authentically on-brand** — hairlines not shadows, accent-soft/surface-raised bubble pair, mono token counts, all composing DESIGN.md's actual tokens into something a generic RAG competitor wouldn't have.
2. **Focus-visible discipline is real and broad** — nearly every interactive element (collapse toggle, vault-name link, tree rows, textarea, send/stop) correctly implements the accent-outline pattern. The export trigger is the one confirmed gap.
3. **The narrow-scope recovery path is a genuine product differentiator, built, not just claimed** — "Seçili kaynaklarda bulunamadı → Kapsamı genişlet?" turns a dead-end into a one-click fix, directly embodying PRODUCT.md's source-grounding principle.

## Priority Issues

**[P1] Source-tree sidebar is a fixed 220px with zero responsive behavior — confirmed, matches your report #1**
- **Why it matters**: `.panel-left { width: 220px }` with no `@media` query anywhere in the file. Measured pixel-identical at 1440/900/700px. At narrower windows the chat column shrinks proportionally (down to 424px/61% at 700px) and citation cards wrap to two lines. The only mitigation is the manual collapse toggle, which has to be rediscovered and re-toggled every session — no breakpoint-driven auto-collapse.
- **Fix**: add a viewport breakpoint (~900px) that auto-collapses `.panel-left` to its existing `.collapsed` state by default, or convert it to an overlay/drawer below that width rather than a permanent column.
- **Suggested command**: `/impeccable adapt`

**[P1] Model/reasoning controls live in the page header, disconnected from the input — confirmed, matches your report #3**
- **Why it matters**: `Chat.svelte`'s `<header>` holds the model select and think-toggle at the *top* of the column; the compose action is the `<footer>` at the bottom. Every time you want to reconsider model or reasoning depth mid-composition, that's an eye-jump top-to-bottom and back — exactly the friction the Claude Code CLI pattern you referenced (controls anchored to the input) avoids.
- **Fix**: move the model-select and think-toggle into a control row directly above/attached to the footer, restyled to match the app's pill/kicker/icon-button language instead of bare native form controls.
- **Suggested command**: `/impeccable layout`

**[P1] DESIGN.md's own empty-state spec isn't implemented, and a zero-source scope gets no visual escalation**
- **Why it matters**: DESIGN.md reserves the Fraunces-headline + illustration + one-action treatment specifically for empty states; the chat's empty transcript is one line of muted text, skipping the spec entirely. Separately, the live instance was observed sitting at **"0/778 kaynak aktif"** — reachable via one unconfirmed click on the tree's "hiçbiri" (select-none) button — rendered with the identical low-emphasis badge as any other scope state, despite being the single state most damaging to the product's "answers only from retrieved sources" promise.
- **Fix**: build the empty state per DESIGN.md's own spec; give a zero-selected scope a distinct treatment (e.g. the `--warning` token) and/or a confirm step on select-none.
- **Suggested command**: `/impeccable onboard` (empty state) + `/impeccable harden` (zero-scope guardrail)

**[P2] Export button's bare glyph and missing focus ring — confirmed, matches your report #3**
- **Why it matters**: `ExportMenu.svelte` renders a literal "⬇" Unicode character — confirmed rendering in the live DOM, not just source — sitting directly between two Lucide icons, with a visible stroke-weight mismatch in every screenshot. It also has only a `title` (no `aria-label`, unlike its siblings) and defines no `focus-visible` ring, unlike every other control in the same row.
- **Fix**: replace with a Lucide `Download` icon at the same size as its siblings; add `aria-label="Dışa aktar"`; add the same focus-visible pattern used everywhere else in this file.
- **Suggested command**: `/impeccable polish`

**[P2] User chat-bubble color reads as visually unrelated across the two themes — confirmed, matches your report #2**
- **Why it matters**: `--bubble-user` is `accent-soft` alpha-blended over `--ground`. Assessment B's direct sampling shows both themes use the same hue/chroma (green, 0.17) at low alpha, so it's not a broken/random value — but the *lightness inversion* means dark mode renders as a muted khaki-green wash while light mode renders as a bright mint highlight: technically one token, perceptually two unrelated colors. In dark mode this also means the user and assistant bubbles (accent-soft vs. surface-raised) sit close in value, so left/right alignment is doing more of the differentiation work than color is.
- **Fix**: consider a fixed-perceptual-weight bubble tint independent of the alpha-over-ground math, so both themes present the same recognizable "note," inverted only in lightness — or boost alpha/contrast specifically for the dark pairing.
- **Suggested command**: `/impeccable colorize`

## Persona Red Flags

**Alex (Power User)**: No shortcut for stop/model-switch/tree-focus/export — Enter-to-send is the only accelerator on the surface. Model + reasoning-depth controls sit at the opposite end of the screen from the input, the exact friction the Claude Code CLI pattern (Alex's own reference point) doesn't have. 778-source tree offers only all/none bulk actions — no search, no saved presets.

**Sam (Accessibility-Dependent User)**: Export trigger has a `title` but no `aria-label` and no themed focus ring, unlike its row-mates. The model `<select>` has no associated `<label>`, relying solely on `title` for its accessible name. Long filenames in the tree truncate via ellipsis with no `title`/`aria-label` fallback to recover the full name.

## Minor Observations

- `.model-select`'s 220px max-width plus title-only labeling means long provider/model strings will truncate in the closed `<select>` state with no way to see the full value except opening it.
- 778 tree nodes render as a fully-mounted recursive tree with no virtualization — not a design defect on its own, but it compounds the narrow-viewport crowding.
- The right-rail's icon+label stack (Panel/Test/Kartlar/Rapor/Harita/Slayt) is the internal reference pattern the header controls should be brought up to — consistent Lucide icons, visible labels, accent-badged counts.

## Questions to Consider

1. What window width are you actually viewing this at? Assessment B's measurements show the sidebar never exceeds ~31% of window width down to 700px — so "filling 60%+ of the side" suggests either a narrower window than tested, or that the tree's visual *weight* (778 unstyled rows) is reading as "too much" independent of literal width. This changes whether the fix is a breakpoint (adapt) or a density/visual-weight pass on the tree itself.
2. If model/thinking controls move to anchor above the input, should the header still carry the scope indicator alone, or should this row disappear entirely in favor of everything living at the input?
3. Given source-grounding is the product's core trust promise, should a zero-source scope be reachable in one unconfirmed click at all?
