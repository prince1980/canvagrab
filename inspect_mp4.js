const ffmpeg = require('ffmpeg-static');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const sampleFile = path.join(__dirname, 'downloads', '0e933cf5648feee0302c4259a5f65335.mp4');

try {
    execSync(`"${ffmpeg}" -i "${sampleFile}"`);
} catch (e) {
    fs.writeFileSync('ffmpeg_output.txt', e.stderr.toString());
}
