// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import {
  GOVERNANCE,
  MIN_VOTE_STAKE,
  ONE_PPRF,
  createPaperProofSDK,
  stringifyForJson,
} from '@paperproof/sdk-ts';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

import { DEFAULT_RPC_URL, createResultError, errorMessage, getArg } from './publish-runtime.mjs';
import { normalizeAddress } from './signer.mjs';

export const DEFAULT_GOVERNANCE_TRANSPORT = 'jsonrpc';
export const DEFAULT_GOVERNANCE_QUERY_TRANSPORT = 'fallback';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function usageHeader() {
  return [
    'Signer modes:',
    '  --signer-mode=auto         auto-detect single-env first, then indexed-env',
    '  --signer-mode=single-env   use ADDRESS / PRIVATE_KEY (or custom --address-var / --private-key-var)',
    '  --signer-mode=indexed-env  use ADDR_1 / PRIVATE_KEY_1 ... ADDR_16 / PRIVATE_KEY_16',
    '',
    'Transport:',
    '  --rpc=<url>',
    '  --transport=jsonrpc|grpc',
    '  --query-transport=none|jsonrpc|graphql|fallback',
  ].join('\n');
}

export function parseGovernanceArgs(argv = process.argv.slice(2)) {
  const args = { help: false, preflight: false, run: false };
  for (const item of argv) {
    if (item === '--help' || item === '-h') args.help = true;
    else if (item === '--preflight' || item === '--preflight-only') args.preflight = true;
    else if (item === '--run') args.run = true;
    else if (item.startsWith('--')) {
      const index = item.indexOf('=');
      if (index === -1) args[item.slice(2)] = true;
      else args[item.slice(2, index)] = item.slice(index + 1);
    } else {
      if (!args._) args._ = [];
      args._.push(item);
    }
  }
  return args;
}

export function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  assert(Number.isFinite(parsed) && parsed > 0, `${label} must be a positive integer.`);
  return Math.trunc(parsed);
}

export function parseStakePprf(value, label = 'stake') {
  assert(value !== undefined && value !== null && String(value).trim().length > 0, `Missing ${label} amount.`);
  const raw = String(value).trim();
  assert(/^\d+(\.\d+)?$/.test(raw), `${label} must be a decimal PPRF amount.`);
  const [wholeText, fractionText = ''] = raw.split('.');
  const whole = BigInt(wholeText);
  const fraction = BigInt((fractionText.padEnd(9, '0')).slice(0, 9));
  return whole * ONE_PPRF + fraction;
}

export function formatPprf(raw) {
  const value = BigInt(raw);
  const whole = value / ONE_PPRF;
  const fraction = value % ONE_PPRF;
  if (fraction === 0n) return `${whole} PPRF`;
  return `${whole}.${fraction.toString().padStart(9, '0').replace(/0+$/, '')} PPRF`;
}

export function governanceStatusLabel(status) {
  switch (Number(status)) {
    case GOVERNANCE.statusActive:
      return 'active';
    case GOVERNANCE.statusPassed:
      return 'passed';
    case GOVERNANCE.statusRejected:
      return 'rejected';
    case GOVERNANCE.statusExecuted:
      return 'executed';
    case GOVERNANCE.statusExpired:
      return 'expired';
    default:
      return `unknown:${status}`;
  }
}

export function actionTypeLabel(actionType) {
  switch (Number(actionType)) {
    case GOVERNANCE.actionSignalFeatureDirection:
      return 'signalFeatureDirection';
    case GOVERNANCE.actionSignalPolicyPosition:
      return 'signalPolicyPosition';
    default:
      return `custom:${actionType}`;
  }
}

export function outcomePreview(totalSupplyRaw, yesVotesRaw, noVotesRaw) {
  const totalSupply = BigInt(totalSupplyRaw ?? 0);
  const yesVotes = BigInt(yesVotesRaw ?? 0);
  const noVotes = BigInt(noVotesRaw ?? 0);
  const remainingVotingSupply = totalSupply - yesVotes - noVotes;
  const passageRuleSatisfied = (yes, no) => yes * 3n >= no * 4n && yes * 10n > totalSupply;
  const deterministicPass = passageRuleSatisfied(yesVotes, noVotes + remainingVotingSupply);
  const deterministicFail = !passageRuleSatisfied(yesVotes + remainingVotingSupply, noVotes);
  return {
    determinable: deterministicPass || deterministicFail,
    deterministicPass,
    deterministicFail,
    remainingVotingSupply,
  };
}

