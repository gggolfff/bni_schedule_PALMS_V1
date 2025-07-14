/**
 * @file BNI Connect Puppeteer Automation Script (v28 - GitHub Actions Ready)
 * @description This script automates logging into BNI Connect, downloading the
 * "Slips Audit Report", and saving it to a local folder. It is designed to be
 * run in a GitHub Actions environment.
 *
 * This version reads credentials from environment variables for security and
 * saves the output file to a local path to be uploaded as a GitHub Artifact.
 *
 * @requires puppeteer-core
 * @requires fs
 * @requires path
 */

// --- 1. Import required modules ---
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// --- 2. CONFIGURATION ---
// Credentials and API keys are now read from environment variables for security.
// You will set these up as "Secrets" in your GitHub repository settings.
const BNI_BROWSERLESS_API_KEY = process.env.BNI_BROWSERLESS_API_KEY;
const BNI_USERNAME = process.env.BNI_USERNAME;
const BNI_PASSWORD = process.env.BNI_PASSWORD;

// The local folder within the GitHub Actions runner to save the file.
// This will be uploaded as an artifact.
const LOCAL_DOWNLOAD_FOLDER = path.resolve('./downloads');
// --- END: CONFIGURATION ---


/**
 * Intercepts a download request and returns the file's content as a buffer.
 * @param {import('puppeteer-core').Page} page - The Puppeteer page object.
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

  console.log('--- Starting BNI Connect Automation Script for GitHub Actions ---');

  // --- 3. Basic Validation ---
  if (!BNI_BROWSERLESS_API_KEY || !BNI_USERNAME || !BNI_PASSWORD) {
    console.error('!!! CRITICAL: Missing one or more required environment variables (BNI_BROWSERLESS_API_KEY, BNI_USERNAME, BNI_PASSWORD).');
    process.exit(1); // Exit with an error code
  }

  try {
    // --- 4. Connect to Browserless.io ---
    console.log('Connecting to Browserless.io...');
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${BNI_BROWSERLESS_API_KEY}`,
    });

    page = await browser.newPage();
    page.setDefaultTimeout(90000);
    await page.setViewport({ width: 1280, height: 960 });
    console.log('Connected to remote browser and page created.');

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
    await Promise.all([
      page.click("button[type='submit']"),
      page.waitForNavigation({ waitUntil: 'networkidle0' })
    ]);
    console.log('Login successful.');


    // --- 6. Patiently Find and Click the Legacy Button ---
    console.log('Starting search for the legacy view switch...');
    const legacyIconSelector = '.css-hp1qy7 > svg';
    let legacyIcon = null;
    const maxRetries = 12;

    for (let i = 1; i <= maxRetries; i++) {
      console.log(`[Attempt ${i}/${maxRetries}] Looking for legacy icon...`);
      try {
        legacyIcon = await page.waitForSelector(legacyIconSelector, { visible: true, timeout: 4000 });
        if (legacyIcon) {
          console.log('✅ Legacy icon found!');
          break;
        }
      } catch (e) {
        console.log(`Icon not found on attempt ${i}.`);
        if (i < maxRetries) {
          console.log('Reloading page and trying again...');
          await page.reload({ waitUntil: 'networkidle0' });
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    if (!legacyIcon) {
      throw new Error(`Could not find the legacy switch icon after ${maxRetries} attempts.`);
    }

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
      console.log('--- Disconnecting from browser ---');
      await browser.disconnect();
    }
    console.log('--- Script execution finished ---');
  }
})();
