/**
 * public/app.js — Frontend Application Engine
 * ─────────────────────────────────────────────────────────────────
 * Handles:
 *   • Real-time split-screen HTML editor & iframe preview sync
 *   • SSE (Server-Sent Events) live log stream & progress bar
 *   • Drag-and-Drop CSV & Attachment uploaders
 *   • Tab navigation, configuration persistence & report export
 * ─────────────────────────────────────────────────────────────────
 */

document.addEventListener('DOMContentLoaded', () => {
  // ── DOM Element References ──────────────────────────────────────
  const tabBtns = document.querySelectorAll('.tab-btn')
  const tabPanes = document.querySelectorAll('.tab-pane')

  const statusBadge = document.getElementById('statusBadge')
  const statusText = document.getElementById('statusText')

  // Config Inputs
  const smtpHost = document.getElementById('smtpHost')
  const smtpPort = document.getElementById('smtpPort')
  const smtpUser = document.getElementById('smtpUser')
  const smtpPass = document.getElementById('smtpPass')
  const smtpSecure = document.getElementById('smtpSecure')
  const fromName = document.getElementById('fromName')
  const fromEmail = document.getElementById('fromEmail')
  const replyTo = document.getElementById('replyTo')
  const batchSize = document.getElementById('batchSize')
  const batchDelayMin = document.getElementById('batchDelayMin')
  const jitterMinMs = document.getElementById('jitterMinMs')
  const jitterMaxMs = document.getElementById('jitterMaxMs')
  const saveConfigBtn = document.getElementById('saveConfigBtn')

  // CSV & Attachment Elements
  const csvDropZone = document.getElementById('csvDropZone')
  const csvFileInput = document.getElementById('csvFileInput')
  const browseCsvBtn = document.getElementById('browseCsvBtn')
  const csvStats = document.getElementById('csvStats')
  const validCount = document.getElementById('validCount')
  const rejectedCount = document.getElementById('rejectedCount')

  const attachmentDropZone = document.getElementById('attachmentDropZone')
  const attachmentInput = document.getElementById('attachmentInput')
  const browseAttachmentBtn = document.getElementById('browseAttachmentBtn')
  const attachmentList = document.getElementById('attachmentList')
  const clearAttachmentsBtn = document.getElementById('clearAttachmentsBtn')

  // Editor & Preview Elements
  const mailSubject = document.getElementById('mailSubject')
  const htmlEditor = document.getElementById('htmlEditor')
  const previewIframe = document.getElementById('previewIframe')
  const sampleTag = document.getElementById('sampleTag')
  const tagChips = document.querySelectorAll('.chip')

  // Progress & Execution Elements
  const progressText = document.getElementById('progressText')
  const progressPct = document.getElementById('progressPct')
  const progressBarFill = document.getElementById('progressBarFill')
  const startBtn = document.getElementById('startBtn')
  const pauseBtn = document.getElementById('pauseBtn')
  const reportBtn = document.getElementById('reportBtn')

  const terminalLog = document.getElementById('terminalLog')
  const clearLogsBtn = document.getElementById('clearLogsBtn')

  // ── Tab Switching ───────────────────────────────────────────────
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.remove('active'))
      tabPanes.forEach((p) => p.classList.remove('active'))
      btn.classList.add('active')
      const targetPane = document.getElementById(`tab-${btn.dataset.tab}`)
      if (targetPane) targetPane.classList.add('active')
    })
  })

  // ── Initial State Load ──────────────────────────────────────────
  fetch('/api/state')
    .then((res) => res.json())
    .then((data) => {
      const cfg = data.config || {}
      smtpHost.value = cfg.smtpHost || ''
      smtpPort.value = cfg.smtpPort || 465
      smtpUser.value = cfg.smtpUser || ''
      smtpPass.value = cfg.smtpPass || ''
      smtpSecure.checked = cfg.smtpSecure !== false
      fromName.value = cfg.fromName || ''
      fromEmail.value = cfg.fromEmail || ''
      replyTo.value = cfg.replyTo || ''
      batchSize.value = cfg.batchSize || 100
      batchDelayMin.value = cfg.batchDelayMin || 30
      jitterMinMs.value = cfg.jitterMinMs || 500
      jitterMaxMs.value = cfg.jitterMaxMs || 1200

      mailSubject.value = cfg.subject || ''
      htmlEditor.value = data.htmlTemplate || ''

      if (data.contactsCount > 0) {
        csvStats.style.display = 'flex'
        validCount.textContent = data.contactsCount
      }

      if (data.attachments && data.attachments.length > 0) {
        renderAttachments(data.attachments)
      }

      updateStatus(data.status || 'idle')
      updatePreview()
    })
    .catch((err) => console.error('Failed to load state:', err))

  // ── Save Configuration ──────────────────────────────────────────
  saveConfigBtn.addEventListener('click', () => {
    const configData = {
      smtpHost: smtpHost.value.trim(),
      smtpPort: parseInt(smtpPort.value) || 465,
      smtpUser: smtpUser.value.trim(),
      smtpPass: smtpPass.value.trim(),
      smtpSecure: smtpSecure.checked,
      fromName: fromName.value.trim(),
      fromEmail: fromEmail.value.trim(),
      replyTo: replyTo.value.trim(),
      subject: mailSubject.value.trim(),
      batchSize: parseInt(batchSize.value) || 100,
      batchDelayMin: parseInt(batchDelayMin.value) || 30,
      jitterMinMs: parseInt(jitterMinMs.value) || 500,
      jitterMaxMs: parseInt(jitterMaxMs.value) || 1200,
    }

    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configData),
    })
      .then((res) => res.json())
      .then(() => {
        saveConfigBtn.textContent = '✅ Saved!'
        setTimeout(() => (saveConfigBtn.textContent = '💾 Save Settings'), 2000)
      })
  })

  // ── CSV Upload Handlers ─────────────────────────────────────────
  browseCsvBtn.addEventListener('click', () => csvFileInput.click())
  csvFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleCsvUpload(e.target.files[0])
  })

  setupDropZone(csvDropZone, (files) => {
    if (files.length > 0 && files[0].name.endsWith('.csv')) {
      handleCsvUpload(files[0])
    }
  })

  function handleCsvUpload(file) {
    const formData = new FormData()
    formData.append('csvFile', file)

    fetch('/api/upload-csv', { method: 'POST', body: formData })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) return alert(data.error)
        csvStats.style.display = 'flex'
        validCount.textContent = data.validCount
        rejectedCount.textContent = data.rejectedCount
        updatePreview()
      })
      .catch((err) => alert(`Upload failed: ${err.message}`))
  }

  // ── Attachment Upload Handlers ──────────────────────────────────
  browseAttachmentBtn.addEventListener('click', () => attachmentInput.click())
  attachmentInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleAttachmentUpload(e.target.files)
  })

  setupDropZone(attachmentDropZone, (files) => {
    if (files.length > 0) handleAttachmentUpload(files)
  })

  function handleAttachmentUpload(files) {
    const formData = new FormData()
    Array.from(files).forEach((f) => formData.append('attachments', f))

    fetch('/api/upload-attachments', { method: 'POST', body: formData })
      .then((res) => res.json())
      .then((data) => {
        if (data.attachments) renderAttachments(data.attachments)
      })
  }

  clearAttachmentsBtn.addEventListener('click', () => {
    fetch('/api/clear-attachments', { method: 'POST' }).then(() => {
      attachmentList.innerHTML = ''
      clearAttachmentsBtn.style.display = 'none'
    })
  })

  function renderAttachments(list) {
    attachmentList.innerHTML = list
      .map(
        (a) => `
      <li class="file-item">
        <span>📎 ${a.name} (${Math.round(a.size / 1024)} KB)</span>
      </li>`
      )
      .join('')
    clearAttachmentsBtn.style.display = list.length > 0 ? 'inline-block' : 'none'
  }

  // ── Drag & Drop Helper ──────────────────────────────────────────
  function setupDropZone(elem, onDrop) {
    ;['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) => {
      elem.addEventListener(evt, (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
    })
    ;['dragenter', 'dragover'].forEach((evt) => {
      elem.addEventListener(evt, () => elem.classList.add('dragover'))
    })
    ;['dragleave', 'drop'].forEach((evt) => {
      elem.addEventListener(evt, () => elem.classList.remove('dragover'))
    })
    elem.addEventListener('drop', (e) => onDrop(e.dataTransfer.files))
  }

  // ── Real-Time Editor & Live Preview ────────────────────────────
  let previewTimer = null
  function updatePreview() {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => {
      fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: htmlEditor.value,
          subject: mailSubject.value,
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          previewIframe.srcdoc = data.html
          if (data.sampleContact) {
            sampleTag.textContent = `Sample: ${data.sampleContact.name || 'Valued Client'} <${data.sampleContact.email}>`
          }
        })
    }, 250) // 250ms debounced
  }

  htmlEditor.addEventListener('input', updatePreview)
  mailSubject.addEventListener('input', updatePreview)

  // Tag Chips Insert Handler
  tagChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag
      insertAtCursor(htmlEditor, tag)
      updatePreview()
    })
  })

  function insertAtCursor(field, text) {
    if (document.selection) {
      field.focus()
      const sel = document.selection.createRange()
      sel.text = text
    } else if (field.selectionStart || field.selectionStart === 0) {
      const startPos = field.selectionStart
      const endPos = field.selectionEnd
      field.value = field.value.substring(0, startPos) + text + field.value.substring(endPos, field.value.length)
      field.selectionStart = startPos + text.length
      field.selectionEnd = startPos + text.length
    } else {
      field.value += text
    }
  }

  // ── Server-Sent Events (SSE) Stream Listener ───────────────────
  const sse = new EventSource('/api/stream')

  sse.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data)
    updateProgressUI(data)
  })

  sse.addEventListener('log', (e) => {
    const data = JSON.parse(e.data)
    appendLog(data)
  })

  function updateStatus(status) {
    statusBadge.className = `status-pill status-${status}`
    statusText.textContent = status.charAt(0).toUpperCase() + status.slice(1)

    const isRunning = status === 'running'
    startBtn.disabled = isRunning
    pauseBtn.disabled = !isRunning
  }

  function updateProgressUI(data) {
    updateStatus(data.status)
    const processed = data.sent + data.failed
    const total = data.total || 0
    const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0

    progressText.textContent = `Sent: ${data.sent} / Total: ${total} (Failed: ${data.failed})`
    progressPct.textContent = `${pct}%`
    progressBarFill.style.width = `${pct}%`
  }

  function appendLog(log) {
    const line = document.createElement('div')
    line.className = `log-line ${log.level}`
    line.innerHTML = `<span class="time">[${log.timestamp}]</span> ${escapeHtml(log.message)}`
    terminalLog.appendChild(line)
    terminalLog.scrollTop = terminalLog.scrollHeight
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  clearLogsBtn.addEventListener('click', () => (terminalLog.innerHTML = ''))

  // ── Action Buttons ──────────────────────────────────────────────
  startBtn.addEventListener('click', () => {
    fetch('/api/campaign/start', { method: 'POST' })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) alert(data.error)
      })
  })

  pauseBtn.addEventListener('click', () => {
    fetch('/api/campaign/pause', { method: 'POST' })
  })

  reportBtn.addEventListener('click', () => {
    window.location.href = '/api/campaign/report'
  })
})
