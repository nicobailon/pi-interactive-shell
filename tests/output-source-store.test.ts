import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { OUTPUT_SOURCE_REPRESENTATION, OutputSourceStore } from "../output-source-store.ts";

const roots: string[] = [];
async function root(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "output-source-store-"));
	roots.push(path);
	return join(path, "private");
}
afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe("OutputSourceStore", () => {
	it("recovers exact ANSI, CR, long-line text and uses immutable UTF-16 ranges", async () => {
		const store = new OutputSourceStore({ root: await root() });
		const capture = store.begin("session-a");
		const sourceId = capture.ref.sourceId;
		const text = `\u001b[31mred\u001b[0m\r${"x".repeat(20_000)}😀tail`;
		capture.appendProcessText(text.slice(0, 10));
		capture.appendProcessText(text.slice(10));
		const status = await capture.finalize();
		assert.equal(status.state, "complete");
		assert.equal(status.length, text.length);
		assert.equal(capture.ref.sourceId, sourceId);
		assert.equal(capture.ref.representation, OUTPUT_SOURCE_REPRESENTATION);
		assert.ok(Object.isFrozen(capture.ref));
		const start = text.indexOf("😀");
		const result = await store.read(sourceId, { start, end: start + 2 });
		assert.equal(result.text, "😀");
		assert.deepEqual(result.range, { start, end: start + 2 });
		assert.ok(Object.isFrozen(result.range));
	});

	it("keeps a prefix larger than the rolling PTY buffer and drains the final queued chunk", async () => {
		const store = new OutputSourceStore({ root: await root() });
		const capture = store.begin("large");
		const prefix = `prefix:${"a".repeat(1024 * 1024 + 17)}`;
		capture.appendProcessText(prefix);
		capture.appendProcessText(":final");
		const completed = await capture.finalize();
		assert.equal(completed.state, "complete");
		const recovered = await store.read(capture.ref.sourceId);
		assert.equal(recovered.text, `${prefix}:final`);
	});

	it("creates private files and directory on POSIX", async () => {
		const directory = await root();
		const store = new OutputSourceStore({ root: directory });
		const capture = store.begin("permissions");
		capture.appendProcessText("private");
		await capture.finalize();
		if (process.platform !== "win32") {
			assert.equal((await stat(directory)).mode & 0o777, 0o700);
			assert.equal((await stat(join(directory, `${capture.ref.sourceId}.data`))).mode & 0o777, 0o600);
			assert.equal((await stat(join(directory, `${capture.ref.sourceId}.manifest.json`))).mode & 0o777, 0o600);
		}
	});

	it("turns per-source and aggregate quota into readable incomplete prefixes without throwing", async () => {
		const directory = await root();
		const store = new OutputSourceStore({ root: directory, perSourceBytes: 8, aggregateBytes: 12 });
		const first = store.begin("first");
		assert.doesNotThrow(() => first.appendProcessText("abcd"));
		assert.doesNotThrow(() => first.appendProcessText("e"));
		assert.equal(store.status(first.ref.sourceId).state, "incomplete");
		assert.match(store.status(first.ref.sourceId).reason ?? "", /per-source-quota/);
		assert.equal((await store.read(first.ref.sourceId)).text, "abcd");
		assert.equal((await first.finalize()).state, "incomplete");
		assert.equal((await store.read(first.ref.sourceId)).text, "abcd");

		const second = store.begin("second");
		assert.doesNotThrow(() => second.appendProcessText("abc"));
		assert.equal(store.status(second.ref.sourceId).state, "incomplete");
		assert.match(store.status(second.ref.sourceId).reason ?? "", /aggregate-quota/);
		await second.finalize();
	});

	it("turns asynchronous write failure into explicit incomplete state", async () => {
		const directory = await root();
		const store = new OutputSourceStore({ root: directory });
		const capture = store.begin("write-failure");
		const path = join(directory, `${capture.ref.sourceId}.capture`);
		await unlink(path);
		await mkdir(path);
		assert.doesNotThrow(() => capture.appendProcessText("cannot-write"));
		const status = await capture.finalize();
		assert.equal(status.state, "incomplete");
		assert.match(status.reason ?? "", /(write|finalize)-/);
	});

	it("distinguishes complete, incomplete, missing, corrupt, and expired", async () => {
		let now = 10_000;
		const directory = await root();
		const store = new OutputSourceStore({ root: directory, clock: () => now, completedTtlMs: 100, tombstoneTtlMs: 50 });
		const complete = store.begin("complete");
		complete.appendProcessText("ok");
		await complete.finalize();
		assert.equal(store.status(complete.ref.sourceId).state, "complete");
		const incomplete = store.begin("incomplete");
		incomplete.appendProcessText("partial");
		await incomplete.markIncomplete("cancelled");
		assert.equal(store.status(incomplete.ref.sourceId).state, "incomplete");
		assert.equal(store.status("11111111-1111-4111-8111-111111111111").state, "missing");
		assert.equal(store.status("../escape").state, "corrupt");
		now += 101;
		await store.sweep();
		assert.equal(store.status(complete.ref.sourceId).state, "expired");
		assert.equal((await store.read(complete.ref.sourceId)).text, "");
		now += 51;
		await store.sweep();
		assert.equal(store.status(complete.ref.sourceId).state, "missing");
	});

	it("survives store reconstruction until TTL and preserves session lookup", async () => {
		let now = 1_000;
		const directory = await root();
		const first = new OutputSourceStore({ root: directory, clock: () => now, completedTtlMs: 1_000 });
		const capture = first.begin("restart-session");
		capture.appendProcessText("restart\r\n\u001b[2Kproof");
		await capture.finalize();
		const reconstructed = new OutputSourceStore({ root: directory, clock: () => now, completedTtlMs: 1_000 });
		assert.equal(reconstructed.statusForSession("restart-session").sourceId, capture.ref.sourceId);
		assert.equal((await reconstructed.read(capture.ref.sourceId)).text, "restart\r\n\u001b[2Kproof");
		now += 1_001;
		await reconstructed.sweep();
		assert.equal(reconstructed.status(capture.ref.sourceId).state, "expired");
	});

	it("does not reserve expired discovered content against new captures", async () => {
		let now = 0;
		const directory = await root();
		const first = new OutputSourceStore({ root: directory, clock: () => now, aggregateBytes: 8, completedTtlMs: 100 });
		const old = first.begin("old"); old.appendProcessText("abcd"); await old.finalize();
		now = 101;
		const reconstructed = new OutputSourceStore({ root: directory, clock: () => now, aggregateBytes: 8, completedTtlMs: 100 });
		assert.equal(reconstructed.status(old.ref.sourceId).state, "expired");
		const fresh = reconstructed.begin("fresh"); fresh.appendProcessText("abcd");
		assert.equal((await fresh.finalize()).state, "complete");
		await reconstructed.sweep();
	});

	it("never restores session lookup for reconstructed expired tombstones", async () => {
		for (const terminalState of ["complete", "incomplete"] as const) {
			let now = 0;
			const directory = await root();
			const sessionId = `${terminalState}-session`;
			const first = new OutputSourceStore({ root: directory, clock: () => now, completedTtlMs: 100, tombstoneTtlMs: 50 });
			const capture = first.begin(sessionId);
			capture.appendProcessText(terminalState);
			if (terminalState === "complete") await capture.finalize();
			else await capture.markIncomplete("cancelled");

			now = 101;
			await first.sweep();
			assert.equal(first.status(capture.ref.sourceId).state, "expired");
			assert.equal(first.statusForSession(sessionId).state, "missing");
			const reconstructed = new OutputSourceStore({ root: directory, clock: () => now, completedTtlMs: 100, tombstoneTtlMs: 50 });
			assert.equal(reconstructed.status(capture.ref.sourceId).state, "expired");
			assert.equal(reconstructed.statusForSession(sessionId).state, "missing");

			now = 152;
			await reconstructed.sweep();
			assert.equal(reconstructed.status(capture.ref.sourceId).state, "missing");
			assert.equal(reconstructed.statusForSession(sessionId).state, "missing");
		}
	});

	it("rejects manifest identity mismatch and missing/corrupt content deterministically", async () => {
		const directory = await root();
		const first = new OutputSourceStore({ root: directory });
		const mismatch = first.begin("mismatch");
		mismatch.appendProcessText("content");
		await mismatch.finalize();
		const manifestPath = join(directory, `${mismatch.ref.sourceId}.manifest.json`);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.ref.sourceId = "22222222-2222-4222-8222-222222222222";
		await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
		const reconstructed = new OutputSourceStore({ root: directory });
		assert.equal(reconstructed.status(mismatch.ref.sourceId).state, "corrupt");

		const missing = reconstructed.begin("missing-content");
		missing.appendProcessText("gone");
		await missing.finalize();
		await unlink(join(directory, `${missing.ref.sourceId}.data`));
		assert.equal((await reconstructed.read(missing.ref.sourceId)).state, "missing");
	});

	it("bounds expired tombstones deterministically", async () => {
		let now = 0;
		const directory = await root();
		const store = new OutputSourceStore({ root: directory, clock: () => now, completedTtlMs: 1, tombstoneTtlMs: 1_000, maxTombstones: 1 });
		const one = store.begin("one"); one.appendProcessText("1"); await one.finalize();
		const two = store.begin("two"); two.appendProcessText("2"); await two.finalize();
		now = 2;
		await store.sweep();
		const states = [store.status(one.ref.sourceId).state, store.status(two.ref.sourceId).state].sort();
		assert.deepEqual(states, ["expired", "missing"]);
	});

	it("reclaims incomplete, corrupt, and orphan storage without touching active captures", async () => {
		let now = 10_000;
		const directory = await root();
		const store = new OutputSourceStore({ root: directory, clock: () => now, aggregateBytes: 8, completedTtlMs: 100, tombstoneTtlMs: 50 });
		const incomplete = store.begin("incomplete-expiry");
		incomplete.appendProcessText("abcd");
		await incomplete.markIncomplete("cancelled");
		const active = store.begin("active-capture");
		const orphanCapture = join(directory, "11111111-1111-4111-8111-111111111111.capture");
		const orphanData = join(directory, "33333333-3333-4333-8333-333333333333.data");
		const orphanTemp = join(directory, "orphan.manifest.json.dead.tmp");
		await writeFile(orphanCapture, "orphan");
		await writeFile(orphanData, "orphan");
		await writeFile(orphanTemp, "orphan");
		await utimes(orphanCapture, new Date(0), new Date(0));
		await utimes(orphanData, new Date(0), new Date(0));
		await utimes(orphanTemp, new Date(0), new Date(0));

		now += 101;
		await store.sweep();
		assert.equal(store.status(incomplete.ref.sourceId).state, "expired");
		assert.equal(store.status(active.ref.sourceId).state, "capturing");
		assert.ok((await readdir(directory)).includes(`${active.ref.sourceId}.capture`));
		assert.ok(!(await readdir(directory)).includes("11111111-1111-4111-8111-111111111111.capture"));
		assert.ok(!(await readdir(directory)).includes("33333333-3333-4333-8333-333333333333.data"));
		assert.ok(!(await readdir(directory)).includes("orphan.manifest.json.dead.tmp"));
		active.appendProcessText("abcd");
		assert.equal(store.status(active.ref.sourceId).state, "capturing");

		now += 51;
		await store.sweep();
		assert.equal(store.status(incomplete.ref.sourceId).state, "missing");
		await active.markIncomplete("test-cleanup");
	});

	it("expires discovered corrupt records into bounded tombstones", async () => {
		let now = 1_000;
		const directory = await root();
		const sourceId = "22222222-2222-4222-8222-222222222222";
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, `${sourceId}.manifest.json`), "{not-json", { mode: 0o600 });
		const store = new OutputSourceStore({ root: directory, clock: () => now, completedTtlMs: 100, tombstoneTtlMs: 50 });
		assert.equal(store.status(sourceId).state, "corrupt");
		now += 101;
		await store.sweep();
		assert.equal(store.status(sourceId).state, "expired");
		now += 51;
		await store.sweep();
		assert.equal(store.status(sourceId).state, "missing");
	});
});
