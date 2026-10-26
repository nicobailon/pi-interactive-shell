import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENABLE_TOOL_DESCRIPTION, TOOL_DESCRIPTION, enableToolParameters, toolParameters } from "../tool-schema.ts";

describe("tool definition", () => {
	// The tool definition sits in every session's cached prompt prefix, so any byte change misses the
	// provider cache for every session that loads the extension. Deliver usage guidance in tool results and
	// notifications instead; update this hash only for a deliberate schema change.
	it("stays byte-identical", () => {
		const hash = createHash("sha256")
			.update(JSON.stringify({ d: TOOL_DESCRIPTION, p: toolParameters, ed: ENABLE_TOOL_DESCRIPTION, ep: enableToolParameters }))
			.digest("hex");
		expect(hash).toBe("57ceb8c15045b6ba8887ce1eeab23ac60194519edc2494ec8d7757daf3f10fd9");
	});
});
