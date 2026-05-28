import { useCallback, useEffect, useState } from 'react';
import { PrimarySidebar, type AppRoute } from './app/PrimarySidebar';
import { useQuayAdminReadModel } from './api/quayAdmin';
import { MissionControlPage } from './mission-control/MissionControlPage';
import { useMissionControlTasks } from './mission-control/useMissionControlTasks';
import { ApiErrorScreen, ApiLoadingScreen } from './screens/ApiStateScreen';
import { ArchiveConfirmDialog } from './screens/ArchiveConfirmDialog';
import { EmptyScreen } from './screens/EmptyScreen';
import { GlobalScreen } from './screens/GlobalScreen';
import { LeftRail } from './screens/LeftRail';
import { PreambleDrawer } from './screens/PreambleDrawer';
import { RepoScreen } from './screens/RepoScreen';
import { SaveFooter } from './screens/SaveFooter';
import { SavePreviewModal } from './screens/SavePreviewModal';
import { TopBar } from './screens/TopBar';
import { useChangeStore } from './store/dirty';

type Scope = 'global' | string;
interface RouteState {
  route: AppRoute;
  scope: Scope;
  basePath: string;
  hasRoute: boolean;
}

type Overlay =
  | null
  | { type: 'save-preview' }
  | { type: 'preamble-drawer'; kind: 'worker' | 'reviewer' }
  | { type: 'archive-confirm'; repoId: string };

type Mode = 'light' | 'dark';

function readModeFromStorage(): Mode {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem('quay-mode');
  return stored === 'dark' ? 'dark' : 'light';
}

function readRouteState(): RouteState {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const routeIndex = parts.findIndex((part) => part === 'mission-control' || part === 'configuration');
  const hasRoute = routeIndex >= 0;
  const route = parts[routeIndex] === 'configuration' ? 'configuration' : 'mission-control';
  const scope = route === 'configuration' && parts[routeIndex + 1] ? decodeURIComponent(parts[routeIndex + 1]!) : 'global';
  const baseParts = hasRoute ? parts.slice(0, routeIndex) : parts;
  return {
    route,
    scope,
    basePath: baseParts.length > 0 ? `/${baseParts.join('/')}` : '',
    hasRoute,
  };
}

function routePath(basePath: string, route: AppRoute, scope: Scope = 'global'): string {
  const prefix = basePath === '' ? '' : basePath;
  if (route === 'mission-control') return `${prefix}/mission-control`;
  if (scope === 'global') return `${prefix}/configuration`;
  return `${prefix}/configuration/${encodeURIComponent(scope)}/`;
}

