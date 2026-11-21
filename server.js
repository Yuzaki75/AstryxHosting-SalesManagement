require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const discordBot = require('./discord-bot');

const app = express();
const PORT = Number(process.env.PORT || 3020);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be a valid TCP port between 1 and 65535.');
}

// Trust the first proxy hop (nginx/Caddy/Cloudflare/etc) so req.secure and
// req.protocol reflect the real client connection when running behind TLS
// termination, instead of always reporting "http".
app.set('trust proxy', 1);

// Middleware
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Use a random development secret, but require an explicit secret in production.
const SESSION_SECRET = process.env.SESSION_SECRET || (
  process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('hex')
);
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('Set SESSION_SECRET to a random value with at least 32 characters.');
}

app.use(cookieParser(SESSION_SECRET));

// Store the lightweight session in a signed, HTTP-only cookie.
app.use((req, res, next) => {
  try {
    // Parse session from signed cookie
    if (req.signedCookies && req.signedCookies.sessionData) {
      try {
        req.session = JSON.parse(req.signedCookies.sessionData);
      } catch (parseError) {
        console.error('Error parsing session cookie:', parseError);
        req.session = {};
      }
    } else {
      req.session = {};
    }
  } catch (error) {
    console.error('Error reading session:', error);
    req.session = {};
  }
  
  // Helper to save session
  req.saveSession = (data) => {
    try {
      // A cookie marked Secure is silently dropped by the browser on any
      // non-HTTPS connection. NODE_ENV=production doesn't tell us whether
      // the actual request arrived over HTTPS (directly, or via a trusted
      // reverse proxy setting X-Forwarded-Proto), so use req.secure — which
      // Express computes correctly now that 'trust proxy' is set above.
      // COOKIE_SECURE can force the value explicitly if ever needed.
      const secureCookie = process.env.COOKIE_SECURE !== undefined
        ? process.env.COOKIE_SECURE === 'true'
        : req.secure;

      const cookieOptions = {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        signed: true
      };
      res.cookie('sessionData', JSON.stringify(data), cookieOptions);
      req.session = data;
    } catch (error) {
      console.error('Error saving session:', error);
    }
  };
  
  // Helper to destroy session
  req.destroySession = () => {
    try {
      const secureCookie = process.env.COOKIE_SECURE !== undefined
        ? process.env.COOKIE_SECURE === 'true'
        : req.secure;
      res.clearCookie('sessionData', {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'lax'
      });
      req.session = {};
    } catch (error) {
      console.error('Error destroying session:', error);
    }
  };
  
  next();
});

// Database and backup files share a directory. Mount it as persistent storage.
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'sales.db'));
const backupsDir = path.join(path.dirname(dbPath), 'backups');

try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
} catch (error) {
  throw new Error(`Cannot create database directory ${path.dirname(dbPath)}: ${error.message}`);
}

let db = null;

function isCorruptError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = err.code || '';
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || msg.includes('malformed') || msg.includes('corrupt');
}

function archiveCorruptDb() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = `${dbPath}.corrupt-${stamp}`;
  try {
    if (!fs.existsSync(dbPath)) return true;
    fs.renameSync(dbPath, archivePath);
    console.error('Corrupt database preserved for recovery:', archivePath);
    for (const suffix of ['-wal', '-shm']) {
      const sidecarPath = dbPath + suffix;
      if (fs.existsSync(sidecarPath)) fs.renameSync(sidecarPath, `${archivePath}${suffix}`);
    }
    return true;
  } catch (error) {
    console.error('Could not preserve the corrupt database. Refusing to replace it:', error.message);
    return false;
  }
}

function openDatabase(retried) {
  const conn = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
      if (isCorruptError(err) && !retried) {
        console.warn('Database corrupt on open:', err.message);
        conn.close(() => {
          if (archiveCorruptDb()) openDatabase(true);
        });
        return;
      }
      console.error('Error opening database:', err.message);
      console.error('Database path:', dbPath);
      if (err.code === 'SQLITE_CANTOPEN') {
        console.error('Hint: the directory may not exist or DATABASE_PATH may be invalid for this OS (e.g. a Linux path like /app/data on Windows).');
      }
      return;
    }
    // Reduce risk of corruption: full sync, busy timeout
    conn.run('PRAGMA foreign_keys = ON;', () => {});
    conn.run('PRAGMA synchronous = FULL;', () => {});
    conn.run('PRAGMA busy_timeout = 5000;', () => {});
    conn.run('PRAGMA journal_mode = WAL;', (walErr) => {
      if (walErr) console.log('Note: WAL mode not available (this is OK)');
    });
    // Check integrity; archive a damaged file before creating a replacement
    conn.get('PRAGMA integrity_check;', (intErr, row) => {
      if (intErr || (row && row.integrity_check !== 'ok')) {
        const reason = intErr ? intErr.message : (row ? row.integrity_check : 'unknown');
        if (!retried) {
          console.warn('Database integrity check failed:', reason);
          conn.close(() => {
            if (archiveCorruptDb()) openDatabase(true);
          });
          return;
        }
      }
      db = conn;
      console.log('Connected to SQLite database:', dbPath);
      setImmediate(() => initializeDatabase());
    });
  });
}

openDatabase(false);

// Track initialization state
let dbInitialized = false;
let dbInitializing = false;
let firstRegistrationInProgress = false;

