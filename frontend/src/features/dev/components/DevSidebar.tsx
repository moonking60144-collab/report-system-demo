import { useLayoutEffect, useRef } from "react";
import {
  AudioOutlined,
  ApartmentOutlined,
  BranchesOutlined,
  ClusterOutlined,
  CodeOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { NavLink, useLocation } from "react-router-dom";
import { DEV_TOOLS, DEV_GROUP_ORDER, DEV_GROUP_META } from "../config/devTools";

/**
 * 左側常駐導覽：主要工具／資料／分析／設定，點一個右側換內容。
 * 選中標示用一條「滑動指示器」——量 active 項目的位置/高度，CSS transition 讓它平滑滑過去，
 * 切換時的移動感更順，而不是每個項目各自瞬間亮/暗。
 */
export function DevSidebar({
  collapsed,
  onToggleCollapsed,
  username,
  onLogout,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  username: string;
  onLogout: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const collapseRequestedByPointerRef = useRef(false);
  const { pathname } = useLocation();

  // 量 active 項目，直接寫進指示器的 style（用 ref 不經 state，避免 effect 內 setState 的串聯 render）
  useLayoutEffect(() => {
    const root = ref.current;
    const ind = indicatorRef.current;
    if (!root || !ind) return;

    let raf = 0;
    let timer = 0;
    const measure = () => {
      const active = root.querySelector<HTMLElement>(".is-active");
      if (!active) {
        ind.style.opacity = "0";
        return;
      }
      ind.style.opacity = "1";
      ind.style.transform = `translateY(${active.offsetTop}px)`;
      ind.style.height = `${active.offsetHeight}px`;
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    measure();
    scheduleMeasure();
    timer = window.setTimeout(measure, 260);
    root.addEventListener("transitionend", scheduleMeasure);
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(root);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      root.removeEventListener("transitionend", scheduleMeasure);
      resizeObserver.disconnect();
    };
  }, [collapsed, pathname]);

  function handleCollapsePointerDown() {
    collapseRequestedByPointerRef.current = true;
  }

  function handleCollapseClick() {
    const shouldBlurAfterToggle = collapseRequestedByPointerRef.current;
    collapseRequestedByPointerRef.current = false;
    onToggleCollapsed();
    if (shouldBlurAfterToggle) {
      requestAnimationFrame(() => collapseButtonRef.current?.blur());
    }
  }

  return (
    <aside
      className={`dev-sidebar${collapsed ? " is-collapsed" : ""}`}
      ref={ref}
      aria-label="開發者模式導覽"
    >
      <span className="dev-sidebar__indicator" aria-hidden ref={indicatorRef} />

      <div className="dev-sidebar__top">
        <NavLink
          to="/dev"
          end
          viewTransition
          title={collapsed ? "Dev 模式" : undefined}
          className={({ isActive }) => `dev-sidebar__home${isActive ? " is-active" : ""}`}
        >
          <span className="dev-sidebar__nav-icon" aria-hidden>
            <DashboardOutlined />
          </span>
          <span className="dev-sidebar__label">Dev 模式</span>
          <span className="dev-sidebar__short" aria-hidden>
            Dev
          </span>
        </NavLink>
        <button
          type="button"
          ref={collapseButtonRef}
          className="dev-sidebar__collapse"
          onPointerDown={handleCollapsePointerDown}
          onClick={handleCollapseClick}
          aria-label={collapsed ? "展開左側導覽" : "收合左側導覽"}
          title={collapsed ? "展開左側導覽" : "收合左側導覽"}
        >
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </button>
      </div>
      {DEV_GROUP_ORDER.map((g) => (
        <div key={g} className="dev-sidebar__group">
          <span className="dev-sidebar__group-title">{DEV_GROUP_META[g].label}</span>
          {DEV_TOOLS.filter((tool) => tool.group === g).map((tool) => (
            <NavLink
              key={tool.id}
              to={tool.path}
              viewTransition
              title={collapsed ? tool.label : undefined}
              className={({ isActive }) =>
                `dev-sidebar__item dev-sidebar__item--${g}${isActive ? " is-active" : ""}`
              }
            >
              <span className="dev-sidebar__nav-icon" aria-hidden>
                {devToolIcon(tool.id)}
              </span>
              <span className="dev-sidebar__label">{tool.label}</span>
              <span className="dev-sidebar__short" aria-hidden>
                {shortSidebarLabel(tool.label)}
              </span>
            </NavLink>
          ))}
        </div>
      ))}
      <div className="dev-sidebar__account">
        <span className="dev-sidebar__avatar" aria-hidden>
          {(username || "D").slice(0, 1).toUpperCase()}
        </span>
        <div className="dev-sidebar__account-text">
          <span>開發者</span>
          <code>{username || "unknown"}</code>
        </div>
        <button type="button" onClick={onLogout}>
          登出
        </button>
      </div>
    </aside>
  );
}

function devToolIcon(id: string) {
  switch (id) {
    case "search":
      return <SearchOutlined />;
    case "deps":
      return <BranchesOutlined />;
    case "workflow":
      return <CodeOutlined />;
    case "definitions":
      return <FileSearchOutlined />;
    case "ai":
      return <RobotOutlined />;
    case "it-duty":
      return <TableOutlined />;
    case "it-sop":
      return <FileTextOutlined />;
    case "meeting-libraries":
      return <AudioOutlined />;
    case "entities":
      return <DatabaseOutlined />;
    case "matrix":
      return <ClusterOutlined />;
    case "normalize":
      return <DeploymentUnitOutlined />;
    case "settings":
      return <SettingOutlined />;
    default:
      return <ApartmentOutlined />;
  }
}

function shortSidebarLabel(label: string): string {
  if (label.startsWith("JS")) return "JS";
  if (label.startsWith("NUI")) return "NUI";
  return Array.from(label).slice(0, 2).join("");
}
