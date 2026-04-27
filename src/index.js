const actor       = require('../package.json');
const apify       = require('apify');
const BunzWrapper = require('./bunz-wrapper.js');
const GS          = require('google-spreadsheet');
const GAL         = require('google-auth-library');

const gsPauseLong  = 1000; // 1 second. Only applies to Google Sheets costly operations.
const gsPauseShort = 100;  // 100 msec. Only applies to Google Sheets cheap operations.

const colorBlack   = { red: 0   , green: 0   , blue: 0    };
const colorWhite   = { red: 1   , green: 1   , blue: 1    };
const colorGray    = { red: 0.75, green: 0.75, blue: 0.75 };
const colorRed     = { red: 1   , green: 0.75, blue: 0.75 };
const colorGreen   = { red: 0.75, green: 1   , blue: 0.75 };
const colorBlue    = { red: 0.75, green: 1   , blue: 1    };

const defLocale    = 'de-DE';

const deDate = new Intl.DateTimeFormat(
    defLocale,
    {
        timeZone: 'UTC',
        day     : '2-digit',
        month   : '2-digit',
        year    : 'numeric'
    }
);

async function downloadProfits(apiWrapper, dateStart, existingProfits) {
    const ret   = {
        status  : false,
        message : '',
        profits : existingProfits
    };
    try {
        const periods   = ret.profits.periods;
        const firstDate = getUTCDateEnd();
        let dateCurrent  = getUTCDateStart(dateStart);
        let monthCurrent = -1;
        let profits;
        while (dateCurrent <= firstDate) {
            const dayISO = dateCurrent.toISOString();
            if (monthCurrent != dateCurrent.getUTCMonth()) {
                monthCurrent = dateCurrent.getUTCMonth();
                const period = periods.find(
                    function (p) {
                        return p.year  == dateCurrent.getUTCFullYear() &&
                               p.month == monthCurrent + 1;
                    }
                );
                if (period) {
                    profits = period.dailyProfits;
                }
                else {
                    periods.push({
                        year         : dateCurrent.getUTCFullYear(),
                        month        : monthCurrent + 1,
                        dailyProfits : []
                    });
                    profits = periods[periods.length - 1].dailyProfits;
                }
            }
            const profit = profits.find(
                function (p) {
                    return p.date == dayISO;
                }
            );
            if (profit) {
                throw new Error(`getEarnings() failed [ profit for ${dayISO} already exists]`);
            }
            profits.push({
                date   : dayISO,
                profit : 0
            });
            dateCurrent = getUTCDateNext(dateCurrent);
        }
        if (!await apiWrapper.getEarnings(dateStart)) {
            throw new Error(`getEarnings() failed [ ${apiWrapper.lastError} ]`);
        }
        else {
            let txtPer;
            for (const e of apiWrapper.lastResult) {
                const id     = e?.id;
                const settle = new Date(e?.settleDate);
                const value  = e?.sharingCalculationAmount?.value    || 0;
                const curr   = e?.sharingCalculationAmount?.currency || '';
                if (isNaN(settle)) {
                    throw new Error(`getEarnings() failed [ invalid settleDate in transaction ${id} ]`);
                }
                if (curr != 'EUR') {
                    throw new Error(`getEarnings() failed [ unexpected currency in transaction ${id}: '${curr}' ]`);
                }
                const setPer = `period ${settle.getUTCFullYear()}.${settle.getUTCMonth() + 1}`;
                const setISO = settle.toISOString();
                const dayISO = getUTCDateStart(settle).toISOString();
                const period = periods.find(
                    function (p) {
                        return p.year  == settle.getUTCFullYear() &&
                               p.month == settle.getUTCMonth() + 1;
                    }
                );
                if (!period) {
                    throw new Error(`getEarnings() failed [ out-of-range year/month in transaction ${id}: ${setISO} ]`);
                }
                const profit = period.dailyProfits.find(
                    function (p) {
                        return p.date == dayISO;
                    }
                );
                if (!profit) {
                    throw new Error(`getEarnings() failed [ out-of-range date in transaction ${id}: ${setISO} ]`);
                }
                profit.profit += value;
                if (txtPer != setPer) {
                    txtPer = setPer;
                    console.log();
                    console.log(txtPer);
                }
                console.log(`${dayISO.split('T')[0]}: ${value.toFixed(2)}`);
            }
        }
        ret.status = true;
    }
    catch (err) {
        ret.message = `downloadProfits() failed [ ${err.message} ]`;
    }
    return ret;
}

function formatCell(c,
                    foregroundColor = colorBlack, backgroundColor = colorWhite,
                    borderColor = false, bold = false, currency = false, percent = false) {
    c.backgroundColor = backgroundColor;
    const border      = borderColor ? { style: 'SOLID', color: borderColor } : null;
    c.borders         = {
        top   : border,
        bottom: border,
        left  : border,
        right : border
    };
    if (currency) {
        c.numberFormat = {
            type   : 'CURRENCY',
            pattern: '\u20AC#,##0.00',
        };
    }
    else if (percent) {
        c.numberFormat = {
            type   : 'PERCENT',
            pattern: '0%',
        };
    }
    c.horizontalAlignment = 'CENTER';
    c.verticalAlignment   = 'MIDDLE';
    c.wrapStrategy        = 'WRAP';
    c.textFormat          = { foregroundColor, bold };
}

async function getAccountProfits(identifier, password, share, profitsFrom, actorProfits, apiParams) {
    const ret   = {
        status  : false,
        message : '',
        profits : {}
    };
    const zw = new BunzWrapper();
    zw.config.proxy    = getHTTPProxy;
    zw.config.cooldown = apiParams.cooldown;
    zw.config.threads  = apiParams.threads;
    zw.config.lives    = apiParams.lives;
    zw.config.factor   = apiParams.factor;
    try {
        const accountFound = Object.values(actorProfits).find(p => p.id === identifier);
        const accountName  = accountFound ? accountFound.name : identifier;
        if (!await zw.login(identifier, password)) {
            throw new Error(`login(${accountName}) failed [ ${zw.lastError} ]`);
        }
        const userId       = zw.config.session.user.id;
        const userName     = zw.config.session.user.username;
        const userEmail    = zw.config.session.user.email;
        const user1stDate  = zw.config.session.user.firstEarningDate || '';
        const userCreator  = zw.config.session.user.roles.some(r => r.toLowerCase().includes("creator"));
        console.log(`logged in as ${userName} ` +
                    `(earnings from ${user1stDate ? user1stDate.split('T')[0] : 'N/A'})`);
        console.log();
        const dateCreated  = new Date(user1stDate || 0);
        const dateFrom     = getUTCDateStart(dateCreated < profitsFrom ? profitsFrom : dateCreated);
        const profits      = {
            id             : userEmail,
            name           : userName,
            share,
            periods        : []
        };
        if (!userCreator) {
            throw new Error(`${userName} is not a creator`);
        }
        console.log(`checking balance for account '${userName}'`);
        if (!await zw.getBalance()) {
            throw new Error(`getBalance() failed [ ${zw.lastError} ]`);
        }
        if (zw.lastResult.estimated) {
            const estimated = zw.lastResult.estimated;
            console.log(`[estimated] ${estimated.amount || 0} ${estimated.currency || ''}`);
        }
        else if (zw.lastResult.current) {
            const current = zw.lastResult.current;
            console.log(`[current] ${current.amount || 0} ${current.currency || ''}`);
        }
        else {
            console.log('[unknown]');
        }
        console.log();
        let startDate = dateFrom;
        if (!actorProfits[userId]) {
            console.log(`grabbing stats for account '${userName}'`);
        }
        else {
            console.log(`updating stats for account '${userName}'`);
            const periods = actorProfits[userId].periods;
            if (periods.length) {
                const lastPeriodDays = periods[periods.length - 1].dailyProfits;
                if (!lastPeriodDays.length) {
                    periods.pop();
                }
                else {
                    const lastPeriodDate = lastPeriodDays[lastPeriodDays.length - 1].date;
                    lastPeriodDays.pop();
                    if (!lastPeriodDays.length) {
                        periods.pop();
                    }
                }
                profits.periods = periods;
            }
            for (const p of periods) {
                for (const d of p.dailyProfits) {
                    startDate = getUTCDateNext(new Date(d.date));
                }
            }
        }
        const r = await downloadProfits(zw, startDate, profits);
        if (!r.status) {
            throw new Error(r.message);
        }
        else {
            ret.status  = true;
            ret.profits = r.profits;
        }
        actorProfits[userId] = r.profits;
        console.log();
    }
    catch (err) {
        ret.message = `getAccountProfits() failed [ ${err.message} ]`;
    }
    finally {
        if (zw.config.session.token) {
            if (!await zw.logout()) {
                console.warn(`logout() failed [ ${zw.lastError} ]`);
            }
            else {
                console.log(`logged off`);
            }
        }
    }
    return ret;
}