// Container orchestrators and reverse proxies use this lightweight endpoint to
// distinguish a healthy app from one that is still opening its SQLite database.
app.get('/api/health', (req, res) => {
  if (!db || !dbInitialized) {
    return res.status(503).json({ status: 'starting' });
  }

  db.get('SELECT 1 AS ok', [], (error, row) => {
    if (error || !row || row.ok !== 1) {
      return res.status(503).json({ status: 'unhealthy' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ status: 'ok' });
  });
});

function initializeDatabase() {
  if (dbInitialized || dbInitializing) {
    return;
  }
  
  if (!db) {
    console.error('Cannot initialize database: db connection is null');
    dbInitializing = false;
    return;
  }
  
  dbInitializing = true;
  
  console.log('Initializing database...');
  
  // Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) {
      console.error('Error creating users table:', err);
      dbInitializing = false;
      return;
    }
    
    // Sales table
    db.run(`CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_bought TEXT NOT NULL,
      date_expiry TEXT,
      duration TEXT,
      customer_name TEXT NOT NULL,
      plan TEXT NOT NULL,
      cpu TEXT NOT NULL,
      ram TEXT NOT NULL,
      disk TEXT NOT NULL,
      amount REAL NOT NULL,
      promo TEXT,
      payment_method TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('Paid', 'Pending')),
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`, (err) => {
      if (err) {
        console.error('Error creating sales table:', err);
        dbInitializing = false;
        return;
      }
      
      // Add promo column if it doesn't exist (for existing databases)
      db.run(`ALTER TABLE sales ADD COLUMN promo TEXT`, (alterErr) => {
        // Ignore error if column already exists
        if (alterErr && !alterErr.message.includes('duplicate column name')) {
          console.log('Note: promo column may already exist or could not be added:', alterErr.message);
        }
      });
      
      // Try to add columns (ignore if they exist)
      db.run(`ALTER TABLE sales ADD COLUMN date_expiry TEXT`, () => {});
      db.run(`ALTER TABLE sales ADD COLUMN duration TEXT`, () => {});
      db.run(`ALTER TABLE sales ADD COLUMN no_renew INTEGER DEFAULT 0`, () => {});
      
      // Plans table - these templates power the plan selector in the sales form.
      // Sales keep their copied plan details, so editing or deleting a template does
      // not change historical sales records.
      db.run(`CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        category TEXT NOT NULL DEFAULT 'General',
        cpu TEXT NOT NULL,
        ram TEXT NOT NULL,
        disk TEXT NOT NULL,
        amount REAL NOT NULL CHECK(amount >= 0),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (plansErr) => {
        if (plansErr) {
          console.error('Error creating plans table:', plansErr);
          dbInitializing = false;
          return;
        }

        const defaultPlans = [
          ['Pig Plan', 'Budget Dedicated', '2 vCores', '4GB', '10GB', 249],
          ['Wolf Plan', 'Budget Dedicated', '2.5 vCores', '6GB', '20GB', 349],
          ['Zombie Plan', 'Enterprise Dedicated', '3 vCores', '8GB', '30GB', 549],
          ['Skeleton Plan', 'Enterprise Dedicated', '4 vCores', '12GB', '40GB', 799],
          ['Ender Dragon Plan', 'Enterprise Dedicated', '6 vCores', '16GB', '50GB', 1099]
        ];
        const seedStatement = db.prepare(
          'INSERT OR IGNORE INTO plans (name, category, cpu, ram, disk, amount) VALUES (?, ?, ?, ?, ?, ?)'
        );
        defaultPlans.forEach((plan) => seedStatement.run(plan));
        seedStatement.finalize((seedErr) => {
          if (seedErr) {
            console.error('Error seeding default plans:', seedErr);
            dbInitializing = false;
            return;
          }

          // Correct legacy defaults only when their original seeded values are untouched.
          const legacyPlanUpdates = [
            ['10GB', 'Pig Plan', '2 vCores', '4GB', '15GB', 249],
            ['2.5 vCores', 'Wolf Plan', '3 vCores', '6GB', '20GB', 349],
            ['3 vCores', 'Zombie Plan', '4 vCores', '8GB', '30GB', 549],
            ['4 vCores', 'Skeleton Plan', '5 vCores', '12GB', '40GB', 799],
            ['50GB', 'Ender Dragon Plan', '6 vCores', '16GB', '60GB', 1099]
          ];
          const updateLegacyPlan = db.prepare(
            'UPDATE plans SET cpu = ?, disk = ? WHERE name = ? COLLATE NOCASE AND cpu = ? AND ram = ? AND disk = ? AND amount = ?'
          );
          legacyPlanUpdates.forEach(([newValue, name, oldCpu, ram, oldDisk, amount]) => {
            const newCpu = name === 'Wolf Plan' || name === 'Zombie Plan' || name === 'Skeleton Plan'
              ? newValue
              : oldCpu;
            const newDisk = name === 'Pig Plan' || name === 'Ender Dragon Plan'
              ? newValue
              : oldDisk;
            updateLegacyPlan.run(newCpu, newDisk, name, oldCpu, ram, oldDisk, amount);
          });
          updateLegacyPlan.finalize(() => {
            // Remove the retired plan from the active catalogue. Historical sales
            // retain their own copied plan details and are not affected.
            db.run("DELETE FROM plans WHERE name = 'Chicken Plan' COLLATE NOCASE", (cleanupErr) => {
              if (cleanupErr) {
                console.error('Could not remove retired Chicken Plan template:', cleanupErr.message);
              }

              db.run(`CREATE TABLE IF NOT EXISTS customers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL COLLATE NOCASE UNIQUE,
              discord_id TEXT DEFAULT '',
              contact TEXT DEFAULT '',
              notes TEXT DEFAULT '',
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, (customerErr) => {
                if (customerErr) {
                  console.error('Error creating customers table:', customerErr);
                  dbInitializing = false;
                  return;
                }

                db.run('CREATE INDEX IF NOT EXISTS idx_sales_date_bought ON sales(date_bought)');
                db.run('CREATE INDEX IF NOT EXISTS idx_sales_date_expiry ON sales(date_expiry)');
                db.run('CREATE INDEX IF NOT EXISTS idx_sales_customer_name ON sales(customer_name)');
                db.run('CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name)');

                dbInitialized = true;
                dbInitializing = false;
                console.log('Database initialization complete');

              // Create Discord settings and start the optional integration.
              setImmediate(() => {
                discordBot.ensureSettingsTable(db, (discErr) => {
                  if (discErr) {
                    console.error('Error creating discord_settings table:', discErr);
                  } else {
                    discordBot.startDiscordBot(db).catch((botErr) => {
                      console.error('Discord bot startup failed:', botErr.message);
                    });
                  }
                  startExpiryAlertTimer();
                });
              });

              // Start the daily backup scheduler after the schema is ready.
              setImmediate(() => {
                runDailyBackup();
                setInterval(runDailyBackup, 6 * 60 * 60 * 1000);
              });

              // Create a non-login system user for automated orders.
              setImmediate(() => {
                db.get('SELECT id FROM users WHERE username = ?', ['system'], (userErr, user) => {
                  if (userErr) {
                    console.error('Error checking for system user:', userErr);
                  } else if (!user) {
                    bcrypt.hash('system-user-' + Date.now(), 10, (hashErr, hash) => {
                      if (hashErr) {
                        console.error('Error hashing system user password:', hashErr);
                      } else {
                        db.run('INSERT INTO users (username, password) VALUES (?, ?)', ['system', hash], (insertErr) => {
                          if (insertErr) {
                            console.error('Error creating system user:', insertErr);
                          } else {
                            console.log('System user created for automated orders');
                          }
                        });
                      }
                    });
                  }
                });
              });
            });
          });
          });
        });
      });
    });
  });
}

// Ensure database is initialized before handling requests
function ensureDbInitialized(req, res, next) {
  if (dbInitialized) {
    return next();
  }
  
  if (!dbInitializing) {
    // Start initialization if not already started
    initializeDatabase();
  }
  
  // Wait for initialization with shorter timeout
  let attempts = 0;
  const maxAttempts = 300; // Wait up to 30 seconds for schema setup.
  
  const checkInitialized = () => {
    attempts++;
    if (dbInitialized) {
      return next();
    }
    if (attempts >= maxAttempts) {
      console.error('Database initialization timeout after', attempts * 100, 'ms');
      return res.status(503).json({ error: 'Database is still initializing. Please retry shortly.' });
    }
    setTimeout(checkInitialized, 100);
  };
  
  checkInitialized();
}

// Ensure db connection exists before handling a request
function requireDb(req, res, next) {
  if (!db) {
    return res.status(503).json({ error: 'Database not ready' });
  }
  next();
}

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Compare secrets without leaking their length/prefix through timing.
function safeCompare(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// API Key authentication middleware for automated order creation
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.body?.apiKey;
  const expectedApiKey = process.env.SALES_API_KEY;
  
  if (!expectedApiKey) {
    console.error('SALES_API_KEY not configured in environment variables');
    return res.status(500).json({ error: 'API key authentication not configured' });
  }
  
  if (!apiKey || !safeCompare(apiKey, expectedApiKey)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  next();
}

// A sale amount must be a finite, non-negative number. Returns null when invalid.
function parseAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

// Normalise Excel dates (Date objects, serial numbers) and text dates to YYYY-MM-DD.
function normalizeDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date && !isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial date: days since 1899-12-30 (accounting for the 1900 leap bug).
    // Only accept plausible serials so stray numbers aren't turned into 1800s dates.
    if (value >= 1 && value <= 2958465) {
      const ms = Math.round((value - 25569) * 86400 * 1000);
      const serialDate = new Date(ms);
      if (!isNaN(serialDate.getTime())) {
        return serialDate.toISOString().slice(0, 10);
      }
    }
  }
  const text = String(value).trim();
  if (!text) return '';
  // Keep date-only strings exactly as written to avoid timezone shifts.
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return text;
}

