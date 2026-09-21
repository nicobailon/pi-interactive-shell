import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const OUTPUT_SOURCE_REPRESENTATION = "normalized-merged-pty-text-v1" as const;
const DEFAULT_SOURCE_LIMIT = 8 * 1024 * 1024;
const DEFAULT_AGGREGATE_LIMIT = 64 * 1024 * 1024;
const DEFAULT_COMPLETED_TTL = 60 * 60 * 1000;
const DEFAULT_TOMBSTONE_TTL = 60 * 60 * 1000;
const DEFAULT_MAX_TOMBSTONES = 1_024;
const SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StoredState = "complete" | "incomplete" | "expired";
export type OutputSourceState = "capturing" | StoredState | "missing" | "corrupt";

export interface OutputSourceRef {
	readonly sourceId: string;
	readonly sessionId: string;
	readonly representation: typeof OUTPUT_SOURCE_REPRESENTATION;
}

export interface OutputSourceStatus {
	readonly ref?: OutputSourceRef;
	readonly sourceId: string;
	readonly state: OutputSourceState;
	readonly length: number;
	readonly startedAt?: string;
	readonly finalizedAt?: string;
	readonly expiresAt?: string;
	readonly reason?: string;
}

export interface OutputSourceRead extends OutputSourceStatus {
	readonly text: string;
	readonly range: Readonly<{ start: number; end: number }>;
}

export interface OutputSourceStoreOptions {
	root: string;
	clock?: () => number;
	perSourceBytes?: number;
	aggregateBytes?: number;
	completedTtlMs?: number;
	tombstoneTtlMs?: number;
	maxTombstones?: number;
}

export interface OutputCapture {
	readonly ref: OutputSourceRef;
	appendProcessText(text: string): void;
	finalize(): Promise<OutputSourceStatus>;
	markIncomplete(reason: string): Promise<OutputSourceStatus>;
}

interface Manifest {
	version: 1;
	ref: OutputSourceRef;
	state: StoredState;
	length: number;
	bytes: number;
	startedAt: string;
	finalizedAt: string;
	expiresAt?: string;
	tombstonedAt?: string;
	reason?: string;
	sha256?: string;
}

interface RecordEntry {
	manifest: Manifest;
	active: boolean;
	queue: Promise<void>;
	committedBytes: number;
	reservedBytes: number;
	terminal?: Promise<OutputSourceStatus>;
	corruptReason?: string;
	discoveredCorrupt?: boolean;
	writeBroken?: boolean;
}

function frozenRef(sourceId: string, sessionId: string): OutputSourceRef {
	return Object.freeze({ sourceId, sessionId, representation: OUTPUT_SOURCE_REPRESENTATION });
}

function iso(ms: number): string { return new Date(ms).toISOString(); }
function digest(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }

/** Process-local, private persistence for exact merged PTY string fragments. */
export class OutputSourceStore {
	private readonly root: string;
	private readonly clock: () => number;
	private readonly perSourceBytes: number;
	private readonly aggregateBytes: number;
	private readonly completedTtlMs: number;
	private readonly tombstoneTtlMs: number;
	private readonly maxTombstones: number;
	private readonly records = new Map<string, RecordEntry>();
	private readonly sessions = new Map<string, string>();
	private aggregateReserved = 0;

