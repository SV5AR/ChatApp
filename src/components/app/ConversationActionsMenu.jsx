import React from "react";
import { TrashIcon, UserMinusIcon, BlockIcon } from "../Icons";

const ConversationActionsMenu = ({
  theme,
  conversation,
  onDeleteForMe,
  onDeleteForAll,
  onUnfriend,
  onBlock,
}) => {
  const items = [
    {
      label: "Delete for me",
      sub: "Removes from your list only",
      color: theme.text,
      icon: <TrashIcon size={14} />,
      fn: () => onDeleteForMe(conversation.conversation_id),
    },
    {
      label: "Delete for everyone",
      sub: "Removes for both users",
      color: theme.danger,
      icon: <TrashIcon size={14} />,
      fn: () => onDeleteForAll(conversation.conversation_id),
    },
    {
      label: "Unfriend",
      sub: "Removes friend and conversation",
      color: theme.danger,
      icon: <UserMinusIcon size={14} />,
      fn: () => onUnfriend(conversation.conversation_id, conversation.otherUser?.id),
    },
    {
      label: "Block",
      sub: "Block and delete conversation",
      color: theme.danger,
      icon: <BlockIcon size={14} />,
      fn: () => onBlock(conversation),
    },
  ];

  return (
    <div
      className="app-menu"
      style={{
        position: "absolute",
        right: 8,
        top: "100%",
        background: theme.surface,
        borderRadius: 16,
        boxShadow: `0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px ${theme.border}`,
        zIndex: 9999,
        minWidth: 220,
        overflow: "hidden",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ padding: "6px 0" }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: theme.text3,
            padding: "6px 14px 4px",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          Actions
        </div>
        {items.map((item) => (
          <button
            className="app-menu-item"
            key={item.label}
            onClick={(e) => {
              e.stopPropagation();
              item.fn();
            }}
            style={{
              width: "100%",
              padding: "12px 14px",
              background: "transparent",
              border: "none",
              color: item.color,
              fontSize: 13,
              cursor: "pointer",
              textAlign: "left",
              display: "flex",
              gap: 10,
              alignItems: "center",
              borderRadius: 12,
            }}
          >
            <span>{item.icon}</span>
            <div>
              <div style={{ fontWeight: 600 }}>{item.label}</div>
              <div style={{ fontSize: 11, color: theme.text3, marginTop: 1 }}>
                {item.sub}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

export default ConversationActionsMenu;