// API Routes

// Registration is only open for the first account unless explicitly enabled by an operator.
app.get('/api/registration-status', ensureDbInitialized, requireDb, (req, res) => {
  db.get("SELECT COUNT(*) AS count FROM users WHERE username <> 'system'", [], (err, row) => {
    if (err) {
      console.error('Could not check registration status:', err.message);
      return res.status(500).json({ error: 'Could not check registration status' });
    }
    const registrationOpen = process.env.ALLOW_REGISTRATION === 'true' || Number(row?.count || 0) === 0;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ registrationOpen });
  });
});

// Register
app.post('/api/register', ensureDbInitialized, requireDb, async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const { password, repeatPassword } = req.body;

  if (!username || !password || !repeatPassword) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || username.toLowerCase() === 'system') {
    return res.status(400).json({ error: 'Username must be 3–32 characters and use only letters, numbers, dots, underscores, or hyphens.' });
  }

  if (typeof password !== 'string' || password !== repeatPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  db.get("SELECT COUNT(*) AS count FROM users WHERE username <> 'system'", [], async (countErr, row) => {
    if (countErr) {
      console.error('Could not verify registration access:', countErr.message);
      return res.status(500).json({ error: 'Could not verify registration access' });
    }

    const hasExistingAccount = Number(row?.count || 0) > 0;
    const registrationEnabled = process.env.ALLOW_REGISTRATION === 'true';
    if (hasExistingAccount && !registrationEnabled) {
      return res.status(403).json({ error: 'Public registration is closed. Ask the application owner to create or enable an account.' });
    }
    if (!registrationEnabled && firstRegistrationInProgress) {
      return res.status(409).json({ error: 'The first account is currently being created. Please try again shortly.' });
    }
    if (!registrationEnabled) firstRegistrationInProgress = true;

    try {
      const hashedPassword = await bcrypt.hash(password, 12);
      db.run(
        'INSERT INTO users (username, password) VALUES (?, ?)',
        [username, hashedPassword],
        function onRegister(insertErr) {
          if (!registrationEnabled) firstRegistrationInProgress = false;
          if (insertErr) {
            if (insertErr.message.includes('UNIQUE constraint')) {
              return res.status(409).json({ error: 'Username already exists' });
            }
            console.error('Error creating user:', insertErr.message);
            return res.status(500).json({ error: 'Error creating user' });
          }
          res.status(201).json({ success: true, message: 'User created successfully' });
        }
      );
    } catch (error) {
      if (!registrationEnabled) firstRegistrationInProgress = false;
      console.error('Error hashing registration password:', error.message);
      res.status(500).json({ error: 'Error creating account' });
    }
  });
});

// Simple in-memory login throttle: at most 10 failed attempts per IP per 15 minutes.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function getLoginRecord(req) {
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record || now - record.firstAttempt > LOGIN_WINDOW_MS) {
    const fresh = { count: 0, firstAttempt: now };
    loginAttempts.set(key, fresh);
    return { key, record: fresh };
  }
  return { key, record };
}

// Login
app.post('/api/login', ensureDbInitialized, requireDb, (req, res) => {
  const { username, password } = req.body;
  const { key: loginKey, record: attemptRecord } = getLoginRecord(req);

  if (attemptRecord.count >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many login attempts. Please try again in a few minutes.' });
  }

  const failLogin = () => {
    attemptRecord.count++;
    return res.status(401).json({ error: 'Invalid username or password' });
  };

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      return failLogin();
    }

    try {
      const match = await bcrypt.compare(password, user.password);
      if (match) {
        // Successful login clears the failure counter for this IP.
        loginAttempts.delete(loginKey);
        // Save session data to signed cookie
        req.saveSession({
          userId: user.id,
          username: user.username
        });
        
        res.json({ success: true, username: user.username });
      } else {
        failLogin();
      }
    } catch (error) {
      console.error('Error in login:', error);
      res.status(500).json({ error: 'Error comparing passwords' });
    }
  });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.destroySession();
  res.json({ success: true });
});

// Exchange rate (USD -> PHP), used to auto-convert the panel's $5.35 cost.
// Cached in memory so we don't hit the external API on every dashboard load.
let exchangeRateCache = { rate: null, fetchedAt: 0 };
const EXCHANGE_RATE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FALLBACK_USD_PHP_RATE = 58.5; // used only if the API is unreachable and we have no cached rate yet

app.get('/api/exchange-rate', async (req, res) => {
  const now = Date.now();

  if (exchangeRateCache.rate && (now - exchangeRateCache.fetchedAt) < EXCHANGE_RATE_TTL_MS) {
    return res.json({ base: 'USD', target: 'PHP', rate: exchangeRateCache.rate, cached: true });
  }

  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!response.ok) {
      throw new Error(`Exchange rate API responded with ${response.status}`);
    }
    const data = await response.json();
    const rate = data && data.rates && data.rates.PHP;
    if (!rate) {
      throw new Error('PHP rate missing from exchange rate API response');
    }
    exchangeRateCache = { rate, fetchedAt: now };
    res.json({ base: 'USD', target: 'PHP', rate, cached: false });
  } catch (error) {
    console.error('Error fetching exchange rate:', error);
    // Serve the last known good rate if we have one, even if stale, rather
    // than breaking the dashboard. Only fall back to the static default if
    // we've never successfully fetched a rate.
    const rate = exchangeRateCache.rate || FALLBACK_USD_PHP_RATE;
    res.json({ base: 'USD', target: 'PHP', rate, cached: true, stale: true });
  }
});

// Check session
app.get('/api/session', (req, res) => {
  const sessionData = req.session || {};
  if (process.env.DEBUG_SESSIONS === 'true') {
    console.log('Session check:', {
      hasSession: !!req.session,
      sessionData: sessionData,
      userId: sessionData.userId,
      username: sessionData.username,
      cookies: req.signedCookies
    });
  }
  
  if (sessionData.userId) {
    res.json({ authenticated: true, username: sessionData.username });
  } else {
    res.json({ authenticated: false });
  }
});

function normalizePlanPayload(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const category = typeof body.category === 'string' && body.category.trim()
    ? body.category.trim()
    : 'General';
  const cpu = typeof body.cpu === 'string' ? body.cpu.trim() : '';
  const ram = typeof body.ram === 'string' ? body.ram.trim() : '';
  const disk = typeof body.disk === 'string' ? body.disk.trim() : '';
  const amount = Number(body.amount);

  if (!name || !cpu || !ram || !disk || !Number.isFinite(amount) || amount < 0) {
    return { error: 'Plan name, CPU, RAM, disk, and a non-negative amount are required' };
  }
  if (name.toLowerCase() === 'custom plan') {
    return { error: '"Custom Plan" is reserved for one-off sales' };
  }

  return { name, category, cpu, ram, disk, amount };
}

