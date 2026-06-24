# Application Registries

Application registries are protocol-level bindings managed through application authority, protocol authority, or governance-like controls. Do not treat them as ordinary user content. Replace sample app IDs and routes with the application-specific IDs and routes the caller actually controls.

## Native Prompts

PaperProof native prompts are PaperProof artifacts, normally `genericFile` packages with content type:

```text
application/vnd.paperproof.prompt+json
```

The prompt registry maps an application route or capability name to a prompt artifact series. Use `useLatest: true` for default rolling updates or a pinned version ID for controlled rollout.

A prompt manifest may include routes such as:

- `copilot/global`
- `copilot/memory`
- `explore`
- `artifact`
- `add-version`
- `publish`
- `publish/preprints`
- `publish/blog-posts`
- `publish/technical-reports`
- `publish/datasets`
- `publish/software-releases`
- `publish/generic-files`
- `governance`
- `create-proposal`
- `proposal`
- `space`
- `docs`
- `blog`
- `blog-post`
- `forum`
- `forum-topic`

### Prompt Update Flow

1. Prepare prompt package JSON.
2. Publish as `genericFile`.
3. Register or update route binding through PromptRegistry.
4. Set latest or pinned policy.
5. Verify the app can resolve the prompt series and download the package.

Only authorized operators should write prompt registry entries for an app they control. Ordinary users may publish prompt artifacts, but they should not be represented as application registry bindings unless the relevant authority registers them.

## Agent Memory Registry

The memory registry is a governed discovery and availability layer. It does not store private memory bodies. Private memory lives in the memory provider, often MemWal-oriented integrations.

One application might choose defaults such as:

- `appId`: `paperproof-app`
- `namespaceRoot`: `paperproof/copilot`
- `memoryId`: `copilot/profile`
- one active memory entry per wallet per app;
- delete tombstones the chain entry and frees the slot;
- delete does not delete external Walrus/MemWal blobs.

### Memory Entry State

A usable application memory should satisfy:

- entry belongs to the configured MemoryRegistry;
- owner wallet matches the user;
- `appId` matches the intended application;
- provider policy is available;
- entry is available;
- owner has not disabled it;
- owner has not deleted it;
- descriptor series/version policy is accepted.

### User Actions

- **Enable/Disable**: local app preference only; should not write chain state unless explicitly designed otherwise.
- **Create**: create provider-side memory/account if needed and register one active chain entry.
- **Update**: write/update provider memory content and update the chain pointer/version if needed.
- **Delete**: tombstone the chain entry; external memory blobs remain untouched.
- **Access/Revoke**: local authorization for a device or agent to access the user's memory provider. Re-authorization may be needed on a new device.

## Governance Relationship

Native prompt and memory registry control is intentionally lighter than full proposal execution. The registry checks authority/governance-bound permissions for application writes and availability controls. Do not assume every registry update requires a public vote, and do not assume every application uses the same authority layout.

Use governance checks for:

- application prompt route registration;
- prompt availability or pinning policy if exposed;
- memory provider policy;
- memory entry availability;
- emergency disabling or version pinning.

## Application Content

Docs, Blog, and Forum content may be early users of the protocol:

- Docs are `genericFile` artifacts, usually locked comments.
- Blog posts are `blogPost` artifacts, preferably Markdown package zips; comments may be locked for official posts.
- Forum starter topics are `blogPost` artifacts with open comments.

When publishing application content, add stable metadata that lets the app resolve the intended page without relying on website state alone.
