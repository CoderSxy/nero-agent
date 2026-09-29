import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

afterEach(cleanup);

describe('independent agent routes', () => {
  it('shows the agent page on /agent/new without embedding Studio', () => {
    const { container } = render(<MemoryRouter initialEntries={['/agent/new']}><App /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '智能体' })).toBeTruthy();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('sends unknown web routes to the new agent page', async () => {
    render(<MemoryRouter initialEntries={['/unknown']}><App /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: '智能体' })).toBeTruthy();
  });
});
