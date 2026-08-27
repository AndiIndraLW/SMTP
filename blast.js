#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                   blast.js  v1.0.0                           ║
 * ║     Production Email Campaign CLI for Node.js (ESM)          ║
 * ║                                                              ║
 * ║  Commands:                                                   ║
 * ║    node blast.js --preview   Dry-run: no emails sent         ║
 * ║    node blast.js             Live send (auto-resumes)        ║
 * ║    node blast.js --reset     Clear progress & send fresh     ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ══════════════════════════════════════════════════════════════════
// §1  IMPORTS
// ══════════════════════════════════════════════════════════════════

import 'dotenv/config'
import fs                        from 'fs'
import path                      from 'path'
import { fileURLToPath }         from 'url'
import { createRequire }         from 'module'
import nodemailer                from 'nodemailer'

// csv-parser is CommonJS — bridge it into this ESM module
const require    = createRequire(import.meta.url)
const csvParser  = require('csv-parser')

const __dirname  = path.dirname(fileURLToPath(import.meta.url))


// ══════════════════════════════════════════════════════════════════
// §2  CLI FLAGS
// ══════════════════════════════════════════════════════════════════

const ARGS       = process.argv.slice(2)
const IS_PREVIEW = ARGS.includes('--preview') || ARGS.includes('--dry-run')
const IS_RESET   = ARGS.includes('--reset')


// ══════════════════════════════════════════════════════════════════
// §3  CONFIGURATION
//     All values come from .env — never hard-coded.
//     Required fields are validated at startup.
// ══════════════════════════════════════════════════════════════════

/**
 * Parse a positive integer from env, fall back to `def` if missing/invalid.
 * @param {string} key
 * @param {number} def  Default value
 */
function envInt(key, def) {
  const v = parseInt(process.env[key])
  return Number.isFinite(v) && v >= 0 ? v : def
}

const CFG = Object.freeze({
  // ── SMTP transport ──────────────────────────────────────────────
  smtp: {
    host:   process.env.SMTP_HOST,
    port:   envInt('SMTP_PORT', 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    pool:           true,   // reuse TCP connections across a batch
    maxConnections: 5,
    socketTimeout:  30_000, // 30 s per socket operation
  },

  // ── Sender identity ─────────────────────────────────────────────
  from: `"${process.env.FROM_NAME  || 'Sender'}" <${
                process.env.FROM_EMAIL || process.env.SMTP_USER}>`,

  // ── Email content ───────────────────────────────────────────────
  subject:      process.env.MAIL_SUBJECT  || 'Hello {{firstname}}!',
  templatePath: path.resolve(__dirname, process.env.TEMPLATE_PATH || './template.html'),

  // ── Contact list ────────────────────────────────────────────────
  csvPath:      path.resolve(__dirname, process.env.CSV_PATH       || './contacts.csv'),

  // ── Batch / rate-limiting ───────────────────────────────────────
  batchSize:      envInt('BATCH_SIZE',          100),
  batchDelayMs:   envInt('BATCH_DELAY_MINUTES',  30) * 60_000,

  // ── Per-email jitter ────────────────────────────────────────────
  jitterMinMs:    envInt('JITTER_MIN_MS',   500),
  jitterMaxMs:    envInt('JITTER_MAX_MS',  1200),

  // ── Retry logic ─────────────────────────────────────────────────
  maxRetries:     envInt('MAX_RETRIES',       3),
  retryBaseMs:    envInt('RETRY_BASE_MS',  2000),

  // ── Output files ────────────────────────────────────────────────
  progressPath: path.resolve(__dirname, process.env.PROGRESS_PATH || './progress.json'),
  reportPath:   path.resolve(__dirname, process.env.REPORT_PATH   || './campaign_report.csv'),
  previewPath:  path.resolve(__dirname, process.env.PREVIEW_PATH  || './preview.html'),
  previewCount: envInt('PREVIEW_COUNT', 3),
})

// ── Validate required SMTP fields at boot ────────────────────────
function validateConfig() {
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter(k => !process.env[k])
  if (missing.length > 0 && !IS_PREVIEW) {
    // Preview mode doesn't need live SMTP creds
    throw new Error(
      `Missing required .env variable(s): ${missing.join(', ')}\n` +
      `  Copy .env.example → .env and fill in your credentials.`
    )
  }
}


// ══════════════════════════════════════════════════════════════════
// §4  UTILITY HELPERS
// ══════════════════════════════════════════════════════════════════

/** Email validation regex — covers 99.9 % of real-world addresses */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const isValidEmail  = (e) => EMAIL_RE.test((e || '').trim())
const normalizeEmail= (e) => e.trim().toLowerCase()

/** Non-blocking async delay */
const delay = (ms) => new Promise(r => setTimeout(r, ms))

/** Random jitter between jitterMinMs and jitterMaxMs */
const jitter = () =>
  delay(CFG.jitterMinMs + Math.random() * (CFG.jitterMaxMs - CFG.jitterMinMs))

/** ISO timestamp for log lines */
const ts = () =>
  new Date().toISOString().replace('T', ' ').slice(0, 19)

/** Percentage string, e.g. " 42%" — right-aligned in 4 chars */
const pct = (done, total) =>
  total > 0 ? String(Math.round(done / total * 100)).padStart(3) + '%' : '  0%'

/** Split array into chunks of at most `size` elements */
const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Escape a value for CSV (RFC 4180) */
const csvEsc = (v) => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s
}

