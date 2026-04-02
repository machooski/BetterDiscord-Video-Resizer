/**
 * @name VideoResizer
 * @author machooski
 * @description Resize video embeds in Discord chat by dragging the bottom-right corner handle.
 *              Supports YouTube, Twitter/X, uploaded videos, and more.
 * @version 1.0
 */

module.exports = class VideoResizer {
    static STYLE_ID      = "VideoResizer-styles";
    static MIN_WIDTH     = 200;
    static MIN_HEIGHT    = 112;
    static DEFAULT_WIDTH = 560;
    static DEFAULT_HEIGHT = 315;

    static MEDIA_SELECTOR = [
        'iframe[src*="youtube.com/embed"]',
        'iframe[src*="youtube-nocookie.com/embed"]',
        'iframe[src*="platform.twitter.com"]',
        'iframe[src*="twitter.com/i/videos"]',
        'iframe[src*="x.com/i/videos"]',
        'video',
    ].join(",");

    // Non resizable media
    static CALL_SCOPES = [
        '[class*="callContainer-"]',
        '[class*="voiceCallWrapper-"]',
        '[class*="streamPreview-"]',
        '[class*="pictureInPicture-"]',
    ];

    /*  Data attributes (all prefixed data-ytr-*):
     *
     *  embed   — the embed/attachment container React manages (receives --ytr-w/--ytr-h)
     *  done    — marks a media element as processed
     *  waiting — video is waiting for loadedmetadata before processing
     *  skip    — sibling elements excluded from CSS constraint lifting
     *  bar     — Discord's native video control bar (gets extra right padding)
     *  parent  — ancestor chain: overflow relief only
     *  auto-h  — ancestor chain: height forced to auto (excludes <li>)
     *  card    — ancestor with max-height, synced to video height via --ytr-h
     *  wide    — ancestor with max-width/containment, synced to video width via --ytr-w
     */

    // Lifecycle

    start() {
        this._overlays      = new Map();
        this._moveListeners = [];
        this._syncRaf       = null;
        this._barFound      = new WeakSet();

        this._onScroll = () => this._scheduleSync();
        this._onResize = () => this._scheduleSync();
        document.addEventListener("scroll", this._onScroll, { capture: true, passive: true });
        window.addEventListener("resize", this._onResize, { passive: true });

        this._injectStyles();
        this._processExistingEmbeds();
        this._startObserver();
        BdApi.Logger.info("VideoResizer", "Plugin started.");
    }

    stop() {
        if (this._observer) { this._observer.disconnect(); this._observer = null; }
        if (this._syncRaf)  { cancelAnimationFrame(this._syncRaf); this._syncRaf = null; }

        document.removeEventListener("scroll", this._onScroll, { capture: true });
        window.removeEventListener("resize", this._onResize);

        this._overlays.forEach(overlay => overlay.remove());
        this._overlays.clear();

        this._moveListeners.forEach(fn => document.removeEventListener("mousemove", fn));
        this._moveListeners = [];

        BdApi.DOM.removeStyle(VideoResizer.STYLE_ID);

        document.querySelectorAll("[data-ytr-embed]").forEach(el => {
            el.style.removeProperty("--ytr-w");
            el.style.removeProperty("--ytr-h");
            delete el.dataset.ytrEmbed;
        });
        document.querySelectorAll("[data-ytr-skip]").forEach(el    => delete el.dataset.ytrSkip);
        document.querySelectorAll("[data-ytr-bar]").forEach(el     => delete el.dataset.ytrBar);
        document.querySelectorAll("[data-ytr-done]").forEach(el    => delete el.dataset.ytrDone);
        document.querySelectorAll("[data-ytr-waiting]").forEach(el => delete el.dataset.ytrWaiting);
        document.querySelectorAll("[data-ytr-auto-h]").forEach(el  => delete el.dataset.ytrAutoH);
        document.querySelectorAll("[data-ytr-parent]").forEach(el  => delete el.dataset.ytrParent);
        document.querySelectorAll("[data-ytr-card]").forEach(el => {
            el.style.removeProperty("--ytr-h");
            delete el.dataset.ytrCard;
        });
        document.querySelectorAll("[data-ytr-wide]").forEach(el => {
            el.style.removeProperty("--ytr-w");
            delete el.dataset.ytrWide;
        });

        this._barFound = null;
        BdApi.Logger.info("VideoResizer", "Plugin stopped.");
    }

    // Helpers

    _isInsideChat(element) {
        for (const selector of VideoResizer.CALL_SCOPES) {
            if (element.closest(selector)) return false;
        }
        // id prefixes are stable across Discord's class-name rotations
        if (element.closest('li[id^="chat-messages-"]')) return true;
        if (element.closest('[id^="message-content-"]')) return true;
        if (element.closest('[class*="embedWrapper-"]')) return true;
        if (element.tagName === "IFRAME") return true;
        return false;
    }

    // Embed Container
    
    _findEmbedContainer(mediaElement) {
        let node = mediaElement.parentNode;
        for (let i = 0; i < 6 && node && node !== document.body; i++) {
            const w = node.style.width, h = node.style.height;
            if (w.endsWith("px") && h.endsWith("px") &&
                parseFloat(w) > 50 && parseFloat(h) > 50) return node;
            node = node.parentNode;
        }
        return mediaElement.parentNode;
    }

    // Finds Discord's native video control bar.
    
    _markControlBar(mediaElement) {
        const container = mediaElement.closest("[data-ytr-embed]");
        if (!container) return;
        const button = container.querySelector("button");
        if (!button) return;
        const bar = button.closest("div:not([data-ytr-embed])");
        if (bar) {
            bar.dataset.ytrBar = "1";
            this._barFound.add(mediaElement);
        }
    }

    // DOM scanning

    _processExistingEmbeds() {
        document.querySelectorAll(VideoResizer.MEDIA_SELECTOR)
            .forEach(el => this._processEmbed(el));
    }

    _startObserver() {
        this._observer = new MutationObserver(mutations => {
            const pending = new Set();
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    node.querySelectorAll(VideoResizer.MEDIA_SELECTOR)
                        .forEach(el => pending.add(el));
                    // If the added node itself matches, include it too.
                    if (node.matches(VideoResizer.MEDIA_SELECTOR)) pending.add(node);
                }
            }
            if (pending.size > 0) {
                requestAnimationFrame(() => pending.forEach(el => this._processEmbed(el)));
            }
        });
        this._observer.observe(document.body, { childList: true, subtree: true });
    }

    // Ancestor chain

    /**
     * Marks siblings at every level between the media element and its embed
     * container with [data-ytr-skip], so the CSS `:not([data-ytr-skip])` rules
     * only lift constraints on the direct ancestor chain.
     */
    _markSkipSiblings(mediaElement, embedContainer) {
        let node = mediaElement;
        while (node && node !== embedContainer) {
            const parent = node.parentNode;
            if (!parent) break;
            for (const sibling of parent.children) {
                if (sibling !== node) sibling.dataset.ytrSkip = "1";
            }
            node = parent;
        }
    }

    /**
     * Walks ancestors from startElement up to the scroll container or message
     * <li>. Marks each for overflow relief and height: auto, and collects
     * elements that need their max-height/max-width synced to video dimensions.
     */
    _markAncestors(startElement) {
        const cardElements = [], wideElements = [];
        let node = startElement;

        for (let i = 0; i < 20 && node && node !== document.body; i++) {
            const style = window.getComputedStyle(node);

            if (style.overflowY === "scroll" || style.overflowY === "auto" ||
                style.overflowX === "scroll" || style.overflowX === "auto") break;

            if (!node.dataset.ytrParent) node.dataset.ytrParent = "1";
            if (node.tagName !== "LI") node.dataset.ytrAutoH = "1";

            if (style.maxHeight !== "none") {
                node.dataset.ytrCard = "1";
                cardElements.push(node);
            }

            const hasClipping = style.maxWidth !== "none"
                || (style.contain !== "none" && style.contain !== "style" && style.contain !== "")
                || (style.clipPath !== "none" && style.clipPath !== "");
            if (hasClipping) {
                node.dataset.ytrWide = "1";
                wideElements.push(node);
            }

            if (node.tagName === "LI") break;
            const parentTag = node.parentNode?.tagName;
            if (parentTag === "OL" || parentTag === "UL") break;
            node = node.parentNode;
        }
        return { cardElements, wideElements };
    }

    // Core

    _processEmbed(mediaElement) {
        if (mediaElement.dataset.ytrDone) return;
        if (!this._isInsideChat(mediaElement)) return;

        // <video> needs metadata loaded before we can read dimensions.
        if (mediaElement.tagName === "VIDEO" && mediaElement.readyState < 1) {
            if (mediaElement.dataset.ytrWaiting) return;
            mediaElement.dataset.ytrWaiting = "1";
            mediaElement.addEventListener("loadedmetadata", () => {
                delete mediaElement.dataset.ytrWaiting;
                this._processEmbed(mediaElement);
            }, { once: true });
            return;
        }

        mediaElement.dataset.ytrDone = "1";

        const embedContainer = this._findEmbedContainer(mediaElement);
        const rect = mediaElement.getBoundingClientRect();
        let originalWidth, originalHeight;

        if (mediaElement.tagName === "VIDEO") {
            originalWidth  = rect.width  > 0 ? rect.width  : (mediaElement.videoWidth  || VideoResizer.DEFAULT_WIDTH);
            originalHeight = rect.height > 0 ? rect.height : (mediaElement.videoHeight || VideoResizer.DEFAULT_HEIGHT);
        } else {
            originalWidth  = rect.width  > 0 ? rect.width  : (parseInt(mediaElement.getAttribute("width"))  || VideoResizer.DEFAULT_WIDTH);
            originalHeight = rect.height > 0 ? rect.height : (parseInt(mediaElement.getAttribute("height")) || VideoResizer.DEFAULT_HEIGHT);
        }

        if (originalWidth < VideoResizer.MIN_WIDTH && originalHeight < VideoResizer.MIN_HEIGHT) return;

        const dimensions = {
            width: originalWidth, height: originalHeight,
            originalWidth, originalHeight,
        };

        embedContainer.dataset.ytrEmbed = "1";
        this._markSkipSiblings(mediaElement, embedContainer);
        const { cardElements, wideElements } = this._markAncestors(embedContainer.parentNode);

        // Applies --ytr-w/--ytr-h on the embed container and syncs ancestor caps.
        // Uses CSS custom properties because React reconciliation wipes inline styles.
        const applyDimensions = (width, height) => {
            dimensions.width = width;
            dimensions.height = height;
            embedContainer.style.setProperty("--ytr-w", width + "px");
            embedContainer.style.setProperty("--ytr-h", height + "px");
            for (const el of cardElements) el.style.setProperty("--ytr-h", height + "px");
            for (const el of wideElements) el.style.setProperty("--ytr-w", width + "px");
            this._scheduleSync();
        };

        applyDimensions(originalWidth, originalHeight);
        this._createOverlay(mediaElement, dimensions, applyDimensions);
    }

    // Overlay

    // Builds a fixed-position overlay on document.body with a resize handle.
    
    _createOverlay(mediaElement, dimensions, applyDimensions) {
        const overlay = document.createElement("div");
        overlay.className = "ytr-controls";

        const handle = document.createElement("div");
        handle.className = "ytr-handle";
        handle.title = "Drag to resize · Double-click to reset";
        overlay.appendChild(handle);

        const onMove = (e) => {
            const rect = mediaElement.getBoundingClientRect();
            const hovering = e.clientX >= rect.left && e.clientX <= rect.right &&
                             e.clientY >= rect.top  && e.clientY <= rect.bottom;
            overlay.dataset.ytrHover = hovering ? "1" : "";

            if (hovering && mediaElement.tagName === "VIDEO" && !this._barFound.has(mediaElement)) {
                this._markControlBar(mediaElement);
            }
        };
        document.addEventListener("mousemove", onMove);
        this._moveListeners.push(onMove);

        const aspectRatio = dimensions.originalWidth / dimensions.originalHeight;
        this._makeResizable(handle, dimensions, applyDimensions, aspectRatio);

        document.body.appendChild(overlay);
        this._overlays.set(mediaElement, overlay);
        this._scheduleSync();
    }

    _scheduleSync() {
        if (this._syncRaf) return;
        this._syncRaf = requestAnimationFrame(() => {
            this._syncRaf = null;
            this._syncOverlays();
        });
    }

    _syncOverlays() {
        for (const [mediaElement, overlay] of this._overlays) {
            if (!document.contains(mediaElement)) {
                overlay.remove();
                this._overlays.delete(mediaElement);
                continue;
            }
            const rect = mediaElement.getBoundingClientRect();
            overlay.style.left   = rect.left   + "px";
            overlay.style.top    = rect.top    + "px";
            overlay.style.width  = rect.width  + "px";
            overlay.style.height = rect.height + "px";
        }
    }

    // Resize

    _makeResizable(handle, dimensions, applyDimensions, aspectRatio) {
        let lastMouseDown = 0;

        handle.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            // Double-click to reset
            const now = performance.now();
            if (now - lastMouseDown < 350) {
                lastMouseDown = 0;
                applyDimensions(dimensions.originalWidth, dimensions.originalHeight);
                return;
            }
            lastMouseDown = now;

            const startX = e.clientX, startY = e.clientY;
            const startWidth = dimensions.width, startHeight = dimensions.height;

            // Transparent overlay that captures mouse events while dragging

            const captureOverlay = document.createElement("div");
            captureOverlay.style.cssText = "position:fixed;inset:0;z-index:99999;cursor:se-resize;";
            document.body.appendChild(captureOverlay);

            const diagonal = Math.sqrt(startWidth * startWidth + startHeight * startHeight);
            const unitX = startWidth / diagonal;
            const unitY = startHeight / diagonal;

            const onMove = (ev) => {
                const distance = (ev.clientX - startX) * unitX
                               + (ev.clientY - startY) * unitY;
                let newWidth  = Math.round(startWidth  + distance * unitX);
                let newHeight = Math.round(startHeight + distance * unitY);

                if (newWidth < VideoResizer.MIN_WIDTH) {
                    newWidth = VideoResizer.MIN_WIDTH;
                    newHeight = Math.round(newWidth / aspectRatio);
                }
                if (newHeight < VideoResizer.MIN_HEIGHT) {
                    newHeight = VideoResizer.MIN_HEIGHT;
                    newWidth = Math.round(newHeight * aspectRatio);
                }
                applyDimensions(newWidth, newHeight);
            };

            const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup",  onUp);
                captureOverlay.remove();
            };

            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup",  onUp);
        });
    }

    // Stylesheet 

    _injectStyles() {
        BdApi.DOM.addStyle(VideoResizer.STYLE_ID, `

            /* Embed container dimensions via CSS custom properties.
               We use --ytr-* vars instead of inline styles because React
               reconciliation resets inline !important — vars persist. */
            [data-ytr-embed] {
                width:      var(--ytr-w) !important;
                height:     var(--ytr-h) !important;
                max-width:  none !important;
                max-height: none !important;
            }
            [data-ytr-embed] iframe {
                width:     var(--ytr-w) !important;
                height:    var(--ytr-h) !important;
                display:   block !important;
                max-width: none !important;
            }
            [data-ytr-embed] video {
                width:      var(--ytr-w) !important;
                height:     var(--ytr-h) !important;
                display:    block !important;
                max-width:  none !important;
                object-fit: contain !important;
            }

            /* Lift size constraints on the wrapper chain between [data-ytr-embed]
               and the media element (3 levels). [data-ytr-skip] excludes siblings
               like Discord's controls bar from being affected. */
            [data-ytr-embed] > :not([data-ytr-skip]),
            [data-ytr-embed] > :not([data-ytr-skip]) > :not([data-ytr-skip]),
            [data-ytr-embed] > :not([data-ytr-skip]) > :not([data-ytr-skip]) > :not([data-ytr-skip]) {
                width:      var(--ytr-w) !important;
                height:     var(--ytr-h) !important;
                max-width:  none !important;
                max-height: none !important;
            }

            /* Ancestor overflow relief */
            [data-ytr-parent] { overflow: visible !important; }
            [data-ytr-auto-h] { height: auto !important; }

            [data-ytr-card] {
                max-height: var(--ytr-h) !important;
                overflow:   visible !important;
            }
            [data-ytr-wide] {
                max-width:  var(--ytr-w) !important;
                min-width:  var(--ytr-w) !important;
                overflow:   visible !important;
                contain:    none !important;
                clip-path:  none !important;
            }

            /* Fixed-position overlay on document.body */
            .ytr-controls {
                position: fixed;
                pointer-events: none;
                z-index: 1000;
                box-sizing: border-box;
                border-radius: 4px;
                outline: 1px solid transparent;
                transition: outline-color 0.15s;
            }
            .ytr-controls[data-ytr-hover="1"] {
                outline-color: rgba(255, 255, 255, 0.18);
            }

            .ytr-handle { pointer-events: none; }
            .ytr-controls[data-ytr-hover="1"] .ytr-handle { pointer-events: all; }

            .ytr-handle {
                position: absolute;
                bottom: 0; right: 0;
                width: 20px; height: 20px;
                cursor: se-resize;
                background: rgba(255,255,255,0.6);
                clip-path: polygon(100% 0%, 100% 100%, 0% 100%);
                opacity: 0;
                transition: opacity 0.15s;
            }
            .ytr-controls[data-ytr-hover="1"] .ytr-handle { opacity: 1; }

            [data-ytr-bar] {
                padding-right: 20px !important;
                box-sizing: border-box !important;
            }

            /* Fullscreen: let the video fill the screen naturally */
            :fullscreen [data-ytr-embed],
            :fullscreen[data-ytr-embed] {
                width:  100% !important;
                height: 100% !important;
            }
            :fullscreen [data-ytr-embed] video,
            :fullscreen[data-ytr-embed] video,
            :fullscreen video {
                width:      100% !important;
                height:     100% !important;
                object-fit: contain !important;
            }
            :fullscreen [data-ytr-bar] {
                padding-right: 0 !important;
            }
        `);
    }
};