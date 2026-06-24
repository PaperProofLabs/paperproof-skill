#!/usr/bin/env node

// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises';
import path from 'node:path';

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { walrus } from '@mysten/walrus';
import {
  MAINNET_DEPLOYMENT,
  createDeployment,
  createPaperProofSDK,
  robustExecuteTransaction,
  robustWalrusExtendBlob,
} from '@paperproof/sdk-ts';
import { loadSignerSet, normalizeAddress } from './lib/signer.mjs';

const DEFAULT_TARGET_EPOCHS = 10;

function usage() {
  return `
Inspect Walrus retention windows and extend short-lived latest versions to a target epoch window.

Inputs:
  --series-json=<file>             JSON array of { artifactCode, seriesId, title? }
  --manifest-json=<file[,file...]> Extract artifactCode/seriesId pairs from one or more app manifest JSON files
  --explore-types=1,2,3,4,5        Pull active artifacts from an explore API for the given artifact types

Common options:
  --run
  --targetEpochs=10
  --api-base=<optional explore api base>
  --batch-size=8
  --mode=batch|sequential
  --signer-mode=auto|single-env|indexed-env

Examples:
  node scripts/extend-walrus-retention.mjs --explore-types=1,2,3
  node scripts/extend-walrus-retention.mjs --run --signer-env=.env --explore-types=1,2,3,4,5
  node scripts/extend-walrus-retention.mjs --series-json=./artifacts/series.json
  node scripts/extend-walrus-retention.mjs --manifest-json=../paperproof-app/public/docs/manifest.json,../paperproof-app/public/blog/manifest.json
`.trim();
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    run: false,
    help: false,
    targetEpochs: String(DEFAULT_TARGET_EPOCHS),
    mode: 'batch',
    batchSize: '8',
  };
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

async function readSeriesJson(filePath) {
  const raw = JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'));
  assert(Array.isArray(raw), '--series-json must point to a JSON array.');
  return raw
    .filter((item) => item?.seriesId)
    .map((item) => ({
      source: 'series-json',
      artifactCode: String(item.artifactCode ?? item.code ?? item.seriesId),
      seriesId: String(item.seriesId),
      title: String(item.title ?? item.artifactCode ?? item.seriesId),
      status: String(item.status ?? 'Active'),
    }));
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

function collectManifestRecords(node, records = [], seen = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectManifestRecords(item, records, seen);
    return records;
  }
  if (!node || typeof node !== 'object') return records;

  const seriesId = node.seriesId ?? node.series_id;
  const artifactCode = node.artifactCode ?? node.artifact_code;
  if (seriesId && artifactCode) {
    const key = String(seriesId).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      records.push({
        source: 'manifest-json',
        artifactCode: String(artifactCode),
        seriesId: String(seriesId),
        title: String(node.title ?? node.id ?? artifactCode),
        status: String(node.status ?? 'Active'),
      });
    }
  }

  for (const value of Object.values(node)) {
    collectManifestRecords(value, records, seen);
  }
  return records;
}

async function readManifestJson(fileArg) {
  const files = String(fileArg)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  assert(files.length > 0, '--manifest-json requires at least one file path.');
  const records = [];
  for (const filePath of files) {
    const payload = JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'));
    collectManifestRecords(payload, records);
  }
  return records;
}

async function readExploreArtifacts(apiBase, artifactTypes) {
  assert(apiBase, 'Provide --api-base when using --explore-types.');
  const base = String(apiBase).replace(/\/$/, '');
  const records = [];
  for (const artifactType of artifactTypes) {
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const params = new URLSearchParams({
        artifact_type: String(artifactType),
        sort: 'updated',
        limit: '100',
        offset: String(offset),
      });
      const payload = await fetchJson(`${base}/v1/explore/items?${params}`);
      for (const item of payload.items ?? []) {
        if (String(item.status ?? '').toLowerCase() !== 'active') continue;
        records.push({
          source: `explore:${artifactType}`,
          artifactCode: String(item.artifactCode),
          seriesId: String(item.seriesId),
          title: String(item.title ?? item.artifactCode),
          status: String(item.status ?? 'Active'),
        });
      }
      hasMore = Boolean(payload.hasMore);
      offset += Number(payload.limit ?? 100);
    }
  }
  return records;
}

