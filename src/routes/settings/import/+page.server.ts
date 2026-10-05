import { redirect } from '@sveltejs/kit';

// The note-app import is now a section of the upload page (one place to add content), but
// the old URL is still in bookmarks, older builds' empty-state links and docs — 307 keeps
// them working and lands on the section itself.
export function load() {
	redirect(307, '/settings/library#kutuphane-ice-aktar');
}
