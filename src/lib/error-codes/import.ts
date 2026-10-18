// Phase 2 owner: /api/import, /api/import/batch, /api/import/links(/scan),
// /api/import/youtube, /api/library/{attachment,file,rename,import-obsidian,
// import/[id]/confirm}, /api/system/python — link-import.ts, library.ts,
// library-read.ts, importObsidian.ts, convertQueue.ts, youtubeQueue.ts,
// webExtractQueue.ts, attachments.ts.
//
// Deliberately collapsed rather than one code per call site: CONVERSION_*
// covers both convert.py (documents/PDFs) and extract_web.py (web pages) —
// both are "a subprocess turned bytes into Markdown and this is how it
// failed", and a user gains nothing from a name that reveals which script
// ran. PDF_DAMAGED is the one exception: convert.py reports it (truncated or
// corrupt PDF) so the user is told to re-download instead of seeing a raw
// parser message. CONVERTER_CRASHED is the other: the converter process died
// natively twice in a row (one automatic retry is built in). PROCESS_TIMEOUT
// similarly covers convert.py, extract_web.py and youtube_transcript.py's
// shared 120s (or page-aware) child-process budget.
export const IMPORT_CODES = [
	'FILE_TOO_LARGE',
	'UNSUPPORTED_FILE_TYPE',
	'CONVERSION_EMPTY',
	'CONVERSION_FAILED',
	'PDF_DAMAGED',
	// Antivirus scan (av-guard.ts) found a threat in the file before conversion; params: {threat}.
	'FILE_THREAT_DETECTED',
	'CONVERTER_CRASHED',
	'PROCESS_TIMEOUT',
	'PYTHON_NOT_FOUND',
	'PYTHON_SPAWN_FAILED',
	'PYTHON_TOO_OLD',
	'PYTHON_VENV_UNAVAILABLE',
	'TRANSCRIPT_EMPTY',
	'TRANSCRIPT_FAILED',
	'LINK_INVALID',
	'LINK_PROTOCOL_UNSUPPORTED',
	'LINK_PRIVATE_NETWORK',
	'LINK_DNS_FAILED',
	'LINK_REDIRECT_INVALID',
	'LINK_TOO_MANY_REDIRECTS',
	'LINK_TIMEOUT',
	'LINK_HTTP_FAILED',
	'LINK_EMPTY_RESPONSE',
	'LINK_ROBOTS_DISALLOWED',
	'LINK_PDF_NOT_PDF',
	'LINK_ALREADY_PDF',
	'LINKS_MIN_ONE',
	'LINKS_MAX',
	'YOUTUBE_URL_INVALID',
	'PATH_OUTSIDE_LIBRARY',
	'LIBRARY_EDIT_CONFLICT',
	'LIBRARY_EDIT_FORBIDDEN',
	'LIBRARY_REVISION_NOT_FOUND',
	'RENAME_FOLDER_UNSUPPORTED',
	'FILE_EXISTS',
	'IMPORT_EXPIRED',
	// Re-import of a note (api/library/reimport): its original was not kept, or a conversion of the note is already running.
	'REIMPORT_NO_ORIGINAL',
	'REIMPORT_BUSY',
	// "Re-read one formula" (api/library/formula-repair): the block is gone from the note, the original PDF was not kept (or the
	// original is not a PDF), another repair is running, or the ingest/formula_repair.py CLI failed (codes mirror its fail codes).
	'FORMULA_REPAIR_BLOCK_NOT_FOUND',
	'FORMULA_REPAIR_NO_ORIGINAL',
	'FORMULA_REPAIR_NOT_PDF',
	'FORMULA_REPAIR_BUSY',
	'FORMULA_REPAIR_NO_CUDA',
	'FORMULA_REPAIR_BAD_PAGE',
	'FORMULA_REPAIR_NO_BOX',
	'FORMULA_REPAIR_MODEL_MISSING',
	'FORMULA_REPAIR_FAILED',
	'IMPORT_INDEX_FAILED',
	'IMPORT_SOURCE_INVALID',
	'IMPORT_NOTHING_TO_IMPORT',
	'IMPORT_ADAPTER_UNKNOWN',
	'IMPORT_ADAPTER_MISMATCH',
	'ATTACHMENT_TYPE_MISMATCH',
	'IMPORT_DUPLICATE_CONTENT',
	'IMPORT_DUPLICATE_URL',
	'IMPORT_INTERRUPTED',
	// The app tried to auto-confirm an MCP import (vault setting) and failed; the note stays pending for the user.
	'IMPORT_AUTO_CONFIRM_FAILED',
	// MCP write surface (api/mcp/**, mcp-import-path.ts): the import-path allowlist and vault exposure.
	'MCP_VAULT_NOT_EXPOSED',
	'MCP_IMPORT_ROOTS_EMPTY',
	'MCP_PATH_NOT_ALLOWED',
	'MCP_PATH_INVALID',
	// edit_note (api/mcp/notes): the developer switch is off; old_string matched nowhere / more than once.
	'MCP_EDIT_NOTE_DISABLED',
	'MCP_EDIT_NOT_FOUND',
	'MCP_EDIT_NOT_UNIQUE',
	'SCAN_ROOT_INVALID',
	'SCAN_PATH_INVALID',
	'SCAN_TOO_LARGE',
	'SCAN_EXPIRED'
] as const;
