// adapter-node's build step (node_modules/@sveltejs/adapter-node/index.js)
// token-replaces ENV_PREFIX/BASE/PRECOMPRESS/PRERENDERED into its bundled
// server entrypoints via @rollup/plugin-replace, whose `include` filter
// does glob matching on the absolute output path. This repo's folder name
// contains literal parentheses ("First brain(Software based)"), which glob
// engines treat as extglob group syntax — the include pattern silently
// fails to match, so the replacement never runs and the built server ships
// with the literal, unresolved token identifiers, crashing immediately on
// `node build` ("ReferenceError: ENV_PREFIX/BASE/PRECOMPRESS/PRERENDERED is
// not defined"). Verified directly: @rollup/pluginutils's
// createFilter([entriesDir + '/**']) returns false for a file under this
// exact path. Root cause is upstream (path-glob interaction with special
// characters in the folder name), not fixable via svelte.config.js — this
// patches in the exact values adapter-node's own defaults would have
// produced (envPrefix: '', precompress: true) plus this build's actual
// zero prerendered routes (confirmed via .svelte-kit/output/server/
// manifest.js's `prerendered_routes: new Set([])` — expected, since
// +layout.ts sets `ssr = false` app-wide, and prerendering requires SSR).
//
// Scans build/*.js and build/server/**/*.js (chunk filenames are content-
// hashed, so no fixed path) — deliberately excludes build/client/, whose
// Vite-bundled dependencies can coincidentally contain the substring
// "BASE" (e.g. a PATHINFO_BASENAME constant list in some bundled lib) with
// nothing to do with this token-replace step.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const buildDir = path.join(process.cwd(), 'build');

const REPLACEMENTS = [
	{ pattern: /\bENV_PREFIX\b/g, value: '""', label: 'ENV_PREFIX -> ""' },
	{ pattern: /\bBASE\b/g, value: '""', label: 'BASE -> ""' },
	{ pattern: /\bPRECOMPRESS\b/g, value: 'true', label: 'PRECOMPRESS -> true' },
	{ pattern: /\bPRERENDERED\b/g, value: 'new Set([])', label: 'PRERENDERED -> new Set([])' }
];

function* walkJsFiles(dir) {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			yield* walkJsFiles(full);
		} else if (entry.endsWith('.js')) {
			yield full;
		}
	}
}

const targets = [
	...['env.js', 'handler.js', 'index.js', 'shims.js']
		.map((f) => path.join(buildDir, f))
		.filter((f) => statSync(f, { throwIfNoEntry: false })),
	...(statSync(path.join(buildDir, 'server'), { throwIfNoEntry: false })
		? [...walkJsFiles(path.join(buildDir, 'server'))]
		: [])
];

let patchedCount = 0;
for (const file of targets) {
	const raw = readFileSync(file, 'utf-8');
	let text = raw;
	const hits = [];
	for (const { pattern, value, label } of REPLACEMENTS) {
		if (pattern.test(text)) {
			pattern.lastIndex = 0;
			text = text.replace(pattern, value);
			hits.push(label);
		}
	}
	if (hits.length > 0) {
		writeFileSync(file, text, 'utf-8');
		console.log(`Patched ${path.relative(process.cwd(), file)}: ${hits.join(', ')}`);
		patchedCount++;
	}
}

if (patchedCount === 0) {
	console.log('No unresolved adapter-node tokens found — nothing to patch.');
}
