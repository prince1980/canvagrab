const { firefox } = require('playwright');

(async () => {
    const browser = await firefox.launch();
    const page = await browser.newPage();
    
    let currentMp4 = null;
    let pairs = [];

    page.on('response', response => {
        const url = response.url();
        const type = response.request().resourceType();
        const ct = response.headers()['content-type'] || '';
        
        if (url.includes('.mp4') || type === 'media' && ct.includes('video')) {
            // New video fetched
            currentMp4 = url;
            pairs.push({ video: url, audio: null });
        } else if (url.includes('.m4a') || type === 'media' && ct.includes('audio')) {
            // Audio fetched, associate with the most recent video
            if (pairs.length > 0 && pairs[pairs.length - 1].audio === null) {
                pairs[pairs.length - 1].audio = url;
            } else {
                console.log('Got audio without recent unassigned video:', url);
            }
        }
    });

    await page.goto("https://bigmotionsportfolio.my.canva.site/", { waitUntil: 'load', timeout: 60000 });
    
    for (let i = 0; i < 20; i++) {
        await page.mouse.wheel(0, 1000);
        await page.waitForTimeout(500);
    }
    await page.waitForTimeout(5000);
    
    // De-dupe pairs
    const uniquePairs = [];
    const seenVideos = new Set();
    for (const p of pairs) {
        if (!seenVideos.has(p.video)) {
            seenVideos.add(p.video);
            uniquePairs.push(p);
        }
    }

    console.log(JSON.stringify(uniquePairs, null, 2));
    
    await browser.close();
})();