/** Escape for HTML attribute (preview page) */
const htmlEsc  = (s) => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
const attrEsc  = (s) => s.replace(/"/g, '&quot;')

/** Extract first word as first name */
const firstName = (name) =>
  (name || '').trim().split(/\s+/)[0] || null


// ══════════════════════════════════════════════════════════════════
// §5  STATE MANAGER  (progress.json)
//
//     Maintains the set of emails successfully sent.
//     Written to disk after EVERY successful send so a crash
//     in the middle of a batch never loses progress.
// ══════════════════════════════════════════════════════════════════

/**
 * Load resumption state from progress.json.
 * @returns {{ sentEmails: Set<string>, startedAt: string|null }}
 */
function loadState() {
  if (!fs.existsSync(CFG.progressPath)) {
    return { sentEmails: new Set(), startedAt: null }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CFG.progressPath, 'utf-8'))
    return {
      sentEmails: new Set(Array.isArray(raw.sentEmails) ? raw.sentEmails : []),
      startedAt:  raw.startedAt || null,
    }
  } catch {
    console.warn('  ⚠️  Could not parse progress.json — starting fresh.')
    return { sentEmails: new Set(), startedAt: null }
  }
}

/**
 * Persist current state to progress.json.
 * Called after every successful email send.
 * @param {{ sentEmails: Set<string>, startedAt: string|null }} state
 */
function saveState(state) {
  const payload = {
    startedAt:  state.startedAt || new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
    sentCount:  state.sentEmails.size,
    sentEmails: [...state.sentEmails],  // Set → Array for JSON
  }
  fs.writeFileSync(CFG.progressPath, JSON.stringify(payload, null, 2), 'utf-8')
}

/** Delete progress.json to allow a clean restart */
function clearState() {
  if (fs.existsSync(CFG.progressPath)) {
    fs.unlinkSync(CFG.progressPath)
    console.log('🗑️  progress.json cleared — starting fresh.\n')
  } else {
    console.log('ℹ️  No progress.json found — nothing to clear.\n')
  }
}


// ══════════════════════════════════════════════════════════════════
// §6  CSV PARSER  (streaming, validation, deduplication)
//
//     • Normalises header names (case-insensitive, trims whitespace)
//     • Strips Excel BOM characters from header row
//     • Validates email format via regex
//     • Deduplicates by normalised email address
//     • Returns separate valid / rejected arrays for reporting
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {{ email: string, name: string|null }} Contact
 * @typedef {{ email: string, reason: string }}   RejectedRow
 */

/**
 * Stream-parse a CSV file and return categorised contacts.
 *
 * @param {string} filePath
 * @returns {Promise<{ valid: Contact[], rejected: RejectedRow[] }>}
 */
