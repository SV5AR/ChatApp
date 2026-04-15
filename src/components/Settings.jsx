import React, { useState } from "react";
import { useTheme } from "../context/ThemeContext";
import {
  CopyIcon,
  LogOutIcon,
  CloseIcon,
  PaletteIcon,
  LockIcon,
  CheckIcon,
  BlockIcon,
} from "./Icons";
import { encryptWithKey, deriveAESKeyFromMasterKey } from "../utils/crypto";
import { edgePost } from "../lib/edgeApi";
import { getProfile, fanoutUsernameShares } from "../lib/schemaApi";
import {
  isRememberMeEnabled,
  disableRememberMe,
  hasRememberedMasterKey,
} from "../lib/edgeApi";
import { clearRememberedMasterKey, clearSigningKeys, persistMasterKey } from "../lib/edgeApi";
import { clearSessionOnly, clearSecureStorage, clearUserCache } from "../utils/secureStorage";
import {
  listPinVaultEntries,
  savePinVault,
  savePinVaultForUser,
  loadPinVaultForUser,
  markMasterKeyEncryptedForUser,
  clearPinVaultForUser,
} from "../utils/secureStorage";
import {
  isAppLockEnabled,
  setAppLockEnabled,
  setAppLockState,
  getAppLockTimeoutSec,
  setAppLockTimeoutSec,
  APP_LOCK_OPTIONS,
} from "../utils/appLock";
import {
  encryptMasterKeyWithPin,
  decryptMasterKeyWithPin,
  getPinStrengthError,
} from "../utils/pinVault";
import {
  isBiometricEnabled,
  registerBiometricCredential,
  clearBiometricCredential,
  verifyBiometricUnlock,
  getBiometricReadinessIssue,
} from "../utils/biometricGuard";

