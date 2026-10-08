<script lang="ts">
	import { page } from '$app/state';
	import { beforeNavigate, goto } from '$app/navigation';
	import { onDestroy, untrack, type Component } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { planBySize } from '$lib/wysiwyg/block-safety';
	import { detectEol } from '$lib/wysiwyg/note-blocks';
	import { resolveBackHref } from '$lib/back-link';
	import { t, i18n } from '$lib/i18n/index.svelte';
	import { intlLocale } from '$lib/i18n/locales';
	import { relativeTime } from '$lib/relative-time';
	import { localizeError, readResponseError } from '$lib/server-error';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import CheckIcon from '@lucide/svelte/icons/check';

	type Revision = { id: string; at: string; bytes: number };
	type EditorProps = { value: string; onchange: (next: string) => void };
	type VisualProps = {
		value: string;
		onchange: (next: string) => void;
		vaultId: string;
		currentPath: string;
		onfallback: (reason: 'too-many-unsafe', count: number) => void;
	};
	type VisualApi = { flush: () => string };

	// What the disk holds (as last fetched/saved) and its hash — the hash is
	// the optimistic-lock token sent back as baseHash on save.
	let raw = $state('');
	let hash = $state('');
	let html = $state('');
	let error = $state('');

	let editing = $state(false);
	let draft = $state('');
	let previewHtml = $state('');
	let saving = $state(false);
	let saveError = $state('');
	let conflict = $state(false);
	let savedFlash = $state('');
	let indexNote = $state<{ kind: 'pending' } | { kind: 'failed'; detail: string } | null>(null);
	let EditorComp = $state<Component<EditorProps> | null>(null);
	let VisualComp = $state<Component<VisualProps, VisualApi> | null>(null);
	let visualRef = $state<VisualApi | undefined>();
	let editorLoading = $state(false);
	// "visual" = Milkdown WYSIWYG (default), "source" = CodeMirror + live preview.
	let editMode = $state<'visual' | 'source'>('visual');
	let modeNote = $state('');

	let showVersions = $state(false);
	let versionsLoading = $state(false);
	let revisions = $state<Revision[]>([]);
	let revPreview = $state<{ rev: Revision; raw: string; html: string } | null>(null);
	let restoring = $state(false);

	let confirmOpen = $state(false);
	let confirmState = $state<{ message: string; action: string; run: () => void }>({ message: '', action: '', run: () => {} });

	let filePath = $derived(page.url.searchParams.get('path') ?? '');
	let vaultId = $derived(page.url.searchParams.get('vault') ?? '');
	let dirty = $derived(editing && draft !== raw);
	// See back-link.ts — sourceLink.ts's libraryViewerUrl attaches `from`
	// whenever a study page or SourceChip links here, so this returns to
	// the exact artifact the citation was clicked from, not a hardcoded
	// home link.
	let backHref = $derived(resolveBackHref(page.url.searchParams.get('from'), vaultId ? `/vault/${vaultId}` : '/'));

	// Reload whenever the target file changes (also covers first mount).
	$effect(() => {
		void filePath;
		void vaultId;
		untrack(load);
	});

	function fileUrl(base: string, extra?: Record<string, string>): string {
		const params = new URLSearchParams({ path: filePath, ...extra });
		if (vaultId) params.set('vault', vaultId);
		return `${base}?${params.toString()}`;
	}

	// Strip the YAML frontmatter block before rendering — a plain markdown
	// renderer has no concept of frontmatter and would otherwise show the raw
	// "---\nkey: value\n---" block as text. \r?\n so a file saved with Windows
	// line endings (e.g. by the editor round-trip) still strips cleanly.
	function render(source: string): Promise<string> {
		const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
		return renderMarkdown(body, vaultId ? { vaultId, currentPath: filePath } : undefined);
	}

	async function fetchFile(): Promise<{ raw: string; hash: string }> {
		const res = await fetch(fileUrl('/api/library/file'));
		if (!res.ok) throw new Error();
		return (await res.json()) as { raw: string; hash: string };
	}

	async function load() {
		error = '';
		html = '';
		editing = false;
		conflict = false;
		saveError = '';
		revPreview = null;
		showVersions = false;
		if (!filePath) {
			error = t('LibraryViewPage.missingPath');
			return;
		}
		try {
			const data = await fetchFile();
			raw = data.raw;
			hash = data.hash;
			html = await render(raw);
		} catch {
			error = t('LibraryViewPage.loadFailed');
		}
	}

	// ---- confirm dialog (shared by cancel / navigate-away / reload-from-disk) ----
	function askConfirm(message: string, action: string, run: () => void) {
		confirmState = { message, action, run };
		confirmOpen = true;
	}

	// ---- edit mode ----
	async function startEdit() {
		draft = raw;
		previewHtml = html;
		saveError = '';
		conflict = false;
		savedFlash = '';
		indexNote = null;
		revPreview = null;
		showVersions = false;
		editing = true;
		modeNote = '';
		// Book-sized notes would take many seconds to build as a visual document.
		if (planBySize(new Blob([raw]).size).mode === 'source') {
			editMode = 'source';
			modeNote = t('WysiwygEditor.fallbackTooLarge');
		} else {
			editMode = 'visual';
		}
		await ensureEditor();
	}

	// Editors are heavy (CodeMirror, Milkdown + KaTeX): pulled in only when the
	// mode is actually shown, never with the read view.
	async function ensureEditor() {
		const needVisual = editMode === 'visual' && !VisualComp;
		const needSource = editMode === 'source' && !EditorComp;
		if (!needVisual && !needSource) return;
		editorLoading = true;
		try {
			if (needVisual) VisualComp = (await import('$lib/components/WysiwygEditor.svelte')).default as unknown as Component<VisualProps, VisualApi>;
			else EditorComp = (await import('$lib/components/MarkdownEditor.svelte')).default as Component<EditorProps>;
		} catch {
			saveError = t('LibraryViewPage.editorLoadFailed');
		} finally {
			editorLoading = false;
		}
	}

	async function switchMode(next: 'visual' | 'source') {
		if (next === editMode) return;
		// pull any debounced visual edit into `draft` before the other editor takes over
		if (editMode === 'visual') visualRef?.flush();
		modeNote = '';
		if (next === 'visual' && planBySize(new Blob([draft]).size).mode === 'source') {
			modeNote = t('WysiwygEditor.fallbackTooLarge');
			return;
		}
		// CodeMirror hands back LF text; a CRLF note must go back to the visual editor as CRLF,
		// otherwise merely peeking at the source would rewrite every line ending on save.
		if (next === 'visual' && detectEol(raw) === '\r\n' && !draft.includes('\r')) draft = draft.replace(/\n/g, '\r\n');
		if (next === 'source') previewHtml = await render(draft);
		editMode = next;
		await ensureEditor();
	}

	// The visual editor found too many blocks it cannot edit safely: hand the note to CodeMirror.
	async function visualFallback(_reason: 'too-many-unsafe', count: number) {
		modeNote = t('WysiwygEditor.fallbackUnsafe', { count });
		previewHtml = await render(draft);
		editMode = 'source';
		await ensureEditor();
	}

	function leaveEdit() {
		editing = false;
		conflict = false;
		saveError = '';
	}

	function cancelEdit() {
		if (dirty) askConfirm(t('LibraryViewPage.unsavedConfirm'), t('LibraryViewPage.leave'), leaveEdit);
		else leaveEdit();
	}

	// Live preview, debounced so typing doesn't re-run the markdown pipeline
	// (KaTeX, highlighting) on every keystroke. The sequence counter drops a
	// slow render that finishes after a newer one was already requested.
	let previewSeq = 0;
	$effect(() => {
		if (!editing || editMode !== 'source') return;
		const text = draft;
		const timer = setTimeout(async () => {
			const seq = ++previewSeq;
			const out = await render(text);
			if (seq === previewSeq) previewHtml = out;
		}, 250);
		return () => clearTimeout(timer);
	});

	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	function flash(message: string) {
		savedFlash = message;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (savedFlash = ''), 4000);
	}
	onDestroy(() => clearTimeout(flashTimer));

	async function finishSave(content: string, result: { hash: string; indexPending: boolean; indexError?: string }, message: string) {
		raw = content;
		hash = result.hash;
		html = await render(content);
		editing = false;
		conflict = false;
		saveError = '';
		revPreview = null;
		indexNote = result.indexError
			? { kind: 'failed', detail: localizeError({ code: result.indexError }) }
			: result.indexPending
				? { kind: 'pending' }
				: null;
		flash(message);
	}

	async function errorCode(res: Response): Promise<string | undefined> {
		const body = (await res.clone().json().catch(() => null)) as { code?: string } | null;
		return body?.code;
	}

	async function put(baseHash: string) {
		const content = draft;
		try {
			const res = await fetch('/api/library/file', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: filePath, vault: vaultId || undefined, content, baseHash })
			});
			if (!res.ok) {
				if (res.status === 409 && (await errorCode(res)) === 'LIBRARY_EDIT_CONFLICT') {
					conflict = true;
					return;
				}
				saveError = await readResponseError(res);
				return;
			}
			await finishSave(content, await res.json(), t('LibraryViewPage.saved'));
		} catch (e) {
			saveError = localizeError(e as Error);
		}
	}

	async function save() {
		if (editing && editMode === 'visual') visualRef?.flush();
		if (!editing || saving || !dirty) return;
		saving = true;
		saveError = '';
		conflict = false;
		try {
			await put(hash);
		} finally {
			saving = false;
		}
	}

	// "Yine de kaydet": adopt whatever is on disk NOW as the base, then write
	// the draft over it. The user has explicitly chosen to overwrite.
	async function forceSave() {
		if (saving) return;
		saving = true;
		saveError = '';
		try {
			const fresh = await fetchFile();
			hash = fresh.hash;
			conflict = false;
			await put(fresh.hash);
		} catch {
			saveError = t('LibraryViewPage.loadFailed');
		} finally {
			saving = false;
		}
	}

	async function reloadFromDisk() {
		try {
			const fresh = await fetchFile();
			raw = fresh.raw;
			hash = fresh.hash;
			html = await render(raw);
			leaveEdit();
		} catch {
			saveError = t('LibraryViewPage.loadFailed');
		}
	}

	function askReload() {
		if (dirty) askConfirm(t('LibraryViewPage.discardConfirm'), t('LibraryViewPage.discard'), reloadFromDisk);
		else reloadFromDisk();
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (editing && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
			e.preventDefault();
			save();
		}
	}

	// In-app navigation: ask first. Leaving the app (reload/close/external
	// link) can't be intercepted with our own dialog — cancel() there hands
	// control to the browser's native "leave site?" prompt.
	beforeNavigate((nav) => {
		if (!dirty) return;
		nav.cancel();
		if (nav.willUnload || !nav.to) return;
		const target = nav.to.url;
		askConfirm(t('LibraryViewPage.unsavedConfirm'), t('LibraryViewPage.leave'), () => {
			editing = false; // clears `dirty`, so the re-issued navigation passes
			goto(target.pathname + target.search + target.hash);
		});
	});

	function onBeforeUnload(e: BeforeUnloadEvent) {
		if (dirty) {
			e.preventDefault();
			e.returnValue = '';
		}
	}

	// ---- previous versions ----
	async function toggleVersions() {
		showVersions = !showVersions;
		if (!showVersions) return;
		versionsLoading = true;
		try {
			const res = await fetch(fileUrl('/api/library/file/revisions'));
			if (!res.ok) {
				saveError = await readResponseError(res);
				revisions = [];
			} else {
				revisions = ((await res.json()) as { revisions: Revision[] }).revisions;
			}
		} catch (e) {
			saveError = localizeError(e as Error);
		} finally {
			versionsLoading = false;
		}
	}

	async function openRevision(rev: Revision) {
		saveError = '';
		try {
			const res = await fetch(fileUrl('/api/library/file/revisions', { id: rev.id }));
			if (!res.ok) {
				saveError = await readResponseError(res);
				return;
			}
			const data = (await res.json()) as { raw: string };
			revPreview = { rev, raw: data.raw, html: await render(data.raw) };
			showVersions = false;
		} catch (e) {
			saveError = localizeError(e as Error);
		}
	}

	async function restoreRevision() {
		if (!revPreview || restoring) return;
		restoring = true;
		saveError = '';
		const { rev, raw: content } = revPreview;
		try {
			const res = await fetch('/api/library/file/revisions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: filePath, vault: vaultId || undefined, id: rev.id, baseHash: hash })
			});
			if (!res.ok) {
				saveError = await readResponseError(res);
				return;
			}
			await finishSave(content, await res.json(), t('LibraryViewPage.restored'));
		} catch (e) {
			saveError = localizeError(e as Error);
		} finally {
			restoring = false;
		}
	}

	function formatSize(bytes: number): string {
		return t('LibraryViewPage.versionSize', { kb: (bytes / 1024).toFixed(1) });
	}