export function App() {
  const [routeState, setRouteState] = useState<RouteState>(readRouteState);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [empty, setEmpty] = useState(false);
  const [mode, setMode] = useState<Mode>(readModeFromStorage);
  const admin = useQuayAdminReadModel();
  const missionControl = useMissionControlTasks();
  const store = useChangeStore();
  const { route, scope } = routeState;
  const repos = empty ? [] : admin.repos;
  const workerPreamble = admin.global?.preambles.find((preamble) => preamble.kind === 'code') ?? null;
  const reviewerPreamble = admin.global?.preambles.find((preamble) => preamble.kind === 'review') ?? null;
  const drawerPreamble =
    overlay?.type === 'preamble-drawer'
      ? overlay.kind === 'worker'
        ? workerPreamble
        : reviewerPreamble
      : null;
  const selectedRepo = scope === 'global' ? null : repos.find((repo) => repo.id === scope) ?? null;

  const navigateTo = useCallback(
    (nextRoute: AppRoute, nextScope: Scope = 'global', opts: { replace?: boolean } = {}) => {
      const nextPath = routePath(routeState.basePath, nextRoute, nextRoute === 'configuration' ? nextScope : 'global');
      if (window.location.pathname !== nextPath) {
        if (opts.replace) {
          window.history.replaceState(null, '', nextPath);
        } else {
          window.history.pushState(null, '', nextPath);
        }
      }
      setRouteState(readRouteState());
    },
    [routeState.basePath],
  );

  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    window.localStorage.setItem('quay-mode', mode);
  }, [mode]);

  useEffect(() => {
    if (!routeState.hasRoute) {
      navigateTo('mission-control', 'global', { replace: true });
    }
  }, [navigateTo, routeState.hasRoute]);

  useEffect(() => {
    function onPopState() {
      setRouteState(readRouteState());
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (route === 'configuration' && scope !== 'global' && !admin.loading && !selectedRepo) {
      navigateTo('configuration', 'global', { replace: true });
    }
  }, [admin.loading, navigateTo, route, scope, selectedRepo]);

  // Cmd/Ctrl + Enter → preview diff (opens the save-preview modal)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (store.changes.length > 0) {
          e.preventDefault();
          setOverlay({ type: 'save-preview' });
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store.changes.length]);

  const handleAddRepo = useCallback(() => undefined, []);
  const handleArchive = useCallback(
    (repoId: string) => setOverlay({ type: 'archive-confirm', repoId }),
    [],
  );
  const handleOpenPreamble = useCallback(
    (kind: 'worker' | 'reviewer') => setOverlay({ type: 'preamble-drawer', kind }),
    [],
  );

  const closeOverlay = useCallback(() => setOverlay(null), []);

  const handleApplied = useCallback(() => {
    store.discardAll();
    setOverlay(null);
    admin.reload();
  }, [admin, store]);

  const handleReloadRequired = useCallback(() => {
    store.discardAll();
    setOverlay(null);
    admin.reload();
  }, [admin, store]);

  const onSaveDirect = useCallback(() => setOverlay({ type: 'save-preview' }), []);

  const isEmpty = !admin.loading && !admin.error && repos.length === 0;
  const scopeLabel = scope === 'global' ? 'Global' : scope;
  const crumbs = route === 'configuration' ? ['prod', 'configuration', scopeLabel] : ['prod', 'mission control'];
  const status =
    admin.loading
      ? { tone: 'warn' as const, label: 'connecting to Quay', pulse: true }
      : admin.error
        ? { tone: 'danger' as const, label: 'Quay API unavailable' }
        : {
            tone: 'good' as const,
            label: `quay ${admin.meta?.quay_version ?? 'API connected'}`,
          };

  const dirtySummary = (() => {
    if (store.changes.length === 0) return '';
    if (store.changes.length === 1) {
      const c = store.changes[0]!;
      return `${c.label} · ${c.before} → ${c.after}`;
    }
    const scopes = new Set(store.changes.map((c) => c.scope));
    return `${store.changes.length} changes across ${scopes.size} scope${scopes.size === 1 ? '' : 's'}`;
  })();

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--paper)' }}>
      <TopBar
        crumbs={crumbs}
        mode={mode}
        backendStatus={status}
        onModeToggle={() => setMode(mode === 'light' ? 'dark' : 'light')}
      />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <PrimarySidebar
          route={route}
          missionControlCount={missionControl.activeTaskCount}
          missionControlAttention={missionControl.hasAttention}
          onNavigate={(nextRoute) => navigateTo(nextRoute, 'global')}
        />
        {route === 'mission-control' ? (
          <MissionControlPage
            tasks={missionControl.tasks}
            loading={missionControl.loading}
            error={missionControl.error}
            lastRefreshAt={missionControl.lastRefreshAt}
            onRefresh={missionControl.refresh}
          />
        ) : (
          <>
            <LeftRail
              active={scope}
              repos={repos}
              empty={isEmpty}
              loading={admin.loading}
              error={admin.error}
              readOnly
              onSelect={(nextScope) => navigateTo('configuration', nextScope)}
              onAddRepo={handleAddRepo}
            />
            <main
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                background: 'var(--paper-2)',
                position: 'relative',
              }}
            >
              {admin.loading ? (
                <ApiLoadingScreen baseUrl={admin.baseUrl} />
              ) : admin.error ? (
                <ApiErrorScreen baseUrl={admin.baseUrl} error={admin.error} onRetry={admin.reload} />
              ) : isEmpty ? (
                <EmptyScreen quayVersion={admin.meta?.quay_version} readOnly onRegisterRepo={handleAddRepo} />
              ) : scope === 'global' && admin.global && admin.matrix ? (
                <GlobalScreen
                  global={admin.global}
                  matrix={admin.matrix}
                  repos={repos}
                  quayVersion={admin.meta?.quay_version}
                  changes={store.changes}
                  onChange={store.set}
                  onOpenPreamble={handleOpenPreamble}
                />
              ) : selectedRepo && admin.global ? (
                <RepoScreen
                  repo={selectedRepo}
                  global={admin.global}
                  changes={store.changes}
                  onChange={store.set}
                  onArchive={handleArchive}
                />
              ) : admin.global && admin.matrix ? (
                <GlobalScreen
                  global={admin.global}
                  matrix={admin.matrix}
                  repos={repos}
                  quayVersion={admin.meta?.quay_version}
                  changes={store.changes}
                  onChange={store.set}
                  onOpenPreamble={handleOpenPreamble}
                />
              ) : (
                <ApiErrorScreen
                  baseUrl={admin.baseUrl}
                  error="Quay Admin API returned an incomplete read model."
                  onRetry={admin.reload}
                />
              )}

              {store.changes.length > 0 && (
                <SaveFooter
                  count={store.changes.length}
                  summary={dirtySummary}
                  onDiscard={store.discardAll}
                  onPreview={() => setOverlay({ type: 'save-preview' })}
                  onSave={onSaveDirect}
                />
              )}
            </main>
          </>
        )}
      </div>

      {import.meta.env.DEV && route === 'configuration' && <DevToggle empty={empty} onToggle={() => setEmpty((e) => !e)} />}

      {overlay?.type === 'save-preview' && (
        <SavePreviewModal
          baseRevision={admin.revision ?? ''}
          changes={store.changes}
          onCancel={closeOverlay}
          onApplied={handleApplied}
          onReloadRequired={handleReloadRequired}
        />
      )}
      {overlay?.type === 'preamble-drawer' && drawerPreamble && (
        <PreambleDrawer
          kind={overlay.kind}
          preamble={drawerPreamble}
          onClose={closeOverlay}
        />
      )}
      {overlay?.type === 'archive-confirm' && (
        <ArchiveConfirmDialog
          repoId={overlay.repoId}
          activeTasks={repos.find((r) => r.id === overlay.repoId)?.active}
          onCancel={closeOverlay}
          onConfirm={closeOverlay}
        />
      )}
    </div>
  );
}

function DevToggle({ empty, onToggle }: { empty: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Dev: toggle empty (zero-repos) state"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 50,
        padding: '6px 10px',
        background: 'var(--surface)',
        border: '1px solid var(--line-2)',
        borderRadius: 'var(--r-sm)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--ink-3)',
        cursor: 'pointer',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {empty ? '◌ empty mode' : '○ dev: empty'}
    </button>
  );
}
