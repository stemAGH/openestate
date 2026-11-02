import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './lib/auth';
import { getSessionEpoch } from './lib/api';
import { toast, ToastContainer } from './lib/toast';
import App from './App';
import './index.css';

function SessionQueries({ sessionEpoch }: { sessionEpoch: number }) {
  const [queryClient] = useState(() => new QueryClient({
    mutationCache: new MutationCache({
      onError: (error) => {
        if (sessionEpoch === getSessionEpoch()) {
          toast.error(error instanceof Error ? error.message : 'Something went wrong.');
        }
      },
    }),
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  }));

  useEffect(() => () => {
    // StrictMode replays cleanup without ending the session.
    if (sessionEpoch !== getSessionEpoch()) queryClient.clear();
  }, [queryClient, sessionEpoch]);

  return (
    <QueryClientProvider client={queryClient}>
      <App />
      <ToastContainer />
    </QueryClientProvider>
  );
}

function SessionBoundary() {
  const { sessionEpoch } = useAuth();
  return <SessionQueries key={sessionEpoch} sessionEpoch={sessionEpoch} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <SessionBoundary />
    </AuthProvider>
  </React.StrictMode>,
);
