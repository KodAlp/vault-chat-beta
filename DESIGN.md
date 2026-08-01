---
name: Vault Agent Toolkit
description: >
  Dark observatory system. A near-black, faintly green-tinted ground with a
  single living green accent; fine hairlines and particle-dust texture instead
  of heavy shadows; wide-tracked editorial type over a calm dashboard shell.
  Restraint everywhere, brilliance in one place per screen.

# Source of truth is src/styles/tokens.css (CSS custom properties).
# This frontmatter is the portable export for Impeccable commands.
# If a token changes there, update both.

colors:
  # Surfaces — never pure black; every dark is tinted toward the accent hue.
  ground: "oklch(13% 0.008 165)"          # page background (--bg)
  ground-deep: "oklch(9% 0.006 165)"      # insets, code wells, transcript gutter
  surface: "oklch(17% 0.010 165)"         # panels, cards, inputs (--surface)
  surface-raised: "oklch(21% 0.010 165)"  # popovers, hover lift, active row

  # Text — neutral near-whites, never #fff on large areas.
  text: "oklch(93% 0.004 165)"            # headings, primary body (--text)
  text-muted: "oklch(62% 0.008 165)"      # meta, timestamps, kickers (--muted)

  # Accent — one green, used for state and focus, not decoration.
  accent: "oklch(76% 0.17 155)"           # primary accent (--accent)
  accent-soft: "oklch(76% 0.17 155 / 0.14)"  # selection fills, tag backgrounds
  accent-glow: "oklch(76% 0.17 155 / 0.25)"  # focus rings, subtle outer glow
  accent-text: "oklch(82% 0.13 155)"      # small readable green text on dark
  ink-on-accent: "oklch(13% 0.008 165)"   # dark ink on the accent-filled primary button

  # Chat bubbles — solid tint, not accent-soft alpha-blended (see
  # src/styles/tokens.css's comment on why the blend broke across themes).
  bubble-user: "oklch(28% 0.03 155)"      # user message fill

  # Hairlines — alpha-based so they sit on any surface.
  hairline: "oklch(90% 0 0 / 0.08)"       # default 1px rule (--border)
  hairline-strong: "oklch(90% 0 0 / 0.16)" # section dividers, table heads
  hairline-accent: "oklch(76% 0.17 155 / 0.45)" # active tab underline, selected card

  # State (sparingly)
  warning: "oklch(72% 0.15 70)"
  danger: "oklch(62% 0.19 25)"
  success: "oklch(72% 0.15 150)"

# Companion light ramp — same hue family (165 neutrals, 155 accent) as the
# dark ramp above, added so a "system" theme session on a light OS
# preference is never left on an undocumented palette. Every pairing is
# WCAG-verified (OKLCH -> linear sRGB -> relative luminance; see
# src/styles/tokens.css's header comment for the exact ratios). The accent
# had to invert to 50% L (from dark's 76%) to stay legible as small
# text/icons on a near-white ground, which in turn flips ink-on-accent from
# dark ink to light ink on the primary-button fill — the one deliberate
# divergence from the dark ramp's own ink rule. See "Light companion" below.
colors-light:
  ground: "oklch(97% 0.006 165)"
  ground-deep: "oklch(90% 0.012 165)"
  surface: "oklch(99% 0.004 165)"
  surface-raised: "oklch(99.3% 0.003 165)"

  text: "oklch(22% 0.01 165)"
  text-muted: "oklch(50% 0.012 165)"

  accent: "oklch(50% 0.17 155)"
  accent-soft: "oklch(50% 0.17 155 / 0.12)"
  accent-glow: "oklch(50% 0.17 155 / 0.2)"
  accent-text: "oklch(38% 0.15 155)"
  ink-on-accent: "oklch(97% 0.006 165)"  # light ink — see note above

  bubble-user: "oklch(93% 0.03 155)"

  hairline: "oklch(20% 0 0 / 0.1)"
  hairline-strong: "oklch(20% 0 0 / 0.18)"
  hairline-accent: "oklch(50% 0.17 155 / 0.5)"

  warning: "oklch(48% 0.15 70)"
  danger: "oklch(48% 0.19 25)"
  success: "oklch(48% 0.15 150)"

typography:
  # Three faces, three jobs. No Inter, no system default as a brand voice.
  display:
    fontFamily: "Fraunces, Georgia, serif"     # poster/'Think' voice: page titles, empty states
    fontWeight: 480
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Schibsted Grotesk, 'Instrument Sans', sans-serif"  # UI + long-form
    fontWeight: 400
  mono:
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace"  # code, stats, tabular numbers
    fontWeight: 400
  kicker:
    # Wide-tracked uppercase labels — the signature from the reference boards.
    fontFamily: "Schibsted Grotesk, sans-serif"
    fontSize: "0.6875rem"     # 11px
    fontWeight: 600
    letterSpacing: "0.10em"
    textTransform: uppercase
  scale:
    "11": "0.6875rem"   # kicker, tag
    "12": "0.75rem"     # meta, table chrome, inline code
    "13": "0.8125rem"   # tree items, dense secondary UI
    "14": "0.875rem"    # controls, list rows, dense body
    "16": "1rem"        # default body, chat transcript
    "18": "1.125rem"    # lead paragraph, card heading
    "20": "1.25rem"     # panel titles
    "24": "1.5rem"      # subsection heads
    "32": "2rem"        # section heads
    "42": "2.625rem"    # page display (Fraunces)
    "56": "3.5rem"      # hero / empty-state display

