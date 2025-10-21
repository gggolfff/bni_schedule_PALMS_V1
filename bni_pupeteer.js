/**
 * @file BNI Connect Puppeteer Automation Script (Multi-report)
 * @description Automates logging into BNI Connect, downloading PALMS Summary Reports
 * for multiple date ranges, and saving them with meaningful, dynamically generated names.
 *
 * This refactored version improves maintainability, error handling, and date calculations.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const BNI_USERNAME = process.env.BNI_USERNAME;
const BNI_PASSWORD = process.env.BNI_PASSWORD;
const LOCAL_DOWNLOAD_FOLDER = path.resolve('./downloads');
const SCREENSHOT_FOLDER = path.resolve('./screenshots'); // New folder for error screenshots

/**
 * @description Centralized CSS selectors for easier maintenance.
 * If the BNI Connect website UI changes, update the values here.
 */
const SELECTORS = {
    login: {
        usernameInput: "input[name='username']",
        passwordInput: "input[name='password']",
        submitButton: "button[type='submit']",
    },
    navigation: {
        legacyViewIcon: '.css-hp1qy7 > svg',
        operationsHomeLink: 'a[href*="operationsHome"]',
        reportsTab: 'a[href="#ui-tabs-3"]',
        palmsReportLink: 'a[href*="reportsChapterPALMSForm"]',
    },
    palmsPage: {
        startDateInput: '#startDateChapterChapterPALMSReportDisplay',
        endDateInput: '#endDateChapterChapterPALMSReportDisplay',
        startDateHiddenInput: '#startDateChapterChapterPALMSReport',
        endDateHiddenInput: '#endDateChapterChapterPALMSReport',
        goButton: '#button',
        reportIframe: 'iframe[src*="WebReport"]',
        closeModalButton: '.ui-dialog-titlebar-close',
    },
    reportIframe: {
        exportLinks: '#links_1',
    },
};

// --- HELPERS ---

/**
 * A simple promise-based timeout. Replaces deprecated page.waitForTimeout.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Polls a directory until a new file (that is not a temporary .crdownload file) appears.
 * @param {string} dirPath - The absolute path to the directory to watch.
 * @param {number} [timeout=90000] - Timeout in milliseconds.
 * @returns {Promise<string>} A promise that resolves with the full path of the new file.
 */
const waitForFile = (dirPath, timeout = 90000) => {
    console.log(`Waiting for a new download in: ${dirPath} (timeout ${timeout / 1000}s)`);
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
        // Get the initial set of files in the directory
        const seen = new Set(fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : []);

        const interval = setInterval(() => {
            const files = fs.readdirSync(dirPath).filter(f => !f.endsWith('.crdownload'));
            const newFile = files.find(f => !seen.has(f));

            if (newFile) {
                clearInterval(interval);
                console.log(`Download detected: ${newFile}`);
                resolve(path.join(dirPath, newFile));
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                reject(new Error(`Download timeout after ${timeout / 1000}s.`));
            }
        }, 1000); // Check every second
    });
};

/**
 * Generates the date ranges and filenames for the reports to be downloaded.
 * This approach is clearer and generates filenames dynamically to avoid errors.
 * @returns {Array<object>} An array of report configuration objects.
 */
function getReportDateRanges() {
    const today = new Date();

    // Find the most recent Friday to use as the end date for all reports.
    const recentFriday = new Date(today);
    recentFriday.setDate(today.getDate() - (today.getDay() + 2) % 7); // (day + 2) % 7 maps Fri->0, Sat->1, ..., Thu->6

    /**
     * Formats a Date object into dd/mm/yyyy format.
     * @param {Date} date - The date to format.
     * @returns {string}
     */
    const formatDate = (date) => {
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const yyyy = date.getFullYear();
        return `${dd}/${mm}/${yyyy}`;
    };

    /**
     * Formats a Date object into ddMmmYYYY format for the filename.
     * @param {Date} date - The date to format.
     * @returns {string}
     */
    const formatFilenameDate = (date) => {
        const dd = String(date.getDate()).padStart(2, '0');
        const monthAbbr = date.toLocaleString('en-US', { month: 'short' });
        const yy = String(date.getFullYear()).slice(-2);
        return `${dd}${monthAbbr}${yy}`;
    };

    const endDate = formatDate(recentFriday);
    const yyyy = recentFriday.getFullYear();
    const yy = String(yyyy).slice(-2);
    const endDateForFilename = formatFilenameDate(recentFriday);

    const reports = [];

    // --- Report 1: Rolling 6-month report ---
    // (Starts from the 1st of the month, 6 months prior to the end date)
    const sixMonthsAgo = new Date(recentFriday);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5); // e.g., Oct -> May
    sixMonthsAgo.setDate(1); // Set to the 1st of that month
    const sixMonthName = sixMonthsAgo.toLocaleString('en-US', { month: 'short' });
    const sixMonthYearYY = String(sixMonthsAgo.getFullYear()).slice(-2);
    reports.push({
        key: '6-months',
        start: formatDate(sixMonthsAgo),
        end: endDate,
        filename: `chapter-palms-report_${sixMonthName}${sixMonthYearYY}-${endDateForFilename}`,
    });

    // --- Report 2: Year-to-date report ---
    const yearStartDate = new Date(yyyy, 0, 1); // January 1st of the current year
    reports.push({
        key: 'year-to-date',
        start: formatDate(yearStartDate),
        end: endDate,
        filename: `chapter-palms-report_YTD-${endDateForFilename}`,
    });

    // --- Report 3: Month-to-date report ---
    const monthStartDate = new Date(recentFriday.getFullYear(), recentFriday.getMonth(), 1);
    const weekOfMonth = Math.ceil(recentFriday.getDate() / 7);
    const monthName = recentFriday.toLocaleString('en-US', { month: 'short' });
    reports.push({
        key: 'month-to-date',
        start: formatDate(monthStartDate),
        end: endDate,
        filename: `chapter-palms-report_${monthName}${yy}-Week${weekOfMonth}`,
    });

    return reports;
}


