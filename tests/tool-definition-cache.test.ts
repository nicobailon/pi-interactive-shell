import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENABLE_TOOL_DESCRIPTION, LEAN_TOOL_DESCRIPTION, TOOL_DESCRIPTION, TOOL_PROMPT_GUIDELINES, TOOL_PROMPT_SNIPPET, enableToolParameters, leanToolParameters, toolParameters } from "../tool-schema.ts";

const definitionHash = (description: string, parameters: unknown) => createHash("sha256")
	.update(JSON.stringify({ d: description, p: parameters, ed: ENABLE_TOOL_DESCRIPTION, ep: enableToolParameters, s: TOOL_PROMPT_SNIPPET, g: TOOL_PROMPT_GUIDELINES }))
	.digest("hex");

describe("tool definition", () => {
	// The tool definition sits in every session's cached prompt prefix, so any byte change misses the
	// provider cache for every session that loads the extension. Deliver usage guidance in tool results and
	// notifications instead; update these hashes only for a deliberate schema change.
	it("stays byte-identical in full mode", () => {
		expect(definitionHash(TOOL_DESCRIPTION, toolParameters)).toBe("4b2c584ba2c6d5a219cf610f985f9e1e66ef683916ca2bc28da7e15a15eedabe");
	});

	it("stays byte-identical in lean mode", () => {
		expect(definitionHash(LEAN_TOOL_DESCRIPTION, leanToolParameters)).toBe("b87a31c922158cf5f60d6d1199fbf06f5aee56c1150604217b6bf5254a5e195d");
	});
});
