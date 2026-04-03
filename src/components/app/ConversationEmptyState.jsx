import React from "react";
import { ChatIcon } from "../Icons";

const ConversationEmptyState = ({ theme, onOpenFriends }) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div
        style={{
          marginBottom: 16,
          color: theme.primary,
          filter: `drop-shadow(0 0 12px ${theme.primary}44)`,
        }}
      >
        <ChatIcon size={52} />
      </div>
      <div
        style={{
          fontWeight: 800,
          color: theme.text,
          fontSize: 18,
          marginBottom: 6,
        }}
      >
        No conversations yet
      </div>
      <div
        style={{
          color: theme.text2,
          fontSize: 13,
          marginBottom: 20,
          lineHeight: 1.6,
        }}
      >
        Head to <strong style={{ color: theme.primary }}>Friends</strong>, add a
        friend, then tap <strong style={{ color: theme.primary }}>Chat</strong> on
        their card to start a conversation.
      </div>
      <button
        onClick={onOpenFriends}
        style={{
          padding: "12px 28px",
          borderRadius: 24,
          background: theme.primary,
          color: theme.primaryFg,
          fontWeight: 700,
          fontSize: 14,
          border: "none",
          cursor: "pointer",
          boxShadow: `0 4px 16px ${theme.primaryGlow}`,
        }}
      >
        Open Friends
      </button>
    </div>
  );
};

export default ConversationEmptyState;
