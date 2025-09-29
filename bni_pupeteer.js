/**
 * @file BNI Connect Puppeteer Automation Script (Multi-report)
 * @description Automates logging into BNI Connect, downloading PALMS Summary Reports
 * for multiple date ranges, and saving them with meaningful names.
 *
 * Compatible with old + new Puppeteer (uses wait(ms) instead of page.waitForTimeout).
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// --- Helper: universal timeout (replaces page.waitForTimeout) ---
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- CONFIGURATION ---
const BNI_USERNAME = process.env.BNI_USERNAME;
const BNI_PASSWORD = process.env.BNI_PASSWORD;
const LOCAL_DOWNLOAD_FOLDER = path.resolve('./downloads');
// --- END CONFIG ---

// --- Month abbreviations for filename formatting ---
const MONTH_ABBREV = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Polls a directory for a new file to appear.
 */
const waitForFile = (dirPath, timeout = 90000) => {
  console.log(`Waiting for a new download in: ${dirPath} (timeout ${timeout/1000}s)`);
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const seen = new Set(fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : []);
    const interval = setInterval(() => {
      const files = fs.readdirSync(dirPath).filter(f => !f.endsWith('.crdownload') && !f.startsWith('.'));
      const newFile = files.find(f => !seen.has(f));
      if (newFile) {
        clearInterval(interval);
        console.log(`Download detected: ${newFile}`);
        return resolve(path.join(dirPath, newFile));
      }
      if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        return reject(new Error(`Download timeout after ${timeout/1000}s`));
      }
    }, 1000);
  });
};

/**
 * Date formatting helpers
 */
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
  const dd = String(date.getDate()).padStart(2, '0');
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
 * Build the 5 report configurations (startDisplay, endDisplay, filename, label)
 */
function buildReportConfigs(recentFriday) {
  const endDisplay = formatDdMmYyyy(recentFriday);
  const endShort = formatEndShortDDMonYY(recentFriday);

  const offsets = [
    { monthsBack: 5, label: '6monthsEarlier' }, // Sep -> Apr
    { monthsBack: 4, label: '5monthsEarlier' }, // Sep -> May
    { monthsBack: 3, label: '4monthsEarlier' }  // Sep -> Jun
  ];

  const configs = offsets.map(o => {
    const start = new Date(recentFriday.getFullYear(), recentFriday.getMonth() - o.monthsBack, 1);
    const startDisplay = formatDdMmYyyy(start);
    const startShort = formatStartMMMYY(start);
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

  // From 1st of this month with WeekN naming (no end date in filename)
  const firstOfMonth = new Date(recentFriday.getFullYear(), recentFriday.getMonth(), 1);
  const weekNum = getFridayWeekNumber(recentFriday);
  configs.push({
    label: 'FromThisMonth',
    startDisplay: formatDdMmYyyy(firstOfMonth),
    endDisplay,
    fileName: `chapter-palms-report_${formatStartMMMYY(firstOfMonth)}-Week${weekNum}`
  });

  return configs;
}

/**
 * Robustly set date inputs on the page (tries datepicker API then DOM/events).
 */
async function setDatesOnPage(page, startDisplay, endDisplay) {
  await page.waitForSelector('#startDateChapterChapterPALMSReportDisplay', { visible: true });
  await page.waitForSelector('#endDateChapterChapterPALMSReportDisplay', { visible: true });

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

      if (!startEl || !endEl) return { error: 'visible date inputs not found' };

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
        } catch (e) { usedDatepicker = false; }
        await new Promise(r => setTimeout(r, 300));
      }

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

      // hidden fields often need MM/DD/YYYY
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

      document.body.click();
      await new Promise(r => setTimeout(r, 300));

      return {
        usedDatepicker,
        displayStart: startEl.value,
        displayEnd: endEl.value,
        hiddenStart: startHiddenEl ? startHiddenEl.value : null,
        hiddenEnd: endHiddenEl ? endHiddenEl.value : null
      };
    },
    { startDisplay, endDisplay }
  );

  console.log('setDates result:', result);
  if (result.error) throw new Error(result.error);
}

/**
 * Runs one report: set dates, click Search, export inside iframe, wait for file, rename, close modal.
 */
