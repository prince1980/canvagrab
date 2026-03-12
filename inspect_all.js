const ffmpeg = require('ffmpeg-static');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dls = path.join(__dirname, 'downloads');
const files = fs.readdirSync(dls).filter(f => f.endsWith('.mp4'));

let videoFiles = [];
let audioFiles = [];

for (const f of files) {
    const p = path.join(dls, f);
    try {
        execSync(`"${ffmpeg}" -i "${p}"`, { stdio: 'pipe' });
    } catch (e) {
        const out = e.stderr.toString();
        if (out.includes('Video:')) videoFiles.push(f);
        if (out.includes('Audio:')) audioFiles.push(f);
    }
}

console.log(`Found ${videoFiles.length} video files.`);
console.log(`Found ${audioFiles.length} audio files.`);

if (audioFiles.length > 0) {
    console.log('Sample Audio file:', audioFiles[0]);
}
