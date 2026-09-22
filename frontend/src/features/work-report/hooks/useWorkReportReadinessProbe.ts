import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchWorkReportReadiness,
  isWorkReportReadyForReentry,
  type WorkReportReadinessSnapshot,
} from "../../../api/workReportReadiness";

const READINESS_RETRY_INTERVAL_MS = 5_000;

export interface WorkReportReadinessProbeState {
  snapshot: WorkReportReadinessSnapshot | null;
  checking: boolean;
  connectionError: boolean;
  lastCheckedAt: string | null;
  checkNow: () => Promise<WorkReportReadinessSnapshot | null>;
}

export function useWorkReportReadinessProbe(): WorkReportReadinessProbeState {
  const [snapshot, setSnapshot] = useState<WorkReportReadinessSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const activeRef = useRef(true);
  const inFlightRef = useRef(false);
  const readyForReentry = isWorkReportReadyForReentry(snapshot);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const checkNow = useCallback(async (): Promise<WorkReportReadinessSnapshot | null> => {
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    if (activeRef.current) setChecking(true);

    try {
      const next = await fetchWorkReportReadiness();
      if (activeRef.current) {
        setSnapshot(next);
        setConnectionError(false);
        setLastCheckedAt(next.checkedAt || new Date().toISOString());
      }
      return next;
    } catch {
      if (activeRef.current) {
        setSnapshot(null);
        setConnectionError(true);
        setLastCheckedAt(new Date().toISOString());
      }
      return null;
    } finally {
      inFlightRef.current = false;
      if (activeRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (readyForReentry) return;
    void checkNow();
    const timer = window.setInterval(() => {
      void checkNow();
    }, READINESS_RETRY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkNow, readyForReentry]);

  return { snapshot, checking, connectionError, lastCheckedAt, checkNow };
}
