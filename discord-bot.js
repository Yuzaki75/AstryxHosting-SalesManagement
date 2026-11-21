'use strict';

const {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

const SETTING_DEFAULTS = Object.freeze({
  bot_token: '',
  guild_id: '',
  channel_id: '',
  webhook_url: '',
  expiring_days: '7',
  notify_sales: 'true',
  notify_renewals: 'true',
  notify_expiring: 'true',
  admin_role_id: '',
});

const SETTING_KEYS = Object.freeze(Object.keys(SETTING_DEFAULTS));

// Commands that expose financial, customer, or infrastructure data. Everyone
// else can still use the public catalogue command (/plans).
const ADMIN_ONLY_COMMANDS = Object.freeze(new Set([
  'stats',
  'revenue',
  'expiring',
  'customer',
  'status',
]));

const processStartedAt = Date.now();
let activeClient = null;
let activeDatabase = null;
let statusProvider = null;
let botStatus = {
  status: 'not_configured',
  user: 'Not configured',
  guild: '',
  error: '',
};

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      resolve(row || null);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) return reject(error);
      resolve(rows || []);
    });
  });
}

function ensureSettingsTable(db, callback) {
  db.run(
    `CREATE TABLE IF NOT EXISTS discord_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )`,
    (createError) => {
      if (createError) return callback(createError);

      const statement = db.prepare(
        'INSERT OR IGNORE INTO discord_settings (key, value) VALUES (?, ?)'
      );
      for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
        statement.run(key, value);
      }
      statement.finalize(callback);
    }
  );
}

async function getDiscordSettings(db) {
  const rows = await dbAll(db, 'SELECT key, value FROM discord_settings');
  const settings = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, row.key)) {
      settings[row.key] = String(row.value ?? '');
    }
  }
  return settings;
}

async function setDiscordSetting(db, key, value) {
  if (!SETTING_KEYS.includes(key)) {
    throw new Error(`Unsupported Discord setting: ${key}`);
  }
  await dbRun(
    db,
    'INSERT INTO discord_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value ?? '')]
  );
}

function isEnabled(value) {
  return String(value).toLowerCase() === 'true';
}

