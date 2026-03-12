const { firefox } = require('playwright');

(async () => {
    const browser = await firefox.launch();
    const page = await browser.newPage();
    
    await page.goto("https://bigmotionsportfolio.my.canva.site/", { waitUntil: 'load', timeout: 60000 });
    
    // scroll whole page
    for (let i = 0; i < 20; i++) {
        await page.mouse.wheel(0, 1000);
        await page.waitForTimeout(500);
    }
    await page.waitForTimeout(5000);
    
    const mediaNodes = await page.evaluate(() => {
        const result = [];
        document.querySelectorAll('video, audio').forEach(el => {
            const sources = Array.from(el.querySelectorAll('source')).map(s => s.src);
            result.push({
                tag: el.tagName,
                src: el.src,
                sources: sources
            });
        });
        return result;
    });

    console.log(JSON.stringify(mediaNodes, null, 2));

    await browser.close();
})();
