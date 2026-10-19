import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MobileModels } from './MobileModels';
import type { SafeModel } from '../model-catalog-client';

afterEach(cleanup);

const model = (ref: `public:${string}` | `private:${string}`, name: string): SafeModel => ({
  ref, scope: ref.startsWith('private:') ? 'private' : 'public', displayName: name,
  providerId: 'openai', modelId: name, baseUrl: '', apiMode: 'chat', enabled: true,
  hasApiKey: true, keyHint: null, supportsVision: false,
});

it('groups public and private models using available catalog fields', () => {
  render(<MobileModels models={[model('private:a', '我的模型 A'), model('public:b', '公共模型 B')]}
    loading={false} error={null} onRetry={() => undefined} />);
  expect(screen.getByRole('heading', { name: '我的模型' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '公共模型' })).toBeTruthy();
  expect(screen.getByText('我的模型 A')).toBeTruthy();
  expect(screen.getByText('公共模型 B')).toBeTruthy();
  expect(screen.queryByText(/剩余额度/)).toBeNull();
});
