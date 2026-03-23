import mysql from 'mysql2/promise';

let pool;
let inited = false;

function normalizeSql(sql) {
  return String(sql || '')
    .replace(/CURRENT_TIMESTAMP\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i, 'INSERT IGNORE INTO ')
    .replace(/datetime\(\s*([a-zA-Z0-9_.`]+)\s*\)/gi, '$1');
}

function mapRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

function mapPragmaTableInfoSql(sql) {
  const m = String(sql || '').match(/^\s*PRAGMA\s+table_info\(([^)]+)\)\s*$/i);
  if (!m) return null;
  const rawTable = String(m[1] || '').trim().replace(/^['"`]|['"`]$/g, '');
  if (!rawTable) return null;
  return {
    sql: `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    params: [rawTable]
  };
}

class Statement {
  constructor(pool, sql) {
    this.pool = pool;
    this.sql = normalizeSql(sql);
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async all() {
    const pragmaInfo = mapPragmaTableInfoSql(this.sql);
    if (pragmaInfo) {
      const [rows] = await this.pool.query(pragmaInfo.sql, pragmaInfo.params);
      return { results: mapRows(rows) };
    }
    const [rows] = await this.pool.query(this.sql, this.params);
    return { results: mapRows(rows) };
  }

  async first() {
    const pragmaInfo = mapPragmaTableInfoSql(this.sql);
    if (pragmaInfo) {
      const [rows] = await this.pool.query(pragmaInfo.sql, pragmaInfo.params);
      return mapRows(rows)[0] || null;
    }
    const [rows] = await this.pool.query(this.sql, this.params);
    return mapRows(rows)[0] || null;
  }

  async run() {
    const [result] = await this.pool.execute(this.sql, this.params);
    return {
      success: true,
      meta: {
        changes: result?.affectedRows || 0,
        last_row_id: result?.insertId || 0
      }
    };
  }
}

export function createMysqlAdapter(mysqlPool) {
  return {
    prepare(sql) {
      return new Statement(mysqlPool, sql);
    },
    async exec(sql) {
      const text = normalizeSql(sql);
      const conn = await mysqlPool.getConnection();
      try {
        for (const part of text.split(';').map(s => s.trim()).filter(Boolean)) {
          const upper = part.toUpperCase();
          if (upper === 'BEGIN' || upper === 'START TRANSACTION') {
            await conn.beginTransaction();
            continue;
          }
          if (upper === 'COMMIT') {
            await conn.commit();
            continue;
          }
          if (upper === 'ROLLBACK') {
            await conn.rollback();
            continue;
          }
          if (/^PRAGMA\s+/i.test(part)) {
            continue;
          }
          await conn.query(part);
        }
      } finally {
        conn.release();
      }
      return { success: true };
    },
    async batch(statements) {
      const conn = await mysqlPool.getConnection();
      try {
        await conn.beginTransaction();
        const results = [];
        for (const stmt of statements || []) {
          if (!stmt || typeof stmt.sql !== 'string') {
            results.push({ success: false, error: 'Invalid statement' });
            continue;
          }
          const [result] = await conn.execute(stmt.sql, stmt.params || []);
          results.push({
            success: true,
            meta: {
              changes: result?.affectedRows || 0,
              last_row_id: result?.insertId || 0
            }
          });
        }
        await conn.commit();
        return results;
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }
    }
  };
}

export async function initMysqlPoolFromEnv(env = process.env) {
  if (pool) return pool;
  pool = mysql.createPool({
    host: env.MYSQL_HOST || '127.0.0.1',
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: Number(env.MYSQL_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    charset: 'utf8mb4'
  });
  const conn = await pool.getConnection();
  conn.release();
  return pool;
}

export async function initializeMySqlSchema(mysqlPool) {
  if (inited) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS mailboxes (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      address VARCHAR(255) NOT NULL UNIQUE,
      local_part VARCHAR(128) NOT NULL,
      domain VARCHAR(128) NOT NULL,
      password_hash VARCHAR(255) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_accessed_at DATETIME NULL,
      expires_at DATETIME NULL,
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      can_login TINYINT(1) NOT NULL DEFAULT 0,
      forward_to VARCHAR(255) NULL,
      is_favorite TINYINT(1) NOT NULL DEFAULT 0,
      INDEX idx_mailboxes_address (address),
      INDEX idx_mailboxes_is_favorite (is_favorite),
      INDEX idx_mailboxes_domain (domain)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
    `CREATE TABLE IF NOT EXISTS messages (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      mailbox_id BIGINT NOT NULL,
      sender VARCHAR(255) NOT NULL,
      to_addrs TEXT NOT NULL,
      subject VARCHAR(500) NOT NULL,
      verification_code VARCHAR(64) NULL,
      preview TEXT NULL,
      r2_bucket VARCHAR(255) NOT NULL DEFAULT 'local-disk',
      r2_object_key VARCHAR(500) NOT NULL DEFAULT '',
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      content LONGTEXT NULL,
      html_content LONGTEXT NULL,
      INDEX idx_messages_mailbox_received (mailbox_id, received_at DESC),
      INDEX idx_messages_r2_object_key (r2_object_key),
      CONSTRAINT fk_messages_mailbox FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
    `CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(128) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'user',
      can_send TINYINT(1) NOT NULL DEFAULT 0,
      mailbox_limit INT NOT NULL DEFAULT 10,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_users_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
    `CREATE TABLE IF NOT EXISTS user_mailboxes (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT NOT NULL,
      mailbox_id BIGINT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      UNIQUE KEY uniq_user_mailbox (user_id, mailbox_id),
      INDEX idx_user_mailboxes_user (user_id),
      INDEX idx_user_mailboxes_mailbox (mailbox_id),
      CONSTRAINT fk_user_mailboxes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_user_mailboxes_mailbox FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
    `CREATE TABLE IF NOT EXISTS sent_emails (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      resend_id VARCHAR(255) NULL,
      from_name VARCHAR(255) NULL,
      from_addr VARCHAR(255) NOT NULL,
      to_addrs TEXT NOT NULL,
      subject VARCHAR(500) NOT NULL,
      html_content LONGTEXT NULL,
      text_content LONGTEXT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'queued',
      scheduled_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_sent_emails_resend_id (resend_id),
      INDEX idx_sent_emails_status_created (status, created_at),
      INDEX idx_sent_emails_from_addr (from_addr)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
  ];

  const conn = await mysqlPool.getConnection();
  try {
    for (const sql of statements) {
      await conn.query(sql);
    }
  } finally {
    conn.release();
  }
  inited = true;
}
