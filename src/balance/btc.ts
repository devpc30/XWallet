/**
 * BTC balance checker با mempool.space API.
 * چون این API batch رو support نمی‌کنه، با concurrency محدود پیش می‌ریم.
 */

const BTC_API = process.env.BTC_API ?? 'https://mempool.space/api';

export interface BtcBalanceResult {
  address: string;
  sats: bigint;
  txCount: number;
}

export async function getBtcBalance(address: string): Promise<BtcBalanceResult> {
  const res = await fetch(`${BTC_API}/address/${address}`);
  if (!res.ok) throw new Error(`mempool.space ${res.status} for ${address}`);

  const d = (await res.json()) as {
    chain_stats: {
      funded_txo_sum: number;
      spent_txo_sum: number;
      tx_count: number;
    };
    mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  };

  const sats = BigInt(
    d.chain_stats.funded_txo_sum -
      d.chain_stats.spent_txo_sum +
      d.mempool_stats.funded_txo_sum -
      d.mempool_stats.spent_txo_sum
  );

  return {
    address,
    sats,
    txCount: d.chain_stats.tx_count + d.mempool_stats.tx_count,
  };
}

/**
 * موجودی چند آدرس رو با concurrency محدود می‌گیره.
 * default concurrency = 5 (نسبتاً محافظه‌کارانه تا rate limit نخوریم)
 */
export async function batchBtcBalances(
  addresses: string[],
  concurrency = 5
): Promise<BtcBalanceResult[]> {
  const results: BtcBalanceResult[] = [];

  for (let i = 0; i < addresses.length; i += concurrency) {
    const chunk = addresses.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(chunk.map(getBtcBalance));

    for (let j = 0; j < chunkResults.length; j++) {
      const r = chunkResults[j];
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        // در صورت خطا: صفر و ادامه (logged)
        console.error(`[btc] ${chunk[j]}: ${r.reason}`);
        results.push({ address: chunk[j], sats: 0n, txCount: 0 });
      }
    }

    // تأخیر کوچک بین chunk‌ها برای respect به rate limit
    if (i + concurrency < addresses.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}
