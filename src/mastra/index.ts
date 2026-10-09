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
import { authRoutes } from './auth/routes';
import { executeCommandTool } from './sandbox/tool';
import { startScheduleTool, stopScheduleTool } from './tools/schedule-tools';
import { tavilySearchTool } from './tools/tavily-search-tool';
import { studioChineseMiddleware } from './studio-zh';
import { agentModelLockMiddleware } from './agent-model-lock';
import { authorizeThreadRoute } from './auth/authorization';
import { currentWorkspaceFileRoutes, fileRoutes } from './files/routes';
import { userFileTools } from './files/tools';
import { modelRoutes } from './models/routes';
import { modelAdminRoutes } from './models/admin-page';
import { authContextFromUser, resourceIdFor } from './auth/auth-context';
import { getUserByToken } from './auth/service';
import { studioAuth } from './auth/studio';
import { createStudioProxyAuth } from './auth/studio-proxy';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL 未配置，请先运行 npm run db:local:setup');
const studioProxyKey = process.env.STUDIO_PROXY_KEY;
const studioAdminId = process.env.STUDIO_ADMIN_USER_ID;
if (Boolean(studioProxyKey) !== Boolean(studioAdminId))
  throw new Error('STUDIO_PROXY_KEY 和 STUDIO_ADMIN_USER_ID 必须同时配置');
const configuredStudioAuth = studioProxyKey && studioAdminId ? createStudioProxyAuth(studioProxyKey, {
  id: studioAdminId,
  email: process.env.STUDIO_ADMIN_EMAIL || 'admin@studio.local',
  displayName: process.env.STUDIO_ADMIN_NAME || '管理员',
  roles: ['admin'],
}) : studioAuth;

export const mastra = new Mastra({
  studio: { auth: configuredStudioAuth },
  server: {
    studioBase: process.env.MASTRA_STUDIO_BASE || '/',
    middleware: [agentModelLockMiddleware, authorizeThreadRoute, studioChineseMiddleware],
    apiRoutes: [...authRoutes, ...modelRoutes, ...modelAdminRoutes, ...fileRoutes,
      ...currentWorkspaceFileRoutes],
    auth: {
      authenticateToken: async token => getUserByToken(token),
      mapUserToResourceId: user => resourceIdFor(authContextFromUser(user)),
    },
  },
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  agents: { agent },
  tools: { startScheduleTool, stopScheduleTool, tavilySearchTool, executeCommandTool, ...userFileTools },
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
