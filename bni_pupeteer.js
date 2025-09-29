/**
 * BNI Connect Puppeteer Automation Script (multi-report + rename)
 * Integrated version — pulls 5 report ranges, downloads, renames files.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// CONFIG
const BNI_USERNAME = process.env.BNI_USERNAME;
const BNI_PASSWORD = process.env.BNI_PASSWORD;
const LOCAL_DOWNLOAD_FOLDER = path.resolve('./downloads');

// Wait-for-file helper (checks file mtime > startTime)
const waitForFile = (dirPath, startTime = Date.now(), timeout = 90000) => {
  console.log(`Waiting for a new download in: ${dirPath} (timeout ${timeout/1000}s)`);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const files = fs.readdirSync(dirPath);
        // filter out in-progress/chrome temp files
        const candidates = files
          .filter(f => !f.endsWith('.crdownload') && !f.startsWith('.'))
          .map(f => {
            const p = path.join(dirPath, f);
            const stat = fs.statSync(p);
            return { name: f, path: p, mtime: stat.mtimeMs };
          })
          .filter(obj => obj.mtime >= startTime - 1000) // created/modified after we started waiting
          .sort((a, b) => b.mtime - a.mtime);

        if (candidates.length > 0) {
          clearInterval(timer);
          console.log('Download detected:', candidates[0].name);
          return resolve(candidates[0].path);
        }

        if (Date.now() - start > timeout) {
          clearInterval(timer);
          return reject(new Error(`Download timeout: no file appeared in ${dirPath} after ${timeout/1000}s.`));
        }
      } catch (err) {
        clearInterval(timer);
        return reject(err);
      }
    }, 1000);
  });
};

// Date helpers & filename formatting
const MONTH_ABBREV = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDdMmYyyy(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatStartMMMYY(date) {
  const mon = MONTH_ABBREV[date.getMonth()];
  const yy = String(date.getFullYear()).slice(-2);
  return `${mon}${yy}`; // e.g., Apr25
}

function formatEndShortDDMonYY(date) {
  const dd = String(date.getDate()).padStart(2,'0');
  const mon = MONTH_ABBREV[date.getMonth()];
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}${mon}${yy}`; // e.g., 19Sep25
}

function getRecentFriday(today = new Date()) {
  const day = today.getDay(); // Sun=0..Sat=6
  const diff = (day >= 5) ? (day - 5) : (day + 2);
  const friday = new Date(today);
  friday.setDate(today.getDate() - diff);
  friday.setHours(0,0,0,0);
  return friday;
}

function getFridayWeekNumber(fridayDate) {
  const d = new Date(fridayDate.getFullYear(), fridayDate.getMonth(), fridayDate.getDate());
  let count = 0;
  for (let day = 1; day <= d.getDate(); day++) {
    const tmp = new Date(d.getFullYear(), d.getMonth(), day);
    if (tmp.getDay() === 5) count++;
  }
  return count;
}

/**
 * Build configurations for the five reports (in the order you wanted).
 * Uses the "recentFriday" (single calculation) as the end date for all.
 */
function buildReportConfigs(recentFriday) {
  const endDisplay = formatDdMmYyyy(recentFriday);
  const endShort = formatEndShortDDMonYY(recentFriday);

  // For the "6 months earlier" naming you requested (Sep -> Apr),
  // we subtract 5 months from the recentFriday month index to get Apr.
  const offsets = [
    { monthsBack: 5, label: '6monthsEarlier' }, // produces Apr25 for Sep
    { monthsBack: 4, label: '5monthsEarlier' }, // May
    { monthsBack: 3, label: '4monthsEarlier' }  // Jun
  ];

  const configs = offsets.map(o => {
    const start = new Date(recentFriday.getFullYear(), recentFriday.getMonth() - o.monthsBack, 1);
    const startDisplay = formatDdMmYyyy(start);
    const startShort = formatStartMMMYY(start);
    // file format: chapter-palms-report_Apr25-19Sep25
    const fileName = `chapter-palms-report_${startShort}-${endShort}`;
    return { label: o.label, startDisplay, endDisplay, fileName };
  });

  // From Jan 1st of this year
  const jan1 = new Date(recentFriday.getFullYear(), 0, 1);
  configs.push({
    label: 'FromJan',
    startDisplay: formatDdMmYyyy(jan1),
    endDisplay,
    fileName: `chapter-palms-report_Jan${String(jan1.getFullYear()).slice(-2)}-${endShort}`
  });

  // From 1st of this month (special "WeekN" naming)
  const firstOfMonth = new Date(recentFriday.getFullYear(), recentFriday.getMonth(), 1);
  const weekNum = getFridayWeekNumber(recentFriday); // 1-based Friday-count
  configs.push({
    label: 'FromThisMonth',
    startDisplay: formatDdMmYyyy(firstOfMonth),
    endDisplay,
    fileName: `chapter-palms-report_${formatStartMMMYY(firstOfMonth)}-Week${weekNum}`
  });

  return configs;
}

