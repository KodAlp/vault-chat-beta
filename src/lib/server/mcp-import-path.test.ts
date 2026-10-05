import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateImportPath } from './mcp-import-path';
import { AppError } from './app-error';

function tmp(): string {
	return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-import-path-test-')));
}

function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof AppError) return e.code;
		throw e;
	}
	return 'NO_ERROR';
}

function setup() {
	const root = tmp();
	const outside = tmp();
	const pdf = path.join(root, 'sema.pdf');
	fs.writeFileSync(pdf, '%PDF-1.4 test');
	const secret = path.join(outside, 'secret.pdf');
	fs.writeFileSync(secret, '%PDF-1.4 secret');
	return { root, outside, pdf, secret };
}

test('an empty allowlist turns local import off', () => {
	const { pdf } = setup();
	assert.equal(codeOf(() => validateImportPath(pdf, [])), 'MCP_IMPORT_ROOTS_EMPTY');
});

test('a regular allowed file inside a root is accepted and resolved to its realpath', () => {
	const { root, pdf } = setup();
	const r = validateImportPath(pdf, [root]);
	assert.equal(r.real, pdf);
	assert.equal(r.name, 'sema.pdf');
	assert.equal(r.ext, '.pdf');
	assert.ok(r.size > 0);
});

test('a path outside every root is MCP_PATH_NOT_ALLOWED, existing or not', () => {
	const { root, secret, outside } = setup();
	assert.equal(codeOf(() => validateImportPath(secret, [root])), 'MCP_PATH_NOT_ALLOWED');
	assert.equal(codeOf(() => validateImportPath(path.join(outside, 'nope.pdf'), [root])), 'MCP_PATH_NOT_ALLOWED');
});

test('a missing file inside a root is MCP_PATH_INVALID (404)', () => {
	const { root } = setup();
	assert.equal(codeOf(() => validateImportPath(path.join(root, 'gone.pdf'), [root])), 'MCP_PATH_INVALID');
});

test('a sibling folder sharing the root as a name prefix is not inside it', () => {
	const parent = tmp();
	const b = path.join(parent, 'b');
	const bc = path.join(parent, 'bc');
	fs.mkdirSync(b);
	fs.mkdirSync(bc);
	const f = path.join(bc, 'x.pdf');
	fs.writeFileSync(f, 'x');
	assert.equal(codeOf(() => validateImportPath(f, [b])), 'MCP_PATH_NOT_ALLOWED');
});

test('relative paths, NUL and ".." segments are rejected as MCP_PATH_INVALID', () => {
	const { root, pdf, secret } = setup();
	assert.equal(codeOf(() => validateImportPath('sema.pdf', [root])), 'MCP_PATH_INVALID');
	assert.equal(codeOf(() => validateImportPath(pdf + '\0.txt', [root])), 'MCP_PATH_INVALID');
	assert.equal(codeOf(() => validateImportPath(`${root}${path.sep}..${path.sep}${path.basename(path.dirname(secret))}${path.sep}secret.pdf`, [root])), 'MCP_PATH_INVALID');
	assert.equal(codeOf(() => validateImportPath(42, [root])), 'MCP_PATH_INVALID');
});

test('a directory is not a file', () => {
	const { root } = setup();
	const dir = path.join(root, 'sub.pdf');
	fs.mkdirSync(dir);
	assert.equal(codeOf(() => validateImportPath(dir, [root])), 'MCP_PATH_INVALID');
});

test('disallowed extensions and oversize files are rejected with the import codes', () => {
	const { root } = setup();
	const exe = path.join(root, 'tool.exe');
	fs.writeFileSync(exe, 'x');
	assert.equal(codeOf(() => validateImportPath(exe, [root])), 'UNSUPPORTED_FILE_TYPE');
	const big = path.join(root, 'big.pdf');
	fs.writeFileSync(big, Buffer.alloc(2048));
	assert.equal(codeOf(() => validateImportPath(big, [root], [], 1024)), 'FILE_TOO_LARGE');
	assert.equal(validateImportPath(big, [root], [], 4096).size, 2048);
});

test('code files are accepted like the upload route does', () => {
	const { root } = setup();
	const py = path.join(root, 'script.py');
	fs.writeFileSync(py, 'print(1)');
	assert.equal(validateImportPath(py, [root]).ext, '.py');
});

test('protected directories inside an allowed root stay off limits', () => {
	const root = tmp();
	const data = path.join(root, 'data');
	fs.mkdirSync(data);
	const providers = path.join(data, 'notes.md');
	fs.writeFileSync(providers, 'x');
	assert.equal(codeOf(() => validateImportPath(providers, [root], [data])), 'MCP_PATH_NOT_ALLOWED');
	assert.equal(validateImportPath(providers, [root], []).name, 'notes.md');
});

test('a symlink is rejected: one pointing outside is NOT_ALLOWED, one pointing inside is INVALID', (t) => {
	const { root, secret, pdf } = setup();
	const toOutside = path.join(root, 'link-out.pdf');
	const toInside = path.join(root, 'link-in.pdf');
	try {
		fs.symlinkSync(secret, toOutside, 'file');
		fs.symlinkSync(pdf, toInside, 'file');
	} catch {
		t.skip('cannot create symlinks on this machine (needs privilege on Windows)');
		return;
	}
	assert.equal(codeOf(() => validateImportPath(toOutside, [root])), 'MCP_PATH_NOT_ALLOWED');
	assert.equal(codeOf(() => validateImportPath(toInside, [root])), 'MCP_PATH_INVALID');
});

test('a symlinked folder inside the root that leads outside is NOT_ALLOWED', (t) => {
	const { root, outside } = setup();
	const link = path.join(root, 'escape');
	try {
		fs.symlinkSync(outside, link, 'junction');
	} catch {
		t.skip('cannot create links on this machine');
		return;
	}
	assert.equal(codeOf(() => validateImportPath(path.join(link, 'secret.pdf'), [root])), 'MCP_PATH_NOT_ALLOWED');
});
