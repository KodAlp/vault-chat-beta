import test from 'node:test';
import assert from 'node:assert/strict';
import {
	resolveDataDir,
	claudeDesktopConfigPath,
	lmStudioConfigPath,
	installedAppDataDir,
	serverEntry,
	mergeServerEntry,
	backupName,
	claudeCodeArgs
} from './setup-lib.mjs';

const win = {
	platform: 'win32',
	env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
	home: 'C:\\Users\\u',
	repoRoot: 'C:\\src\\vault-chat'
};
const appDir = 'C:\\Users\\u\\AppData\\Roaming\\app.vaultchat.desktop';

test('resolveDataDir: flag beats env, app and repo', () => {
	const r = resolveDataDir({ ...win, flag: 'D:\\x', envDataDir: 'E:\\y', exists: () => true });
	assert.deepEqual(r, { dir: 'D:\\x', source: 'flag' });
});

test('resolveDataDir: env beats installed app dir', () => {
	const r = resolveDataDir({ ...win, flag: null, envDataDir: 'E:\\y', exists: () => true });
	assert.deepEqual(r, { dir: 'E:\\y', source: 'env' });
});

test('resolveDataDir: installed app dir when it exists, else repo/data', () => {
	assert.deepEqual(resolveDataDir({ ...win, flag: null, envDataDir: null, exists: (p) => p === appDir }), {
		dir: appDir,
		source: 'app'
	});
	assert.deepEqual(resolveDataDir({ ...win, flag: null, envDataDir: null, exists: () => false }), {
		dir: 'C:\\src\\vault-chat\\data',
		source: 'repo'
	});
});

test('resolveDataDir: relative values resolve against the repo root', () => {
	const r = resolveDataDir({ ...win, flag: null, envDataDir: 'mydata', exists: () => false });
	assert.equal(r.dir, 'C:\\src\\vault-chat\\mydata');
});

test('installedAppDataDir per platform', () => {
	assert.equal(installedAppDataDir({ platform: 'darwin', env: {}, home: '/Users/u' }), '/Users/u/Library/Application Support/app.vaultchat.desktop');
	assert.equal(installedAppDataDir({ platform: 'linux', env: {}, home: '/home/u' }), '/home/u/.local/share/app.vaultchat.desktop');
	assert.equal(installedAppDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/x' }, home: '/home/u' }), '/x/app.vaultchat.desktop');
});

test('claudeDesktopConfigPath prefers an existing MSIX file on Windows', () => {
	const msix = 'C:\\Users\\u\\AppData\\Local\\Packages\\Claude_abc123\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json';
	const r = claudeDesktopConfigPath({
		...win,
		listDir: () => ['Other_x', 'Claude_abc123'],
		exists: (p) => p === msix
	});
	assert.equal(r, msix);
});

test('claudeDesktopConfigPath falls back to APPDATA when no MSIX file exists', () => {
	const expected = 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude_desktop_config.json';
	assert.equal(claudeDesktopConfigPath({ ...win, listDir: () => ['Claude_abc123'], exists: () => false }), expected);
	assert.equal(
		claudeDesktopConfigPath({
			...win,
			listDir: () => {
				throw new Error('ENOENT');
			},
			exists: () => false
		}),
		expected
	);
});

test('claudeDesktopConfigPath on macOS and Linux', () => {
	const noop = { listDir: () => [], exists: () => false };
	assert.equal(claudeDesktopConfigPath({ platform: 'darwin', env: {}, home: '/Users/u', ...noop }), '/Users/u/Library/Application Support/Claude/claude_desktop_config.json');
	assert.equal(claudeDesktopConfigPath({ platform: 'linux', env: {}, home: '/home/u', ...noop }), '/home/u/.config/Claude/claude_desktop_config.json');
});

test('lmStudioConfigPath', () => {
	assert.equal(lmStudioConfigPath({ platform: 'linux', home: '/home/u' }), '/home/u/.lmstudio/mcp.json');
});

const entry = serverEntry({ nodePath: '/usr/bin/node', launchPath: '/r/mcp/launch.mjs', dataDir: '/d' });

test('serverEntry shape', () => {
	assert.deepEqual(entry, { command: '/usr/bin/node', args: ['/r/mcp/launch.mjs'], env: { DATA_DIR: '/d' } });
});

test('mergeServerEntry: null, empty and whitespace files start a new object', () => {
	for (const input of [null, '', '  \n']) {
		const r = mergeServerEntry(input, entry);
		assert.equal(r.changed, true);
		assert.deepEqual(JSON.parse(r.text), { mcpServers: { 'vault-chat': entry } });
		assert.ok(r.text.endsWith('}\n'));
	}
});

test('mergeServerEntry preserves other keys, their order and other servers', () => {
	const existing = JSON.stringify({ preferences: { x: 1 }, mcpServers: { other: { command: 'a' } }, tail: true });
	const r = mergeServerEntry(existing, entry);
	assert.equal(r.changed, true);
	const out = JSON.parse(r.text);
	assert.deepEqual(Object.keys(out), ['preferences', 'mcpServers', 'tail']);
	assert.deepEqual(Object.keys(out.mcpServers), ['other', 'vault-chat']);
	assert.deepEqual(out.preferences, { x: 1 });
});

test('mergeServerEntry: identical entry is unchanged, a different one is replaced', () => {
	const first = mergeServerEntry(null, entry);
	assert.equal(mergeServerEntry(first.text, entry).changed, false);
	const other = { ...entry, env: { DATA_DIR: '/other' } };
	const r = mergeServerEntry(first.text, other);
	assert.equal(r.changed, true);
	assert.equal(JSON.parse(r.text).mcpServers['vault-chat'].env.DATA_DIR, '/other');
});

test('mergeServerEntry throws on unusable files', () => {
	assert.throws(() => mergeServerEntry('{ nope', entry), /geçerli JSON değil/);
	assert.throws(() => mergeServerEntry('[1,2]', entry), /nesnesi değil/);
	assert.throws(() => mergeServerEntry('null', entry), /nesnesi değil/);
	assert.throws(() => mergeServerEntry('{"mcpServers": []}', entry), /mcpServers/);
	assert.throws(() => mergeServerEntry('{"mcpServers": "x"}', entry), /mcpServers/);
});

test('backupName format', () => {
	assert.equal(backupName('/a/b.json', new Date(2026, 9, 7, 3, 4, 5)), '/a/b.json.bak-20261007-030405');
});

test('claudeCodeArgs', () => {
	const a = claudeCodeArgs(entry);
	assert.deepEqual(a.remove, ['mcp', 'remove', '--scope', 'user', 'vault-chat']);
	assert.deepEqual(a.add, ['mcp', 'add', '--scope', 'user', '-e', 'DATA_DIR=/d', 'vault-chat', '--', '/usr/bin/node', '/r/mcp/launch.mjs']);
});
