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
  const duplicateCount = document.getElementById('duplicateCount')
  const invalidCount = document.getElementById('invalidCount')
  const csvBreakdown = document.getElementById('csvBreakdown')
  const duplicateListContainer = document.getElementById('duplicateListContainer')
  const invalidListContainer = document.getElementById('invalidListContainer')
  const dupCountLabel = document.getElementById('dupCountLabel')
  const invCountLabel = document.getElementById('invCountLabel')
  const duplicateList = document.getElementById('duplicateList')
  const invalidList = document.getElementById('invalidList')

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
      if (btn.dataset.tab === 'sent') {
        loadSentEmails()
      }
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

      if (data.csvStats) {
        renderCsvBreakdown(data.csvStats)
      } else if (data.contactsCount > 0) {
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
        renderCsvBreakdown(data)
        updatePreview()
      })
      .catch((err) => alert(`Upload failed: ${err.message}`))
  }

  function renderCsvBreakdown(stats) {
    if (!stats) return
    csvStats.style.display = 'flex'
    validCount.textContent = stats.validCount || 0
    duplicateCount.textContent = stats.duplicateCount || 0
    invalidCount.textContent = stats.invalidCount || 0

    const duplicates = stats.duplicateItems || []
    const invalid = stats.invalidItems || []

    if (duplicates.length > 0 || invalid.length > 0) {
      csvBreakdown.style.display = 'flex'
    } else {
      csvBreakdown.style.display = 'none'
    }

    if (duplicates.length > 0) {
      duplicateListContainer.style.display = 'block'
      dupCountLabel.textContent = duplicates.length
      duplicateList.innerHTML = duplicates
        .map((item) => `<li><span>${item.email}</span> <span class="text-warning">Duplicate</span></li>`)
        .join('')
    } else {
      duplicateListContainer.style.display = 'none'
    }

    if (invalid.length > 0) {
      invalidListContainer.style.display = 'block'
      invCountLabel.textContent = invalid.length
      invalidList.innerHTML = invalid
        .map((item) => `<li><span>${item.email}</span> <span class="text-danger">Invalid Syntax</span></li>`)
        .join('')
    } else {
      invalidListContainer.style.display = 'none'
    }
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

  sse.addEventListener('email_sent', (e) => {
    // Live update sent table if currently visible or active
    loadSentEmails()
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

  // ── Email Sent Tab Engine ───────────────────────────────────────
  const sentStatTotal = document.getElementById('sentStatTotal')
  const sentStatSuccess = document.getElementById('sentStatSuccess')
  const sentStatFailed = document.getElementById('sentStatFailed')
  const sentStatRate = document.getElementById('sentStatRate')

  const filterYear = document.getElementById('filterYear')
  const filterMonth = document.getElementById('filterMonth')
  const filterDay = document.getElementById('filterDay')
  const filterSearch = document.getElementById('filterSearch')
  const filterTodayBtn = document.getElementById('filterTodayBtn')
  const resetFiltersBtn = document.getElementById('resetFiltersBtn')
  const clearHistoryBtn = document.getElementById('clearHistoryBtn')
  const sentTableBody = document.getElementById('sentTableBody')

  let isTodayFilterActive = false

  function loadSentEmails() {
    if (!sentTableBody) return

    const search = (filterSearch.value || '').trim()
    const params = new URLSearchParams()

    if (isTodayFilterActive) {
      params.append('today', 'true')
    } else {
      params.append('year', filterYear.value || 'all')
      params.append('month', filterMonth.value || 'all')
      params.append('day', filterDay.value || 'all')
    }
    if (search) params.append('search', search)

    fetch(`/api/sent-emails?${params.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        updateSentStats(data.stats)
        updateFilterDropdowns(data.availableFilters)
        renderSentTable(data.emails)
      })
      .catch((err) => console.error('Error fetching sent emails:', err))
  }

  function updateSentStats(stats = {}) {
    if (!sentStatTotal) return
    sentStatTotal.textContent = stats.totalCount || 0
    sentStatSuccess.textContent = stats.sentCount || 0
    sentStatFailed.textContent = stats.failedCount || 0
    sentStatRate.textContent = `${stats.successRate || 0}%`
  }

  function updateFilterDropdowns(filters = {}) {
    if (!filterYear || !filterDay) return

    // Update Year Options
    const currentYearVal = filterYear.value
    filterYear.innerHTML = '<option value="all">All Years</option>'
    ;(filters.years || []).forEach((y) => {
      const opt = document.createElement('option')
      opt.value = y
      opt.textContent = y
      if (String(y) === currentYearVal) opt.selected = true
      filterYear.appendChild(opt)
    })

    // Update Day Options
    const currentDayVal = filterDay.value
    filterDay.innerHTML = '<option value="all">All Days</option>'
    ;(filters.days || []).forEach((d) => {
      const opt = document.createElement('option')
      opt.value = d
      opt.textContent = `Day ${d}`
      if (String(d) === currentDayVal) opt.selected = true
      filterDay.appendChild(opt)
    })
  }

  // Map cache for sent email detail lookup
  let currentSentEmailsMap = new Map()

  // Modal DOM References
  const emailDetailModal = document.getElementById('emailDetailModal')
  const closeModalBtn = document.getElementById('closeModalBtn')
  const modalSubject = document.getElementById('modalSubject')
  const modalStatusBadge = document.getElementById('modalStatusBadge')
  const modalDate = document.getElementById('modalDate')
  const modalRecipient = document.getElementById('modalRecipient')
  const modalRecipientName = document.getElementById('modalRecipientName')
  const modalAttachmentsSection = document.getElementById('modalAttachmentsSection')
  const modalAttachmentsList = document.getElementById('modalAttachmentsList')
  const modalErrorSection = document.getElementById('modalErrorSection')
  const modalErrorMsg = document.getElementById('modalErrorMsg')
  const modalBodyIframe = document.getElementById('modalBodyIframe')

  function renderSentTable(emails = []) {
    if (!sentTableBody) return

    currentSentEmailsMap.clear()

    if (emails.length === 0) {
      sentTableBody.innerHTML = `<tr><td colspan="5" class="empty-row">No sent emails recorded for this filter.</td></tr>`
      return
    }

    sentTableBody.innerHTML = emails
      .map((item) => {
        currentSentEmailsMap.set(item.id, item)
        const isSent = item.status === 'SENT'
        const badgeClass = isSent ? 'badge-sent' : 'badge-failed'
        const dateStr = item.timestamp
          ? new Date(item.timestamp).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
          : `${item.year}-${item.month}-${item.day} ${item.time || ''}`

        return `
        <tr data-id="${item.id}" title="Click to view full email details">
          <td><span class="${badgeClass}">${item.status}</span></td>
          <td><strong>${escapeHtml(item.email)}</strong></td>
          <td>${escapeHtml(item.name || '-')}</td>
          <td>${escapeHtml(item.subject || '-')}</td>
          <td style="color: var(--text-dim); font-size: 11px;">${escapeHtml(dateStr)}</td>
        </tr>
      `
      })
      .join('')
  }

  // Row click event delegator to open detail modal
  if (sentTableBody) {
    sentTableBody.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-id]')
      if (!row) return
      const emailId = row.dataset.id
      const item = currentSentEmailsMap.get(emailId)
      if (item) {
        openEmailDetailModal(item)
      }
    })
  }

  function openEmailDetailModal(item) {
    if (!emailDetailModal) return

    const isSent = item.status === 'SENT'
    modalStatusBadge.className = isSent ? 'badge-sent' : 'badge-failed'
    modalStatusBadge.textContent = item.status

    modalSubject.textContent = item.subject || '(No Subject)'

    const dateStr = item.timestamp
      ? new Date(item.timestamp).toLocaleString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : `${item.year}-${item.month}-${item.day} ${item.time || ''}`
    modalDate.textContent = `Sent at ${dateStr}`

    modalRecipient.textContent = item.email || '-'
    modalRecipientName.textContent = item.name || '-'

    // Attachments section
    if (item.attachments && item.attachments.length > 0) {
      modalAttachmentsSection.style.display = 'block'
      modalAttachmentsList.innerHTML = item.attachments
        .map(
          (a) => `<span class="attachment-chip">📄 ${escapeHtml(a.filename || a.originalname || 'attachment')}</span>`
        )
        .join('')
    } else {
      modalAttachmentsSection.style.display = 'none'
      modalAttachmentsList.innerHTML = ''
    }

    // Error details section
    if (!isSent && item.errorDetails) {
      modalErrorSection.style.display = 'block'
      modalErrorMsg.textContent = item.errorDetails
    } else {
      modalErrorSection.style.display = 'none'
      modalErrorMsg.textContent = ''
    }

    // HTML Body frame
    const bodyHtml =
      item.html ||
      `<div style="font-family: sans-serif; padding: 20px; color: #666;">No HTML content recorded for this email.</div>`
    modalBodyIframe.srcdoc = bodyHtml

    // Show native dialog modal
    emailDetailModal.showModal()
  }

  // Modal Close Handlers
  if (closeModalBtn && emailDetailModal) {
    closeModalBtn.addEventListener('click', () => emailDetailModal.close())
  }

  if (emailDetailModal) {
    // Backdrop click dismiss
    emailDetailModal.addEventListener('click', (e) => {
      const rect = emailDetailModal.getBoundingClientRect()
      const isInDialog =
        rect.top <= e.clientY &&
        e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX &&
        e.clientX <= rect.left + rect.width
      if (!isInDialog) {
        emailDetailModal.close()
      }
    })
  }

  function updateTodayBtnUI() {
    if (!filterTodayBtn) return
    if (isTodayFilterActive) {
      filterTodayBtn.classList.remove('btn-secondary')
      filterTodayBtn.classList.add('btn-primary')
      filterTodayBtn.textContent = '📅 Today (Active)'
    } else {
      filterTodayBtn.classList.remove('btn-primary')
      filterTodayBtn.classList.add('btn-secondary')
      filterTodayBtn.textContent = '📅 Today'
    }
  }

  // Filter Event Listeners
  if (filterYear) {
    filterYear.addEventListener('change', () => {
      isTodayFilterActive = false
      updateTodayBtnUI()
      loadSentEmails()
    })
  }
  if (filterMonth) {
    filterMonth.addEventListener('change', () => {
      isTodayFilterActive = false
      updateTodayBtnUI()
      loadSentEmails()
    })
  }
  if (filterDay) {
    filterDay.addEventListener('change', () => {
      isTodayFilterActive = false
      updateTodayBtnUI()
      loadSentEmails()
    })
  }
  if (filterSearch) {
    let searchTimeout
    filterSearch.addEventListener('input', () => {
      clearTimeout(searchTimeout)
      searchTimeout = setTimeout(loadSentEmails, 250)
    })
  }

  if (filterTodayBtn) {
    filterTodayBtn.addEventListener('click', () => {
      isTodayFilterActive = !isTodayFilterActive
      updateTodayBtnUI()
      loadSentEmails()
    })
  }

  if (resetFiltersBtn) {
    resetFiltersBtn.addEventListener('click', () => {
      isTodayFilterActive = false
      filterYear.value = 'all'
      filterMonth.value = 'all'
      filterDay.value = 'all'
      filterSearch.value = ''
      updateTodayBtnUI()
      loadSentEmails()
    })
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all sent email logs?')) {
        fetch('/api/sent-emails/clear', { method: 'POST' })
          .then((res) => res.json())
          .then(() => loadSentEmails())
      }
    })
  }
})

