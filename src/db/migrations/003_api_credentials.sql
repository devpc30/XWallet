-- ═══════════════════════════════════════════════════════════════════════
-- API Keys / RPC Endpoints management
--
-- توکن‌ها با AES-256-GCM (همون WALLET_MASTER_KEY) encrypt می‌شن.
-- در memory cache می‌شن و هر ۶۰ ثانیه refresh می‌شن تا تغییرات پنل
-- بدون restart worker اعمال بشن.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE api_credentials (
    id              BIGSERIAL    PRIMARY KEY,
    provider        VARCHAR(30)  NOT NULL,    -- 'trongrid' | 'eth_rpc' | 'btc_api'
    label           VARCHAR(100),              -- توضیح اختیاری (مثلاً "Alchemy main")

    -- مقدار encrypted (آدرس endpoint یا API key)
    value_ciphertext  BYTEA      NOT NULL,
    value_nonce       BYTEA      NOT NULL,
    value_tag         BYTEA      NOT NULL,

    -- آمار کاربرد
    last_used_at       TIMESTAMPTZ,
    last_error_at      TIMESTAMPTZ,
    last_error_message TEXT,
    rate_limited_until TIMESTAMPTZ,            -- موقت block (مثلاً 429)

    success_count   BIGINT       NOT NULL DEFAULT 0,
    failure_count   BIGINT       NOT NULL DEFAULT 0,

    is_active       BOOLEAN      NOT NULL DEFAULT true,
    created_by      BIGINT       REFERENCES admins(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_credentials_provider
    ON api_credentials(provider, is_active)
    WHERE is_active = true;

CREATE TRIGGER set_api_credentials_updated_at
    BEFORE UPDATE ON api_credentials
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
