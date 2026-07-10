/**
 * Compute stream delta between two kitty get-text snapshots.
 * Avoids re-appending the full snapshot when scrollback truncates or the TUI redraws.
 * Returns empty delta with rewrite=true when the change is a non-append rewrite
 * (caller should update the authoritative snapshot only, not stream listeners).
 */
export function computeSnapshotDelta(previous: string, next: string): { delta: string; rewrite: boolean } {
	if (next === previous) return { delta: "", rewrite: false };
	if (!previous) return { delta: next, rewrite: false };
	if (next.startsWith(previous)) return { delta: next.slice(previous.length), rewrite: false };

	const previousLines = splitLinesWithEndings(previous);
	const nextLines = splitLinesWithEndings(next);
	const maxOverlapLines = Math.min(previousLines.length, nextLines.length);
	for (let lineCount = maxOverlapLines; lineCount > 0; lineCount--) {
		const previousSuffix = previousLines.slice(previousLines.length - lineCount).join("");
		const nextPrefix = nextLines.slice(0, lineCount).join("");
		if (previousSuffix === nextPrefix && isUsefulOverlap(nextPrefix, lineCount)) {
			return { delta: next.slice(nextPrefix.length), rewrite: false };
		}
	}

	// Full rewrite / TUI screen replace — do not stream-append the entire snapshot.
	return { delta: "", rewrite: true };
}

function splitLinesWithEndings(value: string): string[] {
	return value.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function isUsefulOverlap(overlap: string, lineCount: number): boolean {
	if (lineCount >= 2) return true;
	// A one-line overlap is useful for small scrollbacks, but a lone newline or
	// whitespace-only boundary is too weak and commonly appears during TUI rewrites.
	return overlap.trim().length > 0;
}
