import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthGate } from './auth/AuthGate';
import { Shell } from './components/Shell';
import { Button, Spinner } from './components/ui';
import { RealtimeProvider } from './state/Realtime';
import { ToastProvider } from './state/Toast';
import Overview from './pages/Overview';

// Heavy pages (React Flow, charts, forms) are split out of the initial bundle.
const Studio = lazy(() => import('./pages/Studio'));
const Voices = lazy(() => import('./pages/Voices'));
const Edit = lazy(() => import('./pages/Edit'));
const Vault = lazy(() => import('./pages/Vault'));
const Projects = lazy(() => import('./pages/Projects'));
const Project = lazy(() => import('./pages/Project'));
const PromptStudio = lazy(() => import('./pages/PromptStudio'));
const Workflows = lazy(() => import('./pages/Workflows'));
const WorkflowBuilder = lazy(() => import('./pages/WorkflowBuilder'));
const Media = lazy(() => import('./pages/Media'));
const Monitoring = lazy(() => import('./pages/Monitoring'));
const SettingsPage = lazy(() => import('./pages/Settings'));

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto mt-24 max-w-md space-y-3 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-6 text-center">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-slate-300">{this.state.error.message}</p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}

function NotFound() {
  return (
    <div className="mt-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-slate-400">That page doesn’t exist.</p>
    </div>
  );
}

export default function App() {
  return (
    <Boundary>
      <ToastProvider>
        <AuthGate>
          <RealtimeProvider>
            <BrowserRouter>
              <Suspense fallback={<div className="p-8"><Spinner /></div>}>
                <Routes>
                  <Route element={<Shell />}>
                    <Route index element={<Overview />} />
                    <Route path="projects" element={<Projects />} />
                    <Route path="projects/:id" element={<Project />} />
                    <Route path="studio" element={<Studio />} />
                    <Route path="voices" element={<Voices />} />
                    <Route path="edit" element={<Edit />} />
                    <Route path="vault" element={<Vault />} />
                    <Route path="prompts"element={<PromptStudio />} />
                    <Route path="workflows" element={<Workflows />} />
                    <Route path="workflows/:id" element={<WorkflowBuilder />} />
                    <Route path="media" element={<Media />} />
                    <Route path="monitoring" element={<Monitoring />} />
                    <Route path="settings" element={<SettingsPage />} />
                    <Route path="*" element={<NotFound />} />
                  </Route>
                </Routes>
              </Suspense>
            </BrowserRouter>
          </RealtimeProvider>
        </AuthGate>
      </ToastProvider>
    </Boundary>
  );
}
