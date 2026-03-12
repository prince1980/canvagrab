const express = require('express');
const path = require('path');
const fs = require('fs');
const { firefox } = require('playwright');
const axios = require('axios');
const ffmpeg = require('ffmpeg-static');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

const downloadDir = path.join(__dirname, 'downloads');
const tempDir = path.join(__dirname, 'temp');
const publicDir = path.join(__dirname, 'public');
[downloadDir, tempDir, publicDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── SECURITY MIDDLEWARE ─────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Limit request body to 2KB (URLs don't need more)
app.use(express.json({ limit: '2kb' }));
app.use(express.static(publicDir));
app.use('/downloads', express.static(downloadDir));

// ── RATE LIMITING ───────────────────────────────────────────────────────────
// Simple in-memory: max 3 scrape jobs per IP per 10 minutes
const rateLimitMap = new Map(); // ip -> [timestamps]
function isRateLimited(ip) {
    const now = Date.now();
    const window = 10 * 60 * 1000; // 10 min
    const max = 3;
    const hits = (rateLimitMap.get(ip) || []).filter(t => now - t < window);
    if (hits.length >= max) return true;
    hits.push(now);
    rateLimitMap.set(ip, hits);
    return false;
}
// Purge old rate-limit entries every 10 min
setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [ip, hits] of rateLimitMap) {
        const fresh = hits.filter(t => t > cutoff);
        if (fresh.length === 0) rateLimitMap.delete(ip);
        else rateLimitMap.set(ip, fresh);
    }
}, 10 * 60 * 1000);

// ── AUTO-CLEANUP ─────────────────────────────────────────────────────────────
// Delete downloaded MP4s older than 30 min to prevent disk fill on VPS
function cleanupOldFiles() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    try {
        for (const f of fs.readdirSync(downloadDir)) {
            const fp = path.join(downloadDir, f);
            try {
                const stat = fs.statSync(fp);
                if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
            } catch (_) {}
        }
        // Also clean temp
        for (const f of fs.readdirSync(tempDir)) {
            const fp = path.join(tempDir, f);
            try {
                const stat = fs.statSync(fp);
                if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
            } catch (_) {}
        }
    } catch (_) {}
}
setInterval(cleanupOldFiles, 15 * 60 * 1000); // every 15 min

// ── JOB STORE ─────────────────────────────────────────────────────────────
const jobs = new Map();
const sseClients = new Map();

// Expire jobs from memory after 1 hour
setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of jobs) {
        if (job.createdAt < cutoff) jobs.delete(id);
    }
}, 30 * 60 * 1000);

function sendSSE(jobId, data) {
    const clients = sseClients.get(jobId) || [];
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(res => { try { res.write(msg); } catch (_) {} });
}

function updateJob(jobId, updates) {
    const job = jobs.get(jobId);
    if (!job) return;
    Object.assign(job, updates);
    sendSSE(jobId, { ...job, jobId });
}

// ── ROUTES ─────────────────────────────────────────────────────────────────
// SSE event stream
app.get('/api/events/:jobId', (req, res) => {
    const { jobId } = req.params;
    if (!/^job_\d+_[a-z0-9]+$/.test(jobId)) return res.status(400).end();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    if (!sseClients.has(jobId)) sseClients.set(jobId, []);
    sseClients.get(jobId).push(res);
    const job = jobs.get(jobId);
    if (job) res.write(`data: ${JSON.stringify({ ...job, jobId })}\n\n`);
    req.on('close', () => {
        const c = (sseClients.get(jobId) || []).filter(x => x !== res);
        sseClients.set(jobId, c);
    });
});

// Job status
app.get('/api/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ ...job, jobId: req.params.jobId });
});

