import { useCallback, useEffect, useState } from 'react';
import { useQuayAdminReadModel } from './api/quayAdmin';
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

export function App() {
  const [scope, setScope] = useState<Scope>('global');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [empty, setEmpty] = useState(false);
  const [mode, setMode] = useState<Mode>(readModeFromStorage);
  const admin = useQuayAdminReadModel();
  const store = useChangeStore();
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

  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    window.localStorage.setItem('quay-mode', mode);
  }, [mode]);

  useEffect(() => {
    if (scope !== 'global' && !admin.loading && !selectedRepo) {
      setScope('global');
    }
  }, [admin.loading, scope, selectedRepo]);

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
        scope={scopeLabel}
        mode={mode}
        backendStatus={status}
        onModeToggle={() => setMode(mode === 'light' ? 'dark' : 'light')}
      />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <LeftRail
          active={scope}
          repos={repos}
          empty={isEmpty}
          loading={admin.loading}
          error={admin.error}
          readOnly
          onSelect={setScope}
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
      </div>

      {import.meta.env.DEV && <DevToggle empty={empty} onToggle={() => setEmpty((e) => !e)} />}

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
