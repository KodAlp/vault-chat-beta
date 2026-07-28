import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// Pin to IPv4 loopback explicitly. Vite's default host resolution picked
	// whichever address "localhost" resolved to first on this machine (IPv6
	// ::1), which some Windows setups (VPN/AV breaking IPv6 loopback) can't
	// reach even though the app is meant to be loopback-only either way.
	server: {
		host: '127.0.0.1'
	}
});
