# Bugfix Brief — Faz 0

Audience: a smaller/cheaper model working inside the vault-chat repo with
the `svelte-vault-chat` skill loaded. Fix the three bugs below IN ORDER,
one commit each. Do not refactor unrelated code. After each fix, run the
acid tests in `svelte-vault-chat` SKILL.md plus the acceptance checks here.

---

## Bug 1 — `$$` KaTeX parse error during streaming

**Symptom:** While the answer is streaming, display-math sometimes renders
as raw `$$...` text or KaTeX throws a parse error; occasionally it stays
broken after the stream ends.

**Likely root cause:** `renderMarkdown()` runs on the *accumulated partial*
text every ~50ms. When the stream has emitted the opening `$$` but not yet
the closing one, the math plugin receives an unterminated block. Depending
on the plugin, this either throws or mis-parses, and a bad intermediate
parse can leave broken markup that persists.

**Fix strategy:**
1. Add a `stabilizeForStreaming(raw: string): string` helper in
   `markdown.ts`, used ONLY on in-flight messages (final render uses raw
   text unchanged):
   - Count `$$` occurrences; if odd, cut the text at the last `$$` and
     hold the tail back (render it as dimmed plain text after the parsed
     part, or simply omit it until the block closes).
   - Same guard for an unterminated single `$` within the last line, and
     for an unclosed code fence (count ``` occurrences; if odd, append a
     temporary closing fence).
2. Verify the KaTeX plugin actually supports multi-line `$$ ... $$`
   *block* rules (not only inline). If not, switch to
   `@vscode/markdown-it-katex` or `markdown-it-texmath` (dollar mode) —
   keep `throwOnError: false` either way.
3. Ensure delimiter normalization (`\[...\]` → `$$...$$`) runs BEFORE the
   odd-count check, or a half-streamed `\[` will bypass the guard.

**Acceptance:** Stream a long derivation (e.g. ask the model to derive the
CT Fourier transform of a rectangular pulse step by step). During
streaming no raw `$$` is ever visible and no KaTeX error appears in
console; after completion, the final message renders identically to a
non-streamed render of the same text.

---

## Bug 2 — Scroll bar broken; cannot scroll back to the beginning

**Symptom:** Scrollbar only reflects the visible tail of the conversation;
scrolling up snaps back or is impossible.

**Likely root causes (check all three):**
1. An `$effect` (or `afterUpdate`) calls `scrollTo(bottom)` on EVERY state
   change — including when the user scrolled up — so the view snaps down
   on each token.
2. Wrong scroll container: the message list sits in a flex column where
   the scrolling div lacks `min-height: 0`, so it grows instead of
   scrolling and the visible scrollbar belongs to an outer element.
3. `height: 100vh` on an inner wrapper duplicating the viewport.

**Fix strategy:**
1. Exactly ONE scroll container: the message list element with
   `overflow-y: auto` and `min-height: 0` (its flex parents:
   `display:flex; flex-direction:column; height:100%`; only the outermost
   shell uses `100dvh`).
2. Introduce "stick to bottom" logic: track `isAtBottom` with a scroll
   listener (`scrollHeight - scrollTop - clientHeight < 80`). Auto-scroll
   during streaming ONLY if `isAtBottom` was true before the update. Any
   manual upward scroll disables sticking until the user returns to
   bottom.
3. Add a small "↓ en sona in" floating button that appears when
   `!isAtBottom` during streaming.

**Acceptance:** During a long streamed answer the user can scroll to the
very first message and read it while tokens keep arriving; view does not
jump. When at bottom, view follows the stream. Scrollbar range covers the
whole conversation.

---

## Bug 3 — Thought-process panel collapses the layout mid-stream

**Symptom:** Scrolling inside the thinking panel while a long answer
streams causes components to collapse: the panel bar floats to mid-screen
and the answer renders behind it.

**Likely root causes:**
1. `<think>` content is being re-parsed from the raw stream on every
   tick, toggling `{#if thinking}` blocks and re-mounting components
   (state + scroll position lost, layout thrash).
2. Unkeyed `{#each}` over messages — Svelte reuses DOM in the wrong
   places when the array updates rapidly.
3. The panel uses `position: sticky/absolute` inside the same scroll
   container as messages, with no `z-index`/height containment, so it
   detaches visually during reflow.

**Fix strategy:**
1. Parse the stream ONCE at ingestion in `Chat.svelte`'s SSE handler:
   maintain a small state machine that routes tokens into
   `message.thinking` vs `message.content` as they arrive (Qwen3 emits
   `<think>...</think>` first). `Message.svelte` receives plain fields
   and never sees raw tags. Persist `thinking` separately (Faz 1 schema
   already has the column).
2. Key the list: `{#each messages as m (m.id)}` — generate `m.id`
   client-side at creation (`crypto.randomUUID()`).
3. Rebuild the panel as a self-contained `ThinkingPanel.svelte`:
   a `<details>`-style collapsible with `max-height: 40vh;
   overflow-y: auto;` INTERNAL scrolling, normal document flow (no
   sticky/absolute), collapsed by default while streaming with a live
   token counter ("düşünüyor… 1.2k token"), expandable on click.
4. Do not animate `height` during streaming; use `content-visibility` or
   simple show/hide.

**Acceptance:** With a 30B reasoning-heavy question, expand the thinking
panel mid-stream, scroll inside it, collapse it, scroll the conversation —
no overlap, no floating bar, chat auto-scroll (Bug 2 logic) unaffected.
The panel's internal scroll never scrolls the outer conversation.

---

## Regression checklist (run after all three fixes)

- All five acid strings from `svelte-vault-chat` SKILL.md render
  correctly, streamed AND pasted whole.
- `Enter`/`Shift+Enter` behavior unchanged.
- Model switching mid-conversation still works.
- No new dependencies beyond those allowed by the skill.
