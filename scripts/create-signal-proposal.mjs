#!/usr/bin/env node

// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import {
  extractProposalResult,
  robustExecuteTransaction,
} from '@paperproof/sdk-ts';

import { loadSignerSet } from './lib/signer.mjs';
import { createResultError } from './lib/publish-runtime.mjs';
import {
  createGovernancePreflight,
  createGovernanceRuntime,
  normalizeActionType,
  normalizeProposalAddress,
  parseGovernanceArgs,
  parseStakePprf,
  printResult,
  proposalSummary,
  requireProposalCreationOpen,
  usageHeader,
} from './lib/governance-runtime.mjs';

function usage() {
  return `
Create a PaperProof governance signal proposal.

Usage:
  node scripts/create-signal-proposal.mjs --preflight --title="..." --description="..." --stake-pprf=10000000 --signer-env=<env> --account=4
  node scripts/create-signal-proposal.mjs --run --title="..." --description="..." --stake-pprf=10000000 --signer-env=<env> --account=4

Required:
  --title=<text>
  --description=<text>
  --stake-pprf=<decimal PPRF amount>

Optional:
  --payload-text=<text>
  --payload-address=<0x...>
  --action-type=signalPolicyPosition|signalFeatureDirection|<u8>
  --account=<n>

${usageHeader()}
`.trim();
}

async function resolveSigner(args, required) {
  const mode = args.signerMode ?? args['signer-mode'] ?? (args.account ? 'indexed-env' : 'auto');
  try {
    const accounts = await loadSignerSet(args, { defaultMode: mode });
    const requested = Number(args.account ?? 1);
    if (args.account || mode === 'indexed-env') {
      const match = accounts.find((item) => item.index === requested);
      if (!match) throw new Error(`Could not find indexed signer account ${requested}.`);
      return { ok: true, account: requested, address: match.address, signer: match.signer };
    }
    const [first] = accounts;
    return { ok: true, account: first.index ?? requested, address: first.address, signer: first.signer };
  } catch (error) {
    if (!required) return { ok: false, ...createResultError('signer', error) };
    throw error;
  }
}

async function main() {
  const args = parseGovernanceArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  if (!args.title) throw new Error('Missing --title=...');
  if (!args.description) throw new Error('Missing --description=...');
  if (!args['stake-pprf'] && !args.stakePprf) throw new Error('Missing --stake-pprf=...');

  const run = Boolean(args.run);
  const runtime = createGovernanceRuntime(args);
  const signerResult = await resolveSigner(args, run || args.preflight);
  const preflight = await createGovernancePreflight({
    runtime,
    signerResult,
    requireSigner: true,
    requireProposal: false,
  });

  const base = {
    ok: false,
    run,
    preflightOnly: Boolean(args.preflight) && !run,
    rpcUrl: runtime.rpcUrl,
    transport: runtime.transport,
    queryTransport: runtime.queryTransport,
    signer: signerResult?.ok ? { address: signerResult.address, account: signerResult.account } : signerResult,
    preflight,
  };

  if (args.preflight && !run) {
    printResult({
      ...base,
      ok: preflight.ok,
      request: {
        title: args.title,
        description: args.description,
        actionType: normalizeActionType(args['action-type'] ?? args.actionType),
        stakePprf: String(args['stake-pprf'] ?? args.stakePprf),
      },
    });
    return;
  }

  if (!preflight.ok) {
    printResult({
      ...base,
      error: {
        category: 'preflight',
        code: 'PREFLIGHT_FAILED',
        summary: 'Preflight failed. Proposal creation was not attempted.',
        criticalFailures: preflight.criticalFailures,
      },
    });
    return;
  }

  const config = await runtime.sdk.read.getGovernanceConfigView();
  requireProposalCreationOpen(config);

  const stakeRaw = parseStakePprf(args['stake-pprf'] ?? args.stakePprf, 'stake');
  const proposerCoin = await runtime.sdk.read.getCoins(signerResult.address, runtime.sdk.deployment.coinTypes.pprf);
  const selectedCoin = proposerCoin.find((coin) => BigInt(coin.balance ?? 0) >= stakeRaw);
  if (!selectedCoin) {
    throw new Error(`No PPRF coin found with at least ${stakeRaw.toString()} raw units for the proposer.`);
  }

  const tx = runtime.sdk.txb.governance.createSignalProposal({
    title: args.title,
    description: args.description,
    actionType: normalizeActionType(args['action-type'] ?? args.actionType),
    payloadText: args['payload-text'] ?? args.payloadText,
    payloadAddress: normalizeProposalAddress(args['payload-address'] ?? args.payloadAddress, signerResult.address),
    stakeCoinId: selectedCoin.coinObjectId,
  });
  tx.setSenderIfNotSet(signerResult.address);

  if (!run) {
    printResult({
      ...base,
      ok: true,
      dryRun: true,
      request: {
        title: args.title,
        description: args.description,
        actionType: normalizeActionType(args['action-type'] ?? args.actionType),
        payloadAddress: normalizeProposalAddress(args['payload-address'] ?? args.payloadAddress, signerResult.address),
        stakeRaw,
        selectedCoinId: selectedCoin.coinObjectId,
      },
    });
    return;
  }

  const execution = await robustExecuteTransaction(runtime.baseClient ?? runtime.jsonRpc, signerResult.signer, tx, 'create signal proposal');
  const extracted = extractProposalResult({
    events: execution.events ?? [],
  }, runtime.sdk.deployment);
  const result = await runtime.sdk.read.getProposalView(extracted.proposalObjectId);
  const proposalResult = {
    proposalObjectId: extracted.proposalObjectId,
    proposal: result,
    preview: {
      determinable: false,
      deterministicPass: false,
      deterministicFail: false,
      remainingVotingSupply: (config.totalSupply ?? 0n) - (result.yesVotes ?? 0n) - (result.noVotes ?? 0n),
    },
  };

  printResult({
    ...base,
    ok: true,
    transactionDigest: execution.digest,
    request: {
      title: args.title,
      description: args.description,
      actionType: normalizeActionType(args['action-type'] ?? args.actionType),
      payloadAddress: normalizeProposalAddress(args['payload-address'] ?? args.payloadAddress, signerResult.address),
      stakeRaw,
      selectedCoinId: selectedCoin.coinObjectId,
    },
    proposal: proposalSummary(proposalResult),
  });
}

main().catch((error) => {
  printResult({
    ok: false,
    error: createResultError('fatal', error),
  });
  process.exitCode = 1;
});
