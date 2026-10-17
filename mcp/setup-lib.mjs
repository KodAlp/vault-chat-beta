// Pure helpers for mcp/setup.mjs. No side effects at import and no direct
// reads of process/os globals: every environment fact is a parameter so the
// logic is testable on any platform (see setup-lib.test.mjs).
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const SERVER_NAME = 'vault-chat';
export const APP_IDENTIFIER = 'app.vaultchat.desktop';

/** Platform-specific path module, so a test can ask for Windows paths on Linux and vice versa. */
function pathFor(platform) {
	return platform === 'win32' ? path.win32 : path.posix;
}

/** Directory of the installed desktop app's data (Tauri app_data_dir). */
export function installedAppDataDir({ platform, env, home }) {
	const p = pathFor(platform);
	if (platform === 'win32') {
		const appData = env.APPDATA || p.join(home, 'AppData', 'Roaming');
		return p.join(appData, APP_IDENTIFIER);
	}
	if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', APP_IDENTIFIER);
	const xdg = env.XDG_DATA_HOME || p.join(home, '.local', 'share');
	return p.join(xdg, APP_IDENTIFIER);
}

/**
 * Data dir order: --data-dir flag > DATA_DIR env (what .env set counts too) >
 * installed app's dir when it exists > <repo>/data. Always absolute.
 */
export function resolveDataDir({ flag, envDataDir, platform, env, home, repoRoot, exists }) {
	const p = pathFor(platform);
	const abs = (v) => p.resolve(repoRoot, v);
	if (flag) return { dir: abs(flag), source: 'flag' };
	if (envDataDir) return { dir: abs(envDataDir), source: 'env' };
	const app = installedAppDataDir({ platform, env, home });
	if (exists(app)) return { dir: app, source: 'app' };
	return { dir: abs('data'), source: 'repo' };
}

/**
 * Claude Desktop's config file. The Microsoft Store (MSIX) build virtualizes
 * %APPDATA%\Claude into %LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude;
 * when such a file exists it is the one the app really reads.
 */
export function claudeDesktopConfigPath({ platform, env, home, listDir, exists }) {
	const p = pathFor(platform);
	if (platform === 'win32') {
		const localAppData = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
		const packages = p.join(localAppData, 'Packages');
		let names = [];
		try {
			names = listDir(packages);
		} catch {
			names = [];
		}
		for (const name of names.filter((n) => /^Claude_/i.test(n)).sort()) {
			const candidate = p.join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
			if (exists(candidate)) return candidate;
		}
		const appData = env.APPDATA || p.join(home, 'AppData', 'Roaming');
		return p.join(appData, 'Claude', 'claude_desktop_config.json');
	}
	if (platform === 'darwin') {
		return p.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
	}
	const xdg = env.XDG_CONFIG_HOME || p.join(home, '.config');
	return p.join(xdg, 'Claude', 'claude_desktop_config.json');
}

export function lmStudioConfigPath({ platform, home }) {
	return pathFor(platform).join(home, '.lmstudio', 'mcp.json');
}

/** Same shape as `node mcp/launch.mjs --print-config` and mcp-client-config.ts. */
export function serverEntry({ nodePath, launchPath, dataDir }) {
	return { command: nodePath, args: [launchPath], env: { DATA_DIR: dataDir } };
}

export function configBlock(entry, name = SERVER_NAME) {
	return JSON.stringify({ mcpServers: { [name]: entry } }, null, 2);
}

/**
 * Adds/replaces mcpServers[name] in a client config file's text. Never
 * rewrites a file it cannot parse: that throws instead.
 * @returns {{ text: string, changed: boolean }}
 */
export function mergeServerEntry(existingText, entry, name = SERVER_NAME) {
	let obj;
	if (existingText == null || existingText.trim() === '') {
		obj = {};
	} else {
		try {
			// Tolerate a UTF-8 BOM that some Windows editors add.
			obj = JSON.parse(existingText.replace(/^\uFEFF/, ''));
		} catch (e) {
			throw new Error(`Yapılandırma dosyası geçerli JSON değil, dokunulmadı: ${e instanceof Error ? e.message : e}`);
		}
		if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
			throw new Error('Yapılandırma dosyasının kökü bir JSON nesnesi değil, dokunulmadı.');
		}
	}
	if (obj.mcpServers === undefined) {
		obj.mcpServers = {};
	} else if (obj.mcpServers === null || typeof obj.mcpServers !== 'object' || Array.isArray(obj.mcpServers)) {
		throw new Error('"mcpServers" alanı bir JSON nesnesi değil, dokunulmadı.');
	}
	if (isDeepStrictEqual(obj.mcpServers[name], entry)) {
		return { text: existingText ?? '', changed: false };
	}
	obj.mcpServers[name] = entry;
	return { text: JSON.stringify(obj, null, 2) + '\n', changed: true };
}

/** `<file>.bak-YYYYMMDD-HHMMSS` in local time. */
export function backupName(file, date) {
	const z = (n, w = 2) => String(n).padStart(w, '0');
	const stamp =
		`${date.getFullYear()}${z(date.getMonth() + 1)}${z(date.getDate())}` +
		`-${z(date.getHours())}${z(date.getMinutes())}${z(date.getSeconds())}`;
	return `${file}.bak-${stamp}`;
}

/** argv lists for `claude mcp remove` / `claude mcp add` (without the `claude` binary itself). */
export function claudeCodeArgs(entry, name = SERVER_NAME) {
	return {
		remove: ['mcp', 'remove', '--scope', 'user', name],
		add: ['mcp', 'add', '--scope', 'user', '-e', `DATA_DIR=${entry.env.DATA_DIR}`, name, '--', entry.command, ...entry.args]
	};
}
