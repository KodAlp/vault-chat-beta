# Remove "Open in Obsidian" deep-link; open sources in-app instead

## Context

Clicking a source citation's external-link icon in vault-chat threw Obsidian's
own "Vault not found" error. Root cause, confirmed by reading files directly:

- vault-chat no longer reads a live Obsidian folder at runtime. On first setup
  it does a one-way import (`importObsidianVault`) that copies content into its
  own `data/vaults/<id>/library/` and rewrites wikilinks to plain markdown.
  Everything is served from that copy from then on
  (`src/lib/server/vaults.ts:44-52`, `migrateVaults.ts:60-78`) — `VAULT_PATH`
  is a dead setting after the first run.
- `obsidianUri()` (`src/lib/sourceLink.ts:10-13`) built
  `obsidian://open?vault=<PUBLIC_VAULT_NAME>&file=<path>` using a hand-typed
  vault name and a path relative to the *copied* library. Reading Obsidian's
  own registry (`obsidian.json`) showed the real registered vault was a
  *different* folder than what was configured, and even if the name matched,
  the file path wouldn't resolve inside real Obsidian anyway (it's relative to
  the copy, not the original vault). There was no code anywhere that
  discovered a real Obsidian vault root (no `.obsidian`-folder walk existed).

Decision (confirmed with the user): vault-chat is its own standalone
application now. Obsidian only matters at import time
(`importObsidianVault`) — the app must never redirect the user out to
Obsidian at runtime. The "open source" button must open the markdown file
inside vault-chat's own viewer, not hand off to another app.

## Fix (applied)

**1. `src/lib/sourceLink.ts`** — deleted `obsidianUri()` and its `VAULT_NAME`/
`env` import entirely. `libraryViewerUrl()` (already in the same file) is the
only remaining/needed link builder — it already always works, reading
straight from `data/library/`.

**2. Six call sites** previously imported both `obsidianUri` and
`libraryViewerUrl` and used `obsidianUri` for a secondary "external-link icon"
href next to an existing `libraryViewerUrl` primary link (same `path`/
`vaultId` already in scope at each site). For each, dropped `obsidianUri` from
the import and repointed that icon's `href` to the same `libraryViewerUrl(path,
vaultId)` call already used on the neighboring line:
- `src/lib/components/SourceChip.svelte:45`
- `src/routes/study/cards/+page.svelte:108`
- `src/routes/study/quiz/[id]/+page.svelte:285`
- `src/routes/study/mindmap/[id]/+page.svelte:181`
- `src/routes/study/report/[id]/+page.svelte:86`
- `src/routes/study/slides/[id]/+page.svelte:109-111`

**3. Copy/labels** — replaced "Obsidian'da aç" (title/aria-label at all 6
sites, plus the `Common.obsidiandaAc` i18n key in `tr.json`/`en.json` used by
`SourceChip.svelte`) with "Kaynağı aç" (renamed key: `Common.kaynagiAc`).

**4. Settings page** (`src/routes/settings/+page.svelte:462`) — relabeled
"Obsidian'da görünen vault adı" to "Kasa adı". Left the underlying field,
Rust `VaultConfig`/IPC commands, and `PUBLIC_VAULT_NAME` plumbing untouched —
the field's one remaining real consumer is a generic default-name fallback
(`migrateVaults.ts:88`), not Obsidian-specific behavior. Also fixed the
orphan `obsidianVaultName` i18n key's value in `tr.json` for consistency.

**5. Doc/comment consistency** — updated `.env.example:17` and
`KURULUM.md:33,36`, which described `PUBLIC_VAULT_NAME` as feeding an
`obsidian://open?vault=...` link that no longer exists.

## Explicitly out of scope

- `importObsidianVault` / the "Import from Obsidian" feature
  (`src/lib/server/importObsidian.ts`, `ImportObsidianDialog.svelte`) — this
  is exactly the "we only care about Obsidian at import time" behavior to
  keep, untouched.
- `data/vaults.json` multi-vault registry, `VAULT_PATH` env, Rust
  `VaultConfig` struct/IPC (`save_vault_config_and_start`,
  `update_vault_config`, `get_vault_config` in `src-tauri/src/lib.rs`) — these
  still serve the first-run bootstrap flow and are unrelated to this fix;
  changing them risks breaking vault setup for no benefit here.

## Verification

1. `grep -rn "obsidianUri\|obsidian://" src/` returns no hits — confirmed.
2. `svelte-check` — 0 errors, 0 warnings — confirmed.
3. Manual click-through in a running dev session (`npm run dev`) still
   recommended: open a chat/quiz/flashcard/report/slide/mindmap view with
   cited sources, click each "open source" icon, confirm it navigates to the
   app's own `/library/view?...` route.
