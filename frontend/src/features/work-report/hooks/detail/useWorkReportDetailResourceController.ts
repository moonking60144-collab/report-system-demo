import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  fetchEditingPresence,
  fetchFormOptions,
  fetchWorkReportEntryResult,
  updateEditingPresence,
  type FormOptionMap,
  type WorkReportReadMeta,
  type WorkReportRecord,
} from "../../../../api/workReport";
import { applyWorkReportOptimisticMutations } from "../../workReportOptimisticMutation";
import { shouldReplayEntryFieldOptimisticTask } from "../../entryFieldMutationSettlement";
import { WorkReportEntrySettlementRevisionBarrier } from "../../entrySettlementRevisionBarrier";
import type { CreateTaskMonitor, WorkReportFormId } from "../../types";
import { getErrorMessage, normalizeRecord } from "../../utils";
import type { DetailNoticeState } from "./useWorkReportDetailStatusController";
import type { LoadEntryOptions } from "./types";

const EMPTY_OPTIONS: FormOptionMap = {};
const EDITING_PRESENCE_SESSION_STORAGE_KEY = "work-report:editing-presence-session:v1";
const ROW_LOCK_DEBUG = import.meta.env.DEV;

function readOrCreateEditingPresenceSessionId(): string {
  if (typeof window === "undefined") {
    return "server";
  }

  try {
    const existing = String(
      window.sessionStorage.getItem(EDITING_PRESENCE_SESSION_STORAGE_KEY) ?? ""
    ).trim();
    if (existing) {
      return existing;
    }
    const nextId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(EDITING_PRESENCE_SESSION_STORAGE_KEY, nextId);
    return nextId;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

interface UseWorkReportDetailResourceControllerArgs {
  isValidRoute: boolean;
  formId: WorkReportFormId | null;
  safeEntryId: string;
  createTaskMonitors: CreateTaskMonitor[];
  setNotice: Dispatch<SetStateAction<DetailNoticeState | null>>;
  t: (key: string, options?: Record<string, unknown>) => string;
}

interface RowEditLockOwner {
  formId: WorkReportFormId;
  entryId: string;
  rowId: string;
}

interface AuthoritativeEntryRecord {
  formId: WorkReportFormId;
  entryId: string;
  record: WorkReportRecord;
}

function isSameEntryIdentity(
  owner: Pick<RowEditLockOwner, "formId" | "entryId">,
  formId: WorkReportFormId | null,
  entryId: string
): boolean {
  return owner.formId === formId && owner.entryId === entryId;
}

function isSameRowEditLockOwner(
  left: RowEditLockOwner | null,
  right: RowEditLockOwner
): boolean {
  return (
    left?.formId === right.formId &&
    left.entryId === right.entryId &&
    left.rowId === right.rowId
  );
}

export function useWorkReportDetailResourceController({
  isValidRoute,
  formId,
  safeEntryId,
  createTaskMonitors,
  setNotice,
  t,
}: UseWorkReportDetailResourceControllerArgs) {
  const [authoritativeEntryRecord, setAuthoritativeEntryRecord] =
    useState<AuthoritativeEntryRecord | null>(null);
  const [entryReadMeta, setEntryReadMeta] =
    useState<WorkReportReadMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOptionsByForm, setFormOptionsByForm] = useState<
    Partial<Record<WorkReportFormId, FormOptionMap>>
  >({});
  const [optionsLoadingByForm, setOptionsLoadingByForm] = useState<
    Partial<Record<WorkReportFormId, boolean>>
  >({});
  const optionsLoadPromiseRef = useRef<
    Partial<Record<WorkReportFormId, Promise<FormOptionMap>>>
  >({});
  const [entryEditingSummary, setEntryEditingSummary] = useState<
    Awaited<ReturnType<typeof fetchEditingPresence>> | null
  >(null);
  const [editLockOwner, setEditLockOwner] = useState<RowEditLockOwner | null>(null);
  const editLockOwnerRef = useRef<RowEditLockOwner | null>(null);
  const [editLockVersionState, setEditLockVersion] = useState<number | null>(null);
  const editingPresenceSessionIdRef = useRef(readOrCreateEditingPresenceSessionId());
  const currentEntryIdentityRef = useRef({ formId, entryId: safeEntryId });
  const foregroundLoadEntryRequestIdRef = useRef(0);
  const backgroundLoadEntryRequestIdRef = useRef(0);
  const foregroundLoadEntryInFlightRef = useRef(false);
  const entrySettlementBarrierRef = useRef(
    new WorkReportEntrySettlementRevisionBarrier<WorkReportRecord>()
  );

  currentEntryIdentityRef.current = { formId, entryId: safeEntryId };

  const authoritativeRecord =
    authoritativeEntryRecord?.formId === formId &&
    authoritativeEntryRecord.entryId === safeEntryId
      ? authoritativeEntryRecord.record
      : null;

  const record = useMemo(
    () =>
      applyWorkReportOptimisticMutations(
        authoritativeRecord,
        createTaskMonitors.filter(
          (task) =>
            task.formId === formId &&
            task.entryId === safeEntryId &&
            shouldReplayEntryFieldOptimisticTask(task, authoritativeRecord)
        )
      ),
    [authoritativeRecord, createTaskMonitors, formId, safeEntryId]
  );

  const mergeAuthoritativeRecord = useCallback(
    (incomingRecord: WorkReportRecord) => {
      if (
        !formId ||
        !safeEntryId ||
        String(incomingRecord.id) !== safeEntryId
      ) {
        return;
      }
      const normalizedRecord = normalizeRecord(incomingRecord, true);
      entrySettlementBarrierRef.current.record(formId, normalizedRecord);
      setAuthoritativeEntryRecord({
        formId,
        entryId: safeEntryId,
        record: normalizedRecord,
      });
    },
    [formId, safeEntryId]
  );

  const loadEntry = useCallback(
    async (options: LoadEntryOptions = {}) => {
      const {
        mode = "foreground",
        forceRefresh = false,
        notifyOnError,
        throwOnError = false,
      } = options;
      if (!formId || !safeEntryId) {
        return;
      }
      const isBackground = mode === "background";
      const requestId = isBackground
        ? ++backgroundLoadEntryRequestIdRef.current
        : ++foregroundLoadEntryRequestIdRef.current;
      const foregroundRequestIdAtStart = foregroundLoadEntryRequestIdRef.current;
      const entrySettlementRevision =
        entrySettlementBarrierRef.current.captureRevision();
      if (!isBackground) {
        foregroundLoadEntryInFlightRef.current = true;
      }
      const isStale = () =>
        isBackground
          ? backgroundLoadEntryRequestIdRef.current !== requestId ||
            foregroundLoadEntryRequestIdRef.current !== foregroundRequestIdAtStart ||
            foregroundLoadEntryInFlightRef.current
          : foregroundLoadEntryRequestIdRef.current !== requestId;
      if (mode === "foreground") {
        setLoading(true);
      } else if (mode === "refreshing") {
        setRefreshing(true);
      }
      if (!isBackground) {
        setLoadError(null);
      }
      try {
        const response = await fetchWorkReportEntryResult(
          formId,
          safeEntryId,
          forceRefresh
        );
        const nextRecord = entrySettlementBarrierRef.current.mergeRecord(
          formId,
          entrySettlementRevision,
          normalizeRecord(response.data, true)
        );
        if (isStale()) {
          return;
        }
        setLoadError(null);
        setAuthoritativeEntryRecord({
          formId,
          entryId: safeEntryId,
          record: nextRecord,
        });
        setEntryReadMeta(response.meta);
      } catch (error) {
        if (isStale()) {
          return;
        }
        const message = getErrorMessage(error);
        if (!isBackground) {
          setLoadError(message);
        }
        if (notifyOnError ?? !isBackground) {
          setNotice({ type: "error", message });
        }
        if (throwOnError) {
          throw error;
        }
      } finally {
        if (
          !isBackground &&
          foregroundLoadEntryRequestIdRef.current === requestId
        ) {
          foregroundLoadEntryInFlightRef.current = false;
          setRefreshing(false);
          setLoading(false);
        }
      }
    },
    [formId, safeEntryId, setNotice]
  );

  const formOptions = useMemo<FormOptionMap>(() => {
    if (!formId) {
      return EMPTY_OPTIONS;
    }
    return formOptionsByForm[formId] ?? EMPTY_OPTIONS;
  }, [formId, formOptionsByForm]);

  const optionsLoading = formId
    ? Boolean(optionsLoadingByForm[formId])
    : false;

  const ensureOptionsLoaded = useCallback(
    async (options: { silent?: boolean } = {}): Promise<FormOptionMap> => {
      if (!formId) {
        return EMPTY_OPTIONS;
      }

      const requestedFormId = formId;
      const cachedOptions = formOptionsByForm[requestedFormId];
      if (cachedOptions) {
        return cachedOptions;
      }

      const inflightPromise = optionsLoadPromiseRef.current[requestedFormId];
      if (inflightPromise) {
        return inflightPromise;
      }

      setOptionsLoadingByForm((previous) => ({
        ...previous,
        [requestedFormId]: true,
      }));
      const loadPromise = (async () => {
        try {
          const data = await fetchFormOptions(requestedFormId, [
            "machineId",
            "operatorId",
            "processCode",
          ]);
          setFormOptionsByForm((previous) => ({
            ...previous,
            [requestedFormId]: data,
          }));
          return data;
        } catch (error) {
          if (!options.silent) {
            setNotice({
              type: "error",
              message: t("workReport:messages.failedLoadFormOptions", {
                error: getErrorMessage(error),
              }),
            });
          }
          return EMPTY_OPTIONS;
        } finally {
          setOptionsLoadingByForm((previous) => ({
            ...previous,
            [requestedFormId]: false,
          }));
          delete optionsLoadPromiseRef.current[requestedFormId];
        }
      })();

      optionsLoadPromiseRef.current[requestedFormId] = loadPromise;
      return loadPromise;
    },
    [formId, formOptionsByForm, setNotice, t]
  );

  const currentEditSessionId = editingPresenceSessionIdRef.current;
  const clearActiveRowEditLock = useCallback(() => {
    editLockOwnerRef.current = null;
    setEditLockOwner(null);
    setEditLockVersion(null);
  }, []);

  const editLockVersion =
    editLockOwner && isSameEntryIdentity(editLockOwner, formId, safeEntryId)
      ? editLockVersionState
      : null;

  const acquireRowEditLock = useCallback(
    async (rowId: string): Promise<number | null> => {
      if (!formId || !safeEntryId) {
        return null;
      }
      const normalizedRowId = String(rowId ?? "").trim();
      if (!normalizedRowId) {
        return null;
      }
      const requestedOwner: RowEditLockOwner = {
        formId,
        entryId: safeEntryId,
        rowId: normalizedRowId,
      };
      try {
        const snapshot = await updateEditingPresence(
          requestedOwner.formId,
          requestedOwner.entryId,
          {
            sessionId: currentEditSessionId,
            rowId: requestedOwner.rowId,
            active: true,
            state: "editing",
          }
        );
        if (ROW_LOCK_DEBUG) {
          console.info("[row-lock-debug][frontend][acquire]", {
            formId: requestedOwner.formId,
            entryId: requestedOwner.entryId,
            rowId: requestedOwner.rowId,
            sessionId: currentEditSessionId,
            snapshot,
          });
        }
        const currentEntryIdentity = currentEntryIdentityRef.current;
        if (
          !isSameEntryIdentity(
            requestedOwner,
            currentEntryIdentity.formId,
            currentEntryIdentity.entryId
          )
        ) {
          if (snapshot.canEdit) {
            void updateEditingPresence(
              requestedOwner.formId,
              requestedOwner.entryId,
              {
                sessionId: currentEditSessionId,
                rowId: requestedOwner.rowId,
                active: false,
              }
            ).catch(() => undefined);
          }
          return null;
        }
        setEntryEditingSummary((previous) =>
          previous
            ? {
                ...previous,
                hasOtherEditors: false,
                otherEditorCount: 0,
                observedAt: snapshot.observedAt,
              }
            : previous
        );
        if (snapshot.canEdit) {
          editLockOwnerRef.current = requestedOwner;
          setEditLockOwner(requestedOwner);
          setEditLockVersion(snapshot.lockVersion ?? null);
          return snapshot.lockVersion ?? null;
        }
        setNotice({
          type: "error",
          message: t("workReport:detailPage.rowLockedByOtherEditor"),
        });
        return null;
      } catch (error) {
        setNotice({
          type: "error",
          message: getErrorMessage(error),
        });
        return null;
      }
    },
    [currentEditSessionId, formId, safeEntryId, setNotice, t]
  );

  const releaseRowEditLock = useCallback(
    async (rowId?: string | null): Promise<void> => {
      const activeOwner = editLockOwnerRef.current;
      const normalizedRowId = String(rowId ?? activeOwner?.rowId ?? "").trim();
      if (!normalizedRowId) {
        clearActiveRowEditLock();
        return;
      }
      const owner =
        activeOwner && (!rowId || activeOwner.rowId === normalizedRowId)
          ? activeOwner
          : formId && safeEntryId
            ? { formId, entryId: safeEntryId, rowId: normalizedRowId }
            : null;
      if (!owner) {
        return;
      }
      try {
        await updateEditingPresence(owner.formId, owner.entryId, {
          sessionId: currentEditSessionId,
          rowId: owner.rowId,
          active: false,
        });
        if (ROW_LOCK_DEBUG) {
          console.info("[row-lock-debug][frontend][release]", {
            formId: owner.formId,
            entryId: owner.entryId,
            rowId: owner.rowId,
            sessionId: currentEditSessionId,
          });
        }
        const currentEntryIdentity = currentEntryIdentityRef.current;
        if (
          isSameEntryIdentity(
            owner,
            currentEntryIdentity.formId,
            currentEntryIdentity.entryId
          )
        ) {
          setEntryEditingSummary((previous) =>
            previous
              ? {
                  ...previous,
                  hasOtherEditors: false,
                  otherEditorCount: 0,
                  observedAt: new Date().toISOString(),
                }
              : previous
          );
        }
      } catch (error) {
        console.warn("[row-edit-lock-release-failed]", {
          formId: owner.formId,
          entryId: owner.entryId,
          rowId: owner.rowId,
          error: getErrorMessage(error),
        });
      } finally {
        if (isSameRowEditLockOwner(editLockOwnerRef.current, owner)) {
          clearActiveRowEditLock();
        }
      }
    },
    [
      clearActiveRowEditLock,
      currentEditSessionId,
      formId,
      safeEntryId,
    ]
  );
  const releaseRowEditLockRef = useRef(releaseRowEditLock);
  releaseRowEditLockRef.current = releaseRowEditLock;

  useEffect(() => {
    if (!isValidRoute || !formId) {
      return;
    }
    void ensureOptionsLoaded({ silent: true });
  }, [ensureOptionsLoaded, formId, isValidRoute]);

  useEffect(() => {
    if (!isValidRoute) {
      setLoading(false);
      setLoadError(t("workReport:detailPage.invalidRoute"));
      return;
    }
    void loadEntry();
  }, [isValidRoute, loadEntry, t]);

  useEffect(() => {
    if (!isValidRoute || !formId || !safeEntryId) {
      return;
    }

    const requestedFormId = formId;
    const requestedEntryId = safeEntryId;

    const loadEditingSummary = async () => {
      try {
        const snapshot = await fetchEditingPresence(
          requestedFormId,
          requestedEntryId,
          currentEditSessionId
        );
        const currentEntryIdentity = currentEntryIdentityRef.current;
        if (
          currentEntryIdentity.formId !== requestedFormId ||
          currentEntryIdentity.entryId !== requestedEntryId
        ) {
          return;
        }
        setEntryEditingSummary(snapshot);
      } catch {
        return;
      }
    };

    void loadEditingSummary();
    const timer = window.setInterval(() => {
      void loadEditingSummary();
    }, 15_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [currentEditSessionId, formId, isValidRoute, safeEntryId]);

  useEffect(() => {
    setEntryEditingSummary(null);
    const activeOwner = editLockOwnerRef.current;
    if (
      activeOwner &&
      !isSameEntryIdentity(activeOwner, formId, safeEntryId)
    ) {
      clearActiveRowEditLock();
    }
  }, [clearActiveRowEditLock, formId, safeEntryId]);

  useEffect(() => {
    if (!editLockOwner) {
      return;
    }

    const owner = editLockOwner;
    let disposed = false;

    const syncPresence = async (active: boolean) => {
      try {
        const snapshot = await updateEditingPresence(owner.formId, owner.entryId, {
          sessionId: editingPresenceSessionIdRef.current,
          rowId: owner.rowId,
          active,
          state: "editing",
        });
        if (!active || disposed) {
          return;
        }
        const currentEntryIdentity = currentEntryIdentityRef.current;
        if (
          !isSameEntryIdentity(
            owner,
            currentEntryIdentity.formId,
            currentEntryIdentity.entryId
          ) ||
          !isSameRowEditLockOwner(editLockOwnerRef.current, owner)
        ) {
          return;
        }
        setEntryEditingSummary((previous) =>
          previous
            ? {
                ...previous,
                hasOtherEditors: false,
                otherEditorCount: 0,
                observedAt: snapshot.observedAt,
              }
            : previous
        );
        setEditLockVersion(
          snapshot.isCurrentSessionOwner ? snapshot.lockVersion ?? null : null
        );
        if (!snapshot.canEdit) {
          setNotice({
            type: "error",
            message: t("workReport:detailPage.rowLockedByOtherEditor"),
          });
          clearActiveRowEditLock();
        }
      } catch {
        return;
      }
    };

    void syncPresence(true);
    const timer = window.setInterval(() => {
      void syncPresence(true);
    }, 15_000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      void syncPresence(false);
    };
  }, [clearActiveRowEditLock, editLockOwner, setNotice, t]);

  useEffect(() => {
    return () => {
      void releaseRowEditLockRef.current();
    };
  }, []);

  return {
    entry: {
      record,
      authoritativeRecord,
      entryReadMeta,
      loading,
      refreshing,
      loadError,
      loadEntry,
      mergeAuthoritativeRecord,
    },
    options: {
      formOptions,
      optionsLoading,
      ensureOptionsLoaded,
    },
    editing: {
      entryEditingSummary,
      currentEditSessionId,
      editLockVersion,
      acquireRowEditLock,
      releaseRowEditLock,
      clearActiveRowEditLock,
    },
  };
}
