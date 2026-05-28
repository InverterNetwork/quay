import { useCallback, useEffect, useState } from 'react';
import { fetchMissionControlTasks } from '../api/quayAdmin';
import type { MissionControlTask } from './taskState';

interface MissionControlTaskStore {
  tasks: MissionControlTask[];
  activeTaskCount: number;
  hasAttention: boolean;
  loading: boolean;
  error: string | null;
  lastRefreshAt: Date | null;
  refresh: () => void;
}

export function useMissionControlTasks(): MissionControlTaskStore {
  const [requestId, setRequestId] = useState(0);
  const [tasks, setTasks] = useState<MissionControlTask[]>([]);
  const [activeTaskCount, setActiveTaskCount] = useState(0);
  const [hasAttention, setHasAttention] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    if (lastRefreshAt === null) setLoading(true);

    fetchMissionControlTasks(controller.signal)
      .then((readModel) => {
        setTasks(readModel.tasks);
        setActiveTaskCount(readModel.activeTaskCount);
        setHasAttention(readModel.hasAttention);
        setLastRefreshAt(new Date(readModel.refreshedAt));
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [requestId]);

  useEffect(() => {
    const timer = window.setInterval(() => setRequestId((id) => id + 1), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(() => setRequestId((id) => id + 1), []);

  return { tasks, activeTaskCount, hasAttention, loading, error, lastRefreshAt, refresh };
}

function errorMessage(err: unknown): string {
  if (err instanceof TypeError) return 'Cannot reach the Quay Admin API.';
  if (err instanceof Error) return err.message;
  return 'Mission Control task refresh failed.';
}