// List plan templates
app.get('/api/plans', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  db.all('SELECT * FROM plans ORDER BY category COLLATE NOCASE, amount ASC, name COLLATE NOCASE', [], (err, rows) => {
    if (err) {
      console.error('Error fetching plans:', err);
      return res.status(500).json({ error: 'Error fetching plans' });
    }
    res.json(rows || []);
  });
});

// Create a plan template
app.post('/api/plans', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const plan = normalizePlanPayload(req.body || {});
  if (plan.error) {
    return res.status(400).json({ error: plan.error });
  }

  db.run(
    'INSERT INTO plans (name, category, cpu, ram, disk, amount) VALUES (?, ?, ?, ?, ?, ?)',
    [plan.name, plan.category, plan.cpu, plan.ram, plan.disk, plan.amount],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(409).json({ error: 'A plan with that name already exists' });
        }
        console.error('Error creating plan:', err);
        return res.status(500).json({ error: 'Error creating plan' });
      }
      db.get('SELECT * FROM plans WHERE id = ?', [this.lastID], (selectErr, row) => {
        if (selectErr) {
          return res.status(500).json({ error: 'Plan was created but could not be loaded' });
        }
        res.status(201).json(row);
      });
    }
  );
});

// Update a plan template
app.put('/api/plans/:id', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const plan = normalizePlanPayload(req.body || {});
  if (plan.error) {
    return res.status(400).json({ error: plan.error });
  }

  db.run(
    `UPDATE plans
     SET name = ?, category = ?, cpu = ?, ram = ?, disk = ?, amount = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [plan.name, plan.category, plan.cpu, plan.ram, plan.disk, plan.amount, req.params.id],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(409).json({ error: 'A plan with that name already exists' });
        }
        console.error('Error updating plan:', err);
        return res.status(500).json({ error: 'Error updating plan' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      db.get('SELECT * FROM plans WHERE id = ?', [req.params.id], (selectErr, row) => {
        if (selectErr) {
          return res.status(500).json({ error: 'Plan was updated but could not be loaded' });
        }
        res.json(row);
      });
    }
  );
});

// Delete a plan template. Existing sales retain their saved plan details.
app.delete('/api/plans/:id', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  db.run('DELETE FROM plans WHERE id = ?', [req.params.id], function(err) {
    if (err) {
      console.error('Error deleting plan:', err);
      return res.status(500).json({ error: 'Error deleting plan' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    res.json({ success: true });
  });
});

// Get all sales (ensureDbInitialized so db is ready; LEFT JOIN so all rows show even if user missing)
app.get('/api/sales', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not ready' });
  }
  const { month, year } = req.query;
  
  let query = `
    SELECT s.*, COALESCE(u.username, 'Unknown') as created_by_username 
    FROM sales s 
    LEFT JOIN users u ON s.created_by = u.id
  `;
  const params = [];

  if (month && year) {
    query += ' WHERE strftime("%m", date_bought) = ? AND strftime("%Y", date_bought) = ?';
    params.push(month.padStart(2, '0'), year);
  }

  query += ' ORDER BY date_bought DESC, created_at DESC';

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Error fetching sales:', err);
      return res.status(500).json({ error: 'Error fetching sales' });
    }
    
    if (rows.length > 0) {
      console.log(`Fetched ${rows.length} sales records`);
    }
    
    res.json(rows || []);
  });
});

// Diagnostic endpoint to check database state
app.get('/api/diagnostic', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  // Check total sales count
  db.get('SELECT COUNT(*) as count FROM sales', [], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Error checking database' });
    }
    
    // Check sales with valid user references
    db.get(`
      SELECT COUNT(*) as count 
      FROM sales s 
      JOIN users u ON s.created_by = u.id
    `, [], (err, validRow) => {
      if (err) {
        return res.status(500).json({ error: 'Error checking valid sales' });
      }
      
      res.json({
        totalSalesInDatabase: row.count || 0,
        validSalesWithUsers: validRow.count || 0,
        orphanedSales: (row.count || 0) - (validRow.count || 0)
      });
    });
  });
});

// Get sales statistics
app.get('/api/statistics', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const { month, year } = req.query;
  
  let whereClause = '';
  const params = [];

  if (month && year) {
    whereClause = ' WHERE strftime("%m", date_bought) = ? AND strftime("%Y", date_bought) = ?';
    params.push(month.padStart(2, '0'), year);
  }

  const query = `
    SELECT 
      COUNT(*) as total_sales,
      SUM(amount) as total_amount,
      SUM(CASE WHEN status = 'Paid' THEN amount ELSE 0 END) as paid_amount,
      SUM(CASE WHEN status = 'Pending' THEN amount ELSE 0 END) as pending_amount,
      COUNT(CASE WHEN status = 'Paid' THEN 1 END) as paid_sales
    FROM sales
    ${whereClause}
  `;

  db.get(query, params, (err, row) => {
    if (err) {
      console.error('Error fetching statistics:', err);
      return res.status(500).json({ error: 'Error fetching statistics' });
    }

    // Ensure we have valid row data, default to 0 if null
    const totalSales = row && row.total_sales ? parseInt(row.total_sales) : 0;
    const totalAmount = row && row.total_amount ? parseFloat(row.total_amount) : 0;
    const paidAmount = row && row.paid_amount ? parseFloat(row.paid_amount) : 0;
    const pendingAmount = row && row.pending_amount ? parseFloat(row.pending_amount) : 0;
    const paidSales = row && row.paid_sales ? parseInt(row.paid_sales) : 0;

    // Fixed monthly salaries (not percentage-based)
    const ownerSalary = 1200;
    const developerSalary = 1200;
    const staffSalary = 700;

    res.json({
      totalSales: totalSales,
      totalAmount: totalAmount,
      paidAmount: paidAmount,
      pendingAmount: pendingAmount,
      paidSales: paidSales,
      salaries: {
        owner: ownerSalary,
        developer: developerSalary,
        staff: staffSalary
      }
    });
  });
});

// Create sale (automated - for order integration)
app.post('/api/sales/auto', ensureDbInitialized, requireDb, requireApiKey, (req, res) => {
  const {
    date_bought,
    duration,
    date_expiry,
    customer_name,
    plan,
    cpu,
    ram,
    disk,
    amount,
    promo,
    payment_method,
    status
  } = req.body;

  console.log('Received automated sale data:', {
    date_bought,
    duration,
    date_expiry,
    customer_name,
    plan
  });

  if (!date_bought || !customer_name || !plan || !cpu || !ram || !disk || amount === undefined || amount === null || amount === '' || !payment_method || !status) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const amountValue = parseAmount(amount);
  if (amountValue === null) {
    return res.status(400).json({ error: 'Amount must be a non-negative number' });
  }

  if (status !== 'Paid' && status !== 'Pending') {
    return res.status(400).json({ error: 'Status must be Paid or Pending' });
  }

  // Get system user ID for automated orders
  db.get('SELECT id FROM users WHERE username = ?', ['system'], (err, systemUser) => {
    if (err) {
      console.error('Error fetching system user:', err);
      return res.status(500).json({ error: 'Error fetching system user: ' + err.message });
    }
    
    if (!systemUser) {
      return res.status(500).json({ error: 'System user not found. Please restart the server to create it.' });
    }
    
    db.run(
      `INSERT INTO sales (date_bought, duration, date_expiry, customer_name, plan, cpu, ram, disk, amount, promo, payment_method, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [date_bought, duration || null, date_expiry || null, customer_name, plan, cpu, ram, disk, amountValue, promo || null, payment_method, status, systemUser.id],
    function(err) {
      if (err) {
        console.error('Error creating automated sale:', err);
        return res.status(500).json({ error: 'Error creating sale: ' + err.message });
      }
      console.log('Automated sale created successfully:', {
        id: this.lastID,
        date_bought,
        date_expiry,
        duration
      });
      res.json({ success: true, id: this.lastID });
      // Fire-and-forget Discord notification
      discordBot.notifyDiscord(db, 'sale', {
        customer_name, plan, amount, payment_method, date_bought, date_expiry,
      }).catch((discErr) => console.error('Discord notify failed:', discErr.message));
      // Track customer record
      db.run('INSERT OR IGNORE INTO customers (name) VALUES (?)', [customer_name], (custErr) => {
        if (custErr && !custErr.message.includes('no such table')) {
          console.error('Error tracking customer:', custErr.message);
        }
      });
    }
    );
  });
});

