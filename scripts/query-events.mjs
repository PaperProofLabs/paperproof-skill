#!/usr/bin/env node

import { fail, parseArgs, pickDefined, printJson } from './lib/cli.mjs';

async function loadSdk() {
  try {
    return await import('@paperproof/sdk-ts');
  } catch (error) {
    throw new Error(`Cannot load @paperproof/sdk-ts. Install with: npm install @paperproof/sdk-ts@0.2.6 @mysten/sui. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const args = parseArgs();
  const { createPaperProofSDK, MAINNET_DEPLOYMENT } = await loadSdk();
  const sdk = createPaperProofSDK({
    network: 'mainnet',
    transport: 'jsonrpc',
    queryTransport: args.queryTransport === 'graphql' ? 'graphql' : 'fallback',
    ...(typeof args.rpc === 'string' ? { rpcUrl: args.rpc } : {}),
    ...(typeof args.graphql === 'string' ? { graphQLEndpoint: args.graphql } : {}),
  });
  const module = typeof args.module === 'string' ? args.module : undefined;
  const event = typeof args.event === 'string' ? args.event : undefined;
  const moveEventType = typeof args.moveEventType === 'string'
    ? args.moveEventType
    : module && event
      ? `${MAINNET_DEPLOYMENT.packages.publishing}::${module}::${event}`
      : undefined;
  const page = await sdk.query.queryTrustedEvents(pickDefined({
    moveEventType,
    sender: typeof args.sender === 'string' ? args.sender : undefined,
    limit: args.limit ? Number(args.limit) : 20,
    descendingOrder: args.ascending ? false : true,
    trust: args.trust === 'raw' || args.trust === 'verified' ? args.trust : 'canonical',
    includeRejected: Boolean(args.includeRejected),
  }));
  printJson({ ok: true, network: sdk.network, provider: page.provider, moveEventType, page });
}

main().catch(fail);

