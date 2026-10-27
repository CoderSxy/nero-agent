import { Mastra } from '@mastra/core/mastra';
import { createStorageRuntime } from './observability/runtime';
import { assertStorageReady } from './storage/readiness';
import { getPool } from './auth/db';
import { agent } from './agents/agent';
import { submitChartDataTool } from './agents/chart-data-tool';
import { authRoutes } from './auth/routes';
import { startSandboxReconcile } from './sandbox/factory';
import { executeBashTool, executeCommandTool } from './sandbox/tool';
import { startScheduleTool, stopScheduleTool } from './tools/schedule-tools';
import { tavilySearchTool } from './tools/tavily-search-tool';
import { studioChineseMiddleware } from './studio-zh';
import { agentModelLockMiddleware } from './agent-model-lock';
import { authorizeThreadRoute } from './auth/authorization';
import { currentWorkspaceFileRoutes, fileRoutes } from './files/routes';
import { turnArtifactRoutes } from './files/artifacts/routes';
import { userFileTools } from './files/tools';
import { modelRoutes } from './models/routes';
import { modelAdminRoutes } from './models/admin-page';
import { authContextFromUser, resourceIdFor } from './auth/auth-context';
import { getUserByToken } from './auth/service';
import { studioAuth } from './auth/studio';
import { createStudioProxyAuth } from './auth/studio-proxy';
import { financeRoutes } from './finance/routes';
import { financeSearchTool, financeInterfaceInfoTool, financeFetchTool } from './finance/tools';
import { createScheduledTaskHooks } from './scheduled-tasks/hooks';
import { nativeScheduleGuardMiddleware } from './scheduled-tasks/native-guard';
import { startScheduledTaskReconcile } from './scheduled-tasks/reconcile';
import { startSkillsReconcile } from './skills/reconcile';
import { scheduledTaskRoutes } from './scheduled-tasks/routes';
import { resolveSkillAgentTools } from './skills/factory';
import { skillRoutes } from './skills/routes';
import { historyRoutes } from './history/routes';

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

await assertStorageReady(getPool());
const storageRuntime = createStorageRuntime();
await storageRuntime.storage.init();

export const mastra = new Mastra({
  studio: { auth: configuredStudioAuth },
  server: {
    studioBase: process.env.MASTRA_STUDIO_BASE || '/',
    middleware: [
      nativeScheduleGuardMiddleware,
      agentModelLockMiddleware,
      authorizeThreadRoute,
      studioChineseMiddleware,
    ],
    apiRoutes: [...authRoutes, ...modelRoutes, ...modelAdminRoutes, ...fileRoutes,
      ...currentWorkspaceFileRoutes, ...turnArtifactRoutes, ...financeRoutes, ...scheduledTaskRoutes, ...skillRoutes,
      ...historyRoutes],
    auth: {
      authenticateToken: async token => getUserByToken(token),
      mapUserToResourceId: user => resourceIdFor(authContextFromUser(user)),
    },
  },
  agents: { agent },
  tools: { submitChartDataTool, startScheduleTool, stopScheduleTool, tavilySearchTool, executeCommandTool, executeBashTool, ...userFileTools,
    financeSearchTool, financeInterfaceInfoTool, financeFetchTool,
    // App skill tools only when AGENT_SKILLS_ENABLED=true; never native Agent.skills auto-tools.
    ...resolveSkillAgentTools() },
  schedules: createScheduledTaskHooks(),
  storage: storageRuntime.storage,
  observability: storageRuntime.observability,
});

startScheduledTaskReconcile(mastra.schedules);
startSkillsReconcile();
startSandboxReconcile();
