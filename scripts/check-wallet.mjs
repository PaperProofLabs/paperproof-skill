#!/usr/bin/env node

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { fail, parseArgs, printJson, requireArg } from './lib/cli.mjs';

const COINS = {
  sui: '0x2::sui::SUI',
  wal: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
  pprf: '0x5d2ec9829a9e116de7c2008281a90b96690beb2252af120ad05a25fe13fae0da::pprf::PPRF',
};

async function main() {
  const args = parseArgs();
  const owner = requireArg(args, 'address');
  const url = typeof args.rpc === 'string' ? args.rpc : 'https://fullnode.mainnet.sui.io:443';
  const client = new SuiJsonRpcClient({ url });
  const balances = {};
  for (const [symbol, coinType] of Object.entries(COINS)) {
    try {
      const balance = await client.getBalance({ owner, coinType });
      balances[symbol] = {
        coinType,
        totalBalance: balance.totalBalance,
        coinObjectCount: balance.coinObjectCount,
      };
    } catch (error) {
      balances[symbol] = { coinType, error: error instanceof Error ? error.message : String(error) };
    }
  }
  printJson({ ok: true, network: 'mainnet', rpcUrl: url, owner, balances });
}

main().catch(fail);