</script>

<svelte:head>
	<title>{filePath || t('LibraryViewPage.fallbackTitle')} — Vault Chat</title>
</svelte:head>

<svelte:window onkeydown={onWindowKeydown} onbeforeunload={onBeforeUnload} />

<div class="viewer" class:wide={editing}>
	<a class="home-link" href={backHref}><ArrowLeftIcon class="rtl-flip" size={14} aria-hidden="true" /> {t('Common.geriDon')}</a>
	<div class="toolbar">
		<p class="path">{filePath}</p>
		{#if !error}
			<div class="actions">
				{#if editing}
					<div class="mode-switch" role="group" aria-label={t('WysiwygEditor.modeLabel')}>
						<button type="button" aria-pressed={editMode === 'visual'} onclick={() => switchMode('visual')}>{t('WysiwygEditor.modeVisual')}</button>
						<button type="button" aria-pressed={editMode === 'source'} onclick={() => switchMode('source')}>{t('WysiwygEditor.modeSource')}</button>
					</div>
					{#if dirty}<span class="dirty-note">{t('LibraryViewPage.unsavedChanges')}</span>{/if}
					<button type="button" class="vc-btn ghost" onclick={cancelEdit} disabled={saving}>{t('LibraryViewPage.cancel')}</button>
					<button type="button" class="vc-btn primary" onclick={save} disabled={!dirty || saving}>
						{saving ? t('LibraryViewPage.saving') : t('LibraryViewPage.save')}
					</button>
				{:else}
					<button type="button" class="vc-btn ghost" onclick={toggleVersions} aria-expanded={showVersions}>
						<ClockIcon size={14} aria-hidden="true" /> {t('LibraryViewPage.versions')}
					</button>
					<button type="button" class="vc-btn secondary" onclick={startEdit}>
						<PencilIcon size={14} aria-hidden="true" /> {t('LibraryViewPage.edit')}
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if showVersions && !editing}
		<div class="versions" role="region" aria-label={t('LibraryViewPage.versions')}>
			{#if versionsLoading}
				<p class="versions-note">{t('LibraryViewPage.versionsLoading')}</p>
			{:else if revisions.length === 0}
				<p class="versions-note">{t('LibraryViewPage.versionsEmpty')}</p>
			{:else}
				<ul>
					{#each revisions as rev (rev.id)}
						<li>
							<button type="button" class="version-row" onclick={() => openRevision(rev)}>
								<span>{relativeTime(rev.at, i18n.locale)}</span>
								<span class="version-meta">{new Date(rev.at).toLocaleString(intlLocale(i18n.locale))} · {formatSize(rev.bytes)}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	{#if savedFlash}
		<p class="saved-flash" role="status"><CheckIcon size={14} aria-hidden="true" /> {savedFlash}</p>
	{/if}
	{#if indexNote}
		<div class="vc-banner info note" role="status">
			<span class="dot"></span>
			<div class="d">
				{indexNote.kind === 'pending'
					? t('LibraryViewPage.indexPending')
					: t('LibraryViewPage.indexFailed', { detail: indexNote.detail })}
			</div>
		</div>
	{/if}
	{#if conflict}
		<div class="vc-banner warning note" role="alert">
			<span class="dot"></span>
			<div class="conflict">
				<div class="t">{t('LibraryViewPage.conflictTitle')}</div>
				<div class="d">{t('LibraryViewPage.conflictBody')}</div>
				<div class="conflict-actions">
					<button type="button" class="vc-btn secondary" onclick={askReload} disabled={saving}>{t('LibraryViewPage.conflictReload')}</button>
					<button type="button" class="vc-btn primary" onclick={forceSave} disabled={saving}>{t('LibraryViewPage.conflictForce')}</button>
				</div>
			</div>
		</div>
	{/if}
	{#if saveError}
		<div class="vc-banner danger note" role="alert">
			<span class="dot"></span>
			<div class="d">{saveError}</div>
		</div>
	{/if}

	{#if error}
		<div class="error">
			<TriangleAlertIcon size={16} aria-hidden="true" />
			<p>{error}</p>
		</div>
	{:else if editing && editMode === 'visual'}
		{#if modeNote}<p class="mode-note" role="status">{modeNote}</p>{/if}
		<div class="visual">
			{#if VisualComp}
				<VisualComp
					bind:this={visualRef}
					value={draft}
					onchange={(next) => (draft = next)}
					{vaultId}
					currentPath={filePath}
					onfallback={visualFallback}
				/>
			{:else if editorLoading}
				<p class="pane-note">{t('WysiwygEditor.loading')}</p>
			{/if}
		</div>
	{:else if editing}
		{#if modeNote}<p class="mode-note" role="status">{modeNote}</p>{/if}
		<div class="split">
			<section class="pane editor-pane" aria-label={t('LibraryViewPage.editorLabel')}>
				{#if EditorComp}
					<EditorComp value={draft} onchange={(next) => (draft = next)} />
				{:else if editorLoading}
					<p class="pane-note">{t('LibraryViewPage.editorLoading')}</p>
				{/if}
			</section>
			<section class="pane preview-pane" aria-label={t('LibraryViewPage.previewLabel')}>
				<div class="content markdown-body">{@html previewHtml}</div>
			</section>
		</div>
	{:else if revPreview}
		<div class="vc-banner info note">
			<span class="dot"></span>
			<div class="rev-banner">
				<div class="d">{t('LibraryViewPage.previewingVersion', { when: new Date(revPreview.rev.at).toLocaleString(intlLocale(i18n.locale)) })}</div>
				<div class="conflict-actions">
					<button type="button" class="vc-btn primary" onclick={restoreRevision} disabled={restoring}>{t('LibraryViewPage.restore')}</button>
					<button type="button" class="vc-btn ghost" onclick={() => (revPreview = null)}>{t('LibraryViewPage.closeVersionPreview')}</button>
				</div>
			</div>
		</div>
		<div class="content markdown-body">{@html revPreview.html}</div>
	{:else}
		<div class="content markdown-body">{@html html}</div>
	{/if}
</div>

<AlertDialog.Root bind:open={confirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{confirmState.message}</AlertDialog.Title>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{t('LibraryViewPage.keepEditing')}</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={(e) => {
					e.preventDefault();
					confirmOpen = false;
					confirmState.run();
				}}
			>
				{confirmState.action}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	.viewer {
		max-width: 760px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}

	/* Edit mode needs room for two panes side by side. */
	.viewer.wide {
		max-width: 1400px;
	}

	.home-link {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font: var(--text-subheadline);
		text-decoration: none;
		color: var(--label-secondary);
		margin-bottom: 1rem;
	}

	.home-link:hover {
		color: var(--label);
	}

	.home-link:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
	}

	.path {
		font: var(--text-caption-1);
		color: var(--label-secondary);
		margin: 0;
		font-family: var(--font-mono);
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.dirty-note {
		font: var(--text-caption-1);
		color: var(--warning);
	}

	.versions {
		margin: -0.75rem 0 1.25rem;
		padding: 0.35rem;
		border-radius: var(--radius-lg);
		background: var(--bg-elevated);
		box-shadow: inset 0 0 0 1px var(--separator);
		max-height: 16rem;
		overflow-y: auto;
	}

	.versions ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.versions-note {
		margin: 0;
		padding: 0.6rem 0.75rem;
		font: var(--text-footnote);
		color: var(--label-secondary);
	}

	.version-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--label);
		font: var(--text-subheadline);
		text-align: start;
		cursor: pointer;
	}

	.version-row:hover {
		background: var(--fill-hover);
	}

	.version-row:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	.version-meta {
		font: var(--text-caption-1);
		color: var(--label-secondary);
	}

	.saved-flash {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0 0 1rem;
		font: var(--text-footnote);
		color: var(--success);
	}

	.note {
		margin-bottom: 1rem;
	}

	.conflict,
	.rev-banner {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.conflict-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.split {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
		height: calc(100dvh - 13rem);
		min-height: 420px;
	}

	.pane {
		min-height: 0;
		min-width: 0;
	}

	.visual {
		height: calc(100dvh - 13rem);
		min-height: 420px;
	}

	.mode-note {
		margin: -0.5rem 0 0.75rem;
		font: var(--text-footnote);
		color: var(--label-secondary);
	}

	.mode-switch {
		display: inline-flex;
		padding: 2px;
		border-radius: var(--radius-md);
		background: var(--fill-control);
		box-shadow: inset 0 0 0 1px var(--separator);
	}

	.mode-switch button {
		padding: 0.25rem 0.7rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--label-secondary);
		font: var(--text-footnote);
		cursor: pointer;
	}

	.mode-switch button[aria-pressed='true'] {
		background: var(--bg-elevated);
		color: var(--label);
		box-shadow: 0 0 0 1px var(--separator-strong);
	}

	.mode-switch button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.preview-pane {
		overflow: auto;
		padding: 0.5rem 1.25rem 1.5rem;
		border-radius: var(--radius-lg);
		box-shadow: inset 0 0 0 1px var(--separator);
	}

	.pane-note {
		margin: 0;
		padding: 1rem;
		font: var(--text-footnote);
		color: var(--label-secondary);
	}

	/* Narrow window: editor above preview instead of side by side. */
	@media (max-width: 900px) {
		.split {
			grid-template-columns: 1fr;
			grid-template-rows: minmax(320px, 55dvh) minmax(260px, 45dvh);
			height: auto;
		}
	}

	.error {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.9rem 1rem;
		box-shadow: inset 0 0 0 1px var(--separator);
		border-radius: var(--radius-lg);
		background: var(--bg-elevated);
		color: var(--danger);
	}

	.error p {
		margin: 0;
		color: var(--color-foreground);
	}

	.content {
		line-height: 1.7;
	}
</style>
