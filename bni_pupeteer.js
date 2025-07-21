/**
 * @file BNI Connect Puppeteer Automation Script (v31 - Resilient Login with Debugging)
 * @description This script automates logging into BNI Connect, downloading the
 * "Slips Audit Report", and saving it to a local folder. It is designed to be
 * run in a GitHub Actions environment using a locally installed browser.
 *
 * This version introduces a resilient retry loop for the login process. If it
 * fails to find the expected element after login, it will reload and try again,
 * taking a screenshot on each failure for easier debugging.
 *
 * @requires puppeteer
 * @requires fs
 * @requires path
 */

// --- 1. Import required modules ---
const puppeteer = require('puppeteer'); // Use the full puppeteer package
const fs = require('fs');
const path = require('path');

// --- 2. CONFIGURATION ---
// Credentials are read from environment variables (GitHub Secrets).
const BNI_USERNAME = process.env.BNI_USERNAME;
const BNI_PASSWORD = process.env.BNI_PASSWORD;

// The local folder within the GitHub Actions runner to save the file.
const LOCAL_DOWNLOAD_FOLDER = path.resolve('./downloads');
// --- END: CONFIGURATION ---


/**
 * Intercepts a download request and returns the file's content as a buffer.
 * @param {import('puppeteer').Page} page - The Puppeteer page object.
 * @returns {Promise<{buffer: Buffer, filename: string}>} A promise that resolves with the file buffer and filename.
 */
const interceptDownload = (page) => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
        reject(new Error('Download intercept timeout after 45 seconds.'));
    }, 45000);

    page.on('response', async (response) => {
      const disposition = response.headers()['content-disposition'];
      if (disposition && disposition.includes('attachment')) {
        try {
            console.log('Download response intercepted.');
            const filenameMatch = disposition.match(/filename="(.+?)"/);
            const filename = filenameMatch ? filenameMatch[1] : 'downloaded-file.csv';
            console.log(`Detected filename: ${filename}`);
            const buffer = await response.buffer();
            console.log('File data captured in buffer.');
            clearTimeout(timeout);
            page.removeAllListeners('response');
            resolve({ buffer, filename });
        } catch (err) {
            clearTimeout(timeout);
            reject(err);
        }
      }
    });
  });
};


