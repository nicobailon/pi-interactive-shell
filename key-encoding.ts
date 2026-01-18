/**
 * Terminal key encoding utilities for translating named keys and modifiers
 * into terminal escape sequences.
 */

// Named key sequences (without modifiers)
const NAMED_KEYS: Record<string, string> = {
	// Arrow keys
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",

	// Common keys
	enter: "\r",
	return: "\r",
	escape: "\x1b",
	esc: "\x1b",
	tab: "\t",
	space: " ",
	backspace: "\x7f",
	bspace: "\x7f", // tmux-style alias

	// Editing keys
	delete: "\x1b[3~",
	del: "\x1b[3~",
	dc: "\x1b[3~", // tmux-style alias
	insert: "\x1b[2~",
	ic: "\x1b[2~", // tmux-style alias

	// Navigation
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pgup: "\x1b[5~",
	ppage: "\x1b[5~", // tmux-style alias
	pagedown: "\x1b[6~",
	pgdn: "\x1b[6~",
	npage: "\x1b[6~", // tmux-style alias

	// Shift+Tab (backtab)
	btab: "\x1b[Z",

	// Function keys
	f1: "\x1bOP",
	f2: "\x1bOQ",
	f3: "\x1bOR",
	f4: "\x1bOS",
	f5: "\x1b[15~",
	f6: "\x1b[17~",
	f7: "\x1b[18~",
	f8: "\x1b[19~",
	f9: "\x1b[20~",
	f10: "\x1b[21~",
	f11: "\x1b[23~",
	f12: "\x1b[24~",

	// Keypad keys (application mode)
	kp0: "\x1bOp",
	kp1: "\x1bOq",
	kp2: "\x1bOr",
	kp3: "\x1bOs",
	kp4: "\x1bOt",
	kp5: "\x1bOu",
	kp6: "\x1bOv",
	kp7: "\x1bOw",
	kp8: "\x1bOx",
	kp9: "\x1bOy",
	"kp/": "\x1bOo",
	"kp*": "\x1bOj",
	"kp-": "\x1bOm",
	"kp+": "\x1bOk",
	"kp.": "\x1bOn",
	kpenter: "\x1bOM",
};

// Ctrl+key combinations (ctrl+a through ctrl+z, plus some special)
const CTRL_KEYS: Record<string, string> = {};
for (let i = 0; i < 26; i++) {
	const char = String.fromCharCode(97 + i); // a-z
	CTRL_KEYS[`ctrl+${char}`] = String.fromCharCode(i + 1);
}
// Special ctrl combinations
CTRL_KEYS["ctrl+["] = "\x1b"; // Same as Escape
CTRL_KEYS["ctrl+\\"] = "\x1c";
CTRL_KEYS["ctrl+]"] = "\x1d";
CTRL_KEYS["ctrl+^"] = "\x1e";
CTRL_KEYS["ctrl+_"] = "\x1f";
CTRL_KEYS["ctrl+?"] = "\x7f"; // Same as Backspace

// Alt+key sends ESC followed by the key
function altKey(char: string): string {
	return `\x1b${char}`;
}

// Keys that support xterm modifier encoding (CSI sequences)
const MODIFIABLE_KEYS = new Set([
	"up", "down", "left", "right", "home", "end",
	"pageup", "pgup", "ppage", "pagedown", "pgdn", "npage",
	"insert", "ic", "delete", "del", "dc",
]);

// Calculate xterm modifier code: 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0)
function xtermModifier(shift: boolean, alt: boolean, ctrl: boolean): number {
	let mod = 1;
	if (shift) mod += 1;
	if (alt) mod += 2;
	if (ctrl) mod += 4;
	return mod;
}