export function createGovernanceRuntime(args) {
  const rpcUrl = String(getArg(args, 'rpc') ?? DEFAULT_RPC_URL);
  const transport = String(getArg(args, 'transport') ?? DEFAULT_GOVERNANCE_TRANSPORT).toLowerCase();
  const queryTransport = String(getArg(args, 'queryTransport', 'query-transport') ?? DEFAULT_GOVERNANCE_QUERY_TRANSPORT).toLowerCase();
  const sdk = createPaperProofSDK({
    network: 'mainnet',
    transport,
    queryTransport,
    rpcUrl,
  });
  const jsonRpc = new SuiJsonRpcClient({ url: rpcUrl });
  return { sdk, jsonRpc, rpcUrl, transport, queryTransport };
}

export async function fetchGovernanceConfig(runtime) {
  const config = await runtime.sdk.read.getGovernanceConfigView();
  return {
    id: config.id,
    totalSupply: config.totalSupply ?? null,
    proposerThreshold: config.proposerThreshold ?? null,
    proposalDurationEpochs: config.proposalDurationEpochs ?? null,
    nextProposalId: config.nextProposalId ?? null,
    proposalCreationPaused: config.proposalCreationPaused ?? null,
    activeProposalId: config.activeProposalId ?? null,
  };
}

export async function fetchSignerBalances(runtime, address) {
  const balances = {};
  for (const [label, coinType] of Object.entries(runtime.sdk.deployment.coinTypes)) {
    const balance = await runtime.jsonRpc.getBalance({ owner: address, coinType });
    balances[label] = {
      coinType,
      totalBalance: BigInt(balance.totalBalance),
      coinObjectCount: balance.coinObjectCount,
    };
  }
  return balances;
}