// Create sale
app.post('/api/sales', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const {
    date_bought,
    duration,
    date_expiry,
    customer_name,
    plan,
    cpu,
    ram,
    disk,
    amount,
    promo,
    payment_method,
    status
  } = req.body;

  console.log('Received sale data:', {
    date_bought,
    duration,
    date_expiry,
    customer_name,
    plan
  });

  if (!date_bought || !customer_name || !plan || !cpu || !ram || !disk || amount === undefined || amount === null || amount === '' || !payment_method || !status) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const amountValue = parseAmount(amount);
  if (amountValue === null) {
    return res.status(400).json({ error: 'Amount must be a non-negative number' });
  }

  if (status !== 'Paid' && status !== 'Pending') {
    return res.status(400).json({ error: 'Status must be Paid or Pending' });
  }

  db.run(
    `INSERT INTO sales (date_bought, duration, date_expiry, customer_name, plan, cpu, ram, disk, amount, promo, payment_method, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [date_bought, duration || null, date_expiry || null, customer_name, plan, cpu, ram, disk, amountValue, promo || null, payment_method, status, req.session.userId],
    function(err) {
      if (err) {
        console.error('Error creating sale:', err);
        return res.status(500).json({ error: 'Error creating sale: ' + err.message });
      }
      console.log('Sale created successfully:', {
        id: this.lastID,
        date_bought,
        date_expiry,
        duration
      });
      res.json({ success: true, id: this.lastID });
      // Fire-and-forget Discord notification
      discordBot.notifyDiscord(db, 'sale', {
        customer_name, plan, amount, payment_method, date_bought, date_expiry,
      }).catch((discErr) => console.error('Discord notify failed:', discErr.message));
      // Track customer record
      db.run('INSERT OR IGNORE INTO customers (name) VALUES (?)', [customer_name], (custErr) => {
        if (custErr && !custErr.message.includes('no such table')) {
          console.error('Error tracking customer:', custErr.message);
        }
      });
    }
  );
});

// Update sale
app.put('/api/sales/:id', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const { id } = req.params;
  const {
    date_bought,
    duration,
    date_expiry,
    customer_name,
    plan,
    cpu,
    ram,
    disk,
    amount,
    promo,
    payment_method,
    status
  } = req.body;

  console.log('Updating sale:', {
    id,
    date_bought,
    duration,
    date_expiry,
    customer_name
  });

  if (!date_bought || !customer_name || !plan || !cpu || !ram || !disk || amount === undefined || amount === null || amount === '' || !payment_method || !status) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const amountValue = parseAmount(amount);
  if (amountValue === null) {
    return res.status(400).json({ error: 'Amount must be a non-negative number' });
  }

  if (status !== 'Paid' && status !== 'Pending') {
    return res.status(400).json({ error: 'Status must be Paid or Pending' });
  }

  db.run(
    `UPDATE sales SET date_bought = ?, duration = ?, date_expiry = ?, customer_name = ?, plan = ?, cpu = ?, ram = ?, disk = ?, 
     amount = ?, promo = ?, payment_method = ?, status = ? WHERE id = ?`,
    [date_bought, duration || null, date_expiry || null, customer_name, plan, cpu, ram, disk, amountValue, promo || null, payment_method, status, id],
    function(err) {
      if (err) {
        console.error('Error updating sale:', err);
        return res.status(500).json({ error: 'Error updating sale: ' + err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Sale not found' });
      }
      console.log('Sale updated successfully:', {
        id,
        date_expiry,
        changes: this.changes
      });
      res.json({ success: true });
      // Keep the customer directory in sync when a sale introduces a new name
      db.run('INSERT OR IGNORE INTO customers (name) VALUES (?)', [customer_name], (custErr) => {
        if (custErr && !custErr.message.includes('no such table')) {
          console.error('Error tracking customer:', custErr.message);
        }
      });
    }
  );
});

// Renew sale (body: { duration?: string, amount?: number })
// 1) Extends the existing sale's date_expiry so the subscription is up to date.
// 2) Inserts a NEW sale row for the renewal payment so total sales and total amount increase.
app.post('/api/sales/:id/renew', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const { id } = req.params;
  const { duration: bodyDuration, amount: bodyAmount } = req.body || {};
  const userId = req.session && req.session.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Get full sale row so we can copy customer/plan and create the renewal sale record
  db.get(
    'SELECT duration, date_expiry, amount, customer_name, plan, cpu, ram, disk, payment_method, promo FROM sales WHERE id = ?',
    [id],
    (err, sale) => {
      if (err) {
        return res.status(500).json({ error: 'Error fetching sale' });
      }
      if (!sale) {
        return res.status(404).json({ error: 'Sale not found' });
      }

      const duration = (typeof bodyDuration === 'string' && bodyDuration.trim()) || sale.duration;
      if (!duration) {
        return res.status(400).json({ error: 'Cannot renew: Duration is required (select in form or set on sale)' });
      }

      // Calculate new expiry date
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let baseDate = today;
      if (sale.date_expiry) {
        const expiryDate = new Date(sale.date_expiry);
        expiryDate.setHours(0, 0, 0, 0);
        if (expiryDate >= today) {
          baseDate = expiryDate;
        }
      }

      const newExpiry = new Date(baseDate);
      switch (duration) {
        case '1 month':
          newExpiry.setMonth(newExpiry.getMonth() + 1);
          break;
        case '6 Months':
          newExpiry.setMonth(newExpiry.getMonth() + 6);
          break;
        case '1 Year':
          newExpiry.setFullYear(newExpiry.getFullYear() + 1);
          break;
        default:
          return res.status(400).json({ error: 'Invalid duration' });
      }

      const year = newExpiry.getFullYear();
      const month = String(newExpiry.getMonth() + 1).padStart(2, '0');
      const day = String(newExpiry.getDate()).padStart(2, '0');
      const newExpiryDate = `${year}-${month}-${day}`;

      const dateBoughtToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const hasBodyAmount = bodyAmount !== null && bodyAmount !== undefined && bodyAmount !== '';
      const renewalAmount = parseAmount(hasBodyAmount ? bodyAmount : sale.amount);
      if (renewalAmount === null) {
        return res.status(400).json({ error: 'Amount must be a non-negative number' });
      }

      // 1) Update existing sale: extend expiry and duration only (keep original amount for the subscription record)
      db.run(
        'UPDATE sales SET date_expiry = ?, duration = ? WHERE id = ?',
        [newExpiryDate, duration, id],
        function(updateErr) {
          if (updateErr) {
            console.error('Error renewing sale (update):', updateErr);
            return res.status(500).json({ error: 'Error renewing sale: ' + updateErr.message });
          }
          if (this.changes === 0) {
            return res.status(404).json({ error: 'Sale not found' });
          }

          // 2) Insert a new sale row for the renewal payment so total sales and total amount increase
          db.run(
            `INSERT INTO sales (date_bought, duration, date_expiry, customer_name, plan, cpu, ram, disk, amount, promo, payment_method, status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Paid', ?)`,
            [
              dateBoughtToday,
              duration,
              newExpiryDate,
              sale.customer_name,
              sale.plan,
              sale.cpu,
              sale.ram,
              sale.disk,
              renewalAmount,
              sale.promo || null,
              sale.payment_method,
              userId
            ],
            function(insertErr) {
              if (insertErr) {
                console.error('Error creating renewal sale record:', insertErr);
                return res.status(500).json({ error: 'Error recording renewal sale: ' + insertErr.message });
              }
              console.log('Sale renewed successfully:', {
                originalId: id,
                renewalSaleId: this.lastID,
                oldExpiry: sale.date_expiry,
                newExpiry: newExpiryDate,
                duration,
                renewalAmount
              });
              res.json({ success: true, newExpiry: newExpiryDate, renewalSaleId: this.lastID });
              // Fire-and-forget Discord notification
              discordBot.notifyDiscord(db, 'renewal', {
                customer_name: sale.customer_name,
                plan: sale.plan,
                amount: renewalAmount,
                payment_method: sale.payment_method,
                date_bought: new Date().toISOString().slice(0, 10),
                date_expiry: newExpiryDate,
              }).catch((discErr) => console.error('Discord notify failed:', discErr.message));
            }
          );
        }
      );
    }
  );
});

