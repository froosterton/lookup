const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const axios = require('axios');
const express = require('express');

// Configuration - Railway deployment ready
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const USERNAME_WEBHOOK_URL = process.env.USERNAME_WEBHOOK_URL;
const ITEM_IDS = process.env.ITEM_IDS || '74891470'; // Comma-separated item IDs
const NEXUS_ADMIN_KEY = process.env.NEXUS_ADMIN_KEY;
const NEXUS_API_URL = 'https://discord.nexusdevtools.com/lookup/roblox';

// Express server for healthcheck
const app = express();
const PORT = process.env.PORT || 3000;

let driver; // Global Selenium WebDriver instance
let profileDriver; // Dedicated driver for profile scraping
let processedUsers = new Set();
let totalLogged = 0;
let isScraping = false;
let retryCount = 0;
const MAX_RETRIES = 3;

// Healthcheck endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'healthy', 
        scraping: isScraping,
        totalLogged: totalLogged,
        timestamp: new Date().toISOString()
    });
});

// Start Express server
app.listen(PORT, () => {
    console.log(`🌐 Healthcheck server running on port ${PORT}`);
});

async function startScraper() {
    console.log('🔐 Initializing scraper...');
    const initialized = await initializeWebDriver();
    if (!initialized) {
        console.error('❌ Failed to initialize WebDriver, exiting.');
        process.exit(1);
    }

    // Always start scraping with ITEM_IDS from environment
    console.log('🚀 Starting Rolimons scraper...');
    isScraping = true;
    const itemIds = ITEM_IDS.split(',').map(id => id.trim()).filter(id => id && !isNaN(id));
    if (itemIds.length > 0) {
        console.log('⚙️ Starting scrape for items:', itemIds.join(', '));
        for (const itemId of itemIds) {
            await scrapeRolimonsItem(itemId);
        }
        console.log("✅ All items scraped, script finished.");
        isScraping = false;
    } else {
        console.log('❌ No valid item IDs found in environment variables');
        process.exit(1);
    }
}

