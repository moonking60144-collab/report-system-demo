import {
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  EditOutlined,
  KeyOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  authorizeMeetingRecordingLibrary,
  confirmOwnerMeetingLibraryCode,
  createOwnerMeetingLibrary,
  fetchOwnerMeetingLibrary,
  logoutMeetingLibrary,
  renameOwnerMeetingLibrary,
  resolveMeetingRecordingApiError,
  resolveMeetingRecordingApiErrorCode,
  rotateOwnerMeetingLibraryCode,
  type MeetingLibraryCodeResult,
  type MeetingLibraryOwnerState,
} from "../api/meetingRecordingApi";

interface MeetingLibraryOwnerAccessProps {
  initialAccess: MeetingLibraryCodeResult;
  onAccessChange: (access: MeetingLibraryCodeResult) => void;
  onCodeConsumed: () => void;
  onReadyChange: (ready: boolean) => void;
  disabled?: boolean;
}

export function MeetingLibraryOwnerAccess({
  initialAccess,
  onAccessChange,
  onCodeConsumed,
  onReadyChange,
  disabled = false,
}: MeetingLibraryOwnerAccessProps) {
  const { t } = useTranslation("meetingMinutes");
  const [ownerState, setOwnerState] = useState<MeetingLibraryOwnerState | null>(
    initialAccess.library
      ? {
          enabled: initialAccess.enabled,
          library: initialAccess.library,
          ownedLibrary:
            initialAccess.ownedLibrary ??
            ((initialAccess.accessMode ?? "owner") === "owner"
              ? initialAccess.library
              : null),
          accessMode: initialAccess.accessMode ?? "owner",
        }
      : null
  );
  const displayCode = initialAccess.code;
  const [codeInput, setCodeInput] = useState("");
  const [libraryNameInput, setLibraryNameInput] = useState("");
  const [renameInput, setRenameInput] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [repairingCode, setRepairingCode] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [currentCodeInput, setCurrentCodeInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const authorizeInFlightRef = useRef(false);
  const createInFlightRef = useRef(false);
  const renameInFlightRef = useRef(false);
  const rotateInFlightRef = useRef(false);
  const repairCodeInFlightRef = useRef(false);
  const leaveInFlightRef = useRef(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const hadInitialLibraryRef = useRef(Boolean(initialAccess.library));
  const skipNextLoadRef = useRef(false);
  const sharingDisabled = ownerState?.enabled === false;
  const accessMode = ownerState?.accessMode ?? "owner";
  const currentLibrary = ownerState?.library ?? null;
  const ownedLibrary =
    ownerState?.ownedLibrary ??
    (accessMode === "owner" ? currentLibrary : null);
  const setupIncomplete = currentLibrary?.setupState === "incomplete";
  const ready = Boolean(
    ownerState && !switching && (sharingDisabled || currentLibrary?.setupState === "ready")
  );
  const busy =
    disabled || authorizing || creating || renaming || rotating || repairingCode || switching;
  const displayName =
    currentLibrary?.displayName?.trim() || t("library.owner.unnamed");
  const codeHint = currentLibrary?.codeHint || t("library.owner.codeHintUnavailable");

  useEffect(() => {
    onReadyChange(ready);
  }, [onReadyChange, ready]);

  useEffect(() => {
    if (loading || ready) return;
    const frame = window.requestAnimationFrame(() => codeInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [loading, ready]);

  useEffect(() => {
    if (initialAccess.library) {
      hadInitialLibraryRef.current = true;
      setOwnerState((current) => ({
        enabled: initialAccess.enabled,
        library: initialAccess.library,
        ownedLibrary:
          initialAccess.ownedLibrary ??
          current?.ownedLibrary ??
          ((initialAccess.accessMode ?? current?.accessMode ?? "owner") === "owner"
            ? initialAccess.library
            : null),
        accessMode: initialAccess.accessMode ?? current?.accessMode ?? "owner",
      }));
      return;
    }
    if (hadInitialLibraryRef.current) {
      hadInitialLibraryRef.current = false;
      skipNextLoadRef.current = true;
      setOwnerState((current) => ({
        enabled: true,
        library: null,
        ownedLibrary: current?.ownedLibrary ?? null,
        accessMode: "selection",
      }));
      setLoading(false);
      setEditingName(false);
      window.requestAnimationFrame(() => codeInputRef.current?.focus());
    }
  }, [
    initialAccess.accessMode,
    initialAccess.enabled,
    initialAccess.library,
    initialAccess.ownedLibrary,
  ]);

  useEffect(() => {
    if (initialAccess.library) {
      setLoading(false);
      return;
    }
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchOwnerMeetingLibrary()
      .then((result) => {
        if (!cancelled) {
          setOwnerState(result);
          onAccessChange({ ...result, code: null });
          setErrorMessage(null);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const code = resolveMeetingRecordingApiErrorCode(error);
        if (code === "MEETING_RECORDING_OWNER_REQUIRED") {
          setOwnerState({ enabled: true, library: null, accessMode: "owner" });
          return;
        }
        setErrorMessage(
          resolveMeetingRecordingApiError(error) ?? t("library.owner.loadFailed")
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialAccess.library, onAccessChange, t]);

  const useExistingLibrary = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (authorizeInFlightRef.current || busy || !codeInput.trim()) return;
    authorizeInFlightRef.current = true;
    setAuthorizing(true);
    setErrorMessage(null);
    try {
      const result = await authorizeMeetingRecordingLibrary(codeInput);
      setOwnerState({
        enabled: result.enabled,
        library: result.library,
        ownedLibrary: result.ownedLibrary ?? null,
        accessMode: result.accessMode ?? "recorder",
      });
      onAccessChange(result);
      setCodeInput("");
    } catch (error) {
      setErrorMessage(
        resolveMeetingRecordingApiError(error) ?? t("library.owner.authorizeFailed")
      );
    } finally {
      authorizeInFlightRef.current = false;
      setAuthorizing(false);
    }
  };

  const createLibrary = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      createInFlightRef.current ||
      busy ||
      !libraryNameInput.trim()
    ) {
      return;
    }
    createInFlightRef.current = true;
    setCreating(true);
    setErrorMessage(null);
    try {
      const result = await createOwnerMeetingLibrary(libraryNameInput);
      if (!result.enabled) {
        const privateFallback = { ...result, accessMode: "owner" as const };
        setOwnerState(privateFallback);
        onAccessChange(privateFallback);
        return;
      }
      if (!result.library) {
        setErrorMessage(t("library.owner.unavailable"));
        return;
      }
      setOwnerState({
        enabled: result.enabled,
        library: result.library,
        ownedLibrary: result.ownedLibrary ?? result.library,
        accessMode: "owner",
      });
      onAccessChange(result);
      setLibraryNameInput("");
    } catch (error) {
      setErrorMessage(
        resolveMeetingRecordingApiError(error) ?? t("library.owner.createFailed")
      );
    } finally {
      createInFlightRef.current = false;
      setCreating(false);
    }
  };

  const startRename = () => {
    setRenameInput(displayName);
    setEditingName(true);
    setErrorMessage(null);
    window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  };

  const renameLibrary = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      renameInFlightRef.current ||
      busy ||
      accessMode !== "owner" ||
      !renameInput.trim()
    ) {
      return;
    }
    renameInFlightRef.current = true;
    setRenaming(true);
    setErrorMessage(null);
    try {
      const result = await renameOwnerMeetingLibrary(renameInput);
      const nextAccess = {
        ...result,
        code:
          result.code ??
          (displayCode &&
          result.library?.libraryId === initialAccess.library?.libraryId &&
          result.library?.accessVersion === initialAccess.library?.accessVersion
            ? displayCode
            : null),
      };
      setOwnerState({
        enabled: nextAccess.enabled,
        library: nextAccess.library,
        ownedLibrary: nextAccess.ownedLibrary ?? nextAccess.library,
        accessMode: "owner",
      });
      onAccessChange(nextAccess);
      setEditingName(false);
    } catch (error) {
      setErrorMessage(
        resolveMeetingRecordingApiError(error) ?? t("library.owner.renameFailed")
      );
    } finally {
      renameInFlightRef.current = false;
      setRenaming(false);
    }
  };

  const rotateCode = async () => {
    if (rotateInFlightRef.current || busy || accessMode !== "owner") return;
    rotateInFlightRef.current = true;
    setRotating(true);
    setErrorMessage(null);
    setCopied(false);
    try {
      const result = await rotateOwnerMeetingLibraryCode();
      setOwnerState({
        enabled: result.enabled,
        library: result.library,
        ownedLibrary: result.ownedLibrary ?? result.library,
        accessMode: "owner",
      });
      onAccessChange(result);
      setConfirming(false);
    } catch (error) {
      setErrorMessage(
        resolveMeetingRecordingApiError(error) ?? t("library.owner.rotateFailed")
      );
    } finally {
      rotateInFlightRef.current = false;
      setRotating(false);
    }
  };

  const confirmCurrentCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      repairCodeInFlightRef.current ||
      busy ||
      accessMode !== "owner" ||
      !currentCodeInput.trim()
    ) {
      return;
    }
    repairCodeInFlightRef.current = true;
    setRepairingCode(true);
    setErrorMessage(null);
    try {
      const result = await confirmOwnerMeetingLibraryCode(currentCodeInput);
      setOwnerState({
        enabled: result.enabled,
        library: result.library,
        ownedLibrary: result.ownedLibrary ?? result.library,
        accessMode: "owner",
      });
      onAccessChange({ ...result, code: displayCode });
      setCurrentCodeInput("");
    } catch (error) {
      setErrorMessage(
        resolveMeetingRecordingApiError(error) ?? t("library.owner.confirmCodeFailed")
      );
    } finally {
      repairCodeInFlightRef.current = false;
      setRepairingCode(false);
    }
  };

  const leaveLibrary = async () => {
    if (leaveInFlightRef.current || busy || sharingDisabled) return;
    leaveInFlightRef.current = true;
    setSwitching(true);
    onReadyChange(false);
    setErrorMessage(null);
    try {
      await logoutMeetingLibrary();
      setOwnerState((current) => ({
        enabled: true,
        library: null,
        ownedLibrary: current?.ownedLibrary ?? null,
        accessMode: "selection",
      }));
      onAccessChange({
        enabled: true,
        library: null,
        ownedLibrary,
        code: null,
        accessMode: "selection",
      });
      setEditingName(false);
      window.requestAnimationFrame(() => codeInputRef.current?.focus());
    } catch (error) {
      setErrorMessage(
        resolveMeetingRecordingApiError(error) ?? t("library.owner.leaveFailed")
      );
    } finally {
      leaveInFlightRef.current = false;
      setSwitching(false);
    }
  };

  const returnToOwnedLibrary = () => {
    if (!ownedLibrary || busy) return;
    const nextAccess: MeetingLibraryCodeResult = {
      enabled: true,
      library: ownedLibrary,
      ownedLibrary,
      code: null,
      accessMode: "owner",
    };
    setOwnerState(nextAccess);
    onAccessChange(nextAccess);
    setErrorMessage(null);
  };

  const copyCode = async () => {
    if (!displayCode) return;
    try {
      await navigator.clipboard.writeText(displayCode);
      setCopied(true);
      setErrorMessage(null);
    } catch {
      setCopied(false);
      setErrorMessage(t("library.owner.copyFailed"));
    }
  };

  return (
    <section
      className={`meeting-library-owner ${ready ? "is-ready" : "is-required"} ${
        sharingDisabled ? "is-disabled-fallback" : ""
      } ${switching ? "is-switching" : ""}`}
      aria-labelledby="meeting-library-owner-title"
    >
      <div className="meeting-library-owner__heading">
        <div>
          <p className="meeting-audio-eyebrow">RECORDING LIBRARY</p>
          <h3 id="meeting-library-owner-title">
            {switching
              ? t("library.owner.switchingTitle")
              : ready
                ? t("library.owner.readyTitle")
                : setupIncomplete
                  ? t("library.owner.setupTitle")
                  : t("library.owner.requiredTitle")}
          </h3>
          <p>
            {switching
              ? t("library.owner.switchingDescription")
              : sharingDisabled
              ? t("library.owner.disabledDescription")
              : ready
                ? accessMode === "recorder"
                  ? t("library.owner.recorderDescription")
                  : t("library.owner.ownerDescription")
                : setupIncomplete
                  ? accessMode === "owner"
                    ? t("library.owner.setupOwnerDescription")
                    : t("library.owner.setupRecorderDescription")
                  : t("library.owner.requiredDescription")}
          </p>
        </div>
        {ready ? (
          <span className="meeting-library-owner__status">
            <CheckOutlined aria-hidden="true" />
            {sharingDisabled
              ? t("library.owner.disabledReady")
              : accessMode === "recorder"
                ? t("library.owner.existingReady")
                : t("library.owner.ownerReady")}
          </span>
        ) : null}
      </div>

      {loading && !ownerState ? (
        <div className="meeting-library-owner__loading" role="status">
          <LoadingOutlined spin aria-hidden="true" />
          {t("library.owner.checking")}
        </div>
      ) : !ready && !currentLibrary ? (
        <div className="meeting-library-selector">
          <form className="meeting-library-selector__existing" onSubmit={useExistingLibrary}>
            <label htmlFor="meeting-recording-library-code">
              {t("library.owner.existingCodeLabel")}
            </label>
            <div>
              <input
                id="meeting-recording-library-code"
                ref={codeInputRef}
                type="password"
                value={codeInput}
                onChange={(event) => setCodeInput(event.target.value)}
                placeholder={t("library.owner.existingCodePlaceholder")}
                autoComplete="current-password"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                maxLength={10}
                disabled={busy}
              />
              <button
                type="submit"
                disabled={busy || !codeInput.trim()}
              >
                {authorizing ? (
                  <LoadingOutlined spin aria-hidden="true" />
                ) : (
                  <KeyOutlined aria-hidden="true" />
                )}
                {authorizing
                  ? t("library.owner.authorizing")
                  : t("library.owner.useExisting")}
              </button>
            </div>
            <small>{t("library.owner.existingCodeHint")}</small>
          </form>

          <div className="meeting-library-selector__divider" aria-hidden="true">
            <span>{t("library.owner.or")}</span>
          </div>

          {ownedLibrary ? (
            <div className="meeting-library-selector__return">
              <strong>{t("library.owner.returnTitle")}</strong>
              <p>
                {t("library.owner.returnDescription", {
                  name:
                    ownedLibrary.displayName?.trim() || t("library.owner.unnamed"),
                })}
              </p>
              <button type="button" onClick={returnToOwnedLibrary} disabled={busy}>
                <CheckOutlined aria-hidden="true" />
                {t("library.owner.returnToOwned")}
              </button>
            </div>
          ) : (
            <form className="meeting-library-selector__create" onSubmit={createLibrary}>
            <strong>{t("library.owner.createTitle")}</strong>
            <label htmlFor="meeting-recording-library-name">
              {t("library.owner.createNameLabel")}
            </label>
            <input
              id="meeting-recording-library-name"
              type="text"
              value={libraryNameInput}
              onChange={(event) => setLibraryNameInput(event.target.value)}
              placeholder={t("library.owner.createNamePlaceholder")}
              autoComplete="off"
              maxLength={60}
              disabled={busy}
            />
            <small>{t("library.owner.createNameHint")}</small>
            <p>{t("library.owner.createDescription")}</p>
            <button
              type="submit"
              disabled={
                busy || !libraryNameInput.trim()
              }
            >
              {creating ? (
                <LoadingOutlined spin aria-hidden="true" />
              ) : (
                <PlusOutlined aria-hidden="true" />
              )}
              {creating ? t("library.owner.creating") : t("library.owner.create")}
            </button>
            </form>
          )}
        </div>
      ) : null}

      {currentLibrary && !sharingDisabled ? (
        <div className="meeting-library-identity" aria-live="polite">
          <div className="meeting-library-identity__name">
            <span>{t("library.owner.currentLibrary")}</span>
            {editingName ? (
              <form onSubmit={renameLibrary}>
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameInput}
                  onChange={(event) => setRenameInput(event.target.value)}
                  aria-label={t("library.owner.renameLabel")}
                  maxLength={60}
                  disabled={busy}
                />
                <button
                  type="submit"
                  disabled={busy || !renameInput.trim()}
                >
                  {renaming ? <LoadingOutlined spin aria-hidden="true" /> : null}
                  {renaming ? t("library.owner.renaming") : t("library.owner.saveName")}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingName(false)}
                  disabled={busy}
                >
                  {t("library.owner.cancel")}
                </button>
              </form>
            ) : (
              <div>
                <strong>{displayName}</strong>
                {accessMode === "owner" ? (
                  <button type="button" onClick={startRename} disabled={busy}>
                    <EditOutlined aria-hidden="true" />
                    {t("library.owner.rename")}
                  </button>
                ) : null}
              </div>
            )}
          </div>
          <div className="meeting-library-identity__code">
            <span>{t("library.owner.codeHintLabel")}</span>
            <code>{codeHint}</code>
          </div>
        </div>
      ) : null}

      {setupIncomplete && currentLibrary && !sharingDisabled ? (
        <div className="meeting-library-setup" role="status">
          <div>
            <strong>{t("library.owner.setupChecklistTitle")}</strong>
            <ul>
              {currentLibrary.missingFields.includes("displayName") ? (
                <li>{t("library.owner.setupNameMissing")}</li>
              ) : null}
              {currentLibrary.missingFields.includes("codeHint") ? (
                <li>{t("library.owner.setupCodeMissing")}</li>
              ) : null}
            </ul>
          </div>
          {accessMode === "owner" ? (
            <div className="meeting-library-setup__actions">
              {currentLibrary.missingFields.includes("displayName") && !editingName ? (
                <button type="button" onClick={startRename} disabled={busy}>
                  <EditOutlined aria-hidden="true" />
                  {t("library.owner.completeName")}
                </button>
              ) : null}
              {currentLibrary.missingFields.includes("codeHint") ? (
                <form onSubmit={confirmCurrentCode}>
                  <input
                    type="password"
                    value={currentCodeInput}
                    onChange={(event) => setCurrentCodeInput(event.target.value)}
                    aria-label={t("library.owner.confirmCodeLabel")}
                    placeholder={t("library.owner.confirmCodePlaceholder")}
                    autoComplete="current-password"
                    maxLength={10}
                    disabled={busy}
                  />
                  <button type="submit" disabled={busy || !currentCodeInput.trim()}>
                    {repairingCode ? <LoadingOutlined spin aria-hidden="true" /> : <KeyOutlined aria-hidden="true" />}
                    {t("library.owner.confirmCode")}
                  </button>
                  <button type="button" onClick={() => setConfirming(true)} disabled={busy}>
                    <ReloadOutlined aria-hidden="true" />
                    {t("library.owner.resetUnknownCode")}
                  </button>
                </form>
              ) : null}
              {confirming ? (
                <div className="meeting-library-owner__confirm" role="alert">
                  <span>{t("library.owner.rotateWarning")}</span>
                  <button type="button" onClick={() => void rotateCode()} disabled={busy}>
                    {rotating ? <LoadingOutlined spin aria-hidden="true" /> : <ReloadOutlined aria-hidden="true" />}
                    {t("library.owner.confirmRotate")}
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
                    {t("library.owner.cancel")}
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <button type="button" className="meeting-library-owner__rotate" onClick={() => void leaveLibrary()} disabled={busy}>
              <CloseOutlined aria-hidden="true" />
              {t("library.owner.switchLibrary")}
            </button>
          )}
        </div>
      ) : null}

      {displayCode ? (
        <div className="meeting-library-code-reveal" role="status">
          <div>
            <span>{t("library.owner.newCodeLabel")}</span>
            <strong>{displayCode}</strong>
            <small>{t("library.owner.oneTimeNotice")}</small>
          </div>
          <div className="meeting-library-code-reveal__actions">
            <button type="button" onClick={() => void copyCode()}>
              {copied ? (
                <CheckOutlined aria-hidden="true" />
              ) : (
                <CopyOutlined aria-hidden="true" />
              )}
              {copied ? t("library.owner.copied") : t("library.owner.copy")}
            </button>
            <button type="button" onClick={onCodeConsumed}>
              <CloseOutlined aria-hidden="true" />
              {t("library.owner.savedCode")}
            </button>
          </div>
        </div>
      ) : null}

      {ready && !sharingDisabled ? (
        <div className="meeting-library-owner__controls">
          <p>
            {accessMode === "owner"
              ? t("library.owner.codeHidden")
              : t("library.owner.recorderSelected")}
          </p>
          {accessMode === "owner" && !displayCode && confirming ? (
            <div className="meeting-library-owner__confirm" role="alert">
              <span>{t("library.owner.rotateWarning")}</span>
              <button
                type="button"
                onClick={() => void rotateCode()}
                disabled={busy}
              >
                {rotating ? (
                  <LoadingOutlined spin aria-hidden="true" />
                ) : (
                  <ReloadOutlined aria-hidden="true" />
                )}
                {t("library.owner.confirmRotate")}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                {t("library.owner.cancel")}
              </button>
            </div>
          ) : accessMode === "owner" && !displayCode ? (
            <button
              type="button"
              className="meeting-library-owner__rotate"
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              <KeyOutlined aria-hidden="true" />
              {t("library.owner.rotate")}
            </button>
          ) : null}
          <button
            type="button"
            className="meeting-library-owner__rotate"
            onClick={() => void leaveLibrary()}
            disabled={busy}
          >
            <CloseOutlined aria-hidden="true" />
            {t("library.owner.switchLibrary")}
          </button>
        </div>
      ) : null}

      {errorMessage ? (
        <p className="meeting-library-owner__error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}
