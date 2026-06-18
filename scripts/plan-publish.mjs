#!/usr/bin/env node

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

function loadJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function missingFields(type, input) {
  return REQUIRED[type].filter((key) => {
    const value = input[key];
    return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  });
}

async function main() {
  const args = parseArgs();
  const type = requireArg(args, 'type');
  if (!REQUIRED[type]) throw new Error(`Unsupported --type. Use one of: ${Object.keys(REQUIRED).join(', ')}`);
  const input = args.input ? loadJson(String(args.input)) : {};
  const missing = missingFields(type, input);
  const mode = args.series ? 'add-version' : 'publish';
  printJson({
    ok: missing.length === 0,
    mode,
    artifactType: type,
    seriesId: args.series ?? null,
    commentsPolicy: args.comments ?? 'ask-user',
    requiredFields: REQUIRED[type],
    missingFields: missing,
    sdkBuilders: mode === 'add-version'
      ? [ADD_VERSION_BUILDERS[type]]
      : BUILDERS[type],
    walrusRequiredBeforeChainRegistration: true,
    signerRequiredForChainWrite: true,
    websiteRequired: false,
    nextSteps: missing.length
      ? ['Collect missing metadata fields.', 'Upload final bytes to Walrus if blob references are missing.', 'Run wallet readiness checks.']
      : ['Confirm public persistence with the user.', 'Build the SDK transaction.', 'Ask the wallet or configured signer to review and sign.'],
  });
}

main().catch(fail);
