#!/usr/bin/env node

// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import { robustExecuteTransaction } from '@paperproof/sdk-ts';

import { loadSignerSet } from './lib/signer.mjs';
import { createResultError } from './lib/publish-runtime.mjs';
import {
  createGovernancePreflight,
  createGovernanceRuntime,
  parseGovernanceArgs,
  parseStakePprf,
  printResult,
  proposalSummary,
  readProposal,
  requireActiveProposal,
  requireStakeAboveMinimum,
  usageHeader,
} from './lib/governance-runtime.mjs';

function usage() {
  return `
Vote on an active PaperProof governance proposal.

Usage:
  node scripts/vote-proposal.mjs --preflight --proposal=22 --side=yes --stake-pprf=101 --signer-env=<env> --account=1
  node scripts/vote-proposal.mjs --run --proposal=0x... --side=no --stake-pprf=150 --signer-env=<env> --account=2

Required:
  --proposal=<proposal id or object id>
  --side=yes|no
  --stake-pprf=<decimal PPRF amount>

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

  const proposalRef = args.proposal;
  if (!proposalRef) throw new Error('Missing --proposal=...');
  const side = String(args.side ?? '').toLowerCase();
  if (side !== 'yes' && side !== 'no') throw new Error('Missing or invalid --side=yes|no.');
  if (!args['stake-pprf'] && !args.stakePprf) throw new Error('Missing --stake-pprf=...');

  const run = Boolean(args.run);
  const runtime = createGovernanceRuntime(args);
  const signerResult = await resolveSigner(args, run || args.preflight);
  const preflight = await createGovernancePreflight({
    runtime,
    signerResult,
    proposalRef,
    requireSigner: true,
    requireProposal: true,
  });

  const base = {
    ok: false,
    run,
    preflightOnly: Boolean(args.preflight) && !run,
    rpcUrl: runtime.rpcUrl,
    transport: runtime.transport,
    queryTransport: runtime.queryTransport,
    proposalRef,
    voteSide: side,
    signer: signerResult?.ok ? { address: signerResult.address, account: signerResult.account } : signerResult,
    preflight,
  };

  if (args.preflight && !run) {
    printResult({
      ...base,
      ok: preflight.ok,
      requestedStakePprf: String(args['stake-pprf'] ?? args.stakePprf),
    });
    return;
  }

  if (!preflight.ok) {
    printResult({
      ...base,
      error: {
        category: 'preflight',
        code: 'PREFLIGHT_FAILED',
        summary: 'Preflight failed. Vote was not attempted.',
        criticalFailures: preflight.criticalFailures,
      },
    });
    return;
  }

  const stakeRaw = parseStakePprf(args['stake-pprf'] ?? args.stakePprf, 'vote stake');
  requireStakeAboveMinimum(stakeRaw);
  const proposalState = await readProposal(runtime, proposalRef);
  requireActiveProposal(proposalState.proposal);

  const coin = await runtime.jsonRpc.getCoins({
    owner: signerResult.address,
    coinType: runtime.sdk.deployment.coinTypes.pprf,
  });
  const selectedCoin = (coin.data ?? [])
    .filter((item) => BigInt(item.balance) >= stakeRaw)
    .sort((left, right) => (BigInt(right.balance) > BigInt(left.balance) ? 1 : -1))[0];
  if (!selectedCoin) throw new Error(`No PPRF coin found with at least ${stakeRaw.toString()} raw units for voting.`);

  const tx = side === 'yes'
    ? runtime.sdk.txb.governance.voteYes({ proposalId: proposalState.proposalObjectId, coinId: selectedCoin.coinObjectId })
    : runtime.sdk.txb.governance.voteNo({ proposalId: proposalState.proposalObjectId, coinId: selectedCoin.coinObjectId });
  tx.setSenderIfNotSet(signerResult.address);

  if (!run) {
    printResult({
      ...base,
      ok: true,
      dryRun: true,
      selectedCoinId: selectedCoin.coinObjectId,
      stakeRaw,
      proposal: proposalSummary(proposalState),
    });
    return;
  }

  const execution = await robustExecuteTransaction(runtime.baseClient ?? runtime.jsonRpc, signerResult.signer, tx, `vote ${side}`);
  const updated = await readProposal(runtime, proposalState.proposalObjectId);
  printResult({
    ...base,
    ok: true,
    transactionDigest: execution.digest,
    selectedCoinId: selectedCoin.coinObjectId,
    stakeRaw,
    proposal: proposalSummary(updated),
  });
}

main().catch((error) => {
  printResult({
    ok: false,
    error: createResultError('fatal', error),
  });
  process.exitCode = 1;
});
