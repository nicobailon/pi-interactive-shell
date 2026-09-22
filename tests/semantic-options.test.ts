import { describe, expect, it } from "vitest";
import { extractSemanticOptions } from "../semantic-options.ts";

const CLAUDE_ASK_USER_VIEWPORT = [
	" ▐▛███▛█   Claude Code v2.1.275",
	"▝▜██████▀  Fable 5.1 with high effort · Claude Max",
	"  ▝▝ ▝▝    ~/.pi/agent/worktrees/pi-interactive-shell/jev-dynamic-menu-selection",
	"❯ You are running an interactive acceptance test. You MUST use AskUserQuestion exactly once before giving any result.   ",
	"  Ask: Which release channel should this test use? Provide exactly these three fixed options in this order: Alpha —     ",
	"  experimental channel Beta — stable channel Gamma — legacy channel Do not infer or select the answer yourself. After   ",
	"  the answer, respond with CHOICE_RESULT: followed by the selected label. Do nothing else.                              ",
	"⏺ I'll ask which release channel this acceptance test should use.",
	"────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
	" ☐ Channel ",
	"Which release channel should this test use?",
	"❯ 1. Alpha",
	"     experimental channel",
	"  2. Beta",
	"     stable channel",
	"  3. Gamma",
	"     legacy channel",
	"  4. Type something.",
	"────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
	"  5. Chat about this",
	"Enter to select · ↑/↓ to navigate · Esc to cancel",
];

