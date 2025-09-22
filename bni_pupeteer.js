/**
 * @file BNI Connect Puppeteer Automation Script (v38 - Filesystem Download)
 * @description This script automates logging into BNI Connect, downloading the
 * "Slips Audit Report", and saving it to a local folder. It is designed to be
 * run in a GitHub Actions environment using a locally installed browser.
 *
 * This version fixes the "ProtocolError" by abandoning download interception.
 * Instead, it instructs the browser to download the file directly to the local
* filesystem and then waits for the file to appear, which is more reliable.
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
 * Polls a directory to wait for a file to be downloaded.
 * @param {string} dirPath - The absolute path to the download directory.
 * @param {number} timeout - The maximum time to wait in milliseconds.
 * @returns {Promise<string>} A promise that resolves with the full path of the downloaded file.
 */
const waitForFile = (dirPath, timeout = 45000) => {
  console.log(`Waiting for download to appear in: ${dirPath}`);
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      try {
        const files = fs.readdirSync(dirPath);
        // Filter out temporary chrome download files
        const completedFiles = files.filter(file => !file.endsWith('.crdownload') && file !== '.com.google.Chrome.??????');

        if (completedFiles.length > 0) {
          clearInterval(interval);
          console.log(`Download detected: ${completedFiles[0]}`);
          resolve(path.join(dirPath, completedFiles[0]));
        } else if (Date.now() - startTime > timeout) {
          clearInterval(interval);
          reject(new Error(`Download timeout: No file appeared in ${dirPath} after ${timeout / 1000} seconds.`));
        }
      } catch (err) {
        clearInterval(interval);
        reject(err);
      }
    }, 1000); // Check every second
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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    page = await browser.newPage();
    page.setDefaultTimeout(90000);
    await page.setViewport({ width: 1280, height: 960 });
    console.log('Local browser launched and page created.');

    // --- 5. Configure Download Behavior ---
    // Create the download directory if it doesn't exist
    if (!fs.existsSync(LOCAL_DOWNLOAD_FOLDER)) {
      fs.mkdirSync(LOCAL_DOWNLOAD_FOLDER, { recursive: true });
    }
    // Use the Chrome DevTools Protocol to set the download path
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: LOCAL_DOWNLOAD_FOLDER,
    });
    console.log(`Download behavior configured to save files in: ${LOCAL_DOWNLOAD_FOLDER}`);


    // --- 6. Login to BNI Connect ---
    console.log('Navigating to the login page...');
    await page.goto('https://www.bniconnectglobal.com/login/', { waitUntil: 'networkidle2' });

    console.log('Typing login credentials...');
    await page.waitForSelector("input[name='username']", { visible: true });
    await page.type("input[name='username']", BNI_USERNAME, { delay: 50 });
    await page.type("input[name='password']", BNI_PASSWORD, { delay: 50 });

    console.log('Clicking the login button and waiting for navigation...');
    await Promise.all([
      page.click("button[type='submit']"),
      page.waitForNavigation({ waitUntil: 'networkidle0' })
    ]);
    console.log('Login successful. Navigated to the dashboard.');


    // --- 7. Find and Click the Legacy Button ---
    console.log('Starting patient search for the legacy view switch...');
    const legacyIconSelector = '.css-hp1qy7 > svg';
    await page.waitForSelector(legacyIconSelector, { visible: true, timeout: 30000 });
    console.log('✅ Legacy icon found!');
    
    console.log('Clicking icon to switch to legacy home...');
    await page.click(legacyIconSelector);

    await page.waitForSelector('a[href*="operationsHome"]', { visible: true });
    console.log('Successfully switched to legacy view.');


    // --- 8. Navigate to PALMS Summary Report ---
    console.log('Navigating through Operations -> Chapter... -> PALMS Summary');
    await page.click('a[href="#ui-tabs-3"]');
    const enterPalmsSelector = 'a[href*="reportsChapterPALMSForm"]';
    await page.waitForSelector(enterPalmsSelector, { visible: true });
    await page.click(enterPalmsSelector);
    //await page.click('#finishReviewButton');
    await page.waitForSelector('#startDateChapterChapterPALMSReportDisplay', { visible: true });
    console.log('Navigated to the Summary PALMS date inputs.');


    // --- 9. Set Date and Search ---
    console.log('Calculating date for the recent Friday...');
     // --- Calculate dates ---
    const { startDateFormatted, endDateFormatted } = (() => {
      const today = new Date();
      const day = today.getDay(); // Sunday=0 ... Saturday=6
  
      // Find most recent Friday (including today if Friday)
      const diff = (day >= 5) ? (day - 5) : (day + 2);
      const recentFriday = new Date(today);
      recentFriday.setDate(today.getDate() - diff);
  
      // End date = recent Friday
      const endDD = String(recentFriday.getDate()).padStart(2, "0");
      const endMM = String(recentFriday.getMonth() + 1).padStart(2, "0");
      const endYYYY = recentFriday.getFullYear();
      const endDateFormatted = `${endDD}/${endMM}/${endYYYY}`;
    
      // Start date = 1st day of month, 6 months earlier
      let start = new Date(recentFriday.getFullYear(), recentFriday.getMonth(), 1);
      start.setMonth(start.getMonth() - 6);
      const startDD = "01";
      const startMM = String(start.getMonth() + 1).padStart(2, "0");
      const startYYYY = start.getFullYear();
      const startDateFormatted = `${startDD}/${startMM}/${startYYYY}`;
  
      return { startDateFormatted, endDateFormatted };
    })();
    
    console.log('PALMS report 6 months earlier date:');
    console.log("Start Date:", startDateFormatted);
    console.log("End Date:", endDateFormatted);

    // --- Fill inputs ---
    await page.type("#startDateChapterChapterPALMSReportDisplay", startDateFormatted, { delay: 50 });
    await page.type("#endDateChapterChapterPALMSReportDisplay", endDateFormatted, { delay: 50 });
    console.log('Start and End date filled in..');
    console.log('sync hidden inputs..');
    
    // --- Also sync hidden inputs (to ensure form submits correctly) ---
    await page.evaluate(
    (startDateFormatted, endDateFormatted) => {
      document.querySelector("#startDateChapterChapterPALMSReport").value = startDateFormatted;
      document.querySelector("#endDateChapterChapterPALMSReport").value = endDateFormatted;
      document.querySelector('#button').click();
    },
    startDateFormatted,
    endDateFormatted
    );

    // --- Original script for PALMS input method.. ---
    // const upcomingFriday = await page.evaluate(() => {
    //   const today = new Date();
    //   const dayOfWeek = today.getDay();
    //   const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
    //   const nextFriday = new Date(today);
    //   nextFriday.setDate(today.getDate() + daysUntilFriday);
    //   const dd = String(nextFriday.getDate()).padStart(2, '0');
    //   const mm = String(nextFriday.getMonth() + 1).padStart(2, '0');
    //   const yyyy = nextFriday.getFullYear();
    //   return `${dd}/${mm}/${yyyy}`;
    // });
    // console.log(`Calculated upcoming Friday as: ${upcomingFriday}`);
    // console.log('Setting date and clicking Search...');
    // await page.evaluate((date) => {
    //     document.querySelector('#fromDate').value = date;
    //     document.querySelector('#Search').click();
    // }, upcomingFriday);

    // await page.waitForSelector('#auditLink', { visible: true, timeout: 30000 });
    // console.log('Search results loaded.');


    // --- 10. Download the Report ---
    // console.log('Clicking the "Slips Audit Report" link...');
    // await page.click('#auditLink');

    console.log('Waiting for the report iframe to load...');
    const iframeElementHandle = await page.waitForSelector('iframe[src*="WebReport"]', { visible: true });
    const frame = await iframeElementHandle.contentFrame();
    if (!frame) throw new Error('Could not get content frame of the report iframe.');

    console.log('Clicking "Export without Headers" inside the iframe...');
    await frame.waitForSelector('#links_1', { visible: true });
    await frame.click('#links_1');

    // Wait for the file to appear in the download directory
    const downloadedFilePath = await waitForFile(LOCAL_DOWNLOAD_FOLDER);
    console.log(`✅ File successfully downloaded to: ${downloadedFilePath}`);
    // No need to save the file, it's already in the correct folder for artifact upload.


    // --- 11. Cleanup ---
    console.log('Attempting to close the report modal if it exists...');
    try {
      const closeModalSelector = '.ui-dialog-titlebar-close';
      await page.waitForSelector(closeModalSelector, { visible: true, timeout: 5000 });
      await page.click(closeModalSelector);
      console.log('Report modal closed.');
    } catch (e) {
      console.log('Report modal not found or already closed. Continuing...');
    }

  } catch (error) {
    console.error('❌ An error occurred during the automation script:');
    if (page) {
        const errorScreenshotPath = './error_screenshot.png';
        try {
            await page.screenshot({ path: errorScreenshotPath, fullPage: true });
            console.error(`📷 A final error screenshot has been saved to: ${errorScreenshotPath}`);
        } catch (e) {
            console.error('Could not take a final screenshot.', e);
        }
    }
    console.error(error);
    process.exit(1);
  } finally {
    if (browser) {
      console.log('--- Closing browser ---');
      await browser.close();
    }
    console.log('--- Script execution finished ---');
  }
})();
