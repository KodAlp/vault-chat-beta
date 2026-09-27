import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installSystemCa, type TlsCaApi } from './system-ca';

function fakeTls(defaults: string[], system: string[]): TlsCaApi & { installed: string[] | null } {
	const api = {
		installed: null as string[] | null,
		getCACertificates: (type: string) => (type === 'system' ? system : defaults),
		setDefaultCACertificates: (certs: string[]) => {
			api.installed = certs;
		}
	};
	return api;
}

test('merges default and system roots, deduplicated', () => {
	const tls = fakeTls(['A', 'B'], ['B', 'KASPERSKY']);
	const r = installSystemCa(tls, {});
	assert.deepEqual(r, { installed: true, defaultCount: 2, systemCount: 2, total: 3 });
	assert.deepEqual(tls.installed, ['A', 'B', 'KASPERSKY']);
});

test('USE_SYSTEM_CA=0 leaves the default store untouched', () => {
	const tls = fakeTls(['A'], ['S']);
	assert.deepEqual(installSystemCa(tls, { USE_SYSTEM_CA: '0' }), { installed: false, reason: 'disabled' });
	assert.equal(tls.installed, null);
});

test('an older Node without the APIs degrades to unchanged instead of throwing', () => {
	assert.deepEqual(installSystemCa({}, {}), { installed: false, reason: 'unsupported' });
});

test('an empty system store changes nothing', () => {
	const tls = fakeTls(['A'], []);
	assert.deepEqual(installSystemCa(tls, {}), { installed: false, reason: 'no-system-certs' });
	assert.equal(tls.installed, null);
});

test('a throwing TLS API is reported, not propagated', () => {
	const r = installSystemCa(
		{
			getCACertificates: () => {
				throw new Error('boom');
			},
			setDefaultCACertificates: () => {}
		},
		{}
	);
	assert.deepEqual(r, { installed: false, reason: 'error', detail: 'boom' });
});
