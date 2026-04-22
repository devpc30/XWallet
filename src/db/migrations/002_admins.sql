-- ═══════════════════════════════════════════════════════════════════════
-- Migration 002: Admin accounts, sessions, and audit log
-- ═══════════════════════════════════════════════════════════════════════

-- اکانت‌های ادمین
CREATE TABLE admins (
    id                    BIGSERIAL     PRIMARY KEY,
    username              VARCHAR(50)   NOT NULL UNIQUE,
    password_hash         VARCHAR(255)  NOT NULL,              -- bcrypt
    role                  VARCHAR(20)   NOT NULL DEFAULT 'admin'
                          CHECK (role IN ('super_admin', 'admin')),
    must_change_password  BOOLEAN       NOT NULL DEFAULT false,
    is_active             BOOLEAN       NOT NULL DEFAULT true,

    -- Brute-force protection
    failed_login_count    INTEGER       NOT NULL DEFAULT 0,
    locked_until          TIMESTAMPTZ,

    last_login_at         TIMESTAMPTZ,
    last_login_ip         INET,
    password_changed_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admins_username_active ON admins(username) WHERE is_active = true;


-- سشن‌های فعال (برای revocation — logout، change password، admin deactivation)
CREATE TABLE admin_sessions (
    id           BIGSERIAL    PRIMARY KEY,
    admin_id     BIGINT       NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    jti          UUID         NOT NULL UNIQUE,    -- JWT ID برای revocation
    ip_address   INET,
    user_agent   TEXT,
    expires_at   TIMESTAMPTZ  NOT NULL,
    revoked      BOOLEAN      NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_jti_active ON admin_sessions(jti) WHERE revoked = false;
CREATE INDEX idx_sessions_admin_active
    ON admin_sessions(admin_id, expires_at)
    WHERE revoked = false;


-- Audit log برای همه اکشن‌های ادمین (login، reveal، change، ...)
CREATE TABLE admin_audit_log (
    id           BIGSERIAL    PRIMARY KEY,
    admin_id     BIGINT       REFERENCES admins(id) ON DELETE SET NULL,
    username     VARCHAR(50),                -- حتی اگه admin حذف شد، username می‌مونه
    action       VARCHAR(50)  NOT NULL,      -- login / logout / reveal_mnemonic / password_change / create_wallet
    target_type  VARCHAR(50),                -- wallet / admin / job
    target_id    BIGINT,
    success      BOOLEAN      NOT NULL,
    details      JSONB,                      -- reason, metadata, ...
    ip_address   INET,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_admin_time ON admin_audit_log(admin_id, created_at DESC);
CREATE INDEX idx_audit_action_time ON admin_audit_log(action, created_at DESC);
CREATE INDEX idx_audit_failed_by_ip ON admin_audit_log(ip_address, created_at DESC)
    WHERE success = false;


-- trigger که تو schema اصلی تعریف شده
CREATE TRIGGER set_admins_updated_at
    BEFORE UPDATE ON admins
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