const Settings = ({
  onClose,
  userProfile,
  onUserProfileUpdate,
  currentPrivateKey,
  onThemeClick,
  embedded = false,
  hideTitle = false,
  onBlockedListClick,
}) => {
  const { theme, layoutName } = useTheme();
  const [username, setUsername] = useState(userProfile?.username || "");
  const [usernameLoading, setUsernameLoading] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState("");
  const [idCopyMsg, setIdCopyMsg] = useState(false);
  const [rememberEnabled, setRememberEnabled] = useState(isRememberMeEnabled());
  const [hasPinVault, setHasPinVault] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinCurrent, setPinCurrent] = useState("");
  const [pinLoading, setPinLoading] = useState(false);
  const [disablePinInput, setDisablePinInput] = useState("");
  const [disablePinLoading, setDisablePinLoading] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(isBiometricEnabled());
  const [bioLoading, setBioLoading] = useState(false);
  const [appLockEnabled, setAppLockEnabledState] = useState(isAppLockEnabled());
  const [appLockSeconds, setAppLockSeconds] = useState(getAppLockTimeoutSec());
  const [appLockDropdownOpen, setAppLockDropdownOpen] = useState(false);
  const lockDropdownButtonRef = React.useRef(null);
  const [lockDropdownWidth, setLockDropdownWidth] = useState(null);
  const [statusTip, setStatusTip] = useState("");
  const [deleteStep, setDeleteStep] = useState(0);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteHintRef = React.useRef(null);
  const [msg, setMsg] = useState({ text: "", type: "info" });
  const msgTimeoutRef = React.useRef(null);

  const showMsg = (text, type = "info") => {
    if (msgTimeoutRef.current) clearTimeout(msgTimeoutRef.current);
    setMsg({ text, type });
    msgTimeoutRef.current = setTimeout(() => {
      setMsg({ text: "", type: "info" });
    }, 3500);
  };

  React.useEffect(() => {
    let alive = true;
    (async () => {
      const uid = String(userProfile?.id || sessionStorage.getItem("userId") || "")
        .trim()
        .toLowerCase();
      const entries = await listPinVaultEntries().catch(() => []);
      const hasAny = Array.isArray(entries) && entries.length > 0;
      const hasForUser = uid ? entries.some((entry) => entry.userId === uid) : false;
      if (!alive) return;
      setHasPinVault(hasForUser || hasAny);
      setBiometricEnabled(isBiometricEnabled());
      setRememberEnabled(isRememberMeEnabled());
      if (!(hasForUser || hasAny)) {
        setAppLockEnabled(false);
        setAppLockEnabledState(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userProfile?.id]);

  const handleUpdateUsername = async () => {
    const u = username.trim();
    if (!u || u.length < 3) {
      setUsernameStatus("Must be at least 3 characters.");
      setTimeout(() => setUsernameStatus(""), 2500);
      return;
    }

    const uid = sessionStorage.getItem("userId");
    if (!uid || !currentPrivateKey) return;
    setUsernameLoading(true);
    try {
      // Encrypt username with own private key before storing
      const aesKey = await deriveAESKeyFromMasterKey(currentPrivateKey);
      const encryptedUsername = await encryptWithKey(u, aesKey);

      const profile = (await getProfile(uid)) || {};
      const publicKey =
        String(profile?.public_key || userProfile?.public_key || sessionStorage.getItem("userPublicKey") || "").trim();
      if (!publicKey) throw new Error("Missing public key for profile update");

      await edgePost("/profile/upsert", {
        id: uid,
        publicKey,
        encryptedUsername,
      });

      await fanoutUsernameShares(u).catch((err) => {
        console.warn("Username share fanout failed:", err);
      });

      onUserProfileUpdate?.({
        ...userProfile,
        public_key: publicKey,
        encrypted_username: encryptedUsername,
        username: u,
      });
      setUsernameStatus("✓ Updated");
      setTimeout(() => setUsernameStatus(""), 2500);
    } catch (e) {
      setUsernameStatus("Error: " + e.message);
    } finally {
      setUsernameLoading(false);
    }
  };

  const handleCopyId = async () => {
    await navigator.clipboard.writeText(userProfile?.id || "");
    setIdCopyMsg(true);
    setTimeout(() => setIdCopyMsg(false), 2000);
  };

  const showStatusTip = (msg) => {
    setStatusTip(msg);
    if (!msg) return;
    setTimeout(() => setStatusTip(""), 1800);
  };

  const getLoginModeLabel = () => {
    if (hasRememberedMasterKey()) return "Session Secured";
    if (rememberEnabled) return "Session kept";
    return "session only";
  };

  const handleRememberToggle = () => {
    if (rememberEnabled) {
      disableRememberMe();
      clearRememberedMasterKey();
      setRememberEnabled(false);
      
      return;
    }
    // Persist the current master key to localStorage
    const privateKey = String(sessionStorage.getItem("userPrivateKey") || "").trim();
    if (!privateKey || !/^[0-9a-f]{64}$/i.test(privateKey)) {
      showStatusTip("Cannot enable — no session key available");
      return;
    }
    persistMasterKey(privateKey, "");
    setRememberEnabled(true);
    
  };

  const handleSetOrChangePin = async () => {
    const uid = String(userProfile?.id || sessionStorage.getItem("userId") || "")
      .trim()
      .toLowerCase();
    const privateKey = String(sessionStorage.getItem("userPrivateKey") || "").trim();

    if (!uid || !privateKey) {
      showMsg("Missing local session key. Please sign in again.", "error");
      return;
    }

    const existingVault = await loadPinVaultForUser(uid).catch(() => null);
    const isChangingPin = !!existingVault;

    if (isChangingPin) {
      if (!pinCurrent) {
        showMsg("Enter current PIN to change.", "error");
        return;
      }
      try {
        await decryptMasterKeyWithPin(existingVault, pinCurrent);
      } catch {
        showMsg("Current PIN is incorrect.", "error");
        return;
      }
    }

    if (pinInput === pinCurrent) {
      showMsg("New PIN cannot be the same as current PIN.", "error");
      return;
    }

    const strengthError = getPinStrengthError(pinInput);
    if (strengthError) {
      showMsg(strengthError, "error");
      return;
    }
    if (pinInput !== pinConfirm) {
      showMsg("PIN confirmation does not match.", "error");
      return;
    }

    setPinLoading(true);
    try {
      if (existingVault && biometricEnabled) {
        await verifyBiometricUnlock();
      }

      const vault = await encryptMasterKeyWithPin(privateKey, pinInput);
      await savePinVault(vault);
      await savePinVaultForUser(uid, vault, userProfile?.username || null);
      await markMasterKeyEncryptedForUser(uid);
      setHasPinVault(true);
      setPinInput("");
      setPinConfirm("");
      setPinCurrent("");
      showMsg(existingVault ? "PIN changed successfully." : "PIN set successfully.", "success");
      
    } catch (error) {
      showMsg(error?.message || "Failed to save PIN.", "error");
    } finally {
      setPinLoading(false);
    }
  };

  const handleToggleBiometric = async () => {
    if (!hasPinVault) return;

    setBioLoading(true);
    try {
      if (biometricEnabled) {
        await verifyBiometricUnlock();
        clearBiometricCredential();
        setBiometricEnabled(false);
        showMsg("Biometric unlock disabled.", "success");
      } else {
        const issue = getBiometricReadinessIssue();
        if (issue) throw new Error(issue);
        await registerBiometricCredential();
        setBiometricEnabled(true);
        showMsg("Biometric unlock enabled.", "success");
      }
    } catch (error) {
      showMsg(error?.message || "Biometric action failed.", "error");
    } finally {
      setBioLoading(false);
    }
  };

  const handleToggleAppLock = () => {
    if (!hasPinVault) {
      showMsg("Set PIN first to enable auto lock.", "error");
      return;
    }
    const next = !appLockEnabled;
    setAppLockEnabled(next);
    setAppLockEnabledState(next);
    showMsg(next ? "Auto lock enabled." : "Auto lock disabled.", "success");
  };

  const handleDisablePin = async () => {
    const uid = String(userProfile?.id || sessionStorage.getItem("userId") || "")
      .trim()
      .toLowerCase();

    if (!uid) {
      showMsg("Missing user ID. Please sign in again.", "error");
      return;
    }

    if (!disablePinInput) {
      showMsg("Enter your current PIN to disable.", "error");
      return;
    }

    setDisablePinLoading(true);
    try {
      const vault = await loadPinVaultForUser(uid);
      if (!vault) {
        throw new Error("No PIN vault found.");
      }

      const masterKeyHex = await decryptMasterKeyWithPin(vault, disablePinInput);

      await persistMasterKey(masterKeyHex, "");
      await clearPinVaultForUser(uid);
      await clearBiometricCredential();

      setHasPinVault(false);
      setBiometricEnabled(false);
      setAppLockEnabled(false);
      setAppLockEnabledState(false);
      setDisablePinInput("");
      showMsg("PIN disabled. Master key saved with obfuscation.", "success");
      
    } catch (error) {
      showMsg(error?.message || "Failed to disable PIN. Check your PIN and try again.", "error");
    } finally {
      setDisablePinLoading(false);
    }
  };

  const handleAppLockTimeoutChange = (seconds) => {
    const next = Number(seconds) || 60;
    setAppLockTimeoutSec(next);
    setAppLockSeconds(next);
    showMsg(`Auto lock timeout set to ${Math.round(next / 60)} minute(s).`, "success");
    setAppLockDropdownOpen(false);
  };

  const formatMinutes = (sec) => {
    const m = Math.round(Number(sec || 60) / 60);
    return `${m} min`;
  };

  React.useEffect(() => {
    if (!appLockDropdownOpen) return;
    const el = lockDropdownButtonRef.current;
    if (!el) return;
    setLockDropdownWidth(el.getBoundingClientRect().width || null);
  }, [appLockDropdownOpen, appLockSeconds]);

  const handleLogout = async () => {
    try {
      clearSigningKeys();
      clearRememberedMasterKey();
      // Disable auto lock on logout so re-login starts fresh
      setAppLockEnabled(false);
      setAppLockState(false);
    } catch {
      // best effort cleanup
    }
    clearSessionOnly().catch(() => {});
    window.location.reload();
  };

  const DELETE_LABELS = [
    "Delete My Account",
    "⚠️ Are you sure? Tap to continue",
    "⚠️ Last chance — this is permanent",
    "🔴 CONFIRM — Delete everything now",
  ];

  const handleDeleteClick = async () => {
    if (deleteStep < 3) {
      setDeleteStep((s) => {
        const next = s + 1;
        setTimeout(() => {
          deleteHintRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }, 0);
        return next;
      });
      return;
    }
    setDeleteLoading(true);
    setDeleteError("");
    try {
      const uid = userProfile?.id || sessionStorage.getItem("userId");
      if (!uid) throw new Error("No user ID found.");
      const nonce = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${crypto
        .getRandomValues(new Uint8Array(8))
        .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`;
      await edgePost("/account/delete", { userId: uid, nonce });

      // Wipe ALL data including PIN vault and root keys
      clearSecureStorage().catch(() => {});
      window.location.reload();
    } catch (e) {
      console.error("Delete account failed:", e);
      setDeleteError("Failed: " + (e.message || "Unknown error"));
      setDeleteLoading(false);
      setDeleteStep(0);
    }
  };

  const s = {
    modal: {
      position: "absolute",
      inset: 0,
      background: "rgba(0,0,0,0.5)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 999,
      animation: "fadeIn 0.18s ease both",
    },
    card: {
      background: theme.surface,
      borderRadius: "var(--app-radius-xl)",
      width: "85%",
      maxWidth: 440,
      minWidth: 280,
      margin: "0 12px",
      height: "85%",
      maxHeight: 680,
      minHeight: 400,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      position: "relative",
      boxShadow: "0 12px 48px rgba(0,0,0,0.3)",
      border: `1px solid ${theme.border}`,
    },
    cardContent: {
      flex: 1,
      padding: "0",
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
    },
    label: {
      fontSize: "clamp(10px, 2.5vw, 11px)",
      fontWeight: 700,
      color: theme.text3,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 8,
      display: "block",
    },
    input: {
      width: "100%",
      padding: "clamp(6px, 1.5vw, 8px) clamp(8px, 2vw, 10px)",
      borderRadius: "clamp(8px, 2vw, 10px)",
      border: `1.5px solid ${theme.inputBorder}`,
      background: theme.inputBg,
      color: theme.text,
      fontSize: "clamp(12px, 3vw, 16px)",
      outline: "none",
      boxSizing: "border-box",
    },
    box: {
      background: theme.surface2,
      borderRadius: "clamp(10px, 2.5vw, 14px)",
      padding: "clamp(10px, 2.5vw, 14px)",
      border: `1px solid ${theme.border}`,
      marginBottom: 12,
    },
    closeBtn: {
      position: "absolute",
      top: 14,
      right: 14,
      width: 32,
      height: 32,
      borderRadius: "50%",
      background: theme.surface2,
      border: "none",
      color: theme.text2,
      cursor: "pointer",
      fontSize: 16,
    },
  };

  const deleteBgColor =
    ["", "#b91c1c", "#c2410c", "#dc2626"][deleteStep] || theme.danger;

  return (
    <div
      style={
        embedded
          ? {
              flex: 1,
              minHeight: "100%",
              display: "flex",
              flexDirection: "column",
            }
          : s.modal
      }
      onClick={embedded ? undefined : onClose}
    >
      {/* Floating message banner */}
      {msg.text && (
        <div
          style={{
            position: "fixed",
            top: "max(48px, env(safe-area-inset-top, 0px) + 32px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: theme.surface,
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            border: `1px solid ${msg.type === "success" ? theme.success : msg.type === "error" ? theme.danger : theme.primary}`,
            color: msg.type === "success" ? theme.success : msg.type === "error" ? theme.danger : theme.primary,
            padding: "11px 16px",
            borderRadius: 14,
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1.4,
            zIndex: 9999,
            boxShadow: `0 8px 28px rgba(0,0,0,0.32)`,
            animation: "fadeInScale 0.2s ease-out both",
            minWidth: 220,
            maxWidth: "min(92vw, 420px)",
            textAlign: "center",
          }}
        >
          {msg.text}
        </div>
      )}
      <div
        style={
          embedded
            ? {
                ...s.card,
                width: "100%",
                maxWidth: "100%",
                margin: 0,
                height: "100%",
                borderRadius: 0,
                border: "none",
                background: "transparent",
                minHeight: "100%",
                maxHeight: "100%",
                boxShadow: "none",
                overflowY: "auto",
                WebkitOverflowScrolling: "touch",
                paddingBottom: 0,
              }
            : s.card
        }
        onClick={embedded ? undefined : (e) => e.stopPropagation()}
        className="modal-enter"
      >
        <div style={s.cardContent}>
          {!hideTitle && (
          <div
            style={{
              padding: "16px 18px 14px",
              flexShrink: 0,
              position: "sticky",
              top: 0,
              zIndex: 2,
              background: theme.surface,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ flex: 1, paddingRight: 12 }}>
              <h2
                style={{
                  color: theme.text,
                  fontWeight: 800,
                  fontSize: 18,
                  margin: 0,
                }}
              >
                Settings
              </h2>
              <p style={{ color: theme.text3, fontSize: 11, margin: "2px 0 0" }}>
                Manage your account and preferences
              </p>
            </div>
            {layoutName !== "sidebar" && (
              <button
                onClick={onClose}
                className="shape-radius-sm"
                style={{
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: theme.surface2,
                  border: "none",
                  color: theme.text2,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                  transition: "box-shadow 0.2s ease",
                  outline: "1px solid rgba(0,0,0,0.08)",
                }}
              >
                <CloseIcon size={16} />
              </button>
            )}
          </div>
        )}

        {/* Account */}
        <div style={{ marginBottom: 16, padding: "0 18px" }}>
          <span style={s.label}>Account</span>
          <div style={s.box}>
            {/* Username */}
            <div style={{ marginBottom: 14 }}>
              <div
                style={{ fontSize: "clamp(10px, 2.5vw, 11px)", color: theme.text3, marginBottom: 6 }}
              >
                Username
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setUsernameStatus("");
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleUpdateUsername()}
                  placeholder="Username"
                  style={{ ...s.input, flex: 1 }}
                />
                <button
                  onClick={handleUpdateUsername}
                  disabled={usernameLoading}
                  style={{
                    padding: "clamp(6px, 1.5vw, 8px) clamp(10px, 2vw, 14px)",
                    borderRadius: "clamp(8px, 2vw, 10px)",
                    background: theme.primary,
                    color: theme.primaryFg,
                    fontWeight: 700,
                    fontSize: "clamp(11px, 2.5vw, 12px)",
                    border: "none",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  {usernameLoading ? "…" : "Update"}
                </button>
              </div>
              {usernameStatus && (
                <div
                  style={{
                    fontSize: "clamp(10px, 2.5vw, 11px)",
                    marginTop: 5,
                    color: usernameStatus.startsWith("✓")
                      ? theme.success
                      : theme.danger,
                  }}
                >
                  {usernameStatus}
                </div>
              )}
            </div>

            {/* User ID */}
            <div>
              <div
                style={{ fontSize: "clamp(10px, 2.5vw, 11px)", color: theme.text3, marginBottom: 6 }}
              >
                Your ID
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    flex: 1,
                    fontSize: 11,
                    fontFamily: "monospace",
                    color: theme.text2,
                    wordBreak: "break-all",
                    lineHeight: 1.4,
                  }}
                >
                  {userProfile?.id}
                </span>
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <button
                    onClick={handleCopyId}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 8,
                      background: theme.primary,
                      color: theme.primaryFg,
                      fontWeight: 700,
                      fontSize: 10,
                      border: "none",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <CopyIcon size={10} />
                  </button>
                  {idCopyMsg && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: "calc(100% + 6px)",
                        left: "50%",
                        transform: "translateX(-50%)",
                        background: theme.surface,
                        border: `1px solid ${theme.border}`,
                        color: theme.success,
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "3px 8px",
                        borderRadius: 8,
                        whiteSpace: "nowrap",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                        animation: "fadeInScale 0.15s ease both",
                        pointerEvents: "none",
                      }}
                    >
                      ✓ Copied!
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Theme */}
            {onThemeClick && (
              <div style={{ marginTop: 14 }}>
                <button
                  onClick={onThemeClick}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: theme.surface,
                    border: `1.5px solid ${theme.border}`,
                    color: theme.text,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    transition: "background 0.15s, box-shadow 0.15s",
                    boxShadow: `0 0 8px ${theme.primaryGlow}`,
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = theme.surface2)
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = theme.surface)
                  }
                >
                  <PaletteIcon size={16} style={{ color: theme.primary }} />
                  <span style={{ flex: 1, textAlign: "left" }}>Theme</span>
                  <span style={{ color: theme.text3, fontSize: 10 }}>→</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Remember Me */}
        <div style={{ marginBottom: 16, padding: "0 18px" }}>
          <span style={s.label}>Remember Me</span>
          <div style={s.box}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: theme.primary,
                  boxShadow: `0 0 12px ${theme.primaryGlow}`,
                }}
              >
                <LockIcon size={14} style={{ color: theme.primaryFg }} />
              </div>
              <span
                style={{ fontSize: 12, fontWeight: 600, color: theme.text }}
              >
                Device login settings
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: theme.text2 }}>
                Status: {getLoginModeLabel()}
              </div>
              <button
                onClick={handleRememberToggle}
                disabled={hasPinVault}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: `1px solid ${theme.border}`,
                  background: hasPinVault
                    ? `${theme.surface2}`
                    : rememberEnabled
                      ? `${theme.success}22`
                      : theme.surface,
                  color: hasPinVault
                    ? theme.text3
                    : rememberEnabled
                      ? theme.success
                      : theme.text,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: hasPinVault ? "not-allowed" : "pointer",
                  opacity: hasPinVault ? 0.65 : 1,
                }}
              >
                {hasPinVault ? "Session Secured" : rememberEnabled ? "Session kept" : "Keep session?"}
              </button>
            </div>
            {statusTip && (
              <div
                style={{
                  position: "relative",
                  marginBottom: 8,
                  height: 0,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: -2,
                    left: 0,
                    background: theme.surface,
                    border: `1px solid ${theme.border}`,
                    color: theme.success,
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "3px 8px",
                    borderRadius: 8,
                    whiteSpace: "nowrap",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                    animation: "fadeInScaleSimple 0.15s ease both",
                    pointerEvents: "none",
                  }}
                >
                  {statusTip}
                </div>
              </div>
            )}

            <div style={{ fontSize: 11, color: theme.text3, marginBottom: 6 }}>
              {hasPinVault ? "Change PIN" : "Set PIN"}
            </div>
            <form
              id="pin-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!pinLoading && pinInput) handleSetOrChangePin();
              }}
            >
              {hasPinVault && (
                <div style={{ marginBottom: 8 }}>
                  <input
                    form="pin-form"
                    value={pinCurrent}
                    onChange={(e) => setPinCurrent(e.target.value.slice(0, 32))}
                    placeholder="Current PIN"
                    type="password"
                    autoComplete="off"
                    style={{ ...s.input, marginBottom: 8 }}
                  />
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input
                  form="pin-form"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.slice(0, 32))}
                  placeholder="New PIN"
                  type="password"
                  autoComplete="off"
                  style={{ ...s.input }}
                />
                <input
                  form="pin-form"
                  value={pinConfirm}
                  onChange={(e) => setPinConfirm(e.target.value.slice(0, 32))}
                  placeholder="Confirm"
                  type="password"
                  autoComplete="off"
                  style={{ ...s.input }}
                />
              </div>
              <button
                type="submit"
                disabled={pinLoading}
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  borderRadius: 10,
                  border: "none",
                  background: theme.primary,
                  color: theme.primaryFg,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  marginBottom: 10,
                }}
              >
                {pinLoading ? "Saving..." : hasPinVault ? "Change PIN" : "Set PIN"}
              </button>
            </form>

            <div
              style={{
                opacity: hasPinVault ? 1 : 0.45,
                pointerEvents: hasPinVault ? "auto" : "none",
                transition: "opacity 0.2s ease",
              }}
            >
              <button
                type="button"
                onClick={bioLoading ? undefined : handleToggleBiometric}
                disabled={!hasPinVault || bioLoading}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  borderRadius: 12,
                  border: `1px solid ${biometricEnabled ? theme.primary : theme.border}`,
                  background: biometricEnabled ? `${theme.primary}16` : theme.surface2,
                  color: theme.text2,
                  padding: "10px 12px",
                  cursor: hasPinVault ? "pointer" : "not-allowed",
                  opacity: hasPinVault ? 1 : 0.55,
                  textAlign: "left",
                  transition:
                    "border-color 0.28s cubic-bezier(0.22,1,0.36,1), background-color 0.28s cubic-bezier(0.22,1,0.36,1), transform 0.12s ease",
                }}
                onMouseDown={(e) => {
                  e.currentTarget.style.transform = "scale(0.992)";
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.transform = "scale(1)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 6,
                    border: `1.5px solid ${biometricEnabled ? theme.primary : theme.border}`,
                    background: biometricEnabled ? theme.primary : theme.surface,
                    boxShadow: biometricEnabled ? `0 0 0 3px ${theme.primary}2f` : "0 0 0 0 rgba(0,0,0,0)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginTop: 1,
                    flexShrink: 0,
                    transition:
                      "border-color 0.28s cubic-bezier(0.22,1,0.36,1), background-color 0.28s cubic-bezier(0.22,1,0.36,1), box-shadow 0.28s cubic-bezier(0.22,1,0.36,1)",
                  }}
                >
                  <span
                    style={{
                      color: theme.primaryFg,
                      display: "inline-flex",
                      opacity: biometricEnabled ? 1 : 0,
                      transform: biometricEnabled ? "scale(1) translateY(0)" : "scale(0.65) translateY(1px)",
                      transition: "opacity 0.2s cubic-bezier(0.22,1,0.36,1), transform 0.2s cubic-bezier(0.22,1,0.36,1)",
                    }}
                  >
                    <CheckIcon size={12} />
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: biometricEnabled ? theme.text : theme.text2,
                    transition: "color 0.2s cubic-bezier(0.22,1,0.36,1)",
                  }}
                >
                  {bioLoading ? "Working..." : "Biometric unlock"}
                </span>
              </button>
            </div>

            {hasPinVault && (
              <form
                id="disable-pin-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!disablePinLoading && disablePinInput) handleDisablePin();
                }}
              >
                <div style={{ marginTop: 16, padding: 12, borderRadius: 10, border: `1px solid ${theme.danger}44`, background: `${theme.danger}08` }}>
                  <div style={{ fontSize: 11, color: theme.text3, marginBottom: 8 }}>
                    Disable PIN (switch to remember me only)
                  </div>
                  <input
                    form="disable-pin-form"
                    value={disablePinInput}
                    onChange={(e) => setDisablePinInput(e.target.value.slice(0, 32))}
                    placeholder="Enter current PIN"
                    type="password"
                    autoComplete="off"
                    style={{
                      ...s.input,
                      marginBottom: 8,
                    }}
                  />
                  <button
                    type="submit"
                    disabled={disablePinLoading}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = theme.danger;
                      e.currentTarget.style.color = "#fff";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = `${theme.danger}22`;
                      e.currentTarget.style.color = theme.danger;
                    }}
                    onMouseDown={(e) => {
                      e.currentTarget.style.transform = "scale(0.97)";
                    }}
                    onMouseUp={(e) => {
                      e.currentTarget.style.transform = "scale(1)";
                    }}
                    style={{
                      width: "100%",
                      padding: "9px 12px",
                      borderRadius: 10,
                      border: `1px solid ${theme.danger}`,
                      background: `${theme.danger}22`,
                      color: theme.danger,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: disablePinLoading ? "wait" : "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    {disablePinLoading ? "Disabling..." : "Disable PIN"}
                  </button>
                </div>
              </form>
            )}

            <div style={{ fontSize: 10, color: theme.text3, marginTop: 8, lineHeight: 1.5 }}>
              iPhone/Safari may show biometric as a passkey prompt. Choose the built-in option (Touch ID / Face ID) for fastest unlock.
            </div>

            <div style={{ height: 1, background: theme.border, margin: "12px 0" }} />
            <div style={{ fontSize: 11, color: theme.text3, marginBottom: 6 }}>
              Auto lock
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 12, color: theme.text2 }}>
                Status: {appLockEnabled ? "Enabled" : "Disabled"}
              </div>
              <button
                onClick={handleToggleAppLock}
                disabled={!hasPinVault}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: `1px solid ${theme.border}`,
                  background: !hasPinVault
                    ? theme.surface2
                    : appLockEnabled
                      ? `${theme.success}22`
                      : theme.surface,
                  color: !hasPinVault
                    ? theme.text3
                    : appLockEnabled
                      ? theme.success
                      : theme.text,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: !hasPinVault ? "not-allowed" : "pointer",
                  opacity: !hasPinVault ? 0.6 : 1,
                }}
              >
                {appLockEnabled ? "Disable" : "Enable"}
              </button>
            </div>
            <div style={{ marginTop: 8, position: "relative" }}>
              <button
                ref={lockDropdownButtonRef}
                onClick={() => setAppLockDropdownOpen((v) => !v)}
                style={{
                  width: "fit-content",
                  minWidth: 0,
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: `1px solid ${theme.border}`,
                  background: theme.surface,
                  color: theme.text,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span>Lock after: {formatMinutes(appLockSeconds)}</span>
                <span style={{ color: theme.text3 }}>▾</span>
              </button>
              {appLockDropdownOpen && (
                <div
                  className="dropdown-enter"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    left: 0,
                    width: lockDropdownWidth || "fit-content",
                    minWidth: lockDropdownWidth || 0,
                    background: theme.surface,
                    border: `1px solid ${theme.border}`,
                    borderRadius: 10,
                    maxHeight: 148,
                    overflowY: "auto",
                    zIndex: 12,
                    boxShadow: "0 10px 26px rgba(0,0,0,0.25)",
                  }}
                >
                  {APP_LOCK_OPTIONS.map((sec) => (
                    <button
                      key={sec}
                      onClick={() => handleAppLockTimeoutChange(sec)}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        border: "none",
                        borderBottom: `1px solid ${theme.border}`,
                        background: "transparent",
                        color: appLockSeconds === sec ? theme.primary : theme.text,
                        textAlign: "left",
                        whiteSpace: "nowrap",
                        fontSize: 11,
                        fontWeight: appLockSeconds === sec ? 700 : 500,
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = appLockSeconds === sec
                          ? `${theme.primary}30`
                          : `${theme.primary}12`;
                        e.currentTarget.style.color = theme.primary;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = appLockSeconds === sec ? theme.primary : theme.text;
                        e.currentTarget.style.fontWeight = appLockSeconds === sec ? 700 : 500;
                      }}
                    >
                      {formatMinutes(sec)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {embedded && (
              <>
                <div style={{ height: 1, background: theme.border, margin: "12px 0" }} />
                <div style={{ fontSize: 11, color: theme.text3, marginBottom: 6 }}>
                  Privacy
                </div>
                <button
                  onClick={() => {
                    if (typeof onBlockedListClick === "function") {
                      onBlockedListClick();
                      return;
                    }
                    try {
                      sessionStorage.setItem("friends_tab_default", "blocked");
                    } catch {
                      // ignore
                    }
                    onClose?.();
                  }}
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    borderRadius: 10,
                    border: `1px solid ${theme.border}`,
                    background: theme.surface,
                    color: theme.text,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = theme.primary;
                    e.currentTarget.style.color = theme.primary;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = theme.border;
                    e.currentTarget.style.color = theme.text;
                  }}
                >
                  <BlockIcon size={15} style={{ color: theme.danger }} />
                  <span style={{ flex: 1, textAlign: "left" }}>Blocked Users</span>
                  <span style={{ color: theme.text3, fontSize: 10 }}>→</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Bottom Actions */}
        <div style={{ padding: "0 18px 20px" }}>
          {/* Logout */}
          <button
            onClick={handleLogout}
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: 10,
              background: theme.success,
              color: theme.successFg,
              fontWeight: 700,
              fontSize: 12,
              border: `1px solid ${theme.success}`,
              cursor: "pointer",
              marginTop: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              boxShadow: `0 0 20px ${theme.success}40`,
            }}
          >
            <LogOutIcon size={14} /> Logout
          </button>

          {/* Clear Account Cache */}
          <button
            onClick={async () => {
              const uid = userProfile?.id || sessionStorage.getItem("userId");
              if (!uid) return;
              await clearUserCache(uid);
              // Also clear the in-memory session cache
              if (window._sessionCache?.convMessages) {
                Object.keys(window._sessionCache.convMessages).forEach((k) => {
                  if (k.includes(uid)) delete window._sessionCache.convMessages[k];
                });
              }
              // Dispatch event to notify Chat components to refetch
              window.dispatchEvent(new CustomEvent("chatapp-cache-cleared", {
                detail: { userId: uid, timestamp: Date.now() }
              }));
              showMsg("Cache cleared!", "success");
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = theme.surface3 || theme.surface2;
              e.currentTarget.style.borderColor = theme.primary;
              e.currentTarget.style.color = theme.primary;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = theme.surface2;
              e.currentTarget.style.borderColor = theme.border;
              e.currentTarget.style.color = theme.text2;
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.transform = "scale(0.97)";
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = "scale(1)";
            }}
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: 10,
              background: theme.surface2,
              color: theme.text2,
              fontWeight: 700,
              fontSize: 12,
              border: `1px solid ${theme.border}`,
              cursor: "pointer",
              marginTop: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              transition: "all 0.15s ease",
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
            Clear cached messages
          </button>

          {/* Delete Account — triple confirm */}
          <div style={{ marginTop: 8 }}>
          {deleteError && (
            <div
              style={{
                fontSize: 11,
                color: theme.danger,
                marginBottom: 6,
                textAlign: "center",
              }}
            >
              {deleteError}
            </div>
          )}
          <button
            onClick={handleDeleteClick}
            disabled={deleteLoading}
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: 10,
              background: deleteStep === 0 ? theme.danger : deleteBgColor,
              color: "#fff",
              fontWeight: 700,
              fontSize: 12,
              border: `1px solid ${deleteStep > 0 ? "#ff0000" : theme.danger}`,
              cursor: "pointer",
              marginTop: 8,
              boxShadow:
                deleteStep > 0
                  ? "0 0 20px #ff000066"
                  : `0 0 15px ${theme.danger}30`,
              transition: "background 0.25s, box-shadow 0.25s",
            }}
          >
            {deleteLoading ? "Deleting…" : DELETE_LABELS[deleteStep]}
          </button>

          {deleteStep > 0 && !deleteLoading && (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div
                ref={deleteHintRef}
                style={{
                  background: `${theme.danger}15`,
                  border: `1px solid ${theme.danger}`,
                  borderRadius: 10,
                  padding: 12,
                  fontSize: 11,
                  color: theme.text2,
                  lineHeight: 1.5,
                }}
              >
                <div
                  style={{
                    color: theme.danger,
                    fontWeight: 700,
                    marginBottom: 6,
                  }}
                >
                  ⚠️ Step {deleteStep} of 3 — permanently deletes:
                </div>
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  <li>All messages and conversations</li>
                  <li>All reactions and notifications</li>
                  <li>Your account and all friends</li>
                </ul>
                <div
                  style={{ marginTop: 8, color: theme.danger, fontWeight: 700 }}
                >
                  Cannot be undone!
                </div>
              </div>
              <button
                onClick={() => setDeleteStep(0)}
                style={{
                  padding: "8px",
                  borderRadius: 10,
                  background: theme.surface2,
                  color: theme.text2,
                  fontWeight: 600,
                  fontSize: 11,
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
