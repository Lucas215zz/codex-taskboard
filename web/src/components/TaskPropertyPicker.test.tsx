import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskPropertyPicker, type TaskPropertyOption } from "./TaskPropertyPicker";

const options: TaskPropertyOption<string>[] = [
  { value: "todo", label: "To do", icon: <span aria-hidden="true">T</span> },
  { value: "in_progress", label: "In progress", icon: <span aria-hidden="true">P</span> },
];

afterEach(cleanup);

describe("TaskPropertyPicker", () => {
  it("keeps menus inside native modal dialogs and applies the selected value", () => {
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <dialog open>
        <TaskPropertyPicker
          value="todo"
          options={options}
          open={false}
          triggerClassName="property-control"
          ariaLabel="Status"
          onOpenChange={onOpenChange}
          onChange={onChange}
        />
      </dialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);

    rerender(
      <dialog open>
        <TaskPropertyPicker
          value="todo"
          options={options}
          open
          triggerClassName="property-control"
          ariaLabel="Status"
          onOpenChange={onOpenChange}
          onChange={onChange}
        />
      </dialog>,
    );

    const menu = screen.getByRole("listbox", { name: "Status" });
    expect(menu.parentElement?.tagName).toBe("DIALOG");

    fireEvent.click(screen.getByRole("option", { name: "In progress" }));
    expect(onChange).toHaveBeenCalledWith("in_progress");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps menus outside non-modal surfaces such as task drawers", () => {
    const { container } = render(
      <aside role="dialog">
        <TaskPropertyPicker
          value="todo"
          options={options}
          open
          triggerClassName="property-control"
          ariaLabel="Status"
          onOpenChange={vi.fn()}
          onChange={vi.fn()}
        />
      </aside>,
    );

    const menu = screen.getByRole("listbox", { name: "Status" });
    expect(menu.parentElement).toBe(document.body);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});
