/**
 * ETH + USDT-ERC20 balance checker با Multicall3.
 *
 * RPC endpoint‌ها از DB خونده می‌شن (با rotation). اگه هیچ کدوم نباشه،
 * fallback به default عمومی (llamarpc). روی هر batch یه RPC انتخاب می‌شه.
 */

import { JsonRpcProvider, Interface, Contract } from 'ethers';
import {
  pickCredential,
  markSuccess,
  markError,
} from '../services/credentials-service.js';

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const USDT_ERC20 = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const FALLBACK_RPC = process.env.ETH_RPC ?? 'https://eth.llamarpc.com';

const multicall3Iface = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])',
  'function getEthBalance(address addr) view returns (uint256)',
]);

const erc20Iface = new Interface([
  'function balanceOf(address) view returns (uint256)',
]);

// Provider cache به ازای هر RPC URL (تا هر بار new نسازیم)
const providerCache = new Map<string, JsonRpcProvider>();

function getProvider(rpcUrl: string): JsonRpcProvider {
  let p = providerCache.get(rpcUrl);
  if (!p) {
    p = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
    providerCache.set(rpcUrl, p);
  }
  return p;
}

export interface EthBalanceResult {
  address: string;
  eth: bigint;
  usdt: bigint;
}

export async function batchEthBalances(
  addresses: string[]
): Promise<EthBalanceResult[]> {
  if (addresses.length === 0) return [];

  const CHUNK = 300;
  const results: EthBalanceResult[] = [];

  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const chunkResults = await batchChunk(chunk);
    results.push(...chunkResults);
  }

  return results;
}

async function batchChunk(addresses: string[]): Promise<EthBalanceResult[]> {
  // یه RPC از DB بگیر، اگه نبود fallback
  const cred = await pickCredential('eth_rpc');
  const rpcUrl = cred ? cred.value : FALLBACK_RPC;

  const provider = getProvider(rpcUrl);
  const multicall = new Contract(MULTICALL3_ADDRESS, multicall3Iface, provider);

  const calls: Array<{ target: string; allowFailure: boolean; callData: string }> = [];
  for (const addr of addresses) {
    calls.push({
      target: MULTICALL3_ADDRESS,
      allowFailure: false,
      callData: multicall3Iface.encodeFunctionData('getEthBalance', [addr]),
    });
    calls.push({
      target: USDT_ERC20,
      allowFailure: true,
      callData: erc20Iface.encodeFunctionData('balanceOf', [addr]),
    });
  }

  try {
    const aggregated = (await multicall.aggregate3(calls)) as Array<{
      success: boolean;
      returnData: string;
    }>;

    if (cred) await markSuccess(cred.id);

    return addresses.map((addr, i) => {
      const ethResult = aggregated[i * 2];
      const usdtResult = aggregated[i * 2 + 1];

      const eth = ethResult.success
        ? (multicall3Iface.decodeFunctionResult('getEthBalance', ethResult.returnData)[0] as bigint)
        : 0n;

      const usdt = usdtResult.success && usdtResult.returnData !== '0x'
        ? (erc20Iface.decodeFunctionResult('balanceOf', usdtResult.returnData)[0] as bigint)
        : 0n;

      return { address: addr, eth, usdt };
    });
  } catch (e) {
    if (cred) await markError(cred.id, (e as Error).message);
    throw e;
  }
}
