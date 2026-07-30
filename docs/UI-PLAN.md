# UI-PLAN — Phase 9 Frontend Revamp

Status: **Adım 1–4 onaylandı** (kullanıcı, 2026-07-30). Adım 5–7 ayrıca
planlanacak — bkz. `FAZ9-ADIM-1-4.md`'nin "Kapsam dışı" bölümü.
Input: kullanıcının tasarım notları + ROADMAP Faz 9.
Rule: implementation must follow this plan; deviations require updating
this file first.

## 1. Design principles

- shadcn-svelte is the base, but the app must not look "default
  shadcn". Character comes from tokens, not from modifying copied
  components: custom radius scale, one strong accent color, a real
  typographic scale, generous spacing in the transcript.
- Density: this is a daily-use study tool, not a marketing site.
  Compact controls (sm sizes) in chrome (sidebars, headers), relaxed
  spacing only in the chat column.
- Dark mode is first-class (user works mostly in dark); both themes
  ship from day one via the `.dark` token overrides.
- Motion: Svelte built-in `transition:` only (fade/slide, 100–200 ms).
  No animation library. Entry-logo animation is deferred (post-Tauri).

## 2. Theme token bridge (step 1 of migration)

| Old var        | New (shadcn) var        | Notes                       |
|----------------|--------------------------|-----------------------------|
| `--bg`         | `--background`           |                             |
| `--panel`      | `--card`                 | side panels, chips          |
| `--text`       | `--foreground`           |                             |
| `--text-dim`   | `--muted-foreground`     |                             |
| `--accent`     | `--primary`              | keep current hue, tune later|
| `--border`     | `--border`               | unchanged                   |
| (new)          | `--secondary`, `--destructive`, `--ring`, `--muted` | added with sensible derivatives |

Mechanical rename across all scoped styles; zero visual change is the
acceptance test for this step. Actual old var names must be verified
against `src/app.css` before the rename — table above is the expected
set, not a guess to be trusted blindly.

> **Doğrulama sonucu (2026-07-30):** yukarıdaki tablo tahminiydi ve
> gerçek `app.css` ile eşleşmiyor — `--panel`, `--text`, `--text-dim` hiç
> yok; gerçekleri `--fg`, `--muted`; ayrıca `--bubble-user/-assistant`,
> `--code-bg`, `--accent-fg`, `--error`, `--font-sans/-mono` var.
> Doğrulanmış gerçek eşleme ve `--accent`/`--primary` ad çakışması riski
> için bkz. `FAZ9-ADIM-1-4.md` § Adım 1.

## 3. Route map

```
/                          vault picker (or auto-redirect, see 4.1)
/vault/[id]                chat list for that vault
/vault/[id]/chat/[chatId]  main screen (three zones + study panel)
/settings                  vault-independent settings (providers, keys)
```

- Auto-redirect: if exactly one vault exists OR "remember last vault"
  is on → `/` redirects to `/vault/[lastId]`. Header vault name is a
  link back to `/`.
- Old routes get server-side redirects to the "default" vault
  equivalents (Faz 8 migration) so existing bookmarks survive.

> Bu route haritası (vault seçici, `/vault/[id]/...`) **Adım 5–7'nin**
> konusu, bu turda uygulanmıyor. Bugünkü route'lar (`/`, `/chat/[id]`)
> Adım 1–4 boyunca aynen kalıyor.

## 4. Screens

### 4.1 Vault picker — `/`

```
+--------------------------------------------------------------+
|  <logo>  vault-agent-toolkit                        [theme]  |
|                                                              |
|   +------------+  +------------+  +- - - - - - +             |
|   |  Elektronik|  |  Yazılım   |  |  + Yeni    |             |
|   |  142 kaynak|  |  87 kaynak |  |    vault   |             |
|   |  dün       |  |  2 sa önce |  |            |             |
|   +------------+  +------------+  +- - - - - - +             |
+--------------------------------------------------------------+
```

- shadcn `Card` grid; each card: name, source count, last-opened
  relative time. Dashed "new vault" card opens a `Dialog` (name +
  path input with server-side validation from Faz 8 registry).
- No separate welcome/enter page. Logo lives in this header.

### 4.2 Chat list — `/vault/[id]`

- Simple list (Card rows): chat title, last message time, active
  source scope badge ("n/m"). "New chat" `Button` top-right.
- Rename/delete via row `DropdownMenu`. Delete confirms with
  `AlertDialog`.

### 4.3 Main screen — `/vault/[id]/chat/[chatId]`

```
+--------------+------------------------------------+---------+
| ← Vault adı  |                                    | [T][K][M]|  ← study buttons
|--------------|      (chat column, centered,       |---------|
| SOURCE TREE  |       max-width ~46rem)            |  STUDY  |
| [x] math/    |                                    |  PANEL  |
|  [x] calc.md |   [3/12 kaynak aktif]              | (Sheet/ |
|  [~] lin/    |   ┌─────────────────────┐          | Resiz-  |
| [ ] os/      |   │ user bubble         │          | able,   |
|              |   └─────────────────────┘          | closed  |
|              |   assistant markdown…               | by      |
|              |   [source chips ⓘ]                  | default)|
|--------------|                                    |         |
| (avatar) ⌄   |   [composer………………][Send]           |         |
+--------------+------------------------------------+---------+
```

Zones:

- **Left top — source tree.** Tri-state checkboxes (`Checkbox` +
  custom indeterminate handling): parent shows checked / indeterminate
  / unchecked from children. Selection persists per chat
  (`included_paths`, Faz 8 API). Default: all included. Collapsible
  folders; lazy-render for large trees (>500 nodes: virtualize or
  collapse-by-default).
