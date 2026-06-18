#!/usr/bin/env node

// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { fail, parseArgs, printJson, requireArg } from './lib/cli.mjs';

const REQUIRED = {
  preprint: ['title', 'abstractText', 'authors', 'keywords', 'field', 'license', 'pageCount', 'contentHash', 'walrusBlobId', 'walrusBlobObjectId', 'contentType'],
  blogPost: ['title', 'summary', 'tags', 'language', 'contentHash', 'walrusBlobId', 'walrusBlobObjectId', 'contentType'],
  technicalReport: ['title', 'abstractText', 'authors', 'organization', 'reportNumber', 'keywords', 'license', 'contentHash', 'walrusBlobId', 'walrusBlobObjectId', 'contentType'],
  dataset: ['title', 'description', 'format', 'fileCount', 'sizeBytes', 'license', 'keywords', 'contentHash', 'walrusBlobId', 'walrusBlobObjectId', 'contentType'],
  softwareRelease: ['projectName', 'versionName', 'sourceHash', 'packageHash', 'changelog', 'license', 'repositoryUrl', 'contentHash', 'walrusBlobId', 'walrusBlobObjectId', 'contentType'],
  genericFile: ['title', 'description', 'filename', 'fileSize', 'license', 'contentHash', 'walrusBlobId', 'walrusBlobObjectId', 'contentType'],
};

const BUILDERS = {
  preprint: ['reservePreprintCode(owner)', 'finalizeReservedPreprint(reservationId, input)'],
  blogPost: ['publishBlogPost(input)'],
  technicalReport: ['publishTechnicalReport(input)'],
  dataset: ['publishDataset(input)'],
  softwareRelease: ['publishSoftwareRelease(input)'],
  genericFile: ['publishGenericFile(input)'],
};

const ADD_VERSION_BUILDERS = {
  preprint: 'addPreprintVersion(input)',
  blogPost: 'addBlogPostVersion(input)',
  technicalReport: 'addTechnicalReportVersion(input)',
  dataset: 'addDatasetVersion(input)',
  softwareRelease: 'addSoftwareReleaseVersion(input)',
  genericFile: 'addGenericFileVersion(input)',
};

const METADATA_LIMIT = 4;

function nextSteps(missing, metadataValidationIssues) {
  if (missing.length) return ['Collect missing metadata fields.', 'Validate metadata again before Walrus upload.', 'Run wallet readiness checks.'];
  if (metadataValidationIssues.length) return ['Fix metadata validation issues before Walrus upload.', 'Move long provenance or file lists into the content package.', 'Run plan-publish again after edits.'];
  return ['Confirm public persistence with the user.', 'Build the SDK transaction.', 'Ask the wallet or configured signer to review and sign.'];
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function missingFields(type, input) {
  return REQUIRED[type].filter((key) => {
    const value = input[key];
    return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  });
}

function metadataIssues(input) {
  const issues = [];
  for (const key of ['seriesMetadata', 'versionMetadata']) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      issues.push(`${key} must be an array when provided.`);
      continue;
    }
    if (value.length > METADATA_LIMIT) {
      issues.push(`${key} has ${value.length} entries; maximum is ${METADATA_LIMIT}. Move long notes into the content package.`);
    }
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        issues.push(`${key}[${index}] must be an object with key and value.`);
        return;
      }
      if (!entry.key || !entry.value) issues.push(`${key}[${index}] requires non-empty key and value.`);
      if (String(entry.key ?? '').length > 64) issues.push(`${key}[${index}].key is long; keep metadata keys concise.`);
      if (String(entry.value ?? '').length > 511) issues.push(`${key}[${index}].value exceeds 511 characters.`);
    });
  }
  return issues;
}

async function main() {
  const args = parseArgs();
  const type = requireArg(args, 'type');
  if (!REQUIRED[type]) throw new Error(`Unsupported --type. Use one of: ${Object.keys(REQUIRED).join(', ')}`);
  const input = args.input ? loadJson(String(args.input)) : {};
  const missing = missingFields(type, input);
  const metadataValidationIssues = metadataIssues(input);
  const mode = args.series ? 'add-version' : 'publish';
  printJson({
    ok: missing.length === 0 && metadataValidationIssues.length === 0,
    mode,
    artifactType: type,
    seriesId: args.series ?? null,
    commentsPolicy: args.comments ?? 'ask-user',
    requiredFields: REQUIRED[type],
    missingFields: missing,
    metadataValidationIssues,
    sdkBuilders: mode === 'add-version'
      ? [ADD_VERSION_BUILDERS[type]]
      : BUILDERS[type],
    walrusRequiredBeforeChainRegistration: true,
    runBeforeWalrusUpload: true,
    signerRequiredForChainWrite: true,
    websiteRequired: false,
    nextSteps: nextSteps(missing, metadataValidationIssues),
  });
}

main().catch(fail);
