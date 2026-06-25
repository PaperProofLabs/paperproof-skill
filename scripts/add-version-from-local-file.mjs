#!/usr/bin/env node

// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromBase64 } from '@mysten/bcs';
import {
  ARTIFACT_TYPES,
  PaperProofTxBuilder,
  extractAddVersionResult,
  robustExecuteTransaction,
  robustWalrusWriteBlob,
  stringifyForJson,
} from '@paperproof/sdk-ts';

import { loadSignerSet, normalizeAddress } from './lib/signer.mjs';
import {
  confirmLatestVersion,
  createResultError,
  createSkillRuntime,
  errorMessage,
  getArg,
  runPublishPreflight,
} from './lib/publish-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');
const ZERO = `0x${'0'.repeat(64)}`;

function usage() {
  return `
Add a new version to an existing PaperProof series from a local file.

Usage:
  node scripts/add-version-from-local-file.mjs --type=technicalReport --series=<seriesId> --file=<path>
  node scripts/add-version-from-local-file.mjs --preflight --type=technicalReport --series=<seriesId> --file=<path> --signer-env=<env> --account=4
  node scripts/add-version-from-local-file.mjs --run --type=technicalReport --series=<seriesId> --file=<path> --signer-env=<env> --account=4

Modes:
  default         dry run; no mainnet write
  --preflight     run structured readiness checks
  --run           upload to Walrus and submit the add-version transaction

Transport:
  --rpc=<url>
  --transport=grpc|jsonrpc
  --query-transport=none|jsonrpc|graphql|fallback
  --walrus-relay=<url>
  --retry-attempts=<n>
  --retry-base-ms=<ms>
  --confirm-attempts=<n>
  --confirm-delay-ms=<ms>

Signer modes:
  --signer-mode=auto         auto-detect single-env first, then indexed-env
  --signer-mode=single-env   use ADDRESS / PRIVATE_KEY (or custom --address-var / --private-key-var)
  --signer-mode=indexed-env  use ADDR_1 / PRIVATE_KEY_1 ... ADDR_16 / PRIVATE_KEY_16
`.trim();
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { run: false, help: false, preflight: false };
  for (const item of argv) {
    if (item === '--run') args.run = true;
    else if (item === '--preflight' || item === '--preflight-only') args.preflight = true;
    else if (item === '--help' || item === '-h') args.help = true;
    else if (item.startsWith('--')) {
      const index = item.indexOf('=');
      if (index === -1) args[item.slice(2)] = true;
      else args[item.slice(2, index)] = item.slice(index + 1);
    }
  }
  return args;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadAccount(args, required) {
  const envSpecified = Boolean(getArg(args, 'signerEnv', 'signer-env'));
  const mode = args.signerMode ?? args['signer-mode'] ?? (args.account ? 'indexed-env' : 'auto');
  if (!required && !envSpecified && !args.account) return null;
  try {
    const accounts = await loadSignerSet(args, { defaultMode: mode });
    const requested = Number(args.account ?? 1);
    if (mode === 'indexed-env' || args.account) {
      const match = accounts.find((item) => item.index === requested);
      if (!match) throw new Error(`Could not find indexed signer account ${requested}.`);
      return { ok: true, account: requested, address: match.address, signer: match.signer };
    }
    const [first] = accounts;
    return { ok: true, account: requested, address: first.address, signer: first.signer };
  } catch (error) {
    if (!required) {
      return {
        ...createResultError('signer', error),
        ok: false,
      };
    }
    throw error;
  }
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function pageCount(filePath) {
  const output = await new Promise((resolve) => {
    const child = spawn('pdfinfo', [filePath], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', () => resolve(''));
    child.on('close', (code) => resolve(code === 0 ? stdout : stderr));
  });
  const match = /^Pages:\s+(\d+)/m.exec(output);
  return match ? Number(match[1]) : undefined;
}

async function readContent(filePath, contentType) {
  const fullPath = path.resolve(filePath);
  const bytes = await fs.readFile(fullPath);
  const stat = await fs.stat(fullPath);
  assert(stat.size === bytes.length, `Could not read full file: ${fullPath}`);
  return {
    fullPath,
    bytes,
    filename: path.basename(fullPath),
    fileSize: bytes.length,
    contentHash: `sha256:${sha256Hex(bytes)}`,
    contentType,
    pageCount: await pageCount(fullPath),
  };
}

function metadataAttributes(entries) {
  return Object.entries(entries)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => ({ key, value: String(value).slice(0, 511) }));
}

function shouldFallbackToManualWalrus(error) {
  const text = errorMessage(error).toLowerCase();
  return text.includes('fetch failed')
    || text.includes('rpcerror')
    || text.includes('getbalance')
    || text.includes('batchgetobjects')
    || text.includes('multigetobjects')
    || text.includes('terminated')
    || text.includes('aborterror')
    || text.includes('connection timeout')
    || text.includes('econnreset')
    || text.includes('tls');
}

function registeredBlobObjectId(execution, fallbackBlobId) {
  const event = (execution.events ?? []).find((item) => item.type?.endsWith('::BlobRegistered'));
  const fromEvent = event?.parsedJson?.object_id ?? event?.parsedJson?.objectId;
  if (typeof fromEvent === 'string' && fromEvent.startsWith('0x')) return fromEvent;

  const createdBlob = (execution.objectChanges ?? []).find(
    (item) => item?.type === 'created' && String(item.objectType ?? '').endsWith('::blob::Blob'),
  );
  if (typeof createdBlob?.objectId === 'string') return createdBlob.objectId;

  throw new Error(`Could not find Walrus blob object id for blob ${fallbackBlobId}.`);
}

async function manualWalrusUpload(runtime, signer, content, label) {
  const flow = runtime.walrusClient.walrus.writeBlobFlow({ blob: content.bytes });
  const encoded = await flow.encode();
  const nonce = encoded.nonce ? fromBase64(encoded.nonce) : null;
  if (!nonce) throw new Error('Walrus manual flow did not return a nonce for upload relay mode.');

  const computed = await runtime.walrusClient.walrus.computeBlobMetadata({
    bytes: content.bytes,
    nonce,
  });
  if (computed.blobId !== encoded.blobId) {
    throw new Error(`Walrus blob id mismatch during manual fallback: ${computed.blobId} != ${encoded.blobId}`);
  }

  const registerTx = flow.register({
    epochs: 10,
    deletable: true,
    owner: signer.toSuiAddress(),
  });
  const registerExecution = await robustExecuteTransaction(runtime.baseClient, signer, registerTx, `${label} walrus register`, {
    attempts: runtime.retryAttempts,
    baseDelayMs: runtime.retryBaseDelayMs,
  });
  const blobObjectId = registeredBlobObjectId(registerExecution, encoded.blobId);

  const relayUpload = await runtime.walrusClient.walrus.writeBlobToUploadRelay({
    blobId: encoded.blobId,
    nonce,
    txDigest: registerExecution.digest,
    blob: content.bytes,
    blobObjectId,
    deletable: true,
    requiresTip: true,
    encodingType: computed.metadata.encodingType,
  });

  const certifyTx = runtime.walrusClient.walrus.certifyBlobTransaction({
    certificate: relayUpload.certificate,
    blobId: encoded.blobId,
    blobObjectId,
    deletable: true,
  });
  const certifyExecution = await robustExecuteTransaction(runtime.baseClient, signer, certifyTx, `${label} walrus certify`, {
    attempts: runtime.retryAttempts,
    baseDelayMs: runtime.retryBaseDelayMs,
  });

  return {
    blobId: encoded.blobId,
    blobObjectId,
    byteLength: content.fileSize,
    registerDigest: registerExecution.digest,
    certifyDigest: certifyExecution.digest,
    strategy: 'manual-flow-fallback',
  };
}

async function uploadContent(runtime, signer, content, run, label) {
  if (!run) {
    const digest = content.contentHash.replace(/^sha256:/, '').slice(0, 24);
    return {
      ok: true,
      uploadOk: true,
      blobId: `local-add-version-${digest}`,
      blobObjectId: `0x${'6'.repeat(64)}`,
      byteLength: content.fileSize,
      strategy: 'dry-run-placeholder',
    };
  }

  try {
    const upload = await robustWalrusWriteBlob(runtime.walrusClient, signer, content.bytes, {
      label: label.slice(0, 96),
      fallback: false,
      attempts: runtime.retryAttempts,
      baseDelayMs: runtime.retryBaseDelayMs,
      epochs: 10,
      owner: signer.toSuiAddress(),
    });
    return {
      ok: true,
      uploadOk: true,
      blobId: upload.blobId,
      blobObjectId: upload.blobObjectId,
      byteLength: content.fileSize,
      strategy: 'sdk-write-blob',
    };
  } catch (error) {
    if (!shouldFallbackToManualWalrus(error)) {
      return {
        ok: false,
        uploadOk: false,
        error: createResultError('upload', error, { transport: runtime.transport }),
      };
    }
    try {
      const upload = await manualWalrusUpload(runtime, signer, content, label.slice(0, 96));
      return {
        ok: true,
        uploadOk: true,
        ...upload,
      };
    } catch (fallbackError) {
      return {
        ok: false,
        uploadOk: false,
        fallbackAttempted: true,
        primaryError: createResultError('upload', error, { transport: runtime.transport }),
        error: createResultError('upload', fallbackError, { transport: runtime.transport }),
      };
    }
  }
}

function commonVersionMetadata(args, content, currentVersion) {
  const sourceFile = args['source-file'] ?? path.relative(process.cwd(), content.fullPath).replaceAll(path.sep, '/');
  return metadataAttributes({
    source_file: sourceFile,
    local_filename: content.filename,
    local_bytes: content.fileSize,
    previous_version: currentVersion.id,
  });
}

function preprintInput(args, content, upload, currentVersion) {
  const raw = currentVersion.rawFields ?? {};
  return {
    seriesId: args.series,
    title: args.title ?? raw.title,
    abstractText: args.abstract ?? raw.abstract_text,
    authors: raw.authors ?? [],
    keywords: raw.keywords ?? [],
    field: args.field ?? raw.field,
    license: args.license ?? raw.license,
    pageCount: args.pages ?? content.pageCount ?? raw.page_count,
    contentHash: content.contentHash,
    walrusBlobId: upload.blobId,
    walrusBlobObjectId: upload.blobObjectId,
    contentType: content.contentType,
    versionMetadata: commonVersionMetadata(args, content, currentVersion),
  };
}

function technicalReportInput(args, content, upload, currentVersion) {
  const raw = currentVersion.rawFields ?? {};
  return {
    seriesId: args.series,
    title: args.title ?? raw.title,
    abstractText: args.abstract ?? raw.abstract_text,
    authors: raw.authors ?? [],
    organization: args.organization ?? raw.organization,
    reportNumber: args['report-number'] ?? raw.report_number,
    keywords: raw.keywords ?? [],
    license: args.license ?? raw.license,
    contentHash: content.contentHash,
    walrusBlobId: upload.blobId,
    walrusBlobObjectId: upload.blobObjectId,
    contentType: content.contentType,
    versionMetadata: commonVersionMetadata(args, content, currentVersion),
  };
}

function genericFileInput(args, content, upload, currentVersion) {
  const raw = currentVersion.rawFields ?? {};
  return {
    seriesId: args.series,
    title: args.title ?? raw.title,
    description: args.description ?? raw.description,
    filename: args.filename ?? content.filename,
    fileSize: content.fileSize,
    license: args.license ?? raw.license,
    contentHash: content.contentHash,
    walrusBlobId: upload.blobId,
    walrusBlobObjectId: upload.blobObjectId,
    contentType: content.contentType,
    versionMetadata: commonVersionMetadata(args, content, currentVersion),
  };
}

function toSdkResponse(execution) {
  return {
    events: (execution.events ?? []).map((event) => ({
      type: event.type,
      packageId: event.packageId ?? event.type?.split('::')[0],
      transactionModule: event.transactionModule,
      sender: event.sender,
      parsedJson: event.parsedJson,
    })),
  };
}

function expectedArtifactType(type) {
  return type === 'preprint'
    ? ARTIFACT_TYPES.preprint
    : type === 'technicalReport'
      ? ARTIFACT_TYPES.technicalReport
      : ARTIFACT_TYPES.genericFile;
}

function confirmationCommand(args, runtime) {
  const bits = [
    'node .\\scripts\\query-series.mjs',
    `--series=${args.series}`,
    `--transport=${runtime.transport}`,
    `--query-transport=${runtime.queryTransport}`,
    `--rpc=${runtime.rpcUrl}`,
  ];
  return bits.join(' ');
}

async function writeReport(reportDir, prefix, report) {
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${prefix}-${Date.now()}.json`);
  await fs.writeFile(reportPath, `${stringifyForJson(report)}\n`, 'utf8');
  return reportPath;
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const type = args.type;
  assert(type === 'preprint' || type === 'technicalReport' || type === 'genericFile', 'Supported --type values for this helper: preprint, technicalReport, genericFile.');
  assert(args.series, 'Missing --series=<seriesId>.');
  assert(args.file, 'Missing --file=<path>.');

  const run = Boolean(args.run);
  const runtime = createSkillRuntime(args);
  const reportDir = path.resolve(args['report-dir'] ?? path.join(SKILL_ROOT, 'artifacts'));
  const contentType = args['content-type'] ?? (type === 'genericFile' ? 'application/octet-stream' : 'application/pdf');
  const signerResult = await loadAccount(args, run);
  const preflight = await runPublishPreflight({
    runtime,
    requireSigner: run,
    signerResult,
    seriesId: args.series,
    expectedArtifactType: expectedArtifactType(type),
  });

  const content = await readContent(args.file, contentType);
  const baseReport = {
    ok: false,
    run,
    preflightOnly: Boolean(args.preflight) && !run,
    transport: runtime.transport,
    queryTransport: runtime.queryTransport,
    rpcUrl: runtime.rpcUrl,
    walrusRelay: runtime.walrusRelay,
    sender: signerResult?.ok ? signerResult.address : null,
    signerAccount: signerResult?.ok ? signerResult.account ?? null : null,
    artifactType: type,
    seriesId: args.series,
    content: {
      file: content.fullPath,
      filename: content.filename,
      fileSize: content.fileSize,
      pageCount: content.pageCount,
      contentHash: content.contentHash,
      contentType,
    },
    preflight,
    uploadOk: false,
    transactionSubmitted: false,
    transactionDigest: null,
    chainResultObserved: false,
    latestVersionConfirmed: false,
    confirmationCommand: confirmationCommand(args, runtime),
  };

  if (args.preflight && !run) {
    const reportPath = await writeReport(reportDir, 'add-version-preflight', {
      ...baseReport,
      ok: preflight.ok,
    });
    console.log(stringifyForJson({ ...baseReport, ok: preflight.ok, reportPath }));
    return;
  }

  if (!preflight.ok) {
    const reportPath = await writeReport(reportDir, 'add-version-preflight-failed', {
      ...baseReport,
      error: {
        category: 'preflight',
        code: 'PREFLIGHT_FAILED',
        summary: 'Preflight failed. No Walrus upload or add-version transaction was attempted.',
        criticalFailures: preflight.criticalFailures,
      },
    });
    console.log(stringifyForJson({
      ...baseReport,
      error: {
        category: 'preflight',
        code: 'PREFLIGHT_FAILED',
        summary: 'Preflight failed. No Walrus upload or add-version transaction was attempted.',
        criticalFailures: preflight.criticalFailures,
      },
      reportPath,
    }));
    return;
  }

  const view = await runtime.sdk.query.getSeriesDetails(args.series);
  assert(view.series.artifactType === expectedArtifactType(type), `Series artifact type ${view.series.artifactType} does not match ${type}.`);
  if (signerResult?.ok) {
    assert(normalizeAddress(view.series.owner) === signerResult.address, `Series owner ${view.series.owner} does not match signer ${signerResult.address}.`);
  }

  if (content.contentHash === view.currentVersion.contentHash) {
    const skipped = {
      ...baseReport,
      ok: true,
      skipped: true,
      reason: 'Local file already matches the current version hash.',
      seriesOwner: view.series.owner,
      artifactCode: view.series.artifactCode,
      currentVersion: view.series.currentVersion,
      currentVersionId: view.series.currentVersionId,
      title: view.currentVersion.rawFields?.title,
      latestVersionConfirmed: true,
    };
    const reportPath = await writeReport(reportDir, 'add-version-skipped', skipped);
    console.log(stringifyForJson({ ...skipped, reportPath }));
    return;
  }

  if (!run) {
    const dryRun = {
      ...baseReport,
      ok: true,
      artifactCode: view.series.artifactCode,
      seriesOwner: view.series.owner,
      previousVersion: view.series.currentVersion,
      previousVersionId: view.series.currentVersionId,
      previousContentHash: view.currentVersion.contentHash,
      newVersion: String(Number(view.series.currentVersion) + 1),
      newVersionId: ZERO,
      title: view.currentVersion.rawFields?.title,
    };
    const reportPath = await writeReport(reportDir, 'add-version-dry-run', dryRun);
    console.log(stringifyForJson({ ...dryRun, reportPath }));
    return;
  }

  const upload = await uploadContent(runtime, signerResult.signer, content, run, `paperproof-add-version-${view.series.artifactCode ?? args.series}`);
  if (!upload.ok) {
    const reportPath = await writeReport(reportDir, 'add-version-upload-failed', {
      ...baseReport,
      artifactCode: view.series.artifactCode,
      seriesOwner: view.series.owner,
      previousVersion: view.series.currentVersion,
      previousVersionId: view.series.currentVersionId,
      previousContentHash: view.currentVersion.contentHash,
      error: upload.error,
      upload,
    });
    console.log(stringifyForJson({
      ...baseReport,
      artifactCode: view.series.artifactCode,
      seriesOwner: view.series.owner,
      previousVersion: view.series.currentVersion,
      previousVersionId: view.series.currentVersionId,
      previousContentHash: view.currentVersion.contentHash,
      error: upload.error,
      upload,
      reportPath,
    }));
    return;
  }

  const txb = new PaperProofTxBuilder(runtime.deployment);
  const input = type === 'preprint'
    ? preprintInput(args, content, upload, view.currentVersion)
    : type === 'technicalReport'
      ? technicalReportInput(args, content, upload, view.currentVersion)
      : genericFileInput(args, content, upload, view.currentVersion);
  const tx = type === 'preprint'
    ? txb.addPreprintVersion(input)
    : type === 'technicalReport'
      ? txb.addTechnicalReportVersion(input)
      : txb.addGenericFileVersion(input);
  tx.setSenderIfNotSet(signerResult.address);

  let execution;
  try {
    execution = await robustExecuteTransaction(runtime.baseClient, signerResult.signer, tx, `add ${type} version`, {
      attempts: runtime.retryAttempts,
      baseDelayMs: runtime.retryBaseDelayMs,
    });
  } catch (error) {
    const reportPath = await writeReport(reportDir, 'add-version-transaction-failed', {
      ...baseReport,
      artifactCode: view.series.artifactCode,
      seriesOwner: view.series.owner,
      previousVersion: view.series.currentVersion,
      previousVersionId: view.series.currentVersionId,
      previousContentHash: view.currentVersion.contentHash,
      uploadOk: true,
      upload,
      error: createResultError('transaction', error, { transport: runtime.transport }),
    });
    console.log(stringifyForJson({
      ...baseReport,
      artifactCode: view.series.artifactCode,
      seriesOwner: view.series.owner,
      previousVersion: view.series.currentVersion,
      previousVersionId: view.series.currentVersionId,
      previousContentHash: view.currentVersion.contentHash,
      uploadOk: true,
      upload,
      error: createResultError('transaction', error, { transport: runtime.transport }),
      reportPath,
    }));
    return;
  }

  let added = null;
  let chainResultObserved = false;
  try {
    added = extractAddVersionResult(toSdkResponse(execution), runtime.deployment);
    chainResultObserved = true;
  } catch (error) {
    added = {
      seriesId: args.series,
      versionId: ZERO,
      artifactType: expectedArtifactType(type),
      version: BigInt(Number(view.series.currentVersion) + 1),
    };
  }

  const confirmation = chainResultObserved
    ? await confirmLatestVersion({
        runtime,
        seriesId: args.series,
        expectedVersionId: added.versionId,
        expectedContentHash: content.contentHash,
      })
    : {
        ok: false,
        ...createResultError('confirmation', new Error('Skipped because add-version result could not be extracted from events.'), { transport: runtime.transport }),
      };

  const report = {
    ...baseReport,
    ok: chainResultObserved,
    artifactCode: view.series.artifactCode,
    seriesOwner: view.series.owner,
    previousVersion: view.series.currentVersion,
    previousVersionId: view.series.currentVersionId,
    previousContentHash: view.currentVersion.contentHash,
    newVersion: String(added.version),
    newVersionId: added.versionId,
    title: view.currentVersion.rawFields?.title,
    uploadOk: true,
    transactionSubmitted: true,
    transactionDigest: execution.digest,
    chainResultObserved,
    latestVersionConfirmed: confirmation.ok,
    upload,
    confirmation,
    needsManualConfirmation: !confirmation.ok && execution.digest !== null,
    operatorNote: !confirmation.ok && execution.digest !== null
      ? 'Upload and transaction submission completed, but the latest-version readback did not confirm success yet. Do not assume chain failure from this alone; run the confirmation command again.'
      : null,
  };
  const reportPath = await writeReport(reportDir, confirmation.ok ? 'add-version-success' : 'add-version-pending-confirmation', report);
  console.log(stringifyForJson({ ...report, reportPath }));
}

main().catch(async (error) => {
  const failure = {
    ok: false,
    error: createResultError('fatal', error),
  };
  console.error(stringifyForJson(failure));
  process.exitCode = 1;
});
