import React, { useState, useEffect } from "react";
import { useTheme } from "../context/ThemeContext";
import { CloseIcon, SearchIcon } from "./Icons";
import { getBlockedUsers, unblockUser } from "../lib/schemaApi";

const BlockedListModal = ({ onClose }) => {
  const { theme } = useTheme();
  const [blockedUsers, setBlockedUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [unblockLoading, setUnblockLoading] = useState(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    loadBlockedUsers();
  }, []);

  const loadBlockedUsers = async () => {
    setLoading(true);
    try {
      const uid = sessionStorage.getItem("userId");
      const users = await getBlockedUsers(uid);
      setBlockedUsers(users || []);
    } catch (err) {
      console.error("Failed to load blocked users:", err);
      setBlockedUsers([]);
    } finally {
      setLoading(false);
    }
  };

  const handleUnblock = async (blockedId) => {
    setUnblockLoading(blockedId);
    try {
      const uid = sessionStorage.getItem("userId");
      await unblockUser(uid, blockedId);
      setBlockedUsers((prev) => prev.filter((u) => u.id !== blockedId));
    } catch (err) {
      console.error("Failed to unblock:", err);
    } finally {
      setUnblockLoading(null);
    }
  };

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => {
      onClose();
    }, 180);
  };

  const filteredUsers = blockedUsers.filter((u) => {
    const query = searchQuery.toLowerCase();
    return (
      u.username?.toLowerCase().includes(query) ||
      u.id?.toLowerCase().includes(query)
    );
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 999,
        transform: "translateZ(0)",
        willChange: "opacity",
      }}
      onClick={requestClose}
      className={closing ? "modal-exit" : "modal-enter"}
    >
      <div
        style={{
          background: theme.surface,
          borderRadius: "var(--app-radius-xl)",
          padding: 0,
          width: "85%",
          maxWidth: 440,
          minWidth: 280,
          margin: "0 12px",
          height: "85%",
          maxHeight: 680,
          minHeight: 400,
          position: "relative",
          boxShadow: "0 12px 48px rgba(0,0,0,0.3)",
          border: `1px solid ${theme.border}`,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          willChange: "transform, opacity",
          backfaceVisibility: "hidden",
        }}
        className={closing ? "modal-card-exit" : "modal-card-enter"}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: "16px 18px 14px",
            flexShrink: 0,
            position: "sticky",
            top: 0,
            zIndex: 2,
            background: theme.surface,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <h2
                style={{
                  color: theme.text,
                  fontWeight: 800,
                  fontSize: 18,
                  margin: 0,
                }}
              >
                Blocked Users
              </h2>
              <p style={{ color: theme.text3, fontSize: 11, margin: "2px 0 0" }}>
                {blockedUsers.length} user{blockedUsers.length !== 1 ? "s" : ""} blocked
              </p>
            </div>
            <button
              onClick={requestClose}
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
              }}
            >
              <CloseIcon size={16} />
            </button>
          </div>

          {blockedUsers.length > 0 && (
            <div style={{ position: "relative" }}>
              <SearchIcon
                size={16}
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: theme.text3,
                  pointerEvents: "none",
                }}
              />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name or ID..."
                style={{
                  width: "100%",
                  padding: "9px 12px 9px 34px",
                  borderRadius: "var(--app-radius-md)",
                  border: `1px solid ${theme.border}`,
                  background: theme.surface2,
                  color: theme.text,
                  fontSize: 13,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: 40, color: theme.text3 }}>
              Loading...
            </div>
          ) : filteredUsers.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: theme.text3 }}>
              {blockedUsers.length === 0
                ? "No blocked users"
                : "No matches found"}
            </div>
          ) : (
            filteredUsers.map((user) => (
              <div
                key={user.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 18px",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = theme.surface2)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: theme.primary,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: theme.primaryFg,
                    fontWeight: 700,
                    fontSize: 16,
                    flexShrink: 0,
                  }}
                >
                  {(user.username?.[0] || user.id?.[0] || "?").toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: theme.text,
                      fontWeight: 600,
                      fontSize: 14,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {user.username || "Unknown"}
                  </div>
                  <div
                    style={{
                      color: theme.text3,
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {user.id}
                  </div>
                </div>
                <button
                  onClick={() => handleUnblock(user.id)}
                  disabled={unblockLoading === user.id}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "var(--app-radius-md)",
                    border: `1px solid ${theme.border}`,
                    background: theme.surface2,
                    color: theme.text2,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: unblockLoading === user.id ? "wait" : "pointer",
                    transition: "all 0.15s ease",
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = theme.danger;
                    e.currentTarget.style.color = "#fff";
                    e.currentTarget.style.borderColor = theme.danger;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = theme.surface2;
                    e.currentTarget.style.color = theme.text2;
                    e.currentTarget.style.borderColor = theme.border;
                  }}
                >
                  {unblockLoading === user.id ? "..." : "Unblock"}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default BlockedListModal;
