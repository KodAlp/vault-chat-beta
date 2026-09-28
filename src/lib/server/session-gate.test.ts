import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSessionGate, timingSafeEqualString, type SessionGateInput } from './session-gate';

const TOKEN = 'a'.repeat(64);

function baseInput(overrides: Partial<SessionGateInput> = {}): SessionGateInput {
	return {
		token: TOKEN,
		queryToken: null,
		cookieToken: null,
		headerToken: null,
		pathname: '/',
		searchParams: new URLSearchParams(),
		...overrides
	};
}

// ---------- timingSafeEqualString

test('equal strings match', () => {
	assert.equal(timingSafeEqualString(TOKEN, TOKEN), true);
	assert.equal(timingSafeEqualString('', ''), true);
});

test('different-length strings never throw and are unequal', () => {
	assert.equal(timingSafeEqualString(TOKEN, TOKEN.slice(0, 63)), false);
	assert.equal(timingSafeEqualString('short', 'much longer string'), false);
	assert.equal(timingSafeEqualString('', 'x'), false);
});

test('same-length but different strings are unequal', () => {
	assert.equal(timingSafeEqualString('a'.repeat(64), 'b'.repeat(64)), false);
});

// ---------- decideSessionGate — query param (first navigation)

test('a matching query token redirects, stripping vc_session and keeping the rest of the query', () => {
	const params = new URLSearchParams({ vc_session: TOKEN, tab: 'chat' });
	const decision = decideSessionGate(
		baseInput({ queryToken: TOKEN, pathname: '/vault/default', searchParams: params })
	);
	assert.deepEqual(decision, { kind: 'redirect', location: '/vault/default?tab=chat' });
});

test('a matching query token with no other params redirects to the bare pathname', () => {
	const params = new URLSearchParams({ vc_session: TOKEN });
	const decision = decideSessionGate(baseInput({ queryToken: TOKEN, pathname: '/', searchParams: params }));
	assert.deepEqual(decision, { kind: 'redirect', location: '/' });
});

test('the original searchParams instance is never mutated', () => {
	const params = new URLSearchParams({ vc_session: TOKEN, tab: 'chat' });
	decideSessionGate(baseInput({ queryToken: TOKEN, searchParams: params }));
	assert.equal(params.get('vc_session'), TOKEN, 'caller’s URLSearchParams must be untouched');
});

test('a wrong query token does not redirect and falls through to cookie/header checks', () => {
	const params = new URLSearchParams({ vc_session: 'wrong'.padEnd(64, '0') });
	const decision = decideSessionGate(baseInput({ queryToken: 'wrong'.padEnd(64, '0'), searchParams: params }));
	assert.deepEqual(decision, { kind: 'reject' });

	const decisionWithCookie = decideSessionGate(
		baseInput({ queryToken: 'wrong'.padEnd(64, '0'), cookieToken: TOKEN, searchParams: params })
	);
	assert.deepEqual(decisionWithCookie, { kind: 'allow' });
});

// ---------- decideSessionGate — cookie / header (every later request)

test('a matching cookie allows the request', () => {
	assert.deepEqual(decideSessionGate(baseInput({ cookieToken: TOKEN })), { kind: 'allow' });
});

test('a matching header allows the request', () => {
	assert.deepEqual(decideSessionGate(baseInput({ headerToken: TOKEN })), { kind: 'allow' });
});

test('a matching query token wins even over a WRONG cookie/header', () => {
	const params = new URLSearchParams({ vc_session: TOKEN });
	const decision = decideSessionGate(
		baseInput({ queryToken: TOKEN, cookieToken: 'stale'.padEnd(64, '0'), headerToken: 'nope', searchParams: params })
	);
	assert.equal(decision.kind, 'redirect');
});

test('nothing present rejects', () => {
	assert.deepEqual(decideSessionGate(baseInput()), { kind: 'reject' });
});

test('a wrong cookie and a wrong header both reject', () => {
	assert.deepEqual(
		decideSessionGate(baseInput({ cookieToken: 'wrong'.padEnd(64, '0'), headerToken: 'also-wrong' })),
		{ kind: 'reject' }
	);
});
