// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { MAINNET_WALRUS_PACKAGE_CONFIG, walrus } from '@mysten/walrus';
import {
  MAINNET_DEPLOYMENT,
  createDeployment,
  createPaperProofSDK,
} from '@paperproof/sdk-ts';

export const DEFAULT_RPC_URL = MAINNET_DEPLOYMENT.rpcUrl ?? 'https://fullnode.mainnet.sui.io:443';
export const DEFAULT_WALRUS_RELAY = 'https://upload-relay.mainnet.walrus.space';
export const DEFAULT_TRANSPORT = 'jsonrpc';
export const DEFAULT_QUERY_TRANSPORT = 'fallback';
export const DEFAULT_RETRY_ATTEMPTS = 4;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_500;
export const DEFAULT_CONFIRM_ATTEMPTS = 8;
export const DEFAULT_CONFIRM_DELAY_MS = 2_500;

const COIN_TYPES = {
  sui: MAINNET_DEPLOYMENT.coinTypes.sui,
  wal: MAINNET_DEPLOYMENT.coinTypes.wal,
  pprf: MAINNET_DEPLOYMENT.coinTypes.pprf,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function getArg(args, ...names) {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

export function normalizeTransport(value, fallback = DEFAULT_TRANSPORT) {
  const transport = String(value ?? fallback).toLowerCase();
  if (transport === 'jsonrpc' || transport === 'grpc') return transport;
  throw new Error(`Unsupported transport "${transport}". Use jsonrpc or grpc.`);
}

export function normalizeQueryTransport(value, fallback = DEFAULT_QUERY_TRANSPORT) {
  const transport = String(value ?? fallback).toLowerCase();
  if (transport === 'none' || transport === 'jsonrpc' || transport === 'graphql' || transport === 'fallback') return transport;
  throw new Error(`Unsupported query transport "${transport}". Use none, jsonrpc, graphql, or fallback.`);
}

export function parseIntegerArg(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  assert(Number.isFinite(parsed) && parsed > 0, `Expected a positive number, received "${value}".`);
  return Math.trunc(parsed);
}

export function errorMessage(error) {
  const parts = [];
  let current = error;
  let guard = 0;
  while (current && guard < 5) {
    if (current instanceof Error) {
      if (current.message) parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
    guard += 1;
  }
  return parts.filter(Boolean).join(' | ') || 'Unknown error';
}

function textHas(text, ...patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function classifyOperatorError(error, context = {}) {
  const detail = errorMessage(error);
  const text = detail.toLowerCase();
  const stage = context.stage ?? 'unknown';
  const transport = context.transport ?? null;

  const result = {
    ok: false,
    stage,
    category: 'unknown',
    code: 'UNKNOWN_ERROR',
    retryable: false,
    summary: 'Unknown failure.',
    detail,
    transport,
  };

  if (textHas(text, 'missing private_key', 'missing address', 'signer mismatch', 'no usable signer accounts', 'could not find indexed signer account')) {
    result.category = 'signer';
    result.code = 'SIGNER_CONFIG_INVALID';
    result.summary = 'Signer environment could not be resolved.';
    return result;
  }

  if (textHas(text, 'series owner', 'does not match signer')) {
    result.category = 'permission';
    result.code = 'SERIES_OWNER_MISMATCH';
    result.summary = 'Signer is not the owner of the target series.';
    return result;
  }

  if (textHas(text, 'unsupported transport', 'unsupported query transport')) {
    result.category = 'configuration';
    result.code = 'TRANSPORT_CONFIG_INVALID';
    result.summary = 'Requested transport configuration is invalid.';
    return result;
  }

  if (textHas(text, 'client network socket disconnected before secure tls connection was established', 'econnreset', 'socket hang up', 'tls')) {
    result.category = stage === 'walrusRelay' ? 'walrusRelay' : 'network';
    result.code = stage === 'walrusRelay' ? 'WALRUS_RELAY_TLS_RESET' : 'SUI_NETWORK_TLS_RESET';
    result.retryable = true;
    result.summary = stage === 'walrusRelay'
      ? 'Walrus relay connection was reset during TLS setup.'
      : 'Sui endpoint connection was reset during TLS setup.';
    return result;
  }

  if (textHas(text, 'fetch failed', 'connection timeout', 'timeout', 'timed out')) {
    result.category = stage === 'walrusRelay' ? 'walrusRelay' : 'network';
    result.code = stage === 'walrusRelay' ? 'WALRUS_RELAY_UNREACHABLE' : 'ENDPOINT_UNREACHABLE';
    result.retryable = true;
    result.summary = stage === 'walrusRelay'
      ? 'Walrus relay is reachable only intermittently or not at all.'
      : 'Configured Sui endpoint is unreachable or unstable.';
    return result;
  }

  if (textHas(text, 'grpc', 'movepackageservice', 'getfunction', 'getbalance', 'unavailable', '14 unavailable')) {
    result.category = 'sui';
    result.code = 'GRPC_UNAVAILABLE';
    result.retryable = true;
    result.summary = 'Sui gRPC path is unavailable or unstable.';
    return result;
  }

  if (textHas(text, 'multigetobjects', 'getdynamicfieldobject', 'get object', 'getobject')) {
    result.category = 'sui';
    result.code = 'JSONRPC_OBJECT_READ_FAILED';
    result.retryable = true;
    result.summary = 'JSON-RPC object read failed.';
    return result;
  }

  if (textHas(text, 'object not found', 'dynamic field not found', 'not found')) {
    result.category = stage === 'series' || stage === 'confirmation' ? 'series' : 'sui';
    result.code = stage === 'series' || stage === 'confirmation' ? 'SERIES_OR_VERSION_NOT_FOUND' : 'OBJECT_NOT_FOUND';
    result.summary = stage === 'series' || stage === 'confirmation'
      ? 'Target series or version could not be read from chain.'
      : 'Expected Sui object was not found.';
    return result;
  }

  if (textHas(text, 'insufficient', 'gas', 'balance')) {
    result.category = 'balance';
    result.code = 'BALANCE_OR_GAS_INSUFFICIENT';
    result.summary = 'Signer balance appears insufficient for this operation.';
    return result;
  }

  if (textHas(text, 'walrus upload failed', 'blob', 'upload relay')) {
    result.category = 'walrus';
    result.code = 'WALRUS_UPLOAD_FAILED';
    result.retryable = true;
    result.summary = 'Walrus upload stage failed before add-version submission.';
    return result;
  }

  if (textHas(text, 'failed on-chain', 'before a confirmed on-chain result', 'moveabort')) {
    result.category = 'transaction';
    result.code = 'CHAIN_TRANSACTION_FAILED';
    result.retryable = textHas(text, 'shared object', 'needs to be rebuilt', 'unavailable for consumption');
    result.summary = 'Add-version transaction failed or could not be confirmed on-chain.';
    return result;
  }

  return result;
}

export function createResultError(stage, error, context = {}) {
  return classifyOperatorError(error, { ...context, stage });
}

export function shouldRetryTransportError(error) {
  const classified = classifyOperatorError(error);
  return classified.retryable;
}

export function transportConfigFromArgs(args, options = {}) {
  const deployment = createDeployment(options.deployment ?? MAINNET_DEPLOYMENT);
  const transport = normalizeTransport(getArg(args, 'transport'), options.defaultTransport ?? DEFAULT_TRANSPORT);
  const queryTransport = normalizeQueryTransport(getArg(args, 'queryTransport', 'query-transport'), options.defaultQueryTransport ?? DEFAULT_QUERY_TRANSPORT);
  const rpcUrl = String(getArg(args, 'rpc') ?? options.rpcUrl ?? deployment.rpcUrl ?? DEFAULT_RPC_URL);
  const walrusRelay = String(getArg(args, 'walrusRelay', 'walrus-relay') ?? options.walrusRelay ?? DEFAULT_WALRUS_RELAY);
  const graphQLEndpoint = getArg(args, 'graphql', 'graphql-endpoint');
  return {
    deployment,
    transport,
    queryTransport,
    rpcUrl,
    walrusRelay,
    graphQLEndpoint: typeof graphQLEndpoint === 'string' ? graphQLEndpoint : undefined,
    retryAttempts: parseIntegerArg(getArg(args, 'retryAttempts', 'retry-attempts'), DEFAULT_RETRY_ATTEMPTS),
    retryBaseDelayMs: parseIntegerArg(getArg(args, 'retryBaseMs', 'retry-base-ms'), DEFAULT_RETRY_BASE_DELAY_MS),
    confirmAttempts: parseIntegerArg(getArg(args, 'confirmAttempts', 'confirm-attempts'), DEFAULT_CONFIRM_ATTEMPTS),
    confirmDelayMs: parseIntegerArg(getArg(args, 'confirmDelayMs', 'confirm-delay-ms'), DEFAULT_CONFIRM_DELAY_MS),
  };
}

export function createBaseClient({ transport, rpcUrl, network }) {
  if (transport === 'grpc') {
    return new SuiGrpcClient({ baseUrl: rpcUrl, network });
  }
  return new SuiJsonRpcClient({ url: rpcUrl, network });
}

export function createWalrusClient(baseClient, walrusRelay) {
  return baseClient.$extend(
    walrus({
      packageConfig: MAINNET_WALRUS_PACKAGE_CONFIG,
      uploadRelay: {
        host: walrusRelay,
        sendTip: { max: 5_000_000 },
      },
    }),
  );
}

export function createSkillRuntime(args, options = {}) {
  const config = transportConfigFromArgs(args, options);
  const sdk = createPaperProofSDK({
    deployment: config.deployment,
    transport: config.transport,
    rpcUrl: config.rpcUrl,
    queryTransport: config.queryTransport,
    ...(config.graphQLEndpoint ? { graphQLEndpoint: config.graphQLEndpoint } : {}),
    readRetry: {
      attempts: config.retryAttempts,
      baseDelayMs: config.retryBaseDelayMs,
      retryable: shouldRetryTransportError,
    },
  });
  const baseClient = createBaseClient({
    transport: config.transport,
    rpcUrl: config.rpcUrl,
    network: config.deployment.network,
  });
  const walrusClient = createWalrusClient(baseClient, config.walrusRelay);
  return {
    ...config,
    sdk,
    baseClient,
    walrusClient,
  };
}

export async function rawGetObject(baseClient, transport, objectId) {
  if (transport === 'grpc') {
    return baseClient.getObject({
      objectId,
      include: {
        json: true,
        owner: true,
        previousTransaction: true,
      },
    });
  }
  return baseClient.getObject({
    id: objectId,
    options: {
      showContent: true,
      showOwner: true,
      showPreviousTransaction: true,
    },
  });
}

export async function rawGetBalance(baseClient, transport, owner, coinType) {
  if (transport === 'grpc') {
    const result = await baseClient.getBalance({ owner, coinType });
    return {
      totalBalance: result.balance.balance,
      coinObjectCount: result.balance.coinObjectCount ?? null,
    };
  }
  const result = await baseClient.getBalance({ owner, coinType });
  return {
    totalBalance: result.totalBalance,
    coinObjectCount: result.coinObjectCount ?? null,
  };
}

export async function pingWalrusRelay(url, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        accept: 'application/json,text/plain,*/*',
      },
    });
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      reachable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getBalances(baseClient, transport, owner) {
  const balances = {};
  for (const [symbol, coinType] of Object.entries(COIN_TYPES)) {
    balances[symbol] = {
      coinType,
      ...(await rawGetBalance(baseClient, transport, owner, coinType)),
    };
  }
  return balances;
}

export function evaluateFunding(balances) {
  const insufficient = Object.entries(balances)
    .filter(([, balance]) => String(balance.totalBalance ?? '0') === '0')
    .map(([symbol]) => symbol);
  return {
    ok: insufficient.length === 0,
    insufficient,
  };
}

export async function runPublishPreflight({
  runtime,
  requireSigner,
  signerResult,
  seriesId,
  expectedArtifactType,
}) {
  const checks = {};
  const criticalFailures = [];

  try {
    const rootObject = await rawGetObject(runtime.baseClient, runtime.transport, runtime.deployment.objects.root);
    checks.rpc = {
      ok: true,
      transport: runtime.transport,
      rpcUrl: runtime.rpcUrl,
      rootObjectId: runtime.deployment.objects.root,
      hasObject: Boolean(rootObject?.data ?? rootObject?.object),
    };
  } catch (error) {
    checks.rpc = {
      ...createResultError('rpc', error, { transport: runtime.transport }),
      rpcUrl: runtime.rpcUrl,
    };
    criticalFailures.push('rpc');
  }

  try {
    const relay = await pingWalrusRelay(runtime.walrusRelay);
    checks.walrusRelay = {
      ok: true,
      url: runtime.walrusRelay,
      status: relay.status,
      statusText: relay.statusText,
    };
  } catch (error) {
    checks.walrusRelay = {
      ...createResultError('walrusRelay', error, { transport: runtime.transport }),
      url: runtime.walrusRelay,
    };
    if (requireSigner) criticalFailures.push('walrusRelay');
  }

  if (signerResult) {
    checks.signer = signerResult.ok
      ? {
          ok: true,
          address: signerResult.address,
          account: signerResult.account ?? null,
        }
      : signerResult;
    if (!signerResult.ok && requireSigner) criticalFailures.push('signer');
  } else {
    checks.signer = {
      ok: !requireSigner,
      skipped: !requireSigner,
      summary: requireSigner ? 'Signer was required but not resolved.' : 'Signer not required for this preflight.',
    };
    if (requireSigner) criticalFailures.push('signer');
  }

  if (signerResult?.ok) {
    try {
      const balances = await getBalances(runtime.baseClient, runtime.transport, signerResult.address);
      const funding = evaluateFunding(balances);
      checks.balances = {
        ok: true,
        address: signerResult.address,
        balances,
        fundingOk: funding.ok,
        insufficient: funding.insufficient,
      };
      if (requireSigner && !funding.ok) criticalFailures.push('balances');
    } catch (error) {
      checks.balances = {
        ...createResultError('balances', error, { transport: runtime.transport }),
        address: signerResult.address,
      };
      if (requireSigner) criticalFailures.push('balances');
    }
  } else {
    checks.balances = {
      ok: false,
      skipped: true,
      summary: 'Balance check skipped because signer was not available.',
    };
  }

  try {
    const details = await runtime.sdk.query.getSeriesDetails(seriesId);
    checks.series = {
      ok: true,
      seriesId,
      artifactCode: details.series.artifactCode,
      artifactType: details.series.artifactType,
      owner: details.series.owner,
      currentVersion: details.series.currentVersion,
      currentVersionId: details.series.currentVersionId,
      currentContentHash: details.currentVersion?.contentHash ?? null,
      title: details.currentVersion?.rawFields?.title ?? null,
    };
    if (expectedArtifactType !== undefined && details.series.artifactType !== expectedArtifactType) {
      checks.series = {
        ok: false,
        category: 'series',
        code: 'SERIES_TYPE_MISMATCH',
        summary: `Series artifact type ${details.series.artifactType} does not match expected type ${expectedArtifactType}.`,
        detail: `Series ${seriesId} returned artifact type ${details.series.artifactType}.`,
        seriesId,
        artifactCode: details.series.artifactCode,
      };
      criticalFailures.push('series');
    }
  } catch (error) {
    checks.series = {
      ...createResultError('series', error, { transport: runtime.transport }),
      seriesId,
    };
    criticalFailures.push('series');
  }

  return {
    ok: criticalFailures.length === 0,
    criticalFailures,
    checks,
    transport: runtime.transport,
    queryTransport: runtime.queryTransport,
    rpcUrl: runtime.rpcUrl,
    walrusRelay: runtime.walrusRelay,
  };
}

export async function confirmLatestVersion({
  runtime,
  seriesId,
  expectedVersionId,
  expectedContentHash,
  attempts = runtime.confirmAttempts ?? DEFAULT_CONFIRM_ATTEMPTS,
  delayMs = runtime.confirmDelayMs ?? DEFAULT_CONFIRM_DELAY_MS,
}) {
  let last = null;
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      last = await runtime.sdk.query.getSeriesDetails(seriesId);
      if (
        last.series.currentVersionId === expectedVersionId
        && last.currentVersion?.contentHash === expectedContentHash
      ) {
        return {
          ok: true,
          transport: runtime.transport,
          currentVersion: last.series.currentVersion,
          currentVersionId: last.series.currentVersionId,
          currentContentHash: last.currentVersion?.contentHash ?? null,
          attemptsUsed: index + 1,
        };
      }
      lastError = new Error(
        `Latest version still points to ${last.series.currentVersionId ?? 'unknown'} instead of ${expectedVersionId}.`,
      );
    } catch (error) {
      lastError = error;
    }
    if (index < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return {
    ok: false,
    ...(createResultError('confirmation', lastError ?? new Error('Latest version confirmation failed.'), { transport: runtime.transport })),
    observedCurrentVersion: last?.series?.currentVersion ?? null,
    observedCurrentVersionId: last?.series?.currentVersionId ?? null,
    observedCurrentContentHash: last?.currentVersion?.contentHash ?? null,
    attemptsUsed: attempts,
  };
}
