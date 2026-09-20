import { describe, expect, it } from "vitest";
import { encodeSemanticActionKeys, translateInput } from "../key-encoding.ts";

describe("translateInput", () => {
	it("encodes named keys and modifiers", () => {
		expect(translateInput({ keys: ["up", "shift+tab", "ctrl+c", "m-x"] })).toBe("\x1b[A\x1b[Z\x03\x1bx");
	});

	it("emits paste before trailing keys so pasted input can be submitted afterward", () => {
		expect(translateInput({
			text: "hi",
			keys: ["enter"],
			hex: ["0x21"],
			paste: "body",
		})).toBe("!hi\x1b[200~body\x1b[201~\r");
	});

	it("supports xterm modifier encoding for CSI keys", () => {
		expect(translateInput({ keys: ["ctrl+alt+delete", "s-up"] })).toBe("\x1b[3;7~\x1b[1;2A");
	});

	it("rejects semantic modifier combinations that cannot be faithfully encoded", () => {
		for (const key of ["ctrl+1", "c-1", "ctrl+@", "c-@", "shift+1", "s-1", "ctrl+alt+1", "c-m-1"]) {
			expect(() => encodeSemanticActionKeys([key]), key).toThrow("Unknown semantic action key");
		}
		expect(encodeSemanticActionKeys(["ctrl+a", "c-[", "alt+1", "m-@", "shift+a", "s-tab", "ctrl+alt+delete"])).toBe("\x01\x1b\x1b1\x1b@A\x1b[Z\x1b[3;7~");
	});
});
