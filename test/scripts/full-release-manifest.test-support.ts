import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { expect } from "vitest";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";

const repository = "openclaw/openclaw";
const workflow = ".github/workflows/full-release-artifacts.yml";
const token = "synthetic-manifest-artifact-token";
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Keep the real manifest writer and artifact validators; replace only external I/O. */
export async function createManifestPublicationFixture(
  directory: string,
  identity: { targetSha: string; workflowSha: string; workflowFullRef: string },
) {
  const producer = {
    repository,
    workflowRef: `${repository}/${workflow}@${identity.workflowFullRef}`,
    workflowSha: identity.workflowSha,
    runId: "81",
    runAttempt: "1",
    jobId: "902",
    jobName: "Prepare npm artifacts / Qualify prepared npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const diff = { entrypointsAdded: [], entrypointsRemoved: [], exports: [] };
  const digest = sha256(JSON.stringify(diff));
  const npmManifest = {
    releaseSha: identity.targetSha,
    pluginSdkApi: createPluginSdkApiReleaseEvidence({
      baseRef: "v2026.9.8",
      baseSha: "e".repeat(40),
      headSha: identity.targetSha,
      workflowSha: identity.workflowSha,
      diff: { ...diff, digest },
    }),
  };
  const manifestBytes = JSON.stringify(npmManifest);
  const zip = new JSZip();
  zip.file("preflight-manifest.json", manifestBytes);
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "STORE",
    platform: "UNIX",
  });
  const qualified = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: { sha: identity.targetSha },
    producer,
    manifestSha256: sha256(manifestBytes),
    artifact: {
      id: "402",
      name: `openclaw-npm-preflight-${identity.targetSha}`,
      digest: sha256(archive),
      runId: producer.runId,
      runAttempt: producer.runAttempt,
    },
  };
  const run = {
    id: Number(producer.runId),
    run_attempt: Number(producer.runAttempt),
    event: "workflow_dispatch",
    path: `${workflow}@${identity.workflowFullRef}`,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_sha: identity.workflowSha,
    head_branch: identity.workflowFullRef.replace(/^refs\/(?:heads|tags)\//u, ""),
    status: "completed",
    conclusion: "success",
  };
  const artifact = {
    id: Number(qualified.artifact.id),
    name: qualified.artifact.name,
    digest: `sha256:${qualified.artifact.digest}`,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2099-10-01T00:00:00Z",
    workflow_run: { id: run.id, head_sha: identity.workflowSha },
  };
  const runPath = `repos/${repository}/actions/runs/${producer.runId}`;
  const artifactPath = `repos/${repository}/actions/artifacts/${qualified.artifact.id}`;
  const responses = {
    [runPath]: run,
    [`${runPath}/attempts/1`]: run,
    [`${runPath}/attempts/1/jobs?per_page=100&page=1`]: {
      total_count: 1,
      jobs: [
        {
          id: Number(producer.jobId),
          name: producer.jobName,
          run_id: run.id,
          run_attempt: run.run_attempt,
          head_sha: identity.workflowSha,
          status: "completed",
          conclusion: "success",
        },
      ],
    },
    [artifactPath]: artifact,
  };
  const bin = join(directory, "bin");
  const responsesPath = join(directory, "external-responses.json");
  const archivePath = join(directory, "preflight.zip");
  const callsPath = join(directory, "external-calls.jsonl");
  const preloadPath = join(directory, "external-fetch.mjs");
  mkdirSync(bin);
  writeFileSync(archivePath, archive);
  writeFileSync(callsPath, "");
  writeFileSync(responsesPath, JSON.stringify(responses));
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const responses = JSON.parse(readFileSync(${JSON.stringify(responsesPath)}, "utf8"));
if (args[0] !== "api" || !Object.hasOwn(responses, args[1])) throw new Error("Unexpected GitHub command");
for (let i = 2; i < args.length; i += 2) {
  if (args[i] === "--method" && args[i + 1] === "GET") continue;
  if (args[i] === "--jq" && args[i + 1] === "{total_count,jobs:[.jobs[] | {id,name,run_id,run_attempt,head_sha,status,conclusion}]}") continue;
  throw new Error("Unexpected GitHub command option");
}
if (process.env.GH_TOKEN !== ${JSON.stringify(token)}) throw new Error("Expected synthetic credential");
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(["gh", args[1]]) + "\\n");
process.stdout.write(JSON.stringify(responses[args[1]]));
`,
    { mode: 0o755 },
  );
  const artifactUrl = `https://api.github.com/${artifactPath}`;
  const registryUrl = "https://registry.npmjs.org/openclaw";
  writeFileSync(
    preloadPath,
    `import { appendFileSync, readFileSync } from "node:fs";
globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  if ((init.method ?? (input instanceof Request ? input.method : "GET")) !== "GET") throw new Error("Unexpected fetch mutation");
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(["fetch", url]) + "\\n");
  if (url === ${JSON.stringify(registryUrl)}) return Response.json({
    versions: { "2026.9.8": {} }, "dist-tags": { latest: "2026.9.8", beta: "2026.9.8" }
  });
  if (new Headers(init.headers).get("authorization") !== ${JSON.stringify(`Bearer ${token}`)}) throw new Error("Expected synthetic artifact credential");
  if (url === ${JSON.stringify(artifactUrl)}) return Response.json(${JSON.stringify(artifact)});
  if (url === ${JSON.stringify(`${artifactUrl}/zip`)}) return new Response(readFileSync(${JSON.stringify(archivePath)}));
  throw new Error("Unexpected fetch URL: " + url);
};
`,
  );
  return {
    env: {
      GH_TOKEN: token,
      GITHUB_TOKEN: "",
      QUALIFIED_NPM_BUNDLE_JSON: JSON.stringify(qualified),
      NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
      PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
    },
    expectSealed(manifest: { publishInputs?: unknown }) {
      expect(manifest.publishInputs).toEqual({
        version: 1,
        targetSha: identity.targetSha,
        npmDistTag: "latest",
        pluginSdkApiAcknowledgement: "",
        pluginSdkApiEvidenceDigest: digest,
        stableSoakWaiver: "",
        npmDecisions: [
          {
            packageName: "openclaw",
            packageVersion: "2026.9.9",
            plan: { channel: "stable", publishTag: "latest", mirrorDistTags: ["beta"] },
            decision: "plan",
            route: null,
            supersededBy: null,
            bootstrap: false,
          },
        ],
      });
      expect(new Set(readFileSync(callsPath, "utf8").trim().split("\n"))).toEqual(
        new Set([
          ...Object.keys(responses).map((endpoint) => JSON.stringify(["gh", endpoint])),
          ...[artifactUrl, `${artifactUrl}/zip`, registryUrl].map((url) =>
            JSON.stringify(["fetch", url]),
          ),
        ]),
      );
    },
  };
}
