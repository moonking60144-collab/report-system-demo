import { useEffect, useRef, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import {
  createItDutyMember,
  deleteItDutyMember,
  reorderItDutyMembers,
  updateItDutyMember,
  type ItDutyMember,
} from "../../../api/itDuty";

interface Props {
  open: boolean;
  members: ItDutyMember[];
  onClose: () => void;
  onChanged: () => void;
}

export function ItDutyMemberManagerModal({ open, members, onClose, onChanged }: Props) {
  const { t } = useTranslation("itDuty");
  const [working, setWorking] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [localOrder, setLocalOrder] = useState<ItDutyMember[]>(members);
  const [orderDirty, setOrderDirty] = useState(false);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const lastDragOver = useRef(0);

  useEffect(() => {
    if (open) {
      setLocalOrder(members);
      setOrderDirty(false);
      setEditingId(null);
      setEditingName("");
      setNewName("");
      setDraggingId(null);
      setDragOverId(null);
    }
  }, [open, members]);

  async function handleAdd() {
    const name = newName.trim();
    if (!name || working) return;
    setWorking(true);
    try {
      await createItDutyMember({ name });
      void message.success(t("memberManager.addSuccess", { name }));
      setNewName("");
      onChanged();
    } catch (error) {
      console.error("[itDuty] add member failed", error);
      void message.error(t("errors.saveFailed"));
    } finally {
      setWorking(false);
    }
  }

  async function handleRename(id: number, name: string) {
    if (!name.trim() || working) return;
    setWorking(true);
    try {
      await updateItDutyMember(id, { name: name.trim() });
      void message.success(t("memberManager.updateSuccess", { name: name.trim() }));
      setEditingId(null);
      setEditingName("");
      onChanged();
    } catch (error) {
      console.error("[itDuty] rename member failed", error);
      void message.error(t("errors.saveFailed"));
    } finally {
      setWorking(false);
    }
  }

  async function handleToggleActive(member: ItDutyMember) {
    if (working) return;
    setWorking(true);
    try {
      await updateItDutyMember(member.id, { active: !member.active });
      void message.success(t("memberManager.updateSuccess", { name: member.name }));
      onChanged();
    } catch (error) {
      console.error("[itDuty] toggle active failed", error);
      void message.error(t("errors.saveFailed"));
    } finally {
      setWorking(false);
    }
  }

  function handleDelete(member: ItDutyMember) {
    Modal.confirm({
      title: t("memberManager.confirmDeleteTitle"),
      content: t("memberManager.confirmDelete", { name: member.name }),
      okText: t("memberManager.deleteButton"),
      okButtonProps: { danger: true },
      cancelText: t("memberManager.cancel"),
      onOk: async () => {
        try {
          await deleteItDutyMember(member.id);
          void message.success(t("memberManager.deleteSuccess", { name: member.name }));
          onChanged();
        } catch (error) {
          console.error("[itDuty] delete member failed", error);
          void message.error(t("errors.deleteFailed"));
        }
      },
    });
  }

  function moveLocal(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= localOrder.length) return;
    const next = [...localOrder];
    const swap = next[target];
    const cur = next[index];
    if (!swap || !cur) return;
    next[index] = swap;
    next[target] = cur;
    setLocalOrder(next);
    setOrderDirty(true);
  }

  function reorderByIds(sourceId: number, targetId: number) {
    if (sourceId === targetId) return;
    const fromIdx = localOrder.findIndex((m) => m.id === sourceId);
    const toIdx = localOrder.findIndex((m) => m.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...localOrder];
    const [moved] = next.splice(fromIdx, 1);
    if (!moved) return;
    next.splice(toIdx, 0, moved);
    setLocalOrder(next);
    setOrderDirty(true);
  }

  async function handleSaveOrder() {
    if (!orderDirty || working) return;
    setWorking(true);
    try {
      await reorderItDutyMembers(localOrder.map((m) => m.id));
      void message.success(t("memberManager.saveSuccess"));
      setOrderDirty(false);
      onChanged();
    } catch (error) {
      console.error("[itDuty] reorder failed", error);
      void message.error(t("errors.saveFailed"));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("memberManager.title")}
      onCancel={onClose}
      footer={null}
      width={520}
    >
      <div className="itduty-member-manager">
        <div className="itduty-member-manager__add-row">
          <input
            type="text"
            value={newName}
            placeholder={t("memberManager.addPlaceholder")}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void handleAdd();
              }
            }}
            disabled={working}
            className="itduty-input"
          />
          <button
            type="button"
            className="itduty-btn itduty-btn--primary"
            onClick={() => void handleAdd()}
            disabled={!newName.trim() || working}
          >
            {t("memberManager.addButton")}
          </button>
        </div>

        <ul className="itduty-member-manager__list">
          {localOrder.map((member, index) => {
            const isEditing = editingId === member.id;
            const isDragging = draggingId === member.id;
            const isDropTarget = dragOverId === member.id && draggingId !== member.id;
            return (
              <li
                key={member.id}
                draggable={!working && !isEditing}
                onDragStart={(e) => {
                  setDraggingId(member.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(member.id));
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDragOverId(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  // throttle setState：避免每 frame 重新 render 拖到爆
                  const now = performance.now();
                  if (now - lastDragOver.current < 30) return;
                  lastDragOver.current = now;
                  if (dragOverId !== member.id) setDragOverId(member.id);
                }}
                onDragLeave={() => {
                  if (dragOverId === member.id) setDragOverId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const sourceIdRaw = e.dataTransfer.getData("text/plain");
                  const sourceId = Number(sourceIdRaw);
                  if (Number.isFinite(sourceId) && sourceId > 0) {
                    reorderByIds(sourceId, member.id);
                  }
                  setDraggingId(null);
                  setDragOverId(null);
                }}
                className={[
                  "itduty-member-manager__item",
                  member.active ? "" : "itduty-member-manager__item--inactive",
                  isDragging ? "itduty-member-manager__item--dragging" : "",
                  isDropTarget ? "itduty-member-manager__item--drop-target" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span
                  className="itduty-member-manager__drag-handle"
                  aria-hidden="true"
                  title={t("memberManager.dragHint")}
                >
                  ⋮⋮
                </span>
                <div className="itduty-member-manager__order">
                  <button
                    type="button"
                    className="itduty-btn itduty-btn--ghost"
                    onClick={() => moveLocal(index, -1)}
                    disabled={index === 0 || working}
                    title={t("memberManager.moveUp")}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="itduty-btn itduty-btn--ghost"
                    onClick={() => moveLocal(index, 1)}
                    disabled={index === localOrder.length - 1 || working}
                    title={t("memberManager.moveDown")}
                  >
                    ↓
                  </button>
                </div>
                <div className="itduty-member-manager__name">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingName}
                      autoFocus
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void handleRename(member.id, editingName);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                          setEditingName("");
                        }
                      }}
                      onBlur={() => void handleRename(member.id, editingName)}
                      className="itduty-input"
                      disabled={working}
                    />
                  ) : (
                    <button
                      type="button"
                      className="itduty-member-manager__name-btn"
                      onClick={() => {
                        setEditingId(member.id);
                        setEditingName(member.name);
                      }}
                      title={t("memberManager.rename")}
                    >
                      {member.name}
                      {!member.active ? (
                        <span className="itduty-member-manager__inactive-tag">
                          {t("memberManager.inactiveTag")}
                        </span>
                      ) : null}
                    </button>
                  )}
                </div>
                <div className="itduty-member-manager__actions">
                  <button
                    type="button"
                    className="itduty-btn"
                    onClick={() => void handleToggleActive(member)}
                    disabled={working}
                  >
                    {member.active
                      ? t("memberManager.deactivate")
                      : t("memberManager.activate")}
                  </button>
                  <button
                    type="button"
                    className="itduty-btn itduty-btn--danger"
                    onClick={() => handleDelete(member)}
                    disabled={working}
                  >
                    {t("memberManager.deleteButton")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="itduty-member-manager__footer">
          <button
            type="button"
            className="itduty-btn itduty-btn--primary"
            onClick={() => void handleSaveOrder()}
            disabled={!orderDirty || working}
          >
            {t("memberManager.saveOrder")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