async function getHTTPProxy() {
    let proxy = '';
    const proxyUsageInfo = (await apify.Actor.getInput()).adv_proxy_usage;
    if (proxyUsageInfo) {
        if (proxyUsageInfo.useApifyProxy) {
            let proxyOptions = {};
            if (Array.isArray(proxyUsageInfo.apifyProxyGroups)) {
                if (proxyUsageInfo.apifyProxyGroups.length) {
                    proxyOptions.groups = proxyUsageInfo.apifyProxyGroups;
                }
            }
            if (proxyUsageInfo.apifyProxyCountry) {
                proxyOptions.countryCode = proxyUsageInfo.apifyProxyCountry;
            }
            const proxyConfig = await apify.Actor.createProxyConfiguration(proxyOptions);
            proxy = await proxyConfig.newUrl();
        }
        else if (Array.isArray(proxyUsageInfo.proxyUrls)) {
            if (proxyUsageInfo.proxyUrls.length) {
                const rndx = Math.trunc(Math.random()*proxyUsageInfo.proxyUrls.length);
                proxy = proxyUsageInfo.proxyUrls[rndx];
            }
        }
    }
    return proxy;
}

function getUTCDateEnd(d = new Date()) {
    return new Date(`${d.toISOString().split('T')[0]}T23:59:59Z`);
}

function getUTCDateNext(d = new Date()) {
    return new Date(getUTCDateStart(d).getTime() + 86400000);
}

function getUTCDateStart(d = new Date()) {
    return new Date(`${d.toISOString().split('T')[0]}T00:00:00Z`);
}

function getUTCPeriod(year, month, locale = defLocale) {
    const utcDate      = new Date(Date.UTC(year, month - 1, 1));
    const utcMonthName = utcDate.toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' });
    return utcMonthName.concat(`, ${year}`);
}

async function importAccounts(doc, config) {
    const ret    = {
        accounts : [],
        status   : false,
        message  : ''
    };
    try {
        const sheets = doc.sheetsByTitle;
        const sheet  = sheets[config.sheet];
        if (!sheet) {
            ret.message = `'${config.sheet}' sheet not found in document`;
        }
        else {
            await loadCells(sheet);
            await sleep(gsPauseLong);
            if (config.startrow > sheet.rowCount) {
                throw new Error(`start row (${config.startrow}) is beyond limits`);
            }
            let total = 0;
            for (let r = config.startrow; r <= sheet.rowCount; r++) {
                const accCell = sheet.getCellByA1(`${config.columns.account}${r}`);
                const chtCell = sheet.getCellByA1(`${config.columns.chatter}${r}`);
                const mgrCell = sheet.getCellByA1(`${config.columns.manager}${r}`);
                const emlCell = sheet.getCellByA1(`${config.columns.email}${r}`);
                const pwdCell = sheet.getCellByA1(`${config.columns.password}${r}`);
                if (!accCell) {
                    throw new Error(`account cell is unreachable for row ${r}`);
                }
                else if (!chtCell) {
                    throw new Error(`chatter cell is unreachable for row ${r}`);
                }
                else if (!mgrCell) {
                    throw new Error(`manager cell is unreachable for row ${r}`);
                }
                else if (!emlCell) {
                    throw new Error(`email cell is unreachable for row ${r}`);
                }
                else if (!pwdCell) {
                    throw new Error(`password cell is unreachable for row ${r}`);
                }
                let account;
                let share;
                account = accCell.value || '';
                share   = 0;
                const chatter  = chtCell.value || '';
                const manager  = mgrCell.value || '';
                const email    = emlCell.value || '';
                const password = pwdCell.value || '';
                if (typeof account !== 'string') {
                    throw new Error(`account value is invalid for row ${r}`);
                }
                else if (typeof chatter !== 'string') {
                    throw new Error(`chatter value is invalid for row ${r}`);
                }
                else if (typeof manager !== 'string') {
                    throw new Error(`manager value is invalid for row ${r}`);
                }
                else if (typeof email !== 'string') {
                    throw new Error(`email value is invalid for row ${r}`);
                }
                else if (typeof password !== 'string') {
                    throw new Error(`password value is invalid for row ${r}`);
                }
                accshr = account.trim().split(/ +/);
                if (accshr.length > 2) {
                    throw new Error(`malformed account value for row ${r}`);
                }
                else if (accshr.length == 2) {
                    account = accshr[0];
                    if (!accshr[1].startsWith('-')) {
                        throw new Error(`malformed account share for row ${r}`);
                    }
                    else if (isNaN(accshr[1].slice(1))) {
                        throw new Error(`invalid account share for row ${r}`);
                    }
                    else {
                        share = parseFloat(accshr[1].slice(1));
                        if (share < 0 || share > 100) {
                            throw new Error(`out of range (0-100) account share for row ${r}`);
                        }
                    }
                }
                if (account.length && email.length && password.length) {
                    const accEntry = {
                        account,
                        chatter,
                        manager,
                        email,
                        password
                    };
                    let inc = true;
                    let exc = false;
                    if (config.filters) {
                        const incFilters = config.filters.include;
                        if (incFilters) {
                            for (const incKey of Object.keys(incFilters)) {
                                if (incKey === 'password') {
                                    inc &&= incFilters[incKey].map(i => i.trim()).includes(accEntry[incKey].trim());
                                }
                                else {
                                    inc &&= incFilters[incKey].map(i => i.trim().toUpperCase()).includes(accEntry[incKey].trim().toUpperCase());
                                }
                                if (!inc) {
                                    break;
                                }
                            }
                        }
                        const excFilters = config.filters.exclude;
                        if (excFilters) {
                            exc = true;
                            for (const excKey of Object.keys(excFilters)) {
                                if (excKey === 'password') {
                                    exc &&= excFilters[excKey].map(i => i.trim()).includes(accEntry[excKey].trim());
                                }
                                else {
                                    exc &&= excFilters[excKey].map(i => i.trim().toUpperCase()).includes(accEntry[excKey].trim().toUpperCase());
                                }
                                if (!exc) {
                                    break;
                                }
                            }
                        }
                    }
                    if (inc && !exc) {
                        ret.accounts.push({
                            account,
                            identifier: email,
                            password,
                            share
                        });
                        const padLeft  = (s, n) => s.slice(0, n).padStart(n, ' ');
                        const padRight = (s, n) => s.slice(0, n).padEnd(n, ' ');
                        const shareTxt = share ? `${padLeft(Number(share).toString(), 3)}%` : '    ';
                        const accRow   = [
                            padLeft(`#${Number(total + 1).toString()}:`, 6),
                            `row ${padLeft(Number(r).toString(), 4)}`,
                            padRight(account, 20),
                            shareTxt,
                            padRight(chatter, 20),
                            padRight(manager, 10),
                            padRight(email, 30)
                        ];
                        console.log(accRow.join('  '));
                        total++;
                    }
                }
            }
            if (!total) {
                throw new Error('not a single valid account was imported');
            }
            else {
                ret.status = true;
                console.log();
            }
        }
    }
    catch (err) {
        ret.message = `'${config.sheet}' sheet: ${err.message}`;
    }
    return ret;
}

