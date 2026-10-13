/**
 * Pure rules for the one-time repair of existing library notes (TODO #4):
 *   1. Adobe-Symbol private-use codes (U+F0xx, Likharev PDFs) -> real Unicode.
 *   2. `\infty` read where the PDF has "proportional to" -> `\propto`.
 *
 * Both rules are PORTS of ingest/postprocess.py (map_symbol_pua, fix_propto):
 * new conversions get them at ingest time, this file fixes notes that are
 * already in a library. Change both together -- scripts/symbol-propto-repair.test.mjs
 * and ingest/postprocess_test.py pin the same cases.
 *
 * No dependencies (the CLI wrapper is scripts/symbol-propto-repair.ts).
 */

/* ------------------------------------------------------------------ Adobe Symbol */

const SYMBOL_ASCII = ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅'; // bytes 0x20-0x40
const SYMBOL_GREEK_UP = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ'; // 0x41-0x5A
const SYMBOL_GREEK_LOW = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ'; // 0x61-0x7A
const SYMBOL_OTHER = {
	0x5b: '[', 0x5c: '∴', 0x5d: ']', 0x5e: '⊥', 0x5f: '_', 0x60: '‾',
	0x7b: '{', 0x7c: '|', 0x7d: '}', 0x7e: '∼',
	0xa0: '€', 0xa1: 'ϒ', 0xa2: '′', 0xa3: '≤', 0xa4: '⁄', 0xa5: '∞',
	0xa6: 'ƒ', 0xa7: '♣', 0xa8: '♦', 0xa9: '♥', 0xaa: '♠', 0xab: '↔',
	0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓', 0xb0: '°', 0xb1: '±',
	0xb2: '″', 0xb3: '≥', 0xb4: '×', 0xb5: '∝', 0xb6: '∂', 0xb7: '•',
	0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈', 0xbc: '…', 0xbd: '⏐',
	0xbe: '⎯', 0xbf: '↵', 0xc0: 'ℵ', 0xc1: 'ℑ', 0xc2: 'ℜ', 0xc3: '℘',
	0xc4: '⊗', 0xc5: '⊕', 0xc6: '∅', 0xc7: '∩', 0xc8: '∪', 0xc9: '⊃',
	0xca: '⊇', 0xcb: '⊄', 0xcc: '⊂', 0xcd: '⊆', 0xce: '∈', 0xcf: '∉',
	0xd0: '∠', 0xd1: '∇', 0xd2: '®', 0xd3: '©', 0xd4: '™', 0xd5: '∏',
	0xd6: '√', 0xd7: '⋅', 0xd8: '¬', 0xd9: '∧', 0xda: '∨', 0xdb: '⇔',
	0xdc: '⇐', 0xdd: '⇑', 0xde: '⇒', 0xdf: '⇓', 0xe0: '◊', 0xe1: '⟨',
	0xe2: '®', 0xe3: '©', 0xe4: '™', 0xe5: '∑', 0xe6: '⎛', 0xe7: '⎜',
	0xe8: '⎝', 0xe9: '⎡', 0xea: '⎢', 0xeb: '⎣', 0xec: '⎧', 0xed: '⎨',
	0xee: '⎩', 0xef: '⎪', 0xf1: '⟩', 0xf2: '∫', 0xf3: '⌠', 0xf4: '⎮',
	0xf5: '⌡', 0xf6: '⎞', 0xf7: '⎟', 0xf8: '⎠', 0xf9: '⎤', 0xfa: '⎥',
	0xfb: '⎦', 0xfc: '⎫', 0xfd: '⎬', 0xfe: '⎭'
};

