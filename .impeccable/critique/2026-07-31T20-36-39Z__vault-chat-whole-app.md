---
target: vault-chat (whole app)
total_score: 19
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-07-31T20-36-39Z
slug: vault-chat-whole-app
---
**Method: dual-agent (A: design-review sub-agent · B: detector+browser-evidence sub-agent, both isolated per the skill's invariant)**

# Vault Agent Toolkit (vault-chat) — Design Critique

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Solid — live streaming, thinking trace, due-card badge, progress bars |
| 2 | Match System / Real World | 2 | Raw model IDs unlabeled; "token" count unexplained |
| 3 | User Control and Freedom | 2 | Rename-on-blur has no visible Cancel; delete has no undo |
| 4 | Consistency and Standards | 2 | Mid-migration shadcn vs hand-rolled; detector confirms 4.3:1 contrast in legacy areas |
| 5 | Error Prevention | 2 | Destructive actions gated only by native confirm() |
| 6 | Recognition Rather Than Recall | 2 | Icon-only rail; detector found labels render at 10.4px, below 11px floor |
| 7 | Flexibility and Efficiency | 1 | No keyboard shortcuts, no bulk ops, no command palette |
| 8 | Aesthetic and Minimalist Design | 2 | Zero DESIGN.md tokens applied; detector confirms flat type hierarchy |
| 9 | Help Recognize/Diagnose/Recover from Errors | 2 | Raw HTTP status in errors; /library/view error state is bare unstyled text |
| 10 | Help and Documentation | 1 | No in-app help/onboarding on any of 5 surfaces |
| **Total** | | **19/40** | **Poor** |

## Design Specificity Verdict

Split verdict. Interaction design (SourceChip citation hover-cards, ScopeIndicator scoped-retrieval readout, narrowScope prompt, ThinkingPanel reasoning trace, Obsidian deep-links) is genuinely product-specific. Visual system is not just unreplaced default shadcn — browser evidence showed every screenshotted page rendered in light mode (matchMedia default with no stored preference), and DESIGN.md documents zero light-theme values. The majority first impression has no design-system authority in either direction.

## Priority Issues

[P1] Visual identity gap: light mode (the actual default for fresh sessions) has no DESIGN.md coverage at all.
[P1] Text/code occlusion bugs in chat transcript: checkboxes covering file icons ~50%, code blocks 74-75% covered by bubble wrapper, one code span 100% covered by invisible textarea.
[P1] Legacy hand-rolled components fail accessibility: no focus-visible anywhere, detector-confirmed 4.3:1 contrast (needs 4.5:1), Space key doesn't activate tree rows.
[P2] Native confirm() for destructive vault-content actions (delete, key removal) - alert-dialog primitive already vendored but unused here.
[P2] Icon language placeholder-grade: mixed dingbats/emoji, and where labels exist they're 10.4px (below 11px floor).

## Persona Red Flags

Alex (power user): no shortcuts, no bulk ops, raw-ID model select.
Jordan (first-timer): one-sentence empty state, obscure icon-only rail, tooltip-only explanations.
Sam (accessibility): Enter-only keyboard activation (not Space), no focus-visible, no aria-live on streaming text, 4.3:1 contrast.

## Minor Observations

"Profil (yakında)" permanent stub in chat sidebar. /library/view renders bare unstyled error page. Hardcoded #b8860b vs existing --warning token. SF Mono stack omits IBM Plex Mono. SourceChip's two link types distinguished only by icon. Emoji-as-icon renders inconsistently across OS fonts. side-tab/layout-transition detector findings on quiz result cards are defensible false positives.

## Questions to Consider

- Replace right-rail icons with DESIGN.md's kicker style instead of bare glyphs?
- Use DESIGN.md's reserved empty-state art direction for the welcome screen?
- Should dark become the only supported theme, removing the undocumented-light-mode problem entirely?
