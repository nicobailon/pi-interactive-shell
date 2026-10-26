import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENABLE_TOOL_DESCRIPTION, TOOL_DESCRIPTION, TOOL_PROMPT_GUIDELINES, TOOL_PROMPT_SNIPPET, enableToolParameters, toolParameters } from "../tool-schema.ts";

describe("tool definition", () => {
	// The tool definition sits in every session's cached prompt prefix, so any byte change misses the
	// provider cache for every session that loads the extension. Deliver usage guidance in tool results and
	// notifications instead; update this hash only for a deliberate schema change.
	it("stays byte-identical", () => {
		const hash = createHash("sha256")
			.update(JSON.stringify({ d: TOOL_DESCRIPTION, p: toolParameters, ed: ENABLE_TOOL_DESCRIPTION, ep: enableToolParameters, s: TOOL_PROMPT_SNIPPET, g: TOOL_PROMPT_GUIDELINES }))
			.digest("hex");
		expect(hash).toBe("4b2c584ba2c6d5a219cf610f985f9e1e66ef683916ca2bc28da7e15a15eedabe");
	});
});
