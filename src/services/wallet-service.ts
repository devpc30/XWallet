/**
 * Wallet Service — orchestrator
 */

import { pool } from '../db/pool.js';
import {
  generateMnemonic,
  deriveMany,
  type Chain,
  type DerivedAddress,
} from '../wallet/derivation.js';
import { encryptMnemonic, decryptMnemonic } from '../crypto/aes.js';

const ALL_CHAINS: Chain[] = ['BTC', 'ETH', 'TRON'];

export interface CreateWalletOptions {
  userId: number;
  wordCount?: 12 | 24;
  initialAddressCount?: number;
}

export interface CreateWalletResult {
  walletId: number;
  addresses: DerivedAddress[];
}

export async function createWallet(
  opts: CreateWalletOptions
): Promise<CreateWalletResult> {
  const { userId, wordCount = 12, initialAddressCount = 1 } = opts;

  if (initialAddressCount < 1 || initialAddressCount > 100) {
    throw new Error('initialAddressCount باید بین 1 و 100 باشه');
  }

  const mnemonic = generateMnemonic(wordCount);
  const requests = ALL_CHAINS.map((c) => ({
    chain: c,
    fromIndex: 0,
    count: initialAddressCount,
  }));
  const addresses = await deriveMany(mnemonic, requests);
  const enc = encryptMnemonic(mnemonic);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletRes = await client.query<{ id: string }>(
      `INSERT INTO wallets
        (user_id, word_count, mnemonic_ciphertext, mnemonic_nonce, mnemonic_tag,
         encryption_version, next_index_btc, next_index_eth, next_index_tron)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
       RETURNING id`,
      [userId, wordCount, enc.ciphertext, enc.nonce, enc.tag, enc.version, initialAddressCount]
    );
    const walletId = Number(walletRes.rows[0].id);

    const values: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (const a of addresses) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(walletId, a.chain, a.index, a.path, a.address);
    }
    await client.query(
      `INSERT INTO addresses (wallet_id, chain, derivation_index, derivation_path, address)
       VALUES ${values.join(', ')}`,
      params
    );

    await client.query('COMMIT');
    return { walletId, addresses };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getNewDepositAddress(
  walletId: number,
  chain: Chain
): Promise<DerivedAddress> {
  const indexCol = `next_index_${chain.toLowerCase()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `UPDATE wallets SET ${indexCol} = ${indexCol} + 1
       WHERE id = $1
       RETURNING ${indexCol} - 1 AS new_index,
                 mnemonic_ciphertext, mnemonic_nonce, mnemonic_tag, encryption_version`,
      [walletId]
    );

    if (res.rows.length === 0) throw new Error(`wallet ${walletId} not found`);

    const row = res.rows[0];
    const mnemonic = decryptMnemonic({
      ciphertext: row.mnemonic_ciphertext,
      nonce: row.mnemonic_nonce,
      tag: row.mnemonic_tag,
      version: row.encryption_version,
    });

    const [derived] = await deriveMany(mnemonic, [
      { chain, fromIndex: Number(row.new_index), count: 1 },
    ]);

    await client.query(
      `INSERT INTO addresses (wallet_id, chain, derivation_index, derivation_path, address)
       VALUES ($1, $2, $3, $4, $5)`,
      [walletId, derived.chain, derived.index, derived.path, derived.address]
    );

    await client.query('COMMIT');
    return derived;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function revealMnemonic(walletId: number): Promise<string> {
  const res = await pool.query(
    `SELECT mnemonic_ciphertext, mnemonic_nonce, mnemonic_tag, encryption_version
     FROM wallets WHERE id = $1`,
    [walletId]
  );

  if (res.rows.length === 0) throw new Error('wallet not found');

  const row = res.rows[0];
  return decryptMnemonic({
    ciphertext: row.mnemonic_ciphertext,
    nonce: row.mnemonic_nonce,
    tag: row.mnemonic_tag,
    version: row.encryption_version,
  });
}
