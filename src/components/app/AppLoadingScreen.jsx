import React from "react";

const AppLoadingScreen = ({ theme }) => {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: theme.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
      }}
    >
      <div style={{ position: "relative", width: 64, height: 64 }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: `3px solid ${theme.border}`,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: "3px solid transparent",
            borderTopColor: theme.primary,
            animation: "spin 0.9s linear infinite",
            boxShadow: `0 0 16px ${theme.primaryGlow}`,
          }}
        />
      </div>
      <div style={{ color: theme.text, fontSize: 16, fontWeight: 800 }}>
        SecureChat
      </div>
      <div style={{ color: theme.text3, fontSize: 12 }}>Securing your data…</div>
    </div>
  );
};

export default AppLoadingScreen;
