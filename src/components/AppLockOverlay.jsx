import React, { useState, useEffect } from "react";
import { useTheme } from "../context/ThemeContext";
import { verifyBiometricUnlock, isBiometricEnabled } from "../utils/biometricGuard";
import {
  PIN_MIN_LENGTH,
  isValidPin,
  decryptMasterKeyWithPin,
} from "../utils/pinVault";
import { loadPinVaultForUser } from "../utils/secureStorage";
import {
  loadMasterKey,
  hasRememberedMasterKey,
  clearSigningKeys,
  clearRememberedMasterKey,
} from "../lib/edgeApi";
import { signInWithPrivateKey } from "../lib/authProfileService";
import { deriveZchatIdentityFromSeed } from "../utils/zchatIdentity";

const AppLockOverlay = ({ userId, onUnlock, onLogout }) => {
  const { theme } = useTheme();
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [biometricVerified, setBiometricVerified] = useState(false);
  const [hasPasswordVault, setHasPasswordVault] = useState(false);

  // Detect available unlock methods
  const bioAvailable = isBiometricEnabled();
  const hasRememberMe = hasRememberedMasterKey();
  const hasPin = !!userId;

  useEffect(() => {
    // Check if password-encrypted vault exists
    try {
      const vaultRaw = localStorage.getItem("zchat_master_key_encrypted");
      setHasPasswordVault(!!vaultRaw);
    } catch {
      // ignore
    }
  }, []); // If userId is passed, PIN vault exists

  // Determine primary unlock method
  const showPinInput = hasPin && !hasRememberMe;
  const showRememberMeButton = hasRememberMe && !hasPin;
  const showBoth = hasRememberMe && hasPin;

  // BUG 1 FIX: Support free-form PIN/password (not just 6 digits)
  // BUG 3 FIX: Biometric is an ALTERNATIVE to PIN, not a prerequisite
  const unlockWithPin = async () => {
    const uid = String(userId || "").trim().toLowerCase();
    if (!uid) return;
    if (!isValidPin(pin)) {
      setStatus(`Enter password (${PIN_MIN_LENGTH}+ characters).`);
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const vault = await loadPinVaultForUser(uid);
      if (!vault) throw new Error("No PIN vault found");
      const privateKeyHex = await decryptMasterKeyWithPin(vault, pin);
      if (!/^[0-9a-f]{64}$/i.test(String(privateKeyHex || ""))) {
        throw new Error("Invalid unlock key");
      }
      const clean = String(privateKeyHex).trim().toLowerCase();
      const signedIn = await signInWithPrivateKey(clean, true);
      onUnlock?.({
        userId: signedIn.userId,
        publicKey: signedIn.publicKey,
        privateKey: clean,
      });
    } catch (e) {
      setStatus(e?.message || "Failed to unlock");
    } finally {
      setBusy(false);
    }
  };

  // BUG 2 FIX: Remember Me users can unlock without PIN
  const unlockWithRememberMe = async () => {
    setBusy(true);
    setStatus("");
    try {
      const remembered = await loadMasterKey();
      if (!remembered || !remembered.masterKeyHex) {
        throw new Error("Remembered session not found. Please sign in again.");
      }
      const identity = deriveZchatIdentityFromSeed(remembered.masterKeyHex);
      onUnlock?.({
        userId: identity.userId,
        publicKey: identity.publicKeyHex,
        privateKey: identity.privateKeyHex,
      });
    } catch (e) {
      setStatus(e?.message || "Failed to unlock");
    } finally {
      setBusy(false);
    }
  };

  // BUG 3 FIX: Biometric replaces PIN/Remember Me — it's an alternative, not a prerequisite
  const unlockWithBiometric = async () => {
    setBusy(true);
    setStatus("");
    try {
      if (!isBiometricEnabled()) throw new Error("Biometric unlock is not enabled");
      await verifyBiometricUnlock();
      setBiometricVerified(true);

      // Try Remember Me first (no input needed)
      if (hasRememberMe) {
        await unlockWithRememberMe();
        return;
      }
      // Try password vault
      if (hasPasswordVault) {
        await unlockWithPassword();
        return;
      }
      // Fall back to PIN
      if (hasPin) {
        if (!pin || !isValidPin(pin)) {
setStatus(`Enter password (${PIN_MIN_LENGTH}+ characters).`);
          return;
        }
        await unlockWithPin();
        return;
      }

      setStatus("No unlock method available after biometric verification");
    } catch (e) {
      setStatus(e?.message || "Biometric verification failed");
      setBiometricVerified(false);
    } finally {
      setBusy(false);
    }
  };

  // Unlock via password-encrypted vault
  const unlockWithPassword = async () => {
    if (!password.trim()) {
      setStatus("Enter your password.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const vaultRaw = localStorage.getItem("zchat_master_key_encrypted");
      if (!vaultRaw) throw new Error("Password vault not found");
      const vault = JSON.parse(vaultRaw);
      const decrypted = await decryptMasterKeyWithPin(vault, password);
      if (!decrypted || !/^[0-9a-f]{64}$/i.test(decrypted)) {
        throw new Error("Invalid password");
      }
      const identity = deriveZchatIdentityFromSeed(decrypted);
      onUnlock?.({
        userId: identity.userId,
        publicKey: identity.publicKeyHex,
        privateKey: decrypted,
      });
    } catch (e) {
      setStatus(e?.message || "Failed to unlock");
    } finally {
      setBusy(false);
    }
  };

  const doLogout = async () => {
    setBusy(true);
    try {
      clearSigningKeys();
      clearRememberedMasterKey();
    } catch {
      // best effort
    }
    onLogout?.();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999,
        background: "rgba(0,0,0,0.72)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 360,
          background: theme.surface,
          borderRadius: 18,
          border: `1px solid ${theme.border}`,
          padding: 16,
          boxShadow: `0 16px 44px rgba(0,0,0,0.38), 0 0 18px ${theme.primaryGlow || "rgba(255,255,255,0.14)"}`,
          animation: "floatIn 0.24s ease both",
        }}
      >
        <div style={{ color: theme.text, fontSize: 17, fontWeight: 700, marginBottom: 8 }}>
          App Locked
        </div>
        <div style={{ color: theme.text3, fontSize: 12, marginBottom: 12 }}>
          {showPinInput
            ? "Enter your PIN to unlock."
            : showRememberMeButton
              ? "Tap Unlock to restore your session."
              : showBoth
                ? "Enter PIN or tap Unlock to restore."
                : "Unlock with biometric or logout."}
          {bioAvailable && " Biometric is also available."}
        </div>

        {/* Biometric button (always shown if available) */}
        {bioAvailable && (
          <button
            onClick={unlockWithBiometric}
            disabled={busy}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${theme.border}`,
              background: biometricVerified ? `${theme.success}20` : theme.surface2,
              color: biometricVerified ? theme.success : theme.text,
              fontWeight: 700,
              cursor: "pointer",
              marginBottom: 8,
            }}
          >
            {biometricVerified ? "Biometric verified" : "Use Face ID / Fingerprint"}
          </button>
        )}

        {/* Remember Me unlock button (plaintext mode) */}
        {hasRememberMe && (
          <button
            onClick={unlockWithRememberMe}
            disabled={busy}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "none",
              background: theme.primary,
              color: theme.primaryFg,
              fontWeight: 700,
              cursor: "pointer",
              marginBottom: 8,
            }}
          >
            {busy ? "Unlocking..." : "Unlock"}
          </button>
        )}

        {/* Password input (password-encrypted vault mode) */}
        {hasPasswordVault && (
          <>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              inputMode="text"
              autoComplete="off"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px 12px",
                borderRadius: 10,
                border: `1px solid ${theme.inputBorder}`,
                background: theme.inputBg,
                color: theme.text,
                marginBottom: 8,
              }}
            />
            <button
              onClick={unlockWithPassword}
              disabled={busy}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: "none",
                background: theme.primary,
                color: theme.primaryFg,
                fontWeight: 700,
                cursor: "pointer",
                marginBottom: 8,
              }}
            >
              {busy ? "Unlocking..." : "Unlock"}
            </button>
          </>
        )}

        {/* PIN input (shown when PIN vault exists) */}
        {hasPin && (
          <>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="Enter PIN"
              inputMode="numeric"
              autoComplete="off"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px 12px",
                borderRadius: 10,
                border: `1px solid ${theme.inputBorder}`,
                background: theme.inputBg,
                color: theme.text,
                marginBottom: 10,
              }}
            />
            <button
              onClick={unlockWithPin}
              disabled={busy}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: "none",
                background: theme.primary,
                color: theme.primaryFg,
                fontWeight: 700,
                cursor: "pointer",
                marginBottom: 14,
              }}
            >
              {busy ? "Unlocking..." : "Unlock"}
            </button>
          </>
        )}

        {/* Fallback: if no unlock method available */}
        {!hasRememberMe && !hasPin && !bioAvailable && (
          <div style={{ color: theme.danger, fontSize: 11, marginBottom: 12 }}>
            No unlock method found. Please logout and sign in again.
          </div>
        )}

        {status && (
          <div style={{ fontSize: 11, color: theme.warning, marginBottom: 10 }}>{status}</div>
        )}

        <button
          onClick={doLogout}
          style={{
            width: "100%",
            padding: "9px 12px",
            borderRadius: 10,
            border: `1px solid ${theme.danger}`,
            background: `${theme.danger}22`,
            color: theme.danger,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Logout
        </button>
      </div>
    </div>
  );
};

export default AppLockOverlay;