function parseContacts(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`CSV file not found: ${filePath}`))
    }

    /** @type {Contact[]} */    const valid    = []
    /** @type {RejectedRow[]} */const rejected = []
    const seen = new Set()         // deduplication guard (normalised emails)

    fs.createReadStream(filePath)
      .pipe(
        csvParser({
          // Strip BOM + whitespace from headers (common Excel export issue)
          mapHeaders: ({ header }) =>
            header.replace(/^\uFEFF/, '').trim().toLowerCase(),
        })
      )
      .on('data', (row) => {
        const rawEmail = (row.email || '').trim()
        const name     = (row.name  || '').trim() || null
        const email    = normalizeEmail(rawEmail)

        // ── Validation ──────────────────────────────────────────
        if (!isValidEmail(email)) {
          rejected.push({ email: rawEmail || '(empty)', reason: 'Invalid email format' })
          return
        }

        // ── Deduplication ────────────────────────────────────────
        if (seen.has(email)) {
          rejected.push({ email, reason: 'Duplicate — skipped' })
          return
        }

        seen.add(email)
        valid.push({ email, name })
      })
      .on('end',   () => resolve({ valid, rejected }))
      .on('error', (err) => reject(new Error(`CSV read error: ${err.message}`)))
  })
}


// ══════════════════════════════════════════════════════════════════
// §7  TEMPLATE ENGINE
//
//     Supported placeholders:
//       {{name}}        Full name  (or "Valued Client" fallback)
//       {{firstname}}   First word of name  (or "there" fallback)
//       {{email}}       Recipient email
//       {{subject}}     Rendered subject line
//       {{date}}        Human-readable date (e.g. "August 27, 2026")
//       {{year}}        4-digit year
//
//     Unknown placeholders are left intact.
// ══════════════════════════════════════════════════════════════════

let _templateCache = null

/** Load template.html from disk (cached after first call). */
function loadTemplate() {
  if (_templateCache !== null) return _templateCache
  if (!fs.existsSync(CFG.templatePath)) {
    throw new Error(`Template not found: ${CFG.templatePath}`)
  }
  _templateCache = fs.readFileSync(CFG.templatePath, 'utf-8')
  return _templateCache
}

/**
 * Render the personalised subject line for a contact.
 * @param {Contact} contact
 * @returns {string}
 */
function renderSubject(contact) {
  const fn   = firstName(contact.name) || 'there'
  const full = contact.name || 'Valued Client'
  return CFG.subject
    .replace(/{{firstname}}/gi, fn)
    .replace(/{{name}}/gi,      full)
    .replace(/{{email}}/gi,     contact.email)
}

/**
 * Render the full HTML email body for a contact.
 * @param {Contact} contact
 * @returns {string}
 */
function renderEmail(contact) {
  const raw  = loadTemplate()
  const now  = new Date()
  const fn   = firstName(contact.name) || 'there'
  const full = contact.name || 'Valued Client'

  const values = {
    name:      full,
    firstname: fn,
    email:     contact.email,
    subject:   renderSubject(contact),
    date:      now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    year:      String(now.getFullYear()),
  }

  // Replace {{placeholder}} (case-insensitive); leave unknown ones intact
  return raw.replace(/\{\{(\w+)\}\}/gi, (match, key) => {
    const k = key.toLowerCase()
    return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : match
  })
}


// ══════════════════════════════════════════════════════════════════
// §8  CAMPAIGN REPORTER  (campaign_report.csv)
//
//     Appended after every send attempt — never only at the end.
//     This way a crash still yields a usable partial report.
// ══════════════════════════════════════════════════════════════════

const REPORT_HEADER = 'Timestamp,Email,Name,Status,ErrorDetails\n'

/** Ensure the report CSV exists with its header row. */
function initReport() {
  if (!fs.existsSync(CFG.reportPath)) {
    fs.writeFileSync(CFG.reportPath, REPORT_HEADER, 'utf-8')
  }
}

/**
 * Append one row to the campaign report.
 * @param {{ email: string, name: string|null, status: 'SENT'|'FAILED', errorMsg?: string }} entry
 */
function appendReport({ email, name, status, errorMsg = '' }) {
  const row =
    [
      csvEsc(new Date().toISOString()),
      csvEsc(email),
      csvEsc(name || ''),
      csvEsc(status),
      csvEsc(errorMsg),
    ].join(',') + '\n'
  fs.appendFileSync(CFG.reportPath, row, 'utf-8')
}


