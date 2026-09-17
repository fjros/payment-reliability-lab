import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connectionString, loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { systemClock } from '../shared/clock.ts';
import { createLogger } from '../shared/logger.ts';
import { buildMcpServer } from './server.ts';

// stdout carries ONLY MCP protocol messages; all diagnostics go to stderr through the logger.
const config = loadConfig();
const logger = createLogger('mcp');
// Read-only role: SELECT on readmodel views only, default_transaction_read_only = on.
const pool = createPool(connectionString(config.db, 'mcp'), 4);
const server = buildMcpServer({ pool, clock: systemClock, logger, allowedRunIds: config.mcpRunIds });
await server.connect(new StdioServerTransport());
logger.info('mcp server ready', { transport: 'stdio', allowedRunIds: config.mcpRunIds, database: config.db.appDatabase });

const close = async (): Promise<void> => {
  await server.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
