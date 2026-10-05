import { diskBlockRatio, diskWarnRatio, isSandboxFileWriteEnabled } from './config';
import { statfs } from 'node:fs/promises';
import { workspaceBase } from './path';

export class DiskProtectionError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'DiskProtectionError';
  }
}

export function assertWritable(bytes: number, usedRatio: number, largeWriteBytes = 10 * 1024 * 1024): void {
  if (usedRatio >= diskBlockRatio()) {
    throw new DiskProtectionError('磁盘使用率过高，已禁止写入');
  }
  if (usedRatio >= diskWarnRatio() && bytes >= largeWriteBytes) {
    throw new DiskProtectionError('磁盘使用率较高，已禁止大文件写入');
  }
}

export async function assertHostWritable(bytes: number): Promise<void> {
  const filesystem = await statfs(workspaceBase());
  const total = filesystem.blocks;
  if (total <= 0) throw new DiskProtectionError('无法读取宿主磁盘容量');
  assertWritable(bytes, 1 - filesystem.bavail / total);
}

export function assertHostQuotaReady(): void {
  if (process.env.WORKSPACE_HOST_QUOTA_VERIFIED !== 'true') {
    throw new DiskProtectionError('宿主项目配额未验证，禁止开放命令写入');
  }
  if (!isSandboxFileWriteEnabled()) {
    throw new DiskProtectionError('沙箱文件写入未开启');
  }
}
