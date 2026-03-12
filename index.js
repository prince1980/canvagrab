const { firefox } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const { execSync } = require('child_process');

const downloadDir = path.join(__dirname, 'downloads');
const tempDir = path.join(__dirname, 'temp');

if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

const cleanDir = (dir) => {
    if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
            fs.unlinkSync(path.join(dir, file));
        }
    }
};

const downloadFile = async (url, filePath) => {
    try {
        const response = await axios({ url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (error) {
        console.error(`Failed to download ${url}:`, error.message);
        throw error;
    }
};

const scrapeVideos = async (targetUrl) => {
    console.log(`Starting scraper for ${targetUrl}`);
    cleanDir(downloadDir);
    cleanDir(tempDir);
    
    let pairs = [];
    let seenVideos = new Set();
    
    const browser = await firefox.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('response', response => {
        const url = response.url();
        const type = response.request().resourceType();
        const ct = response.headers()['content-type'] || '';
        
        if (url.includes('.mp4') || (type === 'media' && ct.includes('video'))) {
            if (!seenVideos.has(url)) {
                seenVideos.add(url);
                pairs.push({ video: url, audio: null });
            }
        } else if (url.includes('.m4a') || url.includes('.aac') || (type === 'media' && ct.includes('audio'))) {
            if (pairs.length > 0 && pairs[pairs.length - 1].audio === null) {
                pairs[pairs.length - 1].audio = url;
            }
        }
    });

    console.log('Navigating to page...');
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 60000 });

    console.log('Scrolling page to trigger lazy loaded videos...');
    for (let i = 0; i < 20; i++) {
        await page.mouse.wheel(0, 1000);
        await page.waitForTimeout(500);
    }
    await page.waitForTimeout(5000);

    await browser.close();

    console.log(`Found ${pairs.length} video streams.`);
    
    if (pairs.length === 0) {
        console.log('No videos found.');
        return;
    }

    let count = 1;
    for (const p of pairs) {
        console.log(`Processing video ${count}/${pairs.length}...`);
        
        const tempVideo = path.join(tempDir, `v_${count}.mp4`);
        const tempAudio = path.join(tempDir, `a_${count}.m4a`);
        const finalOutput = path.join(downloadDir, `video_${count}.mp4`);

        try {
            await downloadFile(p.video, tempVideo);
            
            if (p.audio) {
                await downloadFile(p.audio, tempAudio);
                // Mux audio and video together, fixes duration data
                execSync(`"${ffmpeg}" -v error -i "${tempVideo}" -i "${tempAudio}" -c copy "${finalOutput}"`);
            } else {
                // Just remux to fix duration data (DASH to standard MP4 wrapper)
                execSync(`"${ffmpeg}" -v error -i "${tempVideo}" -c copy "${finalOutput}"`);
            }
            console.log(`-> Saved: video_${count}.mp4`);
        } catch (e) {
            console.error(`-> Error processing video_${count}.mp4:`, e.message);
        }
        
        // Clean up temp files
        if (fs.existsSync(tempVideo)) fs.unlinkSync(tempVideo);
        if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);

        count++;
    }
    
    console.log('Finished downloading all videos!');
};

const targetUrl = process.argv[2];

if (!targetUrl) {
    console.error('Please provide a Canva site URL.');
    console.log('Usage: node index.js <url>');
    process.exit(1);
}

scrapeVideos(targetUrl);
