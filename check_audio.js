const { firefox } = require('playwright');

(async () => {
    const browser = await firefox.launch();
    const page = await browser.newPage();
    
    page.on('response', response => {
        const url = response.url();
        const type = response.request().resourceType();
        const ct = response.headers()['content-type'] || '';
        
        if (url.includes('.mp4') || url.includes('.m4a') || url.includes('audio') || type === 'media' || ct.includes('audio')) {
            console.log(`[${type}] [${ct}] ${url}`);
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
