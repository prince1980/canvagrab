const { firefox } = require('playwright');

(async () => {
    const browser = await firefox.launch();
    const page = await browser.newPage();
    
    page.on('request', request => {
        const url = request.url();
        if (url.includes('.mp4') || url.includes('.m3u8') || url.includes('.mpd') || url.includes('audio') || request.resourceType() === 'media') {
            console.log(`[${request.resourceType()}] ${url}`);
        }
    });

    await page.goto("https://bigmotionsportfolio.my.canva.site/", { waitUntil: 'load', timeout: 60000 });
    
    for (let i = 0; i < 20; i++) {
        await page.mouse.wheel(0, 1000);
        await page.waitForTimeout(500);
    }
    await page.waitForTimeout(5000);
    
    await browser.close();
})();
