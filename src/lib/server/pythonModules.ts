/** Turns ingest/requirements.txt into the list of top-level
 * Python import names this app needs to be able to `import` at runtime.
 * Pure/pulled out of the /api/system/python route so it's unit-testable
 * without spawning python, and so the route's "one process checks every
 * module" script (see that route) and PythonStatusBanner's "any missing
 * required module" rule both read from the exact same parse instead of a
 * hand-maintained duplicate list that could drift from the pinned file.
 */

export interface PythonModuleSpec {
	/** The PyPI/distribution name exactly as pinned in requirements.txt
	 * (extras marker and version stripped), e.g. "py-asciimath". */
	distName: string;
	/** The name this app actually `import`s, e.g. "py_asciimath". */
	importName: string;
}

/**
 * Distribution names whose top-level import name is NOT simply
 * dash-to-underscore of the PyPI name (e.g. a package whose import name has
 * nothing in common with its PyPI name at all). None of this repo's
 * currently pinned packages need an entry here — markitdown, yt-dlp ->
 * yt_dlp, trafilatura, py-asciimath -> py_asciimath and pypdf all follow the
 * plain rule — but this map is the seam for the next dependency that
 * doesn't, instead of hardcoding a special case into the parse itself.
 */
const IMPORT_NAME_OVERRIDES: Record<string, string> = {};

function distNameToImportName(distName: string): string {
	return IMPORT_NAME_OVERRIDES[distName] ?? distName.replace(/-/g, '_');
}

/**
 * Parses a pip-requirements-style text (comments, blank lines, extras
 * markers like `[all]`, and version pins all stripped) into the import
 * names this app needs. Only reads the dist-name token at the start of each
 * line — it does not attempt to resolve `-r other.txt` includes or
 * environment markers, since ingest/requirements.txt uses neither.
 */
export function parseRequirementsImportNames(text: string): PythonModuleSpec[] {
	const out: PythonModuleSpec[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.split('#')[0].trim();
		if (!line) continue;
		const m = /^([A-Za-z0-9._-]+)/.exec(line);
		if (!m) continue;
		const distName = m[1];
		out.push({ distName, importName: distNameToImportName(distName) });
	}
	return out;
}

/**
 * Builds a single Python `-c` script that tries importing every name in
 * `importNames` independently (so one broken/missing module can't blank out
 * the report for the rest, the way a single `import a, b, c` statement
 * would) and prints one JSON object `{name: boolean}` to stdout — checking
 * every module in ONE python process instead of spawning one per module.
 * `importNames` must already be validated identifiers (this app's own,
 * fixed requirements.txt — never arbitrary/user-controlled text) since they
 * are embedded directly into the generated source.
 */
export function buildModuleCheckScript(importNames: string[]): string {
	const lines = importNames.map((name) => {
		const literal = JSON.stringify(name);
		return `try:\n    __import__(${literal})\n    results[${literal}] = True\nexcept Exception:\n    results[${literal}] = False`;
	});
	return ['import json', 'results = {}', ...lines, 'print(json.dumps(results))'].join('\n');
}
