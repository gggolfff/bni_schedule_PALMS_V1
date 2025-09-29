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

/**
 * Polls a directory for a new file to appear.
 */
const waitForFile = (dirPath, timeout = 90000) => {
  console.log(`Waiting for a new download in: ${dirPath} (timeout ${timeout/1000}s)`);
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
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
        reject(new Error(`Download timeout after ${timeout/1000}s`));
      }
    }, 1000);
  });
};

/**
 * Sets visible + hidden date fields robustly.
 */
async function setDates(page, startDateFormatted, endDateFormatted) {
  // Convert dd/mm/yyyy → mm/dd/yyyy for hidden inputs
  const ddmmyyyyToMmddyyyy = s => {
    const [dd, mm, yyyy] = s.split('/');
    return `${mm}/${dd}/${yyyy}`;
  };

  const startHiddenFormat = ddmmyyyyToMmddyyyy(startDateFormatted);
  const endHiddenFormat = ddmmyyyyToMmddyyyy(endDateFormatted);

  const result = await page.evaluate(
    async ({ startDisplay, endDisplay, startHidden, endHidden }) => {
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
        return { error: 'visible inputs not found' };
      }

      const parseDMY = s => {
        const [dd, mm, yyyy] = s.split('/');
        return new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
      };

      let usedDatepicker = false;
      if ($ && $.datepicker) {
        try {
          $(startEl).datepicker('setDate', parseDMY(startDisplay));
          $(endEl).datepicker('setDate', parseDMY(endDisplay));
          $(startEl).trigger('change').trigger('blur');
          $(endEl).trigger('change').trigger('blur');
          usedDatepicker = true;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 300));
      }

      if (startEl.value !== startDisplay || endEl.value !== endDisplay) {
        startEl.value = startDisplay;
        startEl.dispatchEvent(new Event('input', { bubbles: true }));
        startEl.dispatchEvent(new Event('change', { bubbles: true }));
        endEl.value = endDisplay;
        endEl.dispatchEvent(new Event('input', { bubbles: true }));
        endEl.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
      }

      if (startHiddenEl) startHiddenEl.value = startHidden;
      if (endHiddenEl) endHiddenEl.value = endHidden;

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
    { startDisplay: startDateFormatted, endDisplay: endDateFormatted, startHidden: startHiddenFormat, endHidden: endHiddenFormat }
  );

  console.log('setDates result:', result);
}

/**
 * Runs one report, downloads & renames it.
 */
async function runOneReport(page, report) {
  console.log(`▶ Running report: ${report.key} -> ${report.filename}`);

  await setDates(page, report.start, report.end);
  await page.click('#button');
  const iframeElementHandle = await page.waitForSelector('iframe[src*="WebReport"]', { visible: true });
  const frame = await iframeElementHandle.contentFrame();

  await frame.waitForSelector('#links_1', { visible: true });
  await frame.click('#links_1');

  const downloadedPath = await waitForFile(LOCAL_DOWNLOAD_FOLDER, 90000);
  const newPath = path.join(LOCAL_DOWNLOAD_FOLDER, `${report.filename}.xls`);
  fs.renameSync(downloadedPath, newPath);
  console.log(`Renamed downloaded file -> ${newPath}`);

  try {
    const closeModalSelector = '.ui-dialog-titlebar-close';
    await page.waitForSelector(closeModalSelector, { visible: true, timeout: 5000 });
    await page.click(closeModalSelector);
    console.log('Modal closed and iframe removed.');
  } catch {}
  await wait(800); // replaced page.waitForTimeout
}

/**
 * Main runner
 */
(async () => {
  console.log('--- Starting BNI Connect multi-report script ---');
  if (!BNI_USERNAME || !BNI_PASSWORD) {
    console.error('Missing credentials in env vars.');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);

  // ensure download folder exists
  if (!fs.existsSync(LOCAL_DOWNLOAD_FOLDER)) {
    fs.mkdirSync(LOCAL_DOWNLOAD_FOLDER, { recursive: true });
  }
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: LOCAL_DOWNLOAD_FOLDER,
  });
  console.log('Download behavior configured.');

  // --- LOGIN ---
  console.log('Navigating to login...');
  await page.goto('https://www.bniconnectglobal.com/login/', { waitUntil: 'networkidle2' });
  await page.type("input[name='username']", BNI_USERNAME, { delay: 50 });
  await page.type("input[name='password']", BNI_PASSWORD, { delay: 50 });
  await Promise.all([
    page.click("button[type='submit']"),
    page.waitForNavigation({ waitUntil: 'networkidle0' })
  ]);
  console.log('Logged in.');

  // --- Switch to legacy view ---
  const legacyIconSelector = '.css-hp1qy7 > svg';
  await page.waitForSelector(legacyIconSelector, { visible: true });
  await page.click(legacyIconSelector);
  await page.waitForSelector('a[href*="operationsHome"]', { visible: true });

  // --- Navigate to PALMS Summary ---
  await page.click('a[href="#ui-tabs-3"]');
  const enterPalmsSelector = 'a[href*="reportsChapterPALMSForm"]';
  await page.waitForSelector(enterPalmsSelector, { visible: true });
  await page.click(enterPalmsSelector);
  await page.waitForSelector('#startDateChapterChapterPALMSReportDisplay', { visible: true });
  console.log('On PALMS Summary page.');

  // --- Calculate dates ---
  const today = new Date();
  const day = today.getDay();
  const diff = (day >= 5) ? (day - 5) : (day + 2);
  const recentFriday = new Date(today);
  recentFriday.setDate(today.getDate() - diff);

  const dd = String(recentFriday.getDate()).padStart(2, '0');
  const mm = String(recentFriday.getMonth() + 1).padStart(2, '0');
  const yyyy = recentFriday.getFullYear();
  const endDate = `${dd}/${mm}/${yyyy}`;

  console.log(`Recent Friday (end for all reports): ${endDate}`);

  const makeDate = (d, m, y) => `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;

  const reports = [
    { key: '6monthsEarlier', start: makeDate(1, recentFriday.getMonth() - 5 <= 0 ? 12 + (recentFriday.getMonth() - 5) : recentFriday.getMonth() - 5 + 1, recentFriday.getMonth() - 5 <= 0 ? yyyy - 1 : yyyy), end: endDate, filename: `chapter-palms-report_Apr25-${endDate.replace(/\//g, '')}` },
    { key: '5monthsEarlier', start: makeDate(1, recentFriday.getMonth() - 4, yyyy), end: endDate, filename: `chapter-palms-report_May25-${endDate.replace(/\//g, '')}` },
    { key: '4monthsEarlier', start: makeDate(1, recentFriday.getMonth() - 3, yyyy), end: endDate, filename: `chapter-palms-report_Jun25-${endDate.replace(/\//g, '')}` },
    { key: 'yearStart', start: `01/01/${yyyy}`, end: endDate, filename: `chapter-palms-report_Jan25-${endDate.replace(/\//g, '')}` },
    { key: 'monthStart', start: makeDate(1, recentFriday.getMonth() + 1, yyyy), end: endDate, filename: `chapter-palms-report_Sep25-Week${Math.ceil(recentFriday.getDate() / 7)}` }
  ];

  console.log('Will pull these reports:');
  reports.forEach(r => console.log(` - ${r.filename} | ${r.start} → ${r.end}`));

  for (const r of reports) {
    await runOneReport(page, r);
  }

  await browser.close();
  console.log('--- Script finished ---');
})();
