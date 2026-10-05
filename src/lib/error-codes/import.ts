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
// ran. PROCESS_TIMEOUT similarly covers convert.py, extract_web.py and
// youtube_transcript.py's shared 120s (or page-aware) child-process budget.
export const IMPORT_CODES = [
	'FILE_TOO_LARGE',
	'UNSUPPORTED_FILE_TYPE',
	'CONVERSION_EMPTY',
	'CONVERSION_FAILED',
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
	'IMPORT_INDEX_FAILED',
	'IMPORT_SOURCE_INVALID',
	'ATTACHMENT_TYPE_MISMATCH',
	'IMPORT_DUPLICATE_CONTENT',
	'SCAN_ROOT_INVALID',
	'SCAN_PATH_INVALID',
	'SCAN_TOO_LARGE',
	'SCAN_EXPIRED'
] as const;
