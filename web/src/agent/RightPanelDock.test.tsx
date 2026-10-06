import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RightPanelDock } from './RightPanelDock';

afterEach(cleanup);

function dock() {
  return render(<RightPanelDock config={<div>配置内容</div>} files={<div>文件内容</div>} />);
}

describe('right panel dock', () => {
  it('starts with Config and lets both panels close', async () => {
    dock();
    expect(screen.getByText('配置内容')).toBeTruthy();
    expect(screen.queryByText('文件内容')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起 Config 面板' }));
    await waitFor(() => expect(screen.queryByText('配置内容')).toBeNull());
    expect(screen.queryByText('文件内容')).toBeNull();
  });

  it('finishes closing one panel before opening the other, even after rapid clicks', async () => {
    dock();
    fireEvent.click(screen.getByRole('button', { name: '打开文件管理面板' }));
    expect(screen.queryByText('文件内容')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开 Config 面板' }));
    fireEvent.click(screen.getByRole('button', { name: '打开文件管理面板' }));
    await waitFor(() => expect(screen.getByText('文件内容')).toBeTruthy());
    expect(screen.queryByText('配置内容')).toBeNull();
    expect(screen.getByRole('button', { name: '收起文件管理面板' }).getAttribute('aria-expanded')).toBe('true');
  });
});
