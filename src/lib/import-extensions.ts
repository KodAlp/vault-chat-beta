/** Same set convert.py actually routes on (MARKITDOWN_EXTS + PDF_EXT +
 * TEX_EXT) plus .md for a source that's already Markdown — anything else is
 * something the converter would only ever fail on or mis-handle, so it's
 * rejected before a subprocess (and its memory/CPU cost) is spent on it.
 *
 * A hand-synced DUPLICATE of $lib/server/library.ts's own copy of these same
 * three exports, not a shared source of truth re-exported from there: this
 * module exists so AddFilesDialog (a client component) can import
 * the exact lists for its pre-filter preview without pulling in a server
 * module (fs/child_process, which don't bundle for the browser) — but
 * library.ts itself can't import FROM here either, because a real (value)
 * `$lib/*` import breaks `npm test`'s tsx runner outside a Vite/SvelteKit
 * context (tsx resolves `$lib` only via .svelte-kit's generated tsconfig). Update
 * BOTH copies together. */
export const ALLOWED_EXTENSIONS = new Set([
	'.pdf',
	'.docx',
	'.pptx',
	'.xlsx',
	'.html',
	'.htm',
	'.epub',
	'.tex',
	'.md'
]);

/** Kod dosyaları, Seçenek B (Aşama 11) — checked SEPARATELY from
 * ALLOWED_EXTENSIONS (not merged into it) at each upload route, not folded
 * into it: ALLOWED_EXTENSIONS's own contract above is "what convert.py's
 * document converters route on", and a code file never reaches
 * MarkItDown/docling/pandoc — it's wrapped as a fenced block instead (see
 * ingest/convert.py's CODE_EXTENSIONS, kept in sync by hand — two
 * different language runtimes, no shared module). `.html`/`.htm` stay out
 * of this set for the same reason convert.py's copy excludes them: those
 * extensions already mean "real document" via ALLOWED_EXTENSIONS. */
export const CODE_EXTENSIONS = new Set([
	'.js',
	'.ts',
	'.py',
	'.c',
	'.h',
	'.cpp',
	'.hpp',
	'.rs',
	'.sh',
	'.json',
	'.css',
	'.svelte',
	'.sql',
	'.asm',
	'.s'
]);

/** Generous enough for a large scanned PDF, small enough that one request
 * can't buffer an unbounded upload into memory — see the size check at each
 * call site, which runs BEFORE arrayBuffer() is called, not after. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
