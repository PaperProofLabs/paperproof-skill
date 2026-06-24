#!/usr/bin/env node

// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { walrus } from '@mysten/walrus';
import {
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

function usage() {
  return `
Package the current worktree as a zip and add it as a new softwareRelease version.

Usage:
  node scripts/add-software-release-version-from-worktree.mjs --series=<seriesId> --run --signer-env=<env>

Options:
  --series=<seriesId>                target software release series
  --project-name=<name>             defaults to current version projectName
  --version-name=<name>             defaults to v<nextVersion>
  --repository-url=<url>            defaults to current version repositoryUrl
  --license=<spdx>                  defaults to current version license
  --changelog=<text>                defaults to a generated note
  --source-hash=<text>              defaults to git:<shortsha>[+dirty]
  --report-dir=<dir>                defaults to ./artifacts
  --output-zip=<path>               defaults to ./artifacts/<project>-<timestamp>.zip
  --signer-mode=auto|single-env|indexed-env
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

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function execCapture(command, commandArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
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
    `Latest version did not advance after ${attempts} checks. `
    + `Observed currentVersionId=${last?.series?.currentVersionId ?? 'unknown'}, expected=${expectedVersionId}.`,
  );
}

async function makeZip(outputZip) {
  await fs.mkdir(path.dirname(outputZip), { recursive: true });
  const args = [
    'archive',
    '--format=zip',
    '--output',
    outputZip,
    'HEAD',
  ];
  await execCapture('git', args, SKILL_ROOT);
}

async function readFileInfo(filePath) {
  const bytes = await fs.readFile(filePath);
  const stat = await fs.stat(filePath);
  return {
    fullPath: filePath,
    bytes,
    fileSize: stat.size,
    contentHash: `sha256:${sha256Hex(bytes)}`,
  };
}

async function uploadContent(walrusClient, signer, fileInfo, label) {
  const upload = await robustWalrusWriteBlob(walrusClient, signer, fileInfo.bytes, {
    label: label.slice(0, 96),
    fallback: false,
    attempts: 4,
    epochs: 10,
  });
  return {
    blobId: upload.blobId,
    blobObjectId: upload.blobObjectId,
    byteLength: fileInfo.fileSize,
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

  assert(args.run, 'This helper is write-only. Pass --run to proceed.');
  assert(args.series, 'Missing --series=<seriesId>.');

  const accounts = await loadSignerSet(args, { defaultMode: args.account ? 'indexed-env' : 'auto' });
  const requested = Number(args.account ?? 4);
  const account = (args.account || (args.signerMode ?? args['signer-mode']) === 'indexed-env')
    ? accounts.find((item) => item.index === requested)
    : accounts[0];
  assert(account, `No signer account available for selection ${requested}.`);

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

  const details = await sdk.query.getSeriesDetails(args.series);
  assert(Number(details.series.artifactType) === 5, 'Target series is not a softwareRelease.');
  assert(normalizeAddress(details.series.owner) === account.address, `Series owner ${details.series.owner} does not match signer ${account.address}.`);

  const current = details.currentVersion.rawFields ?? {};
  const shortSha = await execCapture('git', ['rev-parse', '--short', 'HEAD'], SKILL_ROOT);
  const isDirty = (await execCapture('git', ['status', '--porcelain'], SKILL_ROOT)).length > 0;
  const sourceHash = args['source-hash'] ?? `git:${shortSha}${isDirty ? '+dirty' : ''}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const projectName = args['project-name'] ?? current.project_name ?? 'paperproof-skill';
  const nextVersion = Number(details.series.currentVersion) + 1;
  const versionName = args['version-name'] ?? `v${nextVersion}`;
  const repositoryUrl = args['repository-url'] ?? current.repository_url ?? 'https://github.com/PaperProofLabs/paperproof-skill';
  const license = args.license ?? current.license ?? 'Apache-2.0';
  const changelog = args.changelog ?? `paperproof-skill community usability refactor and generic retention workflow ${timestamp}`;

  const reportDir = path.resolve(args['report-dir'] ?? path.join(SKILL_ROOT, 'artifacts'));
  const outputZip = path.resolve(args['output-zip'] ?? path.join(reportDir, `${projectName}-${timestamp}.zip`));

  await makeZip(outputZip);
  const fileInfo = await readFileInfo(outputZip);
  const upload = await uploadContent(walrusClient, account.signer, fileInfo, `paperproof-software-release-${projectName}`);

  const txb = new PaperProofTxBuilder(deployment);
  const tx = txb.addSoftwareReleaseVersion({
    seriesId: args.series,
    projectName,
    versionName,
    sourceHash,
    packageHash: fileInfo.contentHash,
    changelog,
    license,
    repositoryUrl,
    contentHash: fileInfo.contentHash,
    walrusBlobId: upload.blobId,
    walrusBlobObjectId: upload.blobObjectId,
    contentType: 'application/zip',
    versionMetadata: [
      { key: 'release_kind', value: 'codex-skill' },
      { key: 'packaging', value: 'git archive zip' },
      { key: 'commit', value: shortSha },
      { key: 'worktree', value: isDirty ? 'dirty' : 'clean' },
    ],
  });
  tx.setSenderIfNotSet(account.address);

  const execution = await robustExecuteTransaction(sui, account.signer, tx, 'add software release version');
  const added = extractAddVersionResult(toSdkResponse(execution), deployment);
  await waitForLatestVersion(sdk, args.series, added.versionId, fileInfo.contentHash);

  const report = {
    ok: true,
    sender: account.address,
    artifactCode: details.series.artifactCode,
    seriesId: args.series,
    previousVersion: details.series.currentVersion,
    previousVersionId: details.series.currentVersionId,
    newVersion: String(added.version),
    newVersionId: added.versionId,
    projectName,
    versionName,
    sourceHash,
    packageHash: fileInfo.contentHash,
    changelog,
    repositoryUrl,
    zipPath: outputZip,
    zipSize: fileInfo.fileSize,
    contentHash: fileInfo.contentHash,
    upload,
    transactionDigest: execution.digest,
  };

  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `software-release-add-version-${Date.now()}.json`);
  await fs.writeFile(reportPath, `${stringifyForJson(report)}\n`, 'utf8');
  console.log(stringifyForJson({ ...report, reportPath }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