spacing:
  reading-measure: "68ch"                  # transcript & long-form max width

radius:
  sm: "6px"     # tags, checkboxes, inline chips
  md: "10px"    # buttons, inputs, tree rows
  lg: "14px"    # cards, panels
  pill: "999px" # kickers-as-badges, filter chips

motion:
  fast: "150ms"      # hover, focus, chevron rotation
  base: "200ms"      # panel/popover reveal
  easing: "cubic-bezier(0.2, 0, 0, 1)"   # ease-out family only; never bounce/elastic
---

# Design language

## Principles

1. **One bright thing per screen.** The green accent marks the single most
   important interactive state — active tab, primary action, live progress.
   Everything else earns hierarchy through type and spacing, not color.
2. **Depth from hairlines, not shadows.** Panels separate with 1px alpha
   hairlines and at most a faint accent glow on focus. No neumorphic double
   shadows, no drop-shadow stacks, no dark glows under cards.
3. **Texture once, in the background.** A single fixed grain/particle layer
   (star-dust feel from the reference boards) may sit behind the app shell at
   very low opacity. Content surfaces stay flat and clean.
4. **Editorial moments in a utilitarian shell.** The dashboard, tree, and
   transcript are calm and dense (Schibsted, 13–16px). Page titles, empty
   states, and onboarding get the Fraunces display voice with generous space —
   that contrast *is* the brand.
5. **Numbers are mono.** Stats cards, progress values, token counts, and
   timestamps use IBM Plex Mono with tabular figures.

## Component notes

- **Vault tree** (ported from the react-aria reference): level-based indent via
  `--tree-item-level`, chevron rotates 90° in 150ms, selected row gets
  `accent-soft` fill + `hairline-accent` left rule — never a solid green row.
- **Cards**: `surface` + `hairline` border + `radius-lg`. Cards never nest
  inside cards; inner grouping uses spacing and hairline dividers.
- **Kickers**: every panel/card may carry one wide-tracked uppercase kicker in
  `text-muted`; it replaces icon-tiles above headings.
- **Buttons**: primary = accent fill with `ink-on-accent` text (dark ink in
  dark theme, light ink in light theme — see Light companion); secondary =
  surface + hairline; ghost = text only. Pill radius reserved for
  chips/filters.
- **Empty states**: the particle-vortex / light-beam art direction lives here
  (and only here) — one SVG illustration, Fraunces headline, one action.

## Light companion

Dark is the primary, original identity (`colors` above); `colors-light` is a
companion ramp so a "system" theme session on a light OS preference is never
left on an undocumented palette. Selectable via Settings → Theme (Sistem /
Açık / Koyu — system / light / dark); "system" resolves live against
`prefers-color-scheme`, not a static default.

- **Same hue family, inverted lightness.** Every surface still carries the
  faint 165° green tint (never pure white, mirroring dark's never-pure-black
  rule); the accent stays 155° green. Only the L values invert.
- **The accent had to get darker, not just the ground lighter.** Dark
  theme's accent sits at 76% L (bright-on-black); that same L fails as
  small text/icon contrast on a near-white ground, so light's accent drops
  to 50% L (4.85:1 against `ground`, clearing the 3:1 non-text floor with
  room for icon/large-text use).
- **`ink-on-accent` flips with it.** Dark ink on the accent fill (dark
  theme's rule) only reaches 3.8:1 at light's darker accent — light ink
  reaches 4.85:1 instead. Same "high-contrast ink on the fill" principle,
  opposite ink color, because the fill's own lightness inverted.
- **One bright thing per screen still holds.** The green accent is the only
  saturated color in either ramp; light does not add texture, gradients, or
  a second accent to compensate for the lower-contrast ground.

## Anti-patterns (hard rules)

- No Inter, Arial, or bare system-ui as the brand voice.
- No pure black (#000), pure white (#fff), or pure gray surfaces — always
  tinted per the ramp, dark or light.
- No purple-to-blue gradients; no gradient text.
- No cards nested in cards; no rounded icon-tile above every heading.
- No bounce/elastic easing; no animation past 300ms for UI chrome.
- No neumorphism; no gray text on colored backgrounds.
- Particle/vortex art only on hero and empty states, never behind data.

## Anti-references

Default shadcn demo look; generic SaaS landing templates; Web3 glow-card
dashboards (reference board #06 is a *mood* reference for line-work, not a
style to copy); anything that reads as a template before it reads as this app.