async function initializeWebDriver() {
    try {
        console.log('🔧 Initializing Selenium WebDriver...');

        const options = new chrome.Options();
        options.addArguments('--headless');
        options.addArguments('--no-sandbox');
        options.addArguments('--disable-dev-shm-usage');
        options.addArguments('--disable-gpu');
        options.addArguments('--window-size=1920,1080');
        options.addArguments('--disable-web-security');
        options.addArguments('--disable-features=VizDisplayCompositor');
        options.addArguments('--disable-extensions');
        options.addArguments('--disable-plugins');
        options.addArguments('--disable-images');
        options.addArguments('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        options.addArguments('--disable-blink-features=AutomationControlled');
        options.addArguments('--exclude-switches=enable-automation');

        driver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(options)
            .build();

        // Initialize profile driver with different settings
        const profileOptions = new chrome.Options();
        profileOptions.addArguments('--headless');
        profileOptions.addArguments('--no-sandbox');
        profileOptions.addArguments('--disable-dev-shm-usage');
        profileOptions.addArguments('--disable-gpu');
        profileOptions.addArguments('--window-size=1920,1080');
        profileOptions.addArguments('--disable-web-security');
        profileOptions.addArguments('--disable-features=VizDisplayCompositor');
        profileOptions.addArguments('--disable-extensions');
        profileOptions.addArguments('--disable-plugins');
        profileOptions.addArguments('--disable-images');
        profileOptions.addArguments('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        profileOptions.addArguments('--disable-blink-features=AutomationControlled');
        profileOptions.addArguments('--exclude-switches=enable-automation');

        profileDriver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(profileOptions)
            .build();

        console.log('✅ Selenium WebDriver initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ WebDriver initialization error:', error.message);
        return false;
    }
}

async function scrapeRolimonsItem(itemId) {
    try {
        const url = `https://www.rolimons.com/item/${itemId}`;
        console.log(`🔍 Getting item information from ${url}`);
        
        // Navigate to the first page to get item name and find pagination
        await driver.get(url);
        await driver.sleep(5000);

        // Click "All Copies" tab to get all users instead of just premium copies
        try {
            console.log('📋 Clicking "All Copies" tab...');
            const allCopiesTab = await driver.findElement(By.css('a[href="#all_copies_table_container"]'));
            const className = await allCopiesTab.getAttribute('class');
            if (!className.includes('active')) {
                await allCopiesTab.click();
                console.log('✅ Successfully clicked "All Copies" tab');
            } else {
                console.log('✅ "All Copies" tab already active');
            }
            
            // CRITICAL: Wait for the All Copies table to actually load and be ready
            console.log('⏳ Waiting for All Copies table to load...');
            await driver.wait(until.elementLocated(By.css('#all_copies_table tbody tr')), 15000);
            await driver.sleep(3000); // Extra wait for DataTables to fully initialize
            
            // Verify we're on the All Copies tab by checking the table exists
            const rows = await driver.findElements(By.css('#all_copies_table tbody tr'));
            console.log(`✅ All Copies table loaded with ${rows.length} rows visible`);
        } catch (e) {
            console.log('⚠️ Could not find/click "All Copies" tab or table not ready:', e.message);
        }

        // Extract item name from page title (for logging only)
        let itemName = 'Unknown Item';
        try {
            const titleElement = await driver.findElement(By.css('h1.page_title.mb-0'));
            itemName = await titleElement.getText();
            console.log(`📦 Scraping ${itemName}`);
        } catch (e) {
            console.log('⚠️ Could not extract item name, using default');
        }

        let totalPages = 1;
        
        try {
            // Find the pagination container and detect the highest visible page number.
            // Match the exact logic from test-pagination.js that works correctly
            await driver.wait(until.elementLocated(By.css('#all_copies_table_paginate')), 10000);

            const pageButtons = await driver.findElements(By.css('#all_copies_table_paginate a.page-link[data-dt-idx]'));
            let lastPageButton = null;

            for (const button of pageButtons) {
                const text = (await button.getText()).trim();
                if (/^\d+$/.test(text)) {
                    const pageNum = parseInt(text, 10);
                    if (!isNaN(pageNum) && pageNum > totalPages) {
                        totalPages = pageNum;
                        lastPageButton = button;
                    }
                }
            }

            if (lastPageButton && totalPages > 1) {
                console.log(`📄 Highest page number found: ${totalPages}. Clicking it to go to last page...`);
                // Match test-pagination.js: try regular click first, fallback to JS click
                try {
                    await lastPageButton.click();
                    console.log('✅ Regular click succeeded');
                } catch (e) {
                    console.log(`⚠️ Regular click failed: ${e.message}, trying JS click...`);
                    await driver.executeScript('arguments[0].click();', lastPageButton);
                    console.log('✅ JS click succeeded');
                }
                // Wait for DataTables to finish updating the table (same as test)
                await driver.sleep(5000);
            } else {
                console.log('⚠️ Could not find a numeric last page button, assuming single page');
            }
        } catch (e) {
            console.log('⚠️ Error finding pagination:', e.message);
        }

        console.log(`🔄 Starting continuous scraping from page ${totalPages} (last page) going backwards using Prev...`);

        for (let page = totalPages; page >= 1; page--) {
            console.log(`\n📄 Processing page ${page}/${totalPages}`);
            if (page !== totalPages) {
                // Click the Prev button (data-dt-idx="0") to go back one page at a time
                try {
                    const prevLink = await driver.findElement(By.css('#all_copies_table_paginate a.page-link[data-dt-idx="0"]'));
                    const prevParent = await prevLink.findElement(By.xpath('..'));
                    const cls = ((await prevParent.getAttribute('class')) || '').toLowerCase();

                    if (cls.includes('disabled')) {
                        console.log('⏹️ Prev button is disabled; reached the first page.');
                        break;
                    }

                    console.log('⬅️ Clicking Prev to move to previous page...');
                    // Match test-pagination.js: try regular click first, fallback to JS click
                    try {
                        await prevLink.click();
                        console.log('✅ Prev regular click succeeded');
                    } catch (e) {
                        console.log(`⚠️ Prev regular click failed: ${e.message}, trying JS click...`);
                        await driver.executeScript('arguments[0].click();', prevLink);
                        console.log('✅ Prev JS click succeeded');
                    }
                    await driver.sleep(5000); // Wait for table to update (same as test)
                } catch (e) {
                    console.log(`❌ Could not click Prev for page ${page}: ${e.message}`);
                    break;
                }
            }
            // No extra sleep here - we already waited after the click, match test-pagination.js behavior

            // ALWAYS log the DataTables "Showing X to Y of Z entries" info so we can
            // confirm which slice of the owner list this page actually represents.
            let infoText = '';
            try {
                infoText = await driver.findElement(By.css('#all_copies_table_info')).getText();
                console.log(`📊 DataTables info for current page: "${infoText}"`);
            } catch (e) {
                console.log('⚠️ Could not read all_copies_table_info:', e.message);
            }
            
            // CRITICAL: Verify we're reading from the correct table by checking a sample username
            // before processing all rows. This helps catch if we're reading stale/cached data.
            try {
                const sampleRows = await driver.findElements(By.css('#all_copies_table tbody tr'));
                if (sampleRows.length > 0) {
                    const firstRow = sampleRows[0];
                    const sampleLink = await firstRow.findElement(By.css('a[href*="/player/"]'));
                    const sampleUsername = await sampleLink.getText();
                    console.log(`🔍 Sample user on this page (first row): "${sampleUsername}"`);
                }
            } catch (e) {
                console.log('⚠️ Could not read sample user from table:', e.message);
            }

            // Use EXACT same selector as test-pagination.js that works correctly
            let rows = [];
            try {
                await driver.wait(until.elementLocated(By.css('#all_copies_table tbody tr')), 15000);
                rows = await driver.findElements(By.css('#all_copies_table tbody tr'));
                console.log(`✅ Found ${rows.length} rows with selector: #all_copies_table tbody tr`);
            } catch (e) {
                console.log(`❌ Could not find rows: ${e.message}`);
                continue;
            }
            
            if (rows.length === 0) {
                console.log(`❌ No users found on page ${page}, skipping...`);
                continue;
            }
            console.log(`👥 Found ${rows.length} users on page ${page}`);
            console.log(`🔄 Processing users from bottom to top (reverse order)...`);

            for (let i = rows.length - 1; i >= 0; i--) {
                try {
                    // Use ONLY the specific selector - don't use broad selectors that might match other tables
                    const currentRows = await driver.findElements(By.css('#all_copies_table tbody tr'));
                    if (i >= currentRows.length) {
                        console.log(`⏭️ Row ${i} no longer exists, skipping...`);
                        continue;
                    }
                    const row = currentRows[i];

                    // Always use the Rolimons profile link (e.g. <a href="/player/1">Roblox</a>)
                    const link = await row.findElement(By.css('a[href*="/player/"]'));

                    // Try multiple ways to get the visible username text
                    let username = (await link.getText()) || '';
                    username = username.trim();

                    if (!username) {
                        // Fallback: use textContent attribute
                        try {
                            username = ((await link.getAttribute('textContent')) || '').trim();
                        } catch (_) {
                            // ignore
                        }
                    }

                    // Build absolute Rolimons profile URL from href
                    let profileUrl = (await link.getAttribute('href')) || '';
                    if (profileUrl && !profileUrl.startsWith('http')) {
                        profileUrl = `https://www.rolimons.com${profileUrl}`;
                    }

                    if (!username) {
                        console.log(`⚠️ Username text empty for row ${i} (from bottom), proceeding with profile link: ${profileUrl}`);
                        // Last-resort username from URL path segment
                        if (profileUrl) {
                            const parts = profileUrl.split('/').filter(Boolean);
                            username = parts[parts.length - 1] || 'Unknown';
                        } else {
                            username = 'Unknown';
                        }
                    }
                    if (processedUsers.has(username)) {
                        console.log(`⏭️ Skipping already processed user: ${username}`);
                        await new Promise(res => setTimeout(res, 6000));
                        continue;
                    }

                    console.log(`🔍 Checking user ${rows.length - i}/${rows.length} (row ${i} from bottom): ${username}`);
                    const rolimons = await scrapeRolimonsUserProfile(profileUrl);
                    rolimons.profileUrl = profileUrl; // Include the profile URL for webhook

                    if (rolimons.tradeAds > 500) {
                        console.log(`❌ Too many trade ads (${rolimons.tradeAds}), skipping ${username}`);
                        processedUsers.add(username);
                        await new Promise(res => setTimeout(res, 6000));
                        continue;
                    }
                    if (rolimons.value >= 6000000) {
                        console.log(`❌ Value too high (${rolimons.value}), skipping ${username}`);
                        processedUsers.add(username);
                        await new Promise(res => setTimeout(res, 6000));
                        continue;
                    }

                    // Process user immediately
                    console.log(`🔍 Processing user: ${username}`);
                    const hit = await lookupDiscordAndSend(username, rolimons);

                    // Wait 10 seconds before moving to the next user
                    await new Promise(res => setTimeout(res, 10000));
                    processedUsers.add(username);
                    if (hit) {
                        totalLogged++;
                    }

                } catch (error) {
                    console.error(`❌ Error processing row ${i} (from bottom):`, error.message);
                    // Add retry logic for critical errors
                    if (error.message.includes('failed to start a thread') || error.message.includes('SIGTRAP')) {
                        console.log('🔄 Critical error detected, attempting recovery...');
                        await new Promise(res => setTimeout(res, 10000)); // Wait 10 seconds
                        
                        // Try to reinitialize drivers if they're broken
                        try {
                            if (driver) {
                                await driver.quit();
                            }
                            if (profileDriver) {
                                await profileDriver.quit();
                            }
                        } catch (e) {
                            console.log('Error closing broken drivers:', e.message);
                        }
                        
                        // Reinitialize
                        await initializeWebDriver();
                        
                        // Skip this user and continue
                        processedUsers.add(username || `unknown_${i}`);
                        continue;
                    }
                }
            }
            console.log(`✅ Finished page ${page}/${totalPages}`);
        }
        console.log(`✅ All users processed for item ${itemId}. Total valid hits so far: ${totalLogged}`);
        isScraping = false;
    } catch (error) {
        console.error('❌ Error during scraping:', error.message);
        
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            console.log(`🔄 Restarting scrape in 10 seconds... (attempt ${retryCount}/${MAX_RETRIES})`);
            
            // Try to reinitialize drivers
            try {
                if (driver) await driver.quit();
                if (profileDriver) await profileDriver.quit();
            } catch (e) {
                console.log('Error closing drivers during restart:', e.message);
            }
            
            await initializeWebDriver();
            setTimeout(() => scrapeRolimonsItem(itemId), 10000);
        } else {
            console.log('❌ Max retries reached, giving up on this item');
            retryCount = 0; // Reset for next item
        }
    }
}

function parseLastOnlineDays(text) {
    text = text.toLowerCase();
    if (
        text.includes('second') ||
        text.includes('minute') ||
        text.includes('hour') ||
        text.includes('just now')
    ) {
        return 0;
    }
    const match = text.match(/(\d+)\s*day/);
    if (match) {
        return parseInt(match[1]);
    }
    return 999; // fallback for unknown format
}

async function scrapeRolimonsUserProfile(profileUrl, retryAttempt = 0) {
    if (!profileDriver) {
        console.error('❌ Profile driver not initialized');
        return {
            tradeAds: 0,
            rap: 0,
            value: 0,
            avatarUrl: '',
            lastOnlineText: 'Unknown',
            lastOnlineDays: 999
        };
    }

    try {
        await profileDriver.get(profileUrl);
        await profileDriver.sleep(2000);

        const getText = async (selector) => {
            try {
                const element = await profileDriver.findElement(By.css(selector));
                return await element.getText();
            } catch {
                return '';
            }
        };

        let tradeAds = 0;
        try {
            try {
                const tradeAdsElement = await profileDriver.findElement(By.css('span.card-title.mb-1.text-light.stat-data.text-nowrap'));
                const text = await tradeAdsElement.getText();
                if (text && !isNaN(text.replace(/,/g, ''))) {
                    tradeAds = parseInt(text.replace(/,/g, '')) || 0;
                    console.log(`✅ Found trade ads with exact selector: ${tradeAds}`);
                }
            } catch (e) {
                console.log('⚠️ Exact selector failed, trying contextual search...');
            }
            if (tradeAds === 0) {
                try {
                    const contextElements = await profileDriver.findElements(By.xpath("//*[contains(text(), 'Trade Ads') and contains(text(), 'Created')]/following::*[contains(@class, 'stat-data')][1] | //*[contains(text(), 'Trade Ads') and contains(text(), 'Created')]/..//*[contains(@class, 'stat-data')]"));
                    if (contextElements.length > 0) {
                        const text = await contextElements[0].getText();
                        if (text && !isNaN(text.replace(/,/g, ''))) {
                            tradeAds = parseInt(text.replace(/,/g, '')) || 0;
                            console.log(`✅ Found trade ads via "Trade Ads Created" context: ${tradeAds}`);
                        }
                    }
                } catch (e) {
                    console.log('⚠️ Contextual search failed, trying alternative selectors...');
                }
            }
            if (tradeAds === 0) {
                const selectors = [
                    '.card-title.mb-1.text-light.stat-data.text-nowrap',
                    'span.stat-data.text-nowrap',
                    '.stat-data.text-nowrap',
                    '.card-title.stat-data'
                ];
                for (const selector of selectors) {
                    try {
                        const elements = await profileDriver.findElements(By.css(selector));
                        for (const element of elements) {
                            const text = await element.getText();
                            if (text && /^\d{1,3}(,\d{3})*$/.test(text)) {
                                const numValue = parseInt(text.replace(/,/g, ''));
                                if (numValue > 0 && numValue <= 50000) {
                                    tradeAds = numValue;
                                    console.log(`✅ Found trade ads: ${tradeAds} using selector: ${selector}`);
                                    break;
                                }
                            }
                        }
                        if (tradeAds > 0) break;
                    } catch (e) { continue; }
                }
            }
            if (tradeAds === 0) {
                console.log('⚠️ Could not find trade ads with any method');
            }
        } catch (e) {
            console.log('⚠️ Error finding trade ads:', e.message);
        }
        const rap = parseInt((await getText('#player_rap')).replace(/,/g, '')) || 0;
        const value = parseInt((await getText('#player_value')).replace(/,/g, '')) || 0;
        const lastOnlineText = await getText('#location_pane_last_seen_online');

        let lastOnlineDays = parseLastOnlineDays(lastOnlineText);

        // Extract Roblox avatar image URL
        let avatarUrl = '';
        try {
            const avatarImg = await profileDriver.findElement(By.css('img.mx-auto.d-block.w-100.h-100[src^="https://tr.rbxcdn.com/"]'));
            avatarUrl = await avatarImg.getAttribute('src');
            if (avatarUrl) {
                console.log(`✅ Found avatar URL: ${avatarUrl.substring(0, 60)}...`);
            }
        } catch (e) {
            console.log('⚠️ Could not find avatar image:', e.message);
        }

        return {
            tradeAds,
            rap,
            value,
            avatarUrl,
            lastOnlineText,
            lastOnlineDays
        };
    } catch (error) {
        console.error('❌ Failed to scrape profile:', error.message);
        
        // Retry logic for profile scraping
        if (retryAttempt < MAX_RETRIES && (error.message.includes('failed to start a thread') || error.message.includes('SIGTRAP'))) {
            console.log(`🔄 Retrying profile scrape (attempt ${retryAttempt + 1}/${MAX_RETRIES})...`);
            await new Promise(res => setTimeout(res, 5000)); // Wait 5 seconds
            return await scrapeRolimonsUserProfile(profileUrl, retryAttempt + 1);
        }
        
        return {
            tradeAds: 0,
            rap: 0,
            value: 0,
            avatarUrl: '',
            lastOnlineText: 'Unknown',
            lastOnlineDays: 999
        };
    }
}

function extractDiscordFromRecord(record) {
    if (!record || typeof record !== 'object') return null;

    // Prefer explicit fields if present
    if (record.discord_tag) return String(record.discord_tag);
    if (record.discord_username && record.discriminator) {
        return `${record.discord_username}#${record.discriminator}`;
    }
    if (record.discord_username) return String(record.discord_username);

    // Nexus /lookup/roblox currently returns objects like:
    // { "username": "<discord username>", "score": 1100, "server_id": "..." }
    // So treat "username" as the Discord username when present.
    if (record.username) return String(record.username);

    // Fallback: any field whose key mentions "discord"
    const key = Object.keys(record).find(k => k.toLowerCase().includes('discord'));
    if (key && record[key]) {
        return String(record[key]);
    }

    return null;
}

async function lookupDiscordAndSend(robloxUsername, rolimonsData) {
    try {
        const response = await axios.get(NEXUS_API_URL, {
            params: { query: robloxUsername },
            headers: {
                'x-admin-key': NEXUS_ADMIN_KEY
            }
        });

        const body = response.data || {};
        const records = Array.isArray(body.data) ? body.data : [];

        if (!records.length) {
            console.log(`ℹ️ No Discord found for ${robloxUsername} (Nexus API returned empty data[])`);
            return false;
        }

        const discordRecord = records[0];
        const discordValue = extractDiscordFromRecord(discordRecord);

        if (!discordValue) {
            console.log(`ℹ️ Could not extract Discord field from Nexus API response for ${robloxUsername}`);
            return false;
        }

        await sendToWebhook(robloxUsername, discordValue, discordRecord, rolimonsData);
        await sendUsernameOnlyToWebhook(discordValue);
        return true;
    } catch (error) {
        console.error(`❌ Nexus API error for ${robloxUsername}:`, error.message);
        return false;
    }
}

async function sendToWebhook(robloxUsername, discordUsername, discordRecord, rolimonsData) {
    console.log(`📤 sendToWebhook called: Roblox=${robloxUsername}, Discord=${discordUsername}`);
    try {
        const fields = [];
        
        // Discord Username (primary field)
        fields.push({ 
            name: "Discord Username", 
            value: discordUsername, 
            inline: false 
        });
        
        // Discord ID if available from record
        if (discordRecord && discordRecord.user_id) {
            fields.push({ 
                name: "Discord ID", 
                value: discordRecord.user_id.toString(), 
                inline: true 
            });
        } else if (discordRecord && discordRecord.id) {
            fields.push({ 
                name: "Discord ID", 
                value: discordRecord.id.toString(), 
                inline: true 
            });
        }
        
        // Roblox Username
        fields.push({ 
            name: "Roblox Username", 
            value: robloxUsername, 
            inline: true 
        });
        
        // Rolimons Value
        if (rolimonsData && rolimonsData.value) {
            fields.push({ 
                name: "Value", 
                value: rolimonsData.value.toLocaleString(), 
                inline: true 
            });
        }
        
        // Trade Ads
        if (rolimonsData && rolimonsData.tradeAds !== undefined) {
            fields.push({ 
                name: "Trade Ads", 
                value: rolimonsData.tradeAds.toString(), 
                inline: true 
            });
        }
        
        // Build embed with thumbnail (avatar image)
        const embed = {
            title: "✨ New Discord Found!",
            color: 0x00AE86,
            fields: fields,
            timestamp: new Date().toISOString()
        };
        
        // Add thumbnail (Roblox avatar) if available
        if (rolimonsData && rolimonsData.avatarUrl) {
            embed.thumbnail = {
                url: rolimonsData.avatarUrl
            };
        }
        
        // Add Rolimons profile link if available
        if (rolimonsData && rolimonsData.profileUrl) {
            fields.push({
                name: "Rolimons Profile",
                value: `[View Profile](${rolimonsData.profileUrl})`,
                inline: false
            });
        }
        
        const payload = {
            embeds: [embed]
        };
        
        console.log('Sending webhook: new Discord found...');
        const response = await axios.post(WEBHOOK_URL, payload);
        console.log('✅ Webhook sent successfully, status:', response.status);
    } catch (e) {
        console.error('❌ Webhook POST error:', e.message);
        if (e.response) {
            console.error('Response status:', e.response.status);
            console.error('Response data:', e.response.data);
        }
    }
}

async function sendUsernameOnlyToWebhook(discordUsername) {
    console.log(`📤 Sending Discord username only to username webhook: ${discordUsername}`);
    try {
        const payload = {
            content: discordUsername
        };
        
        const response = await axios.post(USERNAME_WEBHOOK_URL, payload);
        console.log('✅ Username-only webhook sent successfully, status:', response.status);
    } catch (e) {
        console.error('❌ Username-only webhook POST error:', e.message);
        if (e.response) {
            console.error('Response status:', e.response.status);
            console.error('Response data:', e.response.data);
        }
    }
}

async function cleanup() {
    console.log('🧹 Cleaning up resources...');
    
    if (driver) {
        try {
            await driver.quit();
            console.log('✅ Main driver closed');
        } catch (e) {
            console.log('Error closing main driver:', e.message);
        }
    }
    
    if (profileDriver) {
        try {
            await profileDriver.quit();
            console.log('✅ Profile driver closed');
        } catch (e) {
            console.log('Error closing profile driver:', e.message);
        }
    }
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await cleanup();
});

// Validate required environment variables
if (!WEBHOOK_URL) {
    console.error('❌ WEBHOOK_URL environment variable is required');
    process.exit(1);
}
if (!USERNAME_WEBHOOK_URL) {
    console.error('❌ USERNAME_WEBHOOK_URL environment variable is required');
    process.exit(1);
}
if (!NEXUS_ADMIN_KEY) {
    console.error('❌ NEXUS_ADMIN_KEY environment variable is required');
    process.exit(1);
}

// Railway deployment logging
console.log('🚀 Starting Railway deployment...');
console.log('📋 Configuration:');
console.log(`   - Webhook URL: ${WEBHOOK_URL.substring(0, 50)}...`);
console.log(`   - Username Webhook URL: ${USERNAME_WEBHOOK_URL.substring(0, 50)}...`);
console.log(`   - Item IDs: ${ITEM_IDS}`);

startScraper();
