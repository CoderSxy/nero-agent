import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MastraReactProvider } from '@mastra/react';
import { useState, type ReactNode } from 'react';

export const mastraReactClientConfig = {
  baseUrl: '',
  apiPrefix: '/api',
};

export function MastraAppProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <MastraReactProvider {...mastraReactClientConfig}>
        {children}
      </MastraReactProvider>
    </QueryClientProvider>
  );
}
