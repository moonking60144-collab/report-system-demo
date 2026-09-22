import {
  AudioOutlined,
  CodeOutlined,
  DownOutlined,
  PartitionOutlined,
} from "@ant-design/icons";
import { Dropdown, type MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import "../styles/subsystem-menu.css";

interface SubsystemMenuProps {
  className?: string;
  disabled?: boolean;
}

export function SubsystemMenu({ className = "", disabled = false }: SubsystemMenuProps) {
  const { t } = useTranslation("common");
  const location = useLocation();
  const navigate = useNavigate();
  const selectedKey = location.pathname.startsWith("/dev")
    ? "developer"
    : location.pathname.startsWith("/meetings")
      ? "meeting-minutes"
      : undefined;

  const items: MenuProps["items"] = [
    {
      key: "developer",
      icon: <CodeOutlined />,
      label: t("subsystems.developerMode"),
      onClick: () => navigate("/dev"),
    },
    {
      key: "meeting-minutes",
      icon: <AudioOutlined />,
      label: t("subsystems.meetingMinutes"),
      onClick: () => navigate("/meetings/audio-check"),
    },
  ];

  return (
    <Dropdown
      menu={{ items, selectedKeys: selectedKey ? [selectedKey] : [] }}
      trigger={["click"]}
      placement="bottomRight"
      overlayClassName="subsystem-menu-popup"
      disabled={disabled}
    >
      <button
        type="button"
        className={`subsystem-menu-trigger ${className}`.trim()}
        aria-label={t("subsystems.openMenu")}
        aria-haspopup="menu"
        disabled={disabled}
      >
        <PartitionOutlined aria-hidden="true" />
        <span>{t("subsystems.label")}</span>
        <DownOutlined className="subsystem-menu-trigger__caret" aria-hidden="true" />
      </button>
    </Dropdown>
  );
}
