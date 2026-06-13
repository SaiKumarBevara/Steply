const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const extensionPath = path.resolve(__dirname, 'dist');
  console.log('Loading extension from:', extensionPath);

  const browser = await puppeteer.launch({
    headless: false, // UI needed for extension
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=800,600'
    ]
  });

  // Find extension ID
  let extensionId;
  for (let i = 0; i < 10; i++) {
    const targets = await browser.targets();
    for (const target of targets) {
      if (target.type() === 'service_worker' || target.type() === 'background_page') {
        const url = target.url();
        if (url.startsWith('chrome-extension://')) {
          extensionId = url.split('/')[2];
          console.log('Found extension ID:', extensionId);
          break;
        }
      }
    }
    if (extensionId) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!extensionId) {
    console.error('Could not find extension ID');
    await browser.close();
    return;
  }

  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  // 1. Open a test page
  await page.goto('https://example.com', { waitUntil: 'networkidle0' });
  console.log('Navigated to example.com');

  // 2. Open extension popup and start recording
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const popupPage = await browser.newPage();
  await popupPage.goto(popupUrl);
  console.log('Opened popup');

  // Wait for the Start Recording button and click it
  await popupPage.waitForSelector('#recordBtn', { visible: true });
  await popupPage.click('#recordBtn');
  console.log('Clicked Start Recording');
  
  // Wait a moment for recording to start
  await new Promise(r => setTimeout(r, 1000));
  
  // 3. Go back to test page and click around
  await page.bringToFront();
  
  // Click on the H1
  const h1 = await page.$('h1');
  const h1Box = await h1.boundingBox();
  await page.mouse.click(h1Box.x + h1Box.width / 2, h1Box.y + h1Box.height / 2);
  console.log('Clicked H1 element');
  
  // Wait for dedupe timer + processing time
  await new Promise(r => setTimeout(r, 1500));
  
  // Click on the paragraph
  const p = await page.$('p');
  const pBox = await p.boundingBox();
  await page.mouse.click(pBox.x + pBox.width / 2, pBox.y + pBox.height / 2);
  console.log('Clicked paragraph');

  await new Promise(r => setTimeout(r, 2000));

  // 4. Check extension database
  const backgroundWorker = await browser.waitForTarget(
    t => t.type() === 'service_worker' && t.url().includes(extensionId)
  );
  
  const worker = await backgroundWorker.worker();
  
  const dbData = await worker.evaluate(async () => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('GuideCapture');
      req.onsuccess = (e) => {
        const db = e.target.result;
        try {
          const tx = db.transaction(['guides', 'steps', 'screenshots'], 'readonly');
          const guidesStore = tx.objectStore('guides');
          const stepsStore = tx.objectStore('steps');
          const ssStore = tx.objectStore('screenshots');
          
          let result = { guides: [], steps: [], screenshots: [] };
          
          guidesStore.getAll().onsuccess = (e1) => {
            result.guides = e1.target.result;
            stepsStore.getAll().onsuccess = (e2) => {
              result.steps = e2.target.result;
              ssStore.getAll().onsuccess = async (e3) => {
                const ssRecords = e3.target.result || [];
                const parsedSS = [];
                for (const rec of ssRecords) {
                  if (rec.blob) {
                    const reader = new FileReader();
                    const base64 = await new Promise((res) => {
                      reader.onloadend = () => res(reader.result);
                      reader.readAsDataURL(rec.blob);
                    });
                    parsedSS.push({ id: rec.id, dataUrl: base64 });
                  }
                }
                result.screenshots = parsedSS;
                resolve(result);
              };
            };
          };
        } catch (err) {
          resolve({ error: err.toString() });
        }
      };
      req.onerror = () => resolve({ error: 'DB open failed' });
    });
  });

  console.log('\n--- DATABASE DUMP ---');
  // Log a clean version without massive base64 strings
  const cleanData = {
    ...dbData,
    screenshots: dbData.screenshots ? dbData.screenshots.map(s => ({ id: s.id, size: s.dataUrl.length })) : []
  };
  console.log(JSON.stringify(cleanData, null, 2));

  // Write screenshot files to artifacts folder
  const fs = require('fs');
  const artifactsDir = 'C:\\Users\\SaikumarBevara\\.gemini\\antigravity\\brain\\c6b924fa-0ba9-40c0-be0d-2df423feac21';
  
  if (dbData.screenshots && dbData.screenshots.length > 0) {
    dbData.screenshots.forEach((ss, idx) => {
      const base64Data = ss.dataUrl.replace(/^data:image\/jpeg;base64,/, '').replace(/^data:image\/png;base64,/, '');
      const filePath = path.join(artifactsDir, `captured_step_${idx + 1}.jpg`);
      fs.writeFileSync(filePath, base64Data, 'base64');
      console.log(`Saved captured screenshot ${idx + 1} to:`, filePath);
    });
  }

  // Wait to let user inspect
  await new Promise(r => setTimeout(r, 1000));
  await browser.close();
})();
