import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: {
  retry: (failureCount, error) => {
    const status = (error as { status?: number })?.status;
    if (status === 429 || (status !== undefined && status >= 400 && status < 500)) return false;
    return failureCount < 1;
  },
  refetchOnWindowFocus: false
} } });
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></React.StrictMode>);
