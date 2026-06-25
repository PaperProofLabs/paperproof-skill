# Publish Workflows

Publishing writes to Walrus and Sui mainnet. Tell the user what will be public and ask for confirmation before any irreversible write.

Publishing does not require any PaperProof website. Use the website only after publication as an optional preview or sharing surface.

## New Artifact Flow

1. **Classify** the artifact type. Read `artifact-types.md` if uncertain.
2. **Collect files** and confirm final content bytes.
3. **Collect metadata** required by that artifact type.
4. **Validate metadata locally before any upload**: required fields, metadata extension counts, string lengths, and the intended SDK builder.
5. **Check wallet readiness**: address, SUI gas, WAL/storage path, and selected signer.
6. **Hash content** with SHA-256 or SDK helper. Keep the exact bytes stable after hashing.
7. **Upload to Walrus** only after local metadata validation passes, then record `walrusBlobId` and `walrusBlobObjectId`.
   Use a 10-epoch storage baseline unless the user explicitly asks for a different Walrus retention period.
8. **Build PaperProof transaction** using `@paperproof/sdk-ts` transaction builders.
9. **Ask wallet to sign and execute**. Do not bypass wallet review.
10. **Extract canonical result** with SDK result helpers.
11. **Verify** the created series/version/comments/likes objects are readable.
12. **Return IDs** and verification status.

Useful helpers before step 7:

- `file-digest.mjs` for hash and file size;
- `metadata-template.mjs` for typed metadata shape;
- `plan-publish.mjs` for missing field checks and SDK builder selection;
- `check-wallet.mjs` for SUI/WAL/PPRF readiness.

Run `plan-publish.mjs` twice when using generated metadata: once with placeholder
Walrus IDs to catch schema and metadata-extension errors before upload, then once
with final `walrusBlobId` and `walrusBlobObjectId` before building the chain
transaction. This avoids wasting a Walrus upload on metadata that the SDK will
reject.

For signer selection, keep community workflows generic:

- use unsigned/dry-run flows first;
- prefer browser wallet or local CLI signing for third-party users;
- use environment-managed signer material only when the user already controls that runtime.

## Add-Version Flow

1. Resolve the target series and current artifact type.
2. Confirm the wallet is allowed to add a version, normally the artifact owner or permitted operator depending on protocol state.
3. Prepare new bytes and metadata.
4. Run a transport-aware preflight before any upload.
   Check RPC reachability, Walrus relay reachability, signer resolution, SUI/WAL/PPRF balance reads, and target series readability.
5. Validate the add-version metadata locally before any upload.
6. Upload the new bytes to Walrus.
   Use a 10-epoch storage baseline unless the user explicitly asks for a different Walrus retention period.
7. Build the typed add-version transaction: `addBlogPostVersion`, `addTechnicalReportVersion`, `addDatasetVersion`, `addSoftwareReleaseVersion`, `addGenericFileVersion`, or the preprint version flow.
8. Execute and distinguish four operator-facing states:
   `uploadOk`, `transactionSubmitted`, `chainResultObserved`, and `latestVersionConfirmed`.
9. If the final latest-version readback fails, do not treat that alone as a confirmed chain failure.
   Return the transaction digest and a follow-up `query-series.mjs` confirmation command.
10. Report both old and new version IDs when available.

### Add-Version Helper Flags

`add-version-from-local-file.mjs` supports transport and readiness controls so community users can adapt to endpoint instability without changing protocol flow:

- `--preflight`
- `--rpc=<url>`
- `--transport=grpc|jsonrpc`
- `--query-transport=none|jsonrpc|graphql|fallback`
- `--walrus-relay=<url>`
- `--retry-attempts=<n>`
- `--retry-base-ms=<ms>`
- `--confirm-attempts=<n>`
- `--confirm-delay-ms=<ms>`

Recommended community default:

- read path on `jsonrpc`
- query path on `fallback`
- explicit preflight before `--run`

## Preprint Reserved Flow

Current direct preprint publishing is disabled. Use:

1. `paperproof.txb.reservePreprintCode(ownerAddress)`
2. User signs reservation transaction.
3. Upload final preprint content to Walrus.
4. `paperproof.txb.finalizeReservedPreprint(reservationId, input)`
5. User signs finalize transaction.

Do not present this as a single atomic transaction.

## Transaction Boundaries

- Chain calls that belong to the same stage may be composed in one PTB.
- Walrus reservation/upload/certification and Sui registration may have separate boundaries.
- If a shared object conflict occurs, rebuild the transaction with fresh object versions.
- Never reuse transaction bytes after a failed shared-object write unless the SDK explicitly marks it safe.

## Application Content Defaults

- Docs: publish as `genericFile`; lock comments; use stable docs path metadata.
- Blog: publish as `blogPost`; prefer Markdown package zip; application posts may lock comments.
- Forum starter topics: publish as `blogPost`; keep comments open.
- Native prompts: publish as `genericFile` with content type `application/vnd.paperproof.prompt+json`, then register route in PromptRegistry.

## Metadata Extension Limits

The current SDK rejects oversized metadata extension arrays before transaction
construction. Keep these constraints in mind before uploading content to Walrus:

- `seriesMetadata`: at most 4 entries.
- `versionMetadata`: at most 4 entries.
- Each metadata key/value should stay concise; long values may be truncated by
  helper scripts or rejected by SDK validation.
- Put long source notes, file manifests, and schemas inside the artifact content
  package rather than on chain.

For datasets, prefer putting `README.md`, `schema.json`, and `sources.json` in
the zip package, while keeping chain metadata to high-value identifiers such as
dataset version, record count, coverage years, package hash, SDK version, and
Walrus epoch count. The current official baseline is 10 epochs.

## Result Checklist

Return:

- artifact code
- artifact type
- series ID
- version ID
- comments tree ID
- likes book ID
- Walrus blob ID
- Walrus blob object ID
- content hash
- transaction digest
- whether content was read back and hash-verified
