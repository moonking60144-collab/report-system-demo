import { DownOutlined, UpOutlined } from "@ant-design/icons";

export function DefinitionsExplorerScrollButtons({
  scrollHint,
  scrollShortcutClassName,
  scrollShortcutExpanded,
  onScrollShortcutHoverStart,
  onScrollShortcutHoverEnd,
  onScrollShortcut,
}: {
  scrollHint: "up" | "down";
  scrollShortcutClassName: string;
  scrollShortcutExpanded: boolean;
  onScrollShortcutHoverStart: () => void;
  onScrollShortcutHoverEnd: () => void;
  onScrollShortcut: (direction: "up" | "down") => void;
}) {
  return (
    <div
      className={scrollShortcutClassName}
      onMouseEnter={onScrollShortcutHoverStart}
      onMouseLeave={onScrollShortcutHoverEnd}
    >
      <button
        type="button"
        className={`ragic-defs__scroll-shortcut ragic-defs__scroll-shortcut--${scrollHint}`}
        onClick={() => onScrollShortcut(scrollHint)}
        aria-label={scrollHint === "up" ? "回到頂部" : "前往底部"}
        title={scrollHint === "up" ? "回到頂部" : "前往底部"}
      >
        {scrollHint === "up" ? <UpOutlined /> : <DownOutlined />}
      </button>
      {scrollShortcutExpanded ? (
        <button
          type="button"
          className={`ragic-defs__scroll-shortcut ragic-defs__scroll-shortcut--secondary ragic-defs__scroll-shortcut--${
            scrollHint === "up" ? "down" : "up"
          }`}
          onClick={() => onScrollShortcut(scrollHint === "up" ? "down" : "up")}
          aria-label={scrollHint === "up" ? "前往底部" : "回到頂部"}
          title={scrollHint === "up" ? "前往底部" : "回到頂部"}
        >
          {scrollHint === "up" ? <DownOutlined /> : <UpOutlined />}
        </button>
      ) : null}
    </div>
  );
}