function safeText(value, maxLength = 1024) {
  return String(value ?? 'N/A')
    .replace(/([*_`~|])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, maxLength);
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '₱0.00';
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildSaleEmbed(type, sale) {
  const isRenewal = type === 'renewal';
  const embed = new EmbedBuilder()
    .setColor(isRenewal ? 0x4c7bfa : 0x34c98f)
    .setTitle(isRenewal ? 'Subscription Renewed' : 'New Sale Recorded')
    .setDescription('AstryxHosting sales notification')
    .addFields(
      { name: 'Customer', value: safeText(sale.customer_name, 256), inline: true },
      { name: 'Plan', value: safeText(sale.plan, 256), inline: true },
      { name: 'Amount', value: money(sale.amount), inline: true },
      { name: 'Payment', value: safeText(sale.payment_method, 128), inline: true },
      { name: 'Status', value: safeText(sale.status || 'Paid', 32), inline: true },
      { name: 'Date Bought', value: safeText(sale.date_bought, 64), inline: true }
    )
    .setTimestamp(new Date());

  if (sale.date_expiry) {
    embed.addFields({ name: 'Expires', value: safeText(sale.date_expiry, 64), inline: true });
  }
  if (sale.promo) {
    embed.addFields({ name: 'Promo', value: safeText(sale.promo, 128), inline: true });
  }
  return embed;
}

function buildExpiryEmbed(sales, days) {
  const embed = new EmbedBuilder()
    .setColor(sales.length ? 0xe6a53a : 0x34c98f)
    .setTitle('Subscription Expiry Digest')
    .setDescription(
      sales.length
        ? `${sales.length} subscription(s) expire within the next ${days} day(s).`
        : `No subscriptions expire within the next ${days} day(s).`
    )
    .setTimestamp(new Date());

  for (const sale of sales.slice(0, 20)) {
    embed.addFields({
      name: `${safeText(sale.customer_name, 180)} · ${safeText(sale.plan, 120)}`,
      value: `Expiry: ${safeText(sale.date_expiry, 32)} | ${money(sale.amount)} | ${safeText(sale.status, 24)}`,
      inline: false,
    });
  }
  if (sales.length > 20) {
    embed.setFooter({ text: `Showing 20 of ${sales.length} subscriptions` });
  }
  return embed;
}

async function sendEmbed(settings, embed) {
  if (settings.webhook_url) {
    let url;
    try {
      url = new URL(settings.webhook_url);
    } catch {
      throw new Error('The Discord webhook URL is invalid.');
    }

    const allowedHosts = new Set([
      'discord.com',
      'discordapp.com',
      'canary.discord.com',
      'ptb.discord.com',
    ]);
    if (
      url.protocol !== 'https:' ||
      !allowedHosts.has(url.hostname.toLowerCase()) ||
      !/^\/(api\/)?webhooks\//.test(url.pathname) ||
      url.username ||
      url.password
    ) {
      throw new Error('The Discord webhook URL is invalid.');
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed.toJSON()] }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Discord webhook returned ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
    }
    return;
  }

  if (!activeClient || !activeClient.isReady()) {
    throw new Error('Discord bot is not connected.');
  }
  if (!settings.channel_id) {
    throw new Error('Set a notification channel ID or configure a webhook URL.');
  }

  const channel = await activeClient.channels.fetch(settings.channel_id);
  if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
    throw new Error('The configured Discord channel is unavailable or cannot receive messages.');
  }
  await channel.send({ embeds: [embed] });
}

async function sendCommandReply(interaction, content) {
  const safeContent = String(content).slice(0, 1900);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: safeContent });
  } else {
    await interaction.reply({ content: safeContent, ephemeral: true });
  }
}

async function sendEmbedReply(interaction, embed) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

function parseMonth(month) {
  if (!month) return null;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
}

// Format a Date as a local YYYY-MM-DD (avoids UTC shifting the day for
// timezones ahead of UTC, e.g. Asia/Manila).
function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Escape LIKE wildcards so a customer search for "%" doesn't match everyone.
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00:00`);
  if (isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function describeExpiry(dateStr) {
  if (!dateStr) return 'No expiry recorded';
  const days = daysUntil(dateStr);
  if (days === null) return String(dateStr);
  if (days < 0) return `${dateStr} (${Math.abs(days)} day(s) ago)`;
  if (days === 0) return `${dateStr} (today)`;
  return `${dateStr} (in ${days} day(s))`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length) parts.push(`${seconds}s`);
  return parts.join(' ');
}

// Search the customer directory by name (partial matches allowed). Falls back
// to distinct sale names so older databases without customer rows still work.
async function getCustomerReport(db, query) {
  const term = String(query || '').trim();
  const result = { query: term, matches: [], customer: null, sales: [] };
  if (!term) return result;

  const pattern = `%${escapeLike(term)}%`;
  let matches = await dbAll(db, `
    SELECT c.id, c.name, c.discord_id, c.contact, c.notes, c.created_at,
           COUNT(s.id) AS total_orders,
           COALESCE(SUM(s.amount), 0) AS total_spent,
           MAX(s.date_expiry) AS latest_expiry
    FROM customers c
    LEFT JOIN sales s ON s.customer_name = c.name COLLATE NOCASE
    WHERE c.name LIKE ? ESCAPE '\\'
    GROUP BY c.id
    ORDER BY c.name COLLATE NOCASE ASC
    LIMIT 10
  `, [pattern]);

  if (!matches.length) {
    matches = await dbAll(db, `
      SELECT NULL AS id, customer_name AS name, '' AS discord_id,
             '' AS contact, '' AS notes, MIN(created_at) AS created_at,
             COUNT(*) AS total_orders,
             COALESCE(SUM(amount), 0) AS total_spent,
             MAX(date_expiry) AS latest_expiry
      FROM sales
      WHERE customer_name LIKE ? ESCAPE '\\'
      GROUP BY customer_name
      ORDER BY customer_name COLLATE NOCASE ASC
      LIMIT 10
    `, [pattern]);
  }

  result.matches = matches;
  if (matches.length !== 1) return result;

  result.customer = matches[0];
  result.sales = await dbAll(db, `
    SELECT date_bought, date_expiry, plan, amount, status, payment_method
    FROM sales
    WHERE customer_name = ? COLLATE NOCASE
    ORDER BY date_bought DESC, created_at DESC
    LIMIT 5
  `, [result.customer.name]);
  return result;
}

// Gather health information for /status. The optional provider supplies data
// that lives in the server (backup files, db initialization flag).
async function getStatusReport(db) {
  const report = {
    bot: getBotStatus(),
    uptimeMs: Date.now() - processStartedAt,
    ping: activeClient && activeClient.isReady() ? activeClient.ws.ping : null,
    db: { ok: false, initialized: false, sales: 0, customers: 0, plans: 0, expiring: 0 },
    backup: null,
    notifications: null,
    adminRoleConfigured: false,
  };

  try {
    const check = await dbGet(db, 'SELECT 1 AS ok');
    report.db.ok = !!check && Number(check.ok) === 1;
    if (report.db.ok) {
      const [sales, customers, plans, expiring] = await Promise.all([
        dbGet(db, 'SELECT COUNT(*) AS count FROM sales'),
        dbGet(db, 'SELECT COUNT(*) AS count FROM customers'),
        dbGet(db, 'SELECT COUNT(*) AS count FROM plans'),
        (() => {
          const today = toDateString(new Date());
          const end = new Date();
          end.setDate(end.getDate() + 7);
          return dbGet(db, `
            SELECT COUNT(*) AS count FROM sales
            WHERE date_expiry BETWEEN ? AND ? AND COALESCE(no_renew, 0) = 0
          `, [today, toDateString(end)]);
        })(),
      ]);
      report.db.sales = Number(sales?.count || 0);
      report.db.customers = Number(customers?.count || 0);
      report.db.plans = Number(plans?.count || 0);
      report.db.expiring = Number(expiring?.count || 0);
    }
  } catch (error) {
    report.db.error = error.message;
  }

  try {
    const settings = await getDiscordSettings(db);
    report.notifications = {
      webhook: !!settings.webhook_url,
      channel: !!settings.channel_id,
      sales: isEnabled(settings.notify_sales),
      renewals: isEnabled(settings.notify_renewals),
      expiring: isEnabled(settings.notify_expiring),
    };
    report.adminRoleConfigured = !!settings.admin_role_id;
  } catch (error) {
    report.settingsError = error.message;
  }

  if (statusProvider) {
    try {
      const extra = await statusProvider();
      if (extra && typeof extra === 'object') {
        report.backup = extra.backup || null;
        if (extra.dbInitialized !== undefined) report.db.initialized = !!extra.dbInitialized;
      }
    } catch (error) {
      report.backup = { error: error.message };
    }
  }

  return report;
}

function buildCustomerEmbed(report) {
  if (!report.matches.length) {
    return new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('Customer not found')
      .setDescription(`No customer matched \`${safeText(report.query || '', 100)}\`.`);
  }

  if (!report.customer) {
    const embed = new EmbedBuilder()
      .setColor(0x4c7bfa)
      .setTitle('Customer matches')
      .setDescription(`${report.matches.length} customer(s) found. Run the command again with a more specific name.`);
    for (const match of report.matches) {
      embed.addFields({
        name: safeText(match.name, 180),
        value: `Orders: ${match.total_orders} · Spent: ${money(match.total_spent)} · Latest expiry: ${describeExpiry(match.latest_expiry)}`,
        inline: false,
      });
    }
    return embed;
  }

  const customer = report.customer;
  const embed = new EmbedBuilder()
    .setColor(0x4c7bfa)
    .setTitle(`Customer: ${safeText(customer.name, 180)}`)
    .addFields(
      { name: 'Customer ID', value: String(customer.id ?? '—'), inline: true },
      { name: 'Discord ID', value: safeText(customer.discord_id || 'Not set', 128), inline: true },
      { name: 'Contact', value: safeText(customer.contact || 'Not set', 128), inline: true },
      { name: 'Total orders', value: String(customer.total_orders), inline: true },
      { name: 'Total spent', value: money(customer.total_spent), inline: true },
      { name: 'Latest expiry', value: safeText(describeExpiry(customer.latest_expiry), 128), inline: true }
    );

  if (customer.notes) {
    embed.addFields({ name: 'Notes', value: safeText(customer.notes, 900), inline: false });
  }

  const recent = report.sales.length
    ? report.sales.map((sale) =>
        `${safeText(sale.date_bought, 32)} · ${safeText(sale.plan, 80)} · ${money(sale.amount)} · ${safeText(sale.status, 24)}`
      ).join('\n')
    : 'No sales recorded.';
  embed.addFields({ name: 'Recent purchases', value: recent.slice(0, 1000), inline: false });
  return embed;
}

function buildStatusEmbed(report) {
  const meta = {
    online: { color: 0x57f287, label: '🟢 Online' },
    connecting: { color: 0xfee75c, label: '🟡 Connecting' },
    starting: { color: 0xfee75c, label: '🟡 Starting' },
    not_configured: { color: 0x95a5a6, label: '⚪ Not configured' },
    stopped: { color: 0x95a5a6, label: '⚪ Stopped' },
    error: { color: 0xed4245, label: '🔴 Error' },
  }[report.bot.status] || { color: 0x95a5a6, label: report.bot.status };

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle('AstryxHosting Bot Status')
    .setTimestamp();

  embed.addFields(
    { name: 'Bot', value: `${meta.label} · ${safeText(report.bot.user, 100)}`, inline: true },
    { name: 'Uptime', value: formatDuration(report.uptimeMs), inline: true },
    { name: 'Ping', value: report.ping === null ? '—' : `${Math.round(report.ping)} ms`, inline: true },
    { name: 'Guild', value: safeText(report.bot.guild || 'Not set', 100), inline: true },
    {
      name: 'Database',
      value: report.db.ok
        ? `OK · ${report.db.sales} sales · ${report.db.customers} customers · ${report.db.plans} plans`
        : `Unavailable${report.db.error ? `: ${safeText(report.db.error, 80)}` : ''}`,
      inline: false,
    },
    { name: 'Expiring (7 days)', value: `${report.db.expiring} subscription(s)`, inline: true }
  );

  if (report.backup) {
    const latest = report.backup.latest;
    const backupText = latest
      ? `${safeText(latest.file, 120)} · ${(Number(latest.size) / 1024).toFixed(0)} KB · ${safeText(latest.created, 40)}`
      : report.backup.error
        ? `Error: ${safeText(report.backup.error, 100)}`
        : `No backups found (${report.backup.count || 0} files)`;
    embed.addFields({ name: 'Last backup', value: backupText, inline: false });
  }

  if (report.notifications) {
    const n = report.notifications;
    embed.addFields({
      name: 'Notifications',
      value: `Webhook: ${n.webhook ? 'configured' : 'off'} · Channel: ${n.channel ? 'configured' : 'off'}\nSale: ${n.sales ? 'on' : 'off'} · Renewal: ${n.renewals ? 'on' : 'off'} · Expiry: ${n.expiring ? 'on' : 'off'}`,
      inline: false,
    });
  }

  embed.addFields({
    name: 'Admin access',
    value: `Configured role: ${report.adminRoleConfigured ? 'yes' : 'no'} · members with Manage Server can always use admin commands`,
    inline: false,
  });

  if (report.bot.error) {
    embed.addFields({ name: 'Bot message', value: safeText(report.bot.error, 900), inline: false });
  }

  return embed;
}

// A member is an admin when they hold Manage Server or the configured role.
function isAdminInteraction(interaction, settings) {
  if (!interaction || typeof interaction.inGuild !== 'function' || !interaction.inGuild()) return false;

  const permissions = interaction.memberPermissions;
  if (permissions && typeof permissions.has === 'function' && permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  const adminRoleId = settings && settings.admin_role_id;
  if (!adminRoleId) return false;

  const roles = interaction.member && interaction.member.roles;
  if (!roles) return false;
  if (roles.cache && typeof roles.cache.has === 'function') return roles.cache.has(adminRoleId);
  if (Array.isArray(roles)) return roles.includes(adminRoleId);
  return false;
}

function setStatusProvider(provider) {
  statusProvider = typeof provider === 'function' ? provider : null;
}

async function handleCommand(interaction, db, settings) {
  const month = parseMonth(interaction.options.getString('month'));
  const days = Math.min(Math.max(interaction.options.getInteger('days') || 7, 1), 90);

  if (interaction.commandName === 'stats') {
    const where = month ? 'WHERE strftime("%Y-%m", date_bought) = ?' : '';
    const params = month ? [month] : [];
    const row = await dbGet(db, `
      SELECT COUNT(*) AS total_sales,
             COALESCE(SUM(amount), 0) AS total_amount,
             COALESCE(SUM(CASE WHEN status = 'Paid' THEN amount ELSE 0 END), 0) AS paid_amount,
             COALESCE(SUM(CASE WHEN status = 'Pending' THEN amount ELSE 0 END), 0) AS pending_amount
      FROM sales ${where}
    `, params);
    const label = month || 'All time';
    return sendCommandReply(
      interaction,
      `**Sales (${label})**\nTransactions: ${row.total_sales}\nTotal: ${money(row.total_amount)}\nPaid: ${money(row.paid_amount)}\nPending: ${money(row.pending_amount)}`
    );
  }

  if (interaction.commandName === 'revenue') {
    const where = month
      ? "WHERE status = 'Paid' AND strftime('%Y-%m', date_bought) = ?"
      : "WHERE status = 'Paid'";
    const rows = await dbAll(db, `
      SELECT payment_method, COALESCE(SUM(amount), 0) AS total
      FROM sales ${where}
      GROUP BY payment_method
      ORDER BY total DESC
    `, month ? [month] : []);
    const lines = rows.length
      ? rows.map((row) => `${safeText(row.payment_method, 80)}: ${money(row.total)}`).join('\n')
      : 'No paid sales found.';
    return sendCommandReply(interaction, `**Paid revenue (${month || 'All time'})**\n${lines}`);
  }

  if (interaction.commandName === 'expiring') {
    const today = toDateString(new Date());
    const end = new Date(`${today}T00:00:00`);
    end.setDate(end.getDate() + days);
    const endDate = toDateString(end);
    const rows = await dbAll(db, `
      SELECT customer_name, plan, date_expiry, amount, status
      FROM sales
      WHERE date_expiry BETWEEN ? AND ? AND COALESCE(no_renew, 0) = 0
      ORDER BY date_expiry ASC
      LIMIT 20
    `, [today, endDate]);
    const lines = rows.length
      ? rows.map((row) => `${safeText(row.customer_name, 80)} · ${safeText(row.plan, 80)} · ${row.date_expiry}`).join('\n')
      : `No subscriptions expire in the next ${days} day(s).`;
    return sendCommandReply(interaction, `**Expiring subscriptions**\n${lines}`);
  }

  if (interaction.commandName === 'plans') {
    const rows = await dbAll(db, 'SELECT name, cpu, ram, disk, amount FROM plans ORDER BY amount ASC LIMIT 20');
    const lines = rows.length
      ? rows.map((row) => `**${safeText(row.name, 100)}** · ${safeText(row.cpu, 40)} CPU · ${safeText(row.ram, 30)} RAM · ${safeText(row.disk, 30)} Disk · ${money(row.amount)}`).join('\n')
      : 'No plans are configured.';
    return sendCommandReply(interaction, `**Available plans**\n${lines}`);
  }

  if (interaction.commandName === 'customer') {
    const query = interaction.options.getString('name') || '';
    const report = await getCustomerReport(db, query);
    return sendEmbedReply(interaction, buildCustomerEmbed(report));
  }

  if (interaction.commandName === 'status') {
    const report = await getStatusReport(db);
    return sendEmbedReply(interaction, buildStatusEmbed(report));
  }

  return sendCommandReply(interaction, 'Unknown command.');
}

function getSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('View sales totals and payment status')
      .addStringOption((option) => option.setName('month').setDescription('Month in YYYY-MM format').setRequired(false)),
    new SlashCommandBuilder()
      .setName('revenue')
      .setDescription('View paid revenue grouped by payment method')
      .addStringOption((option) => option.setName('month').setDescription('Month in YYYY-MM format').setRequired(false)),
    new SlashCommandBuilder()
      .setName('expiring')
      .setDescription('List subscriptions expiring soon')
      .addIntegerOption((option) => option.setName('days').setDescription('Number of days to check').setMinValue(1).setMaxValue(90).setRequired(false)),
    new SlashCommandBuilder()
      .setName('plans')
      .setDescription('List the configured hosting plans'),
    new SlashCommandBuilder()
      .setName('customer')
      .setDescription('Look up a customer and their recent purchases')
      .addStringOption((option) => option
        .setName('name')
        .setDescription('Customer name (partial names work)')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(100)),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show bot, database, and backup health'),
  ].map((command) => command.toJSON());
}

async function startDiscordBot(db) {
  activeDatabase = db;

  if (activeClient) {
    const previousClient = activeClient;
    activeClient = null;
    try {
      previousClient.destroy();
    } catch (error) {
      console.warn('Could not cleanly stop the previous Discord client:', error.message);
    }
  }

  let settings;
  try {
    settings = await getDiscordSettings(db);
  } catch (error) {
    botStatus = { status: 'error', user: 'Unavailable', guild: '', error: error.message };
    throw error;
  }

  if (!settings.bot_token && settings.webhook_url) {
    botStatus = { status: 'online', user: 'Webhook notifications', guild: '', error: '' };
    return botStatus;
  }

  if (!settings.bot_token) {
    botStatus = { status: 'not_configured', user: 'Not configured', guild: '', error: '' };
    return botStatus;
  }

  botStatus = { status: 'connecting', user: 'Connecting…', guild: settings.guild_id || '', error: '' };
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  activeClient = client;

  client.once(Events.ClientReady, async (readyClient) => {
    botStatus = {
      status: 'online',
      user: readyClient.user.tag,
      guild: settings.guild_id || '',
      error: '',
    };

    // Guild commands update instantly; global commands are the fallback when
    // no server ID is configured (Discord may take up to an hour to propagate).
    try {
      const commands = getSlashCommands();
      if (settings.guild_id) {
        await readyClient.application.commands.set(commands, settings.guild_id);
      } else {
        await readyClient.application.commands.set(commands);
        botStatus.error = 'No server ID configured, so slash commands were registered globally and may take up to an hour to appear.';
      }
    } catch (error) {
      botStatus.error = `Connected, but slash command registration failed: ${error.message}`;
      console.error('Discord slash command registration failed:', error.message);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (ADMIN_ONLY_COMMANDS.has(interaction.commandName) && !isAdminInteraction(interaction, settings)) {
      await sendCommandReply(
        interaction,
        'You need the configured admin role or the **Manage Server** permission to use this command.'
      ).catch(() => {});
      return;
    }
    try {
      await handleCommand(interaction, activeDatabase, settings);
    } catch (error) {
      console.error('Discord command failed:', error.message);
      await sendCommandReply(interaction, 'The command failed. Check the sales app logs for details.').catch(() => {});
    }
  });

  client.on(Events.Error, (error) => {
    botStatus = { ...botStatus, status: 'error', error: error.message };
    console.error('Discord client error:', error.message);
  });

  try {
    await client.login(settings.bot_token);
  } catch (error) {
    botStatus = { status: 'error', user: 'Connection failed', guild: settings.guild_id || '', error: error.message };
    activeClient = null;
    client.destroy();
    throw error;
  }

  return botStatus;
}

async function notifyDiscord(db, type, sale) {
  const settings = await getDiscordSettings(db);
  if (type === 'sale' && !isEnabled(settings.notify_sales)) return false;
  if (type === 'renewal' && !isEnabled(settings.notify_renewals)) return false;
  if (!settings.webhook_url && (!settings.bot_token || !settings.channel_id)) return false;

  await sendEmbed(settings, buildSaleEmbed(type, sale));
  return true;
}

async function sendExpiryDigest(db) {
  const settings = await getDiscordSettings(db);
  if (!isEnabled(settings.notify_expiring)) return false;
  if (!settings.webhook_url && (!settings.bot_token || !settings.channel_id)) return false;

  const days = Math.min(Math.max(parseInt(settings.expiring_days, 10) || 7, 1), 90);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  const startDate = toDateString(start);
  const endDate = toDateString(end);
  const sales = await dbAll(db, `
    SELECT customer_name, plan, date_expiry, amount, status
    FROM sales
    WHERE date_expiry BETWEEN ? AND ? AND COALESCE(no_renew, 0) = 0
    ORDER BY date_expiry ASC
  `, [startDate, endDate]);

  await sendEmbed(settings, buildExpiryEmbed(sales, days));
  return true;
}

function getBotStatus() {
  return { ...botStatus };
}

function stopDiscordBot() {
  if (activeClient) {
    try {
      activeClient.destroy();
    } catch (error) {
      console.warn('Could not stop the Discord client cleanly:', error.message);
    }
    activeClient = null;
  }
  botStatus = { status: 'stopped', user: 'Stopped', guild: botStatus.guild || '', error: '' };
}

module.exports = {
  SETTING_KEYS,
  ADMIN_ONLY_COMMANDS,
  ensureSettingsTable,
  getDiscordSettings,
  setDiscordSetting,
  startDiscordBot,
  stopDiscordBot,
  notifyDiscord,
  sendExpiryDigest,
  getBotStatus,
  getSlashCommands,
  getCustomerReport,
  getStatusReport,
  isAdminInteraction,
  setStatusProvider,
};
