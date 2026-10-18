import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendManifestEntry, loadRetryableUrls, type ManifestEntry } from './link-manifest';

function tmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-manifest-'));
	return { dir, manifest: path.join(dir, '_meta', 'link-manifest.jsonl'), log: path.join(dir, '_meta', 'import-log.jsonl') };
}

const e = (url: string, status: ManifestEntry['status'], at: string, code?: string): ManifestEntry => ({ batchId: 'b', url, status, at, ...(code ? { code } : {}) });

test('loadRetryableUrls returns urls whose latest entry is failed, newest first', () => {
	const { dir, manifest, log } = tmp();
	appendManifestEntry(manifest, e('https://a.example/', 'failed', '2026-01-01T00:00:00Z', 'X'));
	appendManifestEntry(manifest, e('https://b.example/', 'failed', '2026-01-03T00:00:00Z', 'Y'));
	appendManifestEntry(manifest, e('https://c.example/', 'failed', '2026-01-02T00:00:00Z'));
	// c later succeeded (pending) -> no longer retryable
	appendManifestEntry(manifest, e('https://c.example/', 'pending', '2026-01-04T00:00:00Z'));
	fs.appendFileSync(manifest, 'not json\n');
	const out = loadRetryableUrls(manifest, log);
	assert.deepEqual(out.map((r) => r.url), ['https://b.example/', 'https://a.example/']);
	assert.equal(out[0].code, 'Y');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('loadRetryableUrls drops urls already in the import log and tolerates a missing manifest', () => {
	const { dir, manifest, log } = tmp();
	assert.deepEqual(loadRetryableUrls(manifest, log), []);
	appendManifestEntry(manifest, e('https://done.example/', 'failed', '2026-01-01T00:00:00Z'));
	appendManifestEntry(manifest, e('https://todo.example/', 'failed', '2026-01-02T00:00:00Z'));
	fs.writeFileSync(log, JSON.stringify({ sourceUrl: 'https://done.example/', status: 'converted' }) + '\n');
	assert.deepEqual(loadRetryableUrls(manifest, log).map((r) => r.url), ['https://todo.example/']);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('loadRetryableUrls caps the result at 200', () => {
	const { dir, manifest, log } = tmp();
	for (let i = 0; i < 250; i++) appendManifestEntry(manifest, e(`https://h${i}.example/`, 'failed', new Date(2026, 0, 1, 0, 0, i).toISOString()));
	assert.equal(loadRetryableUrls(manifest, log).length, 200);
	fs.rmSync(dir, { recursive: true, force: true });
});
