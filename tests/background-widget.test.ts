import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setupBackgroundWidget } from "../background-widget.ts";

describe("setupBackgroundWidget", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("releases local resources before tolerating stale ctx widget removal", () => {
		vi.useFakeTimers();
		const events: string[] = [];
		const unsubscribe = vi.fn();
		const ctx = {
			hasUI: true,
			ui: {
				setWidget: vi.fn((name: string, value: unknown) => {
					expect(name).toBe("bg-sessions");
					events.push(value === undefined ? "set:cleanup" : "set:register");
					if (value === undefined) throw new Error("stale ctx");
				}),
			},
		};
		const sessionManager = {
			onChange: vi.fn(() => () => {
				events.push("unsubscribe");
				unsubscribe();
			}),
			list: vi.fn(() => [{
				id: "bg-1",
				command: "pi \"work\"",
				startedAt: new Date("2026-08-26T00:00:00.000Z"),
				session: { exited: false },
			}]),
		} satisfies Parameters<typeof setupBackgroundWidget>[1];

		const cleanup = setupBackgroundWidget(ctx, sessionManager);
		expect(cleanup).toBeTypeOf("function");
		expect(vi.getTimerCount()).toBe(1);

		expect(() => cleanup?.()).not.toThrow();
		expect(events).toEqual(["set:register", "unsubscribe", "set:cleanup"]);
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(2);
	});

	it("caps its height, hides completed sessions, and never wraps rows", () => {
		const setWidget = vi.fn();
		const ctx = { hasUI: true, ui: { setWidget } };
		const sessions = Array.from({ length: 10 }, (_, index) => ({
			id: `job-${index}`,
			command: `run a deliberately long command for background job ${index}`,
			reason: `background task ${index}`,
			startedAt: new Date(),
			session: { exited: index < 5 },
		}));
		const sessionManager = {
			onChange: vi.fn(() => () => {}),
			list: vi.fn(() => sessions),
		} satisfies Parameters<typeof setupBackgroundWidget>[1];

		setupBackgroundWidget(ctx, sessionManager);
		const factory = setWidget.mock.calls[0][1] as (tui: unknown, theme: unknown) => { render(width: number): string[] };
		const widget = factory(
			{ terminal: { columns: 44, rows: 24 }, requestRender() {} },
			{ fg: (_color: string, text: string) => text },
		);
		const lines = widget.render(44);

		expect(lines).toHaveLength(4);
		expect(lines.slice(0, 3).every((line) => line.includes("job-5") || line.includes("job-6") || line.includes("job-7"))).toBe(true);
		expect(lines[3]).toContain("+2 more running");
		expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
	});

	it("disappears when every background session has completed", () => {
		const setWidget = vi.fn();
		const ctx = { hasUI: true, ui: { setWidget } };
		const sessionManager = {
			onChange: vi.fn(() => () => {}),
			list: vi.fn(() => [{
				id: "done",
				command: "finished command",
				startedAt: new Date(),
				session: { exited: true },
			}]),
		} satisfies Parameters<typeof setupBackgroundWidget>[1];

		setupBackgroundWidget(ctx, sessionManager);
		const factory = setWidget.mock.calls[0][1] as (tui: unknown, theme: unknown) => { render(width: number): string[] };
		const widget = factory(
			{ terminal: { columns: 80, rows: 24 }, requestRender() {} },
			{ fg: (_color: string, text: string) => text },
		);

		expect(widget.render(80)).toEqual([]);
	});
});
