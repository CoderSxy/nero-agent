import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillImportDialog } from './SkillImportDialog';

const previewSkillImport = vi.fn();
const commitSkillImport = vi.fn();

vi.mock('./skills-api', () => ({
  SkillApiError: class SkillApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  previewSkillImport: (...args: unknown[]) => previewSkillImport(...args),
  commitSkillImport: (...args: unknown[]) => commitSkillImport(...args),
}));

afterEach(() => {
  cleanup();
  previewSkillImport.mockReset();
  commitSkillImport.mockReset();
});

describe('SkillImportDialog', () => {
  it('shows rename risk and commits only an accepted draft name', async () => {
    previewSkillImport.mockResolvedValue({
      importId: '11111111-1111-4111-8111-111111111111',
      report: {
        importId: '11111111-1111-4111-8111-111111111111',
        expiresAt: '2026-10-19T00:30:00.000Z',
        sourceName: 'legacy_name',
        suggestedCanonicalName: 'legacy-name',
        requiresNameAcceptance: true,
        canonicalName: '',
        description: 'desc',
        warnings: ['name needs acceptance'],
        referenceRenameRisks: [{
          path: 'SKILL.md',
          message: '来源名「legacy_name」与规范名「legacy-name」不同。接受新名称不会自动改写正文或资源里的引用，跨技能引用可能失效。',
        }],
        compatibility: 'instructions-only',
        files: [{ path: 'SKILL.md', hash: 'abc', size: 10 }],
      },
    });
    commitSkillImport.mockResolvedValue({ skill: { id: 'skill-1' }, version: { version: 1 } });
    const onCommitted = vi.fn();
    render(<SkillImportDialog open onClose={vi.fn()} onCommitted={onCommitted} />);
    expect(screen.getByText(/不会自动发布/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('导入 ZIP'), {
      target: { files: [new File(['zip'], 'pack.zip', { type: 'application/zip' })] },
    });
    expect(await screen.findByLabelText('改名引用风险')).toBeTruthy();
    expect(screen.getByText(/不会自动改写/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认导入草稿' }));
    await waitFor(() => expect(commitSkillImport).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      { acceptedName: 'legacy-name' },
    ));
    expect(onCommitted).toHaveBeenCalledWith('skill-1');
  });
});