	constructor(options: OutputSourceStoreOptions) {
		this.root = options.root;
		this.clock = options.clock ?? Date.now;
		this.perSourceBytes = options.perSourceBytes ?? DEFAULT_SOURCE_LIMIT;
		this.aggregateBytes = options.aggregateBytes ?? DEFAULT_AGGREGATE_LIMIT;
		this.completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL;
		this.tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL;
		this.maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
		for (const [name, value] of Object.entries({ perSourceBytes: this.perSourceBytes, aggregateBytes: this.aggregateBytes, completedTtlMs: this.completedTtlMs, tombstoneTtlMs: this.tombstoneTtlMs, maxTombstones: this.maxTombstones })) {
			if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid OutputSourceStore ${name}`);
		}
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") chmodSync(this.root, 0o700);
		this.discover();
	}

	begin(sessionId: string): OutputCapture {
		if (!sessionId) throw new Error("Output source sessionId must not be empty");
		let sourceId = randomUUID();
		while (this.records.has(sourceId)) sourceId = randomUUID();
		const ref = frozenRef(sourceId, sessionId);
		const startedAt = iso(this.clock());
		const capture = this.capturePath(sourceId);
		const fd = openSync(capture, "wx", 0o600);
		closeSync(fd);
		if (process.platform !== "win32") chmodSync(capture, 0o600);
		const manifest: Manifest = { version: 1, ref, state: "incomplete", length: 0, bytes: 0, startedAt, finalizedAt: startedAt, reason: "capture-not-finalized" };
		const entry: RecordEntry = { manifest, active: true, queue: Promise.resolve(), committedBytes: 0, reservedBytes: 0 };
		this.records.set(sourceId, entry);
		this.sessions.set(sessionId, sourceId);

		return Object.freeze({
			ref,
			appendProcessText: (text: string) => this.append(entry, text),
			finalize: () => this.finish(entry),
			markIncomplete: (reason: string) => this.fail(entry, reason || "marked-incomplete"),
		});
	}

	status(sourceId: string): OutputSourceStatus {
		if (!SOURCE_ID.test(sourceId)) return Object.freeze({ sourceId, state: "corrupt", length: 0, reason: "invalid-source-id" });
		const entry = this.records.get(sourceId);
		if (!entry) return Object.freeze({ sourceId, state: "missing", length: 0 });
		return this.publicStatus(entry);
	}

	statusForSession(sessionId: string): OutputSourceStatus {
		const sourceId = this.sessions.get(sessionId);
		return sourceId ? this.status(sourceId) : Object.freeze({ sourceId: "", state: "missing", length: 0, reason: "session-has-no-source" });
	}

	async read(sourceId: string, range?: { start: number; end: number }): Promise<OutputSourceRead> {
		const initial = this.status(sourceId);
		const entry = this.records.get(sourceId);
		if (!entry || initial.state === "corrupt" || initial.state === "missing" || initial.state === "expired") {
			return Object.freeze({ ...initial, text: "", range: Object.freeze({ start: 0, end: 0 }) });
		}
		await entry.queue;
		const status = this.publicStatus(entry);
		let data: Buffer;
		try {
			data = await readFile(entry.active ? this.capturePath(sourceId) : this.dataPath(sourceId));
		} catch (error) {
			return Object.freeze({ sourceId, state: "missing", length: 0, reason: `source-content-unavailable: ${this.errorMessage(error)}`, text: "", range: Object.freeze({ start: 0, end: 0 }) });
		}
		const text = data.subarray(0, entry.committedBytes).toString("utf16le");
		const start = range?.start ?? 0;
		const end = range?.end ?? text.length;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) throw new RangeError(`Invalid output source range [${start}, ${end}) for length ${text.length}`);
		return Object.freeze({ ...status, text: text.slice(start, end), range: Object.freeze({ start, end }) });
	}

	async sweep(now = this.clock()): Promise<void> {
		const ordered = [...this.records.entries()].sort(([a], [b]) => a.localeCompare(b));
		for (const [sourceId, entry] of ordered) {
			if (entry.manifest.state === "complete" && Date.parse(entry.manifest.expiresAt ?? "") <= now) {
				await this.removeFile(this.dataPath(sourceId));
				this.aggregateReserved -= entry.reservedBytes;
				entry.reservedBytes = entry.committedBytes = 0;
				entry.manifest = { ...entry.manifest, state: "expired", length: 0, bytes: 0, tombstonedAt: iso(now), reason: "completed-source-expired", sha256: undefined };
				await this.persistManifest(entry.manifest);
			} else if (entry.manifest.state === "expired" && Date.parse(entry.manifest.tombstonedAt ?? entry.manifest.finalizedAt) + this.tombstoneTtlMs <= now) {
				await this.removeRecord(sourceId);
			}
		}
		const tombstones = [...this.records.entries()]
			.filter(([, entry]) => entry.manifest.state === "expired")
			.sort((a, b) => (a[1].manifest.tombstonedAt ?? "").localeCompare(b[1].manifest.tombstonedAt ?? "") || a[0].localeCompare(b[0]));
		for (let i = 0; i < tombstones.length - this.maxTombstones; i++) await this.removeRecord(tombstones[i]![0]);
	}

	private append(entry: RecordEntry, text: string): void {
		try {
			if (this.currentState(entry) !== "capturing" || text.length === 0) return;
			const data = Buffer.from(text, "utf16le");
			if (entry.reservedBytes + data.length > this.perSourceBytes) { this.setIncomplete(entry, "per-source-quota-exceeded"); return; }
			if (this.aggregateReserved + data.length > this.aggregateBytes) { this.setIncomplete(entry, "aggregate-quota-exceeded"); return; }
			entry.reservedBytes += data.length;
			this.aggregateReserved += data.length;
			entry.queue = entry.queue.then(async () => {
				if (entry.writeBroken) return;
				try {
					await appendFile(this.capturePath(entry.manifest.ref.sourceId), data, { mode: 0o600 });
					entry.committedBytes += data.length;
					entry.manifest = { ...entry.manifest, length: entry.committedBytes / 2, bytes: entry.committedBytes };
				} catch (error) {
					entry.writeBroken = true;
					this.setIncomplete(entry, `write-failed: ${this.errorMessage(error)}`);
				}
			});
		} catch (error) {
			this.setIncomplete(entry, `append-failed: ${this.errorMessage(error)}`);
		}
	}

	private finish(entry: RecordEntry): Promise<OutputSourceStatus> {
		if (entry.terminal) return entry.terminal;
		entry.terminal = this.settle(entry, undefined);
		return entry.terminal;
	}

	private fail(entry: RecordEntry, reason: string): Promise<OutputSourceStatus> {
		this.setIncomplete(entry, reason);
		if (!entry.terminal) entry.terminal = this.settle(entry, entry.corruptReason ?? reason);
		return entry.terminal;
	}

	private setIncomplete(entry: RecordEntry, reason: string): void {
		if (this.currentState(entry) === "capturing") entry.corruptReason = reason;
	}

	private async settle(entry: RecordEntry, requestedFailure?: string): Promise<OutputSourceStatus> {
		await entry.queue;
		entry.active = false;
		const sourceId = entry.manifest.ref.sourceId;
		const reason = entry.corruptReason ?? requestedFailure;
		const finalized = this.clock();
		try {
			await rename(this.capturePath(sourceId), this.dataPath(sourceId));
			if (process.platform !== "win32") await chmod(this.dataPath(sourceId), 0o600);
		} catch (error) {
			entry.corruptReason = `finalize-content-failed: ${this.errorMessage(error)}`;
		}
		const finalReason = entry.corruptReason ?? reason;
		let hash: string | undefined;
		try { hash = digest((await readFile(this.dataPath(sourceId))).subarray(0, entry.committedBytes)); }
		catch (error) { entry.corruptReason = `finalize-read-failed: ${this.errorMessage(error)}`; }
		entry.manifest = {
			...entry.manifest,
			state: finalReason || entry.corruptReason ? "incomplete" : "complete",
			length: entry.committedBytes / 2,
			bytes: entry.committedBytes,
			finalizedAt: iso(finalized),
			expiresAt: !finalReason && !entry.corruptReason ? iso(finalized + this.completedTtlMs) : undefined,
			reason: entry.corruptReason ?? finalReason,
			sha256: hash,
		};
		try { await this.persistManifest(entry.manifest); }
		catch (error) {
			entry.manifest = { ...entry.manifest, state: "incomplete", expiresAt: undefined, reason: `manifest-write-failed: ${this.errorMessage(error)}` };
		}
		return this.publicStatus(entry);
	}

	private currentState(entry: RecordEntry): OutputSourceState {
		if (entry.corruptReason) return entry.active ? "incomplete" : entry.manifest.state;
		return entry.active ? "capturing" : entry.manifest.state;
	}

	private publicStatus(entry: RecordEntry): OutputSourceStatus {
		if (entry.discoveredCorrupt) {
			return Object.freeze({ sourceId: entry.manifest.ref.sourceId, ref: entry.manifest.ref, state: "corrupt", length: 0, reason: entry.corruptReason });
		}
		const state = this.currentState(entry);
		return Object.freeze({ sourceId: entry.manifest.ref.sourceId, ref: entry.manifest.ref, state, length: entry.committedBytes / 2, startedAt: entry.manifest.startedAt, finalizedAt: entry.active ? undefined : entry.manifest.finalizedAt, expiresAt: entry.manifest.expiresAt, reason: entry.corruptReason ?? entry.manifest.reason });
	}

	private discover(): void {
		for (const filename of readdirSync(this.root).filter(name => name.endsWith(".manifest.json")).sort()) {
			const filenameId = filename.slice(0, -".manifest.json".length);
			if (!SOURCE_ID.test(filenameId)) continue;
			try {
				const parsed = JSON.parse(readFileSync(join(this.root, filename), "utf8")) as Partial<Manifest>;
				if (!this.validManifest(parsed) || parsed.ref.sourceId !== filenameId) throw new Error("manifest identity or schema mismatch");
				const manifest = parsed as Manifest;
				const entry: RecordEntry = { manifest: { ...manifest, ref: frozenRef(manifest.ref.sourceId, manifest.ref.sessionId) }, active: false, queue: Promise.resolve(), committedBytes: manifest.bytes, reservedBytes: manifest.bytes };
				if (manifest.state !== "expired") {
					const path = this.dataPath(filenameId);
					if (!existsSync(path)) throw new Error("source content is missing");
					const bytes = statSync(path).size;
					if (bytes < manifest.bytes || bytes % 2 !== 0) throw new Error("source content length mismatch");
					const data = readFileSync(path).subarray(0, manifest.bytes);
					if (!manifest.sha256 || digest(data) !== manifest.sha256) throw new Error("source content digest mismatch");
					this.aggregateReserved += manifest.bytes;
				}
				this.records.set(filenameId, entry);
				this.sessions.set(manifest.ref.sessionId, filenameId);
			} catch (error) {
				const now = iso(this.clock());
				const manifest: Manifest = { version: 1, ref: frozenRef(filenameId, ""), state: "incomplete", length: 0, bytes: 0, startedAt: now, finalizedAt: now };
				this.records.set(filenameId, { manifest, active: false, queue: Promise.resolve(), committedBytes: 0, reservedBytes: 0, corruptReason: this.errorMessage(error), discoveredCorrupt: true });
			}
		}
	}

	private validManifest(value: Partial<Manifest>): value is Manifest {
		return value.version === 1 && !!value.ref && SOURCE_ID.test(value.ref.sourceId) && typeof value.ref.sessionId === "string" && value.ref.representation === OUTPUT_SOURCE_REPRESENTATION && (value.state === "complete" || value.state === "incomplete" || value.state === "expired") && Number.isSafeInteger(value.length) && value.length! >= 0 && Number.isSafeInteger(value.bytes) && value.bytes! === value.length! * 2 && typeof value.startedAt === "string" && typeof value.finalizedAt === "string";
	}

	private async persistManifest(manifest: Manifest): Promise<void> {
		const sourceId = manifest.ref.sourceId;
		const temporary = `${this.manifestPath(sourceId)}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		if (process.platform !== "win32") await chmod(temporary, 0o600);
		await rename(temporary, this.manifestPath(sourceId));
	}

	private async removeRecord(sourceId: string): Promise<void> {
		const entry = this.records.get(sourceId);
		if (!entry) return;
		this.aggregateReserved -= entry.reservedBytes;
		await this.removeFile(this.manifestPath(sourceId));
		await this.removeFile(this.dataPath(sourceId));
		await this.removeFile(this.capturePath(sourceId));
		this.records.delete(sourceId);
		if (this.sessions.get(entry.manifest.ref.sessionId) === sourceId) this.sessions.delete(entry.manifest.ref.sessionId);
	}

	private async removeFile(path: string): Promise<void> {
		try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}

	private capturePath(sourceId: string): string { return join(this.root, `${sourceId}.capture`); }
	private dataPath(sourceId: string): string { return join(this.root, `${sourceId}.data`); }
	private manifestPath(sourceId: string): string { return join(this.root, `${sourceId}.manifest.json`); }
	private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
