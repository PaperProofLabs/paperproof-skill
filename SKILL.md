---
name: paperproof-protocol
description: Operate the PaperProof protocol for AI agents and developer assistants. Use when a user asks to publish, update, query, verify, inspect, or explain PaperProof artifacts, versions, comments, governance, native prompts, Agent Memory registrations, Walrus content, Sui package/object bindings, wallet readiness, or SDK-based PaperProof workflows. Prefer protocol, SDK, Sui, Walrus, and indexer interfaces over browser automation or website clicking.
---

# PaperProof Protocol

Use this skill as a protocol client guide, not as a website automation guide. Prefer `@paperproof/sdk-ts`, Sui clients, Walrus clients, and indexer APIs. The skill must remain useful if every PaperProof website or UI disappears. Use websites only for optional human preview links or when the user explicitly requests browser interaction.

The skill is suitable for community PaperProof users, developers, operators, researchers, and AI agents. Keep it useful for third-party PaperProof applications and user-owned artifacts; avoid project-private mappings, unpublished operational assumptions, or PaperProof Labs internal-only shortcuts unless the user explicitly provides that context.

## First Decision

Classify the user request before acting:

- **Publish**: create a new PaperProof artifact series and first version.
- **Add version**: update an existing series without erasing earlier versions.
- **Query**: find artifacts, series, versions, owner activity, events, comments, governance, prompts, or memory entries.
- **Verify**: check chain bindings, canonical events, Walrus content, hashes, deployment IDs, or provenance.
- **Prepare**: choose an artifact type, draft metadata, build a publication checklist, or package files.
- **Operate application registries**: native prompts, Agent Memory registry, governance-controlled availability, or application content publishing.

If the request is broad, ask one short clarifying question only when the missing choice blocks safe action. Otherwise choose conservative defaults and continue.

## When Not To Use This Skill

- The user only wants general Sui or Walrus help with no PaperProof artifact, registry, or verification context.
- The user asks for website styling, marketing copy, or frontend layout unrelated to protocol operations.
- The user asks for private-key extraction, seed phrase handling, or custodial wallet management.
- The user asks to bypass wallet review, governance authority, registry permissions, CORS, or chain validation.

## Non-Negotiable Rules

- Do not ask for or store private keys, seed phrases, or wallet secrets.
- Do not sign transactions for the user unless the runtime already has an explicit signer chosen by the user.
- Tell the user before any operation that writes to Sui mainnet or Walrus.
- Treat Sui objects, PaperProof events, Walrus blobs, and SDK deployment constants as protocol facts; do not infer facts from website DOM.
- Do not require the official website for publishing, querying, verifying, prompt operations, memory operations, or wallet readiness checks.
- For Walrus-backed artifacts, verify the bytes against the version content hash when the task is verification-sensitive.
- If a write depends on shared Sui objects, rebuild the transaction before retrying.
- If a task touches official registries or governance permissions, confirm the caller has authority before building write transactions.

## Reference Routing

- Read `references/protocol-map.md` for core objects, deployment constants, and package IDs.
- Read `references/artifact-types.md` when selecting an artifact type or filling metadata.
- Read `references/publish-workflows.md` for new publications, add-version flows, comments defaults, and Walrus staging.
- Read `references/query-verify-workflows.md` for reads, canonical event checks, Walrus verification, and reporting.
- Read `references/wallet-and-funding.md` for wallet, SUI, WAL, signing, and balance readiness checks.
- Read `references/official-registries.md` for native prompts, Agent Memory registry, governance control, and application-managed registry patterns.
- Read `references/error-handbook.md` when diagnosing failed transactions, relayers, Walrus reads, or Move aborts.
- Read `references/sdk-reference.md` when writing code with the TypeScript SDK.
- Read `references/agent-task-patterns.md` when turning natural-language user requests into concrete PaperProof actions.

## Default Execution Pattern

