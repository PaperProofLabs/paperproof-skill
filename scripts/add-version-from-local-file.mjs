#!/usr/bin/env node

// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { walrus } from '@mysten/walrus';
import {
  ARTIFACT_TYPES,
  JsonRpcPaperProofProvider,
  MAINNET_DEPLOYMENT,
  PaperProofTxBuilder,
  createDeployment,
  createPaperProofSDK,
  extractAddVersionResult,
  robustExecuteTransaction,
  robustWalrusWriteBlob,
  stringifyForJson,
} from '@paperproof/sdk-ts';
import { loadSignerSet, normalizeAddress } from './lib/signer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');
const ZERO = `0x${'0'.repeat(64)}`;

function usage() {
  return `
Add a new version to an existing PaperProof series from a local file.

Usage:
  node scripts/add-version-from-local-file.mjs --type=preprint --series=<seriesId> --file=<path>
  node scripts/add-version-from-local-file.mjs --run --type=technicalReport --series=<seriesId> --file=<path> --signer-env=<env>
  node scripts/add-version-from-local-file.mjs --run --type=genericFile --series=<seriesId> --file=<path> --signer-mode=single-env

Default mode is a dry run. --run writes the file to Walrus and submits a Sui
mainnet add-version transaction with the explicitly configured signer.

Signer modes:
  --signer-mode=auto         auto-detect single-env first, then indexed-env
  --signer-mode=single-env   use ADDRESS / PRIVATE_KEY (or custom --address-var / --private-key-var)
  --signer-mode=indexed-env  use ADDR_1 / PRIVATE_KEY_1 ... ADDR_16 / PRIVATE_KEY_16
`.trim();
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { run: false, help: false };
  for (const item of argv) {
    if (item === '--run') args.run = true;
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

async function waitForLatestVersion(sdk, seriesId, expectedVersionId, expectedContentHash, attempts = 6, delayMs = 2000) {
  let last = null;
  for (let index = 0; index < attempts; index += 1) {
    last = await sdk.query.getSeriesDetails(seriesId);
    if (last.series.currentVersionId === expectedVersionId && last.currentVersion.contentHash === expectedContentHash) {
      return last;
    }
    if (index < attempts - 1) await delay(delayMs);
  }
  throw new Error(
    `Latest version did not advance to the added version after ${attempts} checks. `
    + `Observed currentVersionId=${last?.series?.currentVersionId ?? 'unknown'}, expected=${expectedVersionId}.`,
  );
}

async function loadAccount(args) {
  const mode = args.signerMode ?? args['signer-mode'] ?? (args.account ? 'indexed-env' : 'auto');
  const accounts = await loadSignerSet(args, { defaultMode: mode });
  const requested = Number(args.account ?? 1);
  if (mode === 'indexed-env' || args.account) {
    const match = accounts.find((item) => item.index === requested);
    if (!match) throw new Error(`Could not find indexed signer account ${requested}.`);
    return { account: requested, address: match.address, signer: match.signer };
  }
  const [first] = accounts;
  return { account: requested, address: first.address, signer: first.signer };
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

async function uploadContent(walrusClient, signer, content, run, label) {
  if (!run) {
    const digest = content.contentHash.replace(/^sha256:/, '').slice(0, 24);
    return {
      blobId: `local-add-version-${digest}`,
      blobObjectId: `0x${'6'.repeat(64)}`,
      byteLength: content.fileSize,
    };
  }
  const upload = await robustWalrusWriteBlob(walrusClient, signer, content.bytes, {
    label: label.slice(0, 96),
    fallback: false,
    attempts: 4,
  });
  return {
    blobId: upload.blobId,
    blobObjectId: upload.blobObjectId,
    byteLength: content.fileSize,
  };
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
  const contentType = args['content-type'] ?? (type === 'genericFile' ? 'application/octet-stream' : 'application/pdf');
  const account = args.run ? await loadAccount(args) : null;
  const deployment = createDeployment(MAINNET_DEPLOYMENT);
  const sdk = createPaperProofSDK({ network: 'mainnet', transport: 'grpc', queryTransport: 'none' });
  const sui = new SuiJsonRpcClient({ url: deployment.rpcUrl ?? 'https://fullnode.mainnet.sui.io:443' });
  const walrusClient = new SuiGrpcClient({ baseUrl: deployment.rpcUrl, network: 'mainnet' }).$extend(
    walrus({
      network: 'mainnet',
      uploadRelay: {
        host: 'https://upload-relay.mainnet.walrus.space',
        sendTip: { max: 5_000_000 },
      },
    }),
  );
  const view = await sdk.query.getSeriesDetails(args.series);
  const expectedType = type === 'preprint'
    ? ARTIFACT_TYPES.preprint
    : type === 'technicalReport'
      ? ARTIFACT_TYPES.technicalReport
      : ARTIFACT_TYPES.genericFile;
  assert(view.series.artifactType === expectedType, `Series artifact type ${view.series.artifactType} does not match ${type}.`);
  if (account) assert(view.series.owner.toLowerCase() === account.address.toLowerCase(), `Series owner ${view.series.owner} does not match signer ${account.address}.`);
  const content = await readContent(args.file, contentType);
  const reportDir = path.resolve(args['report-dir'] ?? path.join(SKILL_ROOT, 'artifacts'));
  await fs.mkdir(reportDir, { recursive: true });
  if (content.contentHash === view.currentVersion.contentHash) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: 'Local file already matches the current version hash.',
      run: args.run,
      sender: account?.address ?? null,
      seriesOwner: view.series.owner,
      artifactType: type,
      artifactCode: view.series.artifactCode,
      seriesId: args.series,
      currentVersion: view.series.currentVersion,
      currentVersionId: view.series.currentVersionId,
      title: view.currentVersion.rawFields?.title,
      content: {
        file: content.fullPath,
        filename: content.filename,
        fileSize: content.fileSize,
        pageCount: content.pageCount,
        contentHash: content.contentHash,
        contentType,
      },
    };
    const reportPath = path.join(reportDir, `add-version-skipped-${Date.now()}.json`);
    await fs.writeFile(reportPath, `${stringifyForJson(skipped)}\n`, 'utf8');
    console.log(stringifyForJson({ ...skipped, reportPath }));
    return;
  }
  const upload = await uploadContent(walrusClient, account?.signer, content, args.run, `paperproof-add-version-${view.series.artifactCode ?? args.series}`);
  const txb = new PaperProofTxBuilder(deployment);
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
  if (account) tx.setSenderIfNotSet(account.address);
  const execution = args.run
    ? await robustExecuteTransaction(sui, account.signer, tx, `add ${type} version`)
    : { digest: null, events: [] };
  const added = args.run
    ? extractAddVersionResult(toSdkResponse(execution), deployment)
    : { seriesId: args.series, versionId: ZERO, artifactType: expectedType, version: BigInt(Number(view.series.currentVersion) + 1) };
  if (args.run) {
    await waitForLatestVersion(sdk, args.series, added.versionId, content.contentHash);
  }
  const report = {
    ok: true,
    run: args.run,
    sender: account?.address ?? null,
    seriesOwner: view.series.owner,
    artifactType: type,
    artifactCode: view.series.artifactCode,
    seriesId: args.series,
    previousVersion: view.series.currentVersion,
    previousVersionId: view.series.currentVersionId,
    newVersion: String(added.version),
    newVersionId: added.versionId,
    title: view.currentVersion.rawFields?.title,
    content: {
      file: content.fullPath,
      filename: content.filename,
      fileSize: content.fileSize,
      pageCount: content.pageCount,
      contentHash: content.contentHash,
      previousContentHash: view.currentVersion.contentHash,
      contentType,
    },
    upload,
    transactionDigest: execution.digest,
  };
  const reportPath = path.join(reportDir, `add-version-${Date.now()}.json`);
  await fs.writeFile(reportPath, `${stringifyForJson(report)}\n`, 'utf8');
  console.log(stringifyForJson({ ...report, reportPath }));
  if (!args.run) console.error('Dry run only. Re-run with --run after explicit user confirmation.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
