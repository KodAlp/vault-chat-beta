import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * End-to-end test of the WHOLE MCP pipeline, run via `npm run mcp:e2e -- --notebook <dir> [flags]`.
 * Deliberately NOT part of `npm test` / `npm run mcp:smoke`: it needs a live Ollama (bge-m3), docling
 * (PDF conversion) and takes minutes.
 *
 * REAL here: the Vault Chat dev server (vite dev, own port), the stdio MCP server (mcp/launch.mjs,
 * spawned the way Claude Desktop/Code would), the app's HTTP API between them, docling conversion, the
 * staging area, bge-m3 embeddings through Ollama and the sqlite-vec index.
 *
 * SIMULATED here: exactly the two USER actions that an MCP client can not (and must not be able to) do:
 *   1. allowing a folder for MCP file imports  (PUT /api/settings/mcp)
 *   2. confirming a pending import in the app   (POST /api/library/import/<id>/confirm)
 * Both are plain fetch calls with no Origin header, standing in for the user's browser.
 *
 * ISOLATION: every data path (DATA_DIR, chats.db, providers, secrets, ...) is pointed into a scratch
 * directory; LIBRARY_PATH/VAULT_PATH/session+MCP tokens are removed from the child env. The real data
 * folders (this checkout's and, for a worktree, the main checkout's) are fingerprinted before, right
 * after the first request and at the end: any change is a hard failure.
 */

// ---------------------------------------------------------------- args

interface Args {
	notebook: string;
	ollama: string;
	url?: string;
	noPdf: boolean;
	port: number;
	scratch: string;
	convertTimeoutMin: number;
	keepApp: boolean;
	/** 'bge-m3' = vector + keyword index through Ollama; 'none' = the fresh-install default (providers.default.json has embedding: null), keyword/FTS only. */
	embedding: 'bge-m3' | 'none';
}

const USAGE = `Usage: npm run mcp:e2e -- --notebook <dir> [options]

  --notebook <dir>            REQUIRED. Root of the source folder (contains "Bilgisayar Mühendisliği" and "Matematik")
  --ollama <url>              Temporary Ollama with bge-m3 (default http://127.0.0.1:11435; start it with
                              OLLAMA_HOST=127.0.0.1:11435 ollama serve, then ollama pull bge-m3 against it)
  --url <url>                 Also import this web page / PDF URL (domain "web"); failure is soft
  --no-pdf                    Skip the PDF import
  --port <n>                  Dev server port (default 5199)
  --scratch <dir>             Scratch directory (default: a fresh temp dir)
  --convert-timeout-min <n>   Max minutes to wait for conversions (default 20)
  --keep-app                  Do not kill the dev server at the end
  --embedding <bge-m3|none>   Index mode (default bge-m3). "none" keeps providers.default.json's keyword-only default`;

