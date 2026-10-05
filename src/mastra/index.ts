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
import { agentModelLockMiddleware } from './agent-model-lock';
import { authorizeThreadRoute } from './auth/authorization';
import { fileRoutes } from './files/routes';
import { userFileTools } from './files/tools';
import { modelRoutes } from './models/routes';
import { modelAdminRoutes } from './models/admin-page';
import { authContextFromUser, resourceIdFor } from './auth/auth-context';
import { getUserByToken } from './auth/service';
import { studioAuth } from './auth/studio';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL 未配置，请先运行 npm run db:local:setup');

export const mastra = new Mastra({
  studio: { auth: studioAuth },
  server: {
    middleware: [agentModelLockMiddleware, authorizeThreadRoute, studioChineseMiddleware],
    apiRoutes: [...authRoutes, ...modelRoutes, ...modelAdminRoutes, ...fileRoutes],
    auth: {
      authenticateToken: async token => getUserByToken(token),
      mapUserToResourceId: user => resourceIdFor(authContextFromUser(user)),
    },
  },
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  agents: { agent },
  tools: { startScheduleTool, stopScheduleTool, tavilySearchTool, ...userFileTools },
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
