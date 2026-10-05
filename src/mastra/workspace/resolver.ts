import { LocalFilesystem } from '@mastra/core/workspace';
import type { RequestContext } from '@mastra/core/request-context';
import { trustedAuth } from '../auth/auth-context';
import { ensureUserWorkspace } from './manager';

export async function resolveUserFilesystem({ requestContext }: { requestContext: RequestContext }) {
  const auth = trustedAuth(requestContext);
  const root = await ensureUserWorkspace(auth);
  return new LocalFilesystem({
    basePath: root,
    contained: true,
    allowedPaths: [],
  });
}
