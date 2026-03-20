/**
 * VK Bridge SDK Wrapper
 * Replaces Yandex Games SDK (yandex-sdk.js) for VK Mini Apps / VK Play.
 * Exposes window.YandexSDK with the same interface so game.js requires no changes.
 */
(function() {
    'use strict';

    var STORAGE_KEY = 'gameState';

    var VKSDKWrapper = {
        isInitialized: false,
        isPlayerInitialized: false,
        isGameReady: false,
        isOdnoklassniki: false,
        verbose: true,

        currentLanguage: 'ru',

        // Save throttling (mirrors yandex-sdk.js behavior)
        SAVE_INTERVAL: 60000,
        lastSaveTime: 0,
        pendingData: null,
        saveTimer: null,
        isSaving: false,

        log: function() {
            if (this.verbose) {
                var args = ['[VKSDK]'].concat(Array.prototype.slice.call(arguments));
                console.log.apply(console, args);
            }
        },

        /**
         * Detect whether we're running inside Odnoklassniki via URL params.
         * VK passes ?vk_client=ok when launching from OK.
         */
        _detectPlatform: function() {
            var urlParams = new URLSearchParams(window.location.search);
            this.isOdnoklassniki = (urlParams.get('vk_client') === 'ok');
            this.log('Platform:', this.isOdnoklassniki ? 'Odnoklassniki' : 'VK');
        },

        /**
         * Hide IAP-related UI when running inside Odnoklassniki.
         * Targets elements marked with class .vk-iap-btn or data-iap attribute.
         */
        _applyIAPVisibility: function() {
            if (!this.isOdnoklassniki) return;
            this.log('Odnoklassniki detected — hiding IAP buttons');
            var style = document.createElement('style');
            style.id = 'vk-iap-hide';
            style.textContent = '.vk-iap-btn, [data-iap] { display: none !important; }';
            document.head.appendChild(style);
        },

        /**
         * Desired game dimensions for desktop widescreen mode.
         * Based on the game's base resolution of 640×700.
         */
        DESKTOP_WIDTH: 900,
        DESKTOP_HEIGHT: 700,

        /**
         * Resize the VK iframe to a reasonable size for desktop widescreen mode.
         * Prevents the game from stretching across a huge iframe.
         */
        _resizeWindow: function() {
            var self = this;
            if (typeof vkBridge === 'undefined') return;

            // Only resize on desktop (not mobile)
            if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) return;

            vkBridge.send('VKWebAppResizeWindow', {
                width: self.DESKTOP_WIDTH,
                height: self.DESKTOP_HEIGHT
            }).then(function(data) {
                self.log('Window resized:', data);
            }).catch(function(error) {
                self.log('VKWebAppResizeWindow error (non-critical):', error);
            });
        },

        /**
         * Initialize VK Bridge.
         * Always resolves (never rejects) so the game starts even without Bridge.
         * @returns {Promise}
         */
        init: function() {
            var self = this;
            self._detectPlatform();

            return new Promise(function(resolve) {
                if (typeof vkBridge === 'undefined') {
                    self.log('vkBridge not available — running in standalone mode');
                    self.isInitialized = true;
                    self.isGameReady = true;
                    self._applyIAPVisibility();
                    resolve();
                    return;
                }

                vkBridge.send('VKWebAppInit')
                    .then(function(data) {
                        self.log('VK Bridge init result:', data.result);
                        self.isInitialized = true;
                        self.isGameReady = true;
                        self._applyIAPVisibility();
                        self._resizeWindow();
                        resolve();
                    })
                    .catch(function(error) {
                        self.log('VK Bridge init error (continuing anyway):', error);
                        self.isInitialized = true;
                        self.isGameReady = true;
                        resolve();
                    });
            });
        },

        /**
         * VK does not require a separate player/auth step.
         * Sets isPlayerInitialized = true so game.js save/load guards pass.
         * @returns {Promise}
         */
        initPlayer: function() {
            var self = this;
            return new Promise(function(resolve) {
                self.isPlayerInitialized = true;
                self.log('Player initialized (VK — no auth step needed)');
                resolve();
            });
        },

        // ─── Save / Load ───────────────────────────────────────────────────────

        /**
         * Perform the actual VK Storage write.
         * @param {Object} data
         * @returns {Promise}
         */
        _doSave: function(data) {
            var self = this;

            if (!self.isInitialized || typeof vkBridge === 'undefined') {
                self.log('Cannot save: VK Bridge not available');
                return Promise.resolve();
            }

            var dataString;
            try {
                dataString = JSON.stringify(data);
            } catch (e) {
                self.log('Error serializing save data:', e);
                return Promise.reject(e);
            }

            self.isSaving = true;
            self.lastSaveTime = Date.now();
            self.pendingData = null;

            return vkBridge.send('VKWebAppStorageSet', {
                key: STORAGE_KEY,
                value: dataString
            })
                .then(function(result) {
                    self.isSaving = false;
                    if (result.result) {
                        self.log('Data saved to VK Storage successfully');
                    }
                })
                .catch(function(error) {
                    self.isSaving = false;
                    self.log('Failed to save data to VK Storage:', error);
                    throw error;
                });
        },

        /**
         * Save game data to VK Storage with throttling (max once per SAVE_INTERVAL).
         * Mirrors the yandex-sdk.js saveData() signature.
         * @param {Object} data
         * @returns {Promise}
         */
        saveData: function(data) {
            var self = this;

            self.pendingData = data;

            return new Promise(function(resolve, reject) {
                if (!self.isPlayerInitialized) {
                    self.log('Player not initialized. Cannot save data.');
                    reject(new Error('Player not initialized'));
                    return;
                }

                var now = Date.now();
                var elapsed = now - self.lastSaveTime;

                if (elapsed >= self.SAVE_INTERVAL) {
                    if (self.saveTimer) {
                        clearTimeout(self.saveTimer);
                        self.saveTimer = null;
                    }
                    self.pendingData = null;
                    self._doSave(data).then(resolve).catch(reject);
                } else {
                    var delay = self.SAVE_INTERVAL - elapsed;
                    if (!self.saveTimer) {
                        self.log('Scheduling save in ' + Math.round(delay / 1000) + 's (throttled)');
                        self.saveTimer = setTimeout(function() {
                            self.saveTimer = null;
                            if (self.pendingData) {
                                var pending = self.pendingData;
                                self.pendingData = null;
                                self._doSave(pending);
                            }
                        }, delay);
                    }
                    resolve();
                }
            });
        },

        /**
         * Force-flush any pending save immediately (called on page hide / unload).
         * @returns {Promise}
         */
        flushPendingData: function() {
            var self = this;

            if (self.saveTimer) {
                clearTimeout(self.saveTimer);
                self.saveTimer = null;
            }

            if (self.pendingData && !self.isSaving) {
                var pending = self.pendingData;
                self.pendingData = null;
                self.log('Flushing pending data immediately');
                return self._doSave(pending);
            }

            return Promise.resolve();
        },

        /**
         * Load game data from VK Storage.
         * Returns the parsed object (same shape as Yandex player.getData()).
         * @returns {Promise<Object|null>}
         */
        loadData: function() {
            var self = this;

            if (!self.isInitialized || typeof vkBridge === 'undefined') {
                self.log('Cannot load: VK Bridge not available');
                return Promise.resolve(null);
            }

            return vkBridge.send('VKWebAppStorageGet', {
                keys: [STORAGE_KEY]
            })
                .then(function(data) {
                    if (data.keys) {
                        var entry = data.keys.find(function(k) { return k.key === STORAGE_KEY; });
                        if (entry && entry.value) {
                            try {
                                var parsed = JSON.parse(entry.value);
                                self.log('Data loaded from VK Storage');
                                return parsed;
                            } catch (e) {
                                self.log('Error parsing VK Storage data:', e);
                                return null;
                            }
                        }
                    }
                    self.log('No data found in VK Storage');
                    return null;
                })
                .catch(function(error) {
                    self.log('Failed to load data from VK Storage:', error);
                    return null;
                });
        },

        // ─── Advertising ───────────────────────────────────────────────────────

        /**
         * Show rewarded video ad.
         * Replaces ysdk.adv.showRewardedVideo().
         * Callbacks: onOpen, onRewarded, onClose, onError
         * @param {Object} callbacks
         */
        showRewardedVideo: function(callbacks) {
            var self = this;
            callbacks = callbacks || {};

            if (!self.isInitialized || typeof vkBridge === 'undefined') {
                self.log('Cannot show rewarded video: VK Bridge not available');
                if (callbacks.onError) callbacks.onError(new Error('VK Bridge not available'));
                return;
            }

            // onOpen fires as soon as we send the request
            if (callbacks.onOpen) callbacks.onOpen();

            vkBridge.send('VKWebAppShowNativeAds', { ad_format: 'reward' })
                .then(function(data) {
                    if (data.result) {
                        self.log('Rewarded video shown — granting reward');
                        if (callbacks.onRewarded) callbacks.onRewarded();
                    } else {
                        self.log('Rewarded video returned result=false');
                    }
                    if (callbacks.onClose) callbacks.onClose();
                })
                .catch(function(error) {
                    self.log('Rewarded video error:', error);
                    if (callbacks.onError) callbacks.onError(error);
                    if (callbacks.onClose) callbacks.onClose();
                });
        },

        /**
         * Show interstitial ad (between screens).
         * Replaces ysdk.adv.showFullscreenAdv().
         * @returns {Promise<boolean>}
         */
        showInterstitialAd: function() {
            var self = this;

            if (!self.isInitialized || typeof vkBridge === 'undefined') {
                self.log('Cannot show interstitial: VK Bridge not available');
                return Promise.resolve(false);
            }

            return vkBridge.send('VKWebAppShowNativeAds', { ad_format: 'interstitial' })
                .then(function(data) {
                    self.log('Interstitial ad shown:', data.result);
                    return !!data.result;
                })
                .catch(function(error) {
                    self.log('Interstitial ad error (game continues):', error);
                    return false;
                });
        },

        // ─── In-App Purchases ──────────────────────────────────────────────────

        /**
         * Open the VK purchase dialog for the given item ID.
         * Disabled on Odnoklassniki.
         * Item IDs are kept identical to those used on Yandex Games.
         * @param {string} itemId
         * @returns {Promise<Object|null>}
         */
        showPurchase: function(itemId) {
            var self = this;

            if (self.isOdnoklassniki) {
                self.log('Purchases are not available on Odnoklassniki');
                return Promise.reject(new Error('Purchases not available on Odnoklassniki'));
            }

            if (!self.isInitialized || typeof vkBridge === 'undefined') {
                self.log('Cannot show purchase: VK Bridge not available');
                return Promise.reject(new Error('VK Bridge not available'));
            }

            return vkBridge.send('VKWebAppShowOrderBox', {
                type: 'item',
                item: itemId
            })
                .then(function(data) {
                    if (data.success) {
                        self.log('Purchase successful, order ID:', data.order_id);
                        return data;
                    }
                    self.log('Purchase dialog closed without completing');
                    return null;
                })
                .catch(function(error) {
                    self.log('Purchase error or cancelled:', error);
                    throw error;
                });
        },

        // ─── Gameplay signals (no-ops — VK has no equivalent API) ─────────────

        gameReady: function() {
            this.log('gameReady() — no-op in VK mode');
        },

        gameplayStart: function() {
            this.log('gameplayStart() — no-op in VK mode');
        },

        gameplayStop: function() {
            this.log('gameplayStop() — no-op in VK mode');
        },

        // ─── Language ──────────────────────────────────────────────────────────

        getLanguage: function() {
            return this.currentLanguage;
        },

        initLanguage: function() {
            // VK audience is Russian-speaking; default to 'ru'.
            this.currentLanguage = 'ru';
            this.log('Language set to:', this.currentLanguage);
            return this.currentLanguage;
        }
    };

    // ── Context protection (mirrors yandex-sdk.js) ────────────────────────────

    document.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        return false;
    });

    document.addEventListener('touchstart', function(e) {
        if (e.touches.length > 1) {
            e.preventDefault();
        }
    }, { passive: false });

    var longPressTimer;
    document.addEventListener('touchstart', function() {
        longPressTimer = setTimeout(function() {}, 500);
    }, { passive: true });

    document.addEventListener('touchend', function() {
        clearTimeout(longPressTimer);
    }, { passive: true });

    document.addEventListener('touchmove', function() {
        clearTimeout(longPressTimer);
    }, { passive: true });

    var style = document.createElement('style');
    style.textContent = [
        '* {',
        '    -webkit-touch-callout: none;',
        '    -webkit-user-select: none;',
        '    -khtml-user-select: none;',
        '    -moz-user-select: none;',
        '    -ms-user-select: none;',
        '    user-select: none;',
        '    -webkit-tap-highlight-color: transparent;',
        '}'
    ].join('\n');
    document.head.appendChild(style);

    // ── Global exposure ───────────────────────────────────────────────────────

    // Keep window.YandexSDK name so game.js needs zero changes.
    window.YandexSDK = VKSDKWrapper;
    window.VKSDK = VKSDKWrapper;

    if (typeof ig !== 'undefined') {
        ig.yandex = VKSDKWrapper;
        ig.vk = VKSDKWrapper;
    }

    // ── Auto-initialization ───────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', function() {
        VKSDKWrapper.init()
            .then(function() {
                return VKSDKWrapper.initPlayer();
            })
            .then(function() {
                VKSDKWrapper.initLanguage();
                VKSDKWrapper.log('SDK and Player fully initialized');
            })
            .catch(function(error) {
                VKSDKWrapper.log('Initialization error:', error);
            });
    });

    // ── Auto-save on page hide / unload ───────────────────────────────────────

    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') {
            VKSDKWrapper.log('Page hidden — flushing pending save data');
            VKSDKWrapper.flushPendingData();
        }
    });

    window.addEventListener('beforeunload', function() {
        VKSDKWrapper.log('Page unloading — flushing pending save data');
        VKSDKWrapper.flushPendingData();
    });

    window.addEventListener('pagehide', function() {
        VKSDKWrapper.log('Page hide — flushing pending save data');
        VKSDKWrapper.flushPendingData();
    });

})();