// ══════════════════════════════════════════════════════════════════
// §9  MAILER  (Nodemailer transport + exponential-backoff retry)
//
//     Retry schedule (with RETRY_BASE_MS = 2000):
//       Attempt 1 → immediate
//       Attempt 2 → wait 2 s
//       Attempt 3 → wait 4 s
//       … up to MAX_RETRIES
// ══════════════════════════════════════════════════════════════════

let _transport = null

/** Get (or lazily create) the shared Nodemailer transport. */
function getTransport() {
  if (_transport) return _transport
  _transport = nodemailer.createTransport(CFG.smtp)
  return _transport
}

/**
 * Attempt to send an email to one contact, retrying on transient failures.
 *
 * @param {Contact} contact
 * @returns {Promise<{ success: boolean, attempts: number, error?: Error }>}
 */
async function sendWithRetry(contact) {
  const transport = getTransport()
  const html      = renderEmail(contact)
  const subject   = renderSubject(contact)

  let lastError = null

  for (let attempt = 1; attempt <= CFG.maxRetries; attempt++) {
    try {
      await transport.sendMail({
        from:    CFG.from,
        to:      contact.name
                   ? `"${contact.name}" <${contact.email}>`
                   : contact.email,
        subject,
        html,
      })
      return { success: true, attempts: attempt }
    } catch (err) {
      lastError = err
      const isLast = attempt === CFG.maxRetries
      if (!isLast) {
        const backoffMs = CFG.retryBaseMs * Math.pow(2, attempt - 1)
        console.warn(
          `     ⚠  [${contact.email}] attempt ${attempt}/${CFG.maxRetries} failed` +
          ` — ${err.message} (retry in ${backoffMs / 1000}s)`
        )
        await delay(backoffMs)
      }
    }
  }

  return { success: false, attempts: CFG.maxRetries, error: lastError }
}


// ══════════════════════════════════════════════════════════════════
// §10  PREVIEW MODE  (dry run — no SMTP calls)
//
//      Writes a dark-themed preview.html with iframe-rendered emails
//      and prints a full campaign summary to stdout.
// ══════════════════════════════════════════════════════════════════

/**
 * Execute preview/dry-run mode.
 *
 * @param {Contact[]}    pending   Contacts that would be sent
 * @param {RejectedRow[]}rejected  Contacts that were rejected
 */
function runPreview(pending, rejected) {
  const batchCount    = Math.ceil(pending.length / CFG.batchSize)
  const pauseMinTotal = Math.max(0, batchCount - 1) * (CFG.batchDelayMs / 60_000)
  const previewN      = Math.min(CFG.previewCount, pending.length)
  const dupCount      = rejected.filter(r => r.reason.startsWith('Duplicate')).length
  const badCount      = rejected.filter(r => r.reason.startsWith('Invalid')).length

  // ── Console summary ──────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════╗')
  console.log('║          📬  BLAST.JS  —  DRY RUN SUMMARY                ║')
  console.log('╚══════════════════════════════════════════════════════════╝\n')

  console.log('  📊  Contact Statistics')
  console.log(`      Total rows in CSV   : ${pending.length + rejected.length}`)
  console.log(`      ✅  Will be sent     : ${pending.length}`)
  console.log(`      ❌  Rejected total   : ${rejected.length}`)
  if (dupCount) console.log(`          ↳ Duplicates   : ${dupCount}`)
  if (badCount) console.log(`          ↳ Bad format   : ${badCount}`)

  console.log('\n  📦  Batch Plan')
  console.log(`      Batch size          : ${CFG.batchSize} emails/batch`)
  console.log(`      Total batches       : ${batchCount}`)
  console.log(`      Delay between       : ${CFG.batchDelayMs / 60_000} min`)
  console.log(`      Total pause time    : ${pauseMinTotal} min`)
  console.log(`      Jitter per email    : ${CFG.jitterMinMs}–${CFG.jitterMaxMs} ms`)
  console.log(`      Max retries         : ${CFG.maxRetries}`)

  console.log('\n  ⚙️   Config')
  console.log(`      SMTP                : ${CFG.smtp.host}:${CFG.smtp.port} (${CFG.smtp.secure ? 'TLS' : 'STARTTLS'})`)
  console.log(`      From                : ${CFG.from}`)
  console.log(`      Subject             : ${CFG.subject}`)
  console.log(`      Template            : ${CFG.templatePath}`)
  console.log(`      Progress file       : ${CFG.progressPath}`)
  console.log(`      Report file         : ${CFG.reportPath}`)

  if (pending.length === 0) {
    console.log('\n  🚫  No contacts to preview.\n')
    return
  }

  // ── Render preview ────────────────────────────────────────────
  console.log(`\n  🔍  Rendering ${previewN} preview email(s)…\n`)

  const previewContacts = pending.slice(0, previewN)
  const sections = previewContacts.map((contact, idx) => {
    const html    = renderEmail(contact)
    const subject = renderSubject(contact)
    const fn      = firstName(contact.name) || 'there'

    console.log(`      [${idx + 1}/${previewN}]  ${contact.email}`)
    console.log(`             Name      : ${contact.name || '(none → "Valued Client" / "there")'}`)
    console.log(`             Firstname : ${fn}`)
    console.log(`             Subject   : ${subject}`)
    console.log(`             HTML size : ${html.length} chars\n`)

    return buildPreviewSection({ contact, html, subject, num: idx + 1, total: previewN })
  })

  fs.writeFileSync(CFG.previewPath, buildPreviewPage(sections, {
    total:   pending.length,
    rejected: rejected.length,
    batches: batchCount,
    delay:   CFG.batchDelayMs / 60_000,
  }), 'utf-8')

  console.log(`  ✅  Preview written → ${CFG.previewPath}`)
  console.log('      Open it in your browser to inspect the rendered emails.')
  console.log('\n  ▶   To send for real:  node blast.js\n')
}

