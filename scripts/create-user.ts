import { createUser, type AppRole } from '../src/mastra/auth/service';
import { getPool } from '../src/mastra/auth/db';

const [email, displayName, role] = process.argv.slice(2);
const password = process.env.NERO_USER_PASSWORD;
if (!email || !displayName || (role !== 'admin' && role !== 'user') || !password) {
  console.error('用法: NERO_USER_PASSWORD=<密码> npm run user:create -- <邮箱> <显示名> <admin|user>');
  process.exitCode = 1;
} else {
  try {
    const user = await createUser({ email, displayName, password, role: role as AppRole });
    console.log(`Created ${user.email} (${user.roles.join(', ')})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '创建用户失败');
    process.exitCode = 1;
  } finally { await getPool().end(); }
}
