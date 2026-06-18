# Publish Workflows

Publishing writes to Walrus and Sui mainnet. Tell the user what will be public and ask for confirmation before any irreversible write.

Publishing does not require any PaperProof website. Use the website only after publication as an optional preview or sharing surface.

## New Artifact Flow

1. **Classify** the artifact type. Read `artifact-types.md` if uncertain.
2. **Collect files** and confirm final content bytes.
3. **Collect metadata** required by that artifact type.
4. **Check wallet readiness**: address, SUI gas, WAL/storage path, and selected signer.
5. **Hash content** with SHA-256 or SDK helper. Keep the exact bytes stable after hashing.
6. **Upload to Walrus** and record `walrusBlobId` and `walrusBlobObjectId`.
7. **Build PaperProof transaction** using `@paperproof/sdk-ts` transaction builders.
8. **Ask wallet to sign and execute**. Do not bypass wallet review.
9. **Extract canonical result** with SDK result helpers.
10. **Verify** the created series/version/comments/likes objects are readable.
11. **Return IDs** and verification status.

Useful helpers before step 7:

- `file-digest.mjs` for hash and file size;
- `metadata-template.mjs` for typed metadata shape;
- `plan-publish.mjs` for missing field checks and SDK builder selection;
- `check-wallet.mjs` for SUI/WAL/PPRF readiness.

## Add-Version Flow

1. Resolve the target series and current artifact type.
2. Confirm the wallet is allowed to add a version, normally the artifact owner or permitted operator depending on protocol state.
3. Prepare new bytes and metadata.
4. Upload the new bytes to Walrus.
5. Build the typed add-version transaction: `addBlogPostVersion`, `addTechnicalReportVersion`, `addDatasetVersion`, `addSoftwareReleaseVersion`, `addGenericFileVersion`, or the preprint version flow.
6. Execute and verify that the series current version now points to the new version.
7. Report both old and new version IDs when available.

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

## Official Content Defaults

- Docs: publish as `genericFile`; lock comments; use stable docs path metadata.
- Blog: publish as `blogPost`; prefer Markdown package zip; official posts may lock comments.
- Forum starter topics: publish as `blogPost`; keep comments open.
- Native prompts: publish as `genericFile` with content type `application/vnd.paperproof.prompt+json`, then register route in PromptRegistry.

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
