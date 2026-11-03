// ==UserScript==
// @name         Facebook Reels Watch Limit
// @namespace    http://tampermonkey.net/
// @version      1.5
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
        firstVisit: 'frwl_first_visit',
        lastVisit: 'frwl_last_visit',
        seen: 'frwl_seen'
    };
    // Kept in both localStorage and sessionStorage
    const BLOCK_UNTIL_KEY = 'frwl_block_until';

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
    let progress = null;

    // === Storage helpers ===
    function now() {
        return Date.now();
    }

    function readInt(storage, key, fallback = 0) {
        const parsed = parseInt(storage.getItem(key), 10);
        return isNaN(parsed) ? fallback : parsed;
    }

    function getSession(key, fallback = 0) {
        return readInt(sessionStorage, key, fallback);
    }

    function setSession(key, value) {
        sessionStorage.setItem(key, value);
    }

    // Reels counted this round (its length is the count), so scrolling back to them is free
    function getSeenReels() {
        try {
            const seen = JSON.parse(sessionStorage.getItem(SESSION_KEYS.seen));
            return Array.isArray(seen) ? seen : [];
        } catch {
            return [];
        }
    }

    function setSeenReels(seen) {
        sessionStorage.setItem(SESSION_KEYS.seen, JSON.stringify(seen));
    }

    function setBlockUntil(value) {
        blockUntilCache = value;
        sessionStorage.setItem(BLOCK_UNTIL_KEY, value);
        localStorage.setItem(BLOCK_UNTIL_KEY, value);
    }

    function getBlockUntil() {
        const nowTime = now();

        const fromStorage = (storage, source) => {
            const parsed = readInt(storage, BLOCK_UNTIL_KEY);
            if (!parsed) return 0;
            if (parsed <= nowTime) {
                console.log(`[ReelLimit] blockUntil from ${source} is expired`);
                return 0;
            }
            console.log(`[ReelLimit] blockUntil from ${source}: ${parsed}`);
            return parsed;
        };

        const stored = fromStorage(localStorage, 'localStorage') || fromStorage(sessionStorage, 'sessionStorage');
        if (stored) return stored;

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

    function getReelId(url) {
        return url.split('/reel/')[1]?.split(/[/?#]/)[0] || '';
    }

    function resetCounter() {
        sessionStorage.removeItem(SESSION_KEYS.seen);
        setSession(SESSION_KEYS.firstVisit, now());
        console.log('[ReelLimit] Counter reset');
    }

    function formatRemaining(ms) {
        const totalSecs = Math.max(0, Math.ceil(ms / 1000));
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    // Keep an event from its default action and from Facebook's own handlers
    function swallow(e) {
        e.preventDefault();
        e.stopImmediatePropagation();
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
    function positionOverlay(overlay, video) {
        let top = 0;
        document.querySelectorAll(`${TOP_BAR_SELECTOR}, ${TOP_BAR_SELECTOR} > *`).forEach(el => {
            const r = visibleRect(el);
            if (r && r.top <= 0) top = Math.max(top, r.bottom);
        });

        // The full-screen Reel viewer (opened from the feed) has a see-through top bar with the video
        // showing between its buttons. Cover that strip too; the buttons are layered above the overlay.
        if (video && top > 0) {
            const r = video.getBoundingClientRect();
            if (r.top < top) {
                const stack = document.elementsFromPoint((r.left + r.right) / 2, Math.max(r.top, 0) + 1);
                const barIndex = stack.findIndex(el => el.closest(TOP_BAR_SELECTOR));
                const videoIndex = stack.indexOf(video);
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
    function placeOverlay(overlay, video) {
        const host = overlayHost();
        let reels = video;
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
        const background = '#3a3b3c';
        Object.assign(a.style, {
            display: 'inline-block',
            padding: '10px 18px',
            borderRadius: '18px',
            background,
            color: '#e4e6eb',
            fontSize: '14px',
            fontWeight: '600',
            textDecoration: 'none'
        });
        a.addEventListener('mouseenter', () => { a.style.background = '#4e4f50'; });
        a.addEventListener('mouseleave', () => { a.style.background = background; });
        return a;
    }

    function createOverlay() {
        const overlay = document.createElement('div');
        Object.assign(overlay.style, {
            position: 'fixed',
            inset: '0',
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
        links.append(createNavButton('Home', '/'), createNavButton('Messenger', '/messages/'));

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
            swallow(e);
            clearTimeout(idleTimer);
            idleTimer = setTimeout(stopEating, 300);
        };
        window.addEventListener('wheel', eatWheel, { capture: true, passive: false });
        idleTimer = setTimeout(stopEating, 300);
        setTimeout(stopEating, 2000);

        const feed = focusReelsFeed();
        if (feed) {
            const [key, keyCode] = direction === 'down' ? ['ArrowDown', 40] : ['ArrowUp', 38];
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
        placeOverlay(overlay, activeVideo());

        resumeBtn.addEventListener('click', resumeBlockedReel);

        // Stop Reels from (auto)playing behind the overlay. Media events don't bubble, so listen in capture phase.
        const onPlay = (e) => {
            if (e.target instanceof HTMLMediaElement) e.target.pause();
        };
        document.addEventListener('play', onPlay, true);

        // Swallow scrolling on the overlay so the Reels feed underneath can't advance.
        // Once the break is over, a scroll/swipe moves on to another Reel instead.
        const onWheel = (e) => {
            swallow(e);
            if (block && block.unlocked && e.deltaY !== 0) skipReel(e.deltaY > 0 ? 'down' : 'up');
        };
        overlay.addEventListener('wheel', onWheel, { passive: false });

        let touchStartY = null;
        overlay.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
        }, { passive: true });
        overlay.addEventListener('touchmove', (e) => {
            swallow(e);
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
                swallow(e);
                skipReel(SKIP_KEYS[e.key]);
                return;
            }
            if (e.key === 'Tab' || e.key === 'Escape') return;
            // Enter/Space on the overlay's own buttons
            if (t instanceof Node && overlay.contains(t)) return;
            swallow(e);
        };
        window.addEventListener('keydown', onKey, true);

        const tick = () => {
            const remaining = block.until - now();
            if (remaining > 0) {
                timeEl.textContent = formatRemaining(remaining);
            } else if (!block.unlocked) {
                block.unlocked = true;
                showUnlocked(els);
            }
            // Facebook may re-render the page container; follow it
            const v = activeVideo();
            placeOverlay(overlay, v);
            positionOverlay(overlay, v);
            pauseAllMedia();
        };

        block = {
            until,
            unlocked: false,
            // Short interval so the overlay follows the top bar if it changes size
            intervalId: setInterval(tick, 250),
            cleanup() {
                clearInterval(this.intervalId);
                document.removeEventListener('play', onPlay, true);
                window.removeEventListener('keydown', onKey, true);
                overlay.remove();
            }
        };
        tick();
        console.log('[ReelLimit] Block overlay shown');
    }

    function hideBlockPage() {
        if (!block) return;
        block.cleanup();
        block = null;
        console.log('[ReelLimit] Block overlay removed');
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
            removeProgressBar();
            return;
        }

        const currentReelId = getReelId(location.href);
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

        const blockUntil = getBlockUntil();
        if (blockUntil) {
            showBlockPage(blockUntil);
            return;
        }

        const currentTime = now();
        const lastVisit = getSession(SESSION_KEYS.lastVisit);
        const timeSinceLast = currentTime - lastVisit;
        if (!lastVisit || timeSinceLast > INACTIVITY_RESET_MS) {
            console.log(lastVisit
                ? `[ReelLimit] Inactive for ${Math.floor(timeSinceLast / 1000)}s — resetting`
                : '[ReelLimit] First reel in session — starting counter');
            resetCounter();
        }
        setSession(SESSION_KEYS.lastVisit, currentTime);

        const seen = getSeenReels();
        if (seen.includes(currentReelId)) {
            showProgressBar(seen.length);
            console.log(`[ReelLimit] Already counted ${currentReelId} — Count stays ${seen.length}`);
        } else if (seen.length >= MAX_REELS) {
            blockReels();
        } else {
            seen.push(currentReelId);
            setSeenReels(seen);
            showProgressBar(seen.length);
            console.log(`[ReelLimit] Count = ${seen.length}`);
        }
    }

    // === Progress widget logic ===
    function showProgressBar(current) {
        if (progress && !progress.bar.isConnected) removeProgressBar();

        if (!progress) {
            const bar = document.createElement('div');
            Object.assign(bar.style, {
                position: 'fixed',
                bottom: '1em',
                left: '1em',
                background: '#222',
                color: '#fff',
                fontSize: '14px',
                fontFamily: 'sans-serif',
                padding: '0.5em 1em',
                borderRadius: '10px',
                boxShadow: '0 0 5px rgba(0,0,0,0.5)',
                zIndex: '999999',
                opacity: '0.9'
            });

            const timeEl = document.createElement('div');
            const counterEl = document.createElement('div');

            const inner = document.createElement('div');
            Object.assign(inner.style, {
                background: '#444',
                borderRadius: '5px',
                overflow: 'hidden',
                marginTop: '0.4em'
            });

            const fill = document.createElement('div');
            Object.assign(fill.style, {
                height: '6px',
                width: '0%',
                background: '#4caf50',
                transition: 'width 0.3s'
            });

            inner.appendChild(fill);
            bar.append(timeEl, counterEl, inner);
            document.body.appendChild(bar);

            // ⏱ Update time wasted every second
            const updateTime = () => {
                const elapsed = now() - getSession(SESSION_KEYS.firstVisit, now());
                const mins = Math.floor(elapsed / 60000);
                const secs = Math.floor((elapsed % 60000) / 1000);
                const t = mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;
                timeEl.textContent = `⏱ Time wasted: ${t}`;
            };
            updateTime();
            progress = { bar, counterEl, fill, timerId: setInterval(updateTime, 1000) };
        }

        // Update count + progress fill
        progress.counterEl.textContent = `📊 ${current} / ${MAX_REELS} Reels`;
        const percent = Math.min(100, Math.floor((current / MAX_REELS) * 100));
        progress.fill.style.width = `${percent}%`;
    }

    function removeProgressBar() {
        if (!progress) return;
        clearInterval(progress.timerId);
        progress.bar.remove();
        progress = null;
        console.log('[ReelLimit] Progress bar removed');
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

    // Also check on initial page load, in case the page starts on a reel
    update();

})();