// Mark sale as "No Renew" (customer won't renew; hide from Expirations tab)
app.post('/api/sales/:id/no-renew', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not ready' });
  }
  const id = req.params.id;

  function doUpdate() {
    db.run('UPDATE sales SET no_renew = 1 WHERE id = ?', [id], function(err) {
      if (err) {
        if (err.message && err.message.includes('no such column: no_renew')) {
          return db.run('ALTER TABLE sales ADD COLUMN no_renew INTEGER DEFAULT 0', (alterErr) => {
            if (alterErr) {
              console.error('Error adding no_renew column:', alterErr);
              return res.status(500).json({ error: 'Error updating sale' });
            }
            doUpdate();
          });
        }
        console.error('Error in no-renew:', err);
        return res.status(500).json({ error: 'Error updating sale' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Sale not found' });
      }
      res.json({ success: true });
    });
  }

  doUpdate();
});

// Delete sale
app.delete('/api/sales/:id', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM sales WHERE id = ?', [id], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Error deleting sale' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Sale not found' });
    }
    res.json({ success: true });
  });
});

// Get available months/years for filtering
app.get('/api/sales/months', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  db.all(
    `SELECT DISTINCT 
      strftime("%Y", date_bought) as year,
      strftime("%m", date_bought) as month,
      strftime("%Y-%m", date_bought) as year_month
    FROM sales 
    ORDER BY year DESC, month DESC`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Error fetching months' });
      }
      res.json(rows);
    }
  );
});

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
      'text/csv' // .csv
    ];
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only Excel (.xlsx, .xls) and CSV files are allowed.'));
    }
  }
});

// Export sales to Excel
app.get('/api/sales/export', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  console.log('Export endpoint called');
  try {
    const query = `
      SELECT 
        s.id,
        s.date_bought as "Date Bought",
        s.date_expiry as "Date Expiry",
        s.duration as "Duration",
        s.customer_name as "Customer Name",
        s.plan as "Plan",
        s.cpu as "CPU",
        s.ram as "RAM",
        s.disk as "DISK",
        s.amount as "Amount",
        s.promo as "Promo",
        s.payment_method as "Payment Method",
        s.status as "Status",
        u.username as "Created By",
        s.created_at as "Created At"
      FROM sales s 
      LEFT JOIN users u ON s.created_by = u.id
      ORDER BY s.date_bought DESC, s.created_at DESC
    `;

    db.all(query, [], (err, rows) => {
      if (err) {
        console.error('Error exporting sales:', err);
        res.status(500).json({ error: 'Error exporting sales: ' + err.message });
        return;
      }

      try {
        // Create workbook and worksheet
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows || []);

        // Set column widths
        const colWidths = [
          { wch: 10 }, // ID
          { wch: 15 }, // Date Bought
          { wch: 15 }, // Date Expiry
          { wch: 12 }, // Duration
          { wch: 20 }, // Customer Name
          { wch: 20 }, // Plan
          { wch: 12 }, // CPU
          { wch: 10 }, // RAM
          { wch: 10 }, // DISK
          { wch: 12 }, // Amount
          { wch: 10 }, // Promo
          { wch: 15 }, // Payment Method
          { wch: 10 }, // Status
          { wch: 15 }, // Created By
          { wch: 20 }  // Created At
        ];
        ws['!cols'] = colWidths;

        XLSX.utils.book_append_sheet(wb, ws, 'Sales');

        // Generate buffer
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        // Set headers for download
        const filename = `sales_export_${new Date().toISOString().split('T')[0]}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
      } catch (xlsxError) {
        console.error('Error creating Excel file:', xlsxError);
        res.status(500).json({ error: 'Error creating Excel file: ' + xlsxError.message });
      }
    });
  } catch (error) {
    console.error('Error in export endpoint:', error);
    res.status(500).json({ error: 'Error exporting sales: ' + error.message });
  }
});

// Import sales from Excel
app.post('/api/sales/import', ensureDbInitialized, requireDb, requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    // Parse the Excel file. cellDates keeps real date cells as Date objects
    // instead of locale-dependent serial numbers.
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    if (data.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Get current user ID
    const userId = req.session.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let successCount = 0;
    let errorCount = 0;
    const errors = [];
    let processedCount = 0;
    const totalRows = data.length;

    // Process each row with promises
    const insertPromises = data.map((row, index) => {
      return new Promise((resolve) => {
        try {
          // Map Excel columns to database fields
          const saleData = {
            date_bought: normalizeDate(row['Date Bought'] || row['date_bought'] || row['Date Bought'] || ''),
            date_expiry: normalizeDate(row['Date Expiry'] || row['date_expiry'] || row['Date Expiry'] || '') || null,
            duration: row['Duration'] || row['duration'] || null,
            customer_name: String(row['Customer Name'] || row['customer_name'] || row['Customer Name'] || '').trim(),
            plan: row['Plan'] || row['plan'] || '',
            cpu: row['CPU'] || row['cpu'] || '',
            ram: row['RAM'] || row['ram'] || '',
            disk: row['DISK'] || row['disk'] || '',
            amount: parseAmount(row['Amount'] ?? row['amount'] ?? row['Amount']),
            promo: row['Promo'] || row['promo'] || row['Promo'] || null,
            payment_method: row['Payment Method'] || row['payment_method'] || row['Payment Method'] || '',
            status: row['Status'] || row['status'] || row['Status'] || 'Pending',
            created_by: userId
          };

          // Validate required fields
          if (!saleData.date_bought || !saleData.customer_name || !saleData.plan || 
              !saleData.cpu || !saleData.ram || !saleData.disk || 
              !saleData.payment_method || !saleData.status) {
            throw new Error('Missing required fields');
          }

          if (saleData.amount === null) {
            throw new Error('Amount must be a non-negative number');
          }

          // Validate status
          if (saleData.status !== 'Paid' && saleData.status !== 'Pending') {
            saleData.status = 'Pending';
          }

          // Insert into database
          db.run(
            `INSERT INTO sales (date_bought, duration, date_expiry, customer_name, plan, cpu, ram, disk, amount, promo, payment_method, status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              saleData.date_bought,
              saleData.duration || null,
              saleData.date_expiry || null,
              saleData.customer_name,
              saleData.plan,
              saleData.cpu,
              saleData.ram,
              saleData.disk,
              saleData.amount,
              saleData.promo || null,
              saleData.payment_method,
              saleData.status,
              saleData.created_by
            ],
            function(err) {
              if (err) {
                errorCount++;
                errors.push(`Row ${index + 2}: ${err.message}`);
              } else {
                successCount++;
                // Track imported customers in the customer directory
                db.run('INSERT OR IGNORE INTO customers (name) VALUES (?)', [saleData.customer_name], (custErr) => {
                  if (custErr && !custErr.message.includes('no such table')) {
                    console.error('Error tracking imported customer:', custErr.message);
                  }
                });
              }
              processedCount++;
              resolve();
            }
          );
        } catch (error) {
          errorCount++;
          errors.push(`Row ${index + 2}: ${error.message}`);
          processedCount++;
          resolve();
        }
      });
    });

    // Wait for all inserts to complete
    Promise.all(insertPromises).then(() => {
      res.json({
        success: true,
        message: `Import completed: ${successCount} successful, ${errorCount} errors`,
        successCount,
        errorCount,
        errors: errors.slice(0, 10) // Limit to first 10 errors
      });
    });
  } catch (error) {
    console.error('Error importing sales:', error);
    res.status(500).json({ error: 'Error processing file: ' + error.message });
  }
});