async function runOneReport(page, downloadFolder, cfg) {
  console.log(`\n▶ Running report: ${cfg.label} -> ${cfg.fileName}`);

  await setDatesOnPage(page, cfg.startDisplay, cfg.endDisplay);

  // Click search
  await page.click('#button'); // adjust if selector differs

  // Wait for iframe & click Export
  console.log('Waiting for report iframe...');
  const iframeElementHandle = await page.waitForSelector('iframe[src*="WebReport"]', { visible: true, timeout: 60000 });
  const frame = await iframeElementHandle.contentFrame();
  if (!frame) throw new Error('Could not access report iframe.');

  console.log('Clicking Export inside iframe...');
  await frame.waitForSelector('#links_1', { visible: true, timeout: 30000 });
  await frame.click('#links_1');

  // Wait for file to appear and rename preserving extension
  const downloadedPath = await waitForFile(downloadFolder, 90000);
  const ext = path.extname(downloadedPath) || '.xls';
  const newPath = path.join(downloadFolder, `${cfg.fileName}${ext}`);
  try {
    fs.renameSync(downloadedPath, newPath);
    console.log(`Renamed downloaded file -> ${newPath}`);
  } catch (err) {
    console.warn('Failed to rename file, leaving original name. Error:', err);
  }

  // Close modal
  try {
    const closeModalSelector = '.ui-dialog-titlebar-close';
    await page.waitForSelector(closeModalSelector, { visible: true, timeout: 5000 });
    await page.click(closeModalSelector);
    await page.waitForSelector('iframe[src*="WebReport"]', { hidden: true, timeout: 5000 });
    console.log('Modal closed and iframe removed.');
  } catch (e) {
    console.log('Modal did not close normally (continuing).', e.message || e);
  }

  await wait(800);
}

// ---------------- Main flow ----------------
(async () => {
  console.log('--- Starting BNI Connect multi-report script ---');

  if (!BNI_USERNAME || !BNI_PASSWORD) {
    console.error('Missing BNI_USERNAME or BNI_PASSWORD env vars.');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  await page.setViewport({ width: 1280, height: 960 });

  // Prepare download folder
  if (!fs.existsSync(LOCAL_DOWNLOAD_FOLDER)) fs.mkdirSync(LOCAL_DOWNLOAD_FOLDER, { recursive: true });
  // clear old files
  for (const f of fs.readdirSync(LOCAL_DOWNLOAD_FOLDER)) {
    try { fs.unlinkSync(path.join(LOCAL_DOWNLOAD_FOLDER, f)); } catch (_) {}
  }

  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: LOCAL_DOWNLOAD_FOLDER });
  console.log('Download behavior configured.');

  // LOGIN
  console.log('Navigating to login...');
  await page.goto('https://www.bniconnectglobal.com/login/', { waitUntil: 'networkidle2' });
  await page.waitForSelector("input[name='username']", { visible: true });
  await page.type("input[name='username']", BNI_USERNAME, { delay: 50 });
  await page.type("input[name='password']", BNI_PASSWORD, { delay: 50 });
  await Promise.all([ page.click("button[type='submit']"), page.waitForNavigation({ waitUntil: 'networkidle0' }) ]);
  console.log('Logged in.');

  // Switch to legacy and navigate to PALMS Summary
  await page.waitForSelector('.css-hp1qy7 > svg', { visible: true, timeout: 30000 });
  await page.click('.css-hp1qy7 > svg');
  await page.waitForSelector('a[href="#ui-tabs-3"]', { visible: true });
  await page.click('a[href="#ui-tabs-3"]');
  const enterPalmsSelector = 'a[href*="reportsChapterPALMSForm"]';
  await page.waitForSelector(enterPalmsSelector, { visible: true });
  await page.click(enterPalmsSelector);
  await page.waitForSelector('#startDateChapterChapterPALMSReportDisplay', { visible: true, timeout: 20000 });
  console.log('On PALMS Summary page.');

  // Compute recent Friday and configs
  const recentFriday = getRecentFriday();
  console.log('Recent Friday (end for all reports):', formatDdMmYyyy(recentFriday));
  const configs = buildReportConfigs(recentFriday);
  console.log('Will pull these reports:');
  configs.forEach(c => console.log(` - ${c.fileName} | ${c.startDisplay} → ${c.endDisplay}`));

  // Run reports
  for (const cfg of configs) {
    await runOneReport(page, LOCAL_DOWNLOAD_FOLDER, { label: cfg.label, startDisplay: cfg.startDisplay, endDisplay: cfg.endDisplay, fileName: cfg.fileName });
  }

  await browser.close();
  console.log('--- Script finished ---');
})();
