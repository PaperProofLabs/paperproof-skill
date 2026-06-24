// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises';
import path from 'node:path';

import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeAddress(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/^"|"$/g, '');
  const noPrefix = raw.startsWith('0x') ? raw.slice(2) : raw.startsWith('x') ? raw.slice(1) : raw;
  return `0x${noPrefix.padStart(64, '0')}`;
}

export function parseEnv(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}

async function readEnvMap(envPath) {
  if (!envPath) return new Map(Object.entries(process.env));
  const text = await fs.readFile(path.resolve(envPath), 'utf8');
  return parseEnv(text);
}

function signerFromSecret(address, secret, label) {
  const normalizedAddress = normalizeAddress(address);
  const decoded = decodeSuiPrivateKey(secret);
  assert(decoded.scheme === 'ED25519', `${label} must use an Ed25519 key.`);
  const signer = Ed25519Keypair.fromSecretKey(decoded.secretKey);
  assert(normalizeAddress(signer.toSuiAddress()) === normalizedAddress, `${label} signer mismatch.`);
  return { address: normalizedAddress, signer };
}

export async function loadSingleSigner({
  envPath,
  addressVar = 'ADDRESS',
  privateKeyVar = 'PRIVATE_KEY',
}) {
  const env = await readEnvMap(envPath);
  const address = env.get(addressVar);
  const secret = env.get(privateKeyVar);
  assert(address, `Missing ${addressVar} in signer environment.`);
  assert(secret, `Missing ${privateKeyVar} in signer environment.`);
  return signerFromSecret(address, secret, addressVar);
}

export async function loadIndexedAccounts({
  envPath,
  maxAccounts = 16,
  addressPrefix = 'ADDR_',
  privateKeyPrefix = 'PRIVATE_KEY_',
}) {
  const env = await readEnvMap(envPath);
  const accounts = [];
  for (let index = 1; index <= maxAccounts; index += 1) {
    const address = env.get(`${addressPrefix}${index}`);
    const secret = env.get(`${privateKeyPrefix}${index}`);
    if (!address || !secret) continue;
    const account = signerFromSecret(address, secret, `${addressPrefix}${index}`);
    accounts.push({ index, ...account });
  }
  assert(accounts.length > 0, 'No usable signer accounts found in signer environment.');
  return accounts;
}

export async function loadSignerSet(args, options = {}) {
  const mode = String(
    args.signerMode
      ?? args['signer-mode']
      ?? options.defaultMode
      ?? 'auto',
  ).toLowerCase();
  const envPath = args.signerEnv ?? args['signer-env'] ?? options.envPath;
  if (mode === 'single-env') {
    const account = await loadSingleSigner({
      envPath,
      addressVar: args.addressVar ?? args['address-var'] ?? options.addressVar,
      privateKeyVar: args.privateKeyVar ?? args['private-key-var'] ?? options.privateKeyVar,
    });
    return [account];
  }
  if (mode === 'indexed-env') {
    return loadIndexedAccounts({
      envPath,
      maxAccounts: Number(args.maxAccounts ?? args['max-accounts'] ?? options.maxAccounts ?? 16),
      addressPrefix: args.addressPrefix ?? args['address-prefix'] ?? options.addressPrefix,
      privateKeyPrefix: args.privateKeyPrefix ?? args['private-key-prefix'] ?? options.privateKeyPrefix,
    });
  }
  if (mode !== 'auto') {
    throw new Error(`Unsupported --signer-mode=${mode}. Use auto, single-env, or indexed-env.`);
  }

  try {
    const account = await loadSingleSigner({
      envPath,
      addressVar: args.addressVar ?? args['address-var'] ?? options.addressVar,
      privateKeyVar: args.privateKeyVar ?? args['private-key-var'] ?? options.privateKeyVar,
    });
    return [account];
  } catch {}

  return loadIndexedAccounts({
    envPath,
    maxAccounts: Number(args.maxAccounts ?? args['max-accounts'] ?? options.maxAccounts ?? 16),
    addressPrefix: args.addressPrefix ?? args['address-prefix'] ?? options.addressPrefix,
    privateKeyPrefix: args.privateKeyPrefix ?? args['private-key-prefix'] ?? options.privateKeyPrefix,
  });
}
