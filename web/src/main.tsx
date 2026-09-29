import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MastraReactProvider } from '@mastra/react';
import { App } from './App';
import './styles.css';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MastraReactProvider baseUrl="" apiPrefix="/api">
        <BrowserRouter><App /></BrowserRouter>
      </MastraReactProvider>
    </QueryClientProvider>
  </StrictMode>,
);
