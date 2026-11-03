// ==UserScript==
// @name         Facebook Reels Watch Limit
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Limit your time watching Reels. Blocks Reels for a cooldown after hitting your limit.
// @author       Diana Täht (dianx93)
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
        lastVisit: 'frwl_last_visit',
        seen: 'frwl_seen'
    };
    const LOCAL_KEYS = {
        blockUntil: 'frwl_block_until'
    };

    // === Facebook navigation that must stay usable while blocked ===
    // Top bar (Home, search, Messenger, notifications...) and the popups/chats it opens
    const TOP_BAR_SELECTOR = 'div[role="banner"]';
    const NAV_SELECTOR = [TOP_BAR_SELECTOR, '[role="dialog"]', '[role="menu"]', '[role="complementary"]'].join(', ');
    // Within Facebook's page container (see overlayHost): above the Reels, below the top bar and its popups
    const OVERLAY_Z_INDEX = '1';

    // Keys that move through the Reels feed, and which way
    const SKIP_KEYS = {
        ArrowDown: 'down',
        PageDown: 'down',
        ArrowUp: 'up',
        PageUp: 'up'
    };

    // === In-memory state ===
    let lastReelId = '';
    let blockUntilCache = 0;
    let block = null;
    let progressTimerId = 0;

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

    // Reels already counted this round, so scrolling back to them is free
    function getSeenReels() {
        try {
            const seen = JSON.parse(sessionStorage.getItem(SESSION_KEYS.seen));
            return Array.isArray(seen) ? seen : [];
        } catch {
            return [];
        }
    }

    function addSeenReel(id) {
        const seen = getSeenReels();
        if (!seen.includes(id)) seen.push(id);
        sessionStorage.setItem(SESSION_KEYS.seen, JSON.stringify(seen));
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
        sessionStorage.removeItem(SESSION_KEYS.seen);
        setSession(SESSION_KEYS.lastVisit, now());
        setSession('frwl_first_visit', now());
        console.log('[ReelLimit] Counter reset');
    }

    function formatRemaining(ms) {
        const totalSecs = Math.max(0, Math.ceil(ms / 1000));
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function pauseAllMedia() {
        document.querySelectorAll('video, audio').forEach(el => {
            try {
                if (!el.paused) el.pause();
            } catch {}
        });
    }

    // Returns the element's rect if it is actually on screen, otherwise null
    function visibleRect(el) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return null;
        return r;
    }

    // Fit the overlay to the area below Facebook's top bar.
    // The banner element itself has no height; the visible bar is a fixed child of it.
    function positionOverlay(overlay) {
        let top = 0;
        document.querySelectorAll(`${TOP_BAR_SELECTOR}, ${TOP_BAR_SELECTOR} > *`).forEach(el => {
            const r = visibleRect(el);
            if (r && r.top <= 0) top = Math.max(top, r.bottom);
        });

        // The full-screen Reel viewer (opened from the feed) has a see-through top bar with the video
        // showing between its buttons. Cover that strip too; the buttons are layered above the overlay.
        const v = activeVideo();
        if (v && top > 0) {
            const r = v.getBoundingClientRect();
            if (r.top < top) {
                const stack = document.elementsFromPoint((r.left + r.right) / 2, Math.max(r.top, 0) + 1);
                const barIndex = stack.findIndex(el => el.closest(TOP_BAR_SELECTOR));
                const videoIndex = stack.indexOf(v);
                if (videoIndex !== -1 && (barIndex === -1 || videoIndex < barIndex)) top = 0;
            }
        }

        overlay.style.top = `${Math.round(top)}px`;
    }

    // The top bar and its popups (notifications, Messenger, menus) are layered inside a z-indexed
    // page container. Placed in there the overlay can sit below them; on <body> it would cover them.
    function overlayHost() {
        const banner = document.querySelector(TOP_BAR_SELECTOR);
        let el = banner && banner.parentElement;
        while (el && el !== document.body && getComputedStyle(el).zIndex === 'auto') el = el.parentElement;
        return el || document.body;
    }

    // Facebook's chat windows are on the same layer as the Reels, in a container that comes after them.
    // Put the overlay right after the Reels so it covers them but stays below the chats opened later.
    function placeOverlay(overlay) {
        const host = overlayHost();
        let reels = activeVideo();
        while (reels && reels.parentElement !== host) reels = reels.parentElement;
        if (reels) {
            if (overlay.previousElementSibling !== reels) reels.after(overlay);
        } else if (overlay.parentElement !== host) {
            host.appendChild(overlay);
        }
    }

    function createNavButton(label, href) {
        const a = document.createElement('a');
        a.href = href;
        a.textContent = label;
        Object.assign(a.style, {
            display: 'inline-block',
            padding: '10px 18px',
            borderRadius: '18px',
            background: '#3a3b3c',
            color: '#e4e6eb',
            fontSize: '14px',
            fontWeight: '600',
            textDecoration: 'none'
        });
        a.addEventListener('mouseenter', () => { a.style.background = '#4e4f50'; });
        a.addEventListener('mouseleave', () => { a.style.background = '#3a3b3c'; });
        return a;
    }

    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'reel-limit-block';
        Object.assign(overlay.style, {
            position: 'fixed',
            top: '0',
            right: '0',
            bottom: '0',
            left: '0',
            zIndex: OVERLAY_Z_INDEX,
            background: '#18191a',
            color: '#e4e6eb',
            fontFamily: 'Segoe UI, Helvetica, Arial, sans-serif',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            padding: '24px',
            boxSizing: 'border-box',
            textAlign: 'center',
            overscrollBehavior: 'contain'
        });

        const title = document.createElement('div');
        title.textContent = 'Reels limit reached';
        Object.assign(title.style, { fontSize: '22px', fontWeight: '600' });

        const subtitle = document.createElement('div');
        subtitle.textContent = `You watched ${MAX_REELS} Reels. They unlock again in`;
        Object.assign(subtitle.style, { fontSize: '14px', color: '#b0b3b8' });

        const timeEl = document.createElement('div');
        Object.assign(timeEl.style, {
            fontSize: '64px',
            fontWeight: '700',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: '1.1',
            margin: '4px 0 12px'
        });

        const resumeBtn = document.createElement('button');
        resumeBtn.type = 'button';
        resumeBtn.textContent = 'Resume';
        Object.assign(resumeBtn.style, {
            display: 'none',
            padding: '12px 32px',
            margin: '4px 0 12px',
            border: 'none',
            borderRadius: '20px',
            background: '#e4e6eb',
            color: '#18191a',
            fontFamily: 'inherit',
            fontSize: '16px',
            fontWeight: '600',
            cursor: 'pointer'
        });

        const links = document.createElement('div');
        Object.assign(links.style, { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' });
        links.appendChild(createNavButton('Home', '/'));
        links.appendChild(createNavButton('Messenger', '/messages/'));

        overlay.append(title, subtitle, timeEl, resumeBtn, links);
        return { overlay, title, subtitle, timeEl, resumeBtn };
    }

    // Break is over: keep Reels paused behind the overlay until the user chooses to continue
    function showUnlocked(els) {
        els.title.textContent = 'Reels unlocked';
        els.subtitle.textContent = 'Your break is over. Resume the Reel you were on, or scroll for a new one.';
        els.timeEl.style.display = 'none';
        els.resumeBtn.style.display = 'inline-block';
        console.log('[ReelLimit] Block expired — waiting for Resume or scroll');
    }

    // The Reel currently on screen: the video taking up the most of the viewport
    function activeVideo() {
        let best = null;
        let bestArea = 0;
        document.querySelectorAll('video').forEach(v => {
            const r = v.getBoundingClientRect();
            const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
            const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
            const area = w > 0 && h > 0 ? w * h : 0;
            if (area > bestArea) {
                bestArea = area;
                best = v;
            }
        });
        return best;
    }

    // The block paused Facebook's player, and it doesn't always start again by itself.
    // Keep nudging the on-screen Reel for a moment, until the user clicks or presses a key.
    function playActiveReel() {
        const startedAt = now();
        let intervalId = 0;
        const stop = () => {
            clearInterval(intervalId);
            window.removeEventListener('pointerdown', stop, true);
            window.removeEventListener('keydown', stop, true);
        };
        const nudge = () => {
            if (block || now() - startedAt > 2000) {
                stop();
                return;
            }
            const v = activeVideo();
            if (v && v.paused) v.play().catch(() => {});
        };
        window.addEventListener('pointerdown', stop, true);
        window.addEventListener('keydown', stop, true);
        intervalId = setInterval(nudge, 200);
        nudge();
    }

    // Facebook only reacts to the arrow keys while its Reels feed has keyboard focus
    function focusReelsFeed() {
        const v = activeVideo();
        const feed = v && v.closest('[tabindex]');
        if (feed) feed.focus({ preventScroll: true });
        return feed;
    }

    // Resume: carry on with the Reel the block landed on, in place, so Facebook keeps its sound settings
    function resumeBlockedReel() {
        hideBlockPage();
        // Count it as the first Reel of the new round, which also brings back the progress bar
        lastReelId = '';
        update();
        focusReelsFeed();
        playActiveReel();
        console.log('[ReelLimit] Resumed after break');
    }

    // Scroll/swipe/arrow key after the break: move to the next/previous Reel with an arrow key press
    function skipReel(direction) {
        hideBlockPage();

        // One wheel gesture fires many events; eat the rest so it only moves one Reel
        let idleTimer = 0;
        const stopEating = () => window.removeEventListener('wheel', eatWheel, true);
        const eatWheel = (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            clearTimeout(idleTimer);
            idleTimer = setTimeout(stopEating, 300);
        };
        window.addEventListener('wheel', eatWheel, { capture: true, passive: false });
        idleTimer = setTimeout(stopEating, 300);
        setTimeout(stopEating, 2000);

        const feed = focusReelsFeed();
        if (feed) {
            const key = direction === 'down' ? 'ArrowDown' : 'ArrowUp';
            const keyCode = direction === 'down' ? 40 : 38;
            feed.dispatchEvent(new KeyboardEvent('keydown', {
                key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true
            }));
        }
        playActiveReel();
        console.log(`[ReelLimit] Skipped ${direction} after break`);
    }

    function showBlockPage(until) {
        if (block) {
            block.until = until;
            return;
        }

        removeProgressBar();
        const els = createOverlay();
        const { overlay, timeEl, resumeBtn } = els;
        placeOverlay(overlay);

        resumeBtn.addEventListener('click', resumeBlockedReel);

        // Stop Reels from (auto)playing behind the overlay. Media events don't bubble, so listen in capture phase.
        const onPlay = (e) => {
            if (e.target instanceof HTMLMediaElement) e.target.pause();
        };
        document.addEventListener('play', onPlay, true);

        // Swallow scrolling on the overlay so the Reels feed underneath can't advance.
        // Once the break is over, a scroll/swipe moves on to another Reel instead.
        const onWheel = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (block && block.unlocked && Math.abs(e.deltaY) > 0) skipReel(e.deltaY > 0 ? 'down' : 'up');
        };
        overlay.addEventListener('wheel', onWheel, { passive: false });

        let touchStartY = null;
        overlay.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
        }, { passive: true });
        overlay.addEventListener('touchmove', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Touch events keep targeting the overlay after skipReel() removed it
            if (!block || !block.unlocked || touchStartY === null) return;
            const dy = touchStartY - e.touches[0].clientY;
            if (Math.abs(dy) > 50) {
                touchStartY = null;
                skipReel(dy > 0 ? 'down' : 'up');
            }
        }, { passive: false });

        // Block Reels keyboard shortcuts (arrows, space...) but leave the nav, chats and browser shortcuts alone
        const onKey = (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target;
            if (t instanceof Element) {
                if (t.isContentEditable || t.closest('input, textarea, select')) return;
                if (t.closest(NAV_SELECTOR)) return;
            }
            if (block.unlocked && SKIP_KEYS[e.key]) {
                e.preventDefault();
                e.stopImmediatePropagation();
                skipReel(SKIP_KEYS[e.key]);
                return;
            }
            if (e.key === 'Tab' || e.key === 'Escape') return;
            // Enter/Space on the overlay's own buttons
            if (t instanceof Element && t.closest('#reel-limit-block')) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        window.addEventListener('keydown', onKey, true);

        const tick = () => {
            const remaining = block.until - now();
            if (remaining <= 0) {
                if (!block.unlocked) {
                    block.unlocked = true;
                    showUnlocked(els);
                }
            } else {
                timeEl.textContent = formatRemaining(remaining);
            }
            // Facebook may re-render the page container; follow it
            placeOverlay(overlay);
            positionOverlay(overlay);
            pauseAllMedia();
        };

        block = {
            until,
            overlay,
            unlocked: false,
            intervalId: 0,
            cleanup() {
                clearInterval(this.intervalId);
                document.removeEventListener('play', onPlay, true);
                window.removeEventListener('keydown', onKey, true);
                overlay.remove();
            }
        };

        tick();
        // Short interval so the overlay follows the top bar if it changes size
        block.intervalId = setInterval(tick, 250);
        console.log('[ReelLimit] Block overlay shown');
    }

    function hideBlockPage() {
        if (!block) return;
        block.cleanup();
        block = null;
        console.log('[ReelLimit] Block overlay removed');
    }

    function isBlocked() {
        const blocked = now() < getBlockUntil();
        console.log(`[ReelLimit] isBlocked → ${blocked}`);
        return blocked;
    }

    function blockReels() {
        const blockUntil = now() + BLOCK_DURATION_MS;
        setBlockUntil(blockUntil);
        resetCounter();
        showBlockPage(blockUntil);
    }

    // === Main logic ===
    function update() {
        if (!isReelUrl(location.href)) {
            // Leaving Reels: release everything so the rest of Facebook works normally
            lastReelId = '';
            hideBlockPage();
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

        // Break is over and the user scrolled to another Reel: drop the overlay and count this one
        if (block && block.unlocked) {
            hideBlockPage();
            playActiveReel();
        }

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
        if (getSeenReels().includes(currentReelId)) {
            setSession(SESSION_KEYS.lastVisit, now());
            showProgressBar(count, MAX_REELS);
            console.log(`[ReelLimit] Already counted ${currentReelId} — Count stays ${count}`);
        } else if (count + 1 > MAX_REELS) {
            blockReels();
        } else {
            setSession(SESSION_KEYS.count, count + 1);
            addSeenReel(currentReelId);
            setSession(SESSION_KEYS.lastVisit, now());
            showProgressBar(count + 1, MAX_REELS);
            console.log(`[ReelLimit] Count = ${count + 1}`);
        }
    }

    // === Progress widget logic ===
    function showProgressBar(current, max) {
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
            const updateTime = () => {
                const firstVisit = getSession('frwl_first_visit', now());
                const mins = Math.floor((now() - firstVisit) / 60000);
                const secs = Math.floor(((now() - firstVisit) % 60000) / 1000);
                const t = mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;
                timeEl.textContent = `⏱ Time wasted: ${t}`;
            };
            updateTime();
            clearInterval(progressTimerId);
            progressTimerId = setInterval(updateTime, 1000);
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
        clearInterval(progressTimerId);
        progressTimerId = 0;
        const bar = document.getElementById('reel-limit-bar');
        if (bar) {
            bar.remove();
            console.log('[ReelLimit] Progress bar removed (not on a reel)');
        }
    }

    // === SPA-safe URL change detector ===
    let lastUrl = location.href;
    function checkUrl() {
        const currentUrl = location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            console.log(`[ReelLimit] URL changed: ${currentUrl}`);
            update();
        }
    }

    const observer = new MutationObserver(checkUrl);
    observer.observe(document, { subtree: true, childList: true });
    window.addEventListener('popstate', checkUrl);

    // Also trigger on initial page load (especially if page starts on a reel)
    if (isReelUrl(location.href)) {
        console.log('[ReelLimit] Initial reel load detected — checking immediately');
        update();
    }

})();
