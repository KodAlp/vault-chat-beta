/**
 * Trust the operating system's certificate store in addition to Node's bundled one.
 *
 * Why: antivirus HTTPS scanning (measured on this project's dev machine: Kaspersky) and corporate
 * proxies re-sign TLS traffic with a root that is installed in the Windows store — browsers trust it,
 * Node's bundled list does not. Every cloud provider call then fails with SELF_SIGNED_CERT_IN_CHAIN
 * (seen in data/app-log.jsonl for openrouter/groq/deepseek). Verification stays ON: this only adds the
 * OS roots the rest of the machine already trusts, the same thing `node --use-system-ca` does.
 *
 * Not done with NODE_OPTIONS=--use-system-ca: the desktop build runs the user's own installed Node,
 * and a Node that doesn't know the flag refuses to start at all. Feature detection here degrades to
 * "unchanged" instead. Opt out with USE_SYSTEM_CA=0.
 */

export interface TlsCaApi {
	getCACertificates?: (type: 'default' | 'system' | 'bundled' | 'extra') => string[];
	setDefaultCACertificates?: (certs: string[]) => void;
}

export type SystemCaResult =
	| { installed: true; defaultCount: number; systemCount: number; total: number }
	| { installed: false; reason: 'disabled' | 'unsupported' | 'no-system-certs' | 'error'; detail?: string };

export function installSystemCa(tlsApi: TlsCaApi, env: Record<string, string | undefined>): SystemCaResult {
	if (env.USE_SYSTEM_CA === '0') return { installed: false, reason: 'disabled' };
	if (typeof tlsApi.getCACertificates !== 'function' || typeof tlsApi.setDefaultCACertificates !== 'function') {
		return { installed: false, reason: 'unsupported' };
	}
	try {
		const defaults = tlsApi.getCACertificates('default');
		const system = tlsApi.getCACertificates('system');
		if (system.length === 0) return { installed: false, reason: 'no-system-certs' };
		const merged = [...new Set([...defaults, ...system])];
		tlsApi.setDefaultCACertificates(merged);
		return { installed: true, defaultCount: defaults.length, systemCount: system.length, total: merged.length };
	} catch (err) {
		return { installed: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
	}
}
