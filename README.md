# ✉️ Bulk Email Campaign Local Web Dashboard

A lightweight, high-performance local web dashboard for sending bulk email campaigns via SMTP. Powered by **Node.js, Express, Nodemailer, Multer**, and **Server-Sent Events (SSE)** for real-time progress and logging.

---

## 📁 Project Structure

```
SMTP/
├── server.js               # Express web server & campaign queue engine
├── package.json            # Dependencies (express, nodemailer, multer, csv-parser, dotenv)
├── .env                    # Hostinger / custom SMTP configuration
├── uploads/                # Directory for CSV & attachment file uploads
├── public/
│   ├── index.html          # Split-screen dashboard HTML layout
│   ├── app.js              # Real-time frontend engine & SSE listener
│   └── style.css           # Dark glassmorphism styles & animations
└── campaign_report.csv     # Auto-generated CSV delivery report
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment (`.env`)
Set your Hostinger (or default) SMTP settings in `.env`:
```env
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=you@yourdomain.com
SMTP_PASS=your_email_password
FROM_NAME=Your Company
FROM_EMAIL=you@yourdomain.com
```

### 3. Launch Dashboard
```bash
npm start
# OR
node server.js
```

### 4. Open in Browser
Open [http://localhost:3000](http://localhost:3000) in your web browser.

---

## ✨ Features

- **Split-Screen HTML Editor & Live Preview**: Real-time iframe rendering as you edit code or insert placeholder tags (`{{name}}`, `{{firstname}}`, `{{email}}`, `{{date}}`, `{{year}}`).
- **Drag & Drop CSV Uploader**: Automatic syntax validation and duplicate filtering with instant contact count feedback.
- **Attachment Uploader**: Attach PDFs, images, or documents to outgoing emails via Multer.
- **Throttled Batch Engine**: Rate-limited queue with configurable batch sizes, inter-batch delays, and per-email jitter (500ms–1200ms) to protect your SMTP port.
- **Real-Time Live SSE Stream**: Progress bar (`Sent X / Total Y`) and scrolling color-coded delivery logs.
- **One-Click CSV Report Download**: Instantly export `campaign_report.csv` detailing timestamps, recipient emails, statuses (`SENT` / `FAILED`), and error reasons.
