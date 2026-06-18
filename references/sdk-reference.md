# TypeScript SDK Reference

Install:

```bash
npm install @paperproof/sdk-ts@0.2.6 @mysten/sui@^2.16.0
```

Use `0.2.6` as the known-compatible baseline captured by this skill. If a newer SDK is installed, inspect its release notes or exported `MAINNET_DEPLOYMENT` before writing to mainnet.

Initialize:

```ts
import { createPaperProofSDK, MAINNET_DEPLOYMENT } from '@paperproof/sdk-ts';

const paperproof = createPaperProofSDK({ network: 'mainnet' });
```

## Main Exports to Look For

- `createPaperProofSDK`
- `MAINNET_DEPLOYMENT`
- `createDeployment`
- `ARTIFACT_TYPES`
- `SERIES_STATUS`
- `TREE_STATUS`
- `FEE_LEVEL`
- `extractPublishResult`
- `extractAddVersionResult`
- `filterCanonicalPaperProofEvents`
- `verifyDeployment`
- `checkDeploymentUpdate`
- `robustExecuteTransaction`
- `robustWalrusWriteBlob`
- `robustWalrusExtendBlob`
- `readAndVerifyWalrusContent`
- `walrusReferenceFromVersion`
- prompt helpers such as `promptPackageToGenericFileInput`

## Transaction Builders

Use `paperproof.txb` to build unsigned transactions:

```ts
const tx = paperproof.txb.publishGenericFile({
  title,
  description,
  filename,
  fileSize,
  license,
  contentHash,
  walrusBlobId,
  walrusBlobObjectId,
  contentType,
});
```

Supported publish builders:

- `reservePreprintCode(owner)` then `finalizeReservedPreprint(reservationId, input)`
- `publishBlogPost(input)`
- `publishTechnicalReport(input)`
- `publishDataset(input)`
- `publishSoftwareRelease(input)`
- `publishGenericFile(input)`

Supported add-version builders:

- `addPreprintVersion(input)`
- `addBlogPostVersion(input)`
- `addTechnicalReportVersion(input)`
- `addDatasetVersion(input)`
- `addSoftwareReleaseVersion(input)`
- `addGenericFileVersion(input)`

Other builders:

- `updateSeriesMetadata(seriesId, metadata)`
- `transferArtifactOwner(input)`
- `paperproof.txb.prompts.registerPrompt(input)`
- `paperproof.txb.memory.createEntry(input)`
- `paperproof.txb.memory.updatePointer(input)`
- `paperproof.txb.memory.deleteOwnEntry({ entryId })`

## Execution Pattern

For browser wallets, build a transaction and let the wallet sign. For Node tools, only use an explicit signer if the user configured one.

```ts
const execution = await robustExecuteTransaction(provider, signer, tx, 'publish generic file', {
  showEffects: true,
  showEvents: true,
  showObjectChanges: true,
});
```

Extract results:

```ts
const published = extractPublishResult(execution, MAINNET_DEPLOYMENT);
console.log(published.seriesId, published.versionId, published.artifactCode);
```

## Walrus Pattern

Upload bytes first, then register the returned blob references in PaperProof:

```ts
const upload = await robustWalrusWriteBlob(walrusClient, signer, fileBytes, {
  epochs: 10,
  deletable: false,
});
```

When verifying:

```ts
const reference = walrusReferenceFromVersion(versionView);
const content = await readAndVerifyWalrusContent(walrusClient, reference);
```

## Deployment Drift

At startup or before important writes, use deployment verification and update checks. If a manifest says packages changed, create an override with `createDeployment(MAINNET_DEPLOYMENT, override)` instead of scattering IDs in application code.

## If the SDK Is Missing

When a runtime cannot install the SDK, continue with read-only planning when possible:

- use deployment constants from `protocol-map.md`;
- read Sui objects directly by ID;
- query package-scoped PaperProof events;
- read Walrus blobs by version header references;
- prepare metadata JSON and an unsigned transaction plan.

For mainnet writes, prefer pausing at a clear handoff rather than reconstructing complex transaction builders from memory.

## Skill Helper Scripts

After cloning the skill repository, run `npm install` to enable protocol helper scripts. They are intentionally website-independent.

Read-only scripts:

- `node scripts/check-wallet.mjs --address=<wallet>`
- `node scripts/read-object.mjs --id=<objectId>`
- `node scripts/query-series.mjs --series=<seriesId>`
- `node scripts/query-events.mjs --module=publishing --event=ArtifactPublishedEvent --limit=20`

Preparation scripts:

- `node scripts/file-digest.mjs <file> <content-type>`
- `node scripts/metadata-template.mjs <artifactType>`
- `node scripts/plan-publish.mjs --type=<artifactType> --input=<metadata.json>`

These scripts do not sign or submit user transactions. For writes, use the returned plan to build SDK transactions and hand them to a user-controlled wallet or explicitly configured signer.