// --- Discord bot integration -------------------------------------------------

// Expiry digest helpers: run at most once per calendar day
let lastExpiryDigestSent = null;
let expiryAlertTimer = null;

async function runDailyExpiryDigest() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastExpiryDigestSent === today) return;
  try {
    // Only mark the day as done when something was actually delivered, so a
    // failed/unconfigured digest is retried on the next timer tick.
    const sent = await discordBot.sendExpiryDigest(db);
    if (sent) lastExpiryDigestSent = today;
  } catch (err) {
    console.error('Discord expiry digest failed:', err.message);
  }
}

function startExpiryAlertTimer() {
  if (expiryAlertTimer) return;
  // Checking every 30 minutes is cheap; the digest itself only goes out once a day.
  expiryAlertTimer = setInterval(runDailyExpiryDigest, 30 * 60 * 1000);
  // Also try shortly after boot
  setTimeout(runDailyExpiryDigest, 60 * 1000);
}

// Discord settings (read; token is masked)
app.get('/api/discord/settings', ensureDbInitialized, requireDb, requireAuth, async (req, res) => {
  try {
    await new Promise((resolve, reject) => discordBot.ensureSettingsTable(db, (e) => (e ? reject(e) : resolve())));
    const settings = await discordBot.getDiscordSettings(db);
    if (settings.bot_token) {
      settings.bot_token_masked = '••••' + settings.bot_token.slice(-4);
    }
    delete settings.bot_token;
    res.json(settings);
  } catch (err) {
    console.error('Error loading discord settings:', err);
    res.status(500).json({ error: 'Error loading Discord settings' });
  }
});

// Discord settings (save; restarts the bot with new config)
app.put('/api/discord/settings', ensureDbInitialized, requireDb, requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    for (const key of discordBot.SETTING_KEYS) {
      if (key === 'expiring_days') {
        const days = parseInt(body[key], 10);
        await discordBot.setDiscordSetting(db, key, isNaN(days) ? 7 : Math.min(Math.max(days, 1), 90));
      } else if (key === 'admin_role_id') {
        const roleId = String(body[key] ?? '').trim();
        if (roleId && !/^\d{5,20}$/.test(roleId)) {
          return res.status(400).json({ error: 'Admin role ID must be a numeric Discord role ID.' });
        }
        await discordBot.setDiscordSetting(db, key, roleId);
      } else if (body[key] !== undefined) {
        await discordBot.setDiscordSetting(db, key, body[key]);
      }
    }
    // Restart the bot so new token / guild / channel settings take effect
    discordBot.startDiscordBot(db).catch((err) => console.error('Discord bot restart failed:', err.message));
    res.json({ success: true, message: 'Discord settings saved. Bot is restarting with the new configuration.' });
  } catch (err) {
    console.error('Error saving discord settings:', err);
    res.status(500).json({ error: 'Error saving Discord settings' });
  }
});

// Discord bot status (for the admin panel)
app.get('/api/discord/status', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  res.json(discordBot.getBotStatus());
});

// Test notification: posts a sample embed via the configured bot channel / webhook
app.post('/api/discord/test', ensureDbInitialized, requireDb, requireAuth, async (req, res) => {
  try {
    await new Promise((resolve, reject) => discordBot.ensureSettingsTable(db, (e) => (e ? reject(e) : resolve())));
    const settings = await discordBot.getDiscordSettings(db);
    const hasWebhook = !!settings.webhook_url;
    const hasBotChannel = !!settings.bot_token && !!settings.channel_id;
    if (!hasWebhook && !hasBotChannel) {
      return res.status(400).json({ error: 'Configure a webhook URL, or a bot token plus a notification channel ID, first.' });
    }
    if (!hasWebhook && discordBot.getBotStatus().status !== 'online') {
      return res.status(400).json({ error: 'The bot is not online yet. Wait a few seconds after saving settings, or configure a webhook URL.' });
    }

    // Temporarily enable sale notifications so the test works even when the
    // admin has switched "new sale" alerts off, then restore the setting.
    const salesWereDisabled = settings.notify_sales !== 'true';
    if (salesWereDisabled) await discordBot.setDiscordSetting(db, 'notify_sales', 'true');
    try {
      const sent = await discordBot.notifyDiscord(db, 'sale', {
        customer_name: 'Test Customer',
        plan: 'Sample Plan',
        amount: 0,
        payment_method: 'Test',
        date_bought: new Date().toISOString(),
      });
      if (!sent) {
        return res.status(400).json({ error: 'Nothing was sent. Check the webhook URL or the bot token/channel ID.' });
      }
    } finally {
      if (salesWereDisabled) await discordBot.setDiscordSetting(db, 'notify_sales', 'false');
    }
    res.json({ success: true, message: 'Test notification sent. Check your Discord channel / webhook.' });
  } catch (err) {
    console.error('Discord test notification failed:', err);
    res.status(500).json({ error: 'Test notification failed: ' + err.message });
  }
});

// --- Customer management -----------------------------------------------------