describe("semantic option extraction", () => {
	it("never downgrades multi-select evidence into an ordinary menu", () => {
		expect(extractSemanticOptions(["Choose:", "❯ [x] Alpha", "  [ ] Beta", "↑ ↓ navigate • space select • ⏎ submit"])).toEqual([]);
		expect(extractSemanticOptions(["Choose:", "❯ [x] Alpha", "  malformed Beta", "↑/↓ move • enter to select"])).toEqual([]);
		expect(extractSemanticOptions(["Choose:", "❯ Alpha", "  Beta", "↑ ↓ navigate • space select • ⏎ submit"])).toEqual([]);
		expect(extractSemanticOptions(["Choose:", "❯◯ Alpha", " ◉ Beta", "↑↓ navigate • space select • a all • i invert • ⏎ submit"])).toEqual([]);
	});
	it("binds sequential numbered and lettered choices to their exact visible selector", () => {
		const numbered = extractSemanticOptions(["Choose a color:", "1. Red", "2. Blue"]);
		expect(numbered).toEqual([
			{ id: "number_1", label: "Red", input: { kind: "text", text: "1", submit: true, bytes: "1\r" }, operation: { kind: "dynamic-terminal-choice" } },
			{ id: "number_2", label: "Blue", input: { kind: "text", text: "2", submit: true, bytes: "2\r" }, operation: { kind: "dynamic-terminal-choice" } },
		]);
		const letters = extractSemanticOptions(["[A] Alpha", "[B] Beta"]);
		expect(letters.map(({ id, input }) => ({ id, input }))).toEqual([
			{ id: "letter_a", input: { kind: "text", text: "A", submit: true, bytes: "A\r" } },
			{ id: "letter_b", input: { kind: "text", text: "B", submit: true, bytes: "B\r" } },
		]);
	});

	it("maps a single visibly selected menu to bounded navigation keys and bytes", () => {
		const options = extractSemanticOptions(["Choose:", "    First", "  ❯ Second", "    Third", "↑/↓ move • enter to select"]);
		expect(options).toEqual([
			{ id: "menu_1", label: "First", input: { kind: "keys", keys: ["up", "enter"], bytes: "\x1b[A\r" }, operation: { kind: "dynamic-terminal-choice" } },
			{ id: "menu_2", label: "Second", input: { kind: "keys", keys: ["enter"], bytes: "\r" }, operation: { kind: "dynamic-terminal-choice" } },
			{ id: "menu_3", label: "Third", input: { kind: "keys", keys: ["down", "enter"], bytes: "\x1b[B\r" }, operation: { kind: "dynamic-terminal-choice" } },
		]);
		expect(Object.isFrozen(options)).toBe(true);
		expect(Object.isFrozen(options[0])).toBe(true);
		expect(Object.isFrozen(options[0]!.input)).toBe(true);
		expect(Object.isFrozen(options[0]!.input.kind === "keys" ? options[0]!.input.keys : [])).toBe(true);
	});

	it.each([
		[1, ["\r", "\x1b[B\r", "\x1b[B\x1b[B\r"], ["enter", "down", "down"]],
		[2, ["\x1b[A\r", "\r", "\x1b[B\r"], ["up", "enter", "down"]],
		[3, ["\x1b[A\x1b[A\r", "\x1b[A\r", "\r"], ["up", "up", "enter"]],
	] as const)("extracts wrapped fixed options at exact positions when menu position %s is selected", (selected, bytes, directions) => {
		const viewport = [
			"Which rollout should be used?",
			`${selected === 1 ? "❯" : " "} 1. Stable rollout`,
			"     Uses the established release path.",
			`${selected === 2 ? "❯" : " "} 2. Canary rollout`,
			"     Sends the release to a small cohort first.",
			`${selected === 3 ? "❯" : " "} 3. Defer rollout`,
			"     Leaves the current release unchanged.",
			"  4. Type your own answer",
			"     Enter a response:",
			"  5. Chat about this",
			"Enter to select · ↑/↓ to navigate · Esc to cancel",
		];
		const options = extractSemanticOptions(viewport);
		expect(options.map(({ id, input }) => ({ id, bytes: input.bytes }))).toEqual([
			{ id: "menu_1", bytes: bytes[0] }, { id: "menu_2", bytes: bytes[1] }, { id: "menu_3", bytes: bytes[2] },
		]);
		expect(options.map((option) => option.input.kind === "keys" ? option.input.keys[0] : "text")).toEqual(directions);
		expect(options.map((option) => option.label)).toEqual([
			"Stable rollout Uses the established release path.",
			"Canary rollout Sends the release to a small cohort first.",
			"Defer rollout Leaves the current release unchanged.",
		]);
	});

	it("keeps unsupported sibling positions in exact navigation distance without making them executable", () => {
		const options = extractSemanticOptions([
			"Pick a route:", "❯ 1. North", "     Uses the ridge.",
			"  2. Type your own answer", "     Enter a response:",
			"  3. South", "     Uses the valley.", "  4. East", "     Uses the road.",
			"↑/↓ navigate · Enter to choose · Esc to cancel",
		]);
		expect(options.map(({ id, input }) => ({ id, bytes: input.bytes }))).toEqual([
			{ id: "menu_1", bytes: "\r" },
			{ id: "menu_3", bytes: "\x1b[B\x1b[B\r" },
			{ id: "menu_4", bytes: "\x1b[B\x1b[B\x1b[B\r" },
		]);
	});

	it("extracts the exact live AskUserQuestion viewport without stale whole-screen poisoning", () => {
		const options = extractSemanticOptions(CLAUDE_ASK_USER_VIEWPORT);
		expect(options.map(({ id, input }) => ({ id, bytes: input.bytes }))).toEqual([
			{ id: "menu_1", bytes: "\r" },
			{ id: "menu_2", bytes: "\x1b[B\r" },
			{ id: "menu_3", bytes: "\x1b[B\x1b[B\r" },
		]);
		expect(options.map((option) => option.id)).not.toEqual(expect.arrayContaining(["menu_4", "menu_5"]));
	});

	it("rejects the reviewer's exact two-menu ambiguity before one footer", () => {
		expect(extractSemanticOptions([
			"❯ 1. Old A", "  2. Old B", "❯ 1. Live A", "  2. Live B", "↑/↓ navigate · Enter to choose",
		])).toEqual([]);
	});

	it.each([
		["earlier plain sequence", ["  1. Old A", "  2. Old B", "❯ 1. Live A", "  2. Live B", "↑/↓ navigate · Enter to choose"]],
		["duplicate first position", ["❯ 1. Live A", "  1. Duplicate A", "  2. Live B", "↑/↓ navigate · Enter to choose"]],
	])("rejects numbered ambiguity from %s", (_name, viewport) => {
		expect(extractSemanticOptions(viewport)).toEqual([]);
	});

	it("rejects the reviewer's exact multi-line adjacent secret header", () => {
		expect(extractSemanticOptions([
			"Password required", "Which route?", "❯ 1. Alpha", "  2. Beta", "↑/↓ navigate · Enter to choose",
		])).toEqual([]);
	});

	it.each([
		["secret", "Password required"],
		["lifecycle", "Exit process"],
		["shell", "sudo deploy"],
	] as const)("checks %s content across a multi-line adjacent header", (_name, unsafe) => {
		expect(extractSemanticOptions([
			unsafe, "Additional question context", "More question context", "Which route?",
			"❯ 1. Alpha", "  2. Beta", "↑/↓ navigate · Enter to choose",
		])).toEqual([]);
	});

	it.each([
		["secret", "Password required", "───"],
		["shell", "sudo deploy", "───"],
		["ambiguous prompt", "Enter a response:", "───"],
		["secret behind long chrome", "Password required", "────────────────────────────────────────────────────────────────"],
		["shell behind long chrome", "sudo deploy", "────────────────────────────────────────────────────────────────"],
		["ambiguous prompt behind long chrome", "Enter a response:", "────────────────────────────────────────────────────────────────"],
	] as const)("does not trust visual separator chrome to hide adjacent %s content", (_name, unsafe, separator) => {
		expect(extractSemanticOptions([
			unsafe, separator, "Which route?", "❯ 1. Alpha", "  2. Beta", "↑/↓ navigate · Enter to choose",
		])).toEqual([]);
	});

	it("does not let stale unsafe content beyond the bounded header region poison a coherent menu", () => {
		expect(extractSemanticOptions([
			"old shell output", "stale one", "stale two", "stale three", "stale four", "Which route?",
			"❯ 1. Alpha", "  2. Beta", "↑/↓ navigate · Enter to choose",
		]).map((option) => option.id)).toEqual(["menu_1", "menu_2"]);
	});

	it.each([
		["immediate secret", (lines: string[]) => lines.splice(11, 0, "Password required")],
		["immediate lifecycle text", (lines: string[]) => lines.splice(11, 0, "Exit process")],
		["immediate shell text", (lines: string[]) => lines.splice(11, 0, "sudo deploy")],
		["immediate ambiguous prompt", (lines: string[]) => lines.splice(11, 0, "Enter a response:")],
		["unsafe unsupported row", (lines: string[]) => { lines[17] = "  4. Type password."; }],
		["arbitrary intervening text", (lines: string[]) => { lines[18] = "not visual chrome"; }],
		["text after a visual separator", (lines: string[]) => lines.splice(19, 0, "     unrelated text")],
		["ambiguous duplicate separator", (lines: string[]) => lines.splice(19, 0, lines[18]!)],
		["duplicate selected marker", (lines: string[]) => { lines[13] = "❯ 2. Beta"; }],
		["duplicate position", (lines: string[]) => { lines[19] = "  4. Chat about this"; }],
		["missing position", (lines: string[]) => { lines[19] = "  6. Chat about this"; }],
	] as Array<[string, (lines: string[]) => unknown]>)("fails the live menu closed for %s", (_name, mutate) => {
		const viewport = [...CLAUDE_ASK_USER_VIEWPORT];
		mutate(viewport);
		expect(extractSemanticOptions(viewport)).toEqual([]);
	});

	it("supports a generic numbered navigable menu without product-specific labels", () => {
		expect(extractSemanticOptions([
			"Pick a transport:", "❯ 1. Bicycle", "     Human powered.", "  2. Train", "     Runs on rails.",
			"↑/↓ navigate · Enter to choose", "Esc to cancel",
		]).map(({ id, input }) => ({ id, bytes: input.bytes }))).toEqual([
			{ id: "menu_1", bytes: "\r" }, { id: "menu_2", bytes: "\x1b[B\r" },
		]);
	});

	it.each([
		["exact", "Yes", "No"],
		["comma-qualified", "Yes, proceed", "No, go back"],
	])("classifies %s visible Yes/No labels as confirmation without changing selector bindings", (_name, yes, no) => {
		expect(extractSemanticOptions(["Delete production database?", `1. ${yes}`, `2. ${no}`])).toEqual([
			{ id: "number_1", label: yes, input: { kind: "text", text: "1", submit: true, bytes: "1\r" }, operation: { kind: "dynamic-terminal-confirmation" } },
			{ id: "number_2", label: no, input: { kind: "text", text: "2", submit: true, bytes: "2\r" }, operation: { kind: "dynamic-terminal-confirmation" } },
		]);
	});

	it("keeps an ordinary binary selection classified as a choice", () => {
		expect(extractSemanticOptions(["Choose a database:", "1. PostgreSQL", "2. SQLite"]).map((option) => option.operation)).toEqual([
			{ kind: "dynamic-terminal-choice" }, { kind: "dynamic-terminal-choice" },
		]);
	});

	it.each([
		["yes", "Continue? (Y/n)"],
		["no", "Proceed with the safe operation? (y/N)"],
	] as const)("extracts an inline confirmation whose uppercase default is %s without assuming Enter", (_default, prompt) => {
		const options = extractSemanticOptions(["Status: ready", prompt, ""]);
		expect(options).toEqual([
			{
				id: "inline_yes", label: "Yes", operation: { kind: "dynamic-terminal-confirmation" },
				input: { kind: "inline-confirmation", response: "y", bytes: "y", prompt, promptIndex: 1, viewport: ["Status: ready", prompt, ""] },
			},
			{
				id: "inline_no", label: "No", operation: { kind: "dynamic-terminal-confirmation" },
				input: { kind: "inline-confirmation", response: "n", bytes: "n", prompt, promptIndex: 1, viewport: ["Status: ready", prompt, ""] },
			},
		]);
		expect(options.every((option) => option.input.bytes.length === 1 && !option.input.bytes.includes("\r"))).toBe(true);
		expect(Object.isFrozen(options[0]!.input)).toBe(true);
		const input = options[0]!.input;
		expect(input.kind === "inline-confirmation" && Object.isFrozen(input.viewport)).toBe(true);
	});

	it("binds inline confirmation identity to the complete visible viewport", () => {
		const options = extractSemanticOptions(["stale one", "stale two", "stale three", "stale four", "stale five", "Ready", "Continue? (Y/n)"]);
		const input = options[0]!.input;
		expect(input.kind === "inline-confirmation" ? input.viewport : []).toEqual([
			"stale one", "stale two", "stale three", "stale four", "stale five", "Ready", "Continue? (Y/n)",
		]);
	});

	it.each([
		"Restart the server? (Y/n)",
		"Reload the service? (Y/n)",
		"Pause the worker? (Y/n)",
		"Resume the worker? (Y/n)",
		"Stop the worker? (Y/n)",
		"Start the daemon? (Y/n)",
	])("rejects lifecycle inline confirmation: %s", (prompt) => {
		expect(extractSemanticOptions([prompt])).toEqual([]);
	});

	it("rejects destructive context anywhere in the viewport without falling back to a generic menu", () => {
		expect(extractSemanticOptions([
			"Delete production resources", "1. Continue", "2. Go back", "details", "more details", "review", "Continue? (Y/n)",
		])).toEqual([]);
	});

	it.each([
		["ambiguous lowercase hint", ["Continue? (y/n)"]],
		["ambiguous uppercase hint", ["Continue? (Y/N)"]],
		["multiple prompts", ["Continue? (Y/n)", "Proceed? (y/N)"]],
		["adjacent question", ["Are you ready?", "Continue? (Y/n)"]],
		["prefilled same line", ["Continue? (Y/n) y"]],
		["prefilled following line", ["Continue? (Y/n)", "y"]],
		["free text", ["Enter a response:", "Continue? (Y/n)"]],
		["credential", ["Password required", "Continue? (Y/n)"]],
		["shell syntax", ["Run sudo deploy", "Continue? (Y/n)"]],
		...["delete", "remove", "overwrite", "drop", "reset", "erase", "destroy", "format", "purge", "abort", "cancel", "exit", "kill", "shutdown"]
			.map((operation) => [`${operation} operation`, [`${operation} data? (Y/n)`]]),
		["process-control operation", ["Stop the process? (y/N)"]],
	] as Array<[string, string[]]>)("rejects unsafe or ambiguous inline confirmation: %s", (_name, viewport) => {
		expect(extractSemanticOptions(viewport)).toEqual([]);
	});

	it.each([
		["duplicate labels", ["1. Same", "2. same"]],
		["non-sequential selectors", ["1. One", "3. Three"]],
		["mixed selector styles", ["1. One", "2) Two"]],
		["duplicate selected markers", ["> One", "> Two"]],
		["ambiguous wrapped boundary", ["❯ 1. One", "  unclear description", "  2. Two", "↑/↓ navigate · Enter to choose"]],
		["free-form text outside an unsupported sibling", ["Enter a response:", "❯ 1. One", "  2. Two", "↑/↓ navigate · Enter to choose"]],
		["secret wrapped choice", ["❯ 1. One", "     Uses a password", "  2. Two", "↑/↓ navigate · Enter to choose"]],
		["lifecycle wrapped choice", ["❯ 1. Continue", "  2. Terminate process", "↑/↓ navigate · Enter to choose"]],
		["secret appended to navigation help", ["❯ 1. One", "  2. Two", "↑/↓ navigate · Enter to choose · password required"]],
		["lifecycle appended to navigation help", ["❯ 1. One", "  2. Two", "↑/↓ navigate · Enter to choose · exit process"]],
		["shell syntax appended to navigation help", ["❯ 1. One", "  2. Two", "↑/↓ navigate · Enter to choose · sudo deploy"]],
		["secret appended to cancel help", ["❯ 1. One", "  2. Two", "↑/↓ navigate · Enter to choose", "Esc to cancel password token"]],
		["unmapped selected menu", ["  One", "❯ Two", "  Three"]],
		["only one option", ["1. Lonely"]],
		["free-form prompt", ["Enter a value:", "1. One", "2. Two"]],
		["secret choice", ["1. Use password", "2. Skip"]],
		["lifecycle choice", ["a) Continue", "b) Exit process"]],
		["ambiguous confirmation labels", ["1. Yes please", "2. No thanks"]],
		["shell syntax", ["1. Build", "2. sudo deploy"]],
		["terminal controls", ["1. Safe", "2. Bad\u001b[31m"]],
		["invisible formatting", ["1. Safe", "2. Con\u202etinue"]],
		["oversized option count", Array.from({ length: 11 }, (_, index) => `${index + 1}. Item ${index + 1}`)],
	] as Array<[string, string[]]>)("fails closed for %s", (_name, viewport) => {
		const result = extractSemanticOptions(viewport);
		expect(result).toEqual([]);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("does not infer options from ordinary or unsupported terminal text", () => {
		expect(extractSemanticOptions(["Build completed", "What should happen next?"])).toEqual([]);
		expect(extractSemanticOptions(["[ ] First", "[x] Second"])).toEqual([]);
		expect(extractSemanticOptions({ viewport: ["1. One", "2. Two"] })).toEqual([]);
	});
});