function loadAccountProfits(identifier, actorProfits) {
    const ret  = {
        status : false,
        message: '',
        profits: {}
    };
    try {
        const accountFound = Object.values(actorProfits).find(p => p.id === identifier);
        if (!accountFound) {
            throw new Error(`id '${identifier}' not found in store`);
        }
        ret.status  = true;
        ret.profits = accountFound;
    }
    catch (err) {
        ret.message = `loadAccountProfits() failed [ ${err.message} ]`;
    }
    return ret;
}

async function loadCells(sheet, rangeTxt = '', lives = 3) {
    if (rangeTxt) {
        console.log(`loading sheet '${sheet.title}' cells [${rangeTxt}]...`);
    }
    else {
        console.log(`loading sheet '${sheet.title}'...`);
    }
    let scTry = lives;
    let delay = 1;
    while (true) {
        try {
            await sheet.loadCells(rangeTxt);
            console.log('done');
            console.log();
            break;
        }
        catch (err) {
            const error = `** loadCells('${sheet.title}') failed: [${err.name}] ${err.message}`;
            scTry--;
            if (!scTry) {
                throw new Error(error);
            }
            else {
                console.warn(error);
                delay *= 5;
                console.log(`waiting ${delay} sec...`);
                await sleep(delay * 1000);
            }
        }
    }
}

