// Bundles the MCP server into ONE ESM file that runs with plain `node` — no tsx, no repo, no devDependencies.
// Output: dist-server/mcp/vault-chat-mcp.mjs (stage-server.mjs calls this; `npm run build:mcp` does it alone).
//
// Why a bundle: mcp/server.ts imports src/lib/server/* as TypeScript and needs tsx (a devDependency) plus the
// source tree; the packaged app ships neither. @modelcontextprotocol/sdk is a devDependency too, so it is
// bundled in rather than resolved from dist-server/node_modules (`npm ci --omit=dev` does not install it).
//
// Externals (resolved at runtime from dist-server/node_modules, both are production dependencies):
//  - better-sqlite3: native .node binary located through `bindings` (file lookups relative to its own package);
//  - sqlite-vec: picks the platform package (sqlite-vec-<os>-<arch>) holding the vec0 loadable extension.
// Anything else in the graph is pure JS. `import.meta.url`/__dirname lookups: none exist in the MCP import
// graph (verified by grep of the built output); cwd-relative lookups
// (data/providers.json fallback) are handled by mcp/bundle-entry.mjs pinning cwd to the server root.
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_BUNDLE_RELATIVE = path.join('mcp', 'vault-chat-mcp.mjs');
export const MCP_EXTERNALS = ['better-sqlite3', 'sqlite-vec'];

// The desktop app requires Node 22 (package.json engines, src-tauri resolve_and_verify_node).
const NODE_TARGET = 'node22';

/** Bundles into <outDir>/mcp/vault-chat-mcp.mjs. Returns the file path, its size and the esbuild metafile. */
export async function buildMcpBundle({ root = process.cwd(), outDir = path.join(root, 'dist-server') } = {}) {
	const { build } = await import('esbuild');
	const outfile = path.join(outDir, MCP_BUNDLE_RELATIVE);
	mkdirSync(path.dirname(outfile), { recursive: true });
	const result = await build({
		absWorkingDir: root,
		entryPoints: [path.join(root, 'mcp', 'bundle-entry.mjs')],
		outfile,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: NODE_TARGET,
		external: MCP_EXTERNALS,
		// `$lib/x` -> src/lib/x (SvelteKit's alias, used by a few server modules).
		alias: { $lib: path.join(root, 'src', 'lib') },
		// Some CJS dependencies (ajv, gray-matter/js-yaml) call require() at runtime; an ESM bundle has no
		// `require`, so provide one. Named with a prefix to never clash with a bundled identifier.
		banner: {
			js: "import { createRequire as __vcCreateRequire } from 'node:module';\nconst require = __vcCreateRequire(import.meta.url);"
		},
		metafile: true,
		legalComments: 'none',
		logLevel: 'warning'
	});
	return { outfile, size: statSync(outfile).size, metafile: result.metafile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { outfile, size } = await buildMcpBundle();
	console.log(`MCP bundle: ${path.relative(process.cwd(), outfile)} (${(size / 1024).toFixed(0)} KiB)`);
}
