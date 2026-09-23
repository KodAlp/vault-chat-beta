import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grantProviderConsent, revokeProviderConsent, isProviderConsented, listConsentedProviders } from './provider-consent';

function useTmpConsentFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-consent-test-'));
	const p = path.join(dir, 'provider-consent.json');
	process.env.PROVIDER_CONSENT_PATH = p;
	return p;
}

test('a provider with no file on disk yet is not consented', () => {
	useTmpConsentFile();
	assert.equal(isProviderConsented('groq'), false);
	assert.deepEqual(listConsentedProviders(), []);
});

test('grantProviderConsent marks a provider consented and it round-trips through a fresh read', () => {
	useTmpConsentFile();
	grantProviderConsent('groq');
	assert.equal(isProviderConsented('groq'), true);
	assert.deepEqual(listConsentedProviders(), ['groq']);
});

test('grantProviderConsent is idempotent — granting twice does not duplicate the entry', () => {
	useTmpConsentFile();
	grantProviderConsent('groq');
	grantProviderConsent('groq');
	assert.deepEqual(listConsentedProviders(), ['groq']);
});

test('revokeProviderConsent removes a granted provider, leaving others untouched', () => {
	useTmpConsentFile();
	grantProviderConsent('groq');
	grantProviderConsent('anthropic');
	revokeProviderConsent('groq');
	assert.deepEqual(listConsentedProviders(), ['anthropic']);
});

test('revoking a never-granted provider is a harmless no-op (does not even create the file)', () => {
	const p = useTmpConsentFile();
	revokeProviderConsent('groq');
	assert.equal(fs.existsSync(p), false);
});

test('a corrupt file reads back as no consent, never throws', () => {
	const p = useTmpConsentFile();
	fs.writeFileSync(p, 'not json', 'utf-8');
	assert.equal(isProviderConsented('groq'), false);
});

test('the file on disk survives a write intact (atomic tmp+rename leaves no stray .tmp file)', () => {
	const p = useTmpConsentFile();
	grantProviderConsent('groq');
	const dir = path.dirname(p);
	const leftoverTmp = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
	assert.deepEqual(leftoverTmp, []);
});
