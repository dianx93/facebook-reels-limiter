// ==UserScript==
// @name         Facebook Reels Watch Limit
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Limit your time watching Reels. Blocks Facebook for a cooldown after hitting your limit.
// @match        *://*.facebook.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // === Config ===
    const MAX_REELS = 20;
    const BLOCK_DURATION_M = 15;
    const INACTIVITY_RESET_M = 10;

    // === Config helpers ===
    const BLOCK_DURATION_MS = BLOCK_DURATION_M * 60 * 1000;
    const INACTIVITY_RESET_MS = INACTIVITY_RESET_M * 60 * 1000;

    // === Keys ===
    const SESSION_KEYS = {
        count: 'frwl_count',
        lastVisit: 'frwl_last_visit'
    };
    const LOCAL_KEYS = {
        blockUntil: 'frwl_block_until'
    };

    // === In-memory state ===
    let lastReelId = '';
    let blockUntilCache = 0;

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && isBlocked()) {
            document.querySelectorAll('video, audio').forEach(el => {
                el.pause();
                el.src = '';
                el.removeAttribute('src');
                el.load();
            });
        }
    });

    // === Storage helpers ===
    function now() {
        return Date.now();
    }

    function getSession(key, fallback = 0) {
        const val = sessionStorage.getItem(key);
        const parsed = parseInt(val, 10);
        return isNaN(parsed) ? fallback : parsed;
    }

    function setSession(key, value) {
        sessionStorage.setItem(key, value.toString());
    }

    function setBlockUntil(value) {
        blockUntilCache = value;
        sessionStorage.setItem(LOCAL_KEYS.blockUntil, value.toString());
        localStorage.setItem(LOCAL_KEYS.blockUntil, value.toString());
    }

    function getBlockUntil() {
        const nowTime = now();

        const tryParse = (val, source) => {
            const parsed = parseInt(val, 10);
            if (!isNaN(parsed)) {
                if (parsed > nowTime) {
                    console.log(`[ReelLimit] blockUntil from ${source}: ${parsed}`);
                    return parsed;
                } else {
                    console.log(`[ReelLimit] blockUntil from ${source} is expired`);
                }
            }
            return 0;
        };

        const fromLocal = tryParse(localStorage.getItem(LOCAL_KEYS.blockUntil), 'localStorage');
        if (fromLocal) return fromLocal;

        const fromSession = tryParse(sessionStorage.getItem(LOCAL_KEYS.blockUntil), 'sessionStorage');
        if (fromSession) return fromSession;

        if (blockUntilCache > nowTime) {
            console.warn(`[ReelLimit] Restoring blockUntil from in-memory cache: ${blockUntilCache}`);
            return blockUntilCache;
        }

        return 0;
    }

    // === Other helpers ===
    function isReelUrl(url) {
        return url.includes('/reel/');
    }

    function resetCounter() {
        setSession(SESSION_KEYS.count, 0);
        setSession(SESSION_KEYS.lastVisit, now());
        setSession('frwl_first_visit', now());
        console.log('[ReelLimit] Counter reset');
    }

    function showBlockPage(until) {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                document.querySelectorAll('video, audio').forEach(el => {
                    el.muted = true;
                    el.volume = 0;
                    el.pause();
                });
            }
        });

        // Mute and pause all video/audio players to prevent background sound
        document.querySelectorAll('video, audio').forEach(el => {
            el.muted = true;
            el.volume = 0;
            el.pause();
        });

        document.head.innerHTML = '';
        document.body.innerHTML = `
        <div id="reel-blocker" style="
            all: initial;
            background-color: #111 !important;
            color: #f1f1f1 !important;
            font-family: sans-serif !important;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            height: 100vh;
            padding: 2em;
        ">
            <h1 style="font-size: 2em; margin-bottom: 0.5em;">⛔ Facebook reels are blocked</h1>
            <p style="font-size: 1.2em;">Please take a break and come back later ✨</p>
            <p id="reel-timer" style="margin-top: 1em; font-size: 1.5em;"></p>
        </div>
        `;

        const timerEl = document.getElementById('reel-timer');
        function updateCountdown() {
            const remaining = until - now();
            if (remaining <= 0) {
                location.reload();
            } else {
                const mins = Math.floor(remaining / 60000);
                const secs = Math.floor((remaining % 60000) / 1000);
                timerEl.textContent = `⏳ ${mins}:${secs.toString().padStart(2, '0')} remaining`;
            }
        }

        updateCountdown();
        setInterval(updateCountdown, 1000);
    }

    function isBlocked() {
        const blocked = now() < getBlockUntil();
        console.log(`[ReelLimit] isBlocked → ${blocked}`);
        return blocked;
    }

    function blockFacebook() {
        const blockUntil = now() + BLOCK_DURATION_MS;
        setBlockUntil(blockUntil);
        resetCounter();
        showBlockPage(blockUntil);
    }

    // === Main logic ===
    function update() {
        if (!isReelUrl(location.href)) {
            removeProgressBar(); // 👈 remove the bar if leaving reels
            return;
        }

        const currentReelId = location.href.split('/reel/')[1]?.split(/[/?#]/)[0] || '';
        if (!currentReelId) return;

        if (currentReelId === lastReelId) {
            console.log(`[ReelLimit] Same reel: ${currentReelId} — skipping`);
            return;
        }

        console.log(`[ReelLimit] New reel: ${currentReelId}`);
        lastReelId = currentReelId;

        if (isBlocked()) {
            showBlockPage(getBlockUntil());
            return;
        }

        let firstVisit = getSession('frwl_first_visit', 0);
        if (firstVisit === 0) {
            firstVisit = now();
            setSession('frwl_first_visit', firstVisit);
        }

        let lastVisit = getSession(SESSION_KEYS.lastVisit, 0);
        const currentTime = now();
        if (lastVisit === 0) {
            console.log(`[ReelLimit] First reel in session — setting lastVisit`);
            lastVisit = currentTime;
            setSession(SESSION_KEYS.lastVisit, currentTime);
        }

        const timeSinceLast = currentTime - lastVisit;
        console.log(`[ReelLimit] lastVisit=${lastVisit}, now=${currentTime}, timeSinceLast=${timeSinceLast}, INACTIVITY_RESET_MS=${INACTIVITY_RESET_MS}`);

        if (timeSinceLast > INACTIVITY_RESET_MS) {
            console.log(`[ReelLimit] Inactive for ${Math.floor(timeSinceLast / 1000)}s — resetting`);
            resetCounter();
        }

        const count = getSession(SESSION_KEYS.count, 0);
        if (count + 1 > MAX_REELS) {
            blockFacebook();
        } else {
            setSession(SESSION_KEYS.count, count + 1);
            setSession(SESSION_KEYS.lastVisit, now());
            showProgressBar(count + 1, MAX_REELS);
            console.log(`[ReelLimit] Count = ${count + 1}`);
        }
    }

    // === Progress widget logic ===
    function showProgressBar(current, max) {
        const firstVisit = getSession('frwl_first_visit', now());

        let bar = document.getElementById('reel-limit-bar');
        let timeEl, counterEl, fill;

        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'reel-limit-bar';
            bar.style.position = 'fixed';
            bar.style.bottom = '1em';
            bar.style.left = '1em';
            bar.style.background = '#222';
            bar.style.color = '#fff';
            bar.style.fontSize = '14px';
            bar.style.fontFamily = 'sans-serif';
            bar.style.padding = '0.5em 1em';
            bar.style.borderRadius = '10px';
            bar.style.boxShadow = '0 0 5px rgba(0,0,0,0.5)';
            bar.style.zIndex = 999999;
            bar.style.opacity = '0.9';

            timeEl = document.createElement('div');
            timeEl.id = 'reel-limit-time';
            bar.appendChild(timeEl);

            counterEl = document.createElement('div');
            counterEl.id = 'reel-limit-counter';
            bar.appendChild(counterEl);

            const inner = document.createElement('div');
            inner.id = 'reel-limit-progress';
            inner.style.background = '#444';
            inner.style.borderRadius = '5px';
            inner.style.overflow = 'hidden';
            inner.style.marginTop = '0.4em';

            fill = document.createElement('div');
            fill.id = 'reel-limit-fill';
            fill.style.height = '6px';
            fill.style.width = '0%';
            fill.style.background = '#4caf50';
            fill.style.transition = 'width 0.3s';

            inner.appendChild(fill);
            bar.appendChild(inner);
            document.body.appendChild(bar);

            // ⏱ Update time wasted every second
            setInterval(() => {
                const mins = Math.floor((now() - firstVisit) / 60000);
                const secs = Math.floor(((now() - firstVisit) % 60000) / 1000);
                const t = mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;
                timeEl.textContent = `⏱ Time wasted: ${t}`;
            }, 1000);
        } else {
            timeEl = document.getElementById('reel-limit-time');
            counterEl = document.getElementById('reel-limit-counter');
            fill = document.getElementById('reel-limit-fill');
        }

        // Update count + progress fill
        counterEl.textContent = `📊 ${current} / ${max} Reels`;
        const percent = Math.min(100, Math.floor((current / max) * 100));
        fill.style.width = `${percent}%`;
    }

    function removeProgressBar() {
        const bar = document.getElementById('reel-limit-bar');
        if (bar) {
            bar.remove();
            console.log('[ReelLimit] Progress bar removed (not on a reel)');
        }
    }

    // === SPA-safe URL change detector ===
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
        const currentUrl = location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            console.log(`[ReelLimit] URL changed: ${currentUrl}`);
            update();
        }
    });

    observer.observe(document, { subtree: true, childList: true });
    // Also trigger on initial page load (especially if page starts on a reel)
    if (isReelUrl(location.href)) {
        console.log('[ReelLimit] Initial reel load detected — checking immediately');
        update();
    }

})();
