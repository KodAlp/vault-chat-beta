/**
 * Which `EditorState.lineSeparator` a document needs so that CodeMirror's
 * save text equals what was loaded. CodeMirror splits on \r\n, \r and \n by
 * default and joins with \n, so a CRLF file silently became LF on save.
 *
 *  - every break is CRLF  -> '\r\n' (CodeMirror joins with CRLF again)
 *  - mixed / lone \r      -> '\n'   (only \n splits; stray \r stay in the text
 *                                    as characters, so the file round-trips)
 *  - pure LF / no breaks  -> undefined (CodeMirror's default is already exact)
 */
export function detectLineSeparator(text: string): '\r\n' | '\n' | undefined {
	if (!text.includes('\r')) return undefined;
	let crlf = 0;
	let lone = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === 13) {
			if (text.charCodeAt(i + 1) === 10) {
				crlf++;
				i++;
			} else lone++;
		} else if (c === 10) lone++;
	}
	return crlf > 0 && lone === 0 ? '\r\n' : '\n';
}
