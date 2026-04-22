-- ═══════════════════════════════════════════════════════════════════════
-- Wallet Service Database Schema (PostgreSQL 14+)
--
-- معماری: Pattern B — per-user mnemonic، per-deposit index
-- Encryption: AES-256-GCM با master key از env
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- برای gen_random_uuid اگه لازم شد

-- ─── جدول اصلی wallet‌ها (یکی per user) ───
CREATE TABLE wallets (
    id                   BIGSERIAL PRIMARY KEY,
    user_id              BIGINT        NOT NULL UNIQUE,   -- external user reference
    word_count           SMALLINT      NOT NULL CHECK (word_count IN (12, 24)),

    -- AES-256-GCM encrypted mnemonic
    mnemonic_ciphertext  BYTEA         NOT NULL,
    mnemonic_nonce       BYTEA         NOT NULL,          -- 12 بایت IV
    mnemonic_tag         BYTEA         NOT NULL,          -- 16 بایت GCM auth tag
    encryption_version   SMALLINT      NOT NULL DEFAULT 1, -- برای key rotation در آینده

    -- Counter برای derivation index بعدی هر chain
    next_index_btc       INTEGER       NOT NULL DEFAULT 0,
    next_index_eth       INTEGER       NOT NULL DEFAULT 0,
    next_index_tron      INTEGER       NOT NULL DEFAULT 0,

    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallets_user_id ON wallets(user_id);


-- ─── آدرس‌های derive شده (n تا per wallet per chain) ───
CREATE TABLE addresses (
    id                BIGSERIAL     PRIMARY KEY,
    wallet_id         BIGINT        NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    chain             VARCHAR(10)   NOT NULL CHECK (chain IN ('BTC', 'ETH', 'TRON')),
    derivation_index  INTEGER       NOT NULL,
    derivation_path   VARCHAR(50)   NOT NULL,   -- e.g. m/84'/0'/0'/0/5
    address           VARCHAR(100)  NOT NULL,

    -- موجودی‌ها (به کوچک‌ترین واحد: sats / wei / sun ذخیره می‌شن برای دقت)
    native_balance    NUMERIC(40, 0) NOT NULL DEFAULT 0,  -- sats/wei/sun
    usdt_balance      NUMERIC(40, 0) NOT NULL DEFAULT 0,  -- USDT smallest (6 decimals) — فقط ETH و TRON

    -- Priority system برای balance checker
    -- 0 = inactive (هرگز dep نداشته یا >30 روز no activity) → هفته‌ای یه بار
    -- 1 = normal → ساعتی یا روزی
    -- 2 = active (اخیراً تراکنش داشته) → هر چند دقیقه
    priority          SMALLINT      NOT NULL DEFAULT 1,
    last_checked_at   TIMESTAMPTZ,
    last_balance_change_at TIMESTAMPTZ,
    tx_count          INTEGER       NOT NULL DEFAULT 0,

    status            VARCHAR(20)   NOT NULL DEFAULT 'active',
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    UNIQUE(chain, address),
    UNIQUE(wallet_id, chain, derivation_index)
);

-- برای balance checker که آدرس‌های priority بالا و قدیمی‌ترین check رو می‌گیره
CREATE INDEX idx_addresses_check_scheduling
    ON addresses(priority DESC, last_checked_at NULLS FIRST)
    WHERE status = 'active';

CREATE INDEX idx_addresses_wallet_chain ON addresses(wallet_id, chain);
CREATE INDEX idx_addresses_by_chain ON addresses(chain, status);


-- ─── audit log برای دسترسی به mnemonic ───
CREATE TABLE mnemonic_access_log (
    id           BIGSERIAL    PRIMARY KEY,
    wallet_id    BIGINT       NOT NULL REFERENCES wallets(id),
    admin_id     BIGINT,                               -- کی درخواست کرد
    accessed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    success      BOOLEAN      NOT NULL,                -- رمز درست بود یا نه
    ip_address   INET,
    user_agent   TEXT
);

CREATE INDEX idx_access_log_wallet ON mnemonic_access_log(wallet_id, accessed_at DESC);
CREATE INDEX idx_access_log_failed
    ON mnemonic_access_log(admin_id, accessed_at DESC)
    WHERE success = false;


-- ─── جدول برای batch job tracking (اختیاری ولی مفید) ───
CREATE TABLE generation_jobs (
    id             BIGSERIAL    PRIMARY KEY,
    requested_by   BIGINT,
    word_count     SMALLINT     NOT NULL,
    total_count    INTEGER      NOT NULL,
    completed      INTEGER      NOT NULL DEFAULT 0,
    status         VARCHAR(20)  NOT NULL DEFAULT 'pending',
    error          TEXT,
    started_at     TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);


-- ─── Auto-update updated_at ───
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_wallets_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