- **Scope indicator.** Above transcript: "n/m kaynak aktif" as a
  `Badge`; click scrolls/highlights the tree. If retrieval returns
  empty AND scope < all: inline notice with a one-click "kapsamı
  genişlet" action (checks all).
- **Left bottom.** Single avatar `Button` → `DropdownMenu`: profile
  (disabled/soon), settings, export, theme toggle.
- **Right top — study tools.** Icon `Button`s with `Tooltip`s: Test,
  Kartlar, Mindmap. Each opens the right panel (never a new route).
- **Study panel.** shadcn `Sheet` on narrow widths, `Resizable` split
  on wide; "expand to full width" toggle inside. Chat stays visible
  and interactive. Panel content mounts the existing quiz/flashcard
  components (restyled), plus new markmap-based mindmap view.
- **Transcript.** Custom components (NOT shadcn): ChatBubble,
  SourceChip (deduped by `source_path`, "×n bölüm" counter,
  `HoverCard` preview with title + first lines), ThinkingPanel,
  FallbackNotice (Faz 6 provider switch notes — styled as system
  note, distinct from assistant text), ConfidenceBadge (parses
  `[LOW]`-style tags out of the text; raw tag never renders).
- **Composer.** `Textarea` autosize + send `Button`; Enter/Shift-Enter
  behavior unchanged. Streaming state: send becomes Stop (wired to
  Faz 6 abort).

> § 4.1–4.3 **Adım 5–7'nin** konusu. Şu an mevcut olan sağ panel
> yaklaşımı UI-PLAN'in literal hali değil: "panel + route birlikte"
> kararı alındı (bkz. `FAZ9-ADIM-1-4.md`) — `/study/*` route'ları
> silinmiyor, panel onları gömecek.

### 4.4 Settings — `/settings`

- Built with shadcn from scratch (first migration target, no legacy
  conversion): provider list (`Card` per provider: enabled `Switch`,
  key status mask, test-connection `Button`, per-task default chain
  `Select`), appearance (theme), data (library paths — read-only info
  from registry).

> Bu bölüm **Adım 3**'ün konusu — kapsam artık `settings/vaults` (Faz 8)
> ve `settings/skills`/`settings/library`'yi de içeriyor, bkz.
> `FAZ9-ADIM-1-4.md` § Adım 3.

## 5. Component inventory

Copied from shadcn-svelte (keep unmodified, wrap don't edit):
`button, card, dialog, alert-dialog, dropdown-menu, tooltip, badge,
checkbox, select, switch, textarea, sheet, resizable, hover-card,
skeleton, separator, scroll-area`.

Custom (ours, use tokens + primitives):
`ChatBubble, SourceChip, SourceTree, ThinkingPanel, FallbackNotice,
ConfidenceBadge, ScopeIndicator, StudyPanel, MindmapView, VaultCard,
Composer`.

> Adım 4 doğrulaması bu listeye şunu ekliyor: beş üretim diyaloğu
> (`QuizDialog`/`CardsDialog`/`SlidesDialog`/`ReportDialog`/
> `MindMapDialog`) ve beş durum komponenti neredeyse birebir aynı —
> tek `GenerationDialog`/`GenerationStatus` + tip başına config'e
> iniyor. Detay `FAZ9-ADIM-1-4.md` § Adım 4.

## 6. Migration order

1. Token bridge rename (zero visual change) → commit.
2. Tailwind v4 + shadcn init; full visual pass for preflight
   regressions → commit.
3. `/settings` built new in shadcn (includes Faz 6 provider UI).
4. Primitives adoption: dialogs, dropdowns, tooltips app-wide.
5. Vault picker + chat list pages.
6. Main screen: tree → scope indicator → study panel → transcript
   components last (highest risk, most custom).
7. Visual-bug closure: UTF-8 encoding fix verification in UI,
   ConfidenceBadge, SourceChip dedup.

Each numbered step = at least one commit; steps 3–6 each end with a
manual smoke pass in both themes.

> **Bu oturumda uygulanan kapsam: 1–4.** 5–7 bu planın dışında, ayrıca
> planlanacak. Adım 7'deki "UTF-8 encoding fix" maddesi doğrulamada
> **yeniden üretilemedi** (gerçek `chats.db`'de mojibake işareti yok) —
> somut bir repro gelmeden ayrı iş açılmayacak. `[LOW]` etiketi ve kaynak
> çipi tekrarı bug'ları gerçek ve doğrulandı, ama transkript komponentleri
> (Adım 6) yazılmadan kapatılamaz.

## 7. Open questions (answered — see below, superseded by user's answers)

1. ~~Accent color: keep current hue or pick a new one during token
   bridge?~~ → **Cevaplandı: indigo kalıyor**, sadece ince ayar.
2. ~~"Remember last vault" default: on or off?~~ → Adım 5'in konusu,
   bu turda karar verilmiyor.
3. ~~Mindmap: per-note or per-topic?~~ → **Geçersiz soru.** Mindmap
   Faz 7'de zaten yazıldı, retrieval-driven (per-topic), markmap ile
   render ediliyor. Değiştirilmiyor.
4. ~~Export: chat, study artifacts, or both?~~ → **Cevaplandı: sadece
   sohbet** (mevcut `/api/chats/[id]/export`, md/json). Study artifact
   dışa aktarımı bu fazın kapsamında değil.