(async () => {
  let browser;
  let page;

  console.log('--- Starting BNI Connect Automation Script (Local Runner) ---');

  // --- 3. Basic Validation ---
  if (!BNI_USERNAME || !BNI_PASSWORD) {
    console.error('!!! CRITICAL: Missing BNI_USERNAME or BNI_PASSWORD environment variables.');
    process.exit(1);
  }

  try {
    // --- 4. Launch a local browser instance ---
    console.log('Launching local Puppeteer browser...');
    browser = await puppeteer.launch({
      // These args are required to run in a Linux container like GitHub Actions
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    page = await browser.newPage();
    page.setDefaultTimeout(90000);
    await page.setViewport({ width: 1280, height: 960 });
    console.log('Local browser launched and page created.');

    // --- 5. Login to BNI Connect ---
    console.log('Navigating to the login page...');
    await page.goto('https://www.bniconnectglobal.com/login/', { waitUntil: 'networkidle2' });

    console.log('Entering login credentials...');
    await page.waitForSelector("input[name='username']", { visible: true });
    await page.evaluate((user, pass) => {
        document.querySelector("input[name='username']").value = user;
        document.querySelector("input[name='password']").value = pass;
    }, BNI_USERNAME, BNI_PASSWORD);

    console.log('Clicking the login button...');
    await page.click("button[type='submit']");

    // LOGIN FIX: Implement a resilient retry loop to handle slow loading or intermediate pages.
    console.log('Waiting for dashboard to load after login...');
    const legacyIconSelector = '.css-hp1qy7 > svg';
    let legacyIcon = null;
    const loginRetries = 3;
    for (let i = 1; i <= loginRetries; i++) {
        console.log(`[Login Attempt ${i}/${loginRetries}] Looking for dashboard element...`);
        try {
            legacyIcon = await page.waitForSelector(legacyIconSelector, { visible: true, timeout: 30000 });
            if (legacyIcon) {
                console.log('✅ Dashboard element found! Login successful.');
                break; // Exit the loop on success
            }
        } catch (err) {
            console.warn(`Dashboard element not found on attempt ${i}.`);
            const debugScreenshotPath = `./debug_screenshot_attempt_${i}.png`;
            await page.screenshot({ path: debugScreenshotPath, fullPage: true });
            console.warn(`📷 A debug screenshot has been saved to: ${debugScreenshotPath}`);
            console.warn(`Current page URL is: ${page.url()}`);

            if (i === loginRetries) {
                throw new Error(`Login failed after ${loginRetries} attempts. Could not find the dashboard element.`);
            }

            console.log('Reloading page and trying again...');
            await page.reload({ waitUntil: 'networkidle0' });
        }
    }

    if (!legacyIcon) {
        throw new Error('Could not find the legacy switch icon after all login attempts.');
    }

    // --- 6. Click the Legacy Button ---
    console.log('Clicking icon to switch to legacy home...');
    await legacyIcon.click();
    await page.waitForSelector('a[href*="operationsHome"]', { visible: true });
    console.log('Successfully switched to legacy view.');


    // --- 7. Navigate to PALMS Report ---
    console.log('Navigating through Operations -> Chapter...');
    await page.click('a[href="#ui-tabs-3"]');
    const enterPalmsSelector = 'a[href*="operationsChapterEnterPalms"]';
    await page.waitForSelector(enterPalmsSelector, { visible: true });
    await page.click(enterPalmsSelector);
    await page.click('#finishReviewButton');
    await page.waitForSelector('#fromDate', { visible: true });
    console.log('Navigated to the PALMS entry page.');


    // --- 8. Set Date and Search ---
    console.log('Calculating date for the upcoming Friday...');
    const upcomingFriday = await page.evaluate(() => {
      const today = new Date();
      const dayOfWeek = today.getDay();
      const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
      const nextFriday = new Date(today);
      nextFriday.setDate(today.getDate() + daysUntilFriday);
      const dd = String(nextFriday.getDate()).padStart(2, '0');
      const mm = String(nextFriday.getMonth() + 1).padStart(2, '0');
      const yyyy = nextFriday.getFullYear();
      return `${dd}/${mm}/${yyyy}`;
    });
    console.log(`Calculated upcoming Friday as: ${upcomingFriday}`);

    console.log('Setting date and clicking Search...');
    await page.evaluate((date) => {
        document.querySelector('#fromDate').value = date;
        document.querySelector('#Search').click();
    }, upcomingFriday);

    await page.waitForSelector('#auditLink', { visible: true, timeout: 30000 });
    console.log('Search results loaded.');


    // --- 9. Download the Report ---
    console.log('Setting up download interceptor...');
    const downloadPromise = interceptDownload(page);

    console.log('Clicking the "Slips Audit Report" link...');
    await page.click('#auditLink');

    console.log('Waiting for the report iframe to load...');
    const iframeElementHandle = await page.waitForSelector('iframe[src*="WebReport"]', { visible: true });
    const frame = await iframeElementHandle.contentFrame();
    if (!frame) throw new Error('Could not get content frame of the report iframe.');

    console.log('Clicking "Export without Headers" inside the iframe...');
    await frame.waitForSelector('#links_1', { visible: true });
    await frame.click('#links_1');

    console.log('Waiting for download data to be captured...');
    const { buffer, filename } = await downloadPromise;


    // --- 10. Save File Locally ---
    console.log(`Processing downloaded file: ${filename}`);
    if (!fs.existsSync(LOCAL_DOWNLOAD_FOLDER)) {
        console.log(`Creating local download folder: ${LOCAL_DOWNLOAD_FOLDER}`);
        fs.mkdirSync(LOCAL_DOWNLOAD_FOLDER, { recursive: true });
    }
    const destinationPath = path.join(LOCAL_DOWNLOAD_FOLDER, filename);
    console.log(`Writing file to local path: ${destinationPath}`);
    fs.writeFileSync(destinationPath, buffer);
    console.log(`✅ File successfully saved locally.`);


    // --- 11. Cleanup ---
    console.log('Closing the report modal...');
    await page.click('.ui-dialog-titlebar-close');
    console.log('Report modal closed.');

  } catch (error) {
    console.error('❌ An error occurred during the automation script:');
    console.error(error);
    process.exit(1);
  } finally {
    if (browser) {
      console.log('--- Closing browser ---');
      await browser.close(); // Use close() for launched browsers
    }
    console.log('--- Script execution finished ---');
  }
})();