/**
 * Sets the visible and hidden date fields on the PALMS report page.
 * This function is complex because it tries multiple methods (jQuery datepicker, direct input events)
 * to ensure the dates are set correctly on the target website.
 * @param {import('puppeteer').Page} page
 * @param {string} startDateFormatted - Date in dd/mm/yyyy format.
 * @param {string} endDateFormatted - Date in dd/mm/yyyy format.
 */
async function setDates(page, startDateFormatted, endDateFormatted) {
    // The hidden input fields on the website expect mm/dd/yyyy format.
    const ddmmyyyyToMmddyyyy = s => {
        const [dd, mm, yyyy] = s.split('/');
        return `${mm}/${dd}/${yyyy}`;
    };

    const startHiddenFormat = ddmmyyyyToMmddyyyy(startDateFormatted);
    const endHiddenFormat = ddmmyyyyToMmddyyyy(endDateFormatted);

    const result = await page.evaluate(
        async ({ startDisplay, endDisplay, startHidden, endHidden, selectors }) => {
            // This code runs in the browser context
            const $ = window.jQuery || window.$;
            const startEl = document.querySelector(selectors.startDateInput);
            const endEl = document.querySelector(selectors.endDateInput);
            const startHiddenEl = document.querySelector(selectors.startDateHiddenInput);
            const endHiddenEl = document.querySelector(selectors.endDateHiddenInput);

            if (!startEl || !endEl) {
                return { error: 'Visible date input fields not found.' };
            }

            // Helper to parse dd/mm/yyyy for the datepicker
            const parseDMY = s => {
                const [dd, mm, yyyy] = s.split('/');
                return new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
            };

            let usedDatepicker = false;
            // Method 1: Try to use the jQuery datepicker if it exists.
            if ($ && $.datepicker) {
                try {
                    $(startEl).datepicker('setDate', parseDMY(startDisplay));
                    $(endEl).datepicker('setDate', parseDMY(endDisplay));
                    // Trigger events to let the page know the date has changed
                    $(startEl).trigger('change').trigger('blur');
                    $(endEl).trigger('change').trigger('blur');
                    usedDatepicker = true;
                } catch (e) {
                    // Fallback if datepicker fails
                }
                await new Promise(r => setTimeout(r, 300)); // Wait for JS to process
            }

            // Method 2: Fallback to setting values and dispatching events directly.
            if (startEl.value !== startDisplay || endEl.value !== endDisplay) {
                startEl.value = startDisplay;
                startEl.dispatchEvent(new Event('input', { bubbles: true }));
                startEl.dispatchEvent(new Event('change', { bubbles: true }));
                endEl.value = endDisplay;
                endEl.dispatchEvent(new Event('input', { bubbles: true }));
                endEl.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(r => setTimeout(r, 300));
            }

            // Set the hidden input values which are often used for form submission.
            if (startHiddenEl) startHiddenEl.value = startHidden;
            if (endHiddenEl) endHiddenEl.value = endHidden;

            document.body.click(); // Click away to close any calendar popups
            await new Promise(r => setTimeout(r, 300));

            return {
                usedDatepicker,
                displayStart: startEl.value,
                displayEnd: endEl.value,
                hiddenStart: startHiddenEl ? startHiddenEl.value : null,
                hiddenEnd: endHiddenEl ? endHiddenEl.value : null,
            };
        }, {
            startDisplay: startDateFormatted,
            endDisplay: endDateFormatted,
            startHidden: startHiddenFormat,
            endHidden: endHiddenFormat,
            selectors: SELECTORS.palmsPage,
        }
    );

    console.log('setDates result:', result);
    if (result.error) {
        throw new Error(result.error);
    }
}

/**
 * Runs a single report: sets dates, clicks "Go", waits for the report iframe,
 * clicks the download link, waits for the download to complete, and renames the file.
 * @param {import('puppeteer').Page} page
 * @param {object} report - A report configuration object.
 */
