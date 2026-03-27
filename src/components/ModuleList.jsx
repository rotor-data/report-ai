import { useEffect, useMemo, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import ModuleCard from "./ModuleCard";

function SortableModuleCard({ module, onChange, onDelete, draggable }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: module.id,
    disabled: !draggable,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <ModuleCard
        module={module}
        onChange={onChange}
        onDelete={onDelete}
        dragProps={draggable ? { ...attributes, ...listeners } : null}
      />
    </div>
  );
}

function keepCoverAndBackCoverLocked(plan) {
  const cover = plan.find((m) => m.module_type === "cover");
  const back = plan.find((m) => m.module_type === "back_cover");
  const middle = plan.filter((m) => m.module_type !== "cover" && m.module_type !== "back_cover");

  const result = [];
  if (cover) result.push(cover);
  result.push(...middle);
  if (back) result.push(back);

  return result.map((m, idx) => ({ ...m, order: idx + 1 }));
}

export default function ModuleList({ modules, onSave }) {
  const [draft, setDraft] = useState(modules);

  useEffect(() => {
    setDraft(modules);
  }, [modules]);

  const sensors = useSensors(useSensor(PointerSensor));
  const ids = useMemo(() => draft.map((m) => m.id), [draft]);

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;

    const activeIndex = draft.findIndex((m) => m.id === active.id);
    const overIndex = draft.findIndex((m) => m.id === over.id);
    const activeItem = draft[activeIndex];
    const overItem = draft[overIndex];

    if (!activeItem || !overItem) return;
    if (activeItem.module_type === "cover" || activeItem.module_type === "back_cover") return;
    if (overItem.module_type === "cover" || overItem.module_type === "back_cover") return;

    const moved = arrayMove(draft, activeIndex, overIndex);
    setDraft(keepCoverAndBackCoverLocked(moved));
  };

  return (
    <div className="panel stack-lg">
      <div className="row-between">
        <h3>Moduler</h3>
        <button className="btn" onClick={() => onSave(keepCoverAndBackCoverLocked(draft))}>
          Spara moduler
        </button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          {draft.map((module, index) => {
            const draggable = module.module_type !== "cover" && module.module_type !== "back_cover";
            return (
              <SortableModuleCard
                key={module.id ?? `${module.module_type}-${index}`}
                module={module}
                draggable={draggable}
                onChange={(next) => {
                  const copy = [...draft];
                  copy[index] = next;
                  setDraft(copy);
                }}
                onDelete={() => {
                  setDraft(draft.filter((m, i) => i !== index));
                }}
              />
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}
