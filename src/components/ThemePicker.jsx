import React, { useState } from "react";
import { createPortal } from "react-dom";
import {
  useTheme,
  THEMES,
  MATERIALS,
  SHAPE_STYLES,
  LAYOUT_STYLES,
} from "../context/ThemeContext";
import { CloseIcon } from "./Icons";

const ThemePicker = ({ onClose }) => {
  const {
    theme,
    themeName,
    setTheme,
    materialName,
    setMaterial,
    shapeName,
    setShape,
    layoutName,
    setLayout,
  } = useTheme();
  const [hovered, setHovered] = useState(null);
  const [tab, setTab] = useState("palette");
  const [closing, setClosing] = useState(false);
  const prevTabRef = React.useRef("palette");
  const [tabAnimClass, setTabAnimClass] = useState("tab-content");
  const closeTimerRef = React.useRef(null);

  React.useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = tab;
    const cls = prev === tab ? "tab-content" : "tab-content tab-content-slide";
    setTabAnimClass(cls);
  }, [tab]);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = setTimeout(() => {
      onClose();
    }, 180);
  };

  const handlePick = (key) => {
    setTheme(key);
  };


  const modal = (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 220,
        padding: 16,
        transform: "translateZ(0)",
        willChange: "opacity",
      }}
      onClick={requestClose}
      className={closing ? "modal-exit" : "modal-enter"}
    >
      <div
        style={{
          background: theme.surface,
          borderRadius: 28,
          padding: 0,
          width: "75%",
          maxWidth: 400,
          minWidth: 280,
          height: "75%",
          maxHeight: 600,
          minHeight: 400,
          position: "relative",
          boxShadow: theme.cardShadow,
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
        <button
          onClick={requestClose}
          className="shape-radius-sm"
          style={{
            position: "absolute",
            top: 18,
            right: 18,
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
            zIndex: 10,
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            transition: "box-shadow 0.2s ease",
            outline: "1px solid rgba(0,0,0,0.08)",
          }}
        >
          <CloseIcon size={16} />
        </button>

        <div
          style={{
            padding: "20px 24px 10px",
            flexShrink: 0,
            position: "sticky",
            top: 0,
            zIndex: 2,
            background: theme.surface,
          }}
        >
          <h2
            className="tab-content"
            style={{
              color: theme.text,
              fontWeight: 800,
              fontSize: 20,
              margin: "0 0 4px",
              paddingRight: 40,
            }}
          >
            Appearance
          </h2>
           <p className="tab-content" style={{ color: theme.text3, fontSize: 12, margin: "0 0 14px" }}>
             {Object.keys(THEMES).length} themes available · Changes apply
             instantly
           </p>

          <div
            className="theme-tab-track"
            style={{
              display: "flex",
              background: theme.surface2,
              borderRadius: "var(--app-radius-md)",
              padding: 4,
              gap: 4,
              border: `1px solid ${theme.border}`,
              position: "relative",
              overflow: "hidden",
            }}
          >
          <div
            className="theme-tab-indicator"
            style={{
              position: "absolute",
              top: 4,
              left:
                tab === "palette"
                  ? 4
                  : tab === "material"
                    ? "calc(25% + 3px)"
                    : tab === "shape"
                      ? "calc(50% + 1px)"
                      : "calc(75% - 1px)",
              width: "calc(25% - 6px)",
              height: "calc(100% - 8px)",
              borderRadius: "var(--app-radius-sm)",
              background: theme.primary + "22",
              border: `1px solid ${theme.primary}3a`,
              boxShadow: `0 0 10px ${theme.primaryGlow || `${theme.primary}44`}`,
              pointerEvents: "none",
              transition:
                "left var(--app-motion-slow, 320ms) var(--app-ease-emphasized, cubic-bezier(0.22,1,0.36,1)), box-shadow var(--app-motion-normal, 220ms) var(--app-ease-standard, ease), background-color var(--app-motion-normal, 220ms) var(--app-ease-standard, ease)",
            }}
          />
          <button
            onClick={() => setTab("palette")}
            style={{
              flex: 1,
              border: "none",
              borderRadius: "var(--app-radius-sm)",
              padding: "9px 10px",
              background: "transparent",
              color: tab === "palette" ? theme.primary : theme.text2,
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
              position: "relative",
              zIndex: 1,
              transition: "color 0.18s ease",
            }}
          >
            Color Palette
          </button>
          <button
            onClick={() => setTab("material")}
            style={{
              flex: 1,
              border: "none",
              borderRadius: "var(--app-radius-sm)",
              padding: "9px 10px",
              background: "transparent",
              color: tab === "material" ? theme.primary : theme.text2,
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
              position: "relative",
              zIndex: 1,
              transition: "color 0.18s ease",
            }}
          >
            Material
          </button>
          <button
            onClick={() => setTab("shape")}
            style={{
              flex: 1,
              border: "none",
              borderRadius: "var(--app-radius-sm)",
              padding: "9px 10px",
              background: "transparent",
              color: tab === "shape" ? theme.primary : theme.text2,
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
              position: "relative",
              zIndex: 1,
              transition: "color 0.18s ease",
            }}
          >
            Shape Style
          </button>
          <button
            onClick={() => setTab("layout")}
            style={{
              flex: 1,
              border: "none",
              borderRadius: "var(--app-radius-sm)",
              padding: "9px 10px",
              background: "transparent",
              color: tab === "layout" ? theme.primary : theme.text2,
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
              position: "relative",
              zIndex: 1,
              transition: "color 0.18s ease",
            }}
          >
            Layout
          </button>
        </div>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "8px 24px 24px",
          }}
        >

        <div
          key={`theme-tab-${tab}`}
          className={tabAnimClass}
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          {tab === "palette" && Object.entries(THEMES).map(([key, t]) => {
            const active = key === themeName;
            const isHovered = hovered === key;
            const p = t.preview;

            return (
              <button
                key={key}
                onClick={() => handlePick(key)}
                onMouseEnter={() => setHovered(key)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  background: active
                    ? `${t.primary}22`
                    : isHovered
                      ? theme.surface2
                      : theme.surface2,
                  border: `2px solid ${active ? t.primary : isHovered ? `${t.primary}66` : theme.border}`,
                  borderRadius: "var(--app-radius-lg)",
                  padding: "14px 16px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  textAlign: "left",
                  boxShadow: active
                    ? `0 0 0 1px ${t.primary}33, 0 4px 20px ${t.primary}33`
                    : isHovered
                      ? `0 0 12px ${t.primary}22`
                      : "none",
                  transition: "all 0.18s ease",
                  transform: isHovered && !active ? "translateY(-1px)" : "none",
                }}
              >
                {/* Mini chat preview */}
                <div
                  style={{
                    width: 72,
                    height: 54,
                    borderRadius: "var(--app-radius-md)",
                    overflow: "hidden",
                    background: p.bg,
                    flexShrink: 0,
                    border: `1px solid ${active ? t.primary + "66" : theme.border}`,
                    boxShadow:
                      active || isHovered ? `0 0 8px ${t.primary}44` : "none",
                    transition: "box-shadow 0.18s",
                  }}
                >
                  {/* Header strip */}
                  <div
                    style={{
                      height: 15,
                      background: p.header,
                      display: "flex",
                      alignItems: "center",
                      padding: "0 7px",
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: `${t.primary}99`,
                      }}
                    />
                    <div
                      style={{
                        flex: 1,
                        height: 3,
                        borderRadius: 2,
                        background: "rgba(255,255,255,0.2)",
                      }}
                    />
                  </div>
                  {/* Messages */}
                  <div
                    style={{
                      padding: "4px 6px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                    }}
                  >
                    <div
                      style={{
                        alignSelf: "flex-end",
                        background: p.bubble1,
                        borderRadius: "7px 7px 2px 7px",
                        padding: "2px 7px",
                        fontSize: 7,
                        color: t.sentFg,
                        maxWidth: 44,
                        boxShadow: `0 0 4px ${p.bubble1}88`,
                      }}
                    >
                      Hey! 👋
                    </div>
                    <div
                      style={{
                        alignSelf: "flex-start",
                        background: p.bubble2,
                        borderRadius: "7px 7px 7px 2px",
                        padding: "2px 7px",
                        fontSize: 7,
                        color: t.recvFg,
                        maxWidth: 44,
                        border:
                          t.recvBorder !== "transparent"
                            ? `1px solid ${t.border}`
                            : "none",
                      }}
                    >
                      Hello!
                    </div>
                  </div>
                </div>

                {/* Theme info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      marginBottom: 5,
                    }}
                  >
                    <span style={{ fontSize: 17 }}>{t.emoji}</span>
                    <span
                      style={{
                        fontWeight: 800,
                        fontSize: 15,
                        color: active ? t.primary : theme.text,
                      }}
                    >
                      {t.name}
                    </span>
                    {active && (
                      <span
                        style={{
                          marginLeft: "auto",
                          fontSize: 10,
                          fontWeight: 700,
                          color: t.primary,
                          background: `${t.primary}22`,
                          padding: "2px 10px",
                          borderRadius: 20,
                          border: `1px solid ${t.primary}44`,
                          boxShadow: `0 0 8px ${t.primary}44`,
                        }}
                      >
                        ✓ Active
                      </span>
                    )}
                  </div>

                  {/* Color swatches */}
                  <div style={{ display: "flex", gap: 5, marginBottom: 5 }}>
                    {[
                      t.primary,
                      t.sent,
                      t.success,
                      t.danger,
                      t.warning,
                      t.bg,
                    ].map((c, i) => (
                      <div
                        key={i}
                        style={{
                          width: 13,
                          height: 13,
                          borderRadius: "50%",
                          background: c,
                          border: `1px solid ${theme.border}`,
                          boxShadow: `0 0 5px ${c}77`,
                        }}
                      />
                    ))}
                  </div>

                  <div
                    style={{
                      fontSize: 10,
                      color: active ? t.primary : theme.text3,
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {t.isDark ? "🌙 Dark" : "☀️ Light"} ·{" "}
                    {active ? "Currently active" : "Click to apply"}
                  </div>
                </div>
              </button>
            );
          })}

          {tab === "material" && Object.values(MATERIALS).map((m) => {
            const active = materialName === m.key;
            const isHovered = hovered === `m-${m.key}`;
            return (
              <button
                key={m.key}
                onClick={() => setMaterial(m.key)}
                onMouseEnter={() => setHovered(`m-${m.key}`)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  background: active ? `${theme.primary}22` : theme.surface2,
                  border: `2px solid ${active ? theme.primary : theme.border}`,
                  borderRadius: "var(--app-radius-lg)",
                  padding: "14px 16px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  textAlign: "left",
                  boxShadow: isHovered ? `0 0 10px ${theme.primaryGlow}` : "none",
                  transition: "all 0.18s ease",
                }}
              >
                <div>
                  <div style={{ color: theme.text, fontWeight: 700, fontSize: 14 }}>{m.label}</div>
                  <div style={{ color: theme.text3, fontSize: 11, marginTop: 3 }}>
                    {m.key === "solid" && "Classic flat surfaces"}
                    {m.key === "glass" && "Liquid glass with frosted depth"}
                    {m.key === "neumorphism" && "Soft extruded tactile depth"}
                    {m.key === "m3" && "Google Material Design 3 surfaces"}
                  </div>
                </div>
                <div
                  style={{
                    width: 52,
                    height: 34,
                    borderRadius: "var(--app-radius-md)",
                    background:
                      m.key === "solid"
                        ? theme.surface3
                        : m.key === "glass"
                          ? "linear-gradient(140deg, rgba(255,255,255,0.5), rgba(255,255,255,0.1) 40%, rgba(255,255,255,0.02))"
                          : m.key === "m3"
                            ? "linear-gradient(180deg, #eaddff, #d0bcff)"
                            : theme.surface2,
                    border: `1px solid ${theme.border}`,
                    boxShadow:
                      m.key === "neumorphism"
                        ? "inset 2px 2px 6px rgba(255,255,255,0.5), inset -2px -2px 6px rgba(0,0,0,0.12)"
                        : m.key === "m3"
                          ? "0 1px 2px rgba(0,0,0,0.24), 0 4px 8px rgba(0,0,0,0.18)"
                        : "none",
                  }}
                />
              </button>
            );
          })}

          {tab === "shape" && Object.values(SHAPE_STYLES).map((shape) => {
            const active = shapeName === shape.key;
            const isHovered = hovered === `s-${shape.key}`;
            return (
              <button
                key={shape.key}
                onClick={() => setShape(shape.key)}
                onMouseEnter={() => setHovered(`s-${shape.key}`)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  background: active ? `${theme.primary}22` : theme.surface2,
                  border: `2px solid ${active ? theme.primary : theme.border}`,
                  borderRadius: "var(--app-radius-lg)",
                  padding: "14px 16px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  textAlign: "left",
                  boxShadow: isHovered ? `0 0 10px ${theme.primaryGlow}` : "none",
                  transition: "all 0.18s ease",
                }}
              >
                <div>
                  <div style={{ color: theme.text, fontWeight: 700, fontSize: 14 }}>{shape.label}</div>
                  <div style={{ color: theme.text3, fontSize: 11, marginTop: 3 }}>
                    {shape.key === "sharp" && "Crisp interface corners"}
                    {shape.key === "rounded" && "Balanced modern corners"}
                    {shape.key === "soft" && "Friendly soft curves"}
                    {shape.key === "pill" && "Maximum rounded geometry"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  {[8, 12, 18].map((r, i) => (
                    <div
                      key={i}
                      style={{
                        width: 14 + i * 6,
                        height: 10 + i * 4,
                        borderRadius:
                          shape.key === "sharp"
                            ? 4
                            : shape.key === "rounded"
                              ? 8
                              : shape.key === "soft"
                                ? 12
                                : 999,
                        border: `1px solid ${theme.border}`,
                        background: theme.surface3,
                      }}
                    />
                  ))}
                </div>
              </button>
            );
          })}

          {tab === "layout" && Object.values(LAYOUT_STYLES).map((layout) => {
            const active = layoutName === layout.key;
            const isHovered = hovered === `l-${layout.key}`;
            return (
              <button
                key={layout.key}
                onClick={() => setLayout(layout.key)}
                onMouseEnter={() => setHovered(`l-${layout.key}`)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  background: active ? `${theme.primary}22` : theme.surface2,
                  border: `2px solid ${active ? theme.primary : theme.border}`,
                  borderRadius: "var(--app-radius-lg)",
                  padding: "14px 16px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  textAlign: "left",
                  boxShadow: isHovered ? `0 0 10px ${theme.primaryGlow}` : "none",
                  transition: "all 0.18s ease",
                }}
              >
                <div>
                  <div style={{ color: theme.text, fontWeight: 700, fontSize: 14 }}>{layout.label}</div>
                  <div style={{ color: theme.text3, fontSize: 11, marginTop: 3 }}>
                    {layout.key === "telegram" && "Top app bar with threaded chat emphasis"}
                    {layout.key === "modal" && "Classic modal overlays for sections"}
                    {layout.key === "sidebar" && "Compact left navigation rail for quick switching"}
                  </div>
                </div>
                <div
                  style={{
                    width: 86,
                    height: 52,
                    borderRadius: 12,
                    border: `1px solid ${theme.border}`,
                    background: theme.surface3,
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  {layout.key === "sidebar" ? (
                    <>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 20, background: `${theme.primary}33` }} />
                      <div style={{ position: "absolute", left: 22, right: 6, top: 6, height: 7, borderRadius: 4, background: theme.surface }} />
                      <div style={{ position: "absolute", left: 24, right: 8, top: 17, height: 6, borderRadius: 4, background: `${theme.primary}44` }} />
                      <div style={{ position: "absolute", left: 24, right: 8, top: 27, height: 6, borderRadius: 4, background: theme.surface }} />
                      <div style={{ position: "absolute", left: 24, right: 8, top: 37, height: 6, borderRadius: 4, background: theme.surface }} />
                    </>
                  ) : layout.key === "modal" ? (
                    <>
                      <div style={{ position: "absolute", left: 6, right: 6, top: 5, height: 8, borderRadius: 4, background: theme.surface }} />
                      <div style={{ position: "absolute", left: 10, top: 18, width: 28, height: 10, borderRadius: 8, background: `${theme.primary}66` }} />
                      <div style={{ position: "absolute", right: 10, top: 18, width: 28, height: 10, borderRadius: 8, background: `${theme.warning}66` }} />
                      <div style={{ position: "absolute", left: 10, right: 10, bottom: 8, height: 10, borderRadius: 8, background: `${theme.success}66` }} />
                    </>
                  ) : (
                    <>
                      <div style={{ position: "absolute", left: 6, right: 6, top: 5, height: 8, borderRadius: 4, background: `${theme.primary}44` }} />
                      <div style={{ position: "absolute", left: 8, right: 8, top: 18, height: 8, borderRadius: 4, background: theme.surface2 }} />
                      <div style={{ position: "absolute", left: 8, right: 8, top: 30, height: 8, borderRadius: 4, background: theme.surface2 }} />
                      <div style={{ position: "absolute", left: 8, width: 26, bottom: 7, height: 8, borderRadius: 8, background: `${theme.primary}66` }} />
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        </div>
      </div>
    </div>
  );

  if (typeof document !== "undefined" && document.body) {
    return createPortal(modal, document.body);
  }
  return modal;
};

export default ThemePicker;
