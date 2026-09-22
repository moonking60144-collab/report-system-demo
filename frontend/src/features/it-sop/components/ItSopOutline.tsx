import { useEffect, useState } from "react";
import type { ItSopSection } from "../../../api/itSop";

interface ItSopOutlineProps {
  sections: ItSopSection[];
}

export function ItSopOutline({ sections }: ItSopOutlineProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const idsKey = sections.map((section) => section.id).join("|");

  useEffect(() => {
    const ids = idsKey ? idsKey.split("|") : [];
    if (ids.length === 0) return;
    // 視窗上緣往下約 15% 處當判定帶，落在帶內最上面的段落即為目前段落
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "-15% 0px -75% 0px", threshold: 0 }
    );
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [idsKey]);

  // 尚未捲動(null)或舊 active 段落被刪 → 退回第一段；render 時 derive，不在 effect 同步 setState
  const resolvedActiveId =
    activeId && sections.some((section) => section.id === activeId)
      ? activeId
      : sections[0]?.id ?? null;

  return (
    <aside className="it-sop_outlinePanel" aria-label="文件大綱">
      <div className="it-sop_outlineTitle">文件大綱</div>
      <nav className="it-sop_outlineList">
        {sections.map((section, index) => (
          <a
            className={`it-sop_outlineLink${section.id === resolvedActiveId ? " is-active" : ""}`}
            href={`#${section.id}`}
            key={section.id}
            aria-current={section.id === resolvedActiveId ? "true" : undefined}
            onClick={(event) => {
              event.preventDefault();
              document
                .getElementById(section.id)
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
              setActiveId(section.id);
            }}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {section.title || "未命名段落"}
          </a>
        ))}
      </nav>
    </aside>
  );
}
