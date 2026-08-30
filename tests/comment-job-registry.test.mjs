import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(projectRoot, "src/comment-job-registry.js"), "utf8");
vm.runInThisContext(source, { filename: "comment-job-registry.js" });

const registry = globalThis.CaptionLiteCommentJobs.createRegistry();

const oldJob = registry.begin(7);
assert.equal(oldJob.isCurrent(), true);
registry.invalidate(7); // A -> B
registry.invalidate(7); // B -> A
assert.equal(oldJob.isCurrent(), false);
assert.equal(oldJob.signal.aborted, true);

const currentJob = registry.begin(7);
const otherTabJob = registry.begin(8);
assert.equal(currentJob.isCurrent(), true);
assert.equal(otherTabJob.isCurrent(), true);
registry.complete(currentJob);
assert.equal(currentJob.isCurrent(), false);
assert.equal(otherTabJob.isCurrent(), true);

console.log("Comment job registry checks passed.");