function uniqueBySeries(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = String(record.seriesId).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rawHeader(version) {
  return version?.rawFields?.header?.fields ?? version?.rawFields?.header ?? {};
}

function normalizeEpoch(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pickSigner(accounts, owners = []) {
  const normalizedOwners = owners.filter(Boolean).map((value) => normalizeAddress(value));
  for (const owner of normalizedOwners) {
    const match = accounts.find((account) => account.address === owner);
    if (match) return match;
  }
  return accounts[0];
}

async function inspectRecords(sdk, walrusClient, records) {
  const inspected = [];
  for (const record of uniqueBySeries(records)) {
    const details = await sdk.query.getSeriesDetails(record.seriesId);
    if (String(details.series.status ?? 0) !== '0') continue;
    const version = details.currentVersion;
    const header = rawHeader(version);
    const blobObjectId = header.walrus_blob_object_id ?? version?.walrusBlobObjectId ?? null;
    const blobId = header.walrus_blob_id ?? version?.walrusBlobId ?? null;
    if (!blobObjectId) continue;
    const blobObject = await walrusClient.walrus.getBlobObject(blobObjectId);
    const startEpoch = normalizeEpoch(blobObject?.storage?.start_epoch);
    const endEpoch = normalizeEpoch(blobObject?.storage?.end_epoch);
    if (startEpoch === null || endEpoch === null) continue;
    inspected.push({
      ...record,
      artifactType: Number(details.series.artifactType ?? 0),
      currentVersion: String(details.series.currentVersion ?? version?.version ?? ''),
      versionId: String(details.series.currentVersionId ?? version?.id ?? ''),
      owner: details.series.owner ? normalizeAddress(details.series.owner) : null,
      author: header.author ? normalizeAddress(header.author) : null,
      blobId,
      blobObjectId,
      startEpoch,
      endEpoch,
      totalEpochs: endEpoch - startEpoch,
    });
  }
  return inspected;
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function extendSequential(walrusClient, signerAccount, item, missingEpochs) {
  const walrusAdapter = {
    walrus: {
      getBlobObject: ({ blobObjectId }) => walrusClient.walrus.getBlobObject(blobObjectId),
      extendBlob: ({ blobObjectId, epochs, signer }) =>
        walrusClient.walrus.executeExtendBlobTransaction({ blobObjectId, epochs, signer }),
    },
  };
  await robustWalrusExtendBlob(walrusAdapter, signerAccount.signer, item.blobObjectId, {
    label: `extend ${item.artifactCode}`,
    epochs: missingEpochs,
    owner: signerAccount.address,
    attempts: 4,
  });
}

async function extendBatchTx({ sui, walrusClient, signerAccount, items, batchSize }) {
  for (const batch of chunk(items, batchSize)) {
    const tx = new Transaction();
    tx.setSenderIfNotSet(signerAccount.address);
    let added = 0;
    for (const item of batch) {
      if (item.missingEpochs <= 0) continue;
      await walrusClient.walrus.extendBlobTransaction({
        transaction: tx,
        blobObjectId: item.blobObjectId,
        epochs: item.missingEpochs,
      });
      added += 1;
    }
    if (added === 0) continue;
    await robustExecuteTransaction(sui, signerAccount.signer, tx, `batch extend ${added} walrus blobs`);
  }
}

async function performExtensions({ inspected, accounts, walrusClient, sui, run, targetEpochs, mode, batchSize }) {
  const results = inspected.map((item) => {
    const signerAccount = accounts.length ? pickSigner(accounts, [item.author, item.owner]) : null;
    const missingEpochs = Math.max(0, targetEpochs - item.totalEpochs);
    return {
      ...item,
      signer: signerAccount?.address ?? item.author ?? item.owner ?? 'unknown',
      signerAccount,
      missingEpochs,
      action: missingEpochs > 0 ? (run ? 'pending' : 'plan') : 'skip',
      addedEpochs: missingEpochs > 0 ? missingEpochs : 0,
      targetEndEpoch: missingEpochs > 0 ? item.endEpoch + missingEpochs : item.endEpoch,
    };
  });

  if (!run) return results;

  const pending = results.filter((item) => item.missingEpochs > 0);
  const grouped = new Map();
  for (const item of pending) {
    assert(item.signerAccount, `No signer account available for ${item.artifactCode}.`);
    const key = item.signerAccount.address;
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }

  for (const items of grouped.values()) {
    const signerAccount = items[0].signerAccount;
    if (mode === 'batch') {
      try {
        await extendBatchTx({ sui, walrusClient, signerAccount, items, batchSize });
        for (const item of items) item.action = 'extended';
      } catch (error) {
        for (const item of items) {
          await extendSequential(walrusClient, signerAccount, item, item.missingEpochs);
          item.action = 'extended';
        }
      }
    } else {
      for (const item of items) {
        await extendSequential(walrusClient, signerAccount, item, item.missingEpochs);
        item.action = 'extended';
      }
    }
  }

  return results;
}

function printSummary(results, { run, targetEpochs, mode, batchSize }) {
  const lines = [
    `Target window: ${targetEpochs} epochs`,
    `Execution mode: ${run ? `${mode} (batch-size=${batchSize})` : 'dry-run'}`,
  ];
  const grouped = new Map();
  for (const item of results) {
    const key = item.artifactType || item.source;
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }
  for (const [group, items] of grouped.entries()) {
    lines.push(`\n[artifact-type ${group}] ${items.length} artifacts`);
    for (const item of items) {
      lines.push(
        [
          `- ${item.artifactCode}`,
          `v${item.currentVersion}`,
          `window=${item.startEpoch}->${item.endEpoch} (${item.totalEpochs} epochs)`,
          `action=${item.action}`,
          `add=${item.addedEpochs}`,
          `targetEnd=${item.targetEndEpoch}`,
        ].join(' | '),
      );
    }
  }
  const planned = results.filter((item) => item.action === 'plan').length;
  const extended = results.filter((item) => item.action === 'extended').length;
  const skipped = results.filter((item) => item.action === 'skip').length;
  lines.push('');
  lines.push(
    run
      ? `Done. extended=${extended}, skipped=${skipped}, total=${results.length}`
      : `Dry run. planned=${planned}, already-ok=${skipped}, total=${results.length}`,
  );
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const targetEpochs = Number(args.targetEpochs ?? args['target-epochs'] ?? DEFAULT_TARGET_EPOCHS);
  const batchSize = Number(args.batchSize ?? args['batch-size'] ?? 8);
  const mode = String(args.mode ?? 'batch').toLowerCase();
  assert(Number.isInteger(targetEpochs) && targetEpochs > 0, '--targetEpochs must be a positive integer.');
  assert(Number.isInteger(batchSize) && batchSize > 0, '--batchSize must be a positive integer.');
  assert(mode === 'batch' || mode === 'sequential', '--mode must be batch or sequential.');
  const seriesJsonArg = args.seriesJson ?? args['series-json'];
  const manifestJsonArg = args.manifestJson ?? args['manifest-json'];
  const exploreTypesArg = args.exploreTypes ?? args['explore-types'];
  const apiBaseArg = args.apiBase ?? args['api-base'];

  assert(seriesJsonArg || manifestJsonArg || exploreTypesArg, 'Provide --series-json, --manifest-json, or --explore-types.');

  const deployment = createDeployment(MAINNET_DEPLOYMENT);
  const sdk = createPaperProofSDK({ deployment });
  const sui = new SuiJsonRpcClient({ url: deployment.rpcUrl ?? 'https://fullnode.mainnet.sui.io:443' });
  const walrusClient = new SuiGrpcClient({ baseUrl: deployment.rpcUrl, network: 'mainnet' }).$extend(
    walrus({
      network: 'mainnet',
      uploadRelay: {
        host: 'https://upload-relay.mainnet.walrus.space',
      },
    }),
  );

  const records = [];
  if (seriesJsonArg) records.push(...await readSeriesJson(seriesJsonArg));
  if (manifestJsonArg) records.push(...await readManifestJson(manifestJsonArg));
  if (exploreTypesArg) {
    const artifactTypes = String(exploreTypesArg)
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
    records.push(...await readExploreArtifacts(apiBaseArg, artifactTypes));
  }

  const inspected = await inspectRecords(sdk, walrusClient, records);
  const accounts = args.run ? await loadSignerSet(args, { defaultMode: 'auto' }) : [];
  const results = await performExtensions({
    inspected,
    accounts,
    walrusClient,
    sui,
    run: args.run,
    targetEpochs,
    mode,
    batchSize,
  });
  console.log(printSummary(results, { run: args.run, targetEpochs, mode, batchSize }));
}

await main();