// List customers with purchase aggregates
app.get('/api/customers', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const query = `
    SELECT c.id, c.name, c.discord_id, c.contact, c.notes, c.created_at,
      COUNT(s.id) AS total_orders,
      COALESCE(SUM(s.amount), 0) AS total_spent,
      MAX(s.date_expiry) AS latest_expiry
    FROM customers c
    LEFT JOIN sales s ON s.customer_name COLLATE NOCASE = c.name
    GROUP BY c.id
    ORDER BY c.name COLLATE NOCASE ASC`;
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching customers:', err);
      return res.status(500).json({ error: 'Error fetching customers' });
    }
    res.json(rows || []);
  });
});

// One customer + their purchase history
app.get('/api/customers/:id', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.get('SELECT * FROM customers WHERE id = ?', [id], (err, customer) => {
    if (err) {
      console.error('Error fetching customer:', err);
      return res.status(500).json({ error: 'Error fetching customer' });
    }
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    db.all('SELECT * FROM sales WHERE customer_name COLLATE NOCASE = ? ORDER BY date_bought DESC, created_at DESC', [customer.name], (err2, sales) => {
      if (err2) {
        console.error('Error fetching customer sales:', err2);
        return res.status(500).json({ error: 'Error fetching customer sales' });
      }
      res.json({ ...customer, sales: sales || [] });
    });
  });
});

// Update customer details
app.put('/api/customers/:id', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, discord_id, contact, notes } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Customer name is required' });
  }
  db.get('SELECT id, name FROM customers WHERE id = ?', [id], (err, customer) => {
    if (err || !customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const newName = String(name).trim();
    const stmt = 'UPDATE customers SET name = ?, discord_id = ?, contact = ?, notes = ? WHERE id = ?';
    const params = [newName, discord_id || '', contact || '', notes || '', id];
    db.run(stmt, params, function (err2) {
      if (err2) {
        if (err2.message.includes('UNIQUE constraint failed: customers.name')) {
          return res.status(409).json({ error: 'A customer with that name already exists' });
        }
        console.error('Error updating customer:', err2);
        return res.status(500).json({ error: 'Error updating customer' });
      }
      // Keep historical sale records pointing at the same customer
      if (newName.toLowerCase() !== customer.name.toLowerCase()) {
        db.run('UPDATE sales SET customer_name = ? WHERE customer_name = ? COLLATE NOCASE', [newName, customer.name], () => {});
      }
      res.json({ success: true });
    });
  });
});

// Delete customer record (historical sales are not touched)
app.delete('/api/customers/:id', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  db.run('DELETE FROM customers WHERE id = ?', [parseInt(req.params.id, 10)], function (err) {
    if (err) {
      console.error('Error deleting customer:', err);
      return res.status(500).json({ error: 'Error deleting customer' });
    }
    res.json({ success: true });
  });
});

// --- Database backups --------------------------------------------------------

function createBackup(filenameOverride, callback) {
  if (!db) return callback(new Error('Database not ready'));
  const dest = path.join(backupsDir, filenameOverride);
  fs.mkdir(backupsDir, { recursive: true }, () => {
    // Checkpoint WAL into the main db file, then copy it (sqlite3's
    // db.backup() produces an empty file on some builds, so copy instead)
    db.run('PRAGMA wal_checkpoint(TRUNCATE);', [], () => {
      fs.copyFile(dbPath, dest, (copyErr) => callback(copyErr || null, filenameOverride));
    });
  });
}

function pruneBackups(keep = 10) {
  fs.readdir(backupsDir, (err, files) => {
    if (err) return;
    const dbs = files.filter((f) => f.endsWith('.db')).sort();
    const toDelete = dbs.slice(0, Math.max(0, dbs.length - keep));
    for (const f of toDelete) {
      fs.unlink(path.join(backupsDir, f), () => {});
    }
  });
}

// Automatic backup: at most once per calendar day, keep the 10 most recent
let lastAutoBackupDay = null;

function runDailyBackup() {
  if (!db) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastAutoBackupDay === today) return;
  const stamp = today + '-' + new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  createBackup(`backup-${stamp}.db`, (err) => {
    if (err) {
      // Leave lastAutoBackupDay unset so the next scheduler tick retries.
      console.error('Automatic backup failed:', err.message);
    } else {
      lastAutoBackupDay = today;
      console.log('Automatic backup created:', stamp);
      pruneBackups(10);
    }
  });
}

// Create a backup now
app.post('/api/backup', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  createBackup(`backup-${stamp}.db`, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Backup failed: ' + err.message });
    }
    pruneBackups(10);
    res.json({ success: true, message: 'Backup created successfully' });
  });
});

// List available backups
app.get('/api/backup', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  fs.readdir(backupsDir, (err, files) => {
    if (err) return res.json([]);
    const backups = files
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const st = fs.statSync(path.join(backupsDir, f));
        return { file: f, size: st.size, created: st.mtime.toISOString() };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
    res.json(backups);
  });
});

// Download or delete a specific backup (file name must be a safe basename)
app.get('/api/backup/download', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const name = path.basename(req.query.file || '');
  if (!name.endsWith('.db')) {
    return res.status(400).json({ error: 'Invalid backup file' });
  }
  const filePath = path.join(backupsDir, name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  res.download(filePath, name);
});

app.delete('/api/backup', ensureDbInitialized, requireDb, requireAuth, (req, res) => {
  const name = path.basename(req.query.file || '');
  if (!name.endsWith('.db')) {
    return res.status(400).json({ error: 'Invalid backup file' });
  }
  const filePath = path.join(backupsDir, name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  fs.unlink(filePath, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Could not delete backup' });
    }
    res.json({ success: true });
  });
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve sales.html
app.get('/sales.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sales.html'));
});

// Unknown API routes return JSON instead of falling through to the SPA HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Return JSON (not an HTML stack page) for malformed bodies and upload errors.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large (maximum 10MB)' });
  }
  if (err && /Invalid file type/i.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled request error:', err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  next(err);
});

// Give the Discord /status command access to backup and DB startup info that
// lives in the server process (the bot module deliberately has no direct
// dependency on server.js).
discordBot.setStatusProvider(async () => {
  const backup = { count: 0, latest: null };
  try {
    const files = (await fs.promises.readdir(backupsDir)).filter((f) => f.endsWith('.db'));
    backup.count = files.length;
    if (files.length) {
      const details = await Promise.all(files.map(async (file) => {
        const stat = await fs.promises.stat(path.join(backupsDir, file));
        return { file, size: stat.size, created: stat.mtime.toISOString(), mtime: stat.mtimeMs };
      }));
      details.sort((a, b) => b.mtime - a.mtime);
      const { mtime, ...latest } = details[0];
      backup.latest = latest;
    }
  } catch (error) {
    backup.error = error.message;
  }
  return { dbInitialized, backup };
});

// On Vercel the platform owns the HTTP listener; only start a standalone
// server when running directly (node server.js / a container / a service).
if (process.env.VERCEL !== '1') {
  const httpServer = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  let isShuttingDown = false;
  function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${signal} received. Closing the HTTP server...`);

    // Stop Discord and stop background timers so the process can exit.
    discordBot.stopDiscordBot();
    if (expiryAlertTimer) {
      clearInterval(expiryAlertTimer);
      expiryAlertTimer = null;
    }

    httpServer.close(() => {
      if (!db) {
        process.exit(0);
        return;
      }

      db.close((error) => {
        if (error) {
          console.error('Error closing database:', error.message);
          process.exit(1);
          return;
        }
        console.log('Database connection closed');
        process.exit(0);
      });
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;
