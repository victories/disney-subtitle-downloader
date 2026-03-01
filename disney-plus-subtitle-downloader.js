// ==UserScript==
// @name        Disney+ Subtitle Downloader
// @description Disney+ (disneyplus.com) altyazı indirici. Tek bölüm, tüm diller veya tüm sezon ZIP olarak indirilir. VTT→SRT dönüştürme, forced altyazı desteği.
// @license     MIT
// @version     3.7.0
// @namespace   victories.disneyplus.subtitle
// @match       https://www.disneyplus.com/*
// @grant       none
// @require     https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @require     https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js
// @run-at      document-start
// ==/UserScript==

(function() {
  'use strict';

  // ============================================================
  // SECTION 1: CONSTANTS & STATE
  // ============================================================

  const VERSION = '3.7.0';
  const MENU_ID = 'dplus-subtitle-downloader-menu';
  const PLAYBACK_URL = 'https://disney.playback.edge.bamgrid.com/v7/playback/ctr-regular';

  const TIMING = {
    FETCH_TIMEOUT: 30000,
    RATE_LIMIT: 500,
    SEASON_RATE_LIMIT: 1000,
    TOKEN_MAX_AGE: 25 * 60 * 1000,
    BACKOFF_MAX: 30000,
  };

  const LANG_NAMES = {
    'tr': 'Türkçe', 'en': 'English', 'ar': 'العربية', 'de': 'Deutsch',
    'fr': 'Français', 'es': 'Español', 'it': 'Italiano', 'pt': 'Português',
    'ru': 'Русский', 'ja': '日本語', 'ko': '한국어', 'zh': '中文',
    'nl': 'Nederlands', 'pl': 'Polski', 'sv': 'Svenska', 'da': 'Dansk',
    'no': 'Norsk', 'fi': 'Suomi', 'el': 'Ελληνικά', 'he': 'עברית',
    'hi': 'हिन्दी', 'th': 'ไทย', 'ro': 'Română', 'hu': 'Magyar',
    'cs': 'Čeština', 'bg': 'Български', 'hr': 'Hrvatski', 'sr': 'Srpski',
    'uk': 'Українська', 'fa': 'فارسی',
    'pt-BR': 'Português (Brasil)', 'zh-Hant': '中文 (繁體)', 'zh-Hans': '中文 (简体)',
    'es-419': 'Español (Lat.)', 'es-ES': 'Español (España)',
    'fr-CA': 'Français (Canada)', 'pt-PT': 'Português (Portugal)',
    'en-US': 'English (US)', 'en-GB': 'English (UK)',
  };

  const LANG_SAFE = {
    'tr': 'Turkce', 'en': 'English', 'ar': 'Arabic', 'de': 'Deutsch',
    'fr': 'Francais', 'es': 'Espanol', 'it': 'Italiano', 'pt': 'Portugues',
    'ru': 'Russian', 'ja': 'Japanese', 'ko': 'Korean', 'zh': 'Chinese',
    'nl': 'Nederlands', 'pl': 'Polski', 'sv': 'Svenska', 'da': 'Dansk',
    'no': 'Norsk', 'fi': 'Suomi', 'el': 'Greek', 'he': 'Hebrew',
    'hi': 'Hindi', 'th': 'Thai', 'ro': 'Romana', 'hu': 'Magyar',
    'cs': 'Cestina', 'bg': 'Bulgarian', 'hr': 'Hrvatski', 'sr': 'Srpski',
    'uk': 'Ukrainian', 'fa': 'Farsi',
    'pt-BR': 'Portuguese-BR', 'zh-Hant': 'Chinese-Trad', 'zh-Hans': 'Chinese-Simp',
    'es-419': 'Spanish-Lat', 'es-ES': 'Spanish-ES',
    'fr-CA': 'French-CA', 'pt-PT': 'Portuguese-PT',
    'en-US': 'English-US', 'en-GB': 'English-UK',
  };

  const AppState = {
    subtitleTracks: [],
    masterM3U8Url: null,
    baseUrl: '',
    isProcessing: false,
    interceptorInjected: false,
    oldLocation: null,
    // Auth & API
    authToken: null,
    authTokenTime: 0,
    apiHeaders: null,
    playbackBody: null,
    capturedMediaId: null,
    playbackApiUrl: null,
    _headersCaptured: false,
    _bodyCaptured: false,
    // Season
    seasonData: null,
    selectedSeason: null,
    selectedLang: '',
    seasonAbort: null,
    // Current episode info (from playerExperience API)
    currentEpisode: null, // { seriesTitle, seasonNumber, episodeNumber, title, contentId }
    // Format
    format: 'srt',
    // Progress
    progressText: '',
    progressPct: 0,
    // Auto-scroll
    _autoScrolling: false,
  };

  // ============================================================
  // SECTION 2: UTILITIES
  // ============================================================

  const getLangName = (code) => {
    if (!code) return 'Unknown';
    return LANG_NAMES[code] || LANG_NAMES[code.split('-')[0]] || code.toUpperCase();
  };

  const getLangSafe = (code) => {
    if (!code) return 'unknown';
    return LANG_SAFE[code] || LANG_SAFE[code.split('-')[0]] || code.replace(/[^a-zA-Z0-9-]/g, '');
  };

  function sanitize(name) {
    return name
      .replace(/\.\./g, '_')
      .replace(/[:*?"<>|\\\/]+/g, '_')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, '.')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+|\.+$/g, '')
      .substring(0, 120) || 'unnamed';
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function debuglog(msg) {
    console.log(`%c[D+SD] ${msg}`, 'background: #0063e5; color: #fff; padding: 2px 6px; border-radius: 3px;');
  }

  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function deepReplaceValue(obj, oldVal, newVal) {
    if (!obj || !oldVal || oldVal === newVal) return obj;
    if (typeof obj === 'string') return obj === oldVal ? newVal : obj;
    if (Array.isArray(obj)) return obj.map(item => deepReplaceValue(item, oldVal, newVal));
    if (typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = deepReplaceValue(value, oldVal, newVal);
      }
      return result;
    }
    return obj;
  }

  function extractMediaIdFromUrl(url) {
    if (!url) return null;
    try {
      const pathname = new URL(url, 'https://www.disneyplus.com').pathname;
      const match = pathname.match(/\/(?:play|video|watch)\/([a-f0-9-]{20,})/i);
      return match ? match[1] : null;
    } catch { return null; }
  }

  function resolveUrl(base, relative) {
    if (relative.startsWith('http')) return relative;
    if (relative.startsWith('/')) {
      const origin = new URL(base).origin;
      return origin + relative;
    }
    const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
    let resolved = baseDir;
    let rel = relative;
    while (rel.startsWith('../')) {
      rel = rel.substring(3);
      resolved = resolved.substring(0, resolved.slice(0, -1).lastIndexOf('/') + 1);
    }
    return resolved + rel;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = TIMING.FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Timeout (${Math.round(timeoutMs / 1000)}s)`);
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Content-scoped localStorage for multi-tab isolation
  function getScopeId() {
    const m = window.location.pathname.match(/\/([a-f0-9-]{8,})/i);
    return m ? m[1].substring(0, 8) : 'global';
  }

  const scopedStorage = {
    _key(field) { return `dplus_sd_${getScopeId()}_${field}`; },
    get(field) { try { return JSON.parse(localStorage.getItem(this._key(field)) || 'null'); } catch { return null; } },
    set(field, val) { try { localStorage.setItem(this._key(field), JSON.stringify(val)); } catch {} },
    remove(field) { try { localStorage.removeItem(this._key(field)); } catch {} },
  };

  // ============================================================
  // SECTION 3: M3U8 & VTT ENGINE
  // ============================================================

  function parseMediaLine(line) {
    const result = {};
    const content = line.replace(/^#EXT-X-MEDIA:/, '');
    const kvRegex = /([A-Z0-9_-]+)=(?:"([^"]*)"|([^,]*))/g;
    let match;
    while ((match = kvRegex.exec(content)) !== null) {
      result[match[1]] = match[2] !== undefined ? match[2] : match[3];
    }
    return result;
  }

  function parseM3U8SubtitleTracks(m3u8Content) {
    const tracks = [];
    const regex = /^#EXT-X-MEDIA:[^\n]*GROUP-ID="sub-main"[^\n]*$/gm;
    const lines = m3u8Content.match(regex);

    if (!lines || lines.length === 0) {
      const broaderRegex = /^#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES[^\n]*$/gm;
      const broaderLines = m3u8Content.match(broaderRegex);
      if (broaderLines) {
        broaderLines.forEach(line => tracks.push(parseMediaLine(line)));
      }
    } else {
      lines.forEach(line => tracks.push(parseMediaLine(line)));
    }
    return tracks.filter(t => t && t.URI);
  }

  function parseSubtitleM3U8(m3u8Content, baseUrl) {
    const urls = [];
    const lines = m3u8Content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') &&
        (trimmed.endsWith('.vtt') || trimmed.endsWith('.webvtt') ||
         trimmed.includes('.vtt?') || trimmed.includes('.webvtt?'))) {
        urls.push(trimmed.startsWith('http') ? trimmed : resolveUrl(baseUrl, trimmed));
      }
    }
    return urls;
  }

  function mergeVTTSegments(segmentTexts) {
    let merged = '';
    for (const segText of segmentTexts) {
      if (!segText || !segText.trim()) continue;
      const arrowIdx = segText.indexOf('-->');
      if (arrowIdx < 0) continue;
      const startIdx = Math.max(0, arrowIdx - 13);
      merged += segText.substring(startIdx);
      if (!merged.endsWith('\n')) merged += '\n';
    }
    return merged;
  }

  function vttToSrt(vttText) {
    const lines = vttText.split(/\r?\n/);
    const result = [];
    let counter = 0;
    let i = 0;

    while (i < lines.length && !lines[i].includes('-->')) i++;

    while (i < lines.length) {
      const line = lines[i].trim();

      if (line.includes('-->')) {
        counter++;
        result.push(String(counter));

        let timeLine = line;
        timeLine = timeLine.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
        timeLine = timeLine.replace(/^(\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2},\d{3})/, '00:$1 --> 00:$2');
        timeLine = timeLine.replace(/\s+(position|align|size|line|vertical):[^\s]+/g, '');
        result.push(timeLine);
        i++;

        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '' && !lines[i].includes('-->')) {
          let cleaned = lines[i].trim()
            .replace(/<\/?c(\.\w+)*>/g, '')
            .replace(/<\/?v[^>]*>/g, '')
            .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
            .replace(/<\/?[a-z][^>]*>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
          if (cleaned) textLines.push(cleaned);
          i++;
        }

        if (textLines.length > 0) {
          result.push(textLines.join('\n'));
          result.push('');
        } else {
          result.pop();
          result.pop();
          counter--;
        }
      } else {
        i++;
      }
    }
    return result.join('\r\n').trim();
  }

  // ============================================================
  // SECTION 4: PAGE-CONTEXT INTERCEPTOR (postMessage)
  // Injected via <script> tag into main world.
  // Uses window.postMessage for cross-world communication
  // (CustomEvent.detail doesn't cross MV3 isolated/main world boundary).
  // ============================================================

  function injectPageInterceptor() {
    const scriptContent = `(function() {
  if (window.__dplus_sd_injected) return;
  window.__dplus_sd_injected = true;

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  var origFetch = window.fetch;

  function post(type, data) {
    try {
      data._dplus_sd = true;
      data.type = type;
      window.postMessage(data, '*');
    } catch(e) {}
  }

  function isDplusApi(url) {
    return url.indexOf('bamgrid.com') !== -1 || url.indexOf('disney.') !== -1 ||
           url.indexOf('dssott.com') !== -1 || url.indexOf('disneyplus.com') !== -1;
  }

  function isSeasonUrl(url) {
    return url.indexOf('/explore/') !== -1 || url.indexOf('/series/') !== -1 ||
           url.indexOf('DmcSeriesBundle') !== -1 || url.indexOf('DmcEpisodes') !== -1 ||
           url.indexOf('DmcSeason') !== -1;
  }

  function isPlaybackUrl(url) {
    return url.indexOf('/playback') !== -1 || url.indexOf('playback.edge.bamgrid.com') !== -1;
  }

  function isPlayerExperienceUrl(url) {
    return url.indexOf('/playerExperience/') !== -1;
  }

  var __sd_auth_token = null;
  var __sd_api_headers = {}; // x-* headers captured from real playback requests

  // ---- XHR Interceptor ----
  XMLHttpRequest.prototype.open = function() {
    this.__sd_url = arguments[1] || '';
    this.__sd_hdrs = {};
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (!this.__sd_hdrs) this.__sd_hdrs = {};
    this.__sd_hdrs[header.toLowerCase()] = value;
    if (header.toLowerCase() === 'authorization' && value && value.indexOf('Bearer ') === 0) {
      __sd_auth_token = value;
      if (isDplusApi(this.__sd_url || '')) {
        post('dplus_sd_auth', { token: value, source: 'xhr' });
      }
    }
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    var url = this.__sd_url || '';
    var self = this;
    var body = arguments[0];

    if (url.indexOf('.m3u8') !== -1) {
      this.addEventListener('load', function() {
        if (self.readyState === 4 && self.status === 200 && self.responseText) {
          post('dplus_sd_m3u8', { url: url, content: self.responseText });
        }
      });
    }

    if (isSeasonUrl(url)) {
      this.addEventListener('load', function() {
        if (self.readyState === 4 && self.status === 200) {
          post('dplus_sd_season', { data: self.responseText, url: url });
        }
      });
    }

    if (isPlayerExperienceUrl(url)) {
      this.addEventListener('load', function() {
        if (self.readyState === 4 && self.status === 200 && self.responseText) {
          post('dplus_sd_episode_info', { data: self.responseText, url: url });
        }
      });
    }

    if (isPlaybackUrl(url)) {
      var hdrs = self.__sd_hdrs ? JSON.parse(JSON.stringify(self.__sd_hdrs)) : {};
      var pbBody = null;
      if (body) {
        if (typeof body === 'string') pbBody = body;
        else if (typeof body === 'object') { try { pbBody = JSON.stringify(body); } catch(e) {} }
      }
      // Save x-* headers in main world for proxy use
      for (var hk in hdrs) {
        if (hk.indexOf('x-') === 0 && hdrs[hk]) __sd_api_headers[hk] = hdrs[hk];
      }
      post('dplus_sd_playback', { url: url, headers: hdrs, body: pbBody });

      this.addEventListener('load', function() {
        try {
          if (self.readyState === 4 && self.status === 200 && self.responseText) {
            var rJson = JSON.stringify(JSON.parse(self.responseText));
            var m3Match = rJson.match(/https?:\\/\\/[^"\\s]+\\.m3u8[^"\\s]*/);
            if (m3Match) {
              var m3Url = m3Match[0];
              origFetch(m3Url).then(function(r) { return r.text(); }).then(function(txt) {
                if (txt && txt.indexOf('#EXTM3U') !== -1) {
                  post('dplus_sd_m3u8', { url: m3Url, content: txt });
                }
              }).catch(function(){});
            }
          }
        } catch(e) {}
      });
    }

    return origSend.apply(this, arguments);
  };

  // ---- Fetch Interceptor ----
  window.fetch = function(input, init) {
    var url = '';
    try {
      var fetchHeaders = {};

      if (typeof input === 'string') {
        url = input;
      } else if (input && input.url) {
        url = input.url;
        try {
          if (input.headers && input.headers.forEach) {
            input.headers.forEach(function(v, k) { fetchHeaders[k.toLowerCase()] = v; });
          }
        } catch(e) {}
      }

      if (init && init.headers) {
        var ih = init.headers;
        if (ih.forEach) {
          fetchHeaders = {};
          ih.forEach(function(v, k) { fetchHeaders[k.toLowerCase()] = v; });
        } else if (typeof ih === 'object' && !ih.forEach) {
          fetchHeaders = {};
          Object.keys(ih).forEach(function(k) { fetchHeaders[k.toLowerCase()] = ih[k]; });
        }
      }

      try {
        var authVal = fetchHeaders['authorization'];
        if (authVal && authVal.indexOf('Bearer ') === 0) {
          __sd_auth_token = authVal;
          if (isDplusApi(url)) {
            post('dplus_sd_auth', { token: authVal, source: 'fetch' });
          }
        }
      } catch(e) {}

      try {
        if (isPlaybackUrl(url)) {
          var pBody = null;
          var pBodyRaw = init && init.body;
          if (pBodyRaw) {
            if (typeof pBodyRaw === 'string') pBody = pBodyRaw;
            else if (typeof pBodyRaw === 'object') { try { pBody = JSON.stringify(pBodyRaw); } catch(e) {} }
          }
          // Save x-* headers in main world for proxy use
          for (var hk in fetchHeaders) {
            if (hk.indexOf('x-') === 0 && fetchHeaders[hk]) __sd_api_headers[hk] = fetchHeaders[hk];
          }
          post('dplus_sd_playback', { url: url, headers: fetchHeaders, body: pBody });
        }
      } catch(e) {}
    } catch(e) {}

    var capturedUrl = url;
    return origFetch.apply(this, arguments).then(function(response) {
      try {
        if (capturedUrl.indexOf('.m3u8') !== -1) {
          response.clone().text().then(function(txt) {
            if (txt && txt.indexOf('#EXTM3U') !== -1) {
              post('dplus_sd_m3u8', { url: capturedUrl, content: txt });
            }
          }).catch(function(){});
        }

        if (isPlaybackUrl(capturedUrl)) {
          response.clone().text().then(function(txt) {
            try {
              var rData = JSON.parse(txt);
              var rJson = JSON.stringify(rData);
              var m3Match = rJson.match(/https?:\\/\\/[^"\\s]+\\.m3u8[^"\\s]*/);
              if (m3Match) {
                var m3Url = m3Match[0];
                origFetch(m3Url).then(function(r) { return r.text(); }).then(function(t) {
                  if (t && t.indexOf('#EXTM3U') !== -1) {
                    post('dplus_sd_m3u8', { url: m3Url, content: t });
                  }
                }).catch(function(){});
              }
            } catch(e) {}
          }).catch(function(){});
        }

        if (isSeasonUrl(capturedUrl)) {
          response.clone().text().then(function(txt) {
            post('dplus_sd_season', { data: txt, url: capturedUrl });
          }).catch(function(){});
        }

        if (isPlayerExperienceUrl(capturedUrl)) {
          response.clone().text().then(function(txt) {
            post('dplus_sd_episode_info', { data: txt, url: capturedUrl });
          }).catch(function(){});
        }
      } catch(e) {}
      return response;
    });
  };

  // ---- Proxy: handle fetch requests from userscript via postMessage ----
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'dplus_sd_proxy_request' || !e.data._dplus_sd) return;
    var requestId = e.data.requestId;
    var pUrl = e.data.url;
    var options = e.data.options || {};

    // For playback requests, ensure x-* headers are present
    // Disney+ SW adds x-* headers AFTER our interceptor, so we must find them elsewhere
    if (pUrl.indexOf('playback') !== -1) {
      if (!options.headers) options.headers = {};
      var xCount = 0;

      // Source 1: Headers captured from interceptor in this session
      for (var hk in __sd_api_headers) {
        if (hk.indexOf('x-') === 0 && __sd_api_headers[hk]) {
          if (!options.headers[hk]) { options.headers[hk] = __sd_api_headers[hk]; xCount++; }
        }
      }

      // Source 2: Scan ALL localStorage for previously stored x-* headers
      if (xCount === 0) {
        try {
          for (var i = 0; i < localStorage.length; i++) {
            var lsKey = localStorage.key(i);
            if (lsKey && lsKey.indexOf('dplus_sd_') === 0 && lsKey.indexOf('_headers') !== -1) {
              var stored = JSON.parse(localStorage.getItem(lsKey));
              if (stored && typeof stored === 'object') {
                var sKeys = Object.keys(stored);
                for (var j = 0; j < sKeys.length; j++) {
                  if (sKeys[j].indexOf('x-') === 0 && stored[sKeys[j]] && !options.headers[sKeys[j]]) {
                    options.headers[sKeys[j]] = stored[sKeys[j]];
                    xCount++;
                  }
                }
              }
            }
          }
          if (xCount > 0) console.log('[D+SD Proxy] x-headers from localStorage: ' + xCount);
        } catch(ex) {}
      }

      // Also inject auth token if missing
      if (__sd_auth_token && !options.headers['Authorization'] && !options.headers['authorization']) {
        options.headers['Authorization'] = __sd_auth_token;
      }
      console.log('[D+SD Proxy] Playback request — x-headers: ' + xCount + ', total: ' + Object.keys(options.headers).length);

      // Diagnostic: list all dplus_sd_* keys to understand storage state
      if (xCount === 0) {
        try {
          var allKeys = [];
          for (var k = 0; k < localStorage.length; k++) {
            var kn = localStorage.key(k);
            if (kn && kn.indexOf('dplus_sd_') === 0) allKeys.push(kn);
          }
          console.log('[D+SD Proxy] Storage keys: ' + (allKeys.length > 0 ? allKeys.join(', ') : 'NONE'));
        } catch(ex) {}
      }
    }

    origFetch(pUrl, options).then(function(response) {
      return response.text().then(function(body) {
        window.postMessage({
          _dplus_sd: true, type: 'dplus_sd_proxy_response',
          requestId: requestId, status: response.status,
          ok: response.ok, statusText: response.statusText, body: body
        }, '*');
      });
    }).catch(function(err) {
      window.postMessage({
        _dplus_sd: true, type: 'dplus_sd_proxy_response',
        requestId: requestId, status: 0, ok: false,
        statusText: 'Network Error', body: err.message, error: true
      }, '*');
    });
  });

  // ---- Extract x-* header values from Service Worker script ----
  // Disney+ SW adds x-* headers to requests. We read the SW source to find the values.
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      var swUrl = navigator.serviceWorker.controller.scriptURL;
      origFetch(swUrl, { cache: 'force-cache' }).then(function(r) { return r.text(); }).then(function(code) {
        // Look for x-application-version, x-bamsdk-*, x-dss-* patterns
        var patterns = [
          { key: 'x-application-version', re: /["']x-application-version["']\s*[:,]\s*["']([^"']+)["']/i },
          { key: 'x-bamsdk-client-id', re: /["']x-bamsdk-client-id["']\s*[:,]\s*["']([^"']+)["']/i },
          { key: 'x-bamsdk-platform', re: /["']x-bamsdk-platform["']\s*[:,]\s*["']([^"']+)["']/i },
          { key: 'x-bamsdk-version', re: /["']x-bamsdk-version["']\s*[:,]\s*["']([^"']+)["']/i },
          { key: 'x-dss-edge-accept', re: /["']x-dss-edge-accept["']\s*[:,]\s*["']([^"']+)["']/i },
        ];
        var found = 0;
        for (var p = 0; p < patterns.length; p++) {
          var m = code.match(patterns[p].re);
          if (m && m[1]) {
            __sd_api_headers[patterns[p].key] = m[1];
            found++;
          }
        }
        if (found > 0) {
          console.log('[D+SD] SW headers extracted: ' + found + ' — ' + Object.keys(__sd_api_headers).join(', '));
          // Also save to localStorage for future use
          try {
            var existingKeys = [];
            for (var i = 0; i < localStorage.length; i++) {
              var k = localStorage.key(i);
              if (k && k.indexOf('dplus_sd_') === 0 && k.indexOf('_headers') !== -1) existingKeys.push(k);
            }
            if (existingKeys.length > 0) {
              // Merge into existing headers
              for (var ek = 0; ek < existingKeys.length; ek++) {
                try {
                  var existing = JSON.parse(localStorage.getItem(existingKeys[ek]));
                  if (existing && typeof existing === 'object') {
                    for (var hk in __sd_api_headers) {
                      existing[hk] = __sd_api_headers[hk];
                    }
                    localStorage.setItem(existingKeys[ek], JSON.stringify(existing));
                  }
                } catch(e) {}
              }
            } else {
              // Create new entry under a generic key
              localStorage.setItem('dplus_sd_global_headers', JSON.stringify(__sd_api_headers));
            }
          } catch(e) {}
        } else {
          console.log('[D+SD] SW headers NOT found in SW script (' + code.length + ' bytes)');
        }
      }).catch(function(err) {
        console.log('[D+SD] SW script fetch failed: ' + err.message);
      });
    } else {
      console.log('[D+SD] No controlling SW found');
    }
  } catch(e) {}

  console.log('[D+SD] Page-context interceptor injected (v3.6.0)');
})()`;

    function doInject() {
      const script = document.createElement('script');
      script.textContent = scriptContent;
      const target = document.head || document.documentElement;
      if (target) {
        target.appendChild(script);
        setTimeout(() => { try { script.remove(); } catch {} }, 200);
        debuglog('Script tag injected into ' + target.tagName);
      } else {
        const observer = new MutationObserver(() => {
          const t = document.head || document.documentElement;
          if (t) {
            observer.disconnect();
            const s = document.createElement('script');
            s.textContent = scriptContent;
            t.appendChild(s);
            setTimeout(() => { try { s.remove(); } catch {} }, 200);
            debuglog('Script tag injected via observer into ' + t.tagName);
          }
        });
        observer.observe(document, { childList: true, subtree: true });
      }
    }

    if (document.documentElement) {
      doInject();
    } else {
      const obs = new MutationObserver(() => {
        if (document.documentElement) {
          obs.disconnect();
          doInject();
        }
      });
      obs.observe(document, { childList: true });
    }
  }

  // ============================================================
  // SECTION 5: MESSAGE LISTENERS (postMessage-based)
  // Listens for messages from the injected main-world script.
  // ============================================================

  let _proxyResponseHandlers = {};

  function setupListeners() {
    window.addEventListener('message', (e) => {
      if (!e.data || !e.data._dplus_sd || e.source !== window) return;

      const msg = e.data;
      try {
        switch (msg.type) {
          case 'dplus_sd_auth': {
            const token = msg.token;
            if (token && token.startsWith('Bearer ')) {
              AppState.authToken = token;
              AppState.authTokenTime = Date.now();
              scopedStorage.set('auth', token);
              scopedStorage.set('auth_time', AppState.authTokenTime);
              debuglog('Auth token yakalandi');
            }
            break;
          }

          case 'dplus_sd_m3u8': {
            const { url, content } = msg;
            if (content && url && content.includes('TYPE=SUBTITLES')) {
              AppState.masterM3U8Url = url;
              AppState.baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
              debuglog('M3U8 yakalandi: ' + url.substring(0, 80));
              processM3U8(content);
            }
            break;
          }

          case 'dplus_sd_playback': {
            const { url, headers, body } = msg;
            if (url && !AppState.playbackApiUrl) {
              AppState.playbackApiUrl = url;
            }
            if (headers && typeof headers === 'object') {
              const keys = Object.keys(headers);
              const xKeys = keys.filter(k => k.startsWith('x-'));
              debuglog('Playback headers yakalandi: ' + keys.length + ' total, x-headers: ' + xKeys.length + ' (' + xKeys.join(', ') + ')');
              if (!AppState._headersCaptured && keys.length > 0) {
                AppState.apiHeaders = headers;
                AppState._headersCaptured = true;
                scopedStorage.set('headers', headers);
              }
            }
            if (body && !AppState._bodyCaptured) {
              try {
                AppState.playbackBody = typeof body === 'string' ? JSON.parse(body) : body;
                AppState._bodyCaptured = true;
                scopedStorage.set('body', AppState.playbackBody);

                const origMediaId = extractMediaIdFromUrl(window.location.href);
                if (origMediaId) {
                  AppState.capturedMediaId = origMediaId;
                  scopedStorage.set('media_id', origMediaId);
                  debuglog('Orijinal mediaId: ' + origMediaId);
                } else {
                  const bodyStr = JSON.stringify(AppState.playbackBody);
                  const uuids = bodyStr.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi);
                  if (uuids) {
                    const pid = AppState.playbackBody.playbackId;
                    const candidates = uuids.filter(u => u !== pid);
                    if (candidates.length > 0) {
                      AppState.capturedMediaId = candidates[0];
                      scopedStorage.set('media_id', candidates[0]);
                      debuglog('Orijinal mediaId (body scan): ' + candidates[0]);
                    }
                  }
                }
                debuglog('Playback body yakalandi, keys: ' + Object.keys(AppState.playbackBody).join(', '));
              } catch {}
            }
            break;
          }

          case 'dplus_sd_season': {
            try {
              const parsed = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
              processSeasonData(parsed);
            } catch(e) { debuglog('Season data parse hatasi: ' + e.message); }
            break;
          }

          case 'dplus_sd_episode_info': {
            try {
              const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
              processEpisodeInfo(data);
            } catch(e) { debuglog('Episode info parse hatasi: ' + e.message); }
            break;
          }

          case 'dplus_sd_proxy_response': {
            const handler = _proxyResponseHandlers[msg.requestId];
            if (handler) {
              delete _proxyResponseHandlers[msg.requestId];
              handler({
                status: msg.status, ok: msg.ok,
                statusText: msg.statusText, body: msg.body, error: msg.error
              });
            }
            break;
          }
        }
      } catch (err) {
        // Silent catch
      }
    });
  }

  // ============================================================
  // SECTION 6: API LAYER
  // ============================================================

  function fetchViaPageContext(url, options = {}) {
    return new Promise((resolve, reject) => {
      const requestId = 'proxy_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
      const timeout = setTimeout(() => {
        delete _proxyResponseHandlers[requestId];
        reject(new Error('Page-context proxy timeout (30s)'));
      }, 30000);

      _proxyResponseHandlers[requestId] = (response) => {
        clearTimeout(timeout);
        if (response.error) reject(new Error(response.body || 'Proxy error'));
        else resolve(response);
      };

      window.postMessage({
        _dplus_sd: true,
        type: 'dplus_sd_proxy_request',
        requestId, url, options
      }, '*');
    });
  }

  function loadPersistedState() {
    if (!AppState.authToken) {
      const t = scopedStorage.get('auth');
      const tt = scopedStorage.get('auth_time');
      if (t && tt && (Date.now() - tt) < TIMING.TOKEN_MAX_AGE) {
        AppState.authToken = t;
        AppState.authTokenTime = tt;
      }
    }
    if (!AppState.playbackBody) {
      const b = scopedStorage.get('body');
      if (b) AppState.playbackBody = b;
    }
    if (!AppState.capturedMediaId) {
      const m = scopedStorage.get('media_id');
      if (m) AppState.capturedMediaId = m;
    }
    if (!AppState.apiHeaders) {
      const h = scopedStorage.get('headers');
      if (h) AppState.apiHeaders = h;
    }
    // Fallback: if apiHeaders has no x-* keys, scan ALL localStorage
    const hasXHeaders = AppState.apiHeaders && Object.keys(AppState.apiHeaders).some(k => k.startsWith('x-'));
    if (!hasXHeaders) {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('dplus_sd_') && key.endsWith('_headers')) {
            const stored = JSON.parse(localStorage.getItem(key));
            if (stored && typeof stored === 'object') {
              const xKeys = Object.keys(stored).filter(k => k.startsWith('x-'));
              if (xKeys.length > 0) {
                if (!AppState.apiHeaders) AppState.apiHeaders = {};
                for (const xk of xKeys) {
                  if (stored[xk]) AppState.apiHeaders[xk] = stored[xk];
                }
                debuglog('x-headers from localStorage fallback (' + key + '): ' + xKeys.length);
                break;
              }
            }
          }
        }
      } catch {}
    }
  }

  function extractM3U8FromPlayback(data) {
    const json = JSON.stringify(data);
    const match = json.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
    if (match) return match[1];
    if (data?.stream?.sources) {
      for (const src of data.stream.sources) {
        if (src.complete?.url) return src.complete.url;
        if (src.url && src.url.includes('.m3u8')) return src.url;
      }
    }
    if (data?.stream?.complete?.[0]?.url) return data.stream.complete[0].url;
    return null;
  }

  async function fetchEpisodeM3U8(episode) {
    loadPersistedState();

    if (!AppState.authToken) {
      throw new Error('Auth token yok. Bir bolum oynatip tekrar deneyin.');
    }
    if ((Date.now() - AppState.authTokenTime) > TIMING.TOKEN_MAX_AGE) {
      throw new Error('Auth token suresi dolmus. Bir bolum oynatip yenileyin.');
    }

    const playbackUrl = AppState.playbackApiUrl || PLAYBACK_URL;
    const headers = {
      'Authorization': AppState.authToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (AppState.apiHeaders) {
      for (const [k, v] of Object.entries(AppState.apiHeaders)) {
        if (k.startsWith('x-') && v) headers[k] = v;
      }
    }

    // Build body - playbackId is base64-encoded JSON with mediaId/availId/sourceId
    let bodyObj;
    if (AppState.playbackBody) {
      bodyObj = JSON.parse(JSON.stringify(AppState.playbackBody));
      // Set playbackId: use episode's resourceId (base64 JSON) or build from scratch
      if (episode.resourceId) {
        bodyObj.playbackId = episode.resourceId;
        debuglog('playbackId from resourceId: ' + episode.contentId.substring(0, 12));
      } else {
        // Build playbackId from mediaId
        const pidObj = { mediaId: episode.contentId, contentType: 'vod' };
        bodyObj.playbackId = btoa(JSON.stringify(pidObj));
        debuglog('playbackId built from mediaId: ' + episode.contentId.substring(0, 12));
      }
      // Generate fresh tracking session ID
      if (bodyObj.playback?.tracking?.playbackSessionId) {
        bodyObj.playback.tracking.playbackSessionId = generateUUID();
      }
    } else {
      // Fallback: minimal body with base64 playbackId
      const pidObj = { mediaId: episode.contentId, contentType: 'vod' };
      bodyObj = {
        playbackId: btoa(JSON.stringify(pidObj)),
        playback: {
          attributes: {
            resolution: { max: ['1920x1080'] },
            protocol: 'HTTPS',
            assetInsertionStrategy: 'SGAI',
            playbackInitiationContext: 'ONLINE',
            frameRates: [60],
          }
        }
      };
    }

    const bodyStr = JSON.stringify(bodyObj);
    const xHeaderKeys = Object.keys(headers).filter(k => k.startsWith('x-'));
    debuglog('Playback istegi: ' + episode.contentId.substring(0, 16) + ' | x-headers: ' + xHeaderKeys.length + ' (' + xHeaderKeys.join(', ') + ')');

    const proxyResult = await fetchViaPageContext(playbackUrl, {
      method: 'POST', headers, body: bodyStr,
    });

    if (proxyResult.status === 401 || proxyResult.status === 403) {
      AppState.authToken = null;
      scopedStorage.remove('auth');
      throw new Error(`Token gecersiz (${proxyResult.status}). Bir bolum oynatip yenileyin.`);
    }
    if (!proxyResult.ok) {
      throw new Error(`Playback API hatasi: ${proxyResult.status}`);
    }

    let playbackData;
    try { playbackData = JSON.parse(proxyResult.body); }
    catch { throw new Error('Playback yaniti parse hatasi'); }

    const m3u8Url = extractM3U8FromPlayback(playbackData);
    if (!m3u8Url) throw new Error('M3U8 URL bulunamadi');

    const m3u8Response = await fetchWithTimeout(m3u8Url);
    const m3u8Content = await m3u8Response.text();
    return { m3u8Url, m3u8Content };
  }

  // ============================================================
  // SECTION 7: SEASON DATA PARSER
  // ============================================================

  function parseEpisodeObject(ep, defaultSeason) {
    if (!ep) return null;

    // mediaId from base64-encoded resourceId (Explore API)
    let contentId = '';
    let resourceId = ''; // raw base64 string for playbackId
    if (ep.actions && Array.isArray(ep.actions) && ep.actions.length > 0) {
      for (const action of ep.actions) {
        if (action.resourceId) {
          try {
            const decoded = JSON.parse(atob(action.resourceId));
            contentId = decoded.mediaId || decoded.contentId || decoded.id || '';
            if (contentId) {
              resourceId = action.resourceId; // keep raw base64 for playbackId
              break;
            }
          } catch {
            contentId = action.resourceId;
          }
        }
      }
    }
    // Fallback: direct fields
    if (!contentId) {
      contentId = ep.mediaId || ep.contentId || ep.dmcContentId ||
        ep.meta?.dmcContentId || ep.familyId || ep.id || '';
    }

    const title = ep.visuals?.episodeTitle ||
                  ep.text?.title?.full?.program?.default?.content ||
                  ep.text?.title?.full?.episode?.default?.content ||
                  ep.title || ep.name || '';
    const episodeNumber = ep.episodeSequenceNumber || ep.episodeNumber ||
                          parseInt(ep.visuals?.episodeNumber) || ep.number || 0;
    const seasonNumber = ep.seasonSequenceNumber || ep.seasonNumber ||
                         parseInt(ep.visuals?.seasonNumber) || defaultSeason || 1;

    if (!contentId) return null;
    return { contentId, resourceId, title, episodeNumber, seasonNumber };
  }

  function parseExploreApiResponse(obj) {
    const containers = obj?.data?.page?.containers;
    if (!Array.isArray(containers)) return null;

    const episodeContainer = containers.find(c => c.type === 'episodes') ||
                             containers.find(c => c.seasons && Array.isArray(c.seasons));
    if (!episodeContainer || !episodeContainer.seasons) return null;

    let seriesTitle = '';
    try {
      const headerContainer = containers.find(c => c.type === 'header' || c.type === 'seriesHeader');
      if (headerContainer) {
        seriesTitle = headerContainer.text?.title?.full?.series?.default?.content ||
                      headerContainer.visuals?.title || headerContainer.title || '';
      }
      if (!seriesTitle) {
        seriesTitle = obj?.data?.page?.text?.title?.full?.series?.default?.content ||
                      obj?.data?.page?.visuals?.title || obj?.data?.page?.title || '';
      }
      // Fallback: get series title from first episode's visuals.title
      if (!seriesTitle && episodeContainer.seasons?.[0]?.items?.[0]?.visuals?.title) {
        seriesTitle = episodeContainer.seasons[0].items[0].visuals.title;
      }
    } catch {}

    const seasons = [];
    let seasonIndex = 0;
    for (const s of episodeContainer.seasons) {
      seasonIndex++;
      const episodeList = s.items || s.episodes || [];
      if (episodeList.length === 0) continue; // Skip empty seasons
      const seasonNum = s.seasonSequenceNumber || s.seasonNumber || seasonIndex;
      const eps = [];
      for (const ep of episodeList) {
        const parsed = parseEpisodeObject(ep, seasonNum);
        if (parsed) eps.push(parsed);
      }
      if (eps.length > 0) {
        const sId = s.seasonId || s.id || s.contentId || s.encodedId || '';
        const more = s.hasMore ?? (s.pagination?.hasMore) ?? (s.meta?.hits > episodeList.length) ?? false;
        seasons.push({ seasonNumber: seasonNum, seasonId: sId, hasMore: !!more, episodes: eps });
      }
    }
    return seasons.length > 0 ? { seriesTitle, seriesId: '', seasons } : null;
  }

  function parseDirectSeasons(obj) {
    const seriesTitle = obj.title || obj.text?.title?.full?.series?.default?.content || '';
    const seriesId = obj.seriesId || obj.encodedSeriesId || '';
    const seasons = [];
    for (const s of obj.seasons) {
      const seasonNum = s.seasonSequenceNumber || s.seasonNumber || seasons.length + 1;
      const eps = [];
      const episodeList = s.items || s.episodes || s.videos || [];
      for (const ep of episodeList) {
        const parsed = parseEpisodeObject(ep, seasonNum);
        if (parsed) eps.push(parsed);
      }
      const sId = s.seasonId || s.id || s.contentId || s.encodedId || '';
      const more = s.hasMore ?? (s.pagination?.hasMore) ?? (s.meta?.hits > episodeList.length) ?? false;
      seasons.push({ seasonNumber: seasonNum, seasonId: sId, hasMore: !!more, episodes: eps });
    }
    return seasons.length > 0 ? { seriesTitle, seriesId, seasons } : null;
  }

  function parseSingleSeasonEpisodes(obj) {
    const seriesTitle = obj.title || obj.seriesTitle || obj.text?.title?.full?.series?.default?.content || '';
    const episodeList = obj.episodes || [];
    if (episodeList.length === 0) return null;

    const seasonMap = {};
    for (const ep of episodeList) {
      const parsed = parseEpisodeObject(ep);
      if (!parsed) continue;
      const sn = parsed.seasonNumber || 1;
      if (!seasonMap[sn]) seasonMap[sn] = [];
      seasonMap[sn].push(parsed);
    }

    const seasons = Object.entries(seasonMap)
      .map(([num, eps]) => ({ seasonNumber: parseInt(num), episodes: eps.sort((a, b) => a.episodeNumber - b.episodeNumber) }))
      .sort((a, b) => a.seasonNumber - b.seasonNumber);
    return seasons.length > 0 ? { seriesTitle, seriesId: '', seasons } : null;
  }

  function findEpisodeData(obj, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 10) return null;
    depth = (depth || 0) + 1;

    // Explore API
    if (obj.data?.page?.containers) {
      const result = parseExploreApiResponse(obj);
      if (result) return result;
    }
    if (obj.page?.containers) {
      const result = parseExploreApiResponse({ data: obj });
      if (result) return result;
    }

    // Single season response
    if (obj.data?.season || obj.season) {
      const seasonObj = obj.data?.season || obj.season;
      if (seasonObj.items && Array.isArray(seasonObj.items)) {
        const eps = [];
        let seasonNum = seasonObj.seasonSequenceNumber || seasonObj.seasonNumber || seasonObj.number || 0;
        // Fallback: check first episode's own season number
        if (!seasonNum && seasonObj.items.length > 0) {
          const firstEp = seasonObj.items[0];
          seasonNum = firstEp.seasonSequenceNumber || firstEp.seasonNumber ||
                      parseInt(firstEp.visuals?.seasonNumber) || 0;
        }
        if (!seasonNum) seasonNum = 1;
        for (const ep of seasonObj.items) {
          const parsed = parseEpisodeObject(ep, seasonNum);
          if (parsed) eps.push(parsed);
        }
        if (eps.length > 0) {
          const sId = seasonObj.seasonId || seasonObj.id || seasonObj.contentId || '';
          const more = seasonObj.hasMore ?? seasonObj.pagination?.hasMore ?? false;
          return { seriesTitle: '', seriesId: '', seasons: [{ seasonNumber: seasonNum, seasonId: sId, hasMore: !!more, episodes: eps }] };
        }
      }
    }

    // DmcSeriesBundle (legacy)
    if (obj.DmcSeriesBundle) return findEpisodeData(obj.DmcSeriesBundle, depth);
    if (obj.data && !obj.seasons && !obj.episodes) {
      for (const k of ['DmcSeriesBundle', 'DmcEpisodes', 'DmcSeason', 'series']) {
        if (obj.data[k]) return findEpisodeData(obj.data[k], depth);
      }
      return findEpisodeData(obj.data, depth);
    }

    // Direct seasons array
    if (obj.seasons && Array.isArray(obj.seasons)) return parseDirectSeasons(obj);

    // Single season episodes
    if (obj.episodes && Array.isArray(obj.episodes) && obj.episodes.length > 0) {
      return parseSingleSeasonEpisodes(obj);
    }

    // items array
    if (obj.items && Array.isArray(obj.items) && obj.items.length > 0) {
      const first = obj.items[0];
      if (first.actions || first.contentId || first.episodeSequenceNumber) {
        return parseSingleSeasonEpisodes({ episodes: obj.items, ...obj });
      }
    }

    // Recurse
    for (const key of ['series', 'seasons', 'episodes', 'items', 'DmcSeriesBundle', 'DmcEpisodes', 'DmcSeason', 'containers', 'set', 'sets']) {
      if (obj[key]) {
        const result = findEpisodeData(obj[key], depth);
        if (result) return result;
      }
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const result = findEpisodeData(item, depth);
        if (result) return result;
      }
    }
    return null;
  }

  function mergeEpisodes(existing, incoming) {
    const idSet = new Set(existing.map(e => e.contentId));
    for (const ep of incoming) {
      if (ep.contentId && !idSet.has(ep.contentId)) {
        existing.push(ep);
        idSet.add(ep.contentId);
      }
    }
    existing.sort((a, b) => a.episodeNumber - b.episodeNumber);
    return existing;
  }

  function processSeasonData(apiResponse) {
    const found = findEpisodeData(apiResponse);
    if (!found || !found.seasons || found.seasons.length === 0) return;

    if (AppState.seasonData && AppState.seasonData.seasons.length > 0) {
      // Merge into existing season data
      AppState.seasonData.seriesTitle = found.seriesTitle || AppState.seasonData.seriesTitle || '';
      AppState.seasonData.seriesId = found.seriesId || AppState.seasonData.seriesId || '';
      AppState.seasonData.capturedAt = Date.now();

      for (const newSeason of found.seasons) {
        const existing = AppState.seasonData.seasons.find(s => s.seasonNumber === newSeason.seasonNumber);
        if (existing) {
          // Merge episodes by contentId (append new, keep existing)
          mergeEpisodes(existing.episodes, newSeason.episodes);
          if (newSeason.seasonId) existing.seasonId = newSeason.seasonId;
          existing.hasMore = newSeason.hasMore;
        } else {
          AppState.seasonData.seasons.push(newSeason);
        }
      }
      AppState.seasonData.seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
    } else {
      AppState.seasonData = {
        seriesTitle: found.seriesTitle || '',
        seriesId: found.seriesId || '',
        seasons: found.seasons,
        capturedAt: Date.now(),
      };
    }

    if (!AppState.selectedSeason && AppState.seasonData.seasons.length > 0) {
      AppState.selectedSeason = AppState.seasonData.seasons[0].seasonNumber;
    }
    const totalEps = AppState.seasonData.seasons.reduce((s, se) => s + se.episodes.length, 0);
    debuglog(`Sezon verisi: ${AppState.seasonData.seriesTitle || '?'} — ${AppState.seasonData.seasons.length} sezon, ${totalEps} bolum`);
    createMenu();

    // Auto-scroll to load remaining episodes if any season has exactly 15 (Disney+ page size)
    const needsMore = AppState.seasonData.seasons.some(s => s.episodes.length % 15 === 0 && s.episodes.length > 0);
    if (needsMore && !AppState._autoScrolling) {
      autoScrollForMoreEpisodes();
    }
  }

  function autoScrollForMoreEpisodes() {
    if (AppState._autoScrolling) return;
    AppState._autoScrolling = true;
    debuglog('Auto-scroll: kalan bolumler icin asagi kaydiriliyor...');

    // Disney+ uses a custom scrollable container, not window scroll
    // Find the main scrollable wrapper
    function findScrollContainer() {
      // Try common Disney+ scroll containers
      const candidates = document.querySelectorAll('[data-testid="content-body"], [class*="page-container"], [class*="content-area"], [class*="scroll"]');
      for (const el of candidates) {
        if (el.scrollHeight > el.clientHeight) return el;
      }
      // Fallback: find any scrollable ancestor of episode cards
      const episodeCard = document.querySelector('[data-testid*="card"], [class*="episode"], [class*="set-item"]');
      if (episodeCard) {
        let parent = episodeCard.parentElement;
        while (parent && parent !== document.body) {
          const style = window.getComputedStyle(parent);
          const overflow = style.overflowY;
          if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight + 50) {
            return parent;
          }
          parent = parent.parentElement;
        }
      }
      // Last fallback: document scrolling element
      return document.scrollingElement || document.documentElement;
    }

    const container = findScrollContainer();
    const originalScrollTop = container.scrollTop;
    const originalWindowY = window.scrollY;
    debuglog(`Auto-scroll: container bulundu — ${container.tagName}.${container.className?.split(' ')[0] || ''}, scrollHeight=${container.scrollHeight}`);

    let step = 0;
    const maxSteps = 4;
    const scrollStep = () => {
      step++;
      debuglog(`Auto-scroll: adim ${step}/${maxSteps}`);

      // Strategy 1: Scroll the found container
      const maxScroll = container.scrollHeight - container.clientHeight;
      container.scrollTop = maxScroll;

      // Strategy 2: Also try window scroll
      window.scrollTo(0, document.documentElement.scrollHeight);

      // Strategy 3: Find last episode card and scrollIntoView
      const cards = document.querySelectorAll('[data-testid*="card"], [class*="set-item"], [class*="episode-card"]');
      if (cards.length > 0) {
        cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
        debuglog(`Auto-scroll: son kart scrollIntoView yapildi (${cards.length} kart)`);
      }

      // Dispatch scroll events to trigger IntersectionObserver / scroll listeners
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('scroll', { bubbles: true }));

      if (step < maxSteps) {
        setTimeout(scrollStep, 1500);
      } else {
        // Wait for API response, then scroll back
        setTimeout(() => {
          container.scrollTop = originalScrollTop;
          window.scrollTo(0, originalWindowY);
          AppState._autoScrolling = false;
          debuglog('Auto-scroll: tamamlandi, basa donuldu');
        }, 2000);
      }
    };
    setTimeout(scrollStep, 800);
  }

  // ============================================================
  // SECTION 8: TITLE EXTRACTION & FILENAME
  // ============================================================

  function processEpisodeInfo(data) {
    if (!data) return;

    // Unwrap nested structure: response may be { data: { playerExperience: { ... } } }
    const pe = data.data?.playerExperience || data.playerExperience || data;

    // Parse internalTitle: "The Artful Dodger - s1e1 - mediaId:c3f3333f-..."
    const internalTitle = pe.internalTitle || data.internalTitle || '';
    const titleMatch = internalTitle.match(/^(.+?)\s*-\s*s(\d+)e(\d+)\s*-\s*mediaId:(.+)$/i);

    if (titleMatch) {
      const seriesTitle = titleMatch[1].trim();
      const seasonNumber = parseInt(titleMatch[2]);
      const episodeNumber = parseInt(titleMatch[3]);
      const realMediaId = titleMatch[4].trim();

      // Episode title from subtitle field: "S1:B1 Yanki Dodge" → "Yanki Dodge"
      let episodeTitle = '';
      const subtitle = pe.subtitle || data.subtitle || '';
      const subMatch = subtitle.match(/^S\d+\s*:\s*(?:B|E|EP?)\d+\s+(.+)$/i);
      if (subMatch) {
        episodeTitle = subMatch[1].trim();
      } else if (subtitle && !subtitle.match(/^S\d+/i)) {
        episodeTitle = subtitle.trim();
      }

      AppState.currentEpisode = {
        seriesTitle,
        seasonNumber,
        episodeNumber,
        title: episodeTitle,
        contentId: realMediaId,
      };

      // Fix capturedMediaId with the REAL mediaId
      if (realMediaId && realMediaId !== '00000000-0000-0000-0000-000000000000') {
        AppState.capturedMediaId = realMediaId;
        scopedStorage.set('media_id', realMediaId);
      }

      debuglog(`Episode: ${seriesTitle} S${String(seasonNumber).padStart(2,'0')}E${String(episodeNumber).padStart(2,'0')} - ${episodeTitle || '(no title)'}`);

      // Refresh menu if tracks already loaded
      if (AppState.subtitleTracks.length > 0) {
        setTimeout(() => createMenu(), 100);
      }
    }

    // Try to fetch series/season data for season download
    fetchSeriesPageFromEpisodeInfo(data);
  }

  async function fetchSeriesPageFromEpisodeInfo(rawData) {
    if (!rawData || AppState.seasonData) return; // Already have season data
    if (!AppState.authToken) {
      debuglog('Series page: Auth token yok, bekleniyor...');
      return;
    }

    try {
      // Step 1: Get URL media ID (deeplinkId)
      const urlMediaId = extractMediaIdFromUrl(window.location.href);
      if (!urlMediaId) {
        debuglog('Series page: URL mediaId bulunamadi');
        return;
      }

      // Step 2: Call deeplink API to discover series entity ID
      const deeplinkUrl = `https://disney.api.edge.bamgrid.com/explore/v1.15/deeplink?action=playback&refId=${urlMediaId}&refIdType=deeplinkId`;
      debuglog('Deeplink API sorgusu: ' + urlMediaId);

      const dlResp = await fetchViaPageContext(deeplinkUrl, {
        headers: { 'Authorization': AppState.authToken }
      });

      if (!dlResp.ok || !dlResp.body) {
        debuglog('Deeplink API hatasi: ' + (dlResp.status || 'no response'));
        return;
      }

      const dlData = JSON.parse(dlResp.body);
      const actions = dlData?.data?.deeplink?.actions || dlData?.deeplink?.actions || [];

      // Find browse action with pageId (series entity page)
      let seriesPageId = null;
      for (const action of actions) {
        if (action.type === 'browse' && action.pageId) {
          seriesPageId = action.pageId;
          break;
        }
      }
      // Fallback: try partnerFeed.evaSeriesEntityId from playback action
      if (!seriesPageId) {
        for (const action of actions) {
          const evaId = action.partnerFeed?.evaSeriesEntityId;
          if (evaId) {
            seriesPageId = 'entity-' + evaId;
            break;
          }
        }
      }

      if (!seriesPageId) {
        debuglog('Series entity ID bulunamadi (deeplink actions: ' + actions.length + ')');
        return;
      }

      debuglog('Series entity ID bulundu: ' + seriesPageId);

      // Step 3: Fetch series page with all season/episode data
      const seriesPageUrl = `https://disney.api.edge.bamgrid.com/explore/v1.15/page/${seriesPageId}`;
      const resp = await fetchViaPageContext(seriesPageUrl, {
        headers: { 'Authorization': AppState.authToken }
      });

      if (resp.ok && resp.body) {
        const parsed = JSON.parse(resp.body);
        processSeasonData(parsed);
      } else {
        debuglog('Series page hatasi: HTTP ' + (resp.status || '?'));
      }
    } catch (e) {
      debuglog('Series page hatasi: ' + e.message);
    }
  }

  function getContentTitle() {
    // 1. Current episode info (from playerExperience)
    if (AppState.currentEpisode?.seriesTitle) return AppState.currentEpisode.seriesTitle;

    // 2. Season data API
    if (AppState.seasonData?.seriesTitle) return AppState.seasonData.seriesTitle;

    // 2. DOM: Disney+ player title elements
    const selectors = [
      '[data-testid="title-field"]',
      '[class*="title-field"]',
      'h2[class*="title"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.innerText?.trim()) {
        const text = el.innerText.trim();
        if (text.length > 1 && text.length < 100 && !text.toLowerCase().includes('disney+')) return text;
      }
    }

    // 3. document.title
    const dt = document.title;
    const match = dt.match(/^(.+?)\s*[|–]\s*Disney\+/i);
    if (match && !match[1].trim().startsWith('Disney')) return match[1].trim();

    return null;
  }

  function getEpisodeLabel(episode) {
    if (!episode) return '';
    return `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
  }

  function buildFilename(seriesTitle, episode, langCode, forced, format) {
    const parts = [];
    if (seriesTitle) parts.push(sanitize(seriesTitle));
    if (episode) {
      parts.push(getEpisodeLabel(episode));
      if (episode.title) parts.push(sanitize(episode.title));
    }
    parts.push(getLangSafe(langCode));
    if (forced) parts.push('forced');
    return parts.join('.') + '.' + (format || 'srt');
  }

  // ============================================================
  // SECTION 9: DOWNLOAD ENGINE
  // ============================================================

  function processM3U8(content) {
    const tracks = parseM3U8SubtitleTracks(content);
    if (tracks.length > 0) {
      AppState.subtitleTracks = tracks;
      debuglog(`${tracks.length} altyazi track'i bulundu`);
      setTimeout(() => createMenu(), 500);
      // Trigger proactive episode info fetch (after short delay for auth to settle)
      if (!AppState.currentEpisode) {
        setTimeout(() => proactiveFetchEpisodeInfo(), 1000);
      }
    }
  }

  /**
   * Proactive episode info fetch — runs from content script side.
   * 1. Injects a tiny script to read performance entries for playerExperience URLs
   * 2. Receives the URL via postMessage
   * 3. Fetches it via page-context proxy (so Service Worker adds proper headers)
   * 4. Parses the response and calls processEpisodeInfo
   */
  async function proactiveFetchEpisodeInfo() {
    if (AppState.currentEpisode) return; // Already have episode info

    // Load auth if not yet available
    loadPersistedState();
    if (!AppState.authToken) {
      debuglog('Proactive PE: auth token yok, bekleniyor...');
      // Wait up to 10s for auth to be captured
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        loadPersistedState();
        if (AppState.authToken) break;
      }
      if (!AppState.authToken) {
        debuglog('Proactive PE: auth token bulunamadi, iptal');
        return;
      }
    }

    // Get playerExperience URL from performance entries via main world
    const peUrl = await getPlayerExperienceUrl();
    if (!peUrl) {
      debuglog('Proactive PE: playerExperience URL bulunamadi');
      // Fallback: try to construct URL from the page URL
      const urlMediaId = extractMediaIdFromUrl(window.location.href);
      if (urlMediaId) {
        // Try the avail ID pattern — fetch via a known URL structure won't work
        // since we need the availId, not the mediaId. Give up gracefully.
        debuglog('Proactive PE: URL mediaId var (' + urlMediaId.substring(0, 8) + ') ama availId bilinmiyor');
      }
      return;
    }

    debuglog('Proactive PE fetch: ' + peUrl.substring(0, 80));
    try {
      const resp = await fetchViaPageContext(peUrl, {
        headers: { 'Authorization': AppState.authToken }
      });

      if (resp.ok && resp.body) {
        const data = JSON.parse(resp.body);
        processEpisodeInfo(data);
        debuglog('Proactive PE basarili!');
      } else {
        debuglog('Proactive PE hata: HTTP ' + resp.status);
      }
    } catch (e) {
      debuglog('Proactive PE fetch hatasi: ' + e.message);
    }
  }

  /**
   * Gets playerExperience URL from performance entries via injected script.
   * Returns the URL string or null.
   */
  function getPlayerExperienceUrl() {
    return new Promise((resolve) => {
      // Create a unique message ID for this request
      const msgId = 'pe_url_' + Date.now();

      // Listen for the response
      const handler = (e) => {
        if (e.data && e.data._dplus_sd && e.data.type === 'dplus_sd_pe_url_response' && e.data.msgId === msgId) {
          window.removeEventListener('message', handler);
          resolve(e.data.url || null);
        }
      };
      window.addEventListener('message', handler);

      // Inject a tiny script to read performance entries
      const script = document.createElement('script');
      script.textContent = `(function() {
        var url = null;
        try {
          var entries = performance.getEntriesByType('resource');
          for (var i = entries.length - 1; i >= 0; i--) {
            if (entries[i].name.indexOf('/playerExperience/') !== -1) {
              url = entries[i].name;
              break;
            }
          }
        } catch(e) {}
        window.postMessage({ _dplus_sd: true, type: 'dplus_sd_pe_url_response', msgId: '${msgId}', url: url }, '*');
      })()`;
      (document.head || document.documentElement).appendChild(script);
      setTimeout(() => { try { script.remove(); } catch {} }, 100);

      // Timeout after 3 seconds
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 3000);
    });
  }

  async function downloadSingleTrack(track, format, zipInstance) {
    const fmt = format || AppState.format || 'srt';
    const langName = getLangName(track.LANGUAGE);
    const isForced = track.FORCED === 'YES';

    const subM3U8Url = resolveUrl(AppState.baseUrl, track.URI);
    const subM3U8Resp = await fetchWithTimeout(subM3U8Url);
    const subM3U8Text = await subM3U8Resp.text();
    const subBaseUrl = subM3U8Url.substring(0, subM3U8Url.lastIndexOf('/') + 1);
    const vttUrls = parseSubtitleM3U8(subM3U8Text, subBaseUrl);

    if (vttUrls.length === 0) throw new Error('VTT segment bulunamadi');

    const segmentTexts = [];
    for (const vttUrl of vttUrls) {
      try {
        const resp = await fetchWithTimeout(vttUrl, {}, 15000);
        segmentTexts.push(await resp.text());
      } catch {}
    }
    if (segmentTexts.length === 0) throw new Error('Segment indirilemedi');

    const mergedVTT = mergeVTTSegments(segmentTexts);
    const content = fmt === 'srt' ? vttToSrt(mergedVTT) : 'WEBVTT\n\n' + mergedVTT;
    if (!content || content.trim().length < 10) throw new Error('Icerik bos');

    const title = getContentTitle();
    const filename = buildFilename(title, AppState.currentEpisode, track.LANGUAGE, isForced, fmt);

    if (zipInstance) {
      zipInstance.file(filename, '\ufeff' + content);
    } else {
      const blob = new Blob(['\ufeff' + content], { type: 'text/plain;charset=utf-8' });
      saveAs(blob, filename);
    }
    return filename;
  }

  async function downloadAllAsZip() {
    if (AppState.subtitleTracks.length === 0 || AppState.isProcessing) return;

    AppState.isProcessing = true;
    const zip = new JSZip();
    const fmt = AppState.format || 'srt';
    let downloaded = 0;

    updateProgress(0, `0/${AppState.subtitleTracks.length}`);

    for (let i = 0; i < AppState.subtitleTracks.length; i++) {
      const track = AppState.subtitleTracks[i];
      updateProgress(((i + 1) / AppState.subtitleTracks.length) * 100, `${i + 1}/${AppState.subtitleTracks.length} — ${getLangName(track.LANGUAGE)}`);
      try {
        await downloadSingleTrack(track, fmt, zip);
        downloaded++;
      } catch (e) {
        debuglog(`Hata (${track.LANGUAGE}): ${e.message}`);
      }
      if (i < AppState.subtitleTracks.length - 1) await sleep(200);
    }

    if (downloaded > 0) {
      const title = getContentTitle() || 'Subtitles';
      const zipName = sanitize(title) + '.All.' + fmt + '.zip';
      const zipContent = await zip.generateAsync({ type: 'blob' });
      saveAs(zipContent, zipName);
    }

    AppState.isProcessing = false;
    updateProgress(0, '', false);
    createMenu();
  }

  async function downloadSeasonSubtitles(seasonNumber, langCode, format) {
    if (AppState.isProcessing || !AppState.seasonData || !AppState.authToken) return;

    let season = AppState.seasonData.seasons.find(s => s.seasonNumber === seasonNumber);
    if (!season || season.episodes.length === 0) return;

    // Fetch ALL episodes for this season (Disney+ paginates at ~15 per page)
    if (season.seasonId) {
      try {
        let allEps = [];
        let page = 1;
        const pageSize = 30;
        let keepGoing = true;
        debuglog(`Sezon ${seasonNumber}: Tum bolumleri cekiliyor (seasonId: ${season.seasonId})...`);

        while (keepGoing && page <= 10) { // safety: max 10 pages = 300 episodes
          const pageUrl = `https://disney.api.edge.bamgrid.com/explore/v1.15/season/${season.seasonId}?pageSize=${pageSize}&page=${page}`;
          const pageResp = await fetchWithTimeout(pageUrl, {
            headers: { 'Authorization': AppState.authToken },
          });
          if (!pageResp.ok) break;
          const pageData = await pageResp.json();
          const parsed = findEpisodeData(pageData);
          const pageEps = parsed?.seasons?.[0]?.episodes || [];
          if (pageEps.length === 0) break;
          allEps.push(...pageEps);
          keepGoing = parsed?.seasons?.[0]?.hasMore || pageEps.length >= pageSize;
          page++;
        }

        if (allEps.length > season.episodes.length) {
          debuglog(`Sezon ${seasonNumber}: ${season.episodes.length} -> ${allEps.length} bolum yuklendi`);
          season.episodes = allEps;
          season.hasMore = false;
        }
      } catch (e) {
        debuglog(`Sezon fetch hatasi: ${e.message}`);
      }
    }

    const fmt = format || AppState.format || 'srt';
    const episodes = season.episodes;
    const seriesTitle = sanitize(AppState.seasonData.seriesTitle || getContentTitle() || 'Series');
    const seasonFolder = `S${String(seasonNumber).padStart(2, '0')}`;

    AppState.isProcessing = true;
    AppState.seasonAbort = new AbortController();
    const zip = new JSZip();
    let successCount = 0;
    let backoffDelay = TIMING.SEASON_RATE_LIMIT;

    updateProgress(0, `0/${episodes.length}`);

    for (let i = 0; i < episodes.length; i++) {
      if (AppState.seasonAbort?.signal?.aborted) break;

      const ep = episodes[i];
      const epLabel = getEpisodeLabel(ep);

      updateProgress((i / episodes.length) * 100, `${i + 1}/${episodes.length} — ${epLabel} ${ep.title}`);

      try {
        const { m3u8Url, m3u8Content } = await fetchEpisodeM3U8(ep);
        const tracks = parseM3U8SubtitleTracks(m3u8Content);
        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

        // Find language track
        let targetTrack = tracks.find(t => t.LANGUAGE === langCode && t.FORCED !== 'YES');
        if (!targetTrack && langCode.includes('-')) {
          const base = langCode.split('-')[0];
          targetTrack = tracks.find(t => t.LANGUAGE === base && t.FORCED !== 'YES');
        }
        if (!targetTrack) {
          targetTrack = tracks.find(t => t.LANGUAGE.startsWith(langCode.split('-')[0]) && t.FORCED !== 'YES');
        }
        if (!targetTrack) { debuglog(`[${epLabel}] '${langCode}' bulunamadi`); continue; }

        // Download VTT segments
        const subM3U8Url = resolveUrl(baseUrl, targetTrack.URI);
        const subM3U8Resp = await fetchWithTimeout(subM3U8Url);
        const subM3U8Text = await subM3U8Resp.text();
        const subBaseUrl = subM3U8Url.substring(0, subM3U8Url.lastIndexOf('/') + 1);
        const vttUrls = parseSubtitleM3U8(subM3U8Text, subBaseUrl);

        if (vttUrls.length === 0) continue;

        const segmentTexts = [];
        for (const vttUrl of vttUrls) {
          try {
            const resp = await fetchWithTimeout(vttUrl, {}, 15000);
            segmentTexts.push(await resp.text());
          } catch {}
        }

        const mergedVTT = mergeVTTSegments(segmentTexts);
        const content = fmt === 'srt' ? vttToSrt(mergedVTT) : 'WEBVTT\n\n' + mergedVTT;
        if (!content || content.trim().length < 10) continue;

        const epTitle = ep.title ? `.${sanitize(ep.title)}` : '';
        const epFilename = `${epLabel}${epTitle}.${getLangSafe(langCode)}.${fmt}`;
        zip.file(epFilename, '\ufeff' + content);
        successCount++;
        debuglog(`[${epLabel}] OK`);
        backoffDelay = TIMING.SEASON_RATE_LIMIT;

      } catch (e) {
        debuglog(`[${epLabel}] Hata: ${e.message}`);
        if (e.message.includes('401') || e.message.includes('403') || e.message.includes('token') || e.message.includes('Token')) {
          break;
        }
        if (e.message.includes('429')) {
          backoffDelay = Math.min(backoffDelay * 2, TIMING.BACKOFF_MAX);
          await sleep(backoffDelay);
        }
      }

      if (i < episodes.length - 1) await sleep(backoffDelay);
    }

    if (successCount > 0) {
      updateProgress(100, 'ZIP olusturuluyor...');
      const zipName = `${seriesTitle}.${seasonFolder}.${getLangSafe(langCode)}.${fmt}.zip`;
      const zipContent = await zip.generateAsync({ type: 'blob' });
      saveAs(zipContent, zipName);
      debuglog(`ZIP indirildi: ${zipName} (${successCount}/${episodes.length})`);
    }

    AppState.isProcessing = false;
    AppState.seasonAbort = null;
    updateProgress(0, '', false);
    createMenu();
  }

  // ============================================================
  // SECTION 10: UI
  // ============================================================

  function updateProgress(pct, text, show = true) {
    // Store in AppState so createMenu can restore it
    AppState.progressPct = show ? pct : 0;
    AppState.progressText = show ? text : '';

    // Panel progress element
    const el = document.getElementById('sd-progress');
    if (el) {
      if (!show) { el.style.display = 'none'; }
      else { el.style.display = 'block'; el.textContent = text; }
    }

    // Main button text
    const btn = document.getElementById('sd-main-btn');
    if (btn) {
      if (show && AppState.isProcessing) {
        const match = text.match(/^(\d+)\/(\d+)/);
        btn.textContent = match ? `Indiriliyor ${match[1]}/${match[2]}` : (text || 'Indiriliyor...');
      } else if (!show) {
        const count = AppState.subtitleTracks?.length || 0;
        btn.innerHTML = `<span>Altyazi</span>${count > 0 ? `<span class="sd-badge">${count}</span>` : ''}`;
      }
    }

    // Top progress bar
    updateTopBar(show ? pct : -1);
  }

  function updateTopBar(pct) {
    let bar = document.getElementById('sd-top-bar');
    if (pct < 0) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'sd-top-bar';
      bar.style.cssText = 'position:fixed;top:0;left:0;height:3px;z-index:2147483647;background:#0063e5;transition:width 0.3s ease;pointer-events:none;box-shadow:0 0 8px rgba(0,99,229,0.6);';
      document.body.appendChild(bar);
    }
    bar.style.width = Math.max(pct, 2) + '%';
  }

  function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:999999999;padding:10px 18px;
      border-radius:8px;font-size:13px;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,0.5);
      background:${type === 'error' ? '#c62828' : type === 'success' ? '#2e7d32' : '#0063e5'};
      transition:opacity 0.3s;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
  }

  function createMenu() {
    let root = document.getElementById(MENU_ID);
    if (root) root.remove();

    const tracks = AppState.subtitleTracks;
    if (tracks.length === 0 && !AppState.seasonData) return;

    root = document.createElement('div');
    root.id = MENU_ID;
    document.body.appendChild(root);

    // Inject CSS
    if (!document.getElementById('sd-styles')) {
      const style = document.createElement('style');
      style.id = 'sd-styles';
      style.textContent = getCSS();
      document.head.appendChild(style);
    }

    const isPlayPage = window.location.pathname.includes('/play/');
    const normalTracks = tracks.filter(t => t.FORCED !== 'YES');
    const forcedTracks = tracks.filter(t => t.FORCED === 'YES');

    // Toggle button
    const btn = document.createElement('button');
    btn.className = 'sd-btn';
    btn.id = 'sd-main-btn';
    if (AppState.isProcessing && AppState.progressText) {
      const match = AppState.progressText.match(/^(\d+)\/(\d+)/);
      btn.textContent = match ? `Indiriliyor ${match[1]}/${match[2]}` : AppState.progressText;
    } else if (AppState.isProcessing) {
      btn.textContent = 'Indiriliyor...';
    } else {
      btn.innerHTML = `<span>Altyazi</span>${tracks.length > 0 ? `<span class="sd-badge">${tracks.length}</span>` : ''}`;
    }
    root.appendChild(btn);

    // Dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'sd-dropdown';
    root.appendChild(dropdown);

    btn.addEventListener('click', () => dropdown.classList.toggle('open'));

    // Header
    const title = getContentTitle() || '';
    const header = document.createElement('div');
    header.className = 'sd-header';
    header.innerHTML = `<div class="sd-title">${title || 'Disney+ Subtitle Downloader'}</div>
      <div class="sd-version">v${VERSION}</div>`;
    dropdown.appendChild(header);

    // Format selector
    const formatRow = document.createElement('div');
    formatRow.className = 'sd-format-row';
    formatRow.innerHTML = `<span>Format:</span>
      <select id="sd-format-select">
        <option value="srt" ${AppState.format === 'srt' ? 'selected' : ''}>SRT</option>
        <option value="vtt" ${AppState.format === 'vtt' ? 'selected' : ''}>VTT</option>
      </select>`;
    dropdown.appendChild(formatRow);
    formatRow.querySelector('select').addEventListener('change', (e) => { AppState.format = e.target.value; });

    // Normal subtitles (only on /play pages)
    if (isPlayPage && normalTracks.length > 0) {
      const section = document.createElement('div');
      section.className = 'sd-section';
      section.innerHTML = `<div class="sd-section-title">Altyazilar (${normalTracks.length})</div>`;
      for (const track of normalTracks) {
        const row = document.createElement('div');
        row.className = 'sd-track-row';
        row.innerHTML = `<span class="sd-lang">${getLangName(track.LANGUAGE)}</span>
          <button class="sd-dl-btn" data-lang="${track.LANGUAGE}" data-forced="NO">SRT</button>`;
        row.querySelector('button').addEventListener('click', async () => {
          try {
            showToast(`${getLangName(track.LANGUAGE)} indiriliyor...`);
            await downloadSingleTrack(track, AppState.format);
            showToast(`${getLangName(track.LANGUAGE)} indirildi`, 'success');
          } catch (e) { showToast(`Hata: ${e.message}`, 'error'); }
        });
        section.appendChild(row);
      }
      dropdown.appendChild(section);
    }

    // Forced subtitles (only on /play pages)
    if (isPlayPage && forcedTracks.length > 0) {
      const section = document.createElement('div');
      section.className = 'sd-section';
      section.innerHTML = `<div class="sd-section-title">Forced Altyazilar (${forcedTracks.length})</div>`;
      for (const track of forcedTracks) {
        const row = document.createElement('div');
        row.className = 'sd-track-row';
        row.innerHTML = `<span class="sd-lang">${getLangName(track.LANGUAGE)} <span class="sd-forced-tag">FORCED</span></span>
          <button class="sd-dl-btn" data-lang="${track.LANGUAGE}" data-forced="YES">SRT</button>`;
        row.querySelector('button').addEventListener('click', async () => {
          try { await downloadSingleTrack(track, AppState.format); }
          catch (e) { showToast(`Hata: ${e.message}`, 'error'); }
        });
        section.appendChild(row);
      }
      dropdown.appendChild(section);
    }

    // Download all ZIP (only on /play pages)
    if (isPlayPage && tracks.length > 0) {
      const allBtn = document.createElement('button');
      allBtn.className = 'sd-all-btn';
      allBtn.textContent = `Tumunu ZIP Indir (${tracks.length})`;
      allBtn.addEventListener('click', () => downloadAllAsZip());
      dropdown.appendChild(allBtn);
    }

    // Season section
    if (AppState.seasonData && AppState.seasonData.seasons.length > 0) {
      const seasonSection = document.createElement('div');
      seasonSection.className = 'sd-section sd-season-section';

      const seasonTitle = AppState.seasonData.seriesTitle || title || '';
      seasonSection.innerHTML = `<div class="sd-section-title">Sezon Indirme${seasonTitle ? ' — ' + seasonTitle : ''}</div>`;

      // Season selector
      const seasonSelect = document.createElement('select');
      seasonSelect.className = 'sd-season-select';
      for (const s of AppState.seasonData.seasons) {
        const opt = document.createElement('option');
        opt.value = s.seasonNumber;
        opt.textContent = `Sezon ${s.seasonNumber} (${s.episodes.length} bolum)`;
        if (s.seasonNumber === AppState.selectedSeason) opt.selected = true;
        seasonSelect.appendChild(opt);
      }
      seasonSelect.addEventListener('change', () => { AppState.selectedSeason = parseInt(seasonSelect.value); });
      seasonSection.appendChild(seasonSelect);

      // Language selector
      const langSelect = document.createElement('select');
      langSelect.className = 'sd-lang-select';
      const availLangs = [...new Set(normalTracks.map(t => t.LANGUAGE))];
      if (availLangs.length === 0) {
        availLangs.push('tr', 'en');
      }
      for (const code of availLangs) {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = getLangName(code);
        if (code === AppState.selectedLang || (!AppState.selectedLang && code === 'tr')) opt.selected = true;
        langSelect.appendChild(opt);
      }
      langSelect.addEventListener('change', () => { AppState.selectedLang = langSelect.value; });
      if (!AppState.selectedLang) AppState.selectedLang = langSelect.value;
      seasonSection.appendChild(langSelect);

      // Token status
      const tokenAge = Date.now() - AppState.authTokenTime;
      const tokenOk = AppState.authToken && tokenAge < TIMING.TOKEN_MAX_AGE;
      const tokenInfo = document.createElement('div');
      tokenInfo.className = 'sd-token-info';
      tokenInfo.textContent = tokenOk
        ? `Token aktif (${Math.round((TIMING.TOKEN_MAX_AGE - tokenAge) / 60000)} dk kaldi)`
        : 'Token yok — bir bolum oynatin';
      tokenInfo.style.color = tokenOk ? '#4caf50' : '#ff9800';
      seasonSection.appendChild(tokenInfo);

      // Download button
      const dlBtn = document.createElement('button');
      dlBtn.className = 'sd-season-dl-btn';
      dlBtn.textContent = 'Tum Sezonu Indir';
      dlBtn.addEventListener('click', () => {
        if (AppState.isProcessing) {
          if (AppState.seasonAbort) { AppState.seasonAbort.abort(); }
          return;
        }
        const sn = parseInt(seasonSelect.value);
        const lang = langSelect.value;
        downloadSeasonSubtitles(sn, lang, AppState.format);
      });
      seasonSection.appendChild(dlBtn);

      // Progress
      const progress = document.createElement('div');
      progress.id = 'sd-progress';
      progress.className = 'sd-progress';
      progress.style.display = 'none';
      seasonSection.appendChild(progress);

      dropdown.appendChild(seasonSection);
    }

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!root.contains(e.target)) dropdown.classList.remove('open');
    }, { once: false });
  }

  // ============================================================
  // SECTION 11: CSS
  // ============================================================

  function getCSS() {
    return `
    #${MENU_ID} {
      position: fixed; top: 50px; right: 10px; z-index: 999999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      font-size: 13px;
    }
    #${MENU_ID} * { box-sizing: border-box; }
    #${MENU_ID} .sd-btn {
      background: #0063e5; color: #fff; border: none; padding: 8px 14px;
      border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: bold;
      box-shadow: 0 2px 10px rgba(0,99,229,0.4); transition: all 0.2s;
      display: flex; align-items: center; gap: 6px;
    }
    #${MENU_ID} .sd-btn:hover { background: #0050b5; }
    #${MENU_ID} .sd-badge {
      background: #fff; color: #0063e5; border-radius: 50%;
      padding: 1px 6px; font-size: 11px; font-weight: bold;
    }
    #${MENU_ID} .sd-dropdown {
      display: none; background: #1a1a2e; border: 1px solid #2a2a4a;
      border-radius: 10px; margin-top: 6px; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      min-width: 340px; max-height: 70vh; overflow-y: auto;
    }
    #${MENU_ID} .sd-dropdown.open { display: block; }
    #${MENU_ID} .sd-header {
      padding: 12px 16px; border-bottom: 1px solid #2a2a4a;
    }
    #${MENU_ID} .sd-title {
      font-size: 14px; font-weight: bold; color: #fff;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${MENU_ID} .sd-version { font-size: 10px; color: #666; margin-top: 2px; }
    #${MENU_ID} .sd-format-row {
      padding: 8px 16px; display: flex; align-items: center; gap: 8px;
      border-bottom: 1px solid #2a2a4a; color: #aaa;
    }
    #${MENU_ID} .sd-format-row select {
      background: #252545; color: #fff; border: 1px solid #3a3a5a;
      border-radius: 4px; padding: 3px 8px; font-size: 12px;
    }
    #${MENU_ID} .sd-section { padding: 8px 0; border-bottom: 1px solid #2a2a4a; }
    #${MENU_ID} .sd-section-title {
      padding: 4px 16px; font-size: 11px; color: #888;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    #${MENU_ID} .sd-track-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 16px; transition: background 0.15s;
    }
    #${MENU_ID} .sd-track-row:hover { background: #252545; }
    #${MENU_ID} .sd-lang { color: #ddd; font-size: 13px; }
    #${MENU_ID} .sd-dl-btn {
      background: #0063e5; color: #fff; border: none; padding: 3px 10px;
      border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;
      transition: background 0.2s;
    }
    #${MENU_ID} .sd-dl-btn:hover { background: #0050b5; }
    #${MENU_ID} .sd-forced-tag {
      background: #ff6b00; color: #fff; border-radius: 3px;
      padding: 1px 5px; margin-left: 6px; font-size: 9px;
      font-weight: bold; text-transform: uppercase;
    }
    #${MENU_ID} .sd-all-btn {
      display: block; width: calc(100% - 32px); margin: 8px 16px;
      background: #1b5e20; color: #fff; border: none; padding: 8px;
      border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: bold;
      transition: background 0.2s;
    }
    #${MENU_ID} .sd-all-btn:hover { background: #2e7d32; }
    #${MENU_ID} .sd-season-section { padding: 12px 16px; }
    #${MENU_ID} .sd-season-section select {
      display: block; width: 100%; margin: 6px 0;
      background: #252545; color: #fff; border: 1px solid #3a3a5a;
      border-radius: 6px; padding: 6px 10px; font-size: 12px;
    }
    #${MENU_ID} .sd-token-info { font-size: 11px; margin: 6px 0; }
    #${MENU_ID} .sd-season-dl-btn {
      display: block; width: 100%; margin: 8px 0 0;
      background: #0063e5; color: #fff; border: none; padding: 8px;
      border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: bold;
      transition: background 0.2s;
    }
    #${MENU_ID} .sd-season-dl-btn:hover { background: #0050b5; }
    #${MENU_ID} .sd-progress {
      font-size: 11px; color: #aaa; margin-top: 6px;
      padding: 4px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    `;
  }

  // ============================================================
  // SECTION 12: INIT
  // ============================================================

  function init() {
    if (AppState.interceptorInjected) return;
    AppState.interceptorInjected = true;

    injectPageInterceptor();
    setupListeners();

    setInterval(() => {
      const loc = window.location.href;
      if (loc !== AppState.oldLocation) {
        AppState.oldLocation = loc;
        // Reset M3U8 state on navigation
        AppState.subtitleTracks = [];
        AppState.masterM3U8Url = null;
        AppState.currentEpisode = null;
        AppState._headersCaptured = false;
        AppState._bodyCaptured = false;
        // Keep auth token, season data, and playback body across navigations
        const menu = document.getElementById(MENU_ID);
        if (menu) menu.remove();
      }
    }, 2000);

    debuglog('Disney+ Subtitle Downloader v' + VERSION + ' baslatildi');
  }

  init();
})();
