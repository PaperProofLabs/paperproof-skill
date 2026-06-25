#!/usr/bin/env node

// Copyright (c) 2026 PaperProof Labs
// SPDX-License-Identifier: Apache-2.0

import { fail, printJson } from './lib/cli.mjs';
import {
  actionTypeLabel,
  createGovernanceRuntime,
  governanceStatusLabel,
  parseGovernanceArgs,
  proposalSummary,
  readProposal,
} from './lib/governance-runtime.mjs';

function usage() {
  return `
Query PaperProof governance config or a specific proposal.

Usage:
  node scripts/query-governance.mjs
  node scripts/query-governance.mjs --proposal=22
  node scripts/query-governance.mjs --proposal=0x...
`.trim();
}

async function main() {
  const args = parseGovernanceArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const runtime = createGovernanceRuntime(args);
  const config = await runtime.sdk.read.getGovernanceConfigView();
  const result = {
    ok: true,
    rpcUrl: runtime.rpcUrl,
    transport: runtime.transport,
    queryTransport: runtime.queryTransport,
    governance: {
      governanceConfigId: config.id,
      totalSupply: config.totalSupply ?? null,
      proposerThreshold: config.proposerThreshold ?? null,
      proposalDurationEpochs: config.proposalDurationEpochs ?? null,
      nextProposalId: config.nextProposalId ?? null,
      proposalCreationPaused: config.proposalCreationPaused ?? null,
      activeProposalId: config.activeProposalId ?? null,
    },
  };

  if (args.proposal) {
    const proposal = await readProposal(runtime, args.proposal);
    result.proposal = {
      ...proposalSummary(proposal),
      statusLabel: governanceStatusLabel(proposal.proposal.status),
      actionTypeLabel: actionTypeLabel(proposal.proposal.actionType),
    };
  }

  printJson(result);
}

main().catch(fail);