// Download file — sanitized filename, explicit .mp4 extension
app.get('/api/download/:filename', (req, res) => {
    // Only allow safe filenames: alphanumeric, underscores, hyphens, dots
    const rawName = req.params.filename;
    if (!/^[\w\-. ]+$/.test(rawName)) return res.status(400).json({ error: 'Invalid filename' });
    const filename = path.basename(rawName); // prevent path traversal
    const filePath = path.join(downloadDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found or expired' });
    const dlName = filename.endsWith('.mp4') ? filename : filename + '.mp4';
    res.download(filePath, dlName);
});

// Start scrape job
app.post('/api/scrape', async (req, res) => {
    // Rate limiting
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
        return res.status(429).json({ error: 'Too many requests. Please wait 10 minutes before trying again.' });
    }

    const rawUrl = (req.body?.url || '').trim();

    // Sanitize: must be a valid http/https URL pointing to canva
    if (!rawUrl || rawUrl.length > 500) {
        return res.status(400).json({ error: 'Invalid URL.' });
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
    } catch {
        return res.status(400).json({ error: 'Please enter a valid http/https URL.' });
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(jobId, {
        status: 'queued', progress: 0, logs: [], videos: [],
        error: null, url: rawUrl, createdAt: Date.now()
    });

    res.json({ jobId });
    scrapeAndDownload(jobId, rawUrl);
});

// SEO redirect pages (static HTML served from /public subfolders)
// robots.txt and sitemap.xml are served as static files from /public

// ── HELPERS ─────────────────────────────────────────────────────────────────
function jobLog(jobId, message, type = 'info') {
    console.log(`[${jobId}] ${message}`);
    const job = jobs.get(jobId);
    if (!job) return;
    job.logs.push({ message, type, time: new Date().toISOString() });
    sendSSE(jobId, { ...job, jobId });
}

async function downloadFile(url, filePath) {
    const response = await axios({
        url, method: 'GET', responseType: 'stream', timeout: 60000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0' }
    });
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// ── SCRAPER ──────────────────────────────────────────────────────────────────
async function scrapeAndDownload(jobId, targetUrl) {
    let browser = null;
    try {
        updateJob(jobId, {
            status: 'scraping', progress: 5,
            logs: [{ message: `Starting scrape for: ${targetUrl}`, type: 'info', time: new Date().toISOString() }]
        });

        let pairs = [];
        let seenVideos = new Set();
        let seenAudios = new Set();

        browser = await firefox.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
        });
        const page = await context.newPage();

        page.on('response', async response => {
            try {
                const url = response.url();
                const type = response.request().resourceType();
                const ct = response.headers()['content-type'] || '';
                if ((url.includes('.mp4') || (type === 'media' && ct.includes('video'))) && !seenVideos.has(url)) {
                    seenVideos.add(url);
                    pairs.push({ video: url, audio: null });
                    jobLog(jobId, `Found video stream #${pairs.length}`, 'success');
                } else if ((url.includes('.m4a') || url.includes('.aac') || (type === 'media' && ct.includes('audio'))) && !seenAudios.has(url)) {
                    seenAudios.add(url);
                    const unpaired = pairs.find(p => p.audio === null);
                    if (unpaired) {
                        unpaired.audio = url;
                        jobLog(jobId, `Paired audio for video #${pairs.indexOf(unpaired) + 1}`, 'info');
                    }
                }
            } catch (_) {}
        });

        jobLog(jobId, 'Navigating to page...', 'info');
        updateJob(jobId, { progress: 10 });

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        updateJob(jobId, { progress: 20 });

        await page.waitForTimeout(1500);
        jobLog(jobId, 'Scrolling to trigger lazy-loaded videos...', 'info');

        const pageHeight = await page.evaluate(() => document.body.scrollHeight);
        const step = Math.ceil(pageHeight / 10);
        for (let i = 0; i < 10; i++) {
            await page.evaluate(s => window.scrollBy(0, s), step);
            await page.waitForTimeout(250);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(1000);

        await browser.close(); browser = null;

        updateJob(jobId, { progress: 30 });
        jobLog(jobId, `Found ${pairs.length} video(s).`, pairs.length > 0 ? 'success' : 'warning');

        if (pairs.length === 0) {
            updateJob(jobId, { status: 'done', progress: 100, error: 'No videos found on this page' });
            return;
        }

        updateJob(jobId, { status: 'downloading', progress: 35 });
        jobLog(jobId, `Downloading and processing ${pairs.length} video(s)...`, 'info');

        const progressPerVideo = 60 / pairs.length;
        const downloadedVideos = [];

        for (let i = 0; i < pairs.length; i++) {
            const p = pairs[i];
            const num = i + 1;
            const tempVideo = path.join(tempDir, `tmp_v_${jobId}_${num}.mp4`);
            const tempAudio = path.join(tempDir, `tmp_a_${jobId}_${num}.m4a`);
            const filename = `canvagrab_${jobId}_${num}.mp4`;
            const finalOutput = path.join(downloadDir, filename);

            jobLog(jobId, `Processing video ${num}/${pairs.length}...`, 'info');
            try {
                await downloadFile(p.video, tempVideo);
                if (p.audio) {
                    await downloadFile(p.audio, tempAudio);
                    execSync(`"${ffmpeg}" -y -v error -i "${tempVideo}" -i "${tempAudio}" -c copy "${finalOutput}"`, { timeout: 120000 });
                } else {
                    execSync(`"${ffmpeg}" -y -v error -i "${tempVideo}" -c copy "${finalOutput}"`, { timeout: 120000 });
                }
                const stats = fs.statSync(finalOutput);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                const sizeKB = (stats.size / 1024).toFixed(1);
                downloadedVideos.push({
                    filename, label: `Video ${num}`,
                    size: stats.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`,
                    url: `/downloads/${filename}`,
                    downloadUrl: `/api/download/${filename}`,
                    hasAudio: !!p.audio
                });
                jobLog(jobId, `✓ Saved: video ${num} (${stats.size > 1024 * 1024 ? sizeMB + ' MB' : sizeKB + ' KB'})`, 'success');
            } catch (e) {
                jobLog(jobId, `✗ Error on video ${num}: ${e.message}`, 'error');
            }
            try { if (fs.existsSync(tempVideo)) fs.unlinkSync(tempVideo); } catch (_) {}
            try { if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio); } catch (_) {}
            updateJob(jobId, { progress: Math.round(35 + (i + 1) * progressPerVideo), videos: [...downloadedVideos] });
        }

        updateJob(jobId, { status: 'done', progress: 100, videos: downloadedVideos });
        jobLog(jobId, `All done! ${downloadedVideos.length} video(s) ready. Files auto-delete in 30 minutes.`, 'success');

    } catch (err) {
        if (browser) try { await browser.close(); } catch (_) {}
        jobLog(jobId, `Fatal error: ${err.message}`, 'error');
        updateJob(jobId, { status: 'error', error: err.message });
    }
}

app.listen(PORT, () => console.log(`\n🚀 CanvaGrab running at http://localhost:${PORT}\n`));