async function makeReport(actor, doc, stats, isLazy, gsLives) {
    const ret  = {
        status : false,
        message: ''
    };
    const sheets         = doc.sheetsByTitle;
    const gesamtSheet    = sheets['Gesamt'];
    const monatlichSheet = sheets['Monatlich'];
    const globalTotals   = [];
    const periodTotals   = {};
    const dataColumns    = [
        'Date',
        'Chatter Name',
        'Chatter %',
        'Net Revenue Brezzels',
        'Payment Chatter',
        'Payment Model',
        'Final Profit'
    ];
    const globalColumns = [
        'Name',
        'Yesterday',
        'Today',
        'This month',
        'Final profit'
    ];
    const periodColumns = [
        'Period',
        'Net Revenue Brezzels',
        'Payment Chatters',
        'Payment Models',
        'Final Profit'
    ];
    try {
        let row;
        let cell;
        let logMsg;
        for (let k = 0; k < stats.length; k++) {
            logMsg = `Generating report [account ${k + 1} of ${stats.length}]...`;
            await actor.setStatusMessage(logMsg);
            console.log();
            await showSheetMessage(gesamtSheet, logMsg, colorBlue, gsLives);
            await showSheetMessage(monatlichSheet, logMsg, colorBlue, gsLives);
            const s            = stats[k];
            const accountName  = s.name;
            const accountError = s.error;
            const sheetName    = s.share ? `${s.name.toLowerCase()} -${s.share}` : s.name.toLowerCase();
            const sheetIsNew   = !(sheetName in sheets);
            const sheet        = sheets[sheetName] || await doc.addSheet({ title: sheetName });
            let cellAllTime    = '';
            let cellYesterday  = '';
            let cellToday      = '';
            let cellThisMonth  = '';
            row = 0;
            await saveProperties(sheet, { tabColor: colorBlue }, gsLives);
            await sleep(gsPauseLong);
            if (accountError) {
                // Marks the account sheet's tab to identify a failed account report.
                await saveProperties(sheet, { tabColor: colorRed }, gsLives);
                await sleep(gsPauseLong);
                globalTotals.push({
                    accountName,
                    sheetName,
                    cellAllTime,
                    cellYesterday,
                    cellToday,
                    cellThisMonth,
                    accountError
                });
            }
            else {
                // Pre-calculates the account sheet's total required rows.
                let totalRows = 4; // 4 header rows.
                for (const p of s.periods) {
                    totalRows += p.dailyProfits.length + 3; // # days + 1 separator + 1 month title + 1 month subtotal.
                }
                await saveProperties(
                    sheet,
                    {
                        gridProperties: {
                            rowCount      : totalRows,
                            columnCount   : 7,
                            frozenRowCount: totalRows > 4 ? 4 : 0
                        }
                    },
                    gsLives
                );
                await sleep(gsPauseLong);
                // Loads range: sheet's headers.
                await loadCells(sheet, 'A1:G4', gsLives);
                await sleep(gsPauseLong);
                // Adds the account sheet's header (name, share) in A1..D1.
                cell       = sheet.getCell(row, 0);
                cell.value = 'Model Name';
                formatCell(cell, colorBlack, colorGray, colorBlack, true);
                cell       = sheet.getCell(row, 1);
                cell.value = s.name;
                formatCell(cell, colorBlack, colorGray, colorBlack, true);
                cell       = sheet.getCell(row, 2);
                cell.value = 'Model %';
                formatCell(cell, colorBlack, colorGray, colorBlack, true);
                cell       = sheet.getCell(row, 3);
                cell.value = s.share / 100;
                formatCell(cell, colorBlack, colorGray, colorBlack, true, false, true);
                // Adds the account sheet's total headers in A3..G3.
                row += 2;
                const monthRowTotHdr = row;
                for (const c of [0, 1, 2, 3, 4 ,5, 6]) {
                    cell = sheet.getCell(row, c);
                    if (!c) {
                        cell.value = 'Gesamt';
                    }
                    formatCell(cell, colorWhite, colorBlack, colorBlack, true);
                }
                await mergeCells(
                    sheet,
                    {
                        startRowIndex   : row,
                        endRowIndex     : row + 1,
                        startColumnIndex: 0,
                        endColumnIndex  : 3
                    }
                );
                await sleep(gsPauseLong);
                // Adds the account sheet's subheaders in A4..G4.
                row++;
                for (let k = 0; k < dataColumns.length; k++) {
                    cell       = sheet.getCell(row, k);
                    cell.value = dataColumns[k];
                    formatCell(cell, colorBlack, colorWhite, colorBlack, true);
                }
                // Saves range: sheet's headers.
                await saveCells(sheet, gsLives);
                await sleep(gsPauseLong);
                // Adds the account sheet's daily totals, in A6..G6 and below.
                row += 2;
                const firstDataRow    = row;
                const lastPeriod      = s.periods.at(-1);
                const lastPeriodYear  = lastPeriod?.year;
                const lastPeriodMonth = lastPeriod?.month;
                const lastPeriod1st   = lastPeriod?.dailyProfits?.length == 1;
                const prevPeriod      = s.periods.at(-2);
                const prevPeriodYear  = prevPeriod?.year;
                const prevPeriodMonth = prevPeriod?.month;
                let monthRowIni;
                let monthRowEnd;
                let monthRowSub = [];
                for (const p of s.periods) {
                    const periodName = getUTCPeriod(p.year, p.month);
                    const isLastPeriod = p.year == lastPeriodYear && p.month == lastPeriodMonth;
                    const isPrevPeriod = p.year == prevPeriodYear && p.month == prevPeriodMonth;
                    const skipPeriod = isLazy && !sheetIsNew && !isLastPeriod && (!isPrevPeriod || !lastPeriod1st);
                    if (skipPeriod) {
                        console.log(`sheet period contents skipped out of laziness: ${periodName}`);
                        row++;
                        monthRowIni = row;
                        row += p.dailyProfits.length;
                    }
                    else {
                        // Loads range: current period.
                        await loadCells(sheet, `A${row}:G${row + p.dailyProfits.length + 2}`, gsLives);
                        await sleep(gsPauseLong);
                        for (const r of [row - 1, row]) {
                            for (const c of [0, 1, 2, 3, 4 ,5, 6]) {
                                cell = sheet.getCell(r, c);
                                if (r == row && !c) {
                                    cell.value = periodName;
                                    formatCell(cell, colorBlack, colorWhite, false, true);
                                }
                                else {
                                    formatCell(cell);
                                }
                            }
                        }
                        row++;
                        monthRowIni = row;
                        for (const d of p.dailyProfits) {
                            const utcDate = new Date(d.date);
                            cell          = sheet.getCell(row, 0);
                            cell.value    = deDate.format(utcDate);
                            formatCell(cell);
                            cell          = sheet.getCell(row, 1);
                            formatCell(cell);
                            cell          = sheet.getCell(row, 2);
                            formatCell(cell, colorBlack, colorWhite, false, false, false, true);
                            cell          = sheet.getCell(row, 3);
                            cell.value    = d.profit;
                            formatCell(cell, colorBlack, colorWhite, false, false, true);
                            cell          = sheet.getCell(row, 4);
                            cell.formula  = `=${toA1(row, 3)}*${toA1(row, 2)}`;
                            formatCell(cell, colorBlack, colorWhite, false, false, true);
                            cell          = sheet.getCell(row, 5);
                            cell.formula  = `=${toA1(row, 3)}*D1`;
                            formatCell(cell, colorBlack, colorWhite, false, false, true);
                            cell          = sheet.getCell(row,6);
                            cell.formula  = `=${toA1(row, 3)}-${toA1(row, 4)}-${toA1(row, 5)}`;
                            formatCell(cell, colorBlack, colorWhite, false, false, true);
                            row++;
                            await sleep(gsPauseShort);
                        }
                        // Saves range: current period.
                        await saveCells(sheet, gsLives);
                        await sleep(gsPauseLong);
                    }
                    monthRowEnd = row - 1;
                    if (monthRowEnd >= monthRowIni) {
                        if (!periodTotals[p.year]) {
                            periodTotals[p.year]={};
                        }
                        if (!periodTotals[p.year][p.month]) {
                            periodTotals[p.year][p.month]={};
                        }
                        periodTotals[p.year][p.month][sheetName] = row;
                    }
                    if (skipPeriod) {
                        console.log(`sheet period totals skipped out of laziness: ${periodName}`);
                        console.log();
                        monthRowSub.push(row);
                        row += 2;
                    }
                    else {
                        // Sets the formula for each column total in the headers (D3, E3, F3, G3).
                        // Loads range: current period's totals row.
                        await loadCells(sheet, `A${row + 1}:G${row + 1}`, gsLives);
                        await sleep(gsPauseLong);
                        for (const c of [0, 1, 2, 3, 4 ,5, 6]) {
                            cell = sheet.getCell(row, c);
                            if (!c) {
                                cell.value = 'Gesamt';
                            }
                            else if (c > 2) {
                                cell.formula  = `=SUM(${toA1(monthRowIni, c)}:${toA1(monthRowEnd, c)})`;
                            }
                            formatCell(cell, colorBlack, colorGray);
                        }
                        monthRowSub.push(row);
                        row += 2;
                        // Saves range: current period's totals row.
                        await saveCells(sheet, gsLives);
                        await sleep(gsPauseLong);
                    }
                }
                cellAllTime = toA1(monthRowTotHdr, 6);
                if (monthRowEnd && monthRowIni) {
                    if (monthRowEnd >= monthRowIni) {
                        if (monthRowEnd > monthRowIni) {
                            cellYesterday = toA1(monthRowEnd - 1, 6);
                        }
                        else if (monthRowEnd - 4 > firstDataRow) {
                            cellYesterday = toA1(monthRowEnd - 4, 6);
                        }
                        cellToday = toA1(monthRowEnd, 6);
                        cellThisMonth = toA1(monthRowEnd + 1, 6);
                    }
                }
                // Sets the subtotal formula for each month, in columns D, E, F and G.
                // Loads range: sheet's totals header.
                await loadCells(sheet, `A${monthRowTotHdr + 1}:G${monthRowTotHdr + 1}`, gsLives);
                await sleep(gsPauseLong);
                for (const c of [3, 4 ,5, 6]) {
                    let f = '';
                    for (const m of monthRowSub) {
                        if (f.length) {
                            f = f.concat('+');
                        }
                        else {
                            f = f.concat('=');
                        }
                        f = f.concat(`${toA1(m, c)}`);
                    }
                    if (f) {
                        cell         = sheet.getCell(monthRowTotHdr, c);
                        cell.formula = f;
                    }
                }
                // saves range: sheet's totals header.
                await saveCells(sheet, gsLives);
                await sleep(gsPauseLong);
                await saveProperties(sheet, { tabColor: null }, gsLives);
                await sleep(gsPauseLong);
                globalTotals.push({
                    accountName,
                    sheetName,
                    cellAllTime,
                    cellYesterday,
                    cellToday,
                    cellThisMonth,
                    accountError
                });
            }
        }
        logMsg = 'Consolidating results...';
        await actor.setStatusMessage(logMsg);
        console.log();
        await showSheetMessage(gesamtSheet, logMsg, colorBlue, gsLives);
        await showSheetMessage(monatlichSheet, logMsg, colorBlue, gsLives);
        // Creates the 'Gesamt' sheet's headers in A3..E3.
        row = 2;
        for (const c of [0, 1, 2, 3, 4]) {
            cell = gesamtSheet.getCell(row, c);
            if (!c) {
                cell.value = 'Gesamt';
            }
            formatCell(cell, colorWhite, colorBlack, colorBlack, true, !!c);
        }
        // Creates the 'Gesamt' sheet's subheader in A4..E4.
        row++;
        cell = gesamtSheet.getCell(row, 0);
        cell.value = 'Accounts';
        formatCell(cell, colorBlack, colorWhite, colorBlack, true);
        await mergeCells(
            gesamtSheet,
            {
                startRowIndex   : row,
                endRowIndex     : row + 1,
                startColumnIndex: 0,
                endColumnIndex  : 5
            }
        );
        await sleep(gsPauseLong);
        // Creates the 'Gesamt' sheet's subheaders in A5..E5.
        row++;
        for (let k = 0; k < globalColumns.length; k++) {
            cell       = gesamtSheet.getCell(row, k);
            cell.value = globalColumns[k];
            formatCell(cell, colorBlack, colorWhite, colorBlack, true);
        }
        await saveCells(gesamtSheet, gsLives);
        await sleep(gsPauseLong);
        // Adds a total row per each account requested, in A6..E6 and below.
        row++;
        for (let k = 0; k < globalTotals.length; k++) {
            cell         = gesamtSheet.getCell(row + k, 0);
            cell.value   = globalTotals[k].accountName;
            if (globalTotals[k].accountError) {
                cell.note = globalTotals[k].accountError;
                formatCell(cell, colorBlack, colorRed);
            }
            else {
                formatCell(cell);
            }
            cell = gesamtSheet.getCell(row + k, 1);
            if (globalTotals[k].cellYesterday) {
                cell.formula = `='${globalTotals[k].sheetName}'!${globalTotals[k].cellYesterday}`;
            }
            formatCell(cell);
            cell = gesamtSheet.getCell(row + k, 2);
            if (globalTotals[k].cellToday) {
                cell.formula = `='${globalTotals[k].sheetName}'!${globalTotals[k].cellToday}`;
            }
            formatCell(cell);
            cell = gesamtSheet.getCell(row + k, 3);
            if (globalTotals[k].cellThisMonth) {
                cell.formula = `='${globalTotals[k].sheetName}'!${globalTotals[k].cellThisMonth}`;
            }
            formatCell(cell);
            cell = gesamtSheet.getCell(row + k, 4);
            if (globalTotals[k].cellAllTime) {
                cell.formula = `='${globalTotals[k].sheetName}'!${globalTotals[k].cellAllTime}`;
            }
            formatCell(cell);
            await sleep(gsPauseShort);
        }
        // Sets the formula for each column total in the headers (B3, C3, D3, E3).
        for (const c of [1, 2 ,3, 4]) {
            cell         = gesamtSheet.getCell(row - 3, c);
            cell.formula = `=SUM(${toA1(row, c)}:${toA1(row + globalTotals.length - 1, c)})`;
        }
        await saveCells(gesamtSheet, gsLives);
        await sleep(gsPauseLong);
        await saveProperties(
            gesamtSheet,
            {
                gridProperties: {
                    rowCount      : row + globalTotals.length,
                    columnCount   : 5,
                    frozenRowCount: row + globalTotals.length > 5 ? 5 : 0
                }
            },
            gsLives
        );
        await sleep(gsPauseLong);
        // Creates the 'Monatlich' sheet's headers in A3..E3.
        row = 2;
        for (const c of [0, 1, 2, 3, 4]) {
            cell = monatlichSheet.getCell(row, c);
            if (!c) {
                cell.value = 'Gesamt';
            }
            formatCell(cell, colorWhite, colorBlack, colorBlack, true);
        }
        // Creates the 'Monatlich' sheet's subheader in A4..E4.
        row++;
        cell = monatlichSheet.getCell(row, 0);
        cell.value = 'Periods';
        formatCell(cell, colorBlack, colorWhite, colorBlack, true);
        await mergeCells(
            monatlichSheet,
            {
                startRowIndex   : row,
                endRowIndex     : row + 1,
                startColumnIndex: 0,
                endColumnIndex  : 5
            }
        );
        await sleep(gsPauseLong);
        // Creates the 'Monatlich' sheet's subheaders in A5..E5.
        row++;
        for (let k = 0; k < periodColumns.length; k++) {
            cell       = monatlichSheet.getCell(row, k);
            cell.value = periodColumns[k];
            formatCell(cell, colorBlack, colorWhite, colorBlack, true);
        }
        await saveCells(monatlichSheet, gsLives);
        await sleep(gsPauseLong);
        // Adds a total row per each available period, in A6..E6 and below.
        row++;
        let k = 0;
        const sortedYears = Object.keys(periodTotals).sort(function (a, b) { return a - b; });
        for (const y of sortedYears) {
            const sortedMonths = Object.keys(periodTotals[y]).sort(function (a, b) { return a - b; });
            for (const m of sortedMonths) {
                const sheetNames = Object.keys(periodTotals[y][m]);
                cell       = monatlichSheet.getCell(row + k, 0);
                cell.value = getUTCPeriod(y, m);
                formatCell(cell);
                for (const c of [1, 2 ,3, 4]) {
                    let periodFormula = '';
                    for (const s of sheetNames) {
                        if (periodFormula.length) {
                            periodFormula = periodFormula.concat('+');
                        }
                        periodFormula = periodFormula.concat(`'${s}'!${toA1(periodTotals[y][m][s], c + 2)}`);
                    }
                    cell         = monatlichSheet.getCell(row + k, c);
                    cell.formula = `=${periodFormula}`;
                    formatCell(cell);
                }
                k++;
            }
        }
        // Sets the formula for each column total in the headers (B3, C3, D3, E3).
        for (const c of [1, 2 ,3, 4]) {
            cell         = monatlichSheet.getCell(row - 3, c);
            cell.formula = `=SUM(${toA1(row, c)}:${toA1(row + k - 1, c)})`;
        }
        await saveCells(monatlichSheet, gsLives);
        await sleep(gsPauseLong);
        await saveProperties(
            monatlichSheet,
            {
                gridProperties: {
                    rowCount      : row + k,
                    columnCount   : 5,
                    frozenRowCount: row + k > 5 ? 5 : 0
                }
            },
            gsLives
        );
        await sleep(gsPauseLong);
        ret.status = true;
    }
    catch (err) {
        const errLine = err.stack?.split('\n')[1]?.match(/:(\d+):(\d+)\)/);
        const errPos  = errLine ? `at line ${errLine[1]}:${errLine[2]} ` : '';
        ret.message = `makeReport() failed ${errPos}[ ${err.message} ]`;
    }
    return ret;
}

