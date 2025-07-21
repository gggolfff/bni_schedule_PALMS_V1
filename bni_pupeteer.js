/**
 * @file BNI Connect Puppeteer Automation Script (v37 - Enhanced Download Logic)
 * @description This script automates logging into BNI Connect, downloading the
 * "Slips Audit Report", and saving it to a local folder. It is designed to be
 * run in a GitHub Actions environment using a locally installed browser.
 *
 * This version incorporates a much more robust download interception function
 * with advanced error handling and diagnostics, including screenshots and an
 * HTML dump on failure, to reliably capture the file.
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
 * Intercepts a download request with robust error handling and diagnostics.
 * @param {import('puppeteer').Page} page - The main Puppeteer page object.
 * @param {import('puppeteer').Frame} frame - The frame containing the download button.
 * @param {string} exportButtonSelector - The selector for the download button inside the frame.
 * @returns {Promise<{buffer: Buffer, filename: string}>} A promise that resolves with the file buffer and filename.
 */
async function interceptDownload(page, frame, exportButtonSelector) {
    console.log('Attempting to intercept download...');
    try {
        // Ensure export button is available and clickable within the frame
        await frame.waitForSelector(exportButtonSelector, { visible: true, timeout: 15000 });
        console.log('Export button found and visible.');

        // Start listening for the download
        const downloadPromise = new Promise(async (resolve, reject) => {
            const timeout = setTimeout(async () => {
                try {
                    // Save diagnostics on timeout
                    console.error('Download intercept timeout after 45 seconds.');
                    const currentUrl = await page.url();
                    console.error('Current page URL:', currentUrl);
                    
                    await page.screenshot({ path: 'error_download_timeout.png', fullPage: true });
                    console.error('📷 Timeout screenshot saved to error_download_timeout.png');

                    const pageContent = await page.content();
                    fs.writeFileSync('error_page_dump.html', pageContent);
                    console.error('📄 HTML page content saved to error_page_dump.html');

                    reject(new Error(`Download intercept timeout after 45 seconds. URL: ${currentUrl}`));
                } catch (diagError) {
                    reject(new Error(`Download intercept timeout, and failed to capture diagnostics: ${diagError.message}`));
                }
            }, 45000);

            // Attach the listener to the MAIN PAGE
            page.on('response', async (response) => {
                const headers = response.headers();
                const disposition = headers['content-disposition'];
                const contentType = headers['content-type'];

                const isAttachment = disposition && disposition.includes('attachment');
                const isDataFile = contentType && (contentType.includes('csv') || contentType.includes('excel') || contentType.includes('spreadsheetml') || contentType.includes('application/octet-stream'));

                if (isAttachment || isDataFile) {
                    console.log(`Download detected! Content-Type: ${contentType}`);
                    try {
                        let filename = 'downloaded-file.tmp';
                        if (disposition) {
                            const filenameMatch = disposition.match(/filename="(.+?)"/);
                            if (filenameMatch) filename = filenameMatch[1];
                        } else if (isDataFile) {
                            const extension = contentType.includes('csv') ? 'csv' : 'xls';
                            filename = `report-${Date.now()}.${extension}`;
                        }
                        
                        const buffer = await response.buffer();
                        console.log(`File data captured for: ${filename}`);
                        
                        clearTimeout(timeout);
                        page.removeAllListeners('response');
                        resolve({ buffer, filename });
                    } catch (bufferError) {
                        clearTimeout(timeout);
                        reject(bufferError);
                    }
                }
            });

            // Trigger the download by clicking the button INSIDE THE FRAME
            try {
                console.log('Clicking export button to trigger download...');
                await frame.click(exportButtonSelector);
            } catch (clickErr) {
                clearTimeout(timeout);
                await page.screenshot({ path: 'error_download_click.png' });
                reject(new Error('Failed to click export button: ' + clickErr.message));
            }
        });

        // Wait for the promise to resolve with the download data
        return await downloadPromise;

    } catch (err) {
        console.error('Download interception failed:', err);
        await page.screenshot({ path: 'error_download_final.png', fullPage: true });
        throw err; // Re-throw the error to fail the script
    }
}


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

    // --- 5. Login to BNI Connect ---
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


    // --- 6. Find and Click the Legacy Button ---
    console.log('Starting patient search for the legacy view switch...');
    const legacyIconSelector = '.css-hp1qy7 > svg';
    await page.waitForSelector(legacyIconSelector, { visible: true, timeout: 30000 });
    console.log('✅ Legacy icon found!');
    
    console.log('Clicking icon to switch to legacy home...');
    await page.click(legacyIconSelector);

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
    console.log('Clicking the "Slips Audit Report" link...');
    await page.click('#auditLink');

    console.log('Waiting for the report iframe to load...');
    const iframeElementHandle = await page.waitForSelector('iframe[src*="WebReport"]', { visible: true });
    const frame = await iframeElementHandle.contentFrame();
    if (!frame) throw new Error('Could not get content frame of the report iframe.');

    // The new function handles the entire download process
    const { buffer, filename } = await interceptDownload(page, frame, '#links_1');


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