function parseArgs(argv: string[]): Args | null {
	const args: Args = {
		notebook: '',
		ollama: 'http://127.0.0.1:11435',
		noPdf: false,
		port: 5199,
		scratch: '',
		convertTimeoutMin: 20,
		keepApp: false,
		embedding: 'bge-m3'
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} needs a value`);
			return v;
		};
		switch (a) {
			case '--notebook':
				args.notebook = next();
				break;
			case '--ollama':
				args.ollama = next().replace(/\/+$/, '');
				break;
			case '--url':
				args.url = next();
				break;
			case '--no-pdf':
				args.noPdf = true;
				break;
			case '--port':
				args.port = Number(next());
				break;
			case '--scratch':
				args.scratch = next();
				break;
			case '--convert-timeout-min':
				args.convertTimeoutMin = Number(next());
				break;
			case '--keep-app':
				args.keepApp = true;
				break;
			case '--embedding': {
				const v = next();
				if (v !== 'bge-m3' && v !== 'none') throw new Error('--embedding must be bge-m3 or none');
				args.embedding = v;
				break;
			}
			default:
				throw new Error(`unknown argument: ${a}`);
		}
	}
	if (!args.notebook) return null;
	if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('--port must be 1..65535');
	if (!(args.convertTimeoutMin > 0)) throw new Error('--convert-timeout-min must be > 0');
	return args;
}

// ---------------------------------------------------------------- steps / report

interface StepRecord {
	id: string;
	actor: 'mcp' | 'user-sim' | 'check';
	title: string;
	ok: boolean;
	hard: boolean;
	skipped: boolean;
	ms: number;
	detail: string;
}

class SkipStep extends Error {}

const steps: StepRecord[] = [];

async function step(
	id: string,
	actor: StepRecord['actor'],
	title: string,
	hard: boolean,
	fn: () => Promise<string | void>
): Promise<StepRecord> {
	const start = Date.now();
	let rec: StepRecord;
	try {
		const detail = (await fn()) ?? '';
		rec = { id, actor, title, ok: true, hard, skipped: false, ms: Date.now() - start, detail };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const skipped = err instanceof SkipStep;
		rec = { id, actor, title, ok: false, hard, skipped, ms: Date.now() - start, detail: message };
	}
	steps.push(rec);
	const label = rec.skipped ? 'skip' : rec.ok ? 'ok' : rec.hard ? 'FAIL' : 'soft';
	console.log(`${label} - [${id}] (${actor}) ${title}${rec.detail ? ` — ${rec.detail}` : ''}`);
	return rec;
}

function must(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- MCP calls

interface ToolResult {
	isError: boolean;
	text: string;
	json?: any;
}

let client: Client | null = null;

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
	if (!client) throw new Error('MCP client is not connected');
	const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
	const content = (res.content ?? []) as { type: string; text?: string }[];
	const text = content[0]?.text ?? '';
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		// error results are "CODE: message", not JSON
	}
	return { isError: res.isError === true, text, json };
}

function expectCode(r: ToolResult, code: string): string {
	must(r.isError, `expected ${code}, but the call succeeded: ${r.text.slice(0, 200)}`);
	must(r.text.startsWith(`${code}:`), `expected ${code}, got: ${r.text.slice(0, 200)}`);
	return r.text.split(':')[0];
}

// ---------------------------------------------------------------- user-sim (fetch, no Origin header)

let appUrl = '';

async function appFetch(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await fetch(`${appUrl}${route}`, {
		method,
		headers: body !== undefined ? { 'content-type': 'application/json' } : {},
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(10 * 60_000)
	});
	let json: unknown = null;
	try {
		json = await res.json();
	} catch {
		// non-JSON body
	}
	return { status: res.status, json };
}

// ---------------------------------------------------------------- isolation guard

const GUARD_FILES = ['chats.db', 'chats.db-wal', 'vaults.json', 'mcp-log.jsonl', 'app-log.jsonl', 'mcp-endpoint.json', 'mcp-settings.json'];

function realDataDirs(repoRoot: string): string[] {
	const dirs = [path.join(repoRoot, 'data')];
	const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
	const at = repoRoot.indexOf(marker);
	if (at > 0) dirs.push(path.join(repoRoot.slice(0, at), 'data'));
	return dirs;
}

function snapshotReal(dirs: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const dir of dirs) {
		for (const f of GUARD_FILES) {
			const p = path.join(dir, f);
			try {
				const st = fs.statSync(p);
				out[p] = `size=${st.size} mtimeMs=${st.mtimeMs}`;
			} catch {
				out[p] = 'absent';
			}
		}
	}
	return out;
}

function diffSnapshots(before: Record<string, string>, after: Record<string, string>): string[] {
	return Object.keys(before)
		.filter((p) => before[p] !== after[p])
		.map((p) => `${p}: ${before[p]} -> ${after[p]}`);
}

// ---------------------------------------------------------------- process helpers

function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (!pid) return;
	if (process.platform === 'win32') {
		spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
	} else {
		try {
			process.kill(-pid, 'SIGTERM');
		} catch {
			try {
				child.kill('SIGTERM');
			} catch {
				// already gone
			}
		}
	}
}

function tail(file: string, lines = 40): string {
	try {
		return fs.readFileSync(file, 'utf-8').split('\n').slice(-lines).join('\n');
	} catch {
		return '(no log)';
	}
}

function walkMd(dir: string, skipDir = '_meta'): string[] {
	const out: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== skipDir) out.push(...walkMd(full, skipDir));
		} else if (e.name.toLowerCase().endsWith('.md')) out.push(full);
	}
	return out;
}

// ---------------------------------------------------------------- fixtures

interface Fixture {
	key: 'md' | 'pdf' | 'url';
	label: string;
	file?: string;
	url?: string;
	domain: string;
	title: string;
	/** library note path once confirmed */
	confirmedPath?: string;
	importId?: string;
	level?: string;
}

interface SearchRecord {
	query: string;
	expected: string;
	rank: number | null;
	top3: { path: string; score: number }[];
	pass: boolean;
	hard: boolean;
}

// ---------------------------------------------------------------- main

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');

async function main(): Promise<number> {
	let args: Args | null;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
		return 2;
	}
	if (!args) {
		console.error(`--notebook is required.\n\n${USAGE}`);
		return 2;
	}
	const notebook = path.resolve(args.notebook);
	const allowedRoot = path.join(notebook, 'Bilgisayar Mühendisliği');
	const files = {
		md: path.join(allowedRoot, 'Derleyici tasarımı', 'craftinginterpreters', 'book', 'a-map-of-the-territory.md'),
		pdf: path.join(allowedRoot, 'Algoritmalar', 'raft.pdf'),
		outside: path.join(notebook, 'Matematik', 'calculus-volume-1_-_WEB.pdf')
	};
	const missing = [allowedRoot, files.md, ...(args.noPdf ? [] : [files.pdf]), files.outside].filter((p) => !fs.existsSync(p));
	if (missing.length > 0) {
		console.error(`Missing fixture(s) under --notebook:\n${missing.map((m) => `  ${m}`).join('\n')}`);
		return 2;
	}

	// Preflight: Ollama must be reachable and have bge-m3 BEFORE anything is spawned (only when it will be used).
	if (args.embedding === 'bge-m3') try {
		const res = await fetch(`${args.ollama}/api/tags`, { signal: AbortSignal.timeout(10_000) });
		must(res.ok, `HTTP ${res.status}`);
		const tags = (await res.json()) as { models?: { name?: string }[] };
		const names = (tags.models ?? []).map((m) => m.name ?? '');
		must(names.some((n) => n.startsWith('bge-m3')), `no bge-m3 model listed (found: ${names.join(', ') || 'none'})`);
	} catch (err) {
		console.error(
			`Ollama preflight failed at ${args.ollama}: ${err instanceof Error ? err.message : String(err)}\n` +
				`Start a temporary instance with:  OLLAMA_HOST=127.0.0.1:11435 ollama serve\n` +
				`and pull the embedding model into it:  OLLAMA_HOST=127.0.0.1:11435 ollama pull bge-m3`
		);
		return 2;
	}

	const scratch = path.resolve(args.scratch || fs.mkdtempSync(path.join(os.tmpdir(), 'vault-chat-mcp-e2e-')));
	const dataDir = path.join(scratch, 'data');
	fs.mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
	appUrl = `http://127.0.0.1:${args.port}`;

	const realDirs = realDataDirs(repoRoot);
	const guardBefore = snapshotReal(realDirs);

	// providers.json = the default file with only the Ollama base URL swapped.
	const providers = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'providers.default.json'), 'utf-8')) as {
		providers: { id: string; baseUrl: string }[];
		embedding?: unknown;
	};
	const ollamaEntry = providers.providers.find((p) => p.id === 'ollama');
	must(ollamaEntry, 'data/providers.default.json has no "ollama" entry');
	ollamaEntry.baseUrl = args.ollama;
	// What the user picks in the setup wizard. Ollama is local, so no cloud-consent record is needed.
	providers.embedding = args.embedding === 'bge-m3' ? { providerId: 'ollama', model: 'bge-m3', dims: 1024 } : null;
	fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify(providers, null, 2));

	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	for (const k of ['LIBRARY_PATH', 'VAULT_PATH', 'VC_SESSION_TOKEN', 'VC_MCP_TOKEN']) delete env[k];
	Object.assign(env, {
		DATA_DIR: dataDir,
		CHATS_DB_PATH: path.join(dataDir, 'chats.db'),
		INDEX_DB_PATH: path.join(dataDir, 'legacy-vault-index.db'),
		STUDY_DB_PATH: path.join(dataDir, 'legacy-study.db'),
		SKILLS_DIR: path.join(dataDir, 'skills'),
		PROVIDERS_PATH: path.join(dataDir, 'providers.json'),
		SECRETS_PATH: path.join(dataDir, 'secrets.json'),
		PROVIDER_CONSENT_PATH: path.join(dataDir, 'provider-consent.json'),
		MODEL_CATALOG_PATH: path.join(dataDir, 'model-catalog.json')
	});

	const devLog = path.join(scratch, 'dev-server.log');
	const mcpErrLog = path.join(scratch, 'mcp-stderr.log');
	const reportJson = path.join(scratch, 'report.json');
	const reportMd = path.join(scratch, 'report.md');

	console.log(`scratch: ${scratch}\napp:     ${appUrl}\nollama:  ${args.ollama}`);

	let dev: ChildProcess | null = null;
	let vaultId = '';
	const fixtures: Fixture[] = [
		{ key: 'md', label: 'Markdown', file: files.md, domain: 'derleyici-tasarimi', title: 'Crafting Interpreters - A Map of the Territory' }
	];
	if (!args.noPdf) {
		fixtures.push({
			key: 'pdf',
			label: 'PDF',
			file: files.pdf,
			domain: 'dagitik-sistemler',
			title: 'Raft - In Search of an Understandable Consensus Algorithm'
		});
	}
	if (args.url) fixtures.push({ key: 'url', label: 'URL', url: args.url, domain: 'web', title: 'Web import' });
	const fx = (key: Fixture['key']) => fixtures.find((f) => f.key === key);

	const searches: SearchRecord[] = [];
	const transitions: string[] = [];
	const convertTimes: { key: string; label: string; seconds: number | null; status: string }[] = [];
	const confirmTimes: { key: string; ms: number; path: string }[] = [];
	let guardAfterFirst: string[] = [];
	let guardAtEnd: string[] = [];
	let endpointCleaned: boolean | null = null;
	const warnings: string[] = [];

	const needVault = () => {
		if (!vaultId) throw new SkipStep('skipped: create_vault did not produce a vault');
	};
	const vaultLibrary = () => path.join(dataDir, 'vaults', vaultId, 'library');

	try {
		// ---- start the app
		dev = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'dev', '--port', String(args.port), '--strictPort'], {
			cwd: repoRoot,
			env,
			stdio: ['ignore', fs.openSync(devLog, 'a'), fs.openSync(devLog, 'a')],
			detached: process.platform !== 'win32',
			windowsHide: true
		});
		let devExit: number | null | undefined;
		dev.on('exit', (code) => {
			devExit = code;
		});

		const endpointFile = path.join(dataDir, 'mcp-endpoint.json');
		const deadline = Date.now() + 180_000;
		let mcpToken = '';
		for (;;) {
			if (devExit !== undefined) throw new Error(`dev server exited early (code ${devExit}). Log tail:\n${tail(devLog)}`);
			if (Date.now() > deadline) throw new Error(`dev server did not become ready within 180 s. Log tail:\n${tail(devLog)}`);
			try {
				const info = JSON.parse(fs.readFileSync(endpointFile, 'utf-8')) as { mcpToken?: string };
				if (info.mcpToken) {
					mcpToken = info.mcpToken;
					const res = await fetch(`${appUrl}/api/mcp/ping`, {
						headers: { 'x-vc-mcp-token': mcpToken },
						signal: AbortSignal.timeout(5000)
					});
					if (res.ok) break;
				}
			} catch {
				// not ready yet
			}
			await sleep(1000);
		}
		console.log('ok - dev server answers /api/mcp/ping');

		guardAfterFirst = diffSnapshots(guardBefore, snapshotReal(realDirs));
		if (guardAfterFirst.length > 0) {
			console.error(`!!!! ISOLATION BREACH right after startup — real data changed:\n${guardAfterFirst.join('\n')}`);
			throw new Error('isolation breach at startup; stopping before any MCP call');
		}

		// ---- connect MCP over real stdio
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [path.join(repoRoot, 'mcp', 'launch.mjs')],
			env,
			stderr: 'pipe'
		});
		const errStream = fs.createWriteStream(mcpErrLog, { flags: 'a' });
		transport.stderr?.pipe(errStream);
		client = new Client({ name: 'vault-chat-e2e', version: '0.0.0' });
		await client.connect(transport);

		// 1. tools/list
		await step('1', 'mcp', 'tools/list: exactly the 7 tools', true, async () => {
			const { tools } = await client!.listTools();
			const names = tools.map((t) => t.name).sort();
			const want = ['create_vault', 'get_note', 'import_source', 'list_pending_imports', 'list_sources', 'list_vaults', 'search_library'];
			must(JSON.stringify(names) === JSON.stringify(want), `got ${names.join(', ')}`);
			return names.join(', ');
		});

		// 2. list_vaults on a fresh data dir
		let defaultExists = false;
		let defaultExposed = false;
		await step('2', 'mcp', 'list_vaults on a fresh install', false, async () => {
			const r = await callTool('list_vaults');
			must(!r.isError, r.text);
			const visible = (r.json.vaults as { id: string }[]).map((v) => v.id);
			try {
				const reg = JSON.parse(fs.readFileSync(path.join(dataDir, 'vaults.json'), 'utf-8')) as {
					vaults: { id: string; mcpExposed?: boolean }[];
				};
				const d = reg.vaults.find((v) => v.id === 'default');
				defaultExists = d !== undefined;
				defaultExposed = d?.mcpExposed === true;
			} catch {
				// no registry yet
			}
			return `visible to MCP: [${visible.join(', ')}]; 'default' vault exists=${defaultExists}, exposed=${defaultExposed}`;
		});

		// 3. create_vault
		await step('3', 'mcp', 'create_vault "MCP Hat Denemesi"', true, async () => {
			const r = await callTool('create_vault', { name: 'MCP Hat Denemesi' });
			must(!r.isError, r.text);
			must(typeof r.json?.vault === 'string' && r.json.vault.length > 0, `no vault id in: ${r.text}`);
			vaultId = r.json.vault;
			const list = await callTool('list_vaults');
			must(!list.isError, list.text);
			must((list.json.vaults as { id: string }[]).some((v) => v.id === vaultId), 'new vault missing from list_vaults');
			return `vault id = ${vaultId}`;
		});

		// 4. before any allowed root
		await step('4', 'mcp', 'import_source before any allowed folder -> MCP_IMPORT_ROOTS_EMPTY', true, async () => {
			needVault();
			return expectCode(await callTool('import_source', { vault: vaultId, path: files.md }), 'MCP_IMPORT_ROOTS_EMPTY');
		});

		// 5. user allows the folder
		await step('5', 'user-sim', 'user allows the "Bilgisayar Mühendisliği" folder (PUT /api/settings/mcp)', true, async () => {
			const put = await appFetch('PUT', '/api/settings/mcp', { allowedImportRoots: [allowedRoot] });
			must(put.status === 200, `PUT answered ${put.status}: ${JSON.stringify(put.json)}`);
			const get = await appFetch('GET', '/api/settings/mcp');
			const roots = (get.json?.allowedImportRoots ?? []) as string[];
			must(get.status === 200 && roots.length === 1, `GET shows ${JSON.stringify(get.json)}`);
			return `stored root: ${roots[0]}`;
		});

		// 6. outside the allowed root
		await step('6', 'mcp', 'import_source outside the allowed folder -> MCP_PATH_NOT_ALLOWED', true, async () => {
			needVault();
			return expectCode(await callTool('import_source', { vault: vaultId, path: files.outside }), 'MCP_PATH_NOT_ALLOWED');
		});

		// 7. traversal / relative paths must never succeed
		await step('7', 'mcp', 'import_source with ".." segment and with a relative path -> MCP_PATH_INVALID', true, async () => {
			needVault();
			const dotted = `${allowedRoot}${path.sep}Algoritmalar${path.sep}..${path.sep}Algoritmalar${path.sep}raft.pdf`;
			const notes: string[] = [];
			for (const [label, p] of [
				['".." path', dotted],
				['relative path', 'raft.pdf']
			] as const) {
				const r = await callTool('import_source', { vault: vaultId, path: p });
				must(r.isError, `${label} SUCCEEDED (security failure): ${r.text.slice(0, 200)}`);
				const code = r.text.split(':')[0];
				notes.push(`${label} -> ${code}`);
				if (code !== 'MCP_PATH_INVALID') warnings.push(`step 7: ${label} answered ${code}, spec expected MCP_PATH_INVALID`);
			}
			return notes.join('; ');
		});

		// 8. a vault that is not exposed must be refused before any fetch
		await step('8', 'mcp', "import_source into the unexposed 'default' vault -> VAULT_NOT_EXPOSED", true, async () => {
			if (!defaultExists) throw new SkipStep("skipped: no 'default' vault in this fresh registry");
			if (defaultExposed) throw new SkipStep("skipped: 'default' vault is exposed to MCP, nothing to test");
			return expectCode(
				await callTool('import_source', { vault: 'default', url: 'https://example.invalid/vault-not-exposed-probe' }),
				'VAULT_NOT_EXPOSED'
			);
		});

		// 9. the real imports
		await step('9', 'mcp', 'import_source: queue md / pdf / url into the new vault', true, async () => {
			needVault();
			const notes: string[] = [];
			for (const f of fixtures) {
				const r = await callTool('import_source', {
					vault: vaultId,
					...(f.file ? { path: f.file } : { url: f.url }),
					domain: f.domain,
					title: f.title
				});
				if (r.isError) {
					if (f.key === 'url') {
						warnings.push(`url import could not be queued: ${r.text.slice(0, 200)}`);
						notes.push(`${f.key}: NOT queued (${r.text.split(':')[0]})`);
						continue;
					}
					throw new Error(`${f.key}: ${r.text.slice(0, 300)}`);
				}
				must(r.json.status === 'queued' && typeof r.json.importId === 'string', `${f.key}: unexpected ${r.text}`);
				f.importId = r.json.importId;
				notes.push(`${f.key}: ${f.importId} queued`);
			}
			must(fixtures.filter((f) => f.key !== 'url').every((f) => f.importId), 'a required import was not queued');
			return notes.join('; ');
		});

		// 10. nothing in the library, nothing indexed yet
		await step('10', 'check', 'before any confirm: no notes in the library, list_sources/search_library report NOT_INDEXED', true, async () => {
			needVault();
			const mdFiles = walkMd(vaultLibrary());
			must(mdFiles.length === 0, `library already holds ${mdFiles.length} .md file(s): ${mdFiles.join(', ')}`);
			const notes = ['library empty'];
			const sources = await callTool('list_sources', { vault: vaultId });
			if (sources.isError) {
				expectCode(sources, 'NOT_INDEXED');
				notes.push('list_sources -> NOT_INDEXED');
			} else {
				must((sources.json?.sources ?? []).length === 0, `list_sources returned data: ${sources.text.slice(0, 200)}`);
				notes.push('list_sources -> empty result');
			}
			const search = await callTool('search_library', { vault: vaultId, query: 'raft consensus', k: 3 });
			if (search.isError) {
				expectCode(search, 'NOT_INDEXED');
				notes.push('search_library -> NOT_INDEXED');
			} else {
				must((search.json?.results ?? []).length === 0, `search_library returned data: ${search.text.slice(0, 200)}`);
				notes.push('search_library -> empty result');
			}
			return notes.join('; ');
		});

		// 11. poll until everything is ready / error
		const proposedOf = new Map<string, { title: string; domain: string; level: string }>();
		await step('11', 'mcp', 'poll list_pending_imports until every import is ready or error', true, async () => {
			needVault();
			const tracked = fixtures.filter((f) => f.importId);
			const last = new Map<string, string>();
			const readyAt = new Map<string, number>();
			const errors = new Map<string, string>();
			const t0 = Date.now();
			const limit = t0 + args!.convertTimeoutMin * 60_000;
			for (;;) {
				const r = await callTool('list_pending_imports', { vault: vaultId });
				must(!r.isError, r.text);
				const items = (r.json.imports ?? []) as {
					importId: string;
					status: string;
					proposed?: { title: string; domain: string; level: string };
					warnings?: string[];
					error?: { code: string; params?: unknown };
				}[];
				const elapsed = Math.round((Date.now() - t0) / 1000);
				for (const f of tracked) {
					const it = items.find((i) => i.importId === f.importId);
					const status = it?.status ?? 'missing';
					if (last.get(f.key) !== status) {
						transitions.push(`${f.key}: ${last.get(f.key) ?? '-'} -> ${status} @ ${elapsed}s`);
						console.log(`   ${f.key}: ${status} @ ${elapsed}s`);
						last.set(f.key, status);
					}
					if (it?.proposed) proposedOf.set(f.key, it.proposed);
					if (status === 'ready' && !readyAt.has(f.key)) {
						readyAt.set(f.key, elapsed);
						if (it?.warnings?.length) warnings.push(`${f.key} warnings: ${it.warnings.join(', ')}`);
					}
					if (status === 'error') errors.set(f.key, JSON.stringify(it?.error ?? {}));
				}
				if (tracked.every((f) => ['ready', 'error'].includes(last.get(f.key) ?? ''))) break;
				if (Date.now() > limit) break;
				await sleep(3000);
			}
			for (const f of tracked) {
				const status = last.get(f.key) ?? 'missing';
				convertTimes.push({ key: f.key, label: f.label, seconds: readyAt.get(f.key) ?? null, status });
			}
			const problems: string[] = [];
			for (const f of tracked) {
				const status = last.get(f.key);
				if (status === 'ready') continue;
				const why = status === 'error' ? `error ${errors.get(f.key)}` : `still ${status} after ${args!.convertTimeoutMin} min`;
				if (f.key === 'url') warnings.push(`url import: ${why} (soft: network)`);
				else problems.push(`${f.key}: ${why}`);
			}
			must(problems.length === 0, problems.join('; '));
			return tracked.map((f) => `${f.key}=${last.get(f.key)}${readyAt.has(f.key) ? `(${readyAt.get(f.key)}s)` : ''}`).join(', ');
		});

		// 12. the user confirms every ready import
		await step('12', 'user-sim', 'user confirms each ready import in the app (indexing happens here)', true, async () => {
			needVault();
			const notes: string[] = [];
			for (const f of fixtures) {
				const proposed = proposedOf.get(f.key);
				const readyOk = convertTimes.find((c) => c.key === f.key)?.status === 'ready';
				if (!f.importId || !proposed || !readyOk) continue;
				f.level = proposed.level;
				const t = Date.now();
				const res = await appFetch('POST', `/api/library/import/${f.importId}/confirm`, {
					title: f.key === 'url' ? proposed.title : f.title,
					domain: proposed.domain,
					level: proposed.level,
					vault: vaultId
				});
				const ms = Date.now() - t;
				if (res.status !== 200 || res.json?.ok !== true) {
					if (f.key === 'url') {
						warnings.push(`url confirm failed: ${res.status} ${JSON.stringify(res.json)}`);
						continue;
					}
					throw new Error(`${f.key}: confirm answered ${res.status} ${JSON.stringify(res.json)}`);
				}
				f.confirmedPath = res.json.path as string;
				if (f.key === 'url') f.title = proposed.title;
				confirmTimes.push({ key: f.key, ms, path: f.confirmedPath });
				notes.push(`${f.key} -> ${f.confirmedPath} (${(ms / 1000).toFixed(1)} s)`);
			}
			must(fixtures.filter((f) => f.key !== 'url').every((f) => f.confirmedPath), 'a required import was not confirmed');
			return notes.join('; ');
		});

		const confirmed = () => fixtures.filter((f) => f.confirmedPath);

		// 13. list_vaults reflects the index
		await step('13', 'mcp', 'list_vaults: vault indexed, noteCount == confirmed, unindexedCount 0', true, async () => {
			needVault();
			const r = await callTool('list_vaults');
			must(!r.isError, r.text);
			const v = (r.json.vaults as { id: string; indexed: boolean; noteCount: number; unindexedCount: number }[]).find((x) => x.id === vaultId);
			must(v, 'vault missing from list_vaults');
			must(v.indexed === true, 'indexed is false');
			must(v.noteCount === confirmed().length, `noteCount ${v.noteCount} != ${confirmed().length}`);
			must(v.unindexedCount === 0, `unindexedCount ${v.unindexedCount}`);
			return `noteCount=${v.noteCount}, unindexedCount=${v.unindexedCount}`;
		});

		// 14. list_sources
		// 13b. the index really was built in the requested mode (a keyword-only index still passes most English searches)
		await step('13b', 'check', `index.db was built with embedding = ${args.embedding}`, true, async () => {
			needVault();
			const { default: Database } = await import('better-sqlite3');
			const db = new Database(path.join(dataDir, 'vaults', vaultId, 'index.db'), { readonly: true });
			try {
				const rows = db.prepare('SELECT key, value FROM index_meta').all() as { key: string; value: string }[];
				const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
				const chunks = (db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n;
				const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all() as { name: string }[]).map((r) => r.name);
				const detail = `embed_provider=${meta.embed_provider}, embed_model=${meta.embed_model}, dims=${meta.embed_dims}, chunks=${chunks}, tables=${tables.join(',')}`;
				if (args.embedding === 'bge-m3') {
					must(String(meta.embed_model ?? '').startsWith('bge-m3') && Number(meta.embed_dims) === 1024, `expected bge-m3/1024 — ${detail}`);
				} else {
					must(meta.embed_provider === 'none', `expected a keyword-only index — ${detail}`);
				}
				return detail;
			} finally {
				db.close();
			}
		});

		await step('14', 'mcp', 'list_sources: every confirmed path present, with its domain', true, async () => {
			needVault();
			const r = await callTool('list_sources', { vault: vaultId });
			must(!r.isError, r.text);
			const sources = r.json.sources as { path: string; domains?: string[] | string }[];
			const problems: string[] = [];
			for (const f of confirmed()) {
				const s = sources.find((x) => x.path === f.confirmedPath);
				if (!s) {
					problems.push(`${f.confirmedPath} missing`);
					continue;
				}
				const doms = Array.isArray(s.domains) ? s.domains : s.domains ? [s.domains] : [];
				if (!doms.includes(f.domain) && !s.path.startsWith(`${f.domain}/`)) problems.push(`${s.path}: domain ${f.domain} not in [${doms.join(', ')}]`);
			}
			must(problems.length === 0, problems.join('; '));
			return `${sources.length} source(s): ${sources.map((s) => s.path).join(', ')}`;
		});

		// 15. search quality
		const queries: { id: string; query: string; fixture: Fixture['key']; hard: boolean }[] = [
			{ id: '15a', query: 'leader election and log replication in a consensus algorithm', fixture: 'pdf', hard: true },
			{ id: '15b', query: 'phases of a compiler: scanning, parsing, code generation', fixture: 'md', hard: true },
			{ id: '15c', query: "Raft'ta lider seçimi nasıl yapılır?", fixture: 'pdf', hard: false },
			{ id: '15d', query: 'derleyicinin aşamaları: tarama ve ayrıştırma', fixture: 'md', hard: false }
		];
		for (const q of queries) {
			await step(q.id, 'mcp', `search_library: "${q.query}"`, q.hard, async () => {
				needVault();
				const target = fx(q.fixture);
				if (!target?.confirmedPath) throw new SkipStep(`skipped: ${q.fixture} note not confirmed`);
				const r = await callTool('search_library', { vault: vaultId, query: q.query, k: 5 });
				must(!r.isError, r.text);
				const results = r.json.results as { path: string; score: number }[];
				const idx = results.findIndex((x) => x.path === target.confirmedPath);
				const rank = idx >= 0 ? idx + 1 : null;
				const top3 = results.slice(0, 3).map((x) => ({ path: x.path, score: x.score }));
				const pass = rank !== null && rank <= 3;
				searches.push({ query: q.query, expected: target.confirmedPath, rank, top3, pass, hard: q.hard });
				const summary = `rank=${rank ?? 'none'}; top3: ${top3.map((t) => `${t.path} (${t.score})`).join(', ')}`;
				must(pass, `expected ${target.confirmedPath} in top 3; ${summary}`);
				return summary;
			});
		}

		// 16. get_note
		await step('16', 'mcp', 'get_note for each confirmed note: frontmatter + body', true, async () => {
			needVault();
			const notes: string[] = [];
			for (const f of confirmed()) {
				const r = await callTool('get_note', { vault: vaultId, path: f.confirmedPath });
				must(!r.isError, `${f.key}: ${r.text}`);
				const fm = r.json.frontmatter as { title?: string; domain?: string };
				const body = String(r.json.content ?? '');
				must(fm.title === f.title, `${f.key}: title "${fm.title}" != "${f.title}"`);
				must(fm.domain === f.domain || f.key === 'url', `${f.key}: domain "${fm.domain}" != "${f.domain}"`);
				if (f.key !== 'url') must(body.length > 500, `${f.key}: body only ${body.length} chars`);
				const heading = body.split('\n').find((l) => /^#{1,6}\s/.test(l)) ?? '(none)';
				notes.push(`${f.key}: ${body.length} chars, first heading "${heading.slice(0, 60)}"`);
			}
			return notes.join('; ');
		});

		// 17. import log
		await step('17', 'check', "import log: one by:'mcp' / status 'converted' entry per confirmed note", true, async () => {
			needVault();
			const logFile = path.join(vaultLibrary(), '_meta', 'import-log.jsonl');
			must(fs.existsSync(logFile), `${logFile} does not exist`);
			const entries = fs
				.readFileSync(logFile, 'utf-8')
				.split('\n')
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l) as { sourcePath?: string; by?: string; status?: string });
			const problems: string[] = [];
			for (const f of confirmed()) {
				const hits = entries.filter((e) => e.sourcePath === f.confirmedPath);
				if (hits.length !== 1) problems.push(`${f.confirmedPath}: ${hits.length} entries`);
				else if (hits[0].by !== 'mcp' || hits[0].status !== 'converted') problems.push(`${f.confirmedPath}: by=${hits[0].by} status=${hits[0].status}`);
			}
			must(problems.length === 0, problems.join('; '));
			return `${entries.length} log entr${entries.length === 1 ? 'y' : 'ies'}`;
		});

		// 18. MCP log privacy
		await step('18', 'check', 'mcp-log.jsonl: write tools logged, no raw paths or URL', true, async () => {
			const logFile = path.join(dataDir, 'mcp-log.jsonl');
			must(fs.existsSync(logFile), 'mcp-log.jsonl does not exist');
			const raw = fs.readFileSync(logFile, 'utf-8');
			const tools = new Set(
				raw
					.split('\n')
					.filter((l) => l.trim())
					.map((l) => (JSON.parse(l) as { tool: string }).tool)
			);
			for (const t of ['create_vault', 'import_source', 'list_pending_imports']) must(tools.has(t), `no log entry for ${t}`);
			const secrets = [notebook, allowedRoot, files.md, files.pdf, files.outside, ...(args!.url ? [args!.url] : [])];
			for (const s of secrets) {
				// JSON escapes backslashes, so look for both spellings.
				const escaped = JSON.stringify(s).slice(1, -1);
				must(!raw.includes(s) && !raw.includes(escaped), `mcp-log.jsonl contains "${s}"`);
			}
			return `tools logged: ${[...tools].join(', ')}; ${secrets.length} secret strings absent`;
		});

		// 19. real data untouched (mid-run snapshot; final one repeats after teardown)
		await step('19', 'check', 'real data files unchanged (chats.db, vaults.json, logs, mcp-settings, ...)', true, async () => {
			const changes = diffSnapshots(guardBefore, snapshotReal(realDirs));
			must(changes.length === 0 && guardAfterFirst.length === 0, `REAL DATA CHANGED:\n${[...guardAfterFirst, ...changes].join('\n')}`);
			const legacy = ['legacy-vault-index.db', 'legacy-study.db'].filter((f) => fs.existsSync(path.join(dataDir, f)));
			must(legacy.length === 0, `legacy db(s) were created in scratch (a module used the old env paths): ${legacy.join(', ')}`);
			return `${Object.keys(guardBefore).length} real files fingerprinted in ${realDirs.length} data dir(s)`;
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		steps.push({ id: 'run', actor: 'check', title: 'test harness', ok: false, hard: true, skipped: false, ms: 0, detail: message });
		console.error(`FAIL - harness error: ${message}`);
	} finally {
		try {
			await client?.close();
		} catch {
			// already closed
		}
		client = null;
		if (dev && !args.keepApp) {
			killTree(dev);
			await sleep(2000);
			endpointCleaned = !fs.existsSync(path.join(dataDir, 'mcp-endpoint.json'));
			if (!endpointCleaned) console.warn('warning - mcp-endpoint.json was not removed after killing the app (kill -9 style exit)');
		} else if (dev) {
			console.log(`--keep-app: dev server left running at ${appUrl} (pid ${dev.pid})`);
		}
		guardAtEnd = diffSnapshots(guardBefore, snapshotReal(realDirs));
		if (guardAtEnd.length > 0) {
			console.error(`!!!! ISOLATION BREACH at the end — real data changed:\n${guardAtEnd.join('\n')}`);
			steps.push({
				id: 'guard-end',
				actor: 'check',
				title: 'real data files unchanged at the end',
				ok: false,
				hard: true,
				skipped: false,
				ms: 0,
				detail: guardAtEnd.join('; ')
			});
		}
	}

	// ---- reports
	const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' });
	const headSha = git.status === 0 ? git.stdout.trim() : 'unknown';
	const hardFailed = steps.filter((s) => !s.ok && !s.skipped && s.hard);
	const softFailed = steps.filter((s) => !s.ok && !s.skipped && !s.hard);
	const envSummary = {
		node: process.version,
		platform: process.platform,
		port: args.port,
		ollama: args.ollama,
		embedding: args.embedding,
		scratch,
		gitHead: headSha,
		notebook,
		pdf: !args.noPdf,
		url: args.url ?? null,
		vaultId,
		finishedAt: new Date().toISOString()
	};
	const isolation = {
		realDataDirs: realDirs,
		guardBefore,
		changedAfterFirstRequest: guardAfterFirst,
		changedAtEnd: guardAtEnd,
		endpointFileCleanedUp: endpointCleaned
	};
	fs.writeFileSync(
		reportJson,
		JSON.stringify({ env: envSummary, steps, convertTimes, confirmTimes, transitions, searches, isolation, warnings }, null, 2)
	);
	fs.writeFileSync(reportMd, renderMarkdown({ envSummary, steps, convertTimes, confirmTimes, transitions, searches, isolation, warnings, hardFailed, softFailed }));

	console.log(`\n${steps.length} step(s): ${hardFailed.length} hard failure(s), ${softFailed.length} soft failure(s), ${steps.filter((s) => s.skipped).length} skipped`);
	console.log(`report.json: ${reportJson}\nreport.md:   ${reportMd}`);
	return hardFailed.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------- markdown report (Turkish)

function cell(text: string): string {
	return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function renderMarkdown(r: {
	envSummary: Record<string, unknown>;
	steps: StepRecord[];
	convertTimes: { key: string; label: string; seconds: number | null; status: string }[];
	confirmTimes: { key: string; ms: number; path: string }[];
	transitions: string[];
	searches: SearchRecord[];
	isolation: {
		realDataDirs: string[];
		guardBefore: Record<string, string>;
		changedAfterFirstRequest: string[];
		changedAtEnd: string[];
		endpointFileCleanedUp: boolean | null;
	};
	warnings: string[];
	hardFailed: StepRecord[];
	softFailed: StepRecord[];
}): string {
	const lines: string[] = [];
	lines.push('# MCP hattı uçtan uca deneme raporu', '');
	lines.push(
		`Sonuç: **${r.hardFailed.length === 0 ? 'GEÇTİ' : 'BAŞARISIZ'}** — ${r.hardFailed.length} zorunlu hata, ${r.softFailed.length} yumuşak hata, ${r.steps.filter((s) => s.skipped).length} atlanan adım.`,
		''
	);
	lines.push(`Node ${r.envSummary.node} · git ${r.envSummary.gitHead} · port ${r.envSummary.port} · Ollama ${r.envSummary.ollama}`, '');
	lines.push('| Adım | Aktör | Sonuç | Süre | Ayrıntı |', '|---|---|---|---|---|');
	for (const s of r.steps) {
		const result = s.skipped ? 'atlandı' : s.ok ? 'tamam' : s.hard ? 'HATA' : 'yumuşak hata';
		lines.push(`| ${s.id} ${cell(s.title)} | ${s.actor} | ${result} | ${(s.ms / 1000).toFixed(1)} s | ${cell(s.detail)} |`);
	}

	lines.push('', '## Dönüşüm süreleri', '');
	lines.push('| Kaynak | Durum | Hazır olana kadar | Onay + indeksleme |', '|---|---|---|---|');
	for (const c of r.convertTimes) {
		const confirm = r.confirmTimes.find((x) => x.key === c.key);
		lines.push(`| ${c.label} | ${c.status} | ${c.seconds === null ? '-' : `${c.seconds} s`} | ${confirm ? `${(confirm.ms / 1000).toFixed(1)} s` : '-'} |`);
	}
	if (r.transitions.length > 0) lines.push('', 'Durum geçişleri:', '', ...r.transitions.map((t) => `- ${t}`));

	lines.push('', '## Arama sonuçları', '');
	lines.push('| Sorgu | Beklenen not | Sıra | İlk 3 | Sonuç |', '|---|---|---|---|---|');
	for (const s of r.searches) {
		lines.push(
			`| ${cell(s.query)} | ${cell(s.expected)} | ${s.rank ?? '-'} | ${cell(s.top3.map((t) => `${t.path} (${t.score})`).join(', '))} | ${s.pass ? 'tamam' : s.hard ? 'HATA' : 'yumuşak hata'} |`
		);
	}

	lines.push('', '## İzolasyon', '');
	lines.push(`- Gerçek veri klasörleri: ${r.isolation.realDataDirs.map((d) => `\`${d}\``).join(', ')}`);
	lines.push(`- İlk istekten sonra değişen gerçek dosya: ${r.isolation.changedAfterFirstRequest.length === 0 ? 'yok' : `**${r.isolation.changedAfterFirstRequest.join('; ')}**`}`);
	lines.push(`- Sonda değişen gerçek dosya: ${r.isolation.changedAtEnd.length === 0 ? 'yok' : `**${r.isolation.changedAtEnd.join('; ')}**`}`);
	lines.push(
		`- mcp-endpoint.json uygulama kapanınca silindi mi: ${r.isolation.endpointFileCleanedUp === null ? 'bilinmiyor (--keep-app)' : r.isolation.endpointFileCleanedUp ? 'evet' : 'hayır (uyarı)'}`
	);
	lines.push(`- Scratch: \`${r.envSummary.scratch}\` (dev-server.log, mcp-stderr.log, data/ burada)`);
	if (r.warnings.length > 0) lines.push('', '## Uyarılar', '', ...r.warnings.map((w) => `- ${w}`));
	lines.push('');
	return lines.join('\n');
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err);
		process.exit(1);
	}
);
