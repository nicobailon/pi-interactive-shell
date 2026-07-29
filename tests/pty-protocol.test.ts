import { describe, expect, it } from "vitest";
import {
	buildCursorPositionResponse,
	buildPrimaryDeviceAttributesResponse,
	splitAroundDeviceQueries,
} from "../pty-protocol.ts";

describe("pty protocol queries", () => {
	it("splits cursor DSR and Primary DA queries in order", () => {
		expect(splitAroundDeviceQueries(`a\x1b[0cb\x1b[6nc`)).toEqual({
			segments: [
				{ text: "a", queryAfter: "primary-device-attributes" },
				{ text: "b", queryAfter: "cursor-position" },
			],
			trailingText: "c",
			hasQuery: true,
		});
	});

	it("recognizes implicit Primary DA and private cursor DSR forms", () => {
		expect(splitAroundDeviceQueries("\x1b[c\x1b[?6n")).toEqual({
			segments: [
				{ text: "", queryAfter: "primary-device-attributes" },
				{ text: "", queryAfter: "cursor-position" },
			],
			trailingText: "",
			hasQuery: true,
		});
	});

	it("builds terminal responses expected by shells", () => {
		expect(buildCursorPositionResponse(12, 34)).toBe("\x1b[12;34R");
		expect(buildPrimaryDeviceAttributesResponse()).toMatch(/^\x1b\[\?.*c$/);
	});
});