async function runOneReport(page, report) {
    console.log(`▶ Running report: ${report.key} -> ${report.filename}`);

    await setDates(page, report.start, report.end);
    await page.click(SELECTORS.palmsPage.goButton);

    // Wait for the report to load inside the iframe
    const iframeElementHandle = await page.waitForSelector(SELECTORS.palmsPage.reportIframe, { visible: true });
    const frame = await iframeElementHandle.contentFrame();
    if (!frame) {
        throw new Error('Could not get content frame from the report iframe.');
    }

    // Click the "Excel" export link within the iframe
    await frame.waitForSelector(SELECTORS.reportIframe.exportLinks, { visible: true });
    await frame.click(SELECTORS.reportIframe.exportLinks);

    // Wait for the file to finish downloading and rename it
    const downloadedPath = await waitForFile(LOCAL_DOWNLOAD_FOLDER, 90000);
    const newPath = path.join(LOCAL_DOWNLOAD_FOLDER, `${report.filename}.xls`);
    fs.renameSync(downloadedPath, newPath);
    console.log(`  ✔ Renamed downloaded file -> ${newPath}`);

    // Attempt to close the report modal dialog to clean up for the next run
    try {
        await page.waitForSelector(SELECTORS.palmsPage.closeModalButton, { visible: true, timeout: 5000 });
        await page.click(SELECTORS.palmsPage.closeModalButton);
        console.log('  ✔ Modal closed successfully.');
    } catch (e) {
        console.log('  - No modal dialog to close, or it closed automatically.');
    }
    await wait(1000); // Brief pause before starting the next report.
}

/**
 * Main execution block.
 */
(async () => {
    console.log('--- Starting BNI Connect Multi-report Script ---');
    if (!BNI_USERNAME || !BNI_PASSWORD) {
        console.error('ERROR: Missing BNI_USERNAME or BNI_PASSWORD in environment variables.');
        process.exit(1);
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Standard args for GitHub Actions
        });
        const page = await browser.newPage();
        page.setDefaultTimeout(90000); // Set a generous default timeout

        // Ensure the download and screenshot folders exist
        if (!fs.existsSync(LOCAL_DOWNLOAD_FOLDER)) {
            fs.mkdirSync(LOCAL_DOWNLOAD_FOLDER, { recursive: true });
        }
        if (!fs.existsSync(SCREENSHOT_FOLDER)) {
            fs.mkdirSync(SCREENSHOT_FOLDER, { recursive: true });
        }
        // Configure Puppeteer to allow downloads and set the directory
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: LOCAL_DOWNLOAD_FOLDER,
        });
        console.log('Download behavior configured.');

        // --- 1. LOGIN ---
        console.log('Navigating to login page...');
        await page.goto('https://www.bniconnectglobal.com/login/', { waitUntil: 'networkidle2' });
        console.log('Typing login credentials...');
        await page.waitForSelector(SELECTORS.login.usernameInput, { visible: true });
        await page.type(SELECTORS.login.usernameInput, BNI_USERNAME, { delay: 50 });
        await page.type(SELECTORS.login.passwordInput, BNI_PASSWORD, { delay: 50 });
        await Promise.all([
            page.click(SELECTORS.login.submitButton),
            page.waitForNavigation({ waitUntil: 'networkidle0' })
        ]);
        console.log('Logged in successfully.');

        // --- 2. NAVIGATE TO REPORTS ---
        console.log('Switching to legacy view...');
        await page.waitForSelector(SELECTORS.navigation.legacyViewIcon, { visible: true });
        await page.click(SELECTORS.navigation.legacyViewIcon);
        await page.waitForSelector(SELECTORS.navigation.operationsHomeLink, { visible: true });

        console.log('Navigating to PALMS Summary Report page...');
        await page.click(SELECTORS.navigation.reportsTab);
        await page.waitForSelector(SELECTORS.navigation.palmsReportLink, { visible: true });
        await page.click(SELECTORS.navigation.palmsReportLink);
        await page.waitForSelector(SELECTORS.palmsPage.startDateInput, { visible: true });
        console.log('On PALMS Summary page.');

        // --- 3. CALCULATE DATES & RUN REPORTS ---
        const reports = getReportDateRanges();
        console.log('Will pull the following reports:');
        reports.forEach(r => console.log(` - ${r.filename} | Start: ${r.start}, End: ${r.end}`));

        for (const report of reports) {
            try {
                await runOneReport(page, report);
            } catch (error) {
                console.error(`\n--- !!! FAILED to run report: ${report.key} !!! ---`);
                console.error(error.message);
                console.error('--- Continuing with the next report... ---\n');
                // Optional: Take a screenshot on failure for debugging
                const screenshotPath = path.join(SCREENSHOT_FOLDER, `error_${report.filename}.png`); // Use new folder
                await page.screenshot({ path: screenshotPath, fullPage: true });
                console.log(`Screenshot saved to ${screenshotPath}`);
                // Refresh the page to try and recover a clean state
                await page.reload({ waitUntil: 'networkidle0' });
                await page.waitForSelector(SELECTORS.palmsPage.startDateInput, { visible: true });

            }
        }
    } catch (error) {
        console.error('\n--- !!! A critical error occurred during execution !!! ---');
        console.error(error);
        process.exit(1);
    } finally {
        if (browser) {
            await browser.close();
        }
        console.log('--- Script Finished ---');
    }
})();


