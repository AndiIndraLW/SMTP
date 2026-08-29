/**
 * server.js — Express Web Server for Bulk Email Campaigns
 * ─────────────────────────────────────────────────────────────────
 * Local web app backend:
 *   • Express static file serving from public/
 *   • Multer handling for CSV uploads & file attachments
 *   • Server-Sent Events (SSE) stream for real-time progress & logs
 *   • Nodemailer transport with per-email jitter & batching
 *   • Automatic campaign report generation & CSV export
 * ─────────────────────────────────────────────────────────────────
 */

import 'dotenv/config'
import express from 'express'
import multer from 'multer'
import nodemailer from 'nodemailer'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const csvParser = require('csv-parser')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000

// ── Ensure folders exist ──────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads')
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

const REPORT_PATH = path.join(__dirname, 'campaign_report.csv')

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// ── Multer Storage Configuration ──────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9)
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`)
  },
})
const upload = multer({ storage })

// ── In-Memory Campaign State ──────────────────────────────────────
const campaignState = {
  status: 'idle', // 'idle' | 'running' | 'paused' | 'completed' | 'error'
  contacts: [],
  attachments: [], // [{ filename, path, originalname, mimetype }]
  config: {
    smtpHost: process.env.SMTP_HOST || 'smtp.hostinger.com',
    smtpPort: parseInt(process.env.SMTP_PORT) || 465,
    smtpSecure: process.env.SMTP_SECURE === 'true' || true,
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    fromName: process.env.FROM_NAME || 'Your Company',
    fromEmail: process.env.FROM_EMAIL || process.env.SMTP_USER || '',
    replyTo: process.env.REPLY_TO || '',
    subject: process.env.MAIL_SUBJECT || 'Hello {{firstname}}, here is your update!',
    batchSize: parseInt(process.env.BATCH_SIZE) || 100,
    batchDelayMin: parseInt(process.env.BATCH_DELAY_MINUTES) || 30,
    jitterMinMs: parseInt(process.env.JITTER_MIN_MS) || 500,
    jitterMaxMs: parseInt(process.env.JITTER_MAX_MS) || 1200,
  },
  htmlTemplate: fs.existsSync(path.join(__dirname, 'template.html'))
    ? fs.readFileSync(path.join(__dirname, 'template.html'), 'utf-8')
    : `<div style="font-family: sans-serif; padding: 20px;">
        <h2>Hello {{firstname}},</h2>
        <p>Thank you for being a valued client!</p>
       </div>`,
  csvStats: {
    validCount: 0,
    duplicateCount: 0,
    invalidCount: 0,
    duplicateItems: [],
    invalidItems: [],
  },
  sentCount: 0,
  failedCount: 0,
  currentIndex: 0,
  logs: [],
}

// ── SSE Clients Registry ──────────────────────────────────────────
let sseClients = []

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  sseClients.forEach((client) => client.write(payload))
}

function addLog(level, message, details = {}) {
  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
    level, // 'info' | 'success' | 'warn' | 'error'
    message,
    ...details,
  }
  campaignState.logs.push(entry)
  if (campaignState.logs.length > 500) campaignState.logs.shift()
  broadcast('log', entry)
}

function updateProgress() {
  broadcast('progress', {
    status: campaignState.status,
    sent: campaignState.sentCount,
    failed: campaignState.failedCount,
    total: campaignState.contacts.length,
    currentIndex: campaignState.currentIndex,
  })
}

// ── Utility Helpers ───────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const isValidEmail = (e) => EMAIL_RE.test((e || '').trim())
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getFirstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'there'
}

function renderContent(template, contact, subjectTemplate) {
  const now = new Date()
  const name = contact.name || 'Valued Client'
  const firstname = getFirstName(contact.name)

  const replacements = {
    name,
    firstname,
    email: contact.email,
    date: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    year: String(now.getFullYear()),
  }

  let html = template
  let subject = subjectTemplate

  Object.entries(replacements).forEach(([key, val]) => {
    const re = new RegExp(`\\{\\{${key}\\}\\}`, 'gi')
    html = html.replace(re, val)
    subject = subject.replace(re, val)
  })

  return { html, subject }
}

// ── Report CSV Helpers ────────────────────────────────────────────
function initReportCSV() {
  const header = 'Timestamp,Email,Name,Status,ErrorDetails\n'
  fs.writeFileSync(REPORT_PATH, header, 'utf-8')
}

function appendReportCSV(email, name, status, errorDetails = '') {
  const esc = (v) => {
    const s = String(v || '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }
  const row = [esc(new Date().toISOString()), esc(email), esc(name), esc(status), esc(errorDetails)].join(',') + '\n'
  fs.appendFileSync(REPORT_PATH, row, 'utf-8')
}

// ══════════════════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════════════════

// 1. Get Current Config & State
app.get('/api/state', (req, res) => {
  res.json({
    config: campaignState.config,
    htmlTemplate: campaignState.htmlTemplate,
    contactsCount: campaignState.contacts.length,
    csvStats: campaignState.csvStats,
    attachments: campaignState.attachments.map((a) => ({ name: a.originalname, size: a.size })),
    status: campaignState.status,
    sentCount: campaignState.sentCount,
    failedCount: campaignState.failedCount,
    logs: campaignState.logs.slice(-50),
  })
})

// 2. Save Config
app.post('/api/config', (req, res) => {
  Object.assign(campaignState.config, req.body)
  addLog('info', '⚙️ Configuration updated successfully.')
  res.json({ success: true, config: campaignState.config })
})

// 3. Upload CSV Contacts
app.post('/api/upload-csv', upload.single('csvFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded.' })

  const valid = []
  const duplicates = []
  const invalid = []
  const seen = new Set()

  fs.createReadStream(req.file.path)
    .pipe(
      csvParser({
        mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim().toLowerCase(),
      })
    )
    .on('data', (row) => {
      const email = (row.email || '').trim().toLowerCase()
      const name = (row.name || '').trim()

      if (!isValidEmail(email)) {
        invalid.push({ email: row.email || '(empty)', name, reason: 'Invalid email syntax' })
        return
      }
      if (seen.has(email)) {
        duplicates.push({ email, name, reason: 'Duplicate email' })
        return
      }
      seen.add(email)
      valid.push({ email, name: name || null })
    })
    .on('end', () => {
      // Clean up uploaded temp file
      fs.unlink(req.file.path, () => {})

      campaignState.contacts = valid
      campaignState.currentIndex = 0
      campaignState.sentCount = 0
      campaignState.failedCount = 0
      campaignState.csvStats = {
        validCount: valid.length,
        duplicateCount: duplicates.length,
        invalidCount: invalid.length,
        duplicateItems: duplicates,
        invalidItems: invalid,
      }

      addLog('info', `📂 Uploaded CSV: ${valid.length} valid contacts | ⚠️ ${duplicates.length} duplicates skipped | ❌ ${invalid.length} invalid emails skipped.`)
      updateProgress()

      res.json({
        success: true,
        validCount: valid.length,
        duplicateCount: duplicates.length,
        invalidCount: invalid.length,
        duplicateItems: duplicates,
        invalidItems: invalid,
      })
    })
    .on('error', (err) => {
      res.status(500).json({ error: `CSV Parse error: ${err.message}` })
    })
})

// 4. Upload File Attachments
app.post('/api/upload-attachments', upload.array('attachments', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No attachment files uploaded.' })
  }

  const newFiles = req.files.map((f) => ({
    filename: f.filename,
    originalname: f.originalname,
    path: f.path,
    size: f.size,
    mimetype: f.mimetype,
  }))

  campaignState.attachments.push(...newFiles)
  addLog('info', `📎 Attached ${newFiles.length} file(s): ${newFiles.map((f) => f.originalname).join(', ')}`)

  res.json({
    success: true,
    attachments: campaignState.attachments.map((a) => ({ name: a.originalname, size: a.size })),
  })
})

// Clear attachments
app.post('/api/clear-attachments', (req, res) => {
  campaignState.attachments.forEach((a) => fs.unlink(a.path, () => {}))
  campaignState.attachments = []
  addLog('info', '🗑️ Attachments cleared.')
  res.json({ success: true })
})

// 5. Preview Endpoint
app.post('/api/preview', (req, res) => {
  const { template, subject } = req.body
  if (template) campaignState.htmlTemplate = template
  if (subject) campaignState.config.subject = subject

  const sampleContact = campaignState.contacts[0] || {
    name: 'Alice Johnson',
    email: 'alice.johnson@example.com',
  }

  const rendered = renderContent(campaignState.htmlTemplate, sampleContact, campaignState.config.subject)

  res.json({
    html: rendered.html,
    subject: rendered.subject,
    sampleContact,
  })
})

// 6. SSE Real-Time Stream
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  sseClients.push(res)

  // Send initial state update
  res.write(
    `event: progress\ndata: ${JSON.stringify({
      status: campaignState.status,
      sent: campaignState.sentCount,
      failed: campaignState.failedCount,
      total: campaignState.contacts.length,
      currentIndex: campaignState.currentIndex,
    })}\n\n`
  )

  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res)
  })
})

// 7. Campaign Control: Start / Pause
app.post('/api/campaign/start', async (req, res) => {
  if (campaignState.contacts.length === 0) {
    return res.status(400).json({ error: 'Please upload a CSV contact list first.' })
  }

  if (campaignState.status === 'running') {
    return res.json({ message: 'Campaign is already running.' })
  }

  campaignState.status = 'running'
  updateProgress()
  addLog('info', '🚀 Campaign execution started.')

  res.json({ success: true, message: 'Campaign started.' })

  // Run sending queue asynchronously
  runSendingQueue()
})

app.post('/api/campaign/pause', (req, res) => {
  if (campaignState.status === 'running') {
    campaignState.status = 'paused'
    addLog('warn', '⏸️ Campaign execution paused by user.')
    updateProgress()
  }
  res.json({ success: true, status: campaignState.status })
})

// 8. Download CSV Report
app.get('/api/campaign/report', (req, res) => {
  if (!fs.existsSync(REPORT_PATH)) {
    initReportCSV()
  }
  res.download(REPORT_PATH, 'campaign_report.csv')
})

// ══════════════════════════════════════════════════════════════════
// QUEUE ENGINE
// ══════════════════════════════════════════════════════════════════
async function runSendingQueue() {
  const cfg = campaignState.config
  const contacts = campaignState.contacts
  const attachments = campaignState.attachments.map((a) => ({
    filename: a.originalname,
    path: a.path,
  }))

  if (!fs.existsSync(REPORT_PATH) || campaignState.currentIndex === 0) {
    initReportCSV()
  }

  // Create transporter
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: {
      user: cfg.smtpUser,
      pass: cfg.smtpPass,
    },
    pool: true,
    maxConnections: 5,
    socketTimeout: 30000,
  })

  // Verify SMTP connection
  try {
    addLog('info', `🔌 Verifying SMTP (${cfg.smtpHost}:${cfg.smtpPort})…`)
    await transporter.verify()
    addLog('success', '✅ SMTP connection verified successfully!')
  } catch (err) {
    addLog('error', `❌ SMTP connection failed: ${err.message}`)
    campaignState.status = 'error'
    updateProgress()
    transporter.close()
    return
  }

  let batchCount = 0

  while (campaignState.currentIndex < contacts.length) {
    if (campaignState.status !== 'running') {
      addLog('warn', `Campaign stopped/paused at contact ${campaignState.currentIndex} of ${contacts.length}.`)
      break
    }

    const contact = contacts[campaignState.currentIndex]
    const { html, subject } = renderContent(campaignState.htmlTemplate, contact, cfg.subject)
    const fromStr = `"${cfg.fromName}" <${cfg.fromEmail || cfg.smtpUser}>`

    try {
      await transporter.sendMail({
        from: fromStr,
        to: contact.name ? `"${contact.name}" <${contact.email}>` : contact.email,
        replyTo: cfg.replyTo || undefined,
        subject,
        html,
        attachments,
      })

      campaignState.sentCount++
      addLog('success', `SENT → ${contact.email}`, { email: contact.email })
      appendReportCSV(contact.email, contact.name || '', 'SENT')
    } catch (err) {
      campaignState.failedCount++
      addLog('error', `FAILED → ${contact.email}: ${err.message}`, { email: contact.email })
      appendReportCSV(contact.email, contact.name || '', 'FAILED', err.message)
    }

    campaignState.currentIndex++
    batchCount++
    updateProgress()

    // Per-email jitter (500ms - 1200ms default)
    const jitter = cfg.jitterMinMs + Math.random() * (cfg.jitterMaxMs - cfg.jitterMinMs)
    await delay(jitter)

    // Check Batch Limit
    if (batchCount >= cfg.batchSize && campaignState.currentIndex < contacts.length) {
      batchCount = 0
      const delayMs = cfg.batchDelayMin * 60 * 1000
      if (delayMs > 0) {
        addLog('info', `⏸️ Batch size (${cfg.batchSize}) reached. Pausing ${cfg.batchDelayMin} minutes…`)
        let waited = 0
        const interval = 1000
        while (waited < delayMs && campaignState.status === 'running') {
          await delay(interval)
          waited += interval
        }
      }
    }
  }

  transporter.close()

  if (campaignState.currentIndex >= contacts.length) {
    campaignState.status = 'completed'
    addLog('success', `🎉 Campaign Complete! Total Sent: ${campaignState.sentCount}, Failed: ${campaignState.failedCount}`)
    updateProgress()
  }
}

// ── Start Server ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║               ✉️  BULK EMAIL CAMPAIGN DASHBOARD               ║
║                                                              ║
║   Local Dashboard Running: http://localhost:${PORT}             ║
╚══════════════════════════════════════════════════════════════╝
`)
})
