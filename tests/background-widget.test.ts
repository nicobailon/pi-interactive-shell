import { afterEach, describe, expect, it, vi } from "vitest";
import { setupBackgroundWidget } from "../background-widget.ts";

describe("setupBackgroundWidget cleanup", () => {
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
});
