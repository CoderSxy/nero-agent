#!/usr/bin/env node
const verified = process.env.WORKSPACE_HOST_QUOTA_VERIFIED === 'true';
const writes = process.env.SANDBOX_FILE_WRITE_ENABLED === 'true';
if (!verified) {
  console.error('WORKSPACE_HOST_QUOTA_VERIFIED is not true; keep SANDBOX_FILE_WRITE_ENABLED=false');
  process.exit(1);
}
if (!writes) {
  console.error('Host quota is marked verified but SANDBOX_FILE_WRITE_ENABLED is false');
  process.exit(1);
}
console.log('Workspace host quota gate is open');