// ── Preview HTML builders ─────────────────────────────────────────

function buildPreviewSection({ contact, html, subject, num, total }) {
  return /* html */`
    <!-- ═══ Preview ${num} / ${total} ═══ -->
    <div class="card">
      <div class="card-header">
        <span class="badge">Preview ${num} / ${total}</span>
        <div class="meta">
          <span><strong>To:</strong> ${htmlEsc(contact.name || 'Valued Client')} &lt;${htmlEsc(contact.email)}&gt;</span>
          <span><strong>Subject:</strong> ${htmlEsc(subject)}</span>
        </div>
      </div>
      <iframe srcdoc="${attrEsc(html)}" title="Preview ${num}" sandbox="allow-same-origin"></iframe>
    </div>`
}

function buildPreviewPage(sections, stats) {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>blast.js — Campaign Preview</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #080c14; color: #e2e8f0; min-height: 100vh; padding: 2rem;
    }
    h1 { font-size: 1.9rem; font-weight: 800; text-align: center; margin-bottom: .4rem;
         background: linear-gradient(135deg, #667eea, #764ba2);
         -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .sub { text-align: center; color: #64748b; font-size: .875rem; margin-bottom: 2.5rem; }
    .dry { display: inline-block; background: #fbbf24; color: #1c1917;
           font-size: .7rem; font-weight: 700; padding: .2rem .75rem;
           border-radius: 99px; text-transform: uppercase; letter-spacing: .08em;
           vertical-align: middle; margin-left: .5rem; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
             gap: 1rem; max-width: 860px; margin: 0 auto 2.5rem; }
    .stat { background: #1a2235; border: 1px solid #2d3748; border-radius: 12px;
            padding: 1.1rem; text-align: center; }
    .stat .v { font-size: 2.1rem; font-weight: 800; color: #a78bfa; }
    .stat .l { font-size: .72rem; color: #64748b; text-transform: uppercase;
               letter-spacing: .06em; margin-top: .3rem; }
    .card { background: #1a2235; border: 1px solid #2d3748; border-radius: 16px;
            overflow: hidden; max-width: 860px; margin: 0 auto 2rem;
            box-shadow: 0 8px 32px rgba(0,0,0,.4); }
    .card-header { background: #111827; border-bottom: 1px solid #2d3748;
                   padding: 1rem 1.25rem; display: flex; align-items: flex-start;
                   gap: 1rem; flex-wrap: wrap; }
    .badge { background: linear-gradient(135deg, #667eea, #764ba2); color: #fff;
             font-size: .75rem; font-weight: 600; padding: .25rem .8rem;
             border-radius: 99px; white-space: nowrap; flex-shrink: 0; align-self: center; }
    .meta { font-size: .85rem; color: #cbd5e1; display: flex; flex-direction: column; gap: .2rem; }
    .meta strong { color: #a78bfa; }
    iframe { width: 100%; height: 580px; border: none; display: block; background: #fff; }
  </style>
</head>
<body>
  <h1>Campaign Preview <span class="dry">Dry Run</span></h1>
  <p class="sub">Generated ${new Date().toLocaleString()} — no emails were sent</p>

  <div class="stats">
    <div class="stat"><div class="v">${stats.total}</div><div class="l">Will Send</div></div>
    <div class="stat"><div class="v">${stats.rejected}</div><div class="l">Rejected</div></div>
    <div class="stat"><div class="v">${stats.batches}</div><div class="l">Batches</div></div>
    <div class="stat"><div class="v">${stats.delay}m</div><div class="l">Batch Delay</div></div>
  </div>

  ${sections.join('\n')}
</body>
</html>`
}


// ══════════════════════════════════════════════════════════════════
// §11  BATCH SCHEDULER  (live send orchestration)
//
//      Flow per batch:
//        for each contact in batch:
//          1. sendWithRetry()
//          2. Update state (sentEmails) + write progress.json
//          3. Append row to campaign_report.csv
//          4. Log result with timestamp + percentage
//          5. Wait jitter ms  ←  avoids SMTP port hammering
//        end for
//        if not last batch: wait batchDelayMs (non-blocking)
// ══════════════════════════════════════════════════════════════════

/**
 * Run the full live email campaign.
 *
 * @param {Contact[]}                             contacts  Pre-filtered, ready-to-send list
 * @param {{ sentEmails: Set<string>, startedAt: string|null }} state  Mutable state object
 */
async function runCampaign(contacts, state) {
  const transport = getTransport()

  // ── SMTP preflight check ─────────────────────────────────────
  process.stdout.write(`🔌  Verifying SMTP (${CFG.smtp.host}:${CFG.smtp.port})… `)
  await transport.verify()
  console.log('OK ✅\n')

  initReport()

  const total       = contacts.length
  const batches     = chunk(contacts, CFG.batchSize)
  const nBatches    = batches.length
  let   totalSent   = 0
  let   totalFailed = 0
  const t0          = Date.now()

  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  🚀  Campaign starting`)
  console.log(`  📧  Contacts to send   : ${total}`)
  console.log(`  📦  Batches            : ${nBatches} × up to ${CFG.batchSize}`)
  console.log(`  ⏱️   Batch delay        : ${CFG.batchDelayMs / 60_000} min`)
  console.log(`  ⚡  Jitter             : ${CFG.jitterMinMs}–${CFG.jitterMaxMs} ms`)
  console.log(`  🔁  Max retries        : ${CFG.maxRetries}`)
  console.log('═══════════════════════════════════════════════════════════\n')

  for (let bi = 0; bi < nBatches; bi++) {
    const batch    = batches[bi]
    const batchNum = bi + 1
    let   batchOk  = 0
    let   batchFail= 0

    console.log(`─── Batch ${batchNum}/${nBatches}  (${batch.length} emails) ${'─'.repeat(33)}`)

    for (const contact of batch) {
      // How many have we fully processed (success + failure) so far?
      const processed = totalSent + totalFailed

      const { success, attempts, error } = await sendWithRetry(contact)
      const progress = pct(processed + 1, total)

      if (success) {
        totalSent++
        batchOk++

        // ── Persist progress after every success ──────────────
        state.sentEmails.add(contact.email)
        if (!state.startedAt) state.startedAt = new Date().toISOString()
        saveState(state)

        appendReport({ email: contact.email, name: contact.name, status: 'SENT' })

        console.log(
          `  [${ts()}] [${progress}]  ✅  ${contact.email.padEnd(36)}` +
          ` (attempt ${attempts})`
        )
      } else {
        totalFailed++
        batchFail++

        appendReport({ email: contact.email, name: contact.name, status: 'FAILED', errorMsg: error?.message })

        console.error(
          `  [${ts()}] [${progress}]  ❌  ${contact.email.padEnd(36)}` +
          ` FAILED — ${error?.message}`
        )
      }

      // ── Per-email jitter (avoids SMTP port hammering) ─────
      await jitter()
    }

    console.log(
      `\n  Batch ${batchNum} complete — ✅ ${batchOk} sent, ❌ ${batchFail} failed\n`
    )

    // ── Inter-batch pause (skip after the last batch) ─────────
    if (bi < nBatches - 1 && CFG.batchDelayMs > 0) {
      const mins = CFG.batchDelayMs / 60_000
      console.log(`  ⏸️   Pausing ${mins} min before batch ${batchNum + 1}…`)
      await delay(CFG.batchDelayMs)
      console.log()
    }
  }

  // ── Close transport pool ────────────────────────────────────
  transport.close()

  const elapsed = Math.round((Date.now() - t0) / 1000)

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log(`  🏁  Campaign complete in ${elapsed}s`)
  console.log(`  ✅  Total sent         : ${totalSent}`)
  console.log(`  ❌  Total failed       : ${totalFailed}`)
  console.log(`  📋  Audit report       : ${CFG.reportPath}`)
  console.log(`  📌  Progress file      : ${CFG.progressPath}`)
  console.log('═══════════════════════════════════════════════════════════\n')
}


// ══════════════════════════════════════════════════════════════════
// §12  GRACEFUL SHUTDOWN  (Ctrl+C mid-campaign)
//
//      On SIGINT, the progress.json is already up-to-date
//      (written after every successful send) so a restart will
//      automatically resume from where we left off.
// ══════════════════════════════════════════════════════════════════

process.on('SIGINT', () => {
  console.log('\n\n  🛑  Interrupted — progress saved. Re-run to resume.\n')
  process.exit(0)
})


// ══════════════════════════════════════════════════════════════════
// §13  MAIN ENTRY POINT
// ══════════════════════════════════════════════════════════════════

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗')
  console.log('║         ✉️   BLAST.JS  —  Email Campaign Engine           ║')
  console.log(`║         Mode: ${IS_PREVIEW ? 'PREVIEW (dry run)              ' : IS_RESET ? 'LIVE SEND  (reset + fresh start)' : 'LIVE SEND  (auto-resume)        '}║`)
  console.log('╚══════════════════════════════════════════════════════════╝\n')

  // Validate config (skip SMTP check in preview mode)
  validateConfig()

  // ── Reset ─────────────────────────────────────────────────────
  if (IS_RESET) clearState()

  // ── Load resumption state ─────────────────────────────────────
  const state = loadState()
  if (state.sentEmails.size > 0) {
    console.log(`📌  Found progress.json — ${state.sentEmails.size} contact(s) already sent (will skip)\n`)
  }

  // ── Parse contacts ────────────────────────────────────────────
  console.log(`📂  Parsing contacts: ${CFG.csvPath}`)
  const { valid, rejected } = await parseContacts(CFG.csvPath)
  console.log(`    ${valid.length} valid  |  ${rejected.length} rejected`)

  if (rejected.length > 0) {
    const dups = rejected.filter(r => r.reason.startsWith('Duplicate'))
    const bads = rejected.filter(r => r.reason.startsWith('Invalid'))
    if (bads.length) console.log(`    ↳ Bad format  : ${bads.length}`)
    if (dups.length) console.log(`    ↳ Duplicates  : ${dups.length}`)
  }

  // ── Apply resumability filter ─────────────────────────────────
  const pending      = valid.filter(c => !state.sentEmails.has(c.email))
  const alreadySent  = valid.length - pending.length

  if (alreadySent > 0) {
    console.log(`\n⏭️   Skipping ${alreadySent} already-sent contact(s)`)
  }

  console.log(`\n  → ${pending.length} contact(s) queued for this run\n`)

  // ── Nothing to do ─────────────────────────────────────────────
  if (pending.length === 0) {
    console.log('✅  All contacts already sent. Campaign is complete.\n')
    console.log(`    Delete ${CFG.progressPath} (or run --reset) to start a new campaign.\n`)
    return
  }

  // ── Dispatch ──────────────────────────────────────────────────
  if (IS_PREVIEW) {
    runPreview(pending, rejected)
  } else {
    await runCampaign(pending, state)
  }
}

main().catch((err) => {
  console.error(`\n🔴  Fatal error: ${err.message}\n`)
  if (process.env.NODE_ENV === 'development') console.error(err.stack)
  process.exit(1)
})
