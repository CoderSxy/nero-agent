import { Mastra } from '@mastra/core/mastra';
import { PostgresStore } from '@mastra/pg';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { agent } from './agents/agent';
import { startScheduleTool, stopScheduleTool } from './tools/schedule-tools';
import { tavilySearchTool } from './tools/tavily-search-tool';
import { studioChineseMiddleware } from './studio-zh';
import { authRoutes } from './auth/routes';
import { getUserByToken } from './auth/service';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL 未配置，请先运行 npm run db:local:setup');

export const mastra = new Mastra({
  server: {
    middleware: [studioChineseMiddleware],
    apiRoutes: authRoutes,
    auth: {
      authenticateToken: async token => getUserByToken(token),
      mapUserToResourceId: user => user.id,
    },
  },
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  agents: { agent },
  tools: { startScheduleTool, stopScheduleTool, tavilySearchTool },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new PostgresStore({
      id: 'mastra-storage',
      connectionString: databaseUrl,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
