# Query and Verify Workflows

Use query flows when the user asks what exists. Use verify flows when the user asks whether something is authentic, current, readable, canonical, or safe to rely on.

## Query Targets

- Artifact code
- Series ID
- Version ID
- Owner address
- Artifact type
- Comment tree ID
- Governance proposal ID or object ID
- Prompt route ID
- Memory owner/app/provider entry
- Walrus blob ID or blob object ID

## Recommended Sources

1. SDK read/query clients.
2. Direct Sui object reads for authoritative object fields.
3. Canonical PaperProof event filters for event history.
4. PaperProof indexer for fast feeds and search.
5. Walrus read APIs for content bytes.

Do not rely on website-rendered state for protocol verification.

## Artifact Verification

For a series or artifact code:

1. Resolve the series object.
2. Read current version ID and full version list.
3. Read the selected version object.
4. Check artifact type and package IDs match `MAINNET_DEPLOYMENT`.
5. Check comments tree and likes book bindings match the series.
6. Derive Walrus reference from version header.
7. Read Walrus bytes when required.
8. Hash bytes and compare with version `contentHash`.
9. Report whether the content is verified, chain-only verified, unavailable, or mismatched.

## Event Verification

- Accept only events emitted by configured PaperProof package IDs.
- For publish events, confirm emitted series/version/comments/likes IDs match readable objects.
- For add-version events, confirm the version belongs to the target series and appears in the version list.
- For governance events, confirm proposal object and package bindings.
- Treat incomplete event pages as unknown, not empty.

## Walrus Status

When checking Walrus:

- Distinguish read failure from expired blob and transport/CORS failure.
- Prefer SDK helpers such as `readAndVerifyWalrusContent` and `walrusReferenceFromVersion`.
- If only chain data is available, say content is not byte-verified.
- For application-managed content, check expiry and recommend renewal before the expiration epoch.

## User-Friendly Report

Use this shape:

```text
Verification result: verified | partially verified | not verified | failed
Artifact: <code>
Series: <id>
Version: <id>
Owner: <address>
Content: <hash status>
Walrus: <readable/expired/unavailable>
Events: <canonical/non-canonical/not checked>
Notes: <short explanation>
```