// Apply xterm modifier to CSI sequence: ESC[A -> ESC[1;modA
function applyXtermModifier(sequence: string, modifier: number): string | null {
	// Arrow keys: ESC[A -> ESC[1;modA
	const arrowMatch = sequence.match(/^\x1b\[([A-D])$/);
	if (arrowMatch) {
		return `\x1b[1;${modifier}${arrowMatch[1]}`;
	}
	// Numbered sequences: ESC[5~ -> ESC[5;mod~
	const numMatch = sequence.match(/^\x1b\[(\d+)~$/);
	if (numMatch) {
		return `\x1b[${numMatch[1]};${modifier}~`;
	}
	// Home/End: ESC[H -> ESC[1;modH, ESC[F -> ESC[1;modF
	const hfMatch = sequence.match(/^\x1b\[([HF])$/);
	if (hfMatch) {
		return `\x1b[1;${modifier}${hfMatch[1]}`;
	}
	return null;
}

// Bracketed paste mode sequences
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function encodePaste(text: string, bracketed = true): string {
	if (!bracketed) return text;
	return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/** Parse a key token and return the escape sequence */
function encodeKeyToken(token: string): string {
	const normalized = token.trim().toLowerCase();
	if (!normalized) return "";

	// Check for direct match in named keys
	if (NAMED_KEYS[normalized]) {
		return NAMED_KEYS[normalized];
	}

	// Check for ctrl+key
	if (CTRL_KEYS[normalized]) {
		return CTRL_KEYS[normalized];
	}

	// Parse modifier prefixes: ctrl+alt+shift+key, c-m-s-key, etc.
	let rest = normalized;
	let ctrl = false, alt = false, shift = false;

	// Support both "ctrl+alt+x" and "c-m-x" syntax
	while (rest.length > 2) {
		if (rest.startsWith("ctrl+") || rest.startsWith("ctrl-")) {
			ctrl = true;
			rest = rest.slice(5);
		} else if (rest.startsWith("alt+") || rest.startsWith("alt-")) {
			alt = true;
			rest = rest.slice(4);
		} else if (rest.startsWith("shift+") || rest.startsWith("shift-")) {
			shift = true;
			rest = rest.slice(6);
		} else if (rest.startsWith("c-")) {
			ctrl = true;
			rest = rest.slice(2);
		} else if (rest.startsWith("m-")) {
			alt = true;
			rest = rest.slice(2);
		} else if (rest.startsWith("s-")) {
			shift = true;
			rest = rest.slice(2);
		} else {
			break;
		}
	}

	// Handle shift+tab specially
	if (shift && rest === "tab") {
		return "\x1b[Z";
	}

	// Check if base key is a named key that supports modifiers
	const baseSeq = NAMED_KEYS[rest];
	if (baseSeq && MODIFIABLE_KEYS.has(rest) && (ctrl || alt || shift)) {
		const mod = xtermModifier(shift, alt, ctrl);
		if (mod > 1) {
			const modified = applyXtermModifier(baseSeq, mod);
			if (modified) return modified;
		}
	}

	// For single character with modifiers
	if (rest.length === 1) {
		let char = rest;
		if (shift && /[a-z]/.test(char)) {
			char = char.toUpperCase();
		}
		if (ctrl) {
			const ctrlChar = CTRL_KEYS[`ctrl+${char.toLowerCase()}`];
			if (ctrlChar) char = ctrlChar;
		}
		if (alt) {
			return altKey(char);
		}
		return char;
	}

	// Named key with alt modifier
	if (baseSeq && alt) {
		return `\x1b${baseSeq}`;
	}

	// Return base sequence if found
	if (baseSeq) {
		return baseSeq;
	}

	// Unknown key, return as literal
	return token;
}

/** Translate input specification to terminal escape sequences */
export function translateInput(input: string | { text?: string; keys?: string[]; paste?: string; hex?: string[] }): string {
	if (typeof input === "string") {
		return input;
	}

	let result = "";

	// Hex bytes (raw escape sequences)
	if (input.hex?.length) {
		for (const raw of input.hex) {
			const trimmed = raw.trim().toLowerCase();
			const normalized = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
			if (/^[0-9a-f]{1,2}$/.test(normalized)) {
				const value = Number.parseInt(normalized, 16);
				if (!Number.isNaN(value) && value >= 0 && value <= 0xff) {
					result += String.fromCharCode(value);
				}
			}
		}
	}

	// Literal text
	if (input.text) {
		result += input.text;
	}

	// Named keys with modifier support
	if (input.keys) {
		for (const key of input.keys) {
			result += encodeKeyToken(key);
		}
	}

	// Bracketed paste
	if (input.paste) {
		result += encodePaste(input.paste);
	}

	return result;
}