export async function fetchCoins(runtime, owner, coinType) {
  const coins = [];
  let cursor = null;
  do {
    const page = await runtime.jsonRpc.getCoins({ owner, coinType, cursor });
    coins.push(...(page.data ?? []));
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return coins;
}

export async function findVoteCoin(runtime, owner, minAmountRaw) {
  const coins = await fetchCoins(runtime, owner, runtime.sdk.deployment.coinTypes.pprf);
  const sorted = coins
    .filter((coin) => BigInt(coin.balance) >= BigInt(minAmountRaw))
    .sort((left, right) => (BigInt(right.balance) > BigInt(left.balance) ? 1 : -1));
  return sorted[0] ?? null;
}

export async function findProposalObjectId(runtime, proposalRef) {
  if (!proposalRef) throw new Error('Missing proposal reference.');
  const value = String(proposalRef).trim();
  if (value.startsWith('0x')) return value;
  return runtime.sdk.read.getProposalObjectId(value);
}

export async function readProposal(runtime, proposalRef) {
  const proposalObjectId = await findProposalObjectId(runtime, proposalRef);
  const proposal = await runtime.sdk.read.getProposalView(proposalObjectId);
  const config = await fetchGovernanceConfig(runtime);
  const preview = outcomePreview(config.totalSupply ?? 0n, proposal.yesVotes ?? 0n, proposal.noVotes ?? 0n);
  return {
    proposalObjectId,
    proposal,
    config,
    preview,
  };
}

export async function createGovernancePreflight({ runtime, signerResult, proposalRef, requireSigner, requireProposal }) {
  const checks = {};
  const criticalFailures = [];

  try {
    const config = await fetchGovernanceConfig(runtime);
    checks.rpc = {
      ok: true,
      rpcUrl: runtime.rpcUrl,
      transport: runtime.transport,
      governanceConfigId: config.id,
    };
    checks.governance = {
      ok: true,
      proposerThreshold: config.proposerThreshold,
      proposalDurationEpochs: config.proposalDurationEpochs,
      proposalCreationPaused: config.proposalCreationPaused,
      activeProposalId: config.activeProposalId,
      totalSupply: config.totalSupply,
    };
  } catch (error) {
    checks.rpc = {
      ...createResultError('rpc', error, { transport: runtime.transport }),
      rpcUrl: runtime.rpcUrl,
    };
    criticalFailures.push('rpc');
  }

  if (signerResult?.ok) {
    checks.signer = {
      ok: true,
      address: signerResult.address,
      account: signerResult.account ?? null,
    };
    try {
      checks.balances = {
        ok: true,
        address: signerResult.address,
        balances: await fetchSignerBalances(runtime, signerResult.address),
      };
    } catch (error) {
      checks.balances = {
        ...createResultError('balances', error, { transport: runtime.transport }),
        address: signerResult.address,
      };
      if (requireSigner) criticalFailures.push('balances');
    }
  } else {
    checks.signer = signerResult ?? {
      ok: !requireSigner,
      skipped: !requireSigner,
      summary: requireSigner ? 'Signer is required for this operation.' : 'Signer not required.',
    };
    checks.balances = {
      ok: false,
      skipped: true,
      summary: 'Balance check skipped because signer was not resolved.',
    };
    if (requireSigner) criticalFailures.push('signer');
  }

  if (requireProposal && proposalRef) {
    try {
      const result = await readProposal(runtime, proposalRef);
      checks.proposal = {
        ok: true,
        proposalObjectId: result.proposalObjectId,
        proposalId: result.proposal.proposalId,
        title: result.proposal.title,
        status: result.proposal.status,
        statusLabel: governanceStatusLabel(result.proposal.status),
        proposer: result.proposal.proposer,
        yesVotes: result.proposal.yesVotes,
        noVotes: result.proposal.noVotes,
        preview: {
          determinable: result.preview.determinable,
          deterministicPass: result.preview.deterministicPass,
          deterministicFail: result.preview.deterministicFail,
          remainingVotingSupply: result.preview.remainingVotingSupply,
        },
      };
    } catch (error) {
      checks.proposal = {
        ...createResultError('proposal', error, { transport: runtime.transport }),
        proposalRef,
      };
      criticalFailures.push('proposal');
    }
  } else {
    checks.proposal = {
      ok: !requireProposal,
      skipped: !requireProposal,
      summary: requireProposal ? 'Proposal read is required for this operation.' : 'Proposal read not required.',
    };
    if (requireProposal) criticalFailures.push('proposal');
  }

  return {
    ok: criticalFailures.length === 0,
    criticalFailures,
    checks,
    rpcUrl: runtime.rpcUrl,
    transport: runtime.transport,
    queryTransport: runtime.queryTransport,
  };
}

export function requireActiveProposal(proposal) {
  assert(Number(proposal.status) === GOVERNANCE.statusActive, `Proposal is not active. Current status: ${governanceStatusLabel(proposal.status)}.`);
}

export function requireProposalCreationOpen(config) {
  assert(!config.proposalCreationPaused, 'Governance proposal creation is currently paused.');
  assert(config.activeProposalId == null, `Another active proposal already exists: ${config.activeProposalId}.`);
}

export function requireStakeAboveMinimum(amountRaw) {
  assert(BigInt(amountRaw) > BigInt(MIN_VOTE_STAKE), `Vote amount must be strictly greater than ${formatPprf(MIN_VOTE_STAKE)}.`);
}

export function normalizeActionType(value) {
  if (value === undefined || value === null || value === '') return GOVERNANCE.actionSignalPolicyPosition;
  const text = String(value).trim();
  if (text === 'signalFeatureDirection') return GOVERNANCE.actionSignalFeatureDirection;
  if (text === 'signalPolicyPosition') return GOVERNANCE.actionSignalPolicyPosition;
  return parsePositiveInteger(text, 'action type');
}

export function proposalSummary(result) {
  return {
    proposalObjectId: result.proposalObjectId,
    proposalId: result.proposal.proposalId,
    title: result.proposal.title,
    description: result.proposal.description,
    status: result.proposal.status,
    statusLabel: governanceStatusLabel(result.proposal.status),
    actionType: result.proposal.actionType,
    actionTypeLabel: actionTypeLabel(result.proposal.actionType),
    proposer: result.proposal.proposer,
    yesVotes: result.proposal.yesVotes,
    noVotes: result.proposal.noVotes,
    startEpoch: result.proposal.startEpoch,
    endEpoch: result.proposal.endEpoch,
    payloadAddress: result.proposal.payloadAddress,
    preview: {
      determinable: result.preview.determinable,
      deterministicPass: result.preview.deterministicPass,
      deterministicFail: result.preview.deterministicFail,
      remainingVotingSupply: result.preview.remainingVotingSupply,
    },
  };
}

export function printResult(value) {
  console.log(stringifyForJson(value));
}

export function explainSignerError(error) {
  const detail = errorMessage(error);
  return {
    ok: false,
    ...createResultError('signer', error),
    detail,
  };
}

export function normalizeProposalAddress(value, fallback) {
  if (value === undefined || value === null || String(value).trim().length === 0) return fallback;
  return normalizeAddress(value);
}
