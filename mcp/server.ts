import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './create-server';

const server = createServer();

process.on('unhandledRejection', (err) => {
	console.error('[vault-chat-mcp] unhandled rejection', err);
	process.exit(1);
});
process.on('uncaughtException', (err) => {
	console.error('[vault-chat-mcp] uncaught exception', err);
	process.exit(1);
});

await server.connect(new StdioServerTransport());