async function main() {
    let actorSuccess  = false;
    let statusMessage = '';
    let prevMessage   = '';
    let sheets;
    await apify.Actor.init();
    const setStatus = async function(message, isError = false) {
        if (message != undefined) {
            statusMessage = message;
        }
        if (statusMessage != prevMessage) {
            prevMessage = statusMessage;
            const options = { isStatusMessageTerminal : false };
            options.level = isError ? 'ERROR' : 'INFO';
            await apify.Actor.setStatusMessage(statusMessage, options);
            console.log();
        }
    };
    try {
        const actorStore  = await apify.Actor.openKeyValueStore('brezzelsStats');
        const actorInput  = await apify.Actor.getInput();
        const keyFile     = actorInput.google_auth;
        const sheetId     = actorInput.spreadsheet_id;
        const sheetConfig = actorInput.accounts_sheet_config;
        const accounts    = actorInput.brezzels_accounts;
        const reportFrom  = new Date(`${actorInput.report_from || '2024-04-01'}T00:00:00Z`);
        const validations = actorInput.dbg_only_validations    || false;
        const skipConfig  = actorInput.dbg_skip_sheets_config  || false;
        const skipStats   = actorInput.dbg_skip_stats_grabbing || false;
        const lazyReport  = actorInput.dbg_lazy_report         || false;
        const apiCooldown = actorInput.dbg_request_cooldown  ?? 1;
        const apiThreads  = actorInput.dbg_operation_threads ?? 2;
        const apiLives    = actorInput.dbg_operation_lives   ?? 3;
        const apiFactor   = actorInput.dbg_backoff_factor    ?? 5;

        const srcSsheet   = typeof sheetConfig === 'object' && !!Object.keys(sheetConfig).length;
        const srcManual   = !srcSsheet && Array.isArray(accounts) && !!accounts.length;

        console.log();
        console.log(`-- ${actor.name} configuration --`);
        console.log(`Accounts source: ${srcSsheet ? 'SPREADSHEET' : srcManual ? 'MANUAL' : 'UNKNOWN'}`);
        console.log(`Report from    : ${reportFrom.toISOString().split('T')[0]}`);
        console.log(`Only validations     : ${validations ? 'YES' : 'NO'}`);
        console.log(`Skip sheets config   : ${skipConfig ? 'YES' : 'NO'}`);
        console.log(`Skip stats grabbing  : ${skipStats ? 'YES' : 'NO'}`);
        console.log(`Lazy report          : ${lazyReport ? 'YES' : 'NO'}`)
        console.log(`API request cooldown : ${apiCooldown} sec`);
        console.log(`API operation threads: ${apiThreads} threads`);
        console.log(`API operation lives  : ${apiLives} lives`);
        console.log(`API backoff factor   : ${apiFactor} x`);
        console.log(`Proxy usage: ${await proxyText(getHTTPProxy)}`);
        console.log();

        let r;

        const apiParams    = {
            cooldown       : apiCooldown,
            threads        : apiThreads,
            lives          : apiLives,
            factor         : apiFactor
        };

        const normAccounts = function (oldAccounts) {
            const source = oldAccounts || accounts;
            const normal = source.map(
                function (a) {
                    const account    = a.account.trim().toLowerCase();
                    const identifier = a.identifier.trim().toLowerCase();
                    const password   = a.password.trim();
                    const share      = a.share;
                    return {
                        account,
                        identifier,
                        password,
                        share
                    };
                }
            );
            accounts.length = 0;
            accounts.push(...normal);
        };

        // Does a deep validation of the supplied JSON keyfile contents.
        r = validateKeyfile(keyFile);
        if (!r.status) {
            throw new Error(r.message);
        }

        // Opens the target spreadsheet.
        await setStatus('Opening target spreadsheet...');
        const auth = new GAL.JWT({
            email : keyFile.client_email,
            key   : keyFile.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        const doc = await openSpreadsheet(sheetId, auth, apiLives);

        if (srcSsheet) {
            await setStatus('Validating sheet config...');
            r = validateSheetConfig(sheetConfig);
            if (!r.status) {
                throw new Error(r.message);
            }
            await setStatus('Importing sheet accounts...');
            r = await importAccounts(doc, sheetConfig);
            if (!r.status) {
                throw new Error(r.message);
            }
            normAccounts(r.accounts);
            await setStatus('Validating imported accounts...');
            r = validateAccounts(accounts);
            if (!r.status) {
                throw new Error(`[imported] ${r.message}`);
            }
        }
        else if (srcManual) {
            normAccounts();
            await setStatus('Validating supplied accounts...');
            r = validateAccounts(accounts);
            if (!r.status) {
                throw new Error(`[manual] ${r.message}`);
            }
        }
        else {
            throw new Error('undefined accounts source');
        }

        // Creates a profits.json file (when not exists) to allow tampering.
        if (!await actorStore.getValue('profits')) {
            await actorStore.setValue('profits', {});
        }

        if (validations) {
            actorSuccess = true;
            throw new Error('Validations passed');
        }

        // Adds a new 'Gesamt' & 'Monatlich' sheets, always as the first ones.
        await setStatus('Configuring main sheets...');
        await doc.addSheet({ index: 0 });
        await doc.addSheet({ index: 0 });
        sheets = doc.sheetsByTitle;
        if (sheets['Monatlich']) {
            // Removes the previous 'Monatlich' sheet.
            await sheets['Monatlich'].delete();
        }
        if (sheets['Gesamt']) {
            // Removes the previous 'Gesamt' sheet.
            await sheets['Gesamt'].delete();
        }
        sheets = doc.sheetsByIndex;
        // Sets up the 'Gesamt' sheet basics.
        await loadCells(sheets[0], '', apiLives);
        await saveProperties(sheets[0], { title: 'Gesamt' }, apiLives);
        await sleep(gsPauseLong);
        await mergeCells(
            sheets[0],
            {
                startRowIndex   : 0,
                endRowIndex     : 1,
                startColumnIndex: 0,
                endColumnIndex  : 5
            }
        );
        // Sets up the 'Monatlich' sheet basics.
        await loadCells(sheets[1], '', apiLives);
        await saveProperties(sheets[1], { title: 'Monatlich' }, apiLives);
        await sleep(gsPauseLong);
        await mergeCells(
            sheets[1],
            {
                startRowIndex   : 0,
                endRowIndex     : 1,
                startColumnIndex: 0,
                endColumnIndex  : 5
            }
        );

        if (!skipConfig) {
            await setStatus('Configuring secondary sheets...');
            await showSheetMessage(sheets[0], statusMessage, colorBlue, apiLives);
            await showSheetMessage(sheets[1], statusMessage, colorBlue, apiLives);
            // Resets the tab colors of the existing sheets.
            for (const s of sheets) {
                await saveProperties(s, { tabColor: null }, apiLives);
                await sleep(gsPauseLong);
            }
        }

        // Loads (in memory) the profits story updates for every account.
        const actorProfits   = await actorStore.getValue('profits') || {};
        const statsOperation = skipStats ? 'Loading' : 'Grabbing';
        await setStatus(`${statsOperation} stats...`);
        if (skipStats) {
            await showSheetMessage(sheets[0], statusMessage, colorBlue, apiLives);
            await showSheetMessage(sheets[1], statusMessage, colorBlue, apiLives);
        }
        const stats = [];
        for (let k = 0; k < accounts.length; k++) {
            await setStatus(`${statsOperation} stats [account ${k + 1} of ${accounts.length}]...`);
            if (!skipStats) {
                await showSheetMessage(sheets[0], statusMessage, colorBlue, apiLives);
                await showSheetMessage(sheets[1], statusMessage, colorBlue, apiLives);
            }
            const a  = accounts[k];
            const ac = a.account;
            const id = a.identifier;
            const pw = a.password;
            const sh = a.share;
            if (skipStats) {
                r = loadAccountProfits(id, actorProfits);
            }
            else {
                r = await getAccountProfits(id, pw, sh, reportFrom, actorProfits, apiParams);
            }
            if (!r.status) {
                const error = r.message;
                console.warn(error);
                stats.push({
                    id,
                    name   : ac,
                    share  : sh,
                    periods: [],
                    error
                });
            }
            else {
                stats.push(r.profits);
                if (!skipStats) {
                    await actorStore.setValue('profits', actorProfits);
                }
            }
            console.log();
        }

        // Creates a report sheet per account, using the loaded story.
        await setStatus('Creating report...');
        r = await makeReport(apify.Actor, doc, stats, lazyReport, apiLives);
        if (!r.status) {
            throw new Error(r.message);
        }

        await setStatus(`Finished at ${new Date().toUTCString()}`);
        await showSheetMessage(sheets[0], statusMessage, colorGreen, apiLives);
        await showSheetMessage(sheets[1], statusMessage, colorGreen, apiLives);

        actorSuccess = true;
    }
    catch (err) {
        await setStatus(err.message, !actorSuccess);
    }
    finally {
        await sleep(gsPauseLong);
        if (actorSuccess) {
            if (statusMessage) {
                await apify.Actor.exit(statusMessage);
            }
            else {
                await apify.Actor.exit();
            }
        }
        else {
            // Checks if it's possible to also show the error in the 'Gesamt' sheet.
            if (typeof sheets !== 'undefined' && Array.isArray(sheets) && sheets.length) {
                await showSheetMessage(sheets[0], statusMessage, colorRed);
                await showSheetMessage(sheets[1], statusMessage, colorRed);
            }
            await apify.Actor.fail(statusMessage);
        }
    }
}

async function mergeCells(sheet, rangeObj, lives = 3) {
    const topLeft     = toA1(rangeObj.startRowIndex, rangeObj.startColumnIndex);
    const bottomRight = toA1(rangeObj.endRowIndex, rangeObj.endColumnIndex);
    const rangeTxt    = `${topLeft}:${bottomRight}`;
    console.log(`merging sheet '${sheet.title}' cells [${rangeTxt}]...`);
    let scTry = lives;
    let delay = 1;
    while (true) {
        try {
            await sheet.mergeCells(rangeObj);
            console.log('done');
            console.log();
            break;
        }
        catch (err) {
            const error = `** mergeCells('${sheet.title}') failed: [${err.name}] ${err.message}`;
            scTry--;
            if (!scTry) {
                throw new Error(error);
            }
            else {
                console.warn(error);
                delay *= 5;
                console.log(`waiting ${delay} sec...`);
                await sleep(delay * 1000);
            }
        }
    }
}

async function openSpreadsheet(sheetId, auth, lives = 3) {
    let doc;
    let scTry = lives;
    let delay = 1;
    while (true) {
        try {
            doc = new GS.GoogleSpreadsheet(sheetId, auth);
            await doc.loadInfo();
            break;
        }
        catch (err) {
            const error = `** loadInfo() failed: [${err.name}] ${err.message}`;
            scTry--;
            if (!scTry) {
                throw new Error(error);
            }
            else {
                console.warn(error);
                delay *= 5;
                console.log(`waiting ${delay} sec...`);
                await sleep(delay * 1000);
            }
        }
    }
    if (delay > 1) {
        console.log();
    }
    return doc;
}

async function proxyText(proxy) {
    let text;
    if (proxy) {
        let p;
        if (typeof(proxy) === 'function') {
            p     = proxy();
            if (p instanceof Promise) {
                p = await p;
            }
            text  = `[function] ${p || 'none'}`;
        }
        else {
            p     = proxy;
            text  = `[rotating] ${p || 'none'}`;
        }
    }
    else {
        text      = '[no proxy]';
    }
    return text;
}

async function saveCells(sheet, lives = 3) {
    console.log(`updating sheet '${sheet.title}'...`);
    let scTry = lives;
    let delay = 1;
    while (true) {
        try {
            await sheet.saveUpdatedCells();
            console.log('done');
            console.log();
            break;
        }
        catch (err) {
            const error = `** saveUpdatedCells('${sheet.title}') failed: [${err.name}] ${err.message}`;
            scTry--;
            if (!scTry) {
                throw new Error(error);
            }
            else {
                console.warn(error);
                delay *= 5;
                console.log(`waiting ${delay} sec...`);
                await sleep(delay * 1000);
            }
        }
    }
}

async function saveProperties(sheet, properties, lives = 3) {
    console.log(`updating sheet '${sheet.title}' properties...`);
    let spTry = lives;
    let delay = 1;
    while (true) {
        try {
            await sheet.updateProperties(properties);
            console.log('done');
            console.log();
            break;
        }
        catch (err) {
            const error = `** updateProperties('${sheet.title}') failed: [${err.name}] ${err.message}`;
            spTry--;
            if (!spTry) {
                throw new Error(error);
            }
            else {
                console.warn(error);
                delay *= 5;
                console.log(`waiting ${delay} sec...`);
                await sleep(delay * 1000);
            }
        }
    }
}

async function showSheetMessage(sheet, message, backgroundColor, lives = 3) {
    const cell = sheet.getCell(0, 0);
    cell.value = message || '';
    if (message) {
        formatCell(cell, colorBlack, backgroundColor);
    }
    else {
        formatCell(cell);
    }
    await saveCells(sheet, lives);
    await sleep(gsPauseLong);
}

function sleep(ms) {
    return new Promise(
        function(resolve) {
            setTimeout(resolve,ms);
        }
    );
}

function toA1(row, col) {
    return String.fromCharCode(65 + col).concat(row + 1);
}

function validateAccounts(accounts) {
    const ret  = {
        status : false,
        message: ''
    };
    if (!Array.isArray(accounts)) {
        ret.message = 'invalid accounts structure';
    }
    else if (!accounts.length) {
        ret.message = 'accounts structure cannot be empty';
    }
    else {
        const names = accounts.map(a => a.account);
        const ids   = accounts.map(a => a.identifier);
        for (let k = 0; k < accounts.length; k++) {
            ret.status = false;
            const a = accounts[k];
            if (typeof a !== 'object') {
                ret.message = `invalid account #${k + 1} structure`;
                break;
            }
            else if (!a.hasOwnProperty('account')) {
                ret.message = `account name #${k + 1} is missing`;
                break;
            }
            else if (!a.hasOwnProperty('identifier')) {
                ret.message = `account identifier #${k + 1} is missing`;
                break;
            }
            else if (!a.hasOwnProperty('password')) {
                ret.message = `account password #${k + 1} is missing`;
                break;
            }
            else if (!a.hasOwnProperty('share')) {
                ret.message = `account share #${k + 1} is missing`;
                break;
            }
            else if (typeof a.account !== 'string') {
                ret.message = `account name #${k + 1} must be a string`;
                break;
            }
            else if (typeof a.identifier !== 'string') {
                ret.message = `account identifier #${k + 1} must be a string`;
                break;
            }
            else if (typeof a.password !== 'string') {
                ret.message = `account password #${k + 1} must be a string`;
                break;
            }
            else if (typeof a.share !== 'number') {
                ret.message = `account share #${k + 1} must be a number`;
                break;
            }
            const ac = a.account.trim();
            const id = a.identifier.trim();
            const pw = a.password.trim();
            const sh = a.share;
            if (!ac.length) {
                ret.message = `account name #${k + 1} cannot be empty`;
                break;
            }
            else if (!id.length) {
                ret.message = `account identifier #${k + 1} cannot be empty`;
                break;
            }
            else if (!pw.length) {
                ret.message = `account password #${k + 1} cannot be empty`;
                break;
            }
            else if (sh < 0 || sh > 100) {
                ret.message = `account share #${k + 1} must be a percent value between 0 and 100`;
                break;
            }
            const sameNames = names.filter(function (n) {return n===ac});
            if (sameNames.length > 1) {
                ret.message = `account name '${ac}' appears duplicated`;
                break;
            }
            const sameIds   = ids.filter(function (n) {return n===id});
            if (sameIds.length > 1) {
                ret.message = `account identifier '${id}' appears duplicated`;
                break;
            }
            ret.status = true;
        }
    }
    return ret;
}

function validateKeyfile(keyfile) {
    const ret  = {
        status : false,
        message: ''
    };
    if (typeof keyfile !== 'object') {
        ret.message = 'invalid keyfile structure';
    }
    else if (!keyfile.hasOwnProperty('client_email')) {
        ret.message = 'client_email is missing in keyfile';
    }
    else if (!keyfile.hasOwnProperty('private_key')) {
        ret.message = 'private_key is missing in keyfile';
    }
    else if (typeof keyfile.client_email !== 'string') {
        ret.message = 'keyfile client_email must be a string';
    }
    else if (typeof keyfile.private_key !== 'string') {
        ret.message = 'keyfile private_key must be a string';
    }
    else if (!keyfile.client_email.trim().length) {
        ret.message = 'client_email cannot be empty';
    }
    else if (!keyfile.private_key.trim().length) {
        ret.message = 'private_key cannot be empty';
    }
    else {
        ret.status  = true;
    }
    return ret;
}

function validateSheetConfig(config) {
    const ret  = {
        status : false,
        message: ''
    };
    if (typeof config !== 'object') {
        ret.message = 'invalid sheet config';
    }
    else if (!Object.keys(config).length) {
        ret.message = 'sheet config cannot be empty';
    }
    else {
        let missing;
        let unexpected;
        let invalid;
        let repeated;
        const columnNames = ['account', 'chatter', 'manager', 'email', 'password'];
        const columnRegEx = /^[A-Z]$/i;
        if (!config.hasOwnProperty('sheet')) {
            ret.message = `config field 'sheet' is missing`;
        }
        else if (typeof config.sheet !== 'string') {
            ret.message = `config field 'sheet' must be a string`;
        }
        else if (!config.sheet.length) {
            ret.message = `config field 'sheet' cannot be empty`;
        }
        else if (!config.hasOwnProperty('startrow')) {
            ret.message = `config field 'startrow' is missing`;
        }
        else if (!Number.isInteger(config.startrow) || config.startrow <= 0) {
            ret.message = `config field 'startrow' must be a positive integer row number`;
        }
        else if (!config.hasOwnProperty('columns')) {
            ret.message = `config field 'columns' is missing`;
        }
        else if (typeof config.columns !== 'object') {
            ret.message = `config field 'columns' must be an object`;
        }
        else if ((missing = columnNames.filter(n => !config.columns.hasOwnProperty(n))).length) {
            ret.message = `config field 'columns' has missing subfield(s): ${missing}`;
        }
        else if ((unexpected = Object.keys(config.columns).filter(n => !columnNames.includes(n))).length) {
            ret.message = `config field 'columns' includes unexpected subfield(s): ${unexpected}`;
        }
        else if ((invalid = columnNames.filter(n => typeof config.columns[n] !== 'string')).length) {
            ret.message = `config field 'columns' has subfield(s) which are not strings: ${invalid}`;
        }
        else if ((invalid = columnNames.filter(n => !columnRegEx.test(config.columns[n]))).length) {
            ret.message = `config field 'columns' has subfield(s) which are not sheet columns (A-Z): ${invalid}`;
        }
        else if ((repeated = columnNames.filter(n => Object.values(config.columns).filter(i => i.toUpperCase() === config.columns[n].toUpperCase()).length > 1)).length) {
            ret.message = `config field 'columns' has subfield(s) which are in conflict: ${repeated}`;
        }
        else {
            if (config.hasOwnProperty('filters')) {
                const filterNames = ['include', 'exclude'];
                if (typeof config.filters !== 'object') {
                    ret.message = `config field 'filters' must be an object`;
                }
                else if (!Object.keys(config.filters).length) {
                    ret.message = `config field 'filters' must include one these subfields: ${filterNames}`;
                }
                else if ((unexpected = Object.keys(config.filters).filter(n => !filterNames.includes(n))).length) {
                    ret.message = `config field 'filters' includes unexpected subfield(s): ${unexpected}`;
                }
                else if ((invalid = filterNames.filter(n => config.filters.hasOwnProperty(n) && typeof config.filters[n] !== 'object' )).length) {
                    ret.message = `config field 'filters' has subfield(s) which are not objects: ${invalid}`;
                }
                else {
                    for (const f of Object.keys(config.filters)) {
                        ret.status = false;
                        const filter   = config.filters[f];
                        const subfield = `filters.${f}`;
                        if (!Object.keys(filter).length) {
                            ret.message = `config subfield '${subfield}' cannot be empty`;
                            break;
                        }
                        else if ((unexpected = Object.keys(filter).filter(n => !columnNames.includes(n))).length) {
                            ret.message = `config subfield '${subfield}' includes unexpected subfield(s): ${unexpected}`;
                            break;
                        }
                        else if ((invalid = Object.keys(filter).filter(n => !Array.isArray(filter[n]))).length) {
                            ret.message = `config subfield '${subfield}' has subfield(s) which are not arrays: ${invalid}`;
                            break;
                        }
                        else if ((invalid = Object.keys(filter).filter(n => !filter[n].length)).length) {
                            ret.message = `config subfield '${subfield}' has subfield(s) which are empty arrays: ${invalid}`;
                            break;
                        }
                        else if ((invalid = Object.keys(filter).filter(n => filter[n].some(i => typeof i !=='string'))).length) {
                            ret.message = `config subfield '${subfield}' has subfield(s) which are not arrays of strings: ${invalid}`;
                            break;
                        }
                        else if ((invalid = Object.keys(filter).filter(n => filter[n].some(i => !i.length))).length) {
                            ret.message = `config subfield '${subfield}' has subfield(s) with empty values: ${invalid}`;
                            break;
                        }
                        else if ((repeated = Object.keys(filter).filter(n => new Set(filter[n].map(i => i.toUpperCase())).size !== filter[n].length)).length) {
                            let subfields = "";
                            for (const r of repeated) {
                                const values = [...new Set(filter[r].map(i => i.toLowerCase()).filter((v, i, a) => a.indexOf(v) !== i))].map(i => `'${i}'`);
                                if (subfields.length) {
                                    subfields += ',';
                                }
                                subfields += `${r}(${values.join(',')})`;
                            }
                            ret.message = `config subfield '${subfield}' has subfield(s) with repeated values: ${subfields}`;
                            break;
                        }
                        ret.status = true;
                    }
                }
            }
            else {
                ret.status = true;
            }
        }
    }
    return ret;
}

main();