/**
 * Robust fill function: tries datepicker('setDate') if jQuery UI exists,
 * otherwise falls back to setting visible value + dispatching events,
 * then forces the hidden fields (MM/DD/YYYY) as a fallback.
 *
 * Note: this function DOES NOT click the Search button — the caller triggers it.
 */
async function setDatesOnPage(page, startDisplay, endDisplay) {
  // ensure inputs exist
  await page.waitForSelector('#startDateChapterChapterPALMSReportDisplay', { visible: true });
  await page.waitForSelector('#endDateChapterChapterPALMSReportDisplay', { visible: true });

  // helper to convert dd/mm/yyyy -> Date within page context
  const result = await page.evaluate(
    async ({ startDisplay, endDisplay }) => {
      const $ = window.jQuery || window.$;
      const startSel = '#startDateChapterChapterPALMSReportDisplay';
      const endSel = '#endDateChapterChapterPALMSReportDisplay';
      const startHiddenSel = '#startDateChapterChapterPALMSReport';
      const endHiddenSel = '#endDateChapterChapterPALMSReport';

      const startEl = document.querySelector(startSel);
      const endEl = document.querySelector(endSel);
      const startHiddenEl = document.querySelector(startHiddenSel);
      const endHiddenEl = document.querySelector(endHiddenSel);

      if (!startEl || !endEl) {
        return { error: 'visible date inputs not found' };
      }

      const parseDMY = s => {
        const [dd, mm, yyyy] = s.split('/');
        return new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
      };

      let usedDatepicker = false;
      if ($ && $.datepicker && typeof $(startEl).datepicker === 'function') {
        try {
          $(startEl).datepicker('setDate', parseDMY(startDisplay));
          $(endEl).datepicker('setDate', parseDMY(endDisplay));
          $(startEl).trigger('change').trigger('blur');
          $(endEl).trigger('change').trigger('blur');
          usedDatepicker = true;
        } catch (e) {
          usedDatepicker = false;
        }
        await new Promise(r => setTimeout(r, 300));
      }

      // fallback: DOM value + events
      if (startEl.value !== startDisplay || endEl.value !== endDisplay) {
        startEl.focus();
        startEl.value = startDisplay;
        startEl.dispatchEvent(new Event('input', { bubbles: true }));
        startEl.dispatchEvent(new Event('change', { bubbles: true }));
        startEl.dispatchEvent(new Event('blur', { bubbles: true }));

        endEl.focus();
        endEl.value = endDisplay;
        endEl.dispatchEvent(new Event('input', { bubbles: true }));
        endEl.dispatchEvent(new Event('change', { bubbles: true }));
        endEl.dispatchEvent(new Event('blur', { bubbles: true }));

        await new Promise(r => setTimeout(r, 300));
      }

      // fallback: force hidden fields to MM/DD/YYYY (many datepickers store that)
      const toHidden = s => {
        const [dd, mm, yyyy] = s.split('/');
        return `${mm}/${dd}/${yyyy}`;
      };

      if (startHiddenEl) {
        startHiddenEl.value = toHidden(startDisplay);
        startHiddenEl.dispatchEvent(new Event('input', { bubbles: true }));
        startHiddenEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (endHiddenEl) {
        endHiddenEl.value = toHidden(endDisplay);
        endHiddenEl.dispatchEvent(new Event('input', { bubbles: true }));
        endHiddenEl.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // click body to trigger blur handlers
      document.body.click();
      await new Promise(r => setTimeout(r, 300));

      return {
        usedDatepicker,
        displayStart: document.querySelector(startSel).value,
        displayEnd: document.querySelector(endSel).value,
        hiddenStart: startHiddenEl ? startHiddenEl.value : null,
        hiddenEnd: endHiddenEl ? endHiddenEl.value : null
      };
    },
    { startDisplay, endDisplay }
  );

  return result;
}

/**
 * Run a single report: set dates, click search, wait for iframe,
 * click export inside iframe, wait for file, rename file, close modal.
 */
async function runOneReport(page, downloadFolder, config) {
  console.log(`\n▶ Running report: ${config.label} -> ${config.fileName}`);

  // Make sure the input fields are visible and page is ready
  await page.waitForSelector('#startDateChapterChapterPALMSReportDisplay', { visible: true, timeout: 10000 });

  // Set the dates (robust)
  const setResult = await setDatesOnPage(page, config.startDisplay, config.endDisplay);
  console.log('setDates result:', setResult);
  if (setResult.error) throw new Error('Could not set date inputs on page: ' + setResult.error);

  // Click the search button
  // record start time BEFORE clicking so waitForFile filters by mtime > startedAt
  const startedAt = Date.now();
  await page.click('#button'); // <- your Search button selector

  // Wait for report iframe
  console.log('Waiting for report iframe...');
  const iframeElementHandle = await page.waitForSelector('iframe[src*="WebReport"]', { visible: true, timeout: 60000 });
  const frame = await iframeElementHandle.contentFrame();
  if (!frame) throw new Error('Could not get content frame of report iframe.');

  // Click Export (inside iframe)
  console.log('Clicking Export inside iframe...');
  await frame.waitForSelector('#links_1', { visible: true, timeout: 30000 });
  await frame.click('#links_1');

  // Wait for file to appear
  const downloadedPath = await waitForFile(downloadFolder, startedAt, 90000);
  console.log('Downloaded file path:', downloadedPath);

  // Rename file to your requested naming scheme (preserve extension)
  const ext = path.extname(downloadedPath) || '.xls';
  const newFilePath = path.join(downloadFolder, `${config.fileName}${ext}`);
  try {
    fs.renameSync(downloadedPath, newFilePath);
    console.log(`Renamed downloaded file -> ${newFilePath}`);
  } catch (err) {
    console.warn('Rename failed, leaving original filename. Error:', err);
  }

  // Close modal (if present) and wait for iframe removal
  try {
    const closeModalSelector = '.ui-dialog-titlebar-close';
    await page.waitForSelector(closeModalSelector, { visible: true, timeout: 5000 });
    await page.click(closeModalSelector);
    // Wait for iframe to disappear
    await page.waitForSelector('iframe[src*="WebReport"]', { hidden: true, timeout: 5000 });
    console.log('Modal closed and iframe removed.');
  } catch (err) {
    console.log('Modal close either not present or already closed. Continuing.');
  }

  // short pause to ensure UI is stable for next iteration
  await page.waitForTimeout(800);
}

(async () => {
  let browser, page;
  try {
    console.log('--- Starting BNI Connect multi-report script ---');

    // Basic validation
    if (!BNI_USERNAME || !BNI_PASSWORD) {
      console.error('Missing BNI_USERNAME or BNI_PASSWORD env vars.');
      process.exit(1);
    }

    // Launch browser
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    page = await browser.newPage();
    page.setDefaultTimeout(90000);
    await page.setViewport({ width: 1280, height: 960 });

    // Prepare download folder
    if (!fs.existsSync(LOCAL_DOWNLOAD_FOLDER)) fs.mkdirSync(LOCAL_DOWNLOAD_FOLDER, { recursive: true });
    // clear old files to avoid false positives (optional but recommended in CI)
    const existing = fs.readdirSync(LOCAL_DOWNLOAD_FOLDER);
    for (const f of existing) {
      try { fs.unlinkSync(path.join(LOCAL_DOWNLOAD_FOLDER, f)); } catch (e) { /* ignore */ }
    }

    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: LOCAL_DOWNLOAD_FOLDER });
    console.log('Download behavior configured.');

    // --- LOGIN & NAVIGATION (kept from your script) ---
    console.log('Navigating to login...');
    await page.goto('https://www.bniconnectglobal.com/login/', { waitUntil: 'networkidle2' });
    await page.waitForSelector("input[name='username']", { visible: true });
    await page.type("input[name='username']", BNI_USERNAME, { delay: 50 });
    await page.type("input[name='password']", BNI_PASSWORD, { delay: 50 });
    await Promise.all([ page.click("button[type='submit']"), page.waitForNavigation({ waitUntil: 'networkidle0' }) ]);
    console.log('Logged in.');

    // Switch to legacy & navigate to PALMS summary (kept from your script)
    await page.waitForSelector('.css-hp1qy7 > svg', { visible: true, timeout: 30000 });
    await page.click('.css-hp1qy7 > svg');
    await page.waitForSelector('a[href*="operationsHome"]', { visible: true });
    await page.click('a[href="#ui-tabs-3"]');
    const enterPalmsSelector = 'a[href*="reportsChapterPALMSForm"]';
    await page.waitForSelector(enterPalmsSelector, { visible: true });
    await page.click(enterPalmsSelector);
    await page.waitForSelector('#startDateChapterChapterPALMSReportDisplay', { visible: true });
    console.log('On PALMS Summary page.');

    // compute recentFriday and report configs
    const recentFriday = getRecentFriday();
    console.log('Recent Friday (end for all reports):', formatDdMmYyyy(recentFriday));
    const configs = buildReportConfigs(recentFriday);
    console.log('Will pull these reports:');
    configs.forEach(c => console.log(' -', c.fileName, '|', c.startDisplay, '→', c.endDisplay));

    // Loop through each report config
    for (const config of configs) {
      await runOneReport(page, LOCAL_DOWNLOAD_FOLDER, config);
    }

    console.log('All reports completed.');
  } catch (error) {
    console.error('❌ Automation error:', error);
    if (page) {
      try {
        await page.screenshot({ path: './error_screenshot.png', fullPage: true });
        console.error('Saved error screenshot: ./error_screenshot.png');
      } catch (e) {
        console.error('Could not save screenshot.', e);
      }
    }
    process.exit(1);
  } finally {
    if (browser) {
      console.log('Closing browser...');
      await browser.close();
    }
    console.log('--- Script finished ---');
  }
})();
