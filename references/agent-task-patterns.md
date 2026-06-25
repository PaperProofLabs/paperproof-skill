# Agent Task Patterns

Use this reference to translate natural-language requests into PaperProof protocol tasks. Prefer concrete next actions over long protocol explanations.

## Common User Requests

| User says | Interpret as | First action |
|---|---|---|
| "Publish this paper" | New `preprint` or `technicalReport` | Ask whether it is research/preprint or formal report |
| "Put this file on PaperProof" | New artifact, often `genericFile` | Inspect file type and ask for title/license if missing |
| "Update this artifact" | Add version | Resolve series ID/artifact code and confirm ownership |
| "Can I publish with this wallet?" | Wallet readiness check | Query SUI and WAL/storage capability |
| "Is this artifact real?" | Verification | Resolve series/version, check package IDs and events |
| "Why does the body not load?" | Content/Walrus diagnosis | Read version header and test Walrus blob availability |
| "Make this AI-usable" | Prepare metadata/package | Choose artifact type and draft machine-readable metadata |
| "Publish an app prompt" | Native prompt registry workflow | Confirm operator authority and route ID |
| "Create memory for this agent" | Memory registry workflow | Confirm app ID, owner, provider, and one-active-entry policy |

## Helper Script Routing

- Wallet readiness: run `node scripts/check-wallet.mjs --address=<wallet>`.
- File hash and size: run `node scripts/file-digest.mjs <file> <content-type>`.
- Metadata draft: run `node scripts/metadata-template.mjs <artifactType>`.
- Publish readiness: run `node scripts/plan-publish.mjs --type=<artifactType> --input=<metadata.json>`.
- Add-version readiness: add `--series=<seriesId>` to `plan-publish.mjs`.
- Local-file add version dry-run: run `node scripts/add-version-from-local-file.mjs --type=<preprint|technicalReport|genericFile> --series=<seriesId> --file=<path>` first without `--run`.
- Walrus retention inspection: run `node scripts/extend-walrus-retention.mjs --series-json=<file>` or `--manifest-json=<file>` first without `--run`.
- Object inspection: run `node scripts/read-object.mjs --id=<objectId>`.
- Series inspection: run `node scripts/query-series.mjs --series=<seriesId>`.
- Event lookup: run `node scripts/query-events.mjs --module=publishing --event=ArtifactPublishedEvent` or pass `--moveEventType=<type>`.
- Governance config/proposal inspection: run `node scripts/query-governance.mjs` or `node scripts/query-governance.mjs --proposal=<id|objectId>`.
- Governance signal proposal dry-run: run `node scripts/create-signal-proposal.mjs --preflight --title="..." --description="..." --stake-pprf=<amount>`.
- Governance vote dry-run: run `node scripts/vote-proposal.mjs --preflight --proposal=<id|objectId> --side=yes|no --stake-pprf=<amount>`.

On Windows PowerShell, avoid plain `>` redirection when generating JSON for
Node helpers because it may write UTF-16. Use `Set-Content -Encoding utf8` or
write the JSON file from Node/Python instead.

## Mainnet Publish Pattern

For generated or packaged artifacts, use this order to avoid unnecessary Walrus
uploads:

1. Create the final package bytes locally.
2. Compute `sha256` and byte size.
3. Draft metadata with placeholder `walrusBlobId` and `walrusBlobObjectId` if
   the final IDs are not known yet.
4. Run `plan-publish.mjs` and fix missing fields or metadata-extension issues.
5. Check wallet readiness.
6. Upload to Walrus only after the local plan is valid.
7. Replace placeholder Walrus references and run `plan-publish.mjs` again.
8. Build and execute the SDK transaction with the user's explicit signer.
9. Read back the series/version and verify the Walrus blob hash when possible.

For dataset packages, keep chain metadata sparse. Put source notes, schemas,
field descriptions, and file manifests inside the zip package rather than in
`seriesMetadata` or `versionMetadata`.

## Mainnet Add-Version Pattern

Use this order when replacing the latest content of an existing series:

1. Resolve the target series from the user's artifact code, series ID, wallet
   history, or indexer search, then run `query-series.mjs`.
2. Confirm artifact type, owner, current version ID, and current content hash.
3. Hash the local replacement file and stop if the hash already equals current.
4. Reuse current typed metadata unless the user explicitly requested metadata
   changes; put provenance in short `versionMetadata` entries.
5. Dry-run `add-version-from-local-file.mjs` without signer material, or build
   the SDK transaction locally without Walrus upload.
6. Tell the user before writing to Walrus or Sui mainnet.
7. Upload to Walrus, build the typed add-version transaction, execute with the
   explicit signer or wallet, and extract `extractAddVersionResult`.
8. Query the series again and verify `currentVersionId` and content hash.

## Intent Checklist

Before writing code or building a transaction, identify:

- target network;
- user role: ordinary publisher, app developer, registry operator, governance participant, or auditor;
- task mode: publish, add version, query, verify, package, or administer registry;
- object identifier: artifact code, series ID, version ID, wallet address, route ID, or provider entry;
- content source: local file, URL, generated text, zip package, PDF, JSON, or existing Walrus blob;
- whether comments should be open, locked, or archived;
- whether the task is read-only or requires wallet signing.

## Conservative Defaults

- Use `mainnet` when the user talks about live PaperProof artifacts and does not name a test network.
- Use `genericFile` for arbitrary files and protocol packages when no specific artifact type fits.
- Use Markdown package zip for blog-like content that may later gain images.
- Keep comments open for forum topics and ask before locking user-published artifacts.
- Lock comments for docs, prompts, and configuration artifacts unless told otherwise.
- Prefer latest-version policy for ordinary native prompt updates; use pinned versions only for controlled rollout.

## User-Facing Explanations

Explain PaperProof in operational terms:

- A series is the stable identity.
- A version is a specific content record.
- Walrus stores bytes.
- Sui stores identity, metadata, references, governance, and verification bindings.
- Comments and likes are protocol objects bound to the series.

Avoid forcing users to learn every object before acting. Ask for the smallest missing input needed to proceed.

## Website Independence

Do not assume `paperproof.site` or any other website is available. Natural-language PaperProof usage should resolve to protocol operations: metadata preparation, Walrus storage, Sui transactions, indexer/canonical event reads, and SDK object views. Preview URLs are optional outputs, not required inputs.

## Write Confirmation Template

Before mainnet writes, say:

```text
This will write to Sui mainnet and/or Walrus. The content reference, metadata, and transaction record will be public and persistent. I will prepare the transaction, and your wallet must review and sign it.
```

Then list the artifact type, title, file hash, target series if any, comments policy, and estimated assets needed.

## Result Summary Template

After a successful operation, return:

```text
Published/updated: <title>
Artifact type: <type>
Artifact code: <code>
Series ID: <id>
Version ID: <id>
Walrus blob: <blob id>
Transaction: <digest>
Verification: <verified/partially verified/not checked>
```
