import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { requiredNodeMajor, validateDefaultProviders, verifyStagedData } from './stage-verify.mjs';

const DEFAULT_PATH = path.join(process.cwd(), 'data', 'providers.default.json');

test('the shipped data/providers.default.json: chains empty, embedding explicit null, no cloud provider enabled, ollama present', () => {
	const parsed = JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf-8'));
	assert.deepEqual(validateDefaultProviders(parsed), []);
	assert.equal(parsed.embedding, null);
	assert.ok(Object.keys(parsed.chains).length > 0, 'the task types are still listed (as empty chains)');
	for (const ids of Object.values(parsed.chains)) assert.deepEqual(ids, []);
	assert.equal(parsed.providers.find((p: { id: string }) => p.id === 'ollama')?.enabled, true);
	assert.deepEqual(parsed.providers.filter((p: { kind: string; enabled: boolean }) => p.kind !== 'ollama' && p.enabled), []);
	assert.equal('defaultModel' in parsed.providers.find((p: { id: string }) => p.id === 'ollama'), false);
});

test('validateDefaultProviders flags each way a default file can go wrong', () => {
	const base = JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf-8'));
	const clone = () => JSON.parse(JSON.stringify(base));

	const noEmbeddingKey = clone();
	delete noEmbeddingKey.embedding;
	assert.match(validateDefaultProviders(noEmbeddingKey).join('|'), /embedding/);

	const filledChain = clone();
	filledChain.chains.chat = ['ollama'];
	assert.match(validateDefaultProviders(filledChain).join('|'), /chain "chat"/);

	const enabledCloud = clone();
	enabledCloud.providers.find((p: { id: string }) => p.id === 'groq').enabled = true;
	assert.match(validateDefaultProviders(enabledCloud).join('|'), /groq/);

	const personalPick = clone();
	personalPick.providers.find((p: { id: string }) => p.id === 'groq').defaultModel = 'x';
	assert.match(validateDefaultProviders(personalPick).join('|'), /defaultModel/);

	const noOllama = clone();
	noOllama.providers = noOllama.providers.filter((p: { id: string }) => p.id !== 'ollama');
	assert.match(validateDefaultProviders(noOllama).join('|'), /ollama/);

	assert.notDeepEqual(validateDefaultProviders({}), []);
});

const SAME = Buffer.from('{"a":1}');
const PRESENT = { stagedBuildIndexExists: true, stagedConvertPyExists: true, stagedMcpBundleExists: true };

test('verifyStagedData accepts a byte-identical providers.json and nothing else under data/', () => {
	assert.deepEqual(verifyStagedData({ stagedProviders: SAME, defaultProviders: Buffer.from('{"a":1}'), ...PRESENT, stagedDataEntries: ['providers.json'] }), []);
});

test('verifyStagedData fails when the staged providers.json differs from the default by even one byte', () => {
	const problems = verifyStagedData({ stagedProviders: Buffer.from('{"a":2}'), defaultProviders: SAME, ...PRESENT, stagedDataEntries: ['providers.json'] });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /birebir/);
});

test('verifyStagedData fails on any personal data staged next to it (secrets, chats.db, ui-prefs, vaults, keys ...)', () => {
	for (const name of ['secrets.json', 'secrets.key', 'chats.db', 'chats.db-wal', 'ui-prefs.json', 'vaults.json', 'vaults', 'library', 'skills', 'provider-consent.json', 'app-log.jsonl', 'mcp-log.jsonl', 'model-catalog.json', 'something-else.txt']) {
		const problems = verifyStagedData({ stagedProviders: SAME, defaultProviders: SAME, ...PRESENT, stagedDataEntries: ['providers.json', name] });
		assert.equal(problems.length, 1, name);
		assert.match(problems[0], new RegExp(name.replace('.', '\\.')));
	}
});

test('verifyStagedData reports a missing staged or default file', () => {
	assert.ok(verifyStagedData({ stagedProviders: null, defaultProviders: SAME, ...PRESENT, stagedDataEntries: [] }).length > 0);
	assert.ok(verifyStagedData({ stagedProviders: SAME, defaultProviders: null, ...PRESENT, stagedDataEntries: ['providers.json'] }).length > 0);
});

test('verifyStagedData requires dist-server/build/index.js, ingest/convert.py and mcp/vault-chat-mcp.mjs', () => {
	const base = { stagedProviders: SAME, defaultProviders: SAME, stagedDataEntries: ['providers.json'] };
	assert.deepEqual(verifyStagedData({ ...base, ...PRESENT }), []);
	const noBuild = verifyStagedData({ ...base, stagedBuildIndexExists: false, stagedConvertPyExists: true, stagedMcpBundleExists: true });
	assert.equal(noBuild.length, 1);
	assert.match(noBuild[0], /build\/index\.js/);
	const noConvert = verifyStagedData({ ...base, stagedBuildIndexExists: true, stagedConvertPyExists: false, stagedMcpBundleExists: true });
	assert.equal(noConvert.length, 1);
	assert.match(noConvert[0], /convert\.py/);
	const noMcp = verifyStagedData({ ...base, stagedBuildIndexExists: true, stagedConvertPyExists: true, stagedMcpBundleExists: false });
	assert.equal(noMcp.length, 1);
	assert.match(noMcp[0], /vault-chat-mcp\.mjs/);
	assert.equal(verifyStagedData({ ...base }).length, 3, 'flags omitted by the caller count as missing');
});

test('verifyStagedData requires the bundled node.exe / python.exe only where the caller asks (win32)', () => {
	const base = { stagedProviders: SAME, defaultProviders: SAME, stagedDataEntries: ['providers.json'], ...PRESENT };
	assert.deepEqual(verifyStagedData({ ...base }), [], 'omitted (non-Windows) = not required');
	assert.deepEqual(verifyStagedData({ ...base, stagedNodeExists: true, stagedPythonExists: true }), []);
	const noNode = verifyStagedData({ ...base, stagedNodeExists: false, stagedPythonExists: true });
	assert.equal(noNode.length, 1);
	assert.match(noNode[0], /node\/node\.exe/);
	const noPython = verifyStagedData({ ...base, stagedNodeExists: true, stagedPythonExists: false });
	assert.equal(noPython.length, 1);
	assert.match(noPython[0], /python\/python\.exe/);
});

test('requiredNodeMajor reads the engines.node lower bound, and the repo pins 22', () => {
	assert.equal(requiredNodeMajor('>=22 <23'), 22);
	assert.equal(requiredNodeMajor('>= 20'), 20);
	assert.equal(requiredNodeMajor('^22'), null);
	assert.equal(requiredNodeMajor(undefined), null);
	const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
	assert.equal(requiredNodeMajor(pkg.engines.node), 22);
});
