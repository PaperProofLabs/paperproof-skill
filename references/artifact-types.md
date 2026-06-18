# Artifact Types

Choose the artifact type by the user's intent and the durability expected from the record. If the user already has a series ID and asks to update it, use the same artifact type and add a version.

## Type Map

| SDK key | On-chain type | Use for | Avoid when |
|---|---:|---|---|
| `preprint` | `1` | papers, research drafts, white papers, yellow papers, academic manuscripts | the item is an operational report rather than research |
| `blogPost` | `2` | official posts, essays, announcements, forum topic bodies | the content should be a locked doc page |
| `technicalReport` | `3` | formal technical reports, audit reports, engineering reports | the content is a general blog or academic paper |
| `dataset` | `4` | datasets, benchmark files, experiment outputs, index snapshots | the primary value is prose, source code, or a report |
| `softwareRelease` | `5` | SDK releases, app builds, source archives, contract packages | there is no software version or repository context |
| `genericFile` | `6` | docs, prompts, arbitrary files, Markdown packages, fallback content | a more specific type clearly fits |

## Required Metadata by Type

Use exact SDK field names where possible.

### Preprint

- `title`
- `abstractText`
- `authors`
- `keywords`
- `field`
- `license`
- `pageCount`
- `contentHash`
- `walrusBlobId`
- `walrusBlobObjectId`
- `contentType`

Direct preprint publication is disabled in the current contract. Use reserved-preprint flow: reserve code first, then finalize with content metadata.

### Blog Post

- `title`
- `summary`
- `tags`
- `language`
- `contentHash`
- `walrusBlobId`
- `walrusBlobObjectId`
- `contentType`

Use `application/vnd.paperproof.markdown-package+zip` when the post may include Markdown plus images or future assets. Use locked comments for official Blog if policy requires no discussion surface.

### Technical Report

- `title`
- `abstractText`
- `authors`
- `organization`
- `reportNumber`
- `keywords`
- `license`
- `contentHash`
- `walrusBlobId`
- `walrusBlobObjectId`
- `contentType`

Good for engineering reports, protocol reports, verification summaries, and formal deliverables.

### Dataset

- `title`
- `description`
- `format`
- `fileCount`
- `sizeBytes`
- `license`
- `keywords`
- `contentHash`
- `walrusBlobId`
- `walrusBlobObjectId`
- `contentType`

Prefer a package format when the dataset has multiple files.
For dataset packages, put schema, source notes, file manifests, and detailed
methodology inside the zip. Keep `seriesMetadata` and `versionMetadata` short;
each array should have no more than 4 entries.

### Software Release

- `projectName`
- `versionName`
- `sourceHash`
- `packageHash`
- `changelog`
- `license`
- `repositoryUrl`
- `contentHash`
- `walrusBlobId`
- `walrusBlobObjectId`
- `contentType`

Use for SDKs, CLIs, contracts, app bundles, and reproducible source archives.

### Generic File

- `title`
- `description`
- `filename`
- `fileSize`
- `license`
- `contentHash`
- `walrusBlobId`
- `walrusBlobObjectId`
- `contentType`

Use for protocol-native prompts with `application/vnd.paperproof.prompt+json` and official Docs with plain Markdown or package formats.

## Comments Policy

- Docs: usually lock comments.
- Official Blog: usually lock comments unless the project wants discussion attached to posts.
- Forum topics: keep comments open.
- Prompts and config artifacts: usually lock comments.
- User-published artifacts: ask the user.

## Metadata Quality Rules

- Keep titles specific and human-readable.
- Include license explicitly.
- Use concise summaries and abstracts, not marketing copy.
- Use stable tags/keywords that help discovery.
- Put app-specific or official flags into metadata attributes rather than title text.
- Keep metadata attributes short and sparse; use content files for long provenance notes.
- Never invent authorship, affiliation, or license if the user has not provided it.