/** @type {Map<string,string>} U+F0xx -> Unicode */
export const SYMBOL_PUA = new Map();
[...SYMBOL_ASCII].forEach((c, i) => SYMBOL_PUA.set(String.fromCharCode(0xf020 + i), c));
[...SYMBOL_GREEK_UP].forEach((c, i) => SYMBOL_PUA.set(String.fromCharCode(0xf041 + i), c));
[...SYMBOL_GREEK_LOW].forEach((c, i) => SYMBOL_PUA.set(String.fromCharCode(0xf061 + i), c));
for (const [b, c] of Object.entries(SYMBOL_OTHER)) SYMBOL_PUA.set(String.fromCharCode(0xf000 + Number(b)), c);

const PUA_RE = /[-]/g;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,}).*?^[ \t]*\1[ \t]*$/gms;
const INLINE_CODE_RE = /(`+)(?:(?!\1).)*?\1/gs;

/** Runs fn on the text outside fenced and inline code; code is copied verbatim. */
export function outsideCode(text, fn) {
	const parts = [];
	const inline = (chunk) => {
		let out = '';
		let p = 0;
		for (const m of chunk.matchAll(INLINE_CODE_RE)) {
			out += fn(chunk.slice(p, m.index)) + m[0];
			p = m.index + m[0].length;
		}
		return out + fn(chunk.slice(p));
	};
	let pos = 0;
	for (const m of text.matchAll(FENCE_RE)) {
		parts.push(inline(text.slice(pos, m.index)), m[0]);
		pos = m.index + m[0].length;
	}
	parts.push(inline(text.slice(pos)));
	return parts.join('');
}

/** Python map_symbol_pua. Codes without an entry (U+F0F0 = Apple logo) stay. */
export function mapSymbolPua(text) {
	PUA_RE.lastIndex = 0;
	if (!PUA_RE.test(text)) return text;
	return outsideCode(text, (chunk) => chunk.replace(PUA_RE, (c) => SYMBOL_PUA.get(c) ?? c));
}

/** Number of private-use characters (U+F0xx) in text, mapped and unmapped. */
export function countPua(text) {
	let mapped = 0;
	let unmapped = 0;
	for (const c of text.match(PUA_RE) ?? []) SYMBOL_PUA.has(c) ? mapped++ : unmapped++;
	return { mapped, unmapped };
}

/* ------------------------------------------------------------------ \infty -> \propto */

const TERM_END_CMDS = new Set(
	('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi ' +
		'varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi ' +
		'Pi Sigma Upsilon Phi Psi Omega hbar ell partial aleph imath jmath Re Im').split(' ')
);
const TERM_START_CMDS = new Set([
	...TERM_END_CMDS,
	...('frac dfrac tfrac sqrt left mathrm mathbf mathit mathcal mathbb boldsymbol text textrm operatorname ' +
		'vec hat bar dot ddot tilde overline nabla sin cos tan exp ln log int sum prod').split(' ')
]);
const SPACING_BACK = ['\\,', '\\;', '\\ ', '\\quad'];
const SPACING_FWD = /\\(?:,|;| |quad(?![a-zA-Z]))|\s/y;
const NO_DASH_TEXT = /\\(?:text|textrm|mathrm)\s*\{\s*-/y;
const isAsciiAlpha = (c) => /^[A-Za-z]$/.test(c);
const isAsciiDigit = (c) => /^[0-9]$/.test(c);
const isSpace = (c) => /^\s$/.test(c);

function skipSpacingBack(s, i) {
	while (i > 0) {
		const cand = SPACING_BACK.find((c) => s.slice(0, i).endsWith(c));
		if (cand) i -= cand.length;
		else if (isSpace(s[i - 1])) i -= 1;
		else return i;
	}
	return i;
}

function skipSpacingFwd(s, i) {
	for (;;) {
		SPACING_FWD.lastIndex = i;
		if (!SPACING_FWD.exec(s)) return i;
		i = SPACING_FWD.lastIndex;
	}
}

/** Does s[pos] sit inside a `{...}` group that is a sub/superscript argument? */
function inScriptGroup(s, pos) {
	let depth = 0;
	for (let i = pos - 1; i >= 0; i--) {
		if (i > 0 && s[i - 1] === '\\') continue;
		if (s[i] === '}') depth++;
		else if (s[i] === '{') {
			if (depth === 0) {
				let j = i;
				while (j > 0 && isSpace(s[j - 1])) j--;
				if (j > 0 && (s[j - 1] === '_' || s[j - 1] === '^')) return true;
			} else depth--;
		}
	}
	return false;
}

function prevIsTermEnd(s, end) {
	if (end <= 0) return false;
	const head = s.slice(0, end);
	if (head.endsWith('\\}') || head.endsWith('\\right|')) return true;
	const ch = s[end - 1];
	if (ch === ')' || ch === ']' || ch === '}') return true;
	if (isAsciiDigit(ch)) return true;
	if (isAsciiAlpha(ch)) {
		let j = end;
		while (j > 0 && isAsciiAlpha(s[j - 1])) j--;
		if (j > 0 && s[j - 1] === '\\') return TERM_END_CMDS.has(s.slice(j, end));
		return true;
	}
	return false;
}

function nextIsTermStart(s, i) {
	if (i >= s.length) return false;
	NO_DASH_TEXT.lastIndex = i;
	if (NO_DASH_TEXT.test(s)) return false;
	const ch = s[i];
	if (ch === '\\') {
		const m = /^\\([A-Za-z]+)/.exec(s.slice(i, i + 40));
		return !!m && TERM_START_CMDS.has(m[1]);
	}
	return '([{'.includes(ch) || isAsciiDigit(ch) || isAsciiAlpha(ch);
}

const SPACED_ALPHA = /(\\,\s*)\\alpha(?![a-zA-Z])(\s*\\,)/g;

/**
 * Python fix_propto: `\infty` between two terms (and a two-side-spaced
 * `\, \alpha \,`) -> `\propto`. Operates on ONE formula body.
 */
export function fixPropto(body) {
	if (!body.includes('\\infty') && !body.includes('\\alpha')) return body;
	let out = '';
	let pos = 0;
	for (const m of body.matchAll(/\\infty(?![a-zA-Z])/g)) {
		const a = skipSpacingBack(body, m.index);
		const b = skipSpacingFwd(body, m.index + m[0].length);
		if (prevIsTermEnd(body, a) && nextIsTermStart(body, b) && !inScriptGroup(body, m.index)) {
			out += body.slice(pos, m.index) + '\\propto';
			pos = m.index + m[0].length;
		}
	}
	out += body.slice(pos);
	return out.replace(SPACED_ALPHA, (_, a, c) => a + '\\propto' + c);
}

/* ------------------------------------------------------------------ whole note */

export function splitFrontmatter(source) {
	const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source);
	return m ? [m[0], source.slice(m[0].length)] : ['', source];
}

/**
 * Applies both rules to a note. Propto only inside `$$ ... $$` outside code
 * (as fix_latex_artifacts); the Symbol map on the whole body outside code.
 * Frontmatter is never touched.
 * Returns {text, symbol:{mapped,unmapped}, propto:[{line,before,after}]}.
 */
export function repairNote(source) {
	const [fm, body0] = splitFrontmatter(source);
	const fmLines = fm.split('\n').length - 1;
	const symbol = countPua(body0);
	const body1 = mapSymbolPua(body0);
	const propto = [];
	const body2 = outsideCode(body1, (chunk) =>
		chunk.replace(/\$\$([\s\S]*?)\$\$/g, (whole, inner) => {
			const fixed = fixPropto(inner);
			if (fixed === inner) return whole;
			propto.push({ before: inner, after: fixed });
			return '$$' + fixed + '$$';
		})
	);
	let from = 0;
	for (const p of propto) {
		const idx = body2.indexOf('$$' + p.after + '$$', from);
		if (idx >= 0) {
			p.line = body2.slice(0, idx).split('\n').length + fmLines;
			from = idx + 1;
		}
	}
	return { text: fm + body2, symbol, propto };
}
