import { describe, expect, it } from "vitest";
import { translateInput } from "../key-encoding.js";

describe("translateInput", () => {
	it("encodes named keys and modifiers", () => {
		expect(translateInput({ keys: ["up", "shift+tab", "ctrl+c", "m-x"] })).toBe("\x1b[A\x1b[Z\x03\x1bx");
	});

	it("combines text, keys, hex bytes, and paste in order", () => {
		expect(translateInput({
			text: "hi",
			keys: ["enter"],
			hex: ["0x21"],
			paste: "body",
		})).toBe("!hi\r\x1b[200~body\x1b[201~");
	});

	it("supports xterm modifier encoding for CSI keys", () => {
		expect(translateInput({ keys: ["ctrl+alt+delete", "s-up"] })).toBe("\x1b[3;7~\x1b[1;2A");
	});
});