1. Restate the detected task type and any irreversible action.
2. Gather missing inputs: wallet address, target artifact/series, files, metadata, desired visibility, and whether comments should be open or locked.
3. Check readiness: Sui network, deployment constants, wallet balance, WAL/storage path, file hashes, and authority if applicable.
4. Use the SDK or direct protocol APIs to prepare the operation.
5. For writes, return an unsigned transaction or ask the user's wallet/signer to review and sign.
6. After execution, extract and report artifact code, series ID, version ID, comments tree ID, likes book ID, Walrus blob ID/object ID, transaction digest, and preview URL if available.
7. For reads, distinguish missing data, expired Walrus content, non-canonical events, and temporary transport failures.

## Package Baseline

Use the published TypeScript SDK when possible:

```bash
npm install @paperproof/sdk-ts@0.2.7 @mysten/sui@^2.16.0
```

Initialize with:

```ts
import { createPaperProofSDK, MAINNET_DEPLOYMENT } from '@paperproof/sdk-ts';

const paperproof = createPaperProofSDK({ network: 'mainnet' });
```

Use `MAINNET_DEPLOYMENT` unless the user explicitly provides an upgraded deployment manifest.

## SDK Fallbacks

If `@paperproof/sdk-ts` is unavailable:

1. Install it in a temporary Node project when the environment allows package installation.
2. If installation is blocked, use direct Sui object reads, Move call targets, Walrus APIs, and the deployment constants in `references/protocol-map.md`.
3. If writes cannot be prepared safely, stop at a publication checklist or unsigned transaction plan.
4. Never simulate a website click path as a substitute for missing protocol capability unless the user explicitly asks for website operation.

## Helper Scripts

The `scripts/` folder contains protocol-oriented helpers. They do not require the PaperProof website.

- `mainnet-config.mjs`: print canonical mainnet package, object, and coin constants.
- `file-digest.mjs`: compute filename, byte size, and `sha256` content hash.
- `metadata-template.mjs`: print an input template for each artifact type.
- `plan-publish.mjs`: validate publish/add-version metadata and return the SDK builder plan.
- `check-wallet.mjs`: query SUI, WAL, and PPRF balances for a wallet address.
- `read-object.mjs`: read a Sui object by ID with content and owner fields.
- `query-series.mjs`: use the SDK to read a PaperProof series, current version, comments tree, and likes book.
- `query-events.mjs`: query PaperProof events using SDK query providers.
- `add-version-from-local-file.mjs`: dry-run or execute a controlled add-version flow for a local PDF/file. Dry-run is read-only; `--run` requires an explicit user-controlled signer environment and uploads to Walrus.
- `extend-walrus-retention.mjs`: inspect current Walrus retention windows for selected artifacts and optionally batch-extend them to a target epoch window.

If a helper needs dependencies, run `npm install` in the skill directory. Helpers that write to chain must use the user's explicit wallet/signer. Do not ask community users to reveal secrets; for local signer helpers, the user must already control their own signer environment. Prefer unsigned or dry-run modes until the user has chosen a signer path.

## Retention Workflow

Use `extend-walrus-retention.mjs` when the task is about Walrus retention
windows and extension operations, not about one website page.

This helper answers three questions:

1. which latest versions or blob objects still have too-short Walrus retention;
2. what their current `start_epoch -> end_epoch` window is;
3. how to extend them efficiently, preferably in batch.

Typical entry points:

- `--explore-types=...` to scan active artifacts from an indexer/explore API;
- `--series-json=...` to scan an explicit JSON list of series;
- `--manifest-json=...` to extract artifact records from app manifest JSON.

Dry-run first:

```powershell
node .\scripts\extend-walrus-retention.mjs --series-json=.\artifacts\series.json
```

Real extension:

```powershell
node .\scripts\extend-walrus-retention.mjs --run --signer-env=..\paperproof-contracts\jstest\.env --explore-types=1,2,3,4,5
```

Default target window is `10 epochs`. Batch mode is preferred; sequential mode
is mainly for debugging or explicit one-by-one operation.

## Output Style

For user-facing task results, include:

- **What happened**: publish/add-version/query/verify outcome.
- **Protocol IDs**: artifact code, series ID, version ID, blob ID/object ID, and transaction digest when available.
- **Confidence**: verified, partially verified, unavailable, or failed.
- **Next action**: only when the user must sign, top up funds, upload a file, renew a blob, or choose metadata.
