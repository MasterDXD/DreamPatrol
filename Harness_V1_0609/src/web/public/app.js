/** @module web/public/app */
(function() {
  'use strict';

  var ERROR_HANDLER_RESET_MS = 6500;
  var REJECTION_HANDLER_RESET_MS = 5500;
  var TOAST_DISPLAY_MS = 4000;
  var TOAST_EXIT_MS = 250;
  var MAX_TOASTS = 5;
  var CACHE_MAX_AGE_MS = 15000;
  var MAX_CACHE_ENTRIES = 200;
  var MAX_DATAHASH_ENTRIES = 200;
  var MAX_PENDING_REQUESTS = 50;
  var CONNECTION_RETRY_INTERVAL_MS = 5000;
  var CONNECTION_RETRY_MAX_INTERVAL_MS = 60000;
  var CONNECTION_MAX_RETRIES = 30;
  var MAX_FETCH_RETRIES = 2;
  var TOKEN_DANGER_THRESHOLD = 0.95;
  var TOKEN_WARNING_THRESHOLD = 0.8;
  var FETCH_TIMEOUT_MS = 5000;
  var _DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  function _safeCopy(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src || typeof src !== 'object') continue;
      var keys = Object.keys(src);
      for (var j = 0; j < keys.length; j++) {
        if (!_DANGEROUS_KEYS.has(keys[j])) target[keys[j]] = src[keys[j]];
      }
    }
    return target;
  }
  function _sanitizeObj(obj, depth) {
    if (!obj || typeof obj !== 'object' || (depth ?? 0) > 10) return obj;
    if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) _sanitizeObj(obj[i], (depth ?? 0) + 1); return obj; }
    var keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) {
      if (_DANGEROUS_KEYS[keys[k]]) { delete obj[keys[k]]; }
      else if (obj[keys[k]] && typeof obj[keys[k]] === 'object') { _sanitizeObj(obj[keys[k]], (depth ?? 0) + 1); }
    }
    return obj;
  }

  var _fetchWithTimeout = function(url, opts, timeoutMs) {
    timeoutMs = timeoutMs ?? FETCH_TIMEOUT_MS;
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeoutId = null;
    var mergedOpts = _safeCopy({}, opts ?? {});
    if (controller) {
      if (mergedOpts.signal) {
        var existingSignal = mergedOpts.signal;
        existingSignal.addEventListener('abort', function() { try { controller.abort(); } catch(e) { if (typeof CONFIG !== 'undefined' && CONFIG.DEBUG) console.warn('Abort error:', e); } });
      }
      mergedOpts.signal = controller.signal;
      timeoutId = setTimeout(function() { try { controller.abort(); } catch(e) { if (typeof CONFIG !== 'undefined' && CONFIG.DEBUG) console.warn('Abort error:', e); } }, timeoutMs);
    }
    return fetch(url, mergedOpts).then(function(res) {
      if (timeoutId) clearTimeout(timeoutId);
      return res;
    }).catch(function(err) {
      if (timeoutId) clearTimeout(timeoutId);
      if (err && err.name === 'AbortError') {
        return new Response(JSON.stringify({ error: 'Request aborted', _aborted: true }), { status: 408, headers: { 'Content-Type': 'application/json' } });
      }
      throw err;
    });
  };

  document.documentElement.classList.add('app-ready');

  var _toastTimers = new Set();
  var _globalErrorShown = false;
  var _sanitizeLogMsg = function(msg) {
    if (!msg || typeof msg !== 'string') return msg;
    return msg.replace(/https?:\/\/[^\s]+/g, '[url]').replace(/\/[a-zA-Z]:\\[^\s]+/g, '[path]').replace(/\/api\/[^\s]+/g, '[api]');
  };
  var _globalErrorHandler = function(event) {
    var msg = event && (event.message || event.error && event.error.message);
    var line = event && event.lineno;
    var col = event && event.colno;
    if (msg === undefined && line === undefined && col === undefined) {
      return;
    }
    if (msg && (msg.indexOf('ResizeObserver') !== -1 || msg.indexOf('ERR_ABORTED') !== -1)) {
      return;
    }
    if (CONFIG.DEBUG) {
      console.error('全局异常:', _sanitizeLogMsg(msg), line, col);
    }
    if (!_globalErrorShown) {
      _globalErrorShown = true;
      showToast('页面发生异常，请刷新重试', 'error');
      setTimeout(function() { _globalErrorShown = false; }, ERROR_HANDLER_RESET_MS);
    }
    return true;
  };
  window.addEventListener('error', _globalErrorHandler);

  var _unhandledRejectionHandler = function(e) {
    var msg = e.reason && (e.reason.message || String(e.reason));
    if (msg && (msg.indexOf('ResizeObserver') !== -1 || msg.indexOf('ERR_ABORTED') !== -1 || msg.indexOf('AbortError') !== -1)) return;
    if (CONFIG.DEBUG) {
      console.error('未处理的Promise异常:', _sanitizeLogMsg(msg));
    }
    if (!_globalErrorShown) {
      _globalErrorShown = true;
      var safeMsg = msg ? _sanitizeLogMsg(msg) : '请刷新重试';
      showToast('异步操作异常: ' + safeMsg, 'error');
      setTimeout(function() { _globalErrorShown = false; }, REJECTION_HANDLER_RESET_MS);
    }
  };
  window.addEventListener('unhandledrejection', _unhandledRejectionHandler);

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var escapeAttr = function(str) {
    return escapeHtml(str).replace(/`/g, '&#96;');
  };

  function safeNum(val) {
    return escapeHtml(String(Number.isFinite(val) ? val : 0));
  }

  var SANITIZE_ALLOWED_TAGS = ['b','i','em','strong','a','code','pre','br','p','span','ul','ol','li','h1','h2','h3','h4','h5','h6','blockquote','hr','table','thead','tbody','tr','th','td','dl','dt','dd','mark','small','sub','sup','abbr','cite','dfn','kbd','samp','var','time','details','summary'];
  var SANITIZE_ALLOWED_ATTRS = ['href','title','class','id','target','rel','datetime','lang','dir'];
  var SANITIZE_DANGEROUS_TAGS = ['script','style','svg','math','object','embed','iframe','base','form','input','textarea','select','button','link','meta','noscript','template','slot','portal','frame','frameset','applet'];
  function sanitizeRawHtml(html) {
    if (html == null) return '';
    if (typeof DOMParser === 'undefined') return escapeHtml(String(html));
    var doc = new DOMParser().parseFromString(String(html), 'text/html');
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    var toRemove = [];
    var current = walker.nextNode();
    while (current) {
      var ltag = current.tagName.toLowerCase();
      if (SANITIZE_DANGEROUS_TAGS.indexOf(ltag) !== -1 || SANITIZE_ALLOWED_TAGS.indexOf(ltag) === -1) {
        toRemove.push(current);
      } else {
        var attrs = current.attributes;
        for (var i = attrs.length - 1; i >= 0; i--) {
          var attrName = attrs[i].name.toLowerCase();
          if (attrName.startsWith('on')) {
            current.removeAttribute(attrs[i].name);
          } else if (attrName === 'style') {
            current.removeAttribute(attrs[i].name);
          } else if (['href', 'src', 'action', 'formaction', 'data', 'dynsrc', 'lowsrc', 'poster', 'xlink:href'].indexOf(attrName) !== -1) {
            var val = attrs[i].value.replace(/[\x00-\x1f\x7f\u00ad\u180e\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g, '');
            if (/(?:javascript|data|vbscript|blob|file)\s*:/i.test(val)) {
              current.removeAttribute(attrs[i].name);
            } else {
              var decodedVal = val.replace(/&#x([0-9a-fA-F]+);?/gi, function(_, hex) { return String.fromCharCode(parseInt(hex, 16)); }).replace(/&#(\d+);?/g, function(_, dec) { return String.fromCharCode(parseInt(dec, 10)); }).replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
              if (/(?:javascript|data|vbscript|blob)\s*:/i.test(decodedVal)) {
                current.removeAttribute(attrs[i].name);
                continue;
              }
            }
          } else if (SANITIZE_ALLOWED_ATTRS.indexOf(attrName) === -1 && attrName !== 'class' && attrName !== 'id') {
            current.removeAttribute(attrs[i].name);
          }
        }
        if (current.tagName === 'A' && current.getAttribute('target')) {
          current.setAttribute('rel', 'noopener noreferrer');
        }
      }
      current = walker.nextNode();
    }
    for (var r = 0; r < toRemove.length; r++) {
      if (toRemove[r].parentNode) toRemove[r].parentNode.removeChild(toRemove[r]);
    }
    var result = doc.body.innerHTML;
    var verifyDoc = new DOMParser().parseFromString(result, 'text/html');
    var verifyWalker = verifyDoc.createTreeWalker(verifyDoc.body, NodeFilter.SHOW_ELEMENT);
    var verifyNode = verifyWalker.nextNode();
    while (verifyNode) {
      var vtag = verifyNode.tagName.toLowerCase();
      if (SANITIZE_DANGEROUS_TAGS.indexOf(vtag) !== -1) {
        return escapeHtml(String(html));
      }
      var vAttrs = verifyNode.attributes;
      for (var vi = vAttrs.length - 1; vi >= 0; vi--) {
        var vAttrName = vAttrs[vi].name.toLowerCase();
        if (vAttrName.startsWith('on')) {
          return escapeHtml(String(html));
        }
        if (['href', 'src', 'action', 'formaction', 'data', 'xlink:href'].indexOf(vAttrName) !== -1) {
          var vVal = vAttrs[vi].value;
          if (/(?:javascript|data|vbscript)\s*:/i.test(vVal)) {
            return escapeHtml(String(html));
          }
        }
      }
      verifyNode = verifyWalker.nextNode();
    }
    return result;
  }

  var _lastHtmlHash = new WeakMap();
  function updateHTML(el, html) {
    if (!el) return;
    html = sanitizeRawHtml(html);
    var h = 0;
    for (var i = 0; i < html.length; i++) h = ((h << 5) - h + html.charCodeAt(i)) | 0;
    if (_lastHtmlHash.get(el) === h) return;
    _lastHtmlHash.set(el, h);
    var keysToRemove = [];
    for (var k in _domCache) {
      if (!Object.prototype.hasOwnProperty.call(_domCache, k)) continue;
      var cached = _domCache[k];
      if (!cached.isConnected || el.contains(cached)) {
        keysToRemove.push(k);
      }
    }
    for (var ri = 0; ri < keysToRemove.length; ri++) {
      delete _domCache[keysToRemove[ri]];
    }
    var scrollTop = el.scrollTop;
    var scrollLeft = el.scrollLeft;
    if (_lazyCallbacks) {
      for (var lk in _lazyCallbacks) {
        if (Object.prototype.hasOwnProperty.call(_lazyCallbacks, lk)) {
          var lazyEntry = _lazyCallbacks[lk];
          var lazyEl = lazyEntry && lazyEntry.element ? lazyEntry.element : document.getElementById(lk);
          if (lazyEl && !lazyEl.isConnected) {
            delete _lazyCallbacks[lk];
          }
        }
      }
    }
    el.innerHTML = html;
    el.scrollTop = scrollTop;
    el.scrollLeft = scrollLeft;
    if (_lazyObserver && el.querySelectorAll) {
      var lazyEls = el.querySelectorAll('[data-lazy-observe]');
      for (var li = 0; li < lazyEls.length; li++) {
        var lazyEl = lazyEls[li];
        if (lazyEl.id && _lazyCallbacks[lazyEl.id]) {
          _lazyObserver.observe(lazyEl);
        }
      }
    }
  }

  var _domCache = Object.create(null);
  var _domCacheVersion = 0;
  var _domCacheMaxSize = MAX_CACHE_ENTRIES;
  function $(id) {
    if (id === '__proto__' || id === 'constructor') return null;
    var cached = _domCache[id];
    if (cached) {
      if (cached.isConnected) return cached;
      delete _domCache[id];
    }
    var el = document.getElementById(id);
    if (el) {
      var keys = Object.keys(_domCache);
      if (keys.length >= _domCacheMaxSize) {
        delete _domCache[keys[0]];
      }
      _domCache[id] = el;
    }
    return el ?? null;
  }
  function invalidateDomCache() { _domCache = Object.create(null); _domCacheVersion++; }

  function debounce(fn, delay) {
    var timer = null;
    return function() {
      var ctx = this;
      var args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function() { fn.apply(ctx, args); timer = null; }, delay);
    };
  }

  var _rafQueue = {};
  var _rafScheduled = false;
  function scheduleRender(key, fn) {
    _rafQueue[key] = fn;
    if (!_rafScheduled) {
      _rafScheduled = true;
      requestAnimationFrame(function() {
        _rafScheduled = false;
        var queue = _rafQueue;
        _rafQueue = {};
        for (var k in queue) {
          if (Object.prototype.hasOwnProperty.call(queue, k)) {
            try { queue[k](); } catch (e) { if (CONFIG.DEBUG) console.error('Scheduled render error [' + k + ']:', e); }
          }
        }
      });
    }
  }

  function initAiModForm() {
    var aiModForm = $('ai-mod-form');
    var aiModBtn = $('btn-record-ai-mod');
    if (aiModBtn && aiModForm) {
      var onToggle = function() {
        aiModForm.classList.toggle('hidden');
        if (!aiModForm.classList.contains('hidden')) {
          var summaryInput = $('ai-mod-summary');
          if (summaryInput) summaryInput.focus();
        }
      };
      aiModBtn.addEventListener('click', onToggle);
      _managedListeners.push({ el: aiModBtn, type: 'click', fn: onToggle });
    }
    var aiModCancel = $('btn-ai-mod-cancel');
    if (aiModCancel && aiModForm) {
      var onCancel = function() {
        aiModForm.classList.add('hidden');
      };
      aiModCancel.addEventListener('click', onCancel);
      _managedListeners.push({ el: aiModCancel, type: 'click', fn: onCancel });
    }
    var aiModSubmit = $('btn-ai-mod-submit');
    if (aiModSubmit) {
      var onSubmit = function() {
        var summary = (($('ai-mod-summary') ?? {}).value || '').trim();
        if (!summary) { showToast('请输入修改摘要', 'error'); return; }
        var category = (($('ai-mod-category') ?? {}).value || '变更');
        var agent = (($('ai-mod-agent') ?? {}).value || '').trim() || 'AI';
        var module = (($('ai-mod-module') ?? {}).value || '').trim();
        var method = (($('ai-mod-method') ?? {}).value || '').trim();
        var value = (($('ai-mod-value') ?? {}).value || '').trim();
        var filesStr = (($('ai-mod-files') ?? {}).value || '').trim();
        var files = filesStr ? filesStr.split(/[,，]/).map(function(f) { return f.trim(); }).filter(Boolean) : [];
        var details = (($('ai-mod-details') ?? {}).value || '').trim();

        var body = { summary: summary, category: category, agent: agent, files: files, details: details };
        if (module) body.module = module;
        if (method) body.method = method;
        if (value) body.value = value;

        aiModSubmit.disabled = true;
        aiModSubmit.textContent = '提交中...';

        var token = (typeof getApiToken === 'function') ? getApiToken() : null;
        var headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;

        _fetchWithTimeout(API + '/api/auto-version/record', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
        }).then(function(r) {
          if (!r.ok) {
            if (r.status === 401) throw new Error('需要认证，请设置 HARNESS_API_TOKEN');
            throw new Error('接口返回错误: ' + r.status);
          }
          return r.json();
        }).then(function(result) {
          if (result.success) {
            showToast('版本记录成功: v' + (result.version || ''), 'info');
            if (aiModForm) aiModForm.classList.add('hidden');
            var summaryInput = $('ai-mod-summary');
            var agentInput = $('ai-mod-agent');
            var moduleInput = $('ai-mod-module');
            var methodInput = $('ai-mod-method');
            var valueInput = $('ai-mod-value');
            var filesInput = $('ai-mod-files');
            var detailsInput = $('ai-mod-details');
            if (summaryInput) summaryInput.value = '';
            if (agentInput) agentInput.value = '';
            if (moduleInput) moduleInput.value = '';
            if (methodInput) methodInput.value = '';
            if (valueInput) valueInput.value = '';
            if (filesInput) filesInput.value = '';
            if (detailsInput) detailsInput.value = '';
            DataLayer.invalidateEndpoint('changelog');
            DataLayer.invalidateEndpoint('auto-version/stats');
            DataLayer.invalidateEndpoint('auto-version/recent');
            DataLayer.fetchMultiple(['changelog', 'auto-version/stats', 'auto-version/recent'], function() {
              scheduleRender('changelog', function() { Renderers.changelog(); });
            });
          } else {
            showToast('记录失败: ' + (result.error || '未知错误'), 'error');
          }
        }).catch(function(err) {
          showToast('提交失败，请稍后重试', 'error');
          if (CONFIG.DEBUG) console.error('AI mod submit error:', err);
        }).finally(function() {
          aiModSubmit.disabled = false;
          aiModSubmit.textContent = '提交记录';
        });
      };
      aiModSubmit.addEventListener('click', onSubmit);
      _managedListeners.push({ el: aiModSubmit, type: 'click', fn: onSubmit });
    }
  }

  var DEFAULT_POLL_INTERVAL_MS = 10000;
  var MIN_POLL_INTERVAL_MS = 1000;
  var MAX_POLL_INTERVAL_MS = 300000;

  var CONFIG = {
    POLL_INTERVAL: (function() { var el = document.querySelector('meta[name="poll-interval"]'); var parsed = parseInt(el && el.content, 10); var v = Number.isFinite(parsed) ? parsed : DEFAULT_POLL_INTERVAL_MS; return Math.max(MIN_POLL_INTERVAL_MS, Math.min(v, MAX_POLL_INTERVAL_MS)); })(),
    DEBUG: (function() { var el = document.querySelector('meta[name="harness-debug"]'); return el && el.content === 'true'; })(),
    API_TOKEN: '',
  };

  var API = '';

  var _validStateKeys = (function() {
    var keys = ['overview','agents','skills','sessions','workflow','changelog','audit','config','memory','checkpoints','learnings','workflowTemplates','compliance','deviations','codeReviews','designStats','designPresets','deepeningDashboard','deepeningMetrics','deepeningCache','deepeningConvergence','deepeningReport','deepeningHealthMonitor','deepeningDependencies','deepeningThrottle','deepeningValidator','deepeningLocks','deepeningEventReplay','deepeningPriorityQueue','deepeningMetricsAggregator','deepeningRateLimiter','deepeningSnapshotStore','deepeningBackpressure','deepeningConnectionPool','deepeningRetryPolicy','deepeningServiceRegistry','deepeningLoadBalancer','deepeningTimeoutManager','deepeningGracefulShutdown','deepeningFeatureFlags','deepeningCircuitBreaker','deepeningTaskScheduler','deepeningDataPipeline','deepeningStateManager','deepeningEventBus','deepeningConfigManager','deepeningResourceManager','deepeningAuditTrail','infrastructureHealthChecker','infrastructurePriorityQueue','infrastructureEventBus','frameworkVersion','frameworkStatus','frameworkArchitecture','frameworkFeatures','panoramaMetadata','pairChatStats','pairChatSessions','chatChainStats','chatChainChains','outputFusionStats','generatorVerifierStats','generatorVerifierHistory','isolatedContextStats','isolatedContextActive','planStats','planActive','deepeningRegistryStats','autoVersionStats','autoVersionRecent','commandRouterStats','commandRouterCommands','hookMonitorData','hookSuccessRates','agentPacksList','agentPacksStats','programmableHookStats','programmableHooks','contextCompressionStats','contextCompressionStrategies','intentSchemas','sqliteStats','memoryEntries','memoryUsage','userProfile','skillImprovementPending','skillImprovementStats','skillCreationList','skillCreationStats','skillCuratorStats','nudgeStats','mcpStatus','mcpTools','affinityStats','affinityRecords','subagentStats','subagentBudget','skillLayerStats','skillDedup','skillContext','channelStats','collaborationModes','collaborationStats','collaborationHistory','intentStats','thoughtsStats','embeddingStats','thoughtRetrieverStats','modelSelectorStats','subagentModelStats','conversationPinned','chatSessions','chatHistory'];
    var map = {};
    for (var i = 0; i < keys.length; i++) map[keys[i]] = true;
    return map;
  })();

  var AGENT_COLORS = [
    { bg: 'rgba(129,140,248,.12)', fg: '#a5b4fc', border: 'rgba(129,140,248,.25)' },
    { bg: 'rgba(167,139,250,.12)', fg: '#c4b5fd', border: 'rgba(167,139,250,.25)' },
    { bg: 'rgba(6,182,212,.12)', fg: '#67e8f9', border: 'rgba(6,182,212,.25)' },
    { bg: 'rgba(52,211,153,.12)', fg: '#6ee7b7', border: 'rgba(52,211,153,.25)' },
    { bg: 'rgba(251,191,36,.12)', fg: '#fde68a', border: 'rgba(251,191,36,.25)' },
    { bg: 'rgba(248,113,113,.12)', fg: '#fca5a5', border: 'rgba(248,113,113,.25)' },
  ];

  function getInitials(id) {
    if (!id || typeof id !== 'string') return '??';
    var parts = id.split('-').filter(function(w) { return w.length > 0; });
    if (parts.length === 0) return '??';
    return parts.map(function(w) { return w.charAt(0); }).join('').toUpperCase().slice(0, 2);
  }

  var Store = (function() {
    var _state = {
      overview: {},
      agents: [],
      skills: [],
      sessions: [],
      workflow: {},
      changelog: [],
      audit: [],
      config: {},
      memory: {},
      checkpoints: {},
      learnings: {},
      workflowTemplates: {},
      compliance: {},
      deviations: {},
      codeReviews: {},
      designStats: {},
      designPresets: {},
      deepeningDashboard: {},
      deepeningMetrics: {},
      deepeningCache: {},
      deepeningConvergence: {},
      deepeningReport: {},
      deepeningHealthMonitor: {},
      deepeningDependencies: {},
      deepeningThrottle: {},
      deepeningValidator: {},
      deepeningLocks: {},
      deepeningEventReplay: {},
      deepeningPriorityQueue: {},
      deepeningMetricsAggregator: {},
      deepeningRateLimiter: {},
      deepeningSnapshotStore: {},
      deepeningBackpressure: {},
      deepeningConnectionPool: {},
      deepeningRetryPolicy: {},
      deepeningServiceRegistry: {},
      deepeningLoadBalancer: {},
      deepeningTimeoutManager: {},
      deepeningGracefulShutdown: {},
      deepeningFeatureFlags: {},
      deepeningCircuitBreaker: {},
      deepeningTaskScheduler: {},
      deepeningDataPipeline: {},
      deepeningStateManager: {},
      deepeningEventBus: {},
      deepeningConfigManager: {},
      deepeningResourceManager: {},
      deepeningAuditTrail: {},
      infrastructureHealthChecker: {},
      infrastructurePriorityQueue: {},
      infrastructureEventBus: {},
      frameworkVersion: {},
      frameworkStatus: {},
      frameworkArchitecture: {},
      frameworkFeatures: {},
      panoramaMetadata: {},
      pairChatStats: {},
      pairChatSessions: {},
      chatChainStats: {},
      chatChainChains: {},
      outputFusionStats: {},
      generatorVerifierStats: {},
      generatorVerifierHistory: {},
      isolatedContextStats: {},
      isolatedContextActive: {},
      planStats: {},
      planActive: {},
      deepeningRegistryStats: {},
      autoVersionStats: {},
      autoVersionRecent: {},
      commandRouterStats: {},
      commandRouterCommands: {},
      hookMonitorData: {},
      hookSuccessRates: {},
      agentPacksList: [],
      agentPacksStats: {},
      programmableHookStats: {},
      programmableHooks: {},
      contextCompressionStats: {},
      contextCompressionStrategies: {},
      intentSchemas: {},
      sqliteStats: {},
      memoryEntries: {},
      memoryUsage: {},
      userProfile: {},
      skillImprovementPending: {},
      skillImprovementStats: {},
      skillCreationList: {},
      skillCreationStats: {},
      skillCuratorStats: {},
      nudgeStats: {},
      mcpStatus: {},
      mcpTools: {},
      affinityStats: {},
      affinityRecords: {},
      subagentStats: {},
      subagentBudget: {},
      skillLayerStats: {},
      skillDedup: {},
      skillContext: {},
      channelStats: {},
      collaborationModes: {},
      collaborationStats: {},
      collaborationHistory: {},
      intentStats: {},
      thoughtsStats: {},
      embeddingStats: {},
      thoughtRetrieverStats: {},
      modelSelectorStats: {},
      subagentModelStats: {},
      chatSessions: {},
      chatHistory: {}
    };
    var _subscribers = {};
    var _changeHooks = [];
    var _prevSnapshot = {};
    var _batchDepth = 0;
    var _pendingNotify = [];
    var _pendingNotifySet = new Set();
    var _pendingPrevValues = {};

    function _hash(str) {
      var h = 0;
      for (var i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
      }
      return h;
    }

    function _shallowHash(value) {
      if (value == null) return 0;
      if (typeof value !== 'object') return _hash(String(value));
      if (Array.isArray(value)) {
        var h = value.length;
        var step = value.length <= 20 ? 1 : Math.ceil(value.length / 20);
        for (var i = 0; i < value.length; i += step) {
          h = ((h << 5) - h + _hash(String(value[i]))) | 0;
        }
        if (value.length > 0) {
          h = ((h << 5) - h + _hash(String(value[value.length - 1]))) | 0;
        }
        return h;
      }
      var keys = Object.keys(value);
      var h = keys.length;
      for (var i = 0; i < keys.length; i++) {
        h = ((h << 5) - h + _hash(keys[i] + ':' + String(value[keys[i]]))) | 0;
      }
      return h;
    }

    function get(key) {
      return _state[key];
    }

    function getAll() {
      return _state;
    }

    function getStats() {
      var keyCount = Object.keys(_state).length;
      var subCount = 0;
      for (var k in _subscribers) {
        if (Object.prototype.hasOwnProperty.call(_subscribers, k)) subCount += _subscribers[k].length;
      }
      return { keyCount: keyCount, subscriberCount: subCount, batchDepth: _batchDepth };
    }

    function set(key, value) {
      if (!key || typeof key !== 'string' || !_validStateKeys[key]) return;
      var prev = _state[key];
      _state[key] = value;
      var prevH = _prevSnapshot[key];
      var currH = _shallowHash(value);
      if (prevH !== currH) {
        _prevSnapshot[key] = currH;
        if (_batchDepth > 0) {
          if (!_pendingNotifySet.has(key)) { _pendingNotify.push(key); _pendingNotifySet.add(key); _pendingPrevValues[key] = prev; }
        } else {
          _notify(key, value, prev);
        }
      }
    }

    function subscribe(key, fn) {
      if (!_subscribers[key]) _subscribers[key] = [];
      _subscribers[key].push(fn);
      return function() {
        var list = _subscribers[key];
        if (list) {
          var idx = list.indexOf(fn);
          if (idx > -1) list.splice(idx, 1);
        }
      };
    }

    function _notify(key, value, prev) {
      var list = _subscribers[key];
      if (list) {
        for (var i = 0; i < list.length; i++) {
          try { list[i](value, prev); } catch (e) { if (CONFIG.DEBUG) console.error('Store subscriber error [' + key + ']:', e); }
        }
      }
      for (var h = 0; h < _changeHooks.length; h++) {
        try { _changeHooks[h](key, value, prev); } catch (e) { if (CONFIG.DEBUG && typeof console !== 'undefined') console.warn('[Harness] changeHook error:', e); }
      }
    }

    function batchUpdate(updates) {
      var prevValues = _batchDepth > 0 ? null : {};
      for (var pk in updates) {
        if (Object.prototype.hasOwnProperty.call(updates, pk)) {
          if (!_pendingNotifySet.has(pk) && prevValues !== null) {
            prevValues[pk] = _state[pk];
          }
        }
      }
      _batchDepth++;
      try {
        for (var key in updates) {
          if (Object.prototype.hasOwnProperty.call(updates, key)) {
            _state[key] = updates[key];
            var prevH = _prevSnapshot[key];
            var currH = _shallowHash(updates[key]);
            if (prevH !== currH) {
              _prevSnapshot[key] = currH;
              if (!_pendingNotifySet.has(key)) {
                _pendingNotify.push(key);
                _pendingNotifySet.add(key);
                _pendingPrevValues[key] = prevValues && prevValues[key] !== undefined ? prevValues[key] : _state[key];
              }
            }
          }
        }
      } finally {
        _batchDepth--;
      }
      if (_batchDepth === 0) {
        var toNotify = _pendingNotify.slice();
        var prevVals = {};
        for (var pk in _pendingPrevValues) { if (Object.prototype.hasOwnProperty.call(_pendingPrevValues, pk)) { prevVals[pk] = _pendingPrevValues[pk]; } }
        _pendingNotify = [];
        _pendingNotifySet.clear();
        _pendingPrevValues = {};
        for (var c = 0; c < toNotify.length; c++) {
          var nk = toNotify[c];
          var pv = prevVals[nk] !== undefined ? prevVals[nk] : null;
          _notify(nk, _state[nk], pv);
        }
        return toNotify.length > 0;
      }
      return false;
    }

    function addChangeHook(fn) {
      _changeHooks.push(fn);
      return function() { var idx = _changeHooks.indexOf(fn); if (idx > -1) _changeHooks.splice(idx, 1); };
    }

    var _selectorCache = {};
    var _selectorDeps = {};

    function createSelector(selectorId, deps, computeFn) {
      _selectorDeps[selectorId] = deps;
      return function() {
        var depValues = deps.map(function(d) { return _state[d]; });
        var cacheKey = depValues.map(function(v) { return _shallowHash(v); }).join('|');
        if (_selectorCache[selectorId] && _selectorCache[selectorId].key === cacheKey) {
          return _selectorCache[selectorId].value;
        }
        var result = computeFn.apply(null, depValues);
        _selectorCache[selectorId] = { key: cacheKey, value: result };
        return result;
      };
    }

    function invalidateSelector(selectorId) {
      delete _selectorCache[selectorId];
      delete _selectorDeps[selectorId];
    }

    return { get: get, getAll: getAll, set: set, subscribe: subscribe, batchUpdate: batchUpdate, addChangeHook: addChangeHook, createSelector: createSelector, invalidateSelector: invalidateSelector, _shallowHash: _shallowHash };
  })();

  var UIState = {
  loadError: false,
  skillSearchQuery: '',
  sessionSearchQuery: '',
  auditSearchQuery: '',
  chatSessionSearchQuery: '',
  activeSkillFilter: 'all',
    activeAgentFilter: 'all',
    changelogPage: 1,
    changelogPageSize: 5,
    _firstLoadDone: false,
    _onlineStatus: true,
    _listeners: {},
    on: function(key, fn) {
      if (!this._listeners[key]) this._listeners[key] = [];
      this._listeners[key].push(fn);
    },
    emit: function(key) {
      var list = this._listeners[key];
      if (list) { for (var i = 0; i < list.length; i++) { try { list[i](); } catch (e) { if (CONFIG.DEBUG) console.error('[MediaQuery] listener error:', e); } } }
    },
  };

  function _tokenColorClass(ratio) { return ratio > TOKEN_DANGER_THRESHOLD ? 'c-danger' : ratio > TOKEN_WARNING_THRESHOLD ? 'c-warning' : 'c-success'; }
  function _tokenColorStyle(ratio) { return ratio > TOKEN_DANGER_THRESHOLD ? 'var(--danger)' : ratio > TOKEN_WARNING_THRESHOLD ? 'var(--warning)' : 'var(--success)'; }
  function _tokenGlowStyle(ratio) { return ratio > TOKEN_DANGER_THRESHOLD ? 'var(--danger-glow)' : ratio > TOKEN_WARNING_THRESHOLD ? 'var(--warning-glow)' : 'var(--success-glow)'; }

  function showToast(msg, type) {
    var container = $('toast-container');
    if (!container) return;
    while (container.children.length >= MAX_TOASTS) {
      var oldest = container.firstChild;
      if (oldest) {
        oldest.classList.remove('toast-visible');
        oldest.classList.add('toast-exit');
        (function(el) {
          setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
        })(oldest);
      } else {
        break;
      }
    }
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    var icon = type === 'error' ? '✕ ' : type === 'success' ? '✓ ' : type === 'warning' ? '⚠ ' : '';
    el.textContent = icon + msg;
    el.style.cursor = 'pointer';
    var progress = document.createElement('div');
    progress.className = 'toast-progress';
    el.appendChild(progress);
    el.addEventListener('click', function() {
      clearTimeout(t1);
      _toastTimers.delete(t1);
      el.classList.remove('toast-visible');
      el.classList.add('toast-exit');
      setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
    });
    container.appendChild(el);
    requestAnimationFrame(function() { el.classList.add('toast-visible'); });
    var t1 = setTimeout(function() {
      _toastTimers.delete(t1);
      el.classList.remove('toast-visible');
      el.classList.add('toast-exit');
      var t2 = setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); _toastTimers.delete(t2); }, TOAST_EXIT_MS);
      _toastTimers.add(t2);
    }, TOAST_DISPLAY_MS);
    _toastTimers.add(t1);
  }

  function formatTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n);
  }

  function animateNumber(el, targetValue, duration) {
    if (!el || typeof targetValue !== 'number') return;
    if (el._animRafId) cancelAnimationFrame(el._animRafId);
    var startValue = (function() { var n = parseInt(el.textContent.replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; })();
    if (startValue === targetValue) return;
    var startTime = null;
    var step = function(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / (duration ?? 400), 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      var current = Math.round(startValue + (targetValue - startValue) * eased);
      el.textContent = formatTokens(current);
      if (progress < 1) {
        el._animRafId = requestAnimationFrame(step);
      } else {
        delete el._animRafId;
      }
    };
    el._animRafId = requestAnimationFrame(step);
  }

  function phaseName(id) {
    var map = {
      'brainstorming': '需求探索',
      'requirement-analysis': '需求分析',
      'architecture-design': '架构设计',
      'module-development': '模块开发',
      'integration-testing': '集成测试',
      'deployment': '部署上线',
      'extension': '扩展'
    };
    return map[id] || id || '—';
  }

  var _abortController = null;
  var _fetching = false;
  var _fetchGeneration = 0;
  var _pollTimer = null;
  var _consecutiveErrors = 0;
  var _baseInterval = CONFIG.POLL_INTERVAL;
  var _pageVisible = true;
  var _responseCache = {};
  var _cacheMaxAge = CACHE_MAX_AGE_MS;
  var _MAX_CACHE_ENTRIES = MAX_CACHE_ENTRIES;
  var _cacheEvictionCounter = 0;
  var _dataHashCache = {};
  var _MAX_DATAHASH_ENTRIES = 200;
  var _dataHashEvictionCounter = 0;
  var _activePanel = 'panorama';
  var _fetchStats = { totalFetches: 0, cacheHits: 0, skippedUpdates: 0, errors: 0 };
  var _pendingRequests = {};
  var _MAX_PENDING_REQUESTS = 50;
  var _connectionDown = false;
  var _connectionRetryTimer = null;
  var _CONNECTION_RETRY_INTERVAL = CONNECTION_RETRY_INTERVAL_MS;
  var _MAX_FETCH_RETRIES = MAX_FETCH_RETRIES;
  var _connectionRetryCount = 0;
  var _CONNECTION_RETRY_MAX_INTERVAL = CONNECTION_RETRY_MAX_INTERVAL_MS;
  var _CONNECTION_MAX_RETRIES = CONNECTION_MAX_RETRIES;
  var _panelEndpointGroups = {
    core: ['overview', 'config', 'frameworkVersion', 'frameworkStatus'],
    panorama: ['agents', 'skills', 'sessions', 'memory', 'panoramaMetadata', 'thoughtsStats', 'embeddingStats', 'thoughtRetrieverStats', 'modelSelectorStats', 'subagentModelStats'],
    workflow: ['workflow', 'checkpoints', 'learnings', 'workflowTemplates'],
    agents: ['agents'],
    skills: ['skills'],
    sessions: ['sessions'],
    changelog: ['changelog', 'autoVersionStats', 'autoVersionRecent'],
    compliance: ['compliance', 'deviations', 'codeReviews'],
    audit: ['audit'],
    design: ['designStats', 'designPresets'],
    architecture: ['agents', 'skills', 'frameworkArchitecture', 'frameworkFeatures'],
    deepening: ['deepeningDashboard', 'deepeningMetrics', 'deepeningCache', 'deepeningConvergence', 'deepeningReport', 'deepeningHealthMonitor', 'deepeningDependencies', 'deepeningThrottle', 'deepeningValidator', 'deepeningLocks', 'deepeningEventReplay', 'deepeningPriorityQueue', 'deepeningMetricsAggregator', 'deepeningRateLimiter', 'deepeningSnapshotStore', 'deepeningBackpressure', 'deepeningConnectionPool', 'deepeningRetryPolicy', 'deepeningServiceRegistry', 'deepeningLoadBalancer', 'deepeningTimeoutManager', 'deepeningGracefulShutdown', 'deepeningFeatureFlags', 'deepeningCircuitBreaker', 'deepeningTaskScheduler', 'deepeningDataPipeline', 'deepeningStateManager', 'deepeningEventBus', 'deepeningConfigManager', 'deepeningResourceManager', 'deepeningAuditTrail', 'deepeningRegistryStats'],
    infrastructure: ['infrastructureHealthChecker', 'infrastructurePriorityQueue', 'infrastructureEventBus'],
    collaboration: ['subagentStats', 'subagentBudget', 'skillLayerStats', 'skillDedup', 'skillContext', 'channelStats', 'collaborationModes', 'collaborationStats', 'collaborationHistory', 'intentStats', 'intentSchemas', 'pairChatStats', 'pairChatSessions', 'chatChainStats', 'chatChainChains', 'outputFusionStats', 'generatorVerifierStats', 'generatorVerifierHistory', 'isolatedContextStats', 'isolatedContextActive', 'planStats', 'planActive'],
    commands: ['commandRouterStats', 'commandRouterCommands', 'programmableHookStats', 'programmableHooks', 'contextCompressionStats', 'contextCompressionStrategies'],
    knowledge: ['sqliteStats', 'memoryEntries', 'memoryUsage', 'userProfile', 'skillImprovementPending', 'skillImprovementStats', 'skillCreationList', 'skillCreationStats', 'skillCuratorStats', 'nudgeStats', 'mcpStatus', 'mcpTools', 'affinityStats', 'affinityRecords', 'hookMonitorData', 'hookSuccessRates', 'agentPacksList', 'agentPacksStats', 'thoughtsStats', 'embeddingStats', 'thoughtRetrieverStats', 'modelSelectorStats', 'subagentModelStats', 'conversationPinned'],
    chat: ['chatSessions'],
  };
  var _adaptiveIntervals = {
    panorama: 10000,
    architecture: 30000,
    workflow: 8000,
    agents: 15000,
    skills: 20000,
    sessions: 10000,
    changelog: 60000,
    compliance: 60000,
    audit: 15000,
    design: 30000,
    deepening: 8000,
    collaboration: 10000,
    knowledge: 15000,
    chat: 8000
  };

  function _endpointToStateKey(ep) {
    var STATE_KEY_OVERRIDES = {
      'skill-layers/stats': 'skillLayerStats',
      'skill-layers/dedup': 'skillDedup',
      'skill-layers/context': 'skillContext',
      'version': 'frameworkVersion',
      'programmable-hook/monitor': 'hookMonitorData',
      'programmable-hook/success-rates': 'hookSuccessRates'
    };
    if (STATE_KEY_OVERRIDES[ep]) return STATE_KEY_OVERRIDES[ep];
    return ep.split('/').map(function(part, partIdx) {
      return part.split('-').map(function(w, i) {
        if (partIdx > 0 && i === 0) return w.charAt(0).toUpperCase() + w.slice(1);
        return i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1);
      }).join('');
    }).join('');
  }

  var _ENDPOINT_DEFS = [
    { e: 'overview', t: 'o' }, { e: 'agents', t: 'a' }, { e: 'skills', t: 'a' },
    { e: 'sessions', t: 'a' }, { e: 'workflow', t: 'o' }, { e: 'changelog', t: 'a' },
    { e: 'audit', t: 'o' }, { e: 'config', t: 'o' }, { e: 'memory', t: 'o' },
    { e: 'checkpoints' }, { e: 'learnings' }, { e: 'workflow-templates' },
    { e: 'compliance' }, { e: 'deviations' }, { e: 'code-reviews' },
    { e: 'design/stats' }, { e: 'design/presets' },
    { e: 'deepening/dashboard' }, { e: 'deepening/metrics' }, { e: 'deepening/cache' },
    { e: 'deepening/convergence' }, { e: 'deepening/report' },
    { e: 'deepening/health-monitor' }, { e: 'deepening/dependencies' },
    { e: 'deepening/throttle' }, { e: 'deepening/validator' }, { e: 'deepening/locks' },
    { e: 'deepening/event-replay' }, { e: 'deepening/priority-queue' },
    { e: 'deepening/metrics-aggregator' }, { e: 'deepening/rate-limiter' },
    { e: 'deepening/snapshot-store' }, { e: 'deepening/backpressure' },
    { e: 'deepening/connection-pool' }, { e: 'deepening/retry-policy' },
    { e: 'deepening/service-registry' }, { e: 'deepening/load-balancer' },
    { e: 'deepening/timeout-manager' }, { e: 'deepening/graceful-shutdown' },
    { e: 'deepening/feature-flags' }, { e: 'deepening/circuit-breaker' },
    { e: 'deepening/task-scheduler' }, { e: 'deepening/data-pipeline' },
    { e: 'deepening/state-manager' }, { e: 'deepening/event-bus' },
    { e: 'deepening/config-manager' }, { e: 'deepening/resource-manager' },
    { e: 'deepening/audit-trail' },
    { e: 'subagent/stats' }, { e: 'subagent/budget' },
    { e: 'skill-layers/stats' }, { e: 'skill-layers/dedup' }, { e: 'skill-layers/context' },
    { e: 'channel/stats' }, { e: 'collaboration/modes' }, { e: 'collaboration/stats' },
    { e: 'collaboration/history' }, { e: 'intent/stats' }, { e: 'intent/schemas' },
    { e: 'version' }, { e: 'framework/status' }, { e: 'framework/architecture' },
    { e: 'framework/features' }, { e: 'panorama/metadata' },
    { e: 'pair-chat/stats' }, { e: 'pair-chat/sessions' },
    { e: 'chat-chain/stats' }, { e: 'chat-chain/chains' },
    { e: 'output-fusion/stats' }, { e: 'generator-verifier/stats' },
    { e: 'generator-verifier/history' }, { e: 'isolated-context/stats' },
    { e: 'isolated-context/active' }, { e: 'plan/stats' }, { e: 'plan/active' },
    { e: 'deepening-registry/stats' }, { e: 'auto-version/stats' },
    { e: 'auto-version/recent' }, { e: 'command-router/stats' },
    { e: 'command-router/commands' }, { e: 'programmable-hook/stats' },
    { e: 'programmable-hook/hooks' }, { e: 'context-compression/stats' },
    { e: 'context-compression/strategies' }, { e: 'sqlite/stats' },
    { e: 'memory/entries' }, { e: 'memory/usage' }, { e: 'user/profile' },
    { e: 'skill-improvement/pending' }, { e: 'skill-improvement/stats' },
    { e: 'skill-creation/list' }, { e: 'skill-creation/stats' },
    { e: 'skill-curator/stats' }, { e: 'nudge/stats' },
    { e: 'mcp/status' }, { e: 'mcp/tools' }, { e: 'affinity/stats' },
    { e: 'cli-anything/status' }, { e: 'cli-anything/hub' },
    { e: 'affinity/records' }, { e: 'programmable-hook/monitor' },
    { e: 'programmable-hook/success-rates' }, { e: 'agent-packs/list' },
    { e: 'agent-packs/stats' }, { e: 'thoughts/stats' }, { e: 'embedding/stats' },
    { e: 'thought-retriever/stats' }, { e: 'model-selector/stats' },
    { e: 'subagent/model-stats' },
    { e: 'conversation/pinned' },
    { e: 'chat/sessions' },
    { e: 'themes' }
  ];
  var ENDPOINT_MAP = _ENDPOINT_DEFS.map(function(d) {
    var m = { endpoint: d.e, stateKey: _endpointToStateKey(d.e) };
    if (d.t === 'o') m.isObject = true;
    if (d.t === 'a') m.isArray = true;
    return m;
  });

  var DataLayer = {
    fetchAll: function() {
      FrameworkMonitor.clearExpectedResources();
      if (!_pageVisible) {
        DataLayer._scheduleNext();
        return Promise.resolve();
      }
      if (_fetching && _abortController) {
        try { _abortController.abort(); } catch (e) { if (CONFIG.DEBUG) console.warn('abort failed:', e); }
        _abortController = null;
        _fetching = false;
        _pendingRequests = {};
      }
      _fetching = true;
      _fetchStats.totalFetches++;
      var currentGen = ++_fetchGeneration;
      _abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var signal = _abortController ? _abortController.signal : null;

      var activeKeys = new Set(_panelEndpointGroups.core ?? []);
      var panelKeys = _panelEndpointGroups[_activePanel];
      if (panelKeys) {
        for (var pi = 0; pi < panelKeys.length; pi++) activeKeys.add(panelKeys[pi]);
      }

      var filteredEndpoints = ENDPOINT_MAP.filter(function(m) {
        return activeKeys.has(m.stateKey);
      });

      var FETCH_CONCURRENCY = 8;
      var fetchItems = filteredEndpoints.map(function(m) {
        var cached = _responseCache[m.stateKey];
        if (cached && (Date.now() - cached.ts < _cacheMaxAge)) {
          _fetchStats.cacheHits++;
          _fetchStats.skippedUpdates++;
          return null;
        }
        if (_connectionDown && cached) {
          _fetchStats.cacheHits++;
          return null;
        }
        return m;
      }).filter(Boolean);

      var cachedResults = filteredEndpoints.map(function(m) {
        var cached = _responseCache[m.stateKey];
        if (cached && (Date.now() - cached.ts < _cacheMaxAge)) {
          return { stateKey: m.stateKey, value: cached.data, fromCache: true };
        }
        if (_connectionDown && cached) {
          return { stateKey: m.stateKey, value: cached.data, fromCache: true };
        }
        return null;
      });

      function fetchEndpoint(m) {
        var opts = signal ? { signal: signal } : undefined;
        return dedupFetch(API + '/api/' + m.endpoint, opts)
          .then(function(r) {
            if (!r.ok) throw new Error('接口返回错误: ' + r.status);
            return r.json();
          })
          .then(function(data) {
            if (m.isArray && !Array.isArray(data)) data = [];
            if (m.isObject && (data === null || typeof data !== 'object' || Array.isArray(data))) data = {};
            _cacheEvictionCounter++;
            if (_cacheEvictionCounter % 10 === 0) {
              var cacheKeys = Object.keys(_responseCache);
              if (cacheKeys.length > _MAX_CACHE_ENTRIES) {
                var now = Date.now();
                cacheKeys.sort(function(a, b) { return _responseCache[a].ts - _responseCache[b].ts; });
                var removeCount = cacheKeys.length - Math.floor(_MAX_CACHE_ENTRIES * 0.8);
                for (var ri = 0; ri < removeCount; ri++) {
                  delete _dataHashCache[cacheKeys[ri]];
                  delete _responseCache[cacheKeys[ri]];
                }
              }
              var expiredKeys = Object.keys(_responseCache).filter(function(k) { return now - _responseCache[k].ts > _cacheMaxAge * 4; });
              for (var ei = 0; ei < expiredKeys.length; ei++) {
                delete _dataHashCache[expiredKeys[ei]];
                delete _responseCache[expiredKeys[ei]];
              }
            }
            _dataHashEvictionCounter++;
            if (_dataHashEvictionCounter % 50 === 0) {
              var dhKeys = Object.keys(_dataHashCache);
              if (dhKeys.length > _MAX_DATAHASH_ENTRIES) {
                for (var di = 0; di < dhKeys.length - _MAX_DATAHASH_ENTRIES + 20; di++) {
                  delete _dataHashCache[dhKeys[di]];
                }
              }
            }
            _responseCache[m.stateKey] = { data: data, ts: Date.now() };
            return { stateKey: m.stateKey, value: data, fromCache: false };
          });
      }

      var promises = cachedResults.filter(function(r) { return r !== null; });
      var _batchErrors = [];
      var batchIndex = 0;
      function processBatch() {
        if (batchIndex >= fetchItems.length) return Promise.resolve();
        var batch = fetchItems.slice(batchIndex, batchIndex + FETCH_CONCURRENCY);
        batchIndex += FETCH_CONCURRENCY;
        return Promise.allSettled(batch.map(fetchEndpoint)).then(function(batchResults) {
          batchResults.forEach(function(r, idx) {
            if (r.status === 'fulfilled') {
              promises.push(r.value);
            } else {
              _batchErrors.push({ reason: r.reason, endpoint: batch[idx].endpoint, stateKey: batch[idx].stateKey });
            }
          });
          return processBatch();
        });
      }

      return processBatch().then(function() {
        return Promise.resolve(promises);
      }).then(function(allResults) {
        if (currentGen !== _fetchGeneration) {
          _fetching = false;
          DataLayer._scheduleNext();
          return;
        }
        _fetching = false;
        var updates = {};
        var hasError = false;
        var hasAuthError = false;
        var hasRateLimit = false;
        var rateLimitRetryAfter = 0;
        var aborted = false;

        allResults.forEach(function(result) {
          if (result.value !== undefined) {
            var key = result.stateKey;
            var newVal = result.value;
            if (newVal && newVal._authError) {
              hasAuthError = true;
              hasError = true;
              _fetchStats.errors++;
              return;
            }
            if (newVal && newVal._rateLimited) {
              hasRateLimit = true;
              rateLimitRetryAfter = Math.max(rateLimitRetryAfter, newVal._retryAfter ?? 5);
              return;
            }
            if (newVal && newVal._aborted) {
              aborted = true;
              return;
            }
            updates[key] = newVal;
          }
        });

        _batchErrors.forEach(function(err) {
          var errReason = err.reason && err.reason.message || String(err.reason);
          if (err.reason && err.reason.name === 'AbortError') {
            aborted = true;
            return;
          }
          if (errReason.indexOf('401') >= 0 || errReason.indexOf('Authentication') >= 0) {
            hasAuthError = true;
            hasError = true;
            _fetchStats.errors++;
            return;
          }
          if (errReason.indexOf('429') >= 0) {
            hasRateLimit = true;
            rateLimitRetryAfter = Math.max(rateLimitRetryAfter, 5);
            _fetchStats.errors++;
            return;
          }
          var isConnError = errReason.indexOf('ERR_CONNECTION_REFUSED') >= 0 ||
            errReason.indexOf('Failed to fetch') >= 0 ||
            errReason.indexOf('ERR_NETWORK_CHANGED') >= 0 ||
            errReason.indexOf('NetworkError') >= 0;
          if (isConnError) {
            if (!_connectionDown) {
              _connectionDown = true;
              showToast('无法连接到服务器，将在恢复后自动重试', 'error');
              _scheduleConnectionRetry();
            }
          } else {
            if (CONFIG.DEBUG) console.error('获取 ' + err.endpoint + ' 数据失败:', err.reason);
          }
          hasError = true;
          _fetchStats.errors++;
          var failedKey = err.stateKey;
          if (failedKey) {
            var panelMap = { overview: 'panorama-panel', agents: 'agents-panel', skills: 'skills-panel', sessions: 'sessions-panel', workflow: 'workflow-panel', changelog: 'changelog-panel', compliance: 'compliance-panel', audit: 'audit-panel', architecture: 'architecture-panel', design: 'design-panel', deepening: 'deepening-panel', collaboration: 'collaboration-panel' };
            var panelEl = panelMap[failedKey] && $(panelMap[failedKey]);
            if (panelEl) InteractionState.setError(panelEl, true, '数据加载失败');
          }
        });

        if (aborted) {
          DataLayer._scheduleNext();
          return;
        }

        if (hasRateLimit) {
          _consecutiveErrors++;
          var rlDelay = (rateLimitRetryAfter + 1) * 1000;
          if (_pollTimer) clearTimeout(_pollTimer);
          _pollTimer = setTimeout(function() { DataLayer.fetchAll().catch(function(e) { if (CONFIG.DEBUG) console.warn('[Harness] poll fetch error:', e); }); }, rlDelay);
          return;
        }

        if (hasAuthError && !UIState._authErrorShown) {
          UIState._authErrorShown = true;
          showToast('认证失败：请设置 NODE_ENV=development 或 HARNESS_API_TOKEN', 'error');
        }

        if (hasError && !UIState.loadError && !hasAuthError) {
          UIState.loadError = true;
          _consecutiveErrors++;
          if (!_connectionDown) {
            showToast('部分数据加载失败，请检查后端服务是否正常运行', 'error');
          }
        } else if (!hasError && UIState.loadError) {
          UIState.loadError = false;
          _consecutiveErrors = 0;
          if (!_connectionDown) {
            showToast('数据连接已恢复正常', '');
          }
          document.querySelectorAll('.card.is-error, .stat-card.is-error, .ds-section.is-error').forEach(function(el) {
            InteractionState.clearAll(el);
          });
        } else if (!hasError) {
          _consecutiveErrors = 0;
        }

        var refreshEl = $('refresh-time');
        if (refreshEl) refreshEl.textContent = new Date().toLocaleTimeString('zh-CN');
        var footerRefreshEl = $('footer-refresh-time');
        if (footerRefreshEl) footerRefreshEl.textContent = new Date().toLocaleTimeString('zh-CN');
        Store.batchUpdate(updates);
        if (!UIState._firstLoadDone) {
          UIState._firstLoadDone = true;
          document.querySelectorAll('.loading-overlay').forEach(function(el) {
            var parent = el.parentElement;
            if (parent) parent.removeChild(el);
          });
          document.querySelectorAll('.card.is-loading, .stat-card.is-loading, .ds-section.is-loading').forEach(function(el) {
            InteractionState.clearAll(el);
          });
          scheduleRender('panorama', function() { Renderers.panorama(); });
          scheduleRender('workflow', function() { Renderers.workflow(); });
          scheduleRender('agents', function() { Renderers.agents(); });
          scheduleRender('skills', function() { Renderers.skills(); });
          scheduleRender('sessions', function() { Renderers.sessions(); });
          scheduleRender('changelog', function() { Renderers.changelog(); });
          scheduleRender('compliance', function() { Renderers.compliance(); });
          scheduleRender('audit', function() { Renderers.audit(); });
          scheduleRender('architecture', function() { Renderers.architecture(); });
          scheduleRender('frameworkFeatures', function() { Renderers._frameworkFeatures(); });
          scheduleRender('design', function() { Renderers.design(); });
          scheduleRender('deepening', function() { Renderers.deepening(); });
          scheduleRender('commands', function() { Renderers.commands(); });
        }
        DataLayer._scheduleNext();
      }).catch(function(err) {
        if (CONFIG.DEBUG) console.error('数据获取异常:', err);
        _fetchStats.errors++;
        if (!UIState.loadError) {
          UIState.loadError = true;
          _consecutiveErrors++;
          showToast('数据获取异常，请检查网络连接和后端服务', 'error');
        }
        DataLayer._scheduleNext();
      }).catch(function(e) { if (CONFIG.DEBUG) console.warn('[DataLayer] fetchAll handler error:', e); DataLayer._scheduleNext(); });
    },

    _scheduleNext: function() {
      if (_pollTimer) clearTimeout(_pollTimer);
      var panelInterval = _adaptiveIntervals[_activePanel] || _baseInterval;
      var interval = panelInterval;
      if (_connectionDown) {
        interval = _CONNECTION_RETRY_INTERVAL + Math.floor(Math.random() * 2000);
      } else if (_consecutiveErrors > 0) {
        var backoff = Math.min(_baseInterval * Math.pow(2, _consecutiveErrors), _baseInterval * 16);
        interval = backoff + Math.floor(Math.random() * 1000);
      } else {
        var jitter = Math.floor(Math.random() * 500);
        interval = panelInterval + jitter;
      }
      _pollTimer = setTimeout(function() { DataLayer.fetchAll().catch(function(e) { if (CONFIG.DEBUG) console.warn('[Harness] poll fetch error:', e); }); }, interval);
    },

    setActivePanel: function(panelId) {
      _activePanel = panelId;
      var panelKeys = _panelEndpointGroups[panelId];
      if (panelKeys && FrameworkMonitor && FrameworkMonitor.addExpectedResources) {
        FrameworkMonitor.addExpectedResources(panelKeys);
      }
    },

    getStats: function() {
      return {
        totalFetches: _fetchStats.totalFetches,
        cacheHits: _fetchStats.cacheHits,
        skippedUpdates: _fetchStats.skippedUpdates,
        errors: _fetchStats.errors,
        cacheSize: Object.keys(_responseCache).length,
        consecutiveErrors: _consecutiveErrors,
        fetching: _fetching,
      };
    },

    clearCache: function() {
      _responseCache = {};
      _dataHashCache = {};
    },

    invalidateEndpoint: function(endpoint) {
      var stateKey = null;
      for (var i = 0; i < ENDPOINT_MAP.length; i++) {
        if (ENDPOINT_MAP[i].endpoint === endpoint) {
          stateKey = ENDPOINT_MAP[i].stateKey;
          break;
        }
      }
      if (stateKey) {
        delete _responseCache[stateKey];
        delete _dataHashCache[stateKey];
      }
    },

    fetchMultiple: function(endpoints, callback) {
      var gen = ++_fetchGeneration;
      var stateKeys = [];
      for (var ei = 0; ei < endpoints.length; ei++) {
        for (var i = 0; i < ENDPOINT_MAP.length; i++) {
          if (ENDPOINT_MAP[i].endpoint === endpoints[ei]) {
            stateKeys.push(ENDPOINT_MAP[i].stateKey);
            break;
          }
        }
      }
      var promises = stateKeys.map(function(sk) {
        var ep = null;
        for (var j = 0; j < ENDPOINT_MAP.length; j++) {
          if (ENDPOINT_MAP[j].stateKey === sk) { ep = ENDPOINT_MAP[j]; break; }
        }
        if (!ep) return Promise.resolve(null);
        delete _responseCache[sk];
        return dedupFetch(API + '/api/' + ep.endpoint)
          .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json().catch(function(e) { var wrap = new Error('JSON parse error for ' + ep.endpoint); wrap.cause = e; throw wrap; }); })
          .then(function(data) {
            if (ep.isArray && !Array.isArray(data)) data = [];
            if (ep.isObject && (data === null || typeof data !== 'object' || Array.isArray(data))) data = {};
            _responseCache[sk] = { data: data, ts: Date.now() };
            return { stateKey: sk, value: data };
          })
          .catch(function(e) { if (CONFIG.DEBUG) console.warn('[DataLayer] fetchMultiple error:', ep.endpoint, e); return null; });
      });
      Promise.allSettled(promises).then(function(results) {
        if (gen !== _fetchGeneration) return;
        var updates = {};
        results.forEach(function(r) {
          if (r.status === 'fulfilled' && r.value && r.value.value !== undefined) {
            updates[r.value.stateKey] = r.value.value;
          }
        });
        Store.batchUpdate(updates);
        if (callback) { try { callback(); } catch (e) { if (CONFIG.DEBUG) console.error('[DataLayer] callback error:', e); } }
      }).catch(function(e) { if (CONFIG.DEBUG) console.warn('[DataLayer] allSettled handler error:', e); });
    },

    stop: function() {
      if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
      if (_abortController) { try { _abortController.abort(); } catch (e) { if (CONFIG.DEBUG) console.warn('[DataLayer] abort error:', e); } _abortController = null; }
      _dataHashCache = {};
    }
  };

  var Components = {
    _sectionCounter: 0,
    statCard: function(icon, label, value, extra, colorClass, iconBg, iconColor) {
      var iconStyle = (iconBg ? 'background:' + escapeAttr(iconBg) + ';' : '') + (iconColor ? 'color:' + escapeAttr(iconColor) + ';' : '');
      return '<div class="stat-card ' + escapeAttr(colorClass) + '" role="status" aria-label="' + escapeAttr(label) + ': ' + escapeAttr(value) + '">' +
        '<div class="stat-icon" aria-hidden="true"' + (iconStyle ? ' style="' + iconStyle + '"' : '') + '>' + escapeHtml(icon) + '</div>' +
        '<div class="stat-value">' + escapeHtml(value) + '</div>' +
        '<div class="stat-label">' + escapeHtml(label) + '</div>' +
        '<div class="stat-extra">' + escapeHtml(extra) + '</div>' +
        '</div>';
    },

    metricRow: function(label, value, dotColor) {
      return '<div class="metric-row">' +
        (dotColor ? '<span class="metric-dot" style="color:' + escapeAttr(dotColor) + '"></span>' : '') +
        '<span class="metric-label">' + escapeHtml(label) + '</span>' +
        '<span class="metric-value"' + (dotColor ? ' style="color:' + escapeAttr(dotColor) + '"' : '') +
        '>' + escapeHtml(value) + '</span></div>';
    },

    metricBlock: function(label, value, color, size) {
      var sizeClass = size === 'sm' ? 'metric-value-sm' : 'metric-value-lg';
      return '<div class="metric-block">' +
        '<span class="metric-label">' + escapeHtml(label) + '</span>' +
        '<span class="metric-value ' + sizeClass + '" style="color:' + escapeAttr(color || 'var(--text)') + '">' + escapeHtml(value) + '</span></div>';
    },

    metricBlockSmall: function(label, value, color) {
      return Components.metricBlock(label, value, color, 'sm');
    },

    skillRow: function(name, detail) {
      return '<div class="phase-skill-row"><div class="phase-skill-name">' + escapeHtml(name) + '</div>' +
        (detail ? '<div class="phase-skill-detail">' + escapeHtml(detail) + '</div>' : '') + '</div>';
    },

    agentAvatar: function(agent, colorIndex, size) {
      if (!agent) return '<div class="agent-avatar" aria-hidden="true">?</div>';
      var c = AGENT_COLORS[colorIndex % AGENT_COLORS.length];
      var initials = escapeHtml(getInitials(agent.id || '?'));
      var cls = size === 'sm' ? 'phase-agent-avatar' : size === 'xs' ? 'wf-agent-dot' : 'agent-avatar';
      var extraAttrs = ' role="img" aria-label="' + escapeAttr(agent.role || 'Agent') + '"';
      if (size === 'xs') {
        extraAttrs += ' data-tooltip-title="' + escapeAttr(agent.role || 'Agent') + '" data-tooltip-sub="' + escapeAttr((agent.id || '?') + ' · ' + (agent.skillCount ?? 0) + ' 个技能') + '" style="background:' + escapeAttr(c.bg) + ';color:' + escapeAttr(c.fg) + ';border-color:' + escapeAttr(c.border) + '"';
      } else {
        extraAttrs += ' style="background:' + escapeAttr(c.bg) + ';color:' + escapeAttr(c.fg) + '"';
      }
      return '<div class="' + cls + '"' + extraAttrs + '>' + initials + '</div>';
    },

    metaItem: function(label, value, ariaLabel, isHighlight) {
      return '<div class="meta-item' + (isHighlight ? ' highlight' : '') + '" aria-label="' + escapeAttr(ariaLabel || label) + '"><span class="meta-label">' + escapeHtml(label) + '</span><span class="meta-value' + (isHighlight ? ' highlight' : '') + '">' + escapeHtml(value) + '</span></div>';
    },

    metaRow: function(dotColor, label, value) {
      return '<div class="meta-row"><span class="meta-dot" style="background:' + escapeAttr(dotColor || 'var(--primary)') + '"></span><span class="meta-label">' + escapeHtml(label) + '</span><span class="meta-value">' + escapeHtml(value) + '</span></div>';
    },

    emptyState: function(icon, text) {
      return '<div class="empty-state" role="status" aria-live="polite"><p>' + (icon ? '<span aria-hidden="true">' + escapeHtml(icon) + '</span> ' : '') + escapeHtml(text) + '</p></div>';
    },

    badge: function(text, cls) {
      return '<span class="badge ' + escapeAttr(cls || '') + '">' + escapeHtml(text) + '</span>';
    },

    metricsRow: function(blocks) {
      return '<div class="metrics-row">' + blocks.join('') + '</div>';
    },

    section: function(title, content, options) {
      var opts = options ?? {};
      var variant = opts.variant || 'default';
      var VALID_VARIANTS = ['default', 'collapsible', 'accent', 'bordered', 'hero'];
      var VALID_SPACING = ['compact', 'default', 'spacious'];
      var VALID_TITLE_SIZES = ['', 'sm', 'md', 'lg'];
      var VALID_BORDER_RADIUS = ['', 'sm', 'md', 'lg'];
      var VALID_ACCENT_COLORS = ['', 'primary', 'success', 'warning', 'danger', 'purple', 'cyan'];
      if (VALID_VARIANTS.indexOf(variant) === -1) variant = 'default';
      var spacing = VALID_SPACING.indexOf(opts.spacing) !== -1 ? opts.spacing : 'default';
      var titleSize = VALID_TITLE_SIZES.indexOf(opts.titleSize) !== -1 ? opts.titleSize : '';
      var borderRadius = VALID_BORDER_RADIUS.indexOf(opts.borderRadius) !== -1 ? opts.borderRadius : '';
      var accentColor = VALID_ACCENT_COLORS.indexOf(opts.accentColor) !== -1 ? opts.accentColor : '';
      var sectionId = opts.id || ('section-' + (++Components._sectionCounter));
      var icon = opts.icon || '';
      var badge = opts.badge || '';
      var description = opts.description || '';
      var footer = opts.footer || '';
      var defaultCollapsed = opts.defaultCollapsed ?? false;
      var loading = opts.loading ?? false;
      var isCollapsible = variant === 'collapsible' || opts.collapsible;
      var cls = 'ds-section ds-section--' + variant + ' ds-section--spacing-' + spacing;
      if (accentColor) cls += ' ds-section--accent-' + accentColor;
      if (isCollapsible) cls += ' ds-section--collapsible';
      if (defaultCollapsed) cls += ' ds-section--collapsed';
      if (titleSize) cls += ' ds-section--title-' + titleSize;
      if (borderRadius) cls += ' ds-section--radius-' + borderRadius;
      if (loading) cls += ' ds-section--loading';
      if (opts.className) cls += ' ' + opts.className;
      var headerCls = 'ds-section__header' + (isCollapsible ? ' ds-section__header--toggle' : '');
      var headerAttrs = '';
      if (isCollapsible) {
        headerAttrs = ' role="button" tabindex="0" aria-expanded="' + (!defaultCollapsed) + '" aria-controls="' + escapeAttr(sectionId) + '-body"';
      }
      var headerHtml = '<div class="' + headerCls + '"' + headerAttrs + '>' +
        (isCollapsible ? '<span class="ds-section__chevron" aria-hidden="true">&#9654;</span>' : '') +
        (icon ? '<span class="ds-section__icon" aria-hidden="true">' + escapeHtml(icon) + '</span>' : '') +
        '<span class="ds-section__title">' + escapeHtml(title) + '</span>' +
        (badge ? '<span class="ds-section__badge">' + escapeHtml(badge) + '</span>' : '') +
        '</div>';
      var descHtml = description ? '<div class="ds-section__description">' + escapeHtml(description) + '</div>' : '';
      var bodyContent = loading ? '<div class="ds-section__loading"><div class="ds-section__loading-bar"></div><div class="ds-section__loading-bar ds-section__loading-bar--short"></div></div>' : content;
      var bodyHtml = '<div class="ds-section__body" id="' + escapeAttr(sectionId) + '-body"' + (loading ? ' aria-busy="true"' : '') + '>' + bodyContent + '</div>';
      var footerHtml = footer ? '<div class="ds-section__footer">' + footer + '</div>' : '';
      var dataAttrs = ' data-variant="' + escapeAttr(variant) + '"' +
        ' data-spacing="' + escapeAttr(spacing) + '"';
      if (accentColor) dataAttrs += ' data-accent-color="' + escapeAttr(accentColor) + '"';
      if (isCollapsible) dataAttrs += ' data-collapsible="true"';
      return '<div class="' + cls + '" id="' + escapeAttr(sectionId) + '"' + dataAttrs + '>' + headerHtml + descHtml + bodyHtml + footerHtml + '</div>';
    },

    collapsibleSection: function(title, content, options) {
      var opts = options ?? {};
      opts.variant = 'collapsible';
      opts.collapsible = true;
      return Components.section(title, content, opts);
    },

    accentSection: function(title, content, options) {
      var opts = options ?? {};
      opts.variant = 'accent';
      return Components.section(title, content, opts);
    },

    borderedSection: function(title, content, options) {
      var opts = options ?? {};
      opts.variant = 'bordered';
      return Components.section(title, content, opts);
    },

    heroSection: function(title, content, options) {
      var opts = options ?? {};
      opts.variant = 'hero';
      return Components.section(title, content, opts);
    },

    moduleCard: function(name, desc, color, suffix) {
      return '<div class="arch-module-card">' +
        '<div class="arch-module-dot" style="background:' + escapeAttr(color) + '"></div>' +
        '<div class="arch-module-info"><div class="arch-module-name">' + escapeHtml(name) + (suffix ? sanitizeRawHtml(suffix) : '') + '</div>' +
        '<div class="arch-module-desc">' + escapeHtml(desc) + '</div></div></div>';
    },

    principleCard: function(icon, title, desc) {
      return '<div class="arch-principle-card">' +
        '<div class="arch-principle-icon">' + escapeHtml(icon) + '</div>' +
        '<div class="arch-principle-title">' + escapeHtml(title) + '</div>' +
        '<div class="arch-principle-desc">' + escapeHtml(desc) + '</div></div>';
    },

    archDetailModule: function(name, desc, color) {
      return '<div class="arch-detail-module">' +
        '<div class="arch-detail-header"><div class="arch-module-dot" style="background:' + escapeAttr(color) + '"></div>' +
        '<div class="arch-detail-name">' + escapeHtml(name) + '</div></div>' +
        '<div class="arch-detail-desc">' + escapeHtml(desc) + '</div></div>';
    },

    detailCard: function(item, type) {
      if (!item || typeof item !== 'object') return '';
      var title, badgeText, badgeCls, fields;
      if (type === 'deviation') {
        var statusBadge = item.status === 'approved' ? 'badge-green' : item.status === 'rejected' ? 'badge-red' : 'badge-yellow';
        var statusText = item.status === 'approved' ? '已批准' : item.status === 'rejected' ? '已拒绝' : '待审批';
        title = item.description || item.id || '—';
        badgeText = statusText;
        badgeCls = statusBadge;
        fields = [
          { label: '请求者', value: item.requester },
          { label: '规则', value: item.rule },
          item.severity ? { label: '严重程度', value: item.severity } : null,
          item.reason ? { label: '原因', value: item.reason } : null,
          item.approver ? { label: '审批人', value: item.approver } : null,
          item.createdAt ? { label: '创建时间', value: item.createdAt } : null,
          item.expiresAt ? { label: '过期时间', value: item.expiresAt } : null
        ].filter(Boolean);
      } else if (type === 'review') {
        var rStatusBadge = item.status === 'approved' ? 'badge-green' : item.status === 'in_progress' ? 'badge-blue' : 'badge-yellow';
        var rStatusText = item.status === 'approved' ? '已通过' : item.status === 'in_progress' ? '审查中' : '待审查';
        title = item.title || item.id || '—';
        badgeText = rStatusText;
        badgeCls = rStatusBadge;
        fields = [
          { label: '审查者', value: item.reviewer },
          { label: '文件', value: item.filePath },
          item.verdict ? { label: '结论', value: item.verdict } : null,
          item.createdAt ? { label: '创建时间', value: item.createdAt } : null
        ].filter(Boolean);
      } else {
        return '';
      }
      var fieldsHtml = fields.map(function(f) {
        return '<span class="detail-card-field"><span class="detail-card-label">' + escapeHtml(f.label) + '</span>' + escapeHtml(f.value ?? '—') + '</span>';
      }).join('');
      return '<div class="detail-card">' +
        '<div class="detail-card-header">' +
        '<div class="detail-card-title">' + escapeHtml(title) + '</div>' +
        Components.badge(badgeText, badgeCls) + '</div>' +
        '<div class="detail-card-meta">' + fieldsHtml + '</div></div>';
    },
    tableEmpty: function(colspan, text) {
      return '<tr><td colspan="' + colspan + '" class="table-empty">' + escapeHtml(text) + '</td></tr>';
    },

    progressBar: function(value, max, options) {
      var opts = options ?? {};
      var pct = max > 0 ? Math.min(100, Math.round(((Number.isFinite(value) ? value : 0) / max) * 100)) : 0;
      var colorClass = pct >= 90 ? 'progress-danger' : pct >= 70 ? 'progress-warning' : 'progress-ok';
      var showLabel = opts.showLabel !== false;
      var size = opts.size || 'md';
      var label = opts.label || '进度';
      return '<div class="progress-bar progress-bar--' + size + '" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100" aria-label="' + escapeAttr(label) + '">' +
        '<div class="progress-bar__track">' +
        '<div class="progress-bar__fill ' + colorClass + '" style="width:' + pct + '%"></div>' +
        '</div>' +
        (showLabel ? '<span class="progress-bar__label">' + pct + '%</span>' : '') +
        '</div>';
    },

    statusDot: function(status, label) {
      var colorMap = { healthy: 'var(--success)', degraded: 'var(--warning)', error: 'var(--danger)', active: 'var(--primary)', inactive: 'var(--text3)' };
      var color = colorMap[status] || 'var(--text3)';
      return '<span class="status-dot" style="background:' + escapeAttr(color) + '" data-tooltip-title="' + escapeAttr(label || status) + '"></span>';
    },

    tooltipText: function(text, tooltip) {
      return '<span data-tooltip-title="' + escapeAttr(tooltip) + '" class="tooltip-trigger">' + escapeHtml(text) + '</span>';
    },

    iconButton: function(icon, label, action, options) {
      var opts = options ?? {};
      var cls = 'icon-btn' + (opts.variant ? ' icon-btn--' + opts.variant : '') + (opts.disabled ? ' icon-btn--disabled' : '');
      var safeIcon = (opts.rawIcon === true) ? sanitizeRawHtml(icon) : escapeHtml(icon);
      return '<button class="' + cls + '" data-action="' + escapeAttr(action) + '"' +
        (opts.disabled ? ' disabled' : '') +
        ' aria-label="' + escapeAttr(label) + '">' + safeIcon + '</button>';
    },

    keyValueList: function(items, options) {
      var opts = options ?? {};
      var cls = 'kv-list' + (opts.compact ? ' kv-list--compact' : '');
      var rows = items.map(function(item) {
        return '<div class="kv-list__row">' +
          '<span class="kv-list__key">' + escapeHtml(item.key) + '</span>' +
          '<span class="kv-list__value">' + (item.raw ? sanitizeRawHtml(item.value) : escapeHtml(String(item.value ?? '—'))) + '</span>' +
          '</div>';
      }).join('');
      return '<div class="' + cls + '">' + rows + '</div>';
    },

    grid: function(items, columns) {
      var cols = columns ?? 2;
      return '<div class="responsive-grid responsive-grid--' + cols + '">' + items.join('') + '</div>';
    },

    modal: function(title, content, options) {
      var opts = options ?? {};
      UI._modalCounter = (UI._modalCounter ?? 0) + 1;
      var modalId = opts.id || ('modal-' + UI._modalCounter + '-' + Date.now().toString(36));
      var size = opts.size || 'md';
      var cls = 'modal-overlay modal-overlay--' + size;
      var safeContent = opts.rawHtml ? sanitizeRawHtml(content) : escapeHtml(content);
      return '<div class="' + cls + '" id="' + escapeAttr(modalId) + '" role="dialog" aria-modal="true" aria-label="' + escapeAttr(title) + '">' +
        '<div class="modal-backdrop" data-action="close-modal"></div>' +
        '<div class="modal-content">' +
        '<div class="modal-header">' +
        '<h3 class="modal-title">' + escapeHtml(title) + '</h3>' +
        '<button class="modal-close" data-action="close-modal" aria-label="关闭">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' + safeContent + '</div>' +
        (opts.footer ? '<div class="modal-footer">' + sanitizeRawHtml(opts.footer) + '</div>' : '') +
        '</div></div>';
    },

    skeletonLines: function(count) {
      var n = count ?? 3;
      var lines = '';
      for (var i = 0; i < n; i++) {
        lines += '<div class="skeleton skeleton-line"></div>';
      }
      return lines;
    },

    skeletonCard: function() {
      return '<div class="skeleton skeleton-card"></div>';
    },
    emptyState: function(icon, title, desc) {
      return '<div class="empty-state">' +
        (icon ? '<div class="empty-state-icon" aria-hidden="true">' + escapeHtml(icon) + '</div>' : '') +
        '<div class="empty-state-text">' + escapeHtml(title || '暂无数据') + '</div>' +
        (desc ? '<div class="empty-state-desc">' + escapeHtml(desc) + '</div>' : '') +
        '</div>';
    },
    statusBadge: function(text, status) {
      return '<span class="status-badge status-badge--' + escapeAttr(status || 'idle') + '">' +
        '<span class="status-badge-dot"></span>' + escapeHtml(text) +
        '</span>';
    },
    table: function(options) {
      var opts = options ?? {};
      var headers = opts.headers ?? [];
      var rows = opts.rows ?? [];
      var tableId = opts.id || '';
      var tableClass = opts.className || '';
      var ariaLabel = opts.ariaLabel || '';
      var mobileCard = opts.mobileCard !== false;
      var html = '<table';
      if (tableId) html += ' id="' + escapeAttr(tableId) + '"';
      html += ' class="data-table ' + escapeAttr(tableClass) + '"';
      if (ariaLabel) html += ' aria-label="' + escapeAttr(ariaLabel) + '"';
      html += '><thead><tr>';
      for (var h = 0; h < headers.length; h++) {
        var hdr = headers[h];
        if (typeof hdr === 'string') {
          html += '<th scope="col">' + escapeHtml(hdr) + '</th>';
        } else {
          html += '<th scope="col"' + (hdr.width ? ' style="width:' + escapeAttr(hdr.width) + '"' : '') + '>' + escapeHtml(hdr.text) + '</th>';
        }
      }
      html += '</tr></thead><tbody>';
      if (rows.length === 0) {
        html += '<tr><td colspan="' + headers.length + '" class="empty-cell">' + escapeHtml(opts.emptyText || '暂无数据') + '</td></tr>';
      } else {
        for (var r = 0; r < rows.length; r++) {
          html += '<tr>';
          var row = rows[r];
          for (var c = 0; c < row.length; c++) {
            var cell = row[c];
            var label = '';
            if (mobileCard && c < headers.length) {
              var hdrText = typeof headers[c] === 'string' ? headers[c] : headers[c].text;
              label = ' data-label="' + escapeAttr(hdrText) + '"';
            }
            html += '<td' + label + '><span class="td-value">' + (cell != null && typeof cell === 'object' ? escapeHtml(JSON.stringify(cell)) : escapeHtml(String(cell ?? ''))) + '</span></td>';
          }
          html += '</tr>';
        }
      }
      html += '</tbody></table>';
      return html;
    },
    pagination: function(options) {
      var opts = options ?? {};
      var current = opts.current ?? 1;
      var total = opts.total ?? 0;
      var pageSize = Math.max(1, opts.pageSize ?? 20);
      var onPageChange = opts.onPageChange || '';
      var totalPages = Math.ceil(total / pageSize);
      if (totalPages <= 1) return '';
      var windowSize = 2;
      var startP = Math.max(2, current - windowSize);
      var endP = Math.min(totalPages - 1, current + windowSize);
      var html = '<nav class="pagination" aria-label="分页导航">';
      html += '<button class="page-btn" data-page="' + (current - 1) + '"' + (current <= 1 ? ' disabled' : '') + ' aria-label="上一页">&lsaquo;</button>';
      html += '<button class="page-btn' + (current === 1 ? ' active' : '') + '" data-page="1"' + (current === 1 ? ' aria-current="page"' : '') + '>1</button>';
      if (startP > 2) html += '<span class="page-ellipsis" aria-hidden="true">&hellip;</span>';
      for (var p = startP; p <= endP; p++) {
        html += '<button class="page-btn' + (current === p ? ' active' : '') + '" data-page="' + p + '"' + (current === p ? ' aria-current="page"' : '') + '>' + p + '</button>';
      }
      if (endP < totalPages - 1) html += '<span class="page-ellipsis" aria-hidden="true">&hellip;</span>';
      if (totalPages > 1) {
        html += '<button class="page-btn' + (current === totalPages ? ' active' : '') + '" data-page="' + totalPages + '"' + (current === totalPages ? ' aria-current="page"' : '') + '>' + totalPages + '</button>';
      }
      html += '<button class="page-btn" data-page="' + (current + 1) + '"' + (current >= totalPages ? ' disabled' : '') + ' aria-label="下一页">&rsaquo;</button>';
      html += '<span class="page-info">共 ' + parseInt(total, 10) + ' 条</span>';
      html += '</nav>';
      return html;
    }
  };

  function h(tag, attrs, children) {
    var html = '<' + tag;
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          var val = attrs[key];
          if (val === true) { html += ' ' + key; }
          else if (val !== false && val != null) { html += ' ' + key + '="' + escapeAttr(String(val)) + '"'; }
        }
      }
    }
    if (children === undefined && typeof attrs === 'string') {
      html += '>' + escapeHtml(attrs) + '</' + tag + '>';
    } else if (Array.isArray(children)) {
      html += '>' + children.join('') + '</' + tag + '>';
    } else if (children != null) {
      html += '>' + escapeHtml(String(children)) + '</' + tag + '>';
    } else {
      html += '></' + tag + '>';
    }
    return html;
  }

  var VirtualList = (function() {
    var ITEM_HEIGHT = 40;
    var BUFFER = 5;

    function create(containerId, options) {
      var opts = options ?? {};
      var itemHeight = Math.max(1, opts.itemHeight || ITEM_HEIGHT);
      var buffer = opts.buffer || BUFFER;
      var renderFn = opts.renderItem;
      var container = document.getElementById(containerId);
      if (!container || !renderFn) return null;

      var _items = [];
      var _scrollTop = 0;
      var _viewportHeight = container.clientHeight ?? 400;

      function update(items) {
        _items = items ?? [];
        render();
      }

      function render() {
        var totalHeight = _items.length * itemHeight;
        var startIndex = Math.max(0, Math.floor(_scrollTop / itemHeight) - buffer);
        var endIndex = Math.min(_items.length, Math.ceil((_scrollTop + _viewportHeight) / itemHeight) + buffer);
        var visibleItems = [];
        for (var i = startIndex; i < endIndex; i++) {
          visibleItems.push(renderFn(_items[i], i));
        }
        var html = '<div style="height:' + totalHeight + 'px;position:relative">' +
          '<div style="transform:translateY(' + (startIndex * itemHeight) + 'px)">' +
          sanitizeRawHtml(visibleItems.join('')) +
          '</div></div>';
        container.innerHTML = html;
      }

      function handleScroll() {
        var newScrollTop = container.scrollTop;
        if (Math.abs(newScrollTop - _scrollTop) >= itemHeight) {
          _scrollTop = newScrollTop;
          scheduleRender('vlist-' + containerId, render);
        }
      }

      container.addEventListener('scroll', handleScroll, { passive: true });

      return {
        update: update,
        render: render,
        destroy: function() {
          container.removeEventListener('scroll', handleScroll);
          _items = [];
        }
      };
    }

    return { create: create };
  })();

  var AnimationUtils = {
    countUp: function(el, startVal, endVal, duration) {
      if (!el) return;
      if (el._animRafId) cancelAnimationFrame(el._animRafId);
      var dur = duration ?? 600;
      var startTime = null;
      var diff = endVal - startVal;
      function step(timestamp) {
        if (!startTime) startTime = timestamp;
        var progress = Math.min((timestamp - startTime) / dur, 1);
        var eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.floor(startVal + diff * eased);
        if (progress < 1) {
          el._animRafId = requestAnimationFrame(step);
        } else {
          delete el._animRafId;
        }
      }
      el._animRafId = requestAnimationFrame(step);
    },

    progressiveReveal: function(container, selector) {
      if (!container) return;
      container._revealTimers = [];
      var items = container.querySelectorAll(selector || '.progressive-reveal');
      for (var i = 0; i < items.length; i++) {
        (function(item, delay) {
          var tid = setTimeout(function() { item.classList.add('visible'); }, delay);
          container._revealTimers.push(tid);
        })(items[i], i * 50);
      }
    },

    cancelReveal: function(container) {
      if (!container || !container._revealTimers) return;
      for (var i = 0; i < container._revealTimers.length; i++) {
        clearTimeout(container._revealTimers[i]);
      }
      container._revealTimers = [];
    },

    observeReveal: function() {
      if (typeof IntersectionObserver === 'undefined') return;
      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.1 });
      var items = document.querySelectorAll('.progressive-reveal');
      for (var i = 0; i < items.length; i++) {
        observer.observe(items[i]);
      }
    }
  };

  var _modalPreviousFocus = null;
  var _modalFocusTrapHandler = null;

  var ErrorBoundary = {
    wrap: function(renderFn, containerId) {
      try {
        return renderFn();
      } catch (e) {
        if (CONFIG.DEBUG) console.error('ErrorBoundary [' + containerId + ']:', e);
        return '<div class="error-boundary" role="alert">' +
          '<div class="error-boundary-title">渲染异常</div>' +
          '<div class="error-boundary-msg">' + escapeHtml(_sanitizeLogMsg(e && e.message ? e.message : String(e)) || '未知错误') + '</div>' +
          '<button class="error-boundary-retry" data-action="reload-page">刷新页面</button>' +
          '</div>';
      }
    },
    wrapAsync: function(asyncFn, containerId) {
      return asyncFn().catch(function(e) {
        if (CONFIG.DEBUG) console.error('ErrorBoundary async [' + containerId + ']:', e);
        var el = $(containerId);
        if (el) {
          updateHTML(el, '<div class="error-boundary" role="alert">' +
            '<div class="error-boundary-title">加载失败</div>' +
            '<div class="error-boundary-msg">' + escapeHtml(_sanitizeLogMsg(e && e.message ? e.message : String(e)) || '网络异常') + '</div>' +
            '<button class="error-boundary-retry" data-retry="' + escapeAttr(containerId) + '">重试</button>' +
            '</div>');
        }
        return null;
      });
    }
  };

  var InteractionState = {
    setLoading: function(el, loading) {
      if (!el) return;
      if (loading) {
        el.classList.add('is-loading');
        el.setAttribute('aria-busy', 'true');
      } else {
        el.classList.remove('is-loading');
        el.removeAttribute('aria-busy');
      }
    },
    setError: function(el, error, msg) {
      if (!el) return;
      if (error) {
        el.classList.add('is-error');
        el.setAttribute('aria-invalid', 'true');
        if (msg) {
          var existing = el.querySelector('.is-error__msg');
          if (!existing) {
            var errEl = document.createElement('div');
            errEl.className = 'is-error__msg';
            errEl.innerHTML = '<span class="is-error__icon">⚠</span>' + escapeHtml(msg);
            el.appendChild(errEl);
          }
        }
      } else {
        el.classList.remove('is-error');
        el.removeAttribute('aria-invalid');
        var errEl2 = el.querySelector('.is-error__msg');
        if (errEl2) errEl2.remove();
      }
    },
    setSelected: function(el, selected) {
      if (!el) return;
      if (selected) {
        el.classList.add('is-selected');
        el.setAttribute('aria-selected', 'true');
      } else {
        el.classList.remove('is-selected');
        el.removeAttribute('aria-selected');
      }
    },
    setDisabled: function(el, disabled) {
      if (!el) return;
      if (disabled) {
        el.classList.add('is-disabled');
        el.setAttribute('aria-disabled', 'true');
      } else {
        el.classList.remove('is-disabled');
        el.removeAttribute('aria-disabled');
      }
    },
    setFocusRing: function(el, focused) {
      if (!el) return;
      if (focused) el.classList.add('is-focus-ring');
      else el.classList.remove('is-focus-ring');
    },
    togglePressed: function(el) {
      if (!el) return;
      el.classList.add('is-active-pressed');
      setTimeout(function() { el.classList.remove('is-active-pressed'); }, 150);
    },
    clearAll: function(el) {
      if (!el) return;
      el.classList.remove('is-loading', 'is-error', 'is-selected', 'is-disabled', 'is-focus-ring', 'is-active-pressed');
      el.removeAttribute('aria-busy');
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-selected');
      el.removeAttribute('aria-disabled');
      var errEl = el.querySelector('.is-error__msg');
      if (errEl) errEl.remove();
    }
  };

  function dedupFetch(url, options) {
    var key = url + '|' + (options && options.method || 'GET');
    if (_pendingRequests[key]) {
      return _pendingRequests[key].then(function(res) {
        try {
          if (res && typeof res.clone === 'function') return res.clone();
        } catch (e) { if (CONFIG.DEBUG) console.warn('Response.clone() failed:', e); }
        return res;
      }).catch(function(err) {
        delete _pendingRequests[key];
        throw err;
      });
    }
    var retryCount = 0;
    function attempt() {
      if (_pendingRequests[key]) return _pendingRequests[key];
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timeoutId = controller ? setTimeout(function() { try { controller.abort(); } catch(e) { if (CONFIG.DEBUG) console.warn('[Cache] abort timeout:', e); } delete _pendingRequests[key]; }, CACHE_MAX_AGE_MS) : null;
      var opts = _safeCopy({}, options);
      if (controller) {
        if (opts.signal) {
          var originalSignal = opts.signal;
          originalSignal.addEventListener('abort', function() { try { controller.abort(); } catch(e) { if (CONFIG.DEBUG) console.warn('[dedupFetch] signal abort forward:', e); } });
        }
        opts.signal = controller.signal;
      }
      if (CONFIG.API_TOKEN && !opts.headers) {
        opts.headers = { 'Authorization': 'Bearer ' + CONFIG.API_TOKEN };
      } else if (CONFIG.API_TOKEN && opts.headers && !opts.headers.Authorization) {
        opts.headers = _safeCopy({}, opts.headers, { 'Authorization': 'Bearer ' + CONFIG.API_TOKEN });
      }
      var promise = fetch(url, opts).then(function(res) {
        if (timeoutId) clearTimeout(timeoutId);
        delete _pendingRequests[key];
        if (_connectionDown) {
          _connectionDown = false;
          if (typeof showToast === 'function') showToast('服务器连接已恢复', '');
        }
        if (res.status === 401) {
          return new Response(JSON.stringify({ error: 'Authentication required', _authError: true }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        if (res.status === 429) {
          var retryAfter = parseInt(res.headers.get('Retry-After'), 10);
          if (!Number.isFinite(retryAfter) || retryAfter < 0) retryAfter = 5;
          return new Response(JSON.stringify({ error: 'Rate limited', _rateLimited: true, _retryAfter: retryAfter }), { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
        return res;
      }).catch(function(err) {
        if (timeoutId) clearTimeout(timeoutId);
        delete _pendingRequests[key];
        if (err.name === 'AbortError') {
          return new Response(JSON.stringify({ error: 'Request aborted', _aborted: true }), { status: 408, headers: { 'Content-Type': 'application/json' } });
        }
        var isNetworkError = err.name === 'TypeError' || err.name === 'NetworkError' ||
          (err.message && (err.message.indexOf('ERR_CONNECTION_REFUSED') >= 0 || err.message.indexOf('Failed to fetch') >= 0 || err.message.indexOf('ERR_NETWORK_CHANGED') >= 0));
        if (isNetworkError && retryCount < _MAX_FETCH_RETRIES) {
          retryCount++;
          var currentKey = key;
          var retryPromise = new Promise(function(resolve) {
            setTimeout(function() {
              if (_pendingRequests[currentKey] !== retryPromise) { resolve(null); return; }
              resolve(attempt());
            }, 1000 * retryCount);
          });
          _pendingRequests[key] = retryPromise;
          return retryPromise;
        }
        if (isNetworkError && !_connectionDown) {
          _connectionDown = true;
          if (typeof showToast === 'function') showToast('无法连接到服务器，将在恢复后自动重试', 'error');
          _scheduleConnectionRetry();
        }
        throw err;
      });
      _pendingRequests[key] = promise;
      var pendingKeys = Object.keys(_pendingRequests);
      if (pendingKeys.length > _MAX_PENDING_REQUESTS) {
        for (var pi = 0; pi < pendingKeys.length - _MAX_PENDING_REQUESTS; pi++) {
          delete _pendingRequests[pendingKeys[pi]];
        }
      }
      return promise;
    }
    return attempt();
  }

  function _scheduleConnectionRetry() {
    if (_connectionRetryTimer) return;
    if (_connectionRetryCount >= _CONNECTION_MAX_RETRIES) {
      if (typeof showToast === 'function') showToast('连接重试已达上限，请手动刷新页面', 'error');
      return;
    }
    var delay = Math.min(_CONNECTION_RETRY_INTERVAL * Math.pow(2, _connectionRetryCount), _CONNECTION_RETRY_MAX_INTERVAL);
    _connectionRetryCount++;
    _connectionRetryTimer = setTimeout(function() {
      _connectionRetryTimer = null;
      if (_connectionDown) {
        var connOpts = { method: 'GET' };
        if (CONFIG.API_TOKEN) connOpts.headers = { 'Authorization': 'Bearer ' + CONFIG.API_TOKEN };
        _fetchWithTimeout(API + '/api/version', connOpts).then(function(res) {
          if (res.ok) {
            _connectionDown = false;
            _connectionRetryCount = 0;
            showToast('服务器连接已恢复', '');
            DataLayer.fetchAll().catch(function(err) { if (CONFIG.DEBUG) console.warn('FetchAll recovery error:', err); });
          } else {
            _scheduleConnectionRetry();
          }
        }).catch(function() {
          if (_connectionRetryCount < _CONNECTION_MAX_RETRIES) {
            _scheduleConnectionRetry();
          }
        });
      }
    }, delay);
  }

  var EventDelegate = {
    _handlers: {},
    on: function(container, selector, eventType, handler) {
      var key = selector + '|' + eventType;
      if (this._handlers[key]) return;
      var wrappedHandler = function(e) {
        var target = e.target;
        var matched = target.closest ? target.closest(selector) : null;
        if (matched) {
          e.delegateTarget = matched;
          handler.call(matched, e);
        }
      };
      this._handlers[key] = { container: container, wrappedHandler: wrappedHandler, eventType: eventType };
      container.addEventListener(eventType, wrappedHandler, true);
    },
    off: function(selector, eventType) {
      var key = selector + '|' + eventType;
      var h = this._handlers[key];
      if (h) {
        h.container.removeEventListener(h.eventType, h.wrappedHandler, true);
        delete this._handlers[key];
      }
    }
  };

  var A11y = {
    announce: function(message, priority) {
      var el = document.getElementById('a11y-announcer');
      if (!el) {
        el = document.createElement('div');
        el.id = 'a11y-announcer';
        el.setAttribute('aria-live', priority || 'polite');
        el.setAttribute('aria-atomic', 'true');
        el.className = 'sr-only';
        document.body.appendChild(el);
      }
      el.textContent = '';
      setTimeout(function() { el.textContent = message; }, 50);
    },
    manageFocus: function(panelId) {
      var panel = $(panelId);
      if (!panel) return;
      var focusable = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length > 0) {
        focusable[0].focus();
      }
    },
    trapFocus: function(container) {
      if (!container) return null;
      var focusable = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return null;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      function handler(e) {
        if (e.key !== 'Tab') return;
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      container.addEventListener('keydown', handler);
      first.focus();
      return function() { container.removeEventListener('keydown', handler); };
    }
  };

  var FormatUtils = {
    number: function(val, decimals) {
      if (val == null || typeof val !== 'number' || Number.isNaN(val)) return '-';
      var d = decimals ?? 0;
      return Number(val).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    percent: function(val, decimals) {
      if (val == null || typeof val !== 'number' || Number.isNaN(val)) return '-';
      var d = decimals ?? 1;
      return Number(val).toFixed(d) + '%';
    },
    bytes: function(bytes) {
      if (bytes == null || isNaN(bytes)) return '-';
      var units = ['B', 'KB', 'MB', 'GB'];
      var i = 0;
      var val = Number(bytes);
      while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
      return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
    },
    duration: function(ms) {
      if (ms == null || typeof ms !== 'number' || Number.isNaN(ms)) return '-';
      var s = Number(ms);
      if (s < 1000) return s + 'ms';
      if (s < 60000) return (s / 1000).toFixed(1) + 's';
      if (s < 3600000) return Math.floor(s / 60000) + 'm ' + Math.floor((s % 60000) / 1000) + 's';
      return Math.floor(s / 3600000) + 'h ' + Math.floor((s % 3600000) / 60000) + 'm';
    },
    relativeTime: function(dateStr) {
      if (!dateStr) return '-';
      var now = Date.now();
      var then = new Date(dateStr).getTime(); if (!Number.isFinite(then)) return '-';
      var diff = now - then;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
      if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
      var d = new Date(dateStr);
      return Number.isFinite(d.getTime()) ? d.toLocaleDateString('zh-CN') : '-';
    },
    truncate: function(str, maxLen) {
      if (!str) return '';
      var len = maxLen ?? 50;
      if (str.length <= len) return str;
      return str.substring(0, len - 3) + '...';
    }
  };

  var LazyRenderer = {
    _queue: [],
    _running: false,
    _ricId: null,

    enqueue: function(id, renderFn, priority) {
      var existing = this._queue.find(function(q) { return q.id === id; });
      if (existing) {
        existing.renderFn = renderFn;
        existing.priority = priority ?? 0;
      } else {
        if (this._queue.length >= 100) {
          this._queue.shift();
        }
        this._queue.push({ id: id, renderFn: renderFn, priority: priority ?? 0 });
      }
      this._queue.sort(function(a, b) { return b.priority - a.priority; });
      this._scheduleNext();
    },

    _scheduleNext: function() {
      if (this._running || this._queue.length === 0) return;
      var self = this;
      var ric = window.requestIdleCallback || function(cb) { setTimeout(cb, 16); };
      this._ricId = ric(function(deadline) {
        self._running = true;
        while (self._queue.length > 0 && (deadline.didTimeout || deadline.timeRemaining() > 4)) {
          var task = self._queue.shift();
          try { task.renderFn(); } catch (e) { if (CONFIG.DEBUG) console.warn('LazyRenderer error:', e); }
        }
        self._running = false;
        if (self._queue.length > 0) self._scheduleNext();
      }, { timeout: 200 });
    },

    cancel: function(id) {
      this._queue = this._queue.filter(function(q) { return q.id !== id; });
    },

    clear: function() {
      this._queue = [];
      if (this._ricId && window.cancelIdleCallback) window.cancelIdleCallback(this._ricId);
      this._running = false;
    }
  };

  var OfflineDetector = {
    _online: true,
    _listeners: [],

    init: function() {
      this._online = navigator.onLine;
      var self = this;
      this._onlineHandler = function() {
        self._online = true;
        self._notify(true);
      };
      this._offlineHandler = function() {
        self._online = false;
        self._notify(false);
      };
      window.addEventListener('online', this._onlineHandler);
      window.addEventListener('offline', this._offlineHandler);
    },

    destroy: function() {
      if (this._onlineHandler) window.removeEventListener('online', this._onlineHandler);
      if (this._offlineHandler) window.removeEventListener('offline', this._offlineHandler);
      this._listeners.length = 0;
    },

    isOnline: function() { return this._online; },

    onChange: function(fn) {
      this._listeners.push(fn);
      var listeners = this._listeners;
      return function() {
        var idx = listeners.indexOf(fn);
        if (idx > -1) listeners.splice(idx, 1);
      };
    },

    _notify: function(isOnline) {
      for (var i = 0; i < this._listeners.length; i++) {
        try { this._listeners[i](isOnline); } catch (e) { if (CONFIG.DEBUG && typeof console !== 'undefined') console.warn('[Harness] connectivityListener error:', e); }
      }
      if (typeof A11y !== 'undefined') {
        A11y.announce(isOnline ? '网络已恢复' : '网络已断开', 'polite');
      }
    }
  };

  var ModalManager = {
    show: function(title, content, options) {
      var existing = document.querySelector('.modal-overlay');
      if (existing) existing.parentNode.removeChild(existing);
      _modalPreviousFocus = document.activeElement;
      var safeContent = (options && options.rawHtml) ? sanitizeRawHtml(content) : content;
      var wrapper = document.createElement('div');
      wrapper.innerHTML = Components.modal(title, safeContent, options);
      var modal = wrapper.firstChild;
      document.body.appendChild(modal);
      requestAnimationFrame(function() {
        modal.classList.add('modal-overlay--visible');
        var firstFocusable = modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (firstFocusable) firstFocusable.focus();
      });
      _modalFocusTrapHandler = function(e) {
        if (e.key !== 'Tab') return;
        var focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      modal.addEventListener('keydown', _modalFocusTrapHandler);
      return modal;
    },
    close: function() {
      var modal = document.querySelector('.modal-overlay');
      if (modal) {
        if (_modalFocusTrapHandler) {
          modal.removeEventListener('keydown', _modalFocusTrapHandler);
          _modalFocusTrapHandler = null;
        }
        modal.classList.remove('modal-overlay--visible');
        modal.classList.add('modal-overlay--exit');
        setTimeout(function() {
          if (modal.parentNode) modal.parentNode.removeChild(modal);
        }, 250);
      }
      if (_modalPreviousFocus) {
        try { _modalPreviousFocus.focus(); } catch (e) { if (CONFIG.DEBUG) console.warn('[Modal] focus restore error:', e); }
        _modalPreviousFocus = null;
      }
    }
  };

  function safeRender(fn) {
    try { fn(); } catch (e) {
      if (CONFIG.DEBUG) console.error('Render error:', e);
      var containerId = fn._containerId;
      if (containerId) {
        var el = $(containerId);
        if (el) {
          updateHTML(el, '<div class="error-boundary" role="alert">' +
            '<div class="error-boundary-title">渲染异常</div>' +
            '<div class="error-boundary-msg">' + escapeHtml(_sanitizeLogMsg(e && e.message ? e.message : String(e)) || '未知错误') + '</div>' +
            '<button class="error-boundary-retry" data-action="reload-page">刷新页面</button>' +
            '</div>');
        }
      }
    }
  }

  var _lazyObserver = null;
  var _lazyCallbacks = {};

  function initLazyObserver() {
    if (_lazyObserver) return;
    if (typeof IntersectionObserver === 'undefined') return;
    _lazyObserver = new IntersectionObserver(function(entries) {
      var observer = _lazyObserver;
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          var id = entry.target.id;
          var cb = _lazyCallbacks[id];
          if (cb) {
            cb();
            delete _lazyCallbacks[id];
          }
          if (observer) observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '100px' });
  }

  function observeLazy(id, callback) {
    var el = document.getElementById(id);
    if (!el) { callback(); return; }
    if (!_lazyObserver) { callback(); return; }
    _lazyCallbacks[id] = callback;
    _lazyObserver.observe(el);
  }

  var PanoramaEngine = (function() {
    var _canvas, _ctx, _animId, _initialized = false;
    var _nodes = [], _edges = [], _particles = [];
    var _hoveredNode = null, _dragNode = null, _dragOffset = { x: 0, y: 0 }, _keyboardFocusIdx = -1;
    var _selectedNode = null;
    var _viewMode = 'network';
    var _time = 0;
    var _pulsePhase = 0;
    var _camera = { x: 0, y: 0, zoom: 1 };
    var _isPanning = false, _panStart = { x: 0, y: 0 };
    var _pinchStartDist = 0, _pinchStartZoom = 0, _pinchCenter = null;
    var _nodeMap = {};
    var _resizeObserver = null;
    var _tokenFlowParticles = [];
    var _lastFrameTime = 0;
    var _frameCount = 0;
    var _fps = 60;
    var _needsRedraw = true;
    var _isMouseOver = false;
    var _edgeCacheCanvas = null;
    var _edgeCacheCtx = null;
    var _edgeCacheDirty = true;
    var _isPanelVisible = true;
    var _prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var _onMouseMove = null;
    var _onMouseDown = null;
    var _onMouseUp = null;
    var _onMouseLeave = null;
    var _onMouseEnter = null;
    var _onWheel = null;
    var _onResize = null;
    var _onTouchStart = null;
    var _onTouchMove = null;
    var _onTouchEnd = null;
    var _onKeyDown = null;
    var _ctrlBtnHandlers = [];

    var NODE_COLORS = {
      'core': '#818cf8', 'runtime': '#a78bfa', 'permission': '#f87171',
      'gate': '#fbbf24', 'agent': '#34d399', 'skill': '#22d3ee',
      'phase': '#c084fc', 'infra': '#fb923c', 'session': '#f472b6',
      'causal': '#60a5fa', 'deepening': '#c084fc', 'web': '#2dd4bf',
      'thought': '#f9a8d4', 'agentRuntime': '#6ee7b7', 'collaboration': '#fbbf24',
      'skillMgmt': '#22d3ee', 'reasoning': '#e879f9'
    };

    var NODE_DESCS = {
      'framework': '框架核心引擎，协调所有子系统运行',
      'SkillRouter': '技能自动发现、匹配与路由',
      'SessionManager': '会话生命周期与状态管理',
      'PhaseOrchestrator': '六阶段流程编排与转换控制',
      'EventBus': '事件总线，支持中间件和异步订阅',
      'MemoryStore': '项目知识存储与摘要管理',
      'AgentChannel': 'Agent间通信通道与共享KV',
      'WorkflowDAG': 'DAG工作流引擎，拓扑排序与环检测',
      'CheckpointManager': '检查点创建、恢复与持久化',
      'RetryEngine': '指数退避重试与三级升级策略',
      'ConcurrencyController': '并发信号量控制与排队',
      'AdversarialReview': '对抗审查，双审查者共识机制',
      'SkillImprover': '技能经验学习与自我改进',
      'PlatformCoordinator': '跨平台消息路由与广播',
      'WorkflowTemplate': '工作流模板创建与实例化',
      'PluginManager': '插件注册、Hook执行与生命周期',
      'HealthChecker': '健康检查注册与状态监控',
      'TokenManager': 'Token预算管理与三层计数',
      'DeepeningModuleRegistry': '深化模块注册与发现',
      'SkillReducer': '技能精简与去重',
      'CommandRouter': '斜杠命令路由与模糊匹配',
      'ProgrammableHookExecutor': '可编程钩子执行器',
      'ContextCompressionEngine': '上下文压缩引擎',
      'GoalExecutor': '目标执行器，自主迭代收敛',
      'PhaseContextInjector': '阶段上下文注入器',
      'HookHandlers': '内置Hook处理器与速率限制',
      'AutoregressiveContextSchema': '自回归上下文模式与版本兼容',
      'CausalDataBus': '因果数据总线，WAL持久化',
      'CausalBufferManager': '因果缓冲区管理与注意力衰减',
      'CausalMemoryStore': '因果记忆存储与检索',
      'CausalVectorIndex': '因果向量索引',
      'CausalConsistencyChecker': '因果一致性校验',
      'ConfigCausalValidator': '配置因果验证器',
      'DocFreshnessGuard': '文档新鲜度守卫',
      'SelfEvolutionGovernor': '自演化治理器',
      'SelfReflection': '自反思引擎',
      'SignalPersistence': '信号持久化',
      'PriorityQueue': '优先级队列',
      'HumanApprovalGate': '人工审批门禁',
      'AgentRuntime': 'Agent运行时环境',
      'AgentLifecycleController': 'Agent生命周期控制器',
      'AgentSandbox': 'Agent沙箱隔离',
      'AgentMonitor': 'Agent监控与指标采集',
      'AgentDeployment': 'Agent部署管理',
      'AgentStateManager': 'Agent状态管理',
      'AgentWorkflowIntegration': 'Agent工作流集成',
      'AgentPackManager': 'Agent包管理',
      'IsolatedContextManager': '隔离上下文管理器',
      'PlanPersistence': '计划持久化',
      'CollaborationModeRouter': '协作模式路由(solo/pair/chain/ensemble)',
      'StructuredIntent': '结构化意图解析',
      'SubagentExecutor': '子Agent执行器',
      'PairChat': '结对对话',
      'ChatChain': '链式对话',
      'SqliteStore': 'SQLite持久化存储',
      'SkillImprovementLoop': '技能改进循环',
      'MemoryNudge': '记忆提醒与关联',
      'SkillCreationEngine': '技能创建引擎',
      'SkillCurator': '技能策展与优化',
      'UserModelManager': '用户模型管理',
      'MCPClient': 'MCP协议客户端(stdio/HTTP)',
      'AutoVersionTracker': '自动版本追踪',
      'ThoughtExtractor': '思维提取器',
      'ThoughtDeduplicator': '思维去重器',
      'ThoughtMemoryStore': '思维记忆存储',
      'ThoughtRetrieverCycle': '思维检索循环',
      'EmbeddingService': '嵌入向量服务',
      'ModelSelector': '模型选择器',
      'DeepeningOrchestrator': '深化推理编排器',
      'DeepeningPipeline': '深化管道(21子模块)',
      'DeepeningHealthMonitor': '深化健康监控',
      'DeepeningCache': '深化缓存',
      'DeepeningCircuitBreaker': '深化熔断器',
      'DeepeningRateLimiter': '深化限流器',
      'DeepeningConnectionPool': '深化连接池',
      'DeepeningLoadBalancer': '深化负载均衡',
      'DeepeningServiceRegistry': '深化服务注册',
      'DeepeningFeatureFlags': '深化特性标志',
      'DeepeningGracefulShutdown': '深化优雅关停',
      'DeepeningStateManager': '深化状态管理',
      'DeepeningSnapshot': '深化快照',
      'DeepeningMetricsAggregator': '深化指标聚合',
      'DeepeningSecurityGuard': '深化安全守卫',
      'DeepeningConfigManager': '深化配置管理',
      'DeepeningDeployment': '深化部署管理',
      'DeepeningValidator': '深化验证器',
      'DeepeningTimeoutManager': '深化超时管理',
      'DeepeningRetryPolicy': '深化重试策略',
      'DeepeningNotifier': '深化通知器',
      'DeepeningBackpressureManager': '深化背压管理',
      'DeepeningBenchmark': '深化基准测试',
      'DeepeningReportGenerator': '深化报告生成',
      'DeepeningStrategyPlugin': '深化策略插件',
      'DeepeningTaskScheduler': '深化任务调度',
      'DeepeningPluginSystem': '深化插件系统',
      'DeepeningLockManager': '深化锁管理',
      'DeepeningThrottle': '深化节流',
      'DeepeningTaskQueue': '深化任务队列',
      'DeepeningPriorityQueue': '深化优先队列',
      'DeepeningResourceManager': '深化资源管理',
      'DeepeningDataPipeline': '深化数据管道',
      'DeepeningErrorHandler': '深化错误处理',
      'DeepeningEventBus': '深化事件总线',
      'DeepeningEventStore': '深化事件存储',
      'DeepeningEventReplay': '深化事件回放',
      'DeepeningDependencyResolver': '深化依赖解析',
      'DeepeningWorkflowTemplate': '深化工作流模板',
      'DeepeningAuditTrail': '深化审计追踪',
      'DeepeningStateMachine': '深化状态机',
      'DeepeningVisualizer': '深化可视化',
      'DeepeningSnapshotStore': '深化快照存储',
      'DeepeningMetricsCollector': '深化指标采集',
      'RecurrentDeepeningScheduler': '循环深化调度器',
      'AdaptiveDepthController': '自适应深度控制器',
      'LTIContextInjector': 'LTI上下文注入器',
      'MultiAgentRouter': '多Agent路由器',
      'OutputFusion': '输出融合器',
      'IterativeRefinement': '迭代精化器',
      'ProgressiveDeepening': '渐进深化器',
      'QualityScorer': '质量评分器',
      'TokenAwareDeepening': 'Token感知深化',
      'AffinityLearner': '亲和度学习器',
      'ConvergenceDetector': '收敛检测器',
      'SharedInfrastructure': '共享基础设施(连接池/负载均衡/服务注册/特性标志)',
      'RBACEnforcer': '基于角色的访问控制执行',
      'PermissionGuard': '文件操作守卫与路径遍历防护',
      'AuditLogger': '审计日志记录与过滤查询',
      'TDDGate': 'TDD强制门禁，RED-GREEN-REFACTOR检测',
      'EvidenceVerifier': '完成声明证据验证器',
      'FrameworkComplianceChecker': '框架合规6类规则检查',
      'DeviationApproval': '偏离审批管理，TTL过期机制',
      'CodeReviewFrameworkCheck': '代码审查8类检查项',
      'DesignSkillEngine': '设计技能引擎，反模式检测',
      'GeneratorVerifier': '生成器验证器，5维度评估',
      'SkillPatchApproval': '技能补丁审批',
      'DashboardServer': 'Web控制台服务器',
      'WebSocketHandler': 'WebSocket实时通信',
      'ChangelogArchive': '变更日志存档'
    };

    function _buildGraph(agents, skills, config) {
      var pMeta = Store.get('panoramaMetadata') ?? {};
      if (pMeta.nodeColors) { var _safeColors = {}; Object.keys(pMeta.nodeColors).forEach(function(k) { if (!_DANGEROUS_KEYS.has(k)) _safeColors[k] = pMeta.nodeColors[k]; }); _safeCopy(NODE_COLORS, _safeColors); }
      if (pMeta.nodeDescs) { var _safeDescs = {}; Object.keys(pMeta.nodeDescs).forEach(function(k) { if (!_DANGEROUS_KEYS.has(k)) _safeDescs[k] = pMeta.nodeDescs[k]; }); _safeCopy(NODE_DESCS, _safeDescs); }
      _nodes = [];
      _edges = [];
      _nodeMap = {};
      _adjacencyMap = {};
      var w = _canvas.width / (window.devicePixelRatio ?? 1);
      var h = _canvas.height / (window.devicePixelRatio ?? 1);
      var cx = w / 2, cy = h / 2;

      function addNode(node) {
        _nodes.push(node);
        _nodeMap[node.id] = node;
      }

      addNode({ id: 'framework', label: '框架核心', type: 'core', x: cx, y: cy, r: 34, pulse: 0, desc: NODE_DESCS['framework'] });

      var runtimeModules = pMeta.runtimeModules || ['SkillRouter', 'SessionManager', 'PhaseOrchestrator', 'EventBus', 'MemoryStore', 'AgentChannel', 'WorkflowDAG', 'CheckpointManager', 'RetryEngine', 'ConcurrencyController', 'AdversarialReview', 'SkillImprover', 'PlatformCoordinator', 'WorkflowTemplate', 'PluginManager', 'HealthChecker', 'TokenManager', 'DeepeningModuleRegistry', 'SkillReducer', 'CommandRouter', 'ProgrammableHookExecutor', 'ContextCompressionEngine', 'GoalExecutor', 'PhaseContextInjector', 'HookHandlers', 'AutoregressiveContextSchema'];
      var permModules = pMeta.permModules || ['RBACEnforcer', 'PermissionGuard', 'AuditLogger'];
      var gateModules = pMeta.gateModules || ['TDDGate', 'EvidenceVerifier', 'FrameworkComplianceChecker', 'DeviationApproval', 'CodeReviewFrameworkCheck', 'DesignSkillEngine', 'GeneratorVerifier', 'SkillPatchApproval'];
      var causalModules = pMeta.causalModules || ['CausalDataBus', 'CausalBufferManager', 'CausalMemoryStore', 'CausalVectorIndex', 'CausalConsistencyChecker', 'ConfigCausalValidator', 'DocFreshnessGuard', 'SelfEvolutionGovernor', 'SelfReflection', 'SignalPersistence', 'PriorityQueue', 'HumanApprovalGate'];
      var agentRuntimeModules = pMeta.agentRuntimeModules || ['AgentRuntime', 'AgentLifecycleController', 'AgentSandbox', 'AgentMonitor', 'AgentDeployment', 'AgentStateManager', 'AgentWorkflowIntegration', 'AgentPackManager', 'IsolatedContextManager'];
      var collaborationModules = pMeta.collaborationModules || ['PlanPersistence', 'CollaborationModeRouter', 'StructuredIntent', 'SubagentExecutor', 'PairChat', 'ChatChain', 'SqliteStore'];
      var skillModules = pMeta.skillModules || ['SkillImprovementLoop', 'MemoryNudge', 'SkillCreationEngine', 'SkillCurator', 'UserModelManager', 'MCPClient', 'AutoVersionTracker'];
      var thoughtModules = pMeta.thoughtModules || ['ThoughtExtractor', 'ThoughtDeduplicator', 'ThoughtMemoryStore', 'ThoughtRetrieverCycle', 'EmbeddingService', 'ModelSelector'];
      var deepeningModules = pMeta.deepeningModules || ['DeepeningOrchestrator', 'DeepeningPipeline', 'DeepeningHealthMonitor', 'DeepeningCache', 'DeepeningCircuitBreaker', 'DeepeningRateLimiter', 'DeepeningConnectionPool', 'DeepeningLoadBalancer', 'DeepeningServiceRegistry', 'DeepeningFeatureFlags', 'DeepeningGracefulShutdown', 'DeepeningStateManager', 'DeepeningSnapshot', 'DeepeningMetricsAggregator', 'DeepeningSecurityGuard', 'DeepeningConfigManager', 'DeepeningDeployment', 'DeepeningValidator', 'DeepeningTimeoutManager', 'DeepeningRetryPolicy', 'DeepeningNotifier', 'DeepeningBackpressureManager', 'DeepeningBenchmark', 'DeepeningReportGenerator', 'DeepeningStrategyPlugin', 'DeepeningTaskScheduler', 'DeepeningPluginSystem', 'DeepeningLockManager', 'DeepeningThrottle', 'DeepeningTaskQueue', 'DeepeningPriorityQueue', 'DeepeningResourceManager', 'DeepeningDataPipeline', 'DeepeningErrorHandler', 'DeepeningEventBus', 'DeepeningEventStore', 'DeepeningEventReplay', 'DeepeningDependencyResolver', 'DeepeningWorkflowTemplate', 'DeepeningAuditTrail', 'DeepeningStateMachine', 'DeepeningVisualizer', 'DeepeningSnapshotStore', 'DeepeningMetricsCollector'];
      var reasoningModules = pMeta.reasoningModules || ['RecurrentDeepeningScheduler', 'AdaptiveDepthController', 'LTIContextInjector', 'MultiAgentRouter', 'OutputFusion', 'IterativeRefinement', 'ProgressiveDeepening', 'QualityScorer', 'TokenAwareDeepening', 'AffinityLearner', 'ConvergenceDetector', 'SharedInfrastructure'];
      var webModules = pMeta.webModules || ['DashboardServer', 'WebSocketHandler', 'ChangelogArchive'];

      var groups = [
        { items: runtimeModules, type: 'runtime', label: '运行时引擎', baseAngle: -Math.PI / 2, radius: 130 },
        { items: permModules, type: 'permission', label: '权限引擎', baseAngle: Math.PI / 6, radius: 130 },
        { items: gateModules, type: 'gate', label: '门禁执行', baseAngle: 5 * Math.PI / 6, radius: 130 },
        { items: causalModules, type: 'causal', label: '因果架构', baseAngle: -Math.PI / 3, radius: 160 },
        { items: agentRuntimeModules, type: 'agentRuntime', label: 'Agent运行时', baseAngle: Math.PI / 3, radius: 160 },
        { items: collaborationModules, type: 'collaboration', label: '协作模式', baseAngle: 2 * Math.PI / 3, radius: 160 },
        { items: skillModules, type: 'skillMgmt', label: '技能管理', baseAngle: -2 * Math.PI / 3, radius: 160 },
        { items: thoughtModules, type: 'thought', label: '思维链', baseAngle: -Math.PI / 6, radius: 160 },
        { items: deepeningModules, type: 'deepening', label: '深化管道', baseAngle: Math.PI / 2 + 0.3, radius: 170 },
        { items: reasoningModules, type: 'reasoning', label: '推理与基础设施', baseAngle: Math.PI / 2 - 0.5, radius: 170 },
        { items: webModules, type: 'web', label: 'Web层', baseAngle: -Math.PI / 2 - 0.5, radius: 140 }
      ];

      groups.forEach(function(g) {
        if (!g.items || g.items.length === 0) return;
        var gAngle = g.baseAngle;
        var gx = cx + g.radius * 1.7 * Math.cos(gAngle);
        var gy = cy + g.radius * 1.7 * Math.sin(gAngle);
        addNode({ id: g.type + '-group', label: g.label, type: g.type, x: gx, y: gy, r: g.items.length > 20 ? 18 : 22, pulse: 0, desc: g.items.length + '个模块' });
        _edges.push({ from: 'framework', to: g.type + '-group', color: NODE_COLORS[g.type] || '#999', type: 'struct' });

        var maxShow = g.items.length > 20 ? 8 : g.items.length;
        var shownItems = g.items.slice(0, maxShow);
        shownItems.forEach(function(item, i) {
          var angle = gAngle + (i - shownItems.length / 2) * (g.items.length > 20 ? 0.25 : 0.32);
          var dist = g.radius * (g.items.length > 20 ? 2.2 : 2.9);
          var nx = gx + dist * Math.cos(angle) * 0.5;
          var ny = gy + dist * Math.sin(angle) * 0.5;
          nx = Math.max(60, Math.min(w - 60, nx));
          ny = Math.max(40, Math.min(h - 40, ny));
          addNode({ id: item, label: item, type: g.type, x: nx, y: ny, r: g.items.length > 20 ? 8 : 13, pulse: 0, desc: NODE_DESCS[item] || '' });
          _edges.push({ from: g.type + '-group', to: item, color: NODE_COLORS[g.type] || '#999', type: 'struct' });
        });
        if (g.items.length > maxShow) {
          var moreAngle = gAngle + (maxShow - shownItems.length / 2) * (g.items.length > 20 ? 0.25 : 0.32);
          var moreDist = g.radius * (g.items.length > 20 ? 2.2 : 2.9);
          var mx = gx + moreDist * Math.cos(moreAngle) * 0.5;
          var my = gy + moreDist * Math.sin(moreAngle) * 0.5;
          mx = Math.max(60, Math.min(w - 60, mx));
          my = Math.max(40, Math.min(h - 40, my));
          addNode({ id: g.type + '-more', label: '+' + (g.items.length - maxShow), type: g.type, x: mx, y: my, r: 10, pulse: 0, desc: '另有' + (g.items.length - maxShow) + '个模块: ' + g.items.slice(maxShow).join(', ') });
          _edges.push({ from: g.type + '-group', to: g.type + '-more', color: NODE_COLORS[g.type] || '#999', type: 'struct' });
        }
      });

      var agentAngle = Math.PI / 2;
      var agentCx = cx + 300 * Math.cos(agentAngle);
      var agentCy = cy + 300 * Math.sin(agentAngle);
      addNode({ id: 'agents-group', label: 'Agent 角色', type: 'agent', x: agentCx, y: agentCy, r: 24, pulse: 0, desc: '' });
      _edges.push({ from: 'framework', to: 'agents-group', color: NODE_COLORS.agent, type: 'struct' });

      (agents ?? []).forEach(function(ag, i) {
        var a = agentAngle + (i - (agents.length - 1) / 2) * 0.55;
        var nx = agentCx + 110 * Math.cos(a);
        var ny = agentCy + 110 * Math.sin(a);
        var skillCount = (ag.skills ?? []).length;
        addNode({ id: ag.id, label: ag.role || ag.id, type: 'agent', x: nx, y: ny, r: 18, pulse: 0, desc: '角色: ' + (ag.role || '') + ' | 技能数: ' + skillCount + ' | 执行级别: ' + (ag.enforcement || '—'), agentData: ag });
        _edges.push({ from: 'agents-group', to: ag.id, color: NODE_COLORS.agent, type: 'struct' });
      });

      var skillAngle = -Math.PI / 6;
      var skillCx = cx + 300 * Math.cos(skillAngle);
      var skillCy = cy + 300 * Math.sin(skillAngle);
      addNode({ id: 'skills-group', label: '技能体系', type: 'skill', x: skillCx, y: skillCy, r: 24, pulse: 0, desc: '' });
      _edges.push({ from: 'framework', to: 'skills-group', color: NODE_COLORS.skill, type: 'struct' });

      var skillPhases = {};
      (skills ?? []).forEach(function(sk) {
        var p = sk.phase ?? 0;
        if (!skillPhases[p]) skillPhases[p] = [];
        skillPhases[p].push(sk);
      });
      var phaseKeys = Object.keys(skillPhases).sort(function(a, b) { return +a - +b; });
      phaseKeys.forEach(function(pk) {
        var phaseSkills = skillPhases[pk];
        var pIdx = +pk;
        var subAngle = skillAngle + (pIdx - 2) * 0.35;
        phaseSkills.forEach(function(sk, si) {
          var a = subAngle + (si - (phaseSkills.length - 1) / 2) * 0.18;
          var dist = 90 + si * 12;
          var nx = skillCx + dist * Math.cos(a);
          var ny = skillCy + dist * Math.sin(a);
          nx = Math.max(40, Math.min(w - 40, nx));
          ny = Math.max(30, Math.min(h - 30, ny));
          var enforcementColor = sk.enforcement === 'strict' ? '#f87171' : sk.enforcement === 'recommended' ? '#fbbf24' : '#34d399';
          addNode({ id: 'skill-' + sk.id, label: sk.name || sk.id, type: 'skill', x: nx, y: ny, r: 8, pulse: 0, desc: '阶段: ' + (sk.phaseName || pk) + ' | 级别: ' + (sk.enforcement ?? '—') + ' | 优先级: ' + (sk.priority ?? '—'), skillData: sk, enforcementColor: enforcementColor });
          _edges.push({ from: 'skills-group', to: 'skill-' + sk.id, color: NODE_COLORS.skill, type: 'struct' });
        });
      });

      (agents ?? []).forEach(function(ag) {
        var agSkills = ag.skills ?? [];
        agSkills.forEach(function(skName) {
          var skillNode = _nodeMap['skill-' + skName];
          if (skillNode) {
            _edges.push({ from: ag.id, to: 'skill-' + skName, color: NODE_COLORS.agent + '60', type: 'agent-skill', dash: true });
          }
        });
      });

      var phaseAngle = -5 * Math.PI / 6;
      var phaseCx = cx + 300 * Math.cos(phaseAngle);
      var phaseCy = cy + 300 * Math.sin(phaseAngle);
      addNode({ id: 'phases-group', label: '六阶段流程', type: 'phase', x: phaseCx, y: phaseCy, r: 24, pulse: 0, desc: '' });
      _edges.push({ from: 'framework', to: 'phases-group', color: NODE_COLORS.phase, type: 'struct' });

      var phaseNames = ['需求探索', '需求分析', '架构设计', '模块开发', '集成测试', '部署上线'];
      phaseNames.forEach(function(pn, pi) {
        var pa = phaseAngle + (pi - 2.5) * 0.35;
        var dist = 80 + pi * 14;
        var nx = phaseCx + dist * Math.cos(pa);
        var ny = phaseCy + dist * Math.sin(pa);
        addNode({ id: 'phase-' + pi, label: pn, type: 'phase', x: nx, y: ny, r: 10, pulse: 0, desc: '第' + (pi + 1) + '阶段: ' + pn });
        _edges.push({ from: 'phases-group', to: 'phase-' + pi, color: NODE_COLORS.phase, type: 'struct' });
        if (pi > 0) {
          _edges.push({ from: 'phase-' + (pi - 1), to: 'phase-' + pi, color: NODE_COLORS.phase + '50', type: 'flow', dash: true });
        }
      });

      _spawnParticles();
      _spawnTokenFlow();
      _edgeCacheDirty = true;
      _rebuildAdjacency();
    }

    var _particlePool = [];
    var _tokenFlowPool = [];

    function _particleDefaults(edge) {
      var isFlow = edge.type === 'flow';
      return {
        t: Math.random(),
        speed: isFlow ? 0.003 + Math.random() * 0.003 : 0.002 + Math.random() * 0.004,
        size: isFlow ? 2 + Math.random() * 1.5 : 1.5 + Math.random() * 1.5,
        opacity: 0.3 + Math.random() * 0.5
      };
    }

    function _acquireParticle(edge) {
      var p = _particlePool.pop();
      var d = _particleDefaults(edge);
      if (p) {
        p.edge = edge;
        p.t = d.t;
        p.speed = d.speed;
        p.size = d.size;
        p.opacity = d.opacity;
        return p;
      }
      d.edge = edge;
      return d;
    }

    function _releaseParticle(p) {
      p.edge = null;
      if (_particlePool.length < 200) _particlePool.push(p);
    }

    function _spawnParticles() {
      _particles.forEach(function(p) { _releaseParticle(p); });
      _particles = [];
      _edges.forEach(function(edge) {
        if (edge.type === 'agent-skill') return;
        var count = edge.type === 'flow' ? 3 : 2;
        for (var i = 0; i < count; i++) {
          _particles.push(_acquireParticle(edge));
        }
      });
    }

    function _spawnTokenFlow() {
      _tokenFlowParticles = [];
      for (var i = 0; i < 8; i++) {
        _tokenFlowParticles.push({
          angle: Math.random() * Math.PI * 2,
          radius: 20 + Math.random() * 30,
          speed: 0.01 + Math.random() * 0.02,
          size: 2 + Math.random() * 2,
          opacity: 0.3 + Math.random() * 0.4
        });
      }
    }

    function _screenToWorld(sx, sy) {
      var zoom = _camera.zoom ?? 1;
      if (!Number.isFinite(zoom) || zoom <= 0) zoom = 1;
      return {
        x: (sx - (_camera.x ?? 0)) / zoom,
        y: (sy - (_camera.y ?? 0)) / zoom
      };
    }

    function _findNode(sx, sy) {
      var wp = _screenToWorld(sx, sy);
      for (var i = _nodes.length - 1; i >= 0; i--) {
        var n = _nodes[i];
        var dx = wp.x - n.x, dy = wp.y - n.y;
        if (dx * dx + dy * dy < n.r * n.r * 1.8) return n;
      }
      return null;
    }

    var _adjacencyMap = {};

    function _rebuildAdjacency() {
      _adjacencyMap = {};
      _edges.forEach(function(e) {
        if (!_adjacencyMap[e.from]) _adjacencyMap[e.from] = {};
        if (!_adjacencyMap[e.to]) _adjacencyMap[e.to] = {};
        _adjacencyMap[e.from][e.to] = true;
        _adjacencyMap[e.to][e.from] = true;
      });
    }

    function _isConnected(nodeId, targetId) {
      return _adjacencyMap[nodeId] && _adjacencyMap[nodeId][targetId];
    }

    function _draw(timestamp) {
      if (!_ctx || !_canvas) return;
      if (!_isPanelVisible) {
        _animId = null;
        _needsRedraw = true;
        return;
      }
      if (!timestamp) timestamp = performance.now();

      var deltaTime = timestamp - _lastFrameTime;
      if (deltaTime > 200) deltaTime = 16;
      _lastFrameTime = timestamp;

      _frameCount++;
      if (_frameCount % 30 === 0) {
        _fps = deltaTime > 0 ? Math.round(1000 / deltaTime) : 60;
      }

      var shouldAnimate = _prefersReducedMotion ? (_dragNode || _isPanning || _selectedNode) : (_isMouseOver || _dragNode || _isPanning || _selectedNode || _frameCount % 3 === 0);
      if (shouldAnimate) {
        _time += deltaTime * 0.001;
        _pulsePhase += deltaTime * 0.002;
      }

      var dpr = window.devicePixelRatio ?? 1;
      _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
      _ctx.save();
      _ctx.scale(dpr, dpr);

      var camZoom = _camera.zoom;
      if (!Number.isFinite(camZoom) || camZoom <= 0) camZoom = 1;
      var camX = Number.isFinite(_camera.x) ? _camera.x : 0;
      var camY = Number.isFinite(_camera.y) ? _camera.y : 0;

      _ctx.save();
      _ctx.translate(camX, camY);
      _ctx.scale(camZoom, camZoom);

      var hasSelection = _selectedNode !== null;

      _edges.forEach(function(e) {
        var from = _nodeMap[e.from];
        var to = _nodeMap[e.to];
        if (!from || !to) return;

        var isHighlighted = hasSelection && (_selectedNode.id === e.from || _selectedNode.id === e.to);
        var isDimmed = hasSelection && !isHighlighted;

        _ctx.beginPath();
        _ctx.moveTo(from.x, from.y);
        if (_viewMode === 'radial' && e.type !== 'flow') {
          var mx = (from.x + to.x) / 2;
          var my = (from.y + to.y) / 2;
          var dx = to.x - from.x, dy = to.y - from.y;
          _ctx.quadraticCurveTo(mx - dy * 0.15, my + dx * 0.15, to.x, to.y);
        } else {
          _ctx.lineTo(to.x, to.y);
        }

        if (e.dash) {
          _ctx.setLineDash([4, 4]);
        } else {
          _ctx.setLineDash([]);
        }

        _ctx.strokeStyle = isDimmed ? e.color + '10' : isHighlighted ? e.color + '90' : e.color + '30';
        _ctx.lineWidth = isHighlighted ? 2 : 1;
        _ctx.stroke();
        _ctx.setLineDash([]);
      });

      if (shouldAnimate) {
        _particles.forEach(function(p) {
          p.t += p.speed;
          if (p.t > 1) p.t -= 1;
          var from = _nodeMap[p.edge.from];
          var to = _nodeMap[p.edge.to];
          if (!from || !to) return;

          var isDimmed = hasSelection && !(_selectedNode.id === p.edge.from || _selectedNode.id === p.edge.to);
          if (isDimmed) return;

          var x = from.x + (to.x - from.x) * p.t;
          var y = from.y + (to.y - from.y) * p.t;
          _ctx.beginPath();
          _ctx.arc(x, y, p.size, 0, Math.PI * 2);
          _ctx.fillStyle = p.edge.color;
          _ctx.globalAlpha = p.opacity * (0.5 + 0.5 * Math.sin(_time * 3 + p.t * 10));
          _ctx.fill();

          _ctx.beginPath();
          _ctx.arc(x, y, p.size * 2.5, 0, Math.PI * 2);
          _ctx.fillStyle = p.edge.color;
          _ctx.globalAlpha = p.opacity * 0.15 * (0.5 + 0.5 * Math.sin(_time * 3 + p.t * 10));
          _ctx.fill();
          _ctx.globalAlpha = 1;
        });
      }

      if (_viewMode === 'flow' && shouldAnimate) {
        _nodes.forEach(function(n) {
          if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.r)) return;
          if (n.type === 'core' || n.id.indexOf('-group') >= 0) return;
          var pulseR = n.r + 8 + 6 * Math.sin(_pulsePhase + n.x * 0.01);
          if (!Number.isFinite(pulseR) || pulseR <= 0) return;
          _ctx.beginPath();
          _ctx.arc(n.x, n.y, pulseR, 0, Math.PI * 2);
          _ctx.strokeStyle = (NODE_COLORS[n.type] || '#818cf8') + '20';
          _ctx.lineWidth = 2;
          _ctx.stroke();
        });
      }

      var coreNode = _nodeMap['framework'];
      if (coreNode && Number.isFinite(coreNode.x) && Number.isFinite(coreNode.y) && shouldAnimate) {
        _tokenFlowParticles.forEach(function(p) {
          p.angle += p.speed;
          var x = coreNode.x + p.radius * Math.cos(p.angle);
          var y = coreNode.y + p.radius * Math.sin(p.angle);
          _ctx.beginPath();
          _ctx.arc(x, y, p.size, 0, Math.PI * 2);
          _ctx.fillStyle = '#818cf8';
          _ctx.globalAlpha = p.opacity * (0.5 + 0.5 * Math.sin(_time * 2 + p.angle));
          _ctx.fill();
          _ctx.globalAlpha = 1;
        });
      }

      var canvasW = _canvas.width / (window.devicePixelRatio ?? 1);
      var canvasH = _canvas.height / (window.devicePixelRatio ?? 1);

      _nodes.forEach(function(n) {
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.r)) return;
        var isHovered = _hoveredNode && _hoveredNode.id === n.id;
        var isSelected = _selectedNode && _selectedNode.id === n.id;
        var isConnectedToSelected = hasSelection && !isSelected && _isConnected(_selectedNode.id, n.id);
        var isDimmed = hasSelection && !isSelected && !isConnectedToSelected;

        var pulse = shouldAnimate ? (1 + 0.04 * Math.sin(_pulsePhase + n.x * 0.02 + n.y * 0.02)) : 1;
        var r = n.r * pulse;

        if (isDimmed) {
          _ctx.globalAlpha = 0.2;
        }

        if (isSelected) {
          _ctx.beginPath();
          _ctx.arc(n.x, n.y, r + 12, 0, Math.PI * 2);
          _ctx.fillStyle = (NODE_COLORS[n.type] || '#818cf8') + '18';
          _ctx.fill();
          _ctx.beginPath();
          _ctx.arc(n.x, n.y, r + 6, 0, Math.PI * 2);
          _ctx.strokeStyle = (NODE_COLORS[n.type] || '#818cf8') + '60';
          _ctx.lineWidth = 2;
          _ctx.setLineDash([3, 3]);
          _ctx.stroke();
          _ctx.setLineDash([]);
        }

        if (isHovered && !isSelected) {
          _ctx.beginPath();
          _ctx.arc(n.x, n.y, r + 8, 0, Math.PI * 2);
          _ctx.fillStyle = (NODE_COLORS[n.type] || '#818cf8') + '15';
          _ctx.fill();
        }

        var grad = _ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.3, 0, n.x, n.y, r);
        var baseColor = n.enforcementColor || NODE_COLORS[n.type] || '#818cf8';
        grad.addColorStop(0, baseColor + '70');
        grad.addColorStop(1, baseColor + '25');
        _ctx.beginPath();
        _ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        _ctx.fillStyle = grad;
        _ctx.fill();
        _ctx.strokeStyle = baseColor + (isSelected ? 'dd' : isHovered ? 'cc' : isConnectedToSelected ? 'aa' : '80');
        _ctx.lineWidth = isSelected ? 2.5 : isHovered ? 2 : 1;
        _ctx.stroke();

        if (n.r >= 10) {
          _ctx.fillStyle = isDimmed ? '#f1f5f980' : '#f1f5f9';
          _ctx.font = (n.r > 20 ? 'bold 11px' : n.r > 14 ? '10px' : '8px') + " -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
          _ctx.textAlign = 'center';
          _ctx.textBaseline = 'middle';
          var label = n.label.length > 10 ? n.label.slice(0, 9) + '…' : n.label;
          _ctx.fillText(label, n.x, n.y);
        }

        _ctx.globalAlpha = 1;
      });

      _ctx.restore();

      _ctx.fillStyle = '#64748b';
      _ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      _ctx.textAlign = 'left';
      _ctx.globalAlpha = 0.5;
      _ctx.fillText('缩放: ' + (Number.isFinite(_camera.zoom) ? (_camera.zoom * 100).toFixed(0) : '—') + '% | FPS: ' + _fps + ' | 拖拽节点移动 | 滚轮/双指缩放 | 点击选中', 12, 16);
      _ctx.globalAlpha = 1;

      _ctx.restore();
      _needsRedraw = false;
      if (_isPanelVisible) {
        if (document.hidden) {
          setTimeout(function() { _animId = requestAnimationFrame(_draw); }, 1000);
          return;
        }
        if (shouldAnimate) {
          _animId = requestAnimationFrame(_draw);
        } else {
          setTimeout(function() { _animId = requestAnimationFrame(_draw); }, 120);
        }
      }
    }

    function init(agents, skills, config) {
      _canvas = document.getElementById('panorama-canvas');
      if (!_canvas) return;
      _ctx = _canvas.getContext('2d');
      if (!_ctx) return;
      _resizeCanvas();
      _camera = { x: 0, y: 0, zoom: 1 };
      _lastFrameTime = performance.now();
      _buildGraph(agents, skills, config);
      _bindEvents();
      _initialized = true;
      PanoramaEngine._initialized = true;
      _animId = requestAnimationFrame(_draw);

      if (typeof ResizeObserver !== 'undefined') {
        var wrap = _canvas.parentElement;
        if (wrap) {
          var _roTimer = null;
          _resizeObserver = new ResizeObserver(function() {
            if (_roTimer) clearTimeout(_roTimer);
            _roTimer = setTimeout(function() {
              if (_canvas && _canvas.parentElement) {
                var ow = _canvas.width / (window.devicePixelRatio ?? 1);
                var oh = _canvas.height / (window.devicePixelRatio ?? 1);
                var nw = _canvas.parentElement.clientWidth;
                var nh = Math.max(480, Math.min(600, _canvas.parentElement.clientWidth * 0.55));
                if (Math.abs(ow - nw) > 2 || Math.abs(oh - nh) > 2) {
                  _resizeCanvas();
                  var ag = Store.get('agents') ?? [];
                  var sk = Store.get('skills') ?? [];
                  var cfg = Store.get('config') ?? {};
                  _buildGraph(ag, sk, cfg);
                }
              }
              _roTimer = null;
            }, 100);
          });
          _resizeObserver.observe(wrap);
        }
      }
    }

    function _resizeCanvas() {
      var wrap = _canvas.parentElement;
      if (!wrap) return;
      var dpr = window.devicePixelRatio ?? 1;
      var w = wrap.clientWidth;
      var h = Math.max(480, Math.min(600, wrap.clientWidth * 0.55));
      _canvas.width = w * dpr;
      _canvas.height = h * dpr;
      _canvas.style.width = w + 'px';
      _canvas.style.height = h + 'px';
    }

    var _detailFocusTrapCleanup = null;

    function _showDetailPanel(node) {
      var panel = document.getElementById('panorama-detail');
      if (!panel || !node) return;
      if (_detailFocusTrapCleanup) { _detailFocusTrapCleanup(); _detailFocusTrapCleanup = null; }
      var color = node.enforcementColor || NODE_COLORS[node.type] || '#818cf8';
      var safeColor = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#818cf8';
      var html = '<div class="pdetail-header">' +
        '<div class="pdetail-dot" style="background:' + safeColor + '"></div>' +
        '<div class="pdetail-title">' + escapeHtml(node.label) + '</div>' +
        '<button class="pdetail-close" id="pdetail-close" aria-label="关闭">&times;</button></div>' +
        '<div class="pdetail-type" style="color:' + safeColor + '">' + escapeHtml(node.type) + '</div>';

      if (node.desc) {
        html += '<div class="pdetail-desc">' + escapeHtml(node.desc) + '</div>';
      }

      if (node.agentData) {
        var ag = node.agentData;
        var agentContent = '';
        if (ag.skills && ag.skills.length) {
          agentContent += '<div class="pdetail-tags">' +
            ag.skills.map(function(s) { return '<span class="pdetail-tag">' + escapeHtml(s) + '</span>'; }).join('') + '</div>';
        }
        if (ag.enforcement) {
          agentContent += '<div class="pdetail-tags"><span class="pdetail-tag">' + escapeHtml(ag.enforcement) + '</span></div>';
        }
        html += Components.section('可用技能', agentContent, { icon: '⚡', badge: (ag.skills ? ag.skills.length : 0) + '', variant: 'accent', accentColor: 'primary', spacing: 'compact' });
      }

      if (node.skillData) {
        var sk = node.skillData;
        var skillContent = '<div class="pdetail-row"><span class="pdetail-row-label">执行级别</span><span class="pdetail-row-value">' + escapeHtml(sk.enforcement ?? '—') + '</span></div>';
        skillContent += '<div class="pdetail-row"><span class="pdetail-row-label">优先级</span><span class="pdetail-row-value">' + escapeHtml(sk.priority ?? '—') + '</span></div>';
        if (sk.dependsOn && sk.dependsOn.length) {
          skillContent += '<div class="pdetail-tags">' +
            sk.dependsOn.map(function(d) { return '<span class="pdetail-tag">' + escapeHtml(d) + '</span>'; }).join('') + '</div>';
        }
        html += Components.section('技能详情', skillContent, { icon: '🔧', badge: sk.priority ?? '', variant: 'bordered', spacing: 'compact' });
      }

      var connections = _edges.filter(function(e) { return e.from === node.id || e.to === node.id; });
      if (connections.length > 0) {
        var connContent = '';
        connections.slice(0, 8).forEach(function(c) {
          var otherId = c.from === node.id ? c.to : c.from;
          var otherNode = _nodeMap[otherId];
          if (otherNode) {
            connContent += '<div class="pdetail-conn">' + escapeHtml(otherNode.label) + '</div>';
          }
        });
        html += Components.section('关联连接', connContent, { icon: '🔗', badge: connections.length + '', variant: 'collapsible', spacing: 'compact' });
      }

      panel.innerHTML = html;
      panel.classList.add('active');
      _detailFocusTrapCleanup = A11y.trapFocus(panel);

      var closeBtn = document.getElementById('pdetail-close');
      if (closeBtn) {
        var newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
        newCloseBtn.addEventListener('click', function() {
          _selectedNode = null;
          panel.classList.remove('active');
          if (_detailFocusTrapCleanup) { _detailFocusTrapCleanup(); _detailFocusTrapCleanup = null; }
        });
      }
    }

    function _bindEvents() {
      _onMouseMove = function(e) {
        if (!_canvas) return;
        _isMouseOver = true;
        var rect = _canvas.getBoundingClientRect();
        var sx = e.clientX - rect.left;
        var sy = e.clientY - rect.top;

        if (_isPanning) {
          _camera.x += e.clientX - _panStart.x;
          _camera.y += e.clientY - _panStart.y;
          _panStart.x = e.clientX;
          _panStart.y = e.clientY;
          return;
        }

        if (_dragNode) {
          var wp = _screenToWorld(sx, sy);
          _dragNode.x = wp.x;
          _dragNode.y = wp.y;
          return;
        }

        var node = _findNode(sx, sy);
        _hoveredNode = node;
        _canvas.style.cursor = node ? 'pointer' : 'grab';
        var tooltip = document.getElementById('panorama-tooltip');
        if (tooltip) {
          if (node) {
            var desc = node.desc ? '<div class="ptt-desc">' + escapeHtml(String(node.desc).slice(0, 60)) + (String(node.desc).length > 60 ? '…' : '') + '</div>' : '';
            tooltip.innerHTML = '<div class="ptt-title">' + escapeHtml(node.label || '') + '</div><div class="ptt-type">' + escapeHtml(node.type || '') + '</div>' + desc;
            tooltip.setAttribute('role', 'tooltip');
            tooltip.style.left = Math.min(sx + 16, rect.width - 200) + 'px';
            tooltip.style.top = (sy - 8) + 'px';
            tooltip.style.opacity = '1';
            tooltip.style.transform = 'translateY(0)';
          } else {
            tooltip.style.opacity = '0';
            tooltip.style.transform = 'translateY(4px)';
          }
        }
      };

      _onMouseDown = function(e) {
        if (!_canvas) return;
        var rect = _canvas.getBoundingClientRect();
        var sx = e.clientX - rect.left;
        var sy = e.clientY - rect.top;
        var node = _findNode(sx, sy);
        if (node) {
          _dragNode = node;
          var wp = _screenToWorld(sx, sy);
          _dragOffset.x = wp.x - node.x;
          _dragOffset.y = wp.y - node.y;
          _canvas.style.cursor = 'grabbing';
        } else {
          _isPanning = true;
          _panStart.x = e.clientX;
          _panStart.y = e.clientY;
          _canvas.style.cursor = 'grabbing';
        }
      };

      _onMouseUp = function(e) {
        if (!_canvas) return;
        if (_dragNode && !_isPanning) {
          var rect = _canvas.getBoundingClientRect();
          var sx = e.clientX - rect.left;
          var sy = e.clientY - rect.top;
          var node = _findNode(sx, sy);
          if (node && node.id === _dragNode.id) {
            _selectedNode = _selectedNode && _selectedNode.id === node.id ? null : node;
            _showDetailPanel(_selectedNode);
          }
        }
        _dragNode = null;
        _isPanning = false;
        _canvas.style.cursor = 'grab';
      };

      _onMouseLeave = function() {
        _dragNode = null;
        _isPanning = false;
        _hoveredNode = null;
        _isMouseOver = false;
        var tooltip = document.getElementById('panorama-tooltip');
        if (tooltip) tooltip.style.opacity = '0';
      };

      _onMouseEnter = function() {
        _isMouseOver = true;
      };

      _onWheel = function(e) {
        if (!_canvas) return;
        e.preventDefault();
        var rect = _canvas.getBoundingClientRect();
        var sx = e.clientX - rect.left;
        var sy = e.clientY - rect.top;
        var delta = e.deltaY > 0 ? 0.9 : 1.1;
        var newZoom = Math.max(0.3, Math.min(3, _camera.zoom * delta));
        var factor = newZoom / _camera.zoom;
        _camera.x = sx - (sx - _camera.x) * factor;
        _camera.y = sy - (sy - _camera.y) * factor;
        _camera.zoom = newZoom;
      };

      _onTouchStart = function(e) {
        if (!_canvas) return;
        if (e.touches.length === 2) {
          _isPanning = false;
          _dragNode = null;
          var dx = e.touches[0].clientX - e.touches[1].clientX;
          var dy = e.touches[0].clientY - e.touches[1].clientY;
          _pinchStartDist = Math.sqrt(dx * dx + dy * dy);
          _pinchStartZoom = _camera.zoom;
          _pinchCenter = {
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2
          };
          var rect = _canvas.getBoundingClientRect();
          _pinchCenter.sx = _pinchCenter.x - rect.left;
          _pinchCenter.sy = _pinchCenter.y - rect.top;
        } else if (e.touches.length === 1) {
          var touch = e.touches[0];
          var rect = _canvas.getBoundingClientRect();
          var sx = touch.clientX - rect.left;
          var sy = touch.clientY - rect.top;
          var node = _findNode(sx, sy);
          if (node) {
            _dragNode = node;
            var wp = _screenToWorld(sx, sy);
            _dragOffset.x = wp.x - node.x;
            _dragOffset.y = wp.y - node.y;
          } else {
            _isPanning = true;
            _panStart.x = touch.clientX;
            _panStart.y = touch.clientY;
          }
        }
      };

      _onTouchMove = function(e) {
        e.preventDefault();
        if (e.touches.length === 2 && _pinchStartDist > 0) {
          var dx = e.touches[0].clientX - e.touches[1].clientX;
          var dy = e.touches[0].clientY - e.touches[1].clientY;
          var dist = Math.sqrt(dx * dx + dy * dy);
          var scale = dist / _pinchStartDist;
          var newZoom = Math.max(0.3, Math.min(3, _pinchStartZoom * scale));
          var factor = newZoom / _camera.zoom;
          _camera.x = _pinchCenter.sx - (_pinchCenter.sx - _camera.x) * factor;
          _camera.y = _pinchCenter.sy - (_pinchCenter.sy - _camera.y) * factor;
          _camera.zoom = newZoom;
        } else if (e.touches.length === 1) {
          var touch = e.touches[0];
          if (_isPanning) {
            _camera.x += touch.clientX - _panStart.x;
            _camera.y += touch.clientY - _panStart.y;
            _panStart.x = touch.clientX;
            _panStart.y = touch.clientY;
          } else if (_dragNode) {
            var rect = _canvas.getBoundingClientRect();
            var sx = touch.clientX - rect.left;
            var sy = touch.clientY - rect.top;
            var wp = _screenToWorld(sx, sy);
            _dragNode.x = wp.x;
            _dragNode.y = wp.y;
          }
        }
      };

      _onTouchEnd = function(e) {
        if (e.touches.length < 2) {
          _pinchStartDist = 0;
          _pinchStartZoom = 0;
          _pinchCenter = null;
        }
        if (e.touches.length === 0) {
          if (_dragNode && !_isPanning) {
            _selectedNode = _selectedNode && _selectedNode.id === _dragNode.id ? null : _dragNode;
            _showDetailPanel(_selectedNode);
          }
          _dragNode = null;
          _isPanning = false;
        }
      };

      _canvas.addEventListener('mousemove', _onMouseMove);
      _canvas.addEventListener('mousedown', _onMouseDown);
      _canvas.addEventListener('mouseup', _onMouseUp);
      _canvas.addEventListener('mouseleave', _onMouseLeave);
      _canvas.addEventListener('mouseenter', _onMouseEnter);
      _canvas.addEventListener('wheel', _onWheel, { passive: false });
      _canvas.addEventListener('touchstart', _onTouchStart, { passive: true });
      _canvas.addEventListener('touchmove', _onTouchMove, { passive: false });
      _canvas.addEventListener('touchend', _onTouchEnd, { passive: true });

      _canvas.setAttribute('tabindex', '0');
      _canvas.setAttribute('role', 'img');
      _canvas.setAttribute('aria-label', '全景架构图，使用方向键导航，+/-缩放');
      _onKeyDown = function(e) {
        if (!_canvas) return;
        var handled = true;
        switch (e.key) {
          case 'ArrowLeft': _camera.x += 40; break;
          case 'ArrowRight': _camera.x -= 40; break;
          case 'ArrowUp': _camera.y += 40; break;
          case 'ArrowDown': _camera.y -= 40; break;
          case '+': case '=':
            _camera.zoom = Math.min(3, _camera.zoom * 1.15);
            break;
          case '-': case '_':
            _camera.zoom = Math.max(0.3, _camera.zoom * 0.85);
            break;
          case 'Escape':
            _selectedNode = null;
            _showDetailPanel(null);
            break;
          case 'Tab':
            if (_nodes && _nodes.length > 0) {
              if (!e.shiftKey) {
                _keyboardFocusIdx = (_keyboardFocusIdx + 1) % _nodes.length;
              } else {
                _keyboardFocusIdx = (_keyboardFocusIdx - 1 + _nodes.length) % _nodes.length;
              }
              var kn = _nodes[_keyboardFocusIdx];
              _camera.x = _canvas.width / (2 * (window.devicePixelRatio ?? 1)) - kn.x * _camera.zoom;
              _camera.y = _canvas.height / (2 * (window.devicePixelRatio ?? 1)) - kn.y * _camera.zoom;
              _hoveredNode = kn;
              _canvas.setAttribute('aria-label', kn.label + ' (' + kn.type + ')');
            }
            break;
          case 'Enter': case ' ':
            if (_hoveredNode) {
              _selectedNode = _selectedNode && _selectedNode.id === _hoveredNode.id ? null : _hoveredNode;
              _showDetailPanel(_selectedNode);
            }
            break;
          default:
            handled = false;
        }
        if (handled) e.preventDefault();
      };
      _canvas.addEventListener('keydown', _onKeyDown);

      document.querySelectorAll('.panorama-ctrl-btn').forEach(function(btn) {
        var handler = function() {
          document.querySelectorAll('.panorama-ctrl-btn').forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
          btn.classList.add('active');
          btn.setAttribute('aria-pressed', 'true');
          _viewMode = btn.dataset.view || 'network';
        };
        btn.addEventListener('click', handler);
        _ctrlBtnHandlers.push({ btn: btn, handler: handler });
      });

      var _resizeTimer = null;
      _onResize = function() {
        if (_resizeTimer) clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(function() {
          if (_canvas) {
            _resizeCanvas();
            var agents = Store.get('agents') ?? [];
            var skills = Store.get('skills') ?? [];
            var config = Store.get('config') ?? {};
            _buildGraph(agents, skills, config);
          }
          _resizeTimer = null;
        }, 150);
      };
      window.addEventListener('resize', _onResize);
    }

    function update(agents, skills, config) {
      if (!_canvas) return;
      _nodes.forEach(function(n) {
        n.pulse = Math.random() * 0.1;
      });
      _restartIfNeeded();
    }

    function _restartIfNeeded() {
      if (!_initialized || !_canvas || !_ctx) return;
      if (!_animId && _isPanelVisible) {
        _lastFrameTime = performance.now();
        _animId = requestAnimationFrame(_draw);
      }
    }

    function destroy() {
      if (_animId) cancelAnimationFrame(_animId);
      _animId = null;
      _initialized = false;
      PanoramaEngine._initialized = false;
      if (_resizeObserver) {
        _resizeObserver.disconnect();
        _resizeObserver = null;
      }
      if (_onResize) {
        window.removeEventListener('resize', _onResize);
        _onResize = null;
      }
      if (_canvas) {
        if (_onMouseMove) _canvas.removeEventListener('mousemove', _onMouseMove);
        if (_onMouseDown) _canvas.removeEventListener('mousedown', _onMouseDown);
        if (_onMouseUp) _canvas.removeEventListener('mouseup', _onMouseUp);
        if (_onMouseLeave) _canvas.removeEventListener('mouseleave', _onMouseLeave);
        if (_onMouseEnter) _canvas.removeEventListener('mouseenter', _onMouseEnter);
        if (_onWheel) _canvas.removeEventListener('wheel', _onWheel);
        if (_onTouchStart) _canvas.removeEventListener('touchstart', _onTouchStart);
        if (_onTouchMove) _canvas.removeEventListener('touchmove', _onTouchMove);
        if (_onTouchEnd) _canvas.removeEventListener('touchend', _onTouchEnd);
        if (_onKeyDown) _canvas.removeEventListener('keydown', _onKeyDown);
      }
      _ctrlBtnHandlers.forEach(function(entry) {
        entry.btn.removeEventListener('click', entry.handler);
      });
      _ctrlBtnHandlers = [];
      _onMouseMove = null;
      _onMouseDown = null;
      _onMouseUp = null;
      _onMouseLeave = null;
      _onMouseEnter = null;
      _onWheel = null;
      _onTouchStart = null;
      _onTouchMove = null;
      _onTouchEnd = null;
      _onKeyDown = null;
      _nodes = [];
      _edges = [];
      _adjacencyMap = {};
      _particles = [];
      _tokenFlowParticles = [];
      _nodeMap = {};
      _particlePool = [];
      _hoveredNode = null;
      _dragNode = null;
      _selectedNode = null;
      _canvas = null;
      _ctx = null;
    }

    return { init: init, update: update, destroy: destroy, setVisibility: function(v) { _isPanelVisible = v; }, restartAnimation: function() { _restartIfNeeded(); }, _initialized: false };
  })();

  function _dpStatsRows(pairs) {
    return pairs.map(function(p) {
      return Components.metaRow(p[0], p[1], p[2] != null ? String(p[2]) : '—');
    }).join('');
  }

  function _renderDeepeningStatsPanel(elId, storeKey, cfg) {
    var el = $(elId);
    if (!el) return;
    var data = Store.get(storeKey) ?? {};
    var stats = data.stats ?? {};
    var listData = cfg.listKey ? (data[cfg.listKey] ?? {}) : {};
    var listNames = Object.keys(listData);
    if (cfg.isEmptyCheck(stats, data, listNames)) {
      el.innerHTML = Components.emptyState('', cfg.emptyText);
      return;
    }
    var mainRows = cfg.mainRows ? cfg.mainRows(data, stats, listData, listNames) : '';
    var statsPairs = cfg.statsPairs(stats, data);
    var statsRowHtml = _dpStatsRows(statsPairs);
    var mainSection = '';
    if (mainRows) {
      if (cfg.rawMainRows) {
        mainSection = mainRows;
      } else {
        mainSection = Components.section(cfg.mainTitle, mainRows, { icon: cfg.mainIcon, badge: typeof cfg.mainBadge === 'function' ? cfg.mainBadge(stats, data) : (cfg.mainBadge || ''), variant: cfg.mainVariant || 'accent', accentColor: cfg.accentColor, defaultCollapsed: cfg.defaultCollapsed });
      }
    }
    var statsSection = statsRowHtml ? Components.section(cfg.statsTitle, statsRowHtml, { icon: '📊', variant: 'collapsible', defaultCollapsed: true }) : '';
    el.innerHTML = mainSection + statsSection;
  }

  var DEEPENING_STATS_PANELS = [
    { elId: 'deepening-health-monitor-panel', storeKey: 'deepeningHealthMonitor',
      emptyText: '暂无健康监控数据',
      isEmptyCheck: function(s, d) { return Object.keys(d.results ?? {}).length === 0 && (d.history ?? []).length === 0; },
      mainTitle: '健康监控', mainIcon: '💓', accentColor: 'success', statsTitle: '健康统计',
      mainBadge: '—',
      mainRows: function(d, s) {
        var healthColorMap = { healthy: 'var(--success)', degraded: 'var(--warning)', error: 'var(--danger)', active: 'var(--primary)', inactive: 'var(--text3)' };
        return Object.keys(d.results ?? {}).map(function(key) {
          var r = d.results[key];
          return Components.metaRow(healthColorMap[r.status] || 'var(--text3)', key, (r.status || '—') + (r.elapsed ? ' (' + r.elapsed + 'ms)' : ''));
        }).join('');
      },
      statsPairs: function(s, d) { return []; }
    },
    { elId: 'deepening-dependencies-panel', storeKey: 'deepeningDependencies',
      emptyText: '暂无依赖关系数据',
      isEmptyCheck: function(s, d) { return (d.nodes ?? []).length === 0; },
      mainTitle: '依赖关系', mainIcon: '🔗', mainVariant: 'bordered', statsTitle: '依赖统计',
      mainBadge: '—',
      mainRows: function(d, s) {
        return (d.nodes ?? []).slice(0, 10).map(function(node) {
          var cnt = node.dependencies ? node.dependencies.length : 0;
          return Components.metaRow('var(--primary)', node.id, cnt > 0 ? cnt + '个依赖' : '无依赖');
        }).join('');
      },
      statsPairs: function(s, d) { return []; }
    },
    { elId: 'deepening-throttle-panel', storeKey: 'deepeningThrottle',
      emptyText: '暂无节流数据',
      isEmptyCheck: function(s) { return (s.keys ?? []).length === 0; },
      mainTitle: '节流状态', mainIcon: '🚦', accentColor: 'warning', statsTitle: '节流统计',
      mainBadge: '—',
      mainRows: function(d, s) {
        return (s.keys ?? []).map(function(k) {
          var c = k.throttled ? 'var(--danger)' : 'var(--success)';
          var pct = s.limit > 0 ? Math.round((k.count / s.limit) * 100) : 0;
          return Components.metaRow(c, k.key, k.count + '/' + s.limit + (k.throttled ? ' (节流中)' : '')) +
            Components.progressBar(k.count, s.limit, { showLabel: false, size: 'sm' });
        }).join('');
      },
      statsPairs: function(s) { return []; }
    },
    { elId: 'deepening-validator-panel', storeKey: 'deepeningValidator',
      emptyText: '暂无验证数据',
      isEmptyCheck: function(s) { return s.totalValidations === 0; },
      mainTitle: '验证统计', mainIcon: '✅', accentColor: 'primary', statsTitle: '验证详情',
      mainBadge: '—',
      mainRows: function(d, s) {
        return Components.metaRow('var(--primary)', '已注册模式', s.schemasRegistered) +
          Components.metaRow('var(--success)', '验证通过', s.validCount) +
          Components.metaRow('var(--danger)', '验证失败', s.invalidCount) +
          Components.metaRow('var(--cyan)', '通过率', s.validationRate);
      },
      statsPairs: function(s) { return []; }
    },
    { elId: 'deepening-convergence-panel', storeKey: 'deepeningMetrics',
      emptyText: '暂无收敛数据',
      isEmptyCheck: function(s, d) { var rc = d.dashboard ?? {}; return (rc.recentConvergence ?? []).length === 0; },
      mainTitle: '收敛检测', mainIcon: '🎯', mainVariant: 'collapsible', statsTitle: '收敛统计',
      mainBadge: function(s, d) { var rc = d.dashboard ?? {}; return (rc.recentConvergence ?? []).length + '次'; },
      mainRows: function(d, s) {
        var rc = d.dashboard ?? {};
        return (rc.recentConvergence ?? []).slice(-10).map(function(c) {
          var statusColor = c.value === 1 ? 'var(--success)' : 'var(--warning)';
          var statusText = c.value === 1 ? '已收敛' : '未收敛';
          var reason = c.tags && c.tags.reason ? c.tags.reason : '—';
          return Components.metaRow(statusColor, statusText, reason);
        }).join('');
      },
      statsPairs: function(s) { return []; }
    },
    { elId: 'deepening-modules-panel', storeKey: 'deepeningDashboard',
      emptyText: '暂无模块数据，启动深化执行后显示',
      isEmptyCheck: function(s, d) { return Object.keys(d.modules ?? {}).length === 0; },
      mainTitle: '活跃模块', mainIcon: '📦', mainVariant: 'bordered', statsTitle: '模块统计',
      mainBadge: function(s, d) { return Object.keys(d.modules ?? {}).length + '个'; },
      mainRows: function(d, s) {
        return Object.keys(d.modules ?? {}).map(function(name) {
          var m = d.modules[name];
          return Components.metaRow('var(--success)', name, JSON.stringify(m ?? {}).slice(0, 80));
        }).join('');
      },
      statsPairs: function(s) { return []; }
    },
    { elId: 'deepening-cache-panel', storeKey: 'deepeningCache',
      emptyText: '暂无缓存数据',
      isEmptyCheck: function(s) { return (s.size ?? 0) === 0 && (s.hits ?? 0) === 0; },
      mainTitle: '缓存状态', mainIcon: '💾', accentColor: 'cyan', statsTitle: '缓存统计',
      mainBadge: function(s) { return ((s.hitRate ?? 0) * 100).toFixed(0) + '%'; },
      mainRows: function(d, s) {
        return Components.metaRow('var(--primary)', '缓存大小', (s.size ?? 0) + ' / ' + (s.maxSize ?? 0)) +
          Components.metaRow('var(--success)', '命中次数', s.hits ?? 0) +
          Components.metaRow('var(--warning)', '未命中次数', s.misses ?? 0) +
          Components.metaRow('var(--danger)', '驱逐次数', s.evictions ?? 0);
      },
      statsPairs: function(s) { return []; }
    },
    { elId: 'deepening-report-panel', storeKey: 'deepeningReport',
      emptyText: '暂无深化报告，执行深化后自动生成',
      isEmptyCheck: function(s, d) { return (d.history ?? []).length === 0; },
      mainTitle: '深化报告', mainIcon: '📋', mainVariant: 'collapsible', defaultCollapsed: true, statsTitle: '报告统计',
      mainBadge: function(s, d) { return (d.history ?? []).length + '份'; },
      mainRows: function(d, s) {
        return (d.history ?? []).slice(-5).map(function(r) {
          return Components.metaRow('var(--cyan)', r.type || '—', r.generatedAt || '—');
        }).join('');
      },
      statsPairs: function(s) { return []; }
    },
    { elId: 'deepening-locks-panel', storeKey: 'deepeningLocks', listKey: 'locks',
      emptyText: '暂无锁数据，资源加锁后显示',
      isEmptyCheck: function(s, d, names) { var locks = d.locks ?? []; return locks.length === 0 && s.activeLocks === 0; },
      mainTitle: '活跃锁', mainIcon: '🔒', accentColor: 'danger', statsTitle: '锁统计',
      mainBadge: function(s) { return s.activeLocks + '个'; },
      mainRows: function(d, s, listData, names) {
        var locks = d.locks ?? [];
        return locks.slice(0, 10).map(function(lock) {
          var elapsedSec = ((lock.elapsed ?? 0) / 1000).toFixed(1);
          var timeoutSec = ((lock.timeout ?? 0) / 1000).toFixed(0);
          var refBadge = lock.refCount > 1 ? ' x' + lock.refCount : '';
          var nearExpiry = lock.timeout > 0 && lock.elapsed > lock.timeout * 0.8;
          var dotColor = nearExpiry ? 'var(--warning)' : 'var(--danger)';
          return Components.metaRow(dotColor, lock.resourceId, lock.ownerId + refBadge + ' · ' + elapsedSec + 's/' + timeoutSec + 's');
        }).join('');
      },
      statsPairs: function(s, d) {
        var expiredLocks = d.expiredLocks ?? [];
        return [['var(--danger)', '活跃锁', s.activeLocks], ['var(--primary)', '引用计数', s.totalRefCount], ['var(--cyan)', '最大锁数', s.maxLocks], ['var(--warning)', '过期锁', expiredLocks.length]];
      }
    },
    { elId: 'deepening-event-replay-panel', storeKey: 'deepeningEventReplay', listKey: 'eventTypes',
      emptyText: '暂无事件回放数据',
      isEmptyCheck: function(s, d) { var events = d.recentEvents ?? []; return s.totalEvents === 0 && events.length === 0; },
      rawMainRows: true,
      mainTitle: '最近事件', mainIcon: '🔄', accentColor: 'purple', statsTitle: '回放统计',
      mainBadge: function(s) { return s.totalEvents + '条'; },
      mainRows: function(d, s) {
        var events = d.recentEvents ?? [];
        var types = d.eventTypes ?? [];
        var typeCounts = s.typeCounts ?? {};
        var erRows = events.slice(-8).map(function(evt) {
          var ts = evt.timestamp && !isNaN(new Date(evt.timestamp).getTime()) ? new Date(evt.timestamp).toLocaleTimeString() : '—';
          return Components.metaRow('var(--purple)', evt.type, ts);
        }).join('');
        var typeRows = types.slice(0, 8).map(function(t) {
          var count = typeCounts[t] ?? 0;
          return Components.metaRow('var(--purple)', t, count + '条');
        }).join('');
        return Components.section('最近事件', erRows, { icon: '🔄', badge: s.totalEvents + '条', variant: 'accent', accentColor: 'purple' }) +
          (typeRows ? Components.section('事件类型分布', typeRows, { icon: '📊', variant: 'bordered' }) : '');
      },
      statsPairs: function(s) { return [['var(--purple)', '事件总数', s.totalEvents], ['var(--primary)', '事件类型', s.eventTypes], ['var(--cyan)', '最大容量', s.maxSize], ['var(--success)', '已注册过滤器', s.filtersRegistered], ['var(--warning)', '播放状态', s.playing ? '播放中' : '空闲']]; }
    },
    { elId: 'deepening-priority-queue-panel', storeKey: 'deepeningPriorityQueue', listKey: null,
      emptyText: '暂无队列数据，任务入队后显示',
      isEmptyCheck: function(s, d) { var completed = d.completed ?? []; return s.pending === 0 && s.running === 0 && completed.length === 0; },
      rawMainRows: true,
      mainTitle: '待处理队列', mainIcon: '📋', accentColor: 'primary', statsTitle: '队列统计',
      mainBadge: function(s) { return s.pending + '个'; },
      mainRows: function(d, s) {
        var priorityLabels = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'IDLE'];
        var priorityColors = ['var(--danger)', 'var(--warning)', 'var(--primary)', 'var(--cyan)', 'var(--surface3)'];
        var pendingByPriority = s.pendingByPriority ?? {};
        var pendingDisplay = Object.keys(pendingByPriority).filter(function(k) { return pendingByPriority[k] > 0; }).map(function(k) {
          var idx = parseInt(k, 10);
          if (!Number.isFinite(idx)) return '';
          return Components.metaRow(priorityColors[idx] || 'var(--primary)', priorityLabels[idx] || 'P' + k, pendingByPriority[k] + '个');
        }).join('');
        var completed = d.completed ?? [];
        var completedRows = completed.slice(-5).reverse().map(function(c) {
          return Components.metaRow('var(--success)', c.name, '等待' + (c.waitTime ?? 0) + 'ms · 执行' + (c.duration ?? 0) + 'ms');
        }).join('');
        return (pendingDisplay ? Components.section('待处理队列', pendingDisplay, { icon: '📋', badge: s.pending + '个', variant: 'accent', accentColor: 'primary' }) : '') +
          (completedRows ? Components.section('最近完成', completedRows, { icon: '✅', variant: 'bordered' }) : '');
      },
      statsPairs: function(s) { return [['var(--primary)', '待处理', s.pending], ['var(--warning)', '执行中', s.running], ['var(--success)', '已完成', s.completed], ['var(--cyan)', '并发数', s.concurrency], ['var(--purple)', '平均等待', s.avgWaitTime + 'ms']]; }
    },
    { elId: 'deepening-metrics-aggregator-panel', storeKey: 'deepeningMetricsAggregator', listKey: null,
      emptyText: '暂无指标数据，注册指标后显示',
      isEmptyCheck: function(s) { return s.registeredMetrics === 0; },
      mainTitle: '指标概览', mainIcon: '📈', accentColor: 'success', statsTitle: '聚合统计',
      mainBadge: function(s) { return s.registeredMetrics + '项'; },
      mainRows: function(d, s) {
        var dashboard = d.dashboard ?? {};
        var metrics = dashboard.metrics ?? {};
        var names = d.names ?? [];
        return names.slice(0, 10).map(function(n) {
          var m = metrics[n] ?? {};
          var val = m.value ?? '-';
          return Components.metaRow('var(--success)', n, val + (m.unit || ''));
        }).join('');
      },
      statsPairs: function(s) { return [['var(--success)', '已注册指标', s.registeredMetrics], ['var(--primary)', '总记录数', s.totalRecorded], ['var(--cyan)', '已刷新次数', s.totalFlushed], ['var(--warning)', '序列长度', s.maxSeriesLength]]; }
    },
    { elId: 'deepening-rate-limiter-panel', storeKey: 'deepeningRateLimiter', listKey: 'buckets',
      emptyText: '暂无限流桶数据，创建桶后显示',
      isEmptyCheck: function(s) { return s.totalBuckets === 0; },
      mainTitle: '令牌桶状态', mainIcon: '🪣', accentColor: 'warning', statsTitle: '限流统计',
      mainBadge: function(s) { return s.totalBuckets + '个'; },
      mainRows: function(d, s, listData, listNames) {
        return listNames.slice(0, 8).map(function(bName) {
          var b = listData[bName] ?? {};
          var tokenPct = (b.capacity > 0 && typeof b.tokens === 'number') ? Number(((b.tokens / b.capacity) * 100).toFixed(0)) : 0;
          var dotColor = tokenPct < 20 ? 'var(--danger)' : tokenPct < 50 ? 'var(--warning)' : 'var(--success)';
          return Components.metaRow(dotColor, bName, Math.floor(b.tokens) + '/' + b.capacity + ' · ' + b.rate + '/s');
        }).join('');
      },
      statsPairs: function(s) { return [['var(--success)', '已允许', s.totalAllowed], ['var(--danger)', '已拒绝', s.totalDenied], ['var(--cyan)', '桶数量', s.totalBuckets], ['var(--primary)', '默认速率', s.defaultRate + '/s']]; }
    },
    { elId: 'deepening-snapshot-store-panel', storeKey: 'deepeningSnapshotStore', listKey: null,
      emptyText: '暂无快照数据，捕获状态后显示',
      isEmptyCheck: function(s) { return s.totalSnapshots === 0; },
      mainTitle: '快照命名空间', mainIcon: '📸', accentColor: 'primary', statsTitle: '快照统计',
      mainBadge: function(s) { return s.totalSnapshots + '个'; },
      mainRows: function(d) {
        var names = d.names ?? [];
        return names.slice(0, 8).map(function(n) { return Components.metaRow('var(--primary)', n, ''); }).join('');
      },
      statsPairs: function(s) { var sizeKB = ((s.totalSizeBytes ?? 0) / 1024).toFixed(1); return [['var(--primary)', '快照总数', s.totalSnapshots], ['var(--success)', '已创建', s.totalCreated], ['var(--cyan)', '已恢复', s.totalRestored], ['var(--warning)', '总大小', sizeKB + 'KB'], ['var(--purple)', '命名空间', s.totalNames]]; }
    },
    { elId: 'deepening-backpressure-panel', storeKey: 'deepeningBackpressure', listKey: 'streams',
      emptyText: '暂无背压数据，注册流后显示',
      isEmptyCheck: function(s) { return s.totalStreams === 0; },
      mainTitle: '流压力状态', mainIcon: '📊', accentColor: 'warning', statsTitle: '背压统计',
      mainBadge: function(s) { return s.totalStreams + '个'; },
      mainRows: function(d, s, listData, listNames) {
        var pressureColors = { low: 'var(--success)', medium: 'var(--warning)', high: 'var(--danger)', critical: 'var(--danger)' };
        return listNames.slice(0, 8).map(function(sName) {
          var stream = listData[sName] ?? {};
          var dotColor = pressureColors[stream.level] || 'var(--primary)';
          var pausedBadge = stream.paused ? ' ⏸' : '';
          return Components.metaRow(dotColor, sName + pausedBadge, stream.bufferSize + '/' + stream.highWatermark + ' · ' + stream.level);
        }).join('');
      },
      statsPairs: function(s) { return [['var(--warning)', '暂停次数', s.totalPaused], ['var(--success)', '恢复次数', s.totalResumed], ['var(--danger)', '丢弃数', s.totalDropped]]; }
    },
    { elId: 'deepening-connection-pool-panel', storeKey: 'deepeningConnectionPool', listKey: 'pools',
      emptyText: '暂无连接池数据，创建池后显示',
      isEmptyCheck: function(s) { return s.totalPools === 0; },
      mainTitle: '连接池状态', mainIcon: '🔌', accentColor: 'success', statsTitle: '连接统计',
      mainBadge: function(s) { return s.totalPools + '个'; },
      mainRows: function(d, s, listData, listNames) {
        return listNames.slice(0, 8).map(function(pName) {
          var p = listData[pName] ?? {};
          var dotColor = p.utilization > 80 ? 'var(--danger)' : p.utilization > 50 ? 'var(--warning)' : 'var(--success)';
          return Components.metaRow(dotColor, pName, p.active + '/' + p.maxConnections + ' · ' + p.utilization + '%');
        }).join('');
      },
      statsPairs: function(s) { return [['var(--success)', '获取次数', s.totalAcquired], ['var(--primary)', '释放次数', s.totalReleased], ['var(--danger)', '错误数', s.totalErrors], ['var(--warning)', '超时回收', s.totalTimeouts]]; }
    },
    { elId: 'deepening-retry-policy-panel', storeKey: 'deepeningRetryPolicy', listKey: null,
      emptyText: '暂无重试策略，定义策略后显示',
      isEmptyCheck: function(s) { return s.totalPolicies === 0; },
      mainTitle: '重试策略', mainIcon: '🔄', accentColor: 'warning', statsTitle: '重试统计',
      mainBadge: function(s) { return s.totalPolicies + '个'; },
      mainRows: function(d, s) {
        var policyNames = d.policyNames ?? [];
        var policies = s.policies ?? {};
        return policyNames.slice(0, 8).map(function(pName) {
          var p = policies[pName] ?? {};
          return Components.metaRow('var(--warning)', pName, (p.backoffStrategy || '-') + ' · 最多' + (p.maxRetries ?? 0) + '次');
        }).join('');
      },
      statsPairs: function(s) { return [['var(--success)', '成功率', s.successRate + '%'], ['var(--primary)', '总调用', s.totalAttempts], ['var(--warning)', '总重试', s.totalRetries], ['var(--danger)', '总失败', s.totalFailures]]; }
    },
    { elId: 'deepening-service-registry-panel', storeKey: 'deepeningServiceRegistry', listKey: 'services',
      emptyText: '暂无服务注册数据',
      isEmptyCheck: function(s) { return s.totalServices === 0; },
      mainTitle: '服务列表', mainIcon: '🌐', accentColor: 'primary', statsTitle: '注册统计',
      mainBadge: function(s) { return s.totalServices + '个'; },
      mainRows: function(d, s, listData, listNames) {
        var stateColors = { healthy: 'var(--success)', degraded: 'var(--warning)', unhealthy: 'var(--danger)', starting: 'var(--cyan)', stopped: 'var(--surface3)' };
        return listNames.slice(0, 8).map(function(sName) {
          var svc = listData[sName] ?? {};
          var dotColor = stateColors[svc.state] || 'var(--primary)';
          return Components.metaRow(dotColor, sName, (svc.version || '') + ' · ' + (svc.state || ''));
        }).join('');
      },
      statsPairs: function(s) { var byState = s.byState ?? {}; return [['var(--success)', '健康', byState.healthy ?? 0], ['var(--warning)', '降级', byState.degraded ?? 0], ['var(--danger)', '不健康', byState.unhealthy ?? 0], ['var(--primary)', '已注册', s.totalRegistered]]; }
    },
    { elId: 'deepening-load-balancer-panel', storeKey: 'deepeningLoadBalancer', listKey: null,
      emptyText: '暂无负载均衡池数据',
      isEmptyCheck: function(s) { return s.totalPools === 0; },
      mainTitle: '均衡池', mainIcon: '⚖️', accentColor: 'success', statsTitle: '均衡统计',
      mainBadge: function(s) { return s.totalPools + '个'; },
      mainRows: function(d, s) {
        var poolNames = d.poolNames ?? [];
        var pools = s.pools ?? {};
        return poolNames.slice(0, 8).map(function(pName) {
          var p = pools[pName] ?? {};
          return Components.metaRow('var(--success)', pName, (p.strategy || '-') + ' · ' + (p.healthyInstances ?? 0) + '/' + (p.totalInstances ?? 0));
        }).join('');
      },
      statsPairs: function(s) { return [['var(--success)', '总选择', s.totalSelected], ['var(--danger)', '总失败', s.totalFailed]]; }
    },
    { elId: 'deepening-timeout-manager-panel', storeKey: 'deepeningTimeoutManager', listKey: null,
      emptyText: '暂无超时管理数据',
      isEmptyCheck: function(s) { return s.totalCreated === 0; },
      mainTitle: '活跃超时', mainIcon: '⏱️', accentColor: 'warning', statsTitle: '超时统计',
      mainBadge: function(s) { return s.active + '个'; },
      mainRows: function(d) {
        var active = d.active ?? [];
        return active.slice(0, 6).map(function(t) {
          var remainSec = ((t.remaining ?? 0) / 1000).toFixed(1);
          return Components.metaRow('var(--warning)', t.name, remainSec + 's');
        }).join('') || '无活跃超时';
      },
      statsPairs: function(s) { return [['var(--success)', '完成率', s.completionRate + '%'], ['var(--danger)', '超时率', s.expiryRate + '%'], ['var(--primary)', '活跃数', s.active], ['var(--cyan)', '已创建', s.totalCreated]]; }
    },
    { elId: 'deepening-graceful-shutdown-panel', storeKey: 'deepeningGracefulShutdown', listKey: null,
      emptyText: '暂无优雅关闭数据',
      isEmptyCheck: function(s) { return s.totalSteps === 0; },
      mainTitle: '关闭步骤', mainIcon: '🛑', accentColor: 'danger', statsTitle: '关闭进度',
      mainBadge: function(s) { return s.totalSteps + '步'; },
      mainRows: function(d) {
        var steps = d.steps ?? [];
        return steps.slice(0, 8).map(function(s) {
          var phaseColor = s.phase === 'drain' ? 'var(--warning)' : s.phase === 'stop' ? 'var(--danger)' : 'var(--success)';
          return Components.metaRow(phaseColor, s.name, s.phase);
        }).join('') || '无步骤';
      },
      statsPairs: function(s, d) { var p = d.progress ?? {}; return [['var(--success)', '已完成', p.completed + '/' + p.total], ['var(--danger)', '失败', p.failed], ['var(--warning)', '当前阶段', p.phase || '-'], ['var(--primary)', '关闭次数', s.totalShutdowns]]; }
    },
    { elId: 'deepening-feature-flags-panel', storeKey: 'deepeningFeatureFlags', listKey: null,
      emptyText: '暂无特性开关数据',
      isEmptyCheck: function(s) { return s.totalFlags === 0; },
      mainTitle: '特性开关', mainIcon: '🚩', accentColor: 'success', statsTitle: '评估统计',
      mainBadge: function(s) { return s.totalFlags + '个'; },
      mainRows: function(d, s) {
        var flagNames = d.flagNames ?? [];
        var flags = s.flags ?? {};
        return flagNames.slice(0, 8).map(function(fName) {
          var f = flags[fName] ?? {};
          var stateColor = f.state === 'on' ? 'var(--success)' : f.state === 'off' ? 'var(--danger)' : 'var(--warning)';
          return Components.metaRow(stateColor, fName, f.state + (f.percentage ? ' ' + f.percentage + '%' : ''));
        }).join('') || '无开关';
      },
      statsPairs: function(s) { return [['var(--success)', '开启次数', s.totalOn], ['var(--danger)', '关闭次数', s.totalOff], ['var(--primary)', '总评估', s.totalEvaluations]]; }
    },
    { elId: 'deepening-circuit-breaker-panel', storeKey: 'deepeningCircuitBreaker', listKey: null,
      emptyText: '暂无熔断器数据',
      isEmptyCheck: function(s) { return s.totalCircuits === 0; },
      mainTitle: '熔断器状态', mainIcon: '⚡', accentColor: 'danger', statsTitle: '熔断统计',
      mainBadge: function(s) { return s.totalCircuits + '个'; },
      mainRows: function(d, s) {
        var circuits = s.circuits ?? {};
        var names = Object.keys(circuits);
        return names.slice(0, 8).map(function(cName) {
          var c = circuits[cName] ?? {};
          var stateColor = c.state === 'closed' ? 'var(--success)' : c.state === 'open' ? 'var(--danger)' : 'var(--warning)';
          return Components.metaRow(stateColor, cName, c.state + ' · ' + (c.failureCount ?? 0) + '次失败');
        }).join('') || '无熔断器';
      },
      statsPairs: function(s) { return [['var(--danger)', '总熔断', s.totalTripped], ['var(--primary)', '熔断器数', s.totalCircuits]]; }
    },
    { elId: 'deepening-task-scheduler-panel', storeKey: 'deepeningTaskScheduler', listKey: null,
      emptyText: '暂无任务调度数据',
      isEmptyCheck: function(s) { return s.totalTasks === 0; },
      rawMainRows: true,
      mainTitle: '任务调度', mainIcon: '📋', accentColor: 'warning', statsTitle: '调度统计',
      mainBadge: function(s, d) { var pending = d.pending ?? []; return pending.length + '个'; },
      mainRows: function(d) {
        var pending = d.pending ?? [];
        var running = d.running ?? [];
        var pendingRows = pending.slice(0, 6).map(function(t) { return Components.metaRow('var(--warning)', t.name, '待执行'); }).join('');
        var runningRows = running.slice(0, 4).map(function(t) { return Components.metaRow('var(--success)', t.name, '执行中'); }).join('');
        return (pendingRows ? Components.section('待执行任务', pendingRows, { icon: '📋', variant: 'accent', accentColor: 'warning' }) : '') +
          (runningRows ? Components.section('执行中', runningRows, { icon: '⏳', variant: 'accent', accentColor: 'success' }) : '');
      },
      statsPairs: function(s) { return [['var(--success)', '已完成', s.totalCompleted], ['var(--danger)', '已失败', s.totalFailed], ['var(--primary)', '总调度', s.totalScheduled]]; }
    },
    { elId: 'deepening-data-pipeline-panel', storeKey: 'deepeningDataPipeline', listKey: 'pipelines',
      emptyText: '暂无数据管道数据',
      isEmptyCheck: function(s) { return s.totalPipelines === 0; },
      mainTitle: '管道列表', mainIcon: '🔗', accentColor: 'primary', statsTitle: '处理统计',
      mainBadge: function(s) { return s.totalPipelines + '个'; },
      mainRows: function(d, s, listData, listNames) {
        return listNames.slice(0, 8).map(function(pName) {
          var p = listData[pName] ?? {};
          return Components.metaRow('var(--primary)', pName, (p.stageCount ?? 0) + '阶段 · ' + (p.totalProcessed ?? 0) + '次');
        }).join('') || '无管道';
      },
      statsPairs: function(s) { return [['var(--success)', '成功', s.totalSucceeded], ['var(--danger)', '失败', s.totalFailed], ['var(--primary)', '总处理', s.totalProcessed]]; }
    },
    { elId: 'deepening-state-manager-panel', storeKey: 'deepeningStateManager', listKey: 'machines',
      emptyText: '暂无状态机数据',
      isEmptyCheck: function(s) { return s.totalMachines === 0; },
      mainTitle: '状态机', mainIcon: '🔄', accentColor: 'purple', statsTitle: '转换统计',
      mainBadge: function(s) { return s.totalMachines + '个'; },
      mainRows: function(d, s, listData, listNames) {
        return listNames.slice(0, 8).map(function(mName) {
          var m = listData[mName] ?? {};
          var stateColor = m.isFinal ? 'var(--danger)' : 'var(--success)';
          return Components.metaRow(stateColor, mName, m.currentState || '-');
        }).join('') || '无状态机';
      },
      statsPairs: function(s) { return [['var(--primary)', '总转换', s.totalTransitions], ['var(--warning)', '拒绝次数', s.totalGuardsDenied]]; }
    },
    { elId: 'deepening-event-bus-panel', storeKey: 'deepeningEventBus', listKey: null,
      emptyText: '暂无事件总线数据',
      isEmptyCheck: function(s) { return s.totalTopics === 0; },
      mainTitle: '主题列表', mainIcon: '📡', accentColor: 'primary', statsTitle: '投递统计',
      mainBadge: function(s) { return s.totalTopics + '个'; },
      mainRows: function(d, s) {
        var topics = Array.isArray(d.topics) ? d.topics : [];
        return topics.slice(0, 8).map(function(t) {
          var count = (s.topics && s.topics[t]) ?? 0;
          return Components.metaRow('var(--primary)', t, count + '订阅');
        }).join('') || '无主题';
      },
      statsPairs: function(s) { return [['var(--success)', '已发布', s.totalPublished], ['var(--primary)', '已投递', s.totalDelivered], ['var(--danger)', '死信', s.totalDead]]; }
    },
    { elId: 'deepening-config-manager-panel', storeKey: 'deepeningConfigManager', listKey: 'configs',
      emptyText: '暂无配置管理数据',
      isEmptyCheck: function(s) { return s.totalConfigs === 0; },
      mainTitle: '配置项', mainIcon: '⚙️', accentColor: 'warning', statsTitle: '变更统计',
      mainBadge: function(s) { return s.totalConfigs + '个'; },
      mainRows: function(d, s, listData, listNames) {
        return listNames.slice(0, 8).map(function(cKey) {
          var c = listData[cKey] ?? {};
          var mutColor = c.mutable ? 'var(--success)' : 'var(--danger)';
          return Components.metaRow(mutColor, cKey, String(c.value ?? '-'));
        }).join('') || '无配置';
      },
      statsPairs: function(s) { return [['var(--warning)', '变更次数', s.totalChanges], ['var(--primary)', '环境覆盖', s.overrideCount]]; }
    },
    { elId: 'deepening-resource-manager-panel', storeKey: 'deepeningResourceManager', listKey: 'pools',
      emptyText: '暂无资源管理数据',
      isEmptyCheck: function(s) { return s.totalPools === 0; },
      mainTitle: '资源池', mainIcon: '📦', accentColor: 'success', statsTitle: '使用统计',
      mainBadge: function(s) { return s.totalPools + '个'; },
      mainRows: function(d, s, listData, listNames) {
        return listNames.slice(0, 8).map(function(pName) {
          var p = listData[pName] ?? {};
          return Components.metaRow('var(--success)', pName, (p.inUse ?? 0) + '/' + (p.maxSize ?? 0) + '使用');
        }).join('') || '无资源池';
      },
      statsPairs: function(s) { return [['var(--success)', '已获取', s.totalAcquired], ['var(--primary)', '已释放', s.totalReleased], ['var(--danger)', '超时', s.totalTimeouts]]; }
    },
    { elId: 'deepening-audit-trail-panel', storeKey: 'deepeningAuditTrail', listKey: null,
      emptyText: '暂无审计追踪数据',
      isEmptyCheck: function(s) { return s.totalEntries === 0; },
      mainTitle: '最近记录', mainIcon: '📝', accentColor: 'danger', statsTitle: '审计统计',
      mainBadge: function(s) { return s.totalEntries + '条'; },
      mainRows: function(d) {
        var entries = d.recentEntries ?? [];
        return entries.slice(0, 8).map(function(e) {
          var sevColor = e.severity === 'critical' ? 'var(--danger)' : e.severity === 'error' ? 'var(--warning)' : (e.severity === 'warning' || e.severity === 'warn') ? 'var(--warning)' : 'var(--success)';
          return Components.metaRow(sevColor, e.action, e.actor);
        }).join('') || '无记录';
      },
      statsPairs: function(s, d) { var byResult = s.byResult ?? {}; var severityCounts = d.severityCounts ?? {}; return [['var(--success)', '成功', byResult.success ?? 0], ['var(--danger)', '失败', byResult.failure ?? 0], ['var(--warning)', '严重', severityCounts.critical ?? 0]]; }
    },
    { elId: 'deepening-registry-panel', storeKey: 'deepeningRegistryStats', listKey: null,
      emptyText: '暂无注册表数据',
      isEmptyCheck: function(s) { return (s.totalDefined ?? 0) === 0 && (s.totalLoaded ?? 0) === 0; },
      mainTitle: '模块注册表', mainIcon: '📋', accentColor: 'primary', statsTitle: '注册统计',
      mainBadge: function(s) { return (s.totalLoaded ?? 0) + '/' + (s.totalDefined ?? 0); },
      mainRows: function(d) {
        var rows = '';
        rows += Components.metaRow('var(--primary-light)', '当前深度级别', 'Level ' + (d.currentDepthLevel ?? 0));
        rows += Components.metaRow('var(--cyan)', '懒加载次数', (d.lazyLoads ?? 0) + '次');
        var loadedByTier = d.loadedByTier ?? {};
        for (var tier in loadedByTier) {
          if (Object.prototype.hasOwnProperty.call(loadedByTier, tier)) {
            var t = loadedByTier[tier];
            var color = t.loaded === t.total ? 'var(--success)' : 'var(--warning)';
            rows += Components.metaRow(color, tier, t.loaded + '/' + t.total + ' 已加载');
          }
        }
        return rows || '无注册模块';
      },
      statsPairs: function(s) { return [['var(--primary-light)', '已定义', s.totalDefined ?? 0], ['var(--success)', '已加载', s.totalLoaded ?? 0], ['var(--cyan)', '懒加载', s.lazyLoads ?? 0]]; }
    },
  ];

  var INFRASTRUCTURE_STATS_PANELS = [
    { elId: 'infrastructure-health-checker-panel', storeKey: 'infrastructureHealthChecker',
      emptyText: '暂无健康检查数据',
      isEmptyCheck: function(s) { return s.totalChecks === 0; },
      mainTitle: '健康检查', mainIcon: '🏥', accentColor: 'success', statsTitle: '检查统计',
      mainBadge: function(s) { return (s.totalChecks ?? 0) + '项'; },
      mainRows: function(d, s) {
        var checks = d.checks ?? [];
        var tierColors = { critical: 'var(--danger)', warning: 'var(--warning)', info: 'var(--primary)' };
        return checks.slice(0, 10).map(function(name) {
          var tier = (s.tiers && s.tiers[name]) || 'warning';
          return Components.metaRow(tierColors[tier] || 'var(--primary)', name, tier);
        }).join('') || '无检查项';
      },
      statsPairs: function(s) { return [['var(--success)', '检查项', s.totalChecks], ['var(--primary)', '已执行', s.checkCount], ['var(--cyan)', '运行时间', Math.round((s.uptimeMs ?? 0) / 1000) + 's'], ['var(--warning)', '最近结果', s.lastCheckResult || '—']]; }
    },
    { elId: 'infrastructure-priority-queue-panel', storeKey: 'infrastructurePriorityQueue',
      emptyText: '暂无优先队列数据',
      isEmptyCheck: function(s) { return s.size === 0 && s.pushed === 0; },
      mainTitle: '优先队列', mainIcon: '📊', accentColor: 'primary', statsTitle: '队列统计',
      mainBadge: function(s) { return (s.size ?? 0) + '项'; },
      mainRows: function(d, s) {
        var items = d.items ?? [];
        return items.slice(0, 10).map(function(item) {
          var p = item.priority !== undefined ? item.priority : 5;
          var pLabel = p <= 1 ? 'CRITICAL' : p <= 3 ? 'HIGH' : p <= 5 ? 'NORMAL' : p <= 7 ? 'LOW' : 'IDLE';
          return Components.metaRow('var(--primary)', item.id || '—', 'P' + p + ' ' + pLabel);
        }).join('') || '队列为空';
      },
      statsPairs: function(s) { return [['var(--primary)', '当前大小', s.size], ['var(--warning)', '最大容量', s.maxSize], ['var(--success)', '已入队', s.pushed], ['var(--cyan)', '已出队', s.popped], ['var(--danger)', '已驱逐', s.evicted]]; }
    },
    { elId: 'infrastructure-event-bus-panel', storeKey: 'infrastructureEventBus',
      emptyText: '暂无事件总线数据',
      isEmptyCheck: function(s) { return s.eventCount === 0 && s.totalListeners === 0; },
      mainTitle: '事件总线', mainIcon: '📡', accentColor: 'primary', statsTitle: '事件统计',
      mainBadge: function(s) { return (s.eventCount ?? 0) + '事件'; },
      mainRows: function(d, s) {
        var history = d.history ?? [];
        return history.slice(-8).reverse().map(function(h) {
          var hTs = h.timestamp && !isNaN(new Date(h.timestamp).getTime()) ? new Date(h.timestamp).toLocaleTimeString() : '—';
          return Components.metaRow('var(--primary)', h.event || '—', hTs);
        }).join('') || '无事件历史';
      },
      statsPairs: function(s) { return [['var(--primary)', '事件类型', s.eventCount], ['var(--success)', '监听器', s.totalListeners], ['var(--cyan)', '历史大小', s.historySize], ['var(--warning)', '健康状态', s.healthy ? '正常' : '已关闭']]; }
    },
  ];

  var Renderers = {
    workflow: function() {
      safeRender(function() {
        var wf = Store.get('workflow') ?? {};
        var phases = wf.phases ?? [];
        var container = $('workflow-nodes');
        if (!container) return;
        if (!phases.length) {
          container.innerHTML = Components.emptyState('🔄', '暂无工作流数据');
          var pdl = $('phase-detail-list');
          if (pdl) pdl.textContent = '';
          return;
        }

        var wfHeaderEl = $('workflow-header-info');
        if (wfHeaderEl) {
          var headerHtml = '';
          if (wf.currentPhase) {
            headerHtml += '<div class="info-box info-box--primary" style="margin-bottom:var(--space-3)">';
            headerHtml += '<div class="info-box__text">当前阶段: <strong>' + escapeHtml(phaseName(wf.currentPhase)) + '</strong>';
            if (wf.completedSkills && wf.completedSkills.length > 0) {
              headerHtml += ' · 已完成技能: ' + wf.completedSkills.length + '个';
            }
            if (wf.phaseBudgetAllocation) {
              var allocKeys = Object.keys(wf.phaseBudgetAllocation);
              if (allocKeys.length > 0) {
                headerHtml += ' · 阶段预算: ' + allocKeys.map(function(k) { return escapeHtml(k) + ':' + escapeHtml(String(wf.phaseBudgetAllocation[k] ?? 0)) + '%'; }).join(' ');
              }
            }
            headerHtml += '</div></div>';
          }
          wfHeaderEl.innerHTML = headerHtml;
        }

        var agentColorMap = {};
        var allAgents = [];
        phases.forEach(function(p) {
          (p.agents ?? []).forEach(function(a) {
            if (!agentColorMap[a.id]) {
              agentColorMap[a.id] = AGENT_COLORS[allAgents.length % AGENT_COLORS.length];
              allAgents.push(a);
            }
          });
        });

        var html = '';
        phases.forEach(function(p, i) {
          var icon = p.status === 'completed' ? '✓' : String(i + 1);
          var agentsHtml = (p.agents ?? []).map(function(a) {
            var c = agentColorMap[a.id] || AGENT_COLORS[0];
            var initials = getInitials(a.id);
            return '<div class="wf-agent-dot" style="background:' + escapeAttr(c.bg) + ';color:' + escapeAttr(c.fg) + ';border-color:' + escapeAttr(c.border) + '" data-tooltip-title="' + escapeAttr(a.role) + '" data-tooltip-sub="' + escapeAttr(a.id + ' · ' + (a.skillCount ?? 0) + ' 个技能') + '">' + escapeHtml(initials) + '</div>';
          }).join('');

          var phaseSkills = p.skills ?? [];
          var completedInPhase = phaseSkills.filter(function(s) { return s.completed; }).length;
          var skillCountHtml = phaseSkills.length > 0 ? '<div class="wf-skill-count"><span class="done">' + completedInPhase + '</span>/' + phaseSkills.length + ' 技能</div>' : '';
          var budgetHtml = p.budgetPercent > 0 ? '<div class="wf-budget">预算 ' + escapeHtml(String(p.budgetPercent)) + '%</div>' : '';
          var statusText = p.status === 'completed' ? '已完成' : p.status === 'active' ? '进行中' : '待开始';

          html += '<div class="wf-node ' + escapeAttr(p.status) + '" data-phase-index="' + i + '" role="button" tabindex="0" aria-label="' + escapeAttr(p.name) + ' - ' + escapeAttr(statusText) + '">' +
            '<div class="wf-circle">' + icon + '</div>' +
            '<div class="wf-label">' + escapeHtml(p.name) + '</div>' + budgetHtml +
            '<div class="wf-agents-row">' + agentsHtml + '</div>' + skillCountHtml + '</div>';
          if (i < phases.length - 1) {
            html += '<div class="wf-arrow ' + (p.status === 'completed' ? 'done' : '') + '">→</div>';
          }
        });
        container.innerHTML = html;

        Renderers._phaseDetails(phases, agentColorMap);
        Renderers._frameworkFeatures();
        initTooltips();
      });
    },

    _phaseDetails: function(phases, agentColorMap) {
      var detailList = $('phase-detail-list');
      if (!detailList) return;
      detailList.innerHTML = phases.map(function(p, i) {
        var icon = p.status === 'completed' ? '✓' : String(i + 1);
        var statusText = p.status === 'completed' ? '已完成' : p.status === 'active' ? '进行中' : '待开始';
        var statusColor = p.status === 'completed' ? 'var(--success)' : p.status === 'active' ? 'var(--primary-light)' : 'var(--text3)';
        var phaseSkills = p.skills ?? [];
        var phaseAgents = p.agents ?? [];
        var completedInPhase = phaseSkills.filter(function(s) { return s.completed; }).length;
        var isExpanded = p.status === 'active' ? ' expanded' : '';

        var agentsHtml = phaseAgents.map(function(a) {
          var c = agentColorMap[a.id] || AGENT_COLORS[0];
          var initials = getInitials(a.id);
          return '<div class="phase-agent-chip"><div class="phase-agent-avatar" style="background:' + escapeAttr(c.bg) + ';color:' + escapeAttr(c.fg) + '">' + escapeHtml(initials) + '</div>' +
            '<span>' + escapeHtml(a.role) + '</span><span class="phase-agent-skill-count">' + escapeHtml(String(a.skillCount ?? 0)) + ' 技能</span></div>';
        }).join('');

        var agentRoleIndex = {};
        for (var ai = 0; ai < phaseAgents.length; ai++) {
          agentRoleIndex[phaseAgents[ai].id] = phaseAgents[ai].role;
        }

        var skillsHtml = phaseSkills.map(function(s) {
          var statusIcon = s.completed ? '✓' : '○';
          var statusClass = s.completed ? 'done' : 'pending';
          var enfMap = { strict: '强制', recommended: '推荐', optional: '可选' };
          var agentNames = (s.applicableAgents ?? []).map(function(aId) {
            return escapeHtml(agentRoleIndex[aId] || aId);
          }).join('、');
          var deps = (s.dependsOn && s.dependsOn.length) ? '← ' + s.dependsOn.map(function(d) { return escapeHtml(d); }).join('、') : '';
          return '<div class="phase-skill-row">' +
            '<div class="phase-skill-status ' + statusClass + '">' + statusIcon + '</div>' +
            '<div class="phase-skill-name">' + escapeHtml(s.name) + '</div>' +
            '<div class="phase-skill-enforcement ' + escapeAttr(s.enforcement) + '">' + (enfMap[s.enforcement] || escapeHtml(s.enforcement)) + '</div>' +
            (deps ? '<div class="phase-skill-deps">' + deps + '</div>' : '') +
            '<div class="phase-skill-agents">' + agentNames + '</div></div>';
        }).join('');
        var budgetBar = p.budgetPercent > 0 ? '<div class="phase-budget-bar"><div class="phase-budget-fill" style="width:' + escapeAttr(String(p.budgetPercent)) + '%;background:' + escapeAttr(statusColor) + '"></div></div>' : '';
        var subText = completedInPhase + '/' + phaseSkills.length + ' 技能完成' + (phaseAgents.length > 0 ? ' · ' + phaseAgents.length + ' 个角色参与' : '');

        var isExpandedAttr = p.status === 'active' ? 'true' : 'false';
        return '<div class="phase-detail-panel' + isExpanded + '" data-phase-index="' + i + '">' +
          '<div class="phase-detail-header" data-action="toggle-phase" role="button" tabindex="0" aria-expanded="' + isExpandedAttr + '" aria-label="' + escapeAttr(p.name) + '">' +
          '<div class="phase-detail-icon ' + escapeAttr(p.status) + '">' + icon + '</div>' +
          '<div class="phase-detail-info"><div class="phase-detail-name">' + escapeHtml(p.name) + '</div>' +
          '<div class="phase-detail-sub">' + subText + '</div>' + budgetBar + '</div>' +
          Components.badge(statusText, p.status === 'completed' ? 'badge-green' : p.status === 'active' ? 'badge-blue' : 'badge-yellow') +
          '<div class="phase-detail-toggle">▼</div></div>' +
          '<div class="phase-detail-body"><div class="phase-detail-content">' +
          (phaseAgents.length > 0 ? Components.section('负责角色', agentsHtml, { icon: '👤', badge: phaseAgents.length + '', variant: 'accent', accentColor: 'primary', spacing: 'compact' }) : '') +
          (phaseSkills.length > 0 ? Components.section('执行技能', skillsHtml, { icon: '⚡', badge: phaseSkills.length + '', variant: 'accent', accentColor: 'success', spacing: 'compact' }) : Components.section('执行技能', Components.emptyState('', '该阶段暂无定义技能'), { icon: '⚡', spacing: 'compact' })) +
          '</div></div></div>';
      }).join('');
    },

    _frameworkFeatures: function() {
      var featData = Store.get('frameworkFeatures') ?? {};
      var cp = Store.get('checkpoints') ?? {};
      var cpCount = cp.count ?? 0;
      var cpEl = $('checkpoint-panel');
      if (cpEl) {
        var cpItems = cp.checkpoints ?? [];
        var ckpt = featData.checkpoint ?? {};
        var cpHtml = Components.metricsRow([
          Components.metricBlock('检查点数', cpCount, 'var(--success)'),
          Components.metricBlockSmall('原子写入', ckpt.atomicWrite || '✓ .tmp+rename', 'var(--success)'),
          Components.metricBlockSmall('恢复机制', ckpt.recovery || '✓ 支持', 'var(--success)')
        ]);
        if (cpItems.length > 0) {
          cpHtml += Components.section('最近检查点', cpItems.slice(-3).reverse().map(function(r) {
            return Components.skillRow(r.id || r.sessionId || '—', r.phase || '');
          }).join(''), { icon: '💾', badge: cpCount + '', variant: 'collapsible' });
        } else {
          cpHtml += Components.emptyState('', '暂无检查点数据');
        }
        cpEl.innerHTML = cpHtml;
      }

      var retryEl = $('retry-engine-panel');
      if (retryEl) {
        var retry = featData.retry ?? {};
        var retryStrategies = retry.escalationStrategies ?? [];
        retryEl.innerHTML = Components.metricsRow([
          Components.metricBlockSmall('退避策略', retry.strategy || 'exponential', 'var(--purple)'),
          Components.metricBlock('最大重试', retry.maxRetries ?? 3, 'var(--purple)'),
          Components.metricBlockSmall('退避上限', retry.maxBackoff || '60s', 'var(--purple)')
        ]) + (retryStrategies.length > 0 ? Components.section('升级策略', retryStrategies.map(function(s) {
          return Components.skillRow(s.name, s.desc);
        }).join(''), { icon: '🔄', badge: retryStrategies.length + '种', variant: 'accent', accentColor: 'purple' }) : '');
      }

      var dagEl = $('dag-template-panel');
      if (dagEl) {
        var wt = Store.get('workflowTemplates') ?? {};
        var templates = wt.templates ?? [];
        var dag = featData.dag ?? {};
        var dagFeatures = dag.features ?? [];
        var dagHtml = Components.metricsRow([
          Components.metricBlockSmall('DAG引擎', dagFeatures.length > 0 ? dagFeatures[0].status : '✓ 环检测+拓扑排序', 'var(--primary-light)'),
          Components.metricBlock('工作流模板', templates.length, 'var(--primary-light)'),
          Components.metricBlockSmall('自环检测', dagFeatures.length > 1 ? dagFeatures[1].status : '✓ 拒绝', 'var(--success)')
        ]);
        if (templates.length > 0) {
          dagHtml += Components.section('已定义模板', templates.map(function(t) {
            return Components.skillRow(t.name || t.id || '—', t.steps ? t.steps.length + ' 步骤' : '');
          }).join(''), { icon: '📐', badge: templates.length + '', variant: 'bordered' });
        } else {
          dagHtml += Components.emptyState('', '暂无工作流模板');
        }
        dagEl.innerHTML = dagHtml;
      }

      var rbacEl = $('rbac-security-panel');
      if (rbacEl) {
        var agents = Store.get('agents') ?? [];
        var autoRouteCount = agents.filter(function(a) { return a.autoRoute; }).length;
        var tddEnforcedCount = agents.filter(function(a) { return a.tddEnforced; }).length;
        var sec = featData.security ?? {};
        var secCapabilities = sec.capabilities ?? [];
        rbacEl.innerHTML = Components.metricsRow([
          Components.metricBlock('RBAC角色', agents.length, 'var(--danger)'),
          Components.metricBlock('自动路由', autoRouteCount, 'var(--primary-light)'),
          Components.metricBlock('TDD强制', tddEnforcedCount, 'var(--danger)')
        ]) + (secCapabilities.length > 0 ? Components.section('安全防护', secCapabilities.map(function(s) {
          return Components.skillRow(s.name, s.status);
        }).join(''), { icon: '🔒', badge: secCapabilities.length + '项', variant: 'accent', accentColor: 'danger' }) : '');
      }

      var ccEl = $('channel-concurrency-panel');
      if (ccEl) {
        var conc = featData.concurrency ?? {};
        var channels = conc.channels ?? [];
        ccEl.innerHTML = Components.metricsRow([
          Components.metricBlock('最大并发', conc.maxConcurrency ?? 6, 'var(--primary-light)'),
          Components.metricBlock('队列上限', conc.queueLimit ?? 100, 'var(--primary-light)'),
          Components.metricBlockSmall('Agent通信', conc.communication ? '✓ ' + conc.communication : '✓ 发布/订阅', 'var(--success)')
        ]) + (channels.length > 0 ? Components.section('通信机制', channels.map(function(c) {
          return Components.skillRow(c.name, c.desc);
        }).join(''), { icon: '📡', badge: channels.length + '种', variant: 'bordered' }) : '');
      }

      var tddEl = $('tdd-evidence-panel');
      if (tddEl) {
        var tdd = featData.tdd ?? {};
        var evidenceTypes = tdd.evidenceTypes ?? [];
        var tddPhases = tdd.phases ?? [];
        var coverageThreshold = tdd.coverageThreshold ?? 80;
        tddEl.innerHTML = Components.metricsRow([
          Components.metricBlockSmall('TDD门禁', tdd.enabled ? '✓ 强制' : '○ 未启用', 'var(--danger)'),
          Components.metricBlock('覆盖率阈值', coverageThreshold + '%', 'var(--danger)'),
          Components.metricBlockSmall('RED-GREEN-REFACTOR', '✓ 强制', 'var(--danger)')
        ]) + (tddPhases.length > 0 ? Components.section('门禁流程', tddPhases.map(function(p) {
          return '<div class="phase-skill-row"><div class="phase-skill-status done">' + escapeHtml(p.emoji) + '</div><div class="phase-skill-name">' + escapeHtml(p.name) + '</div></div>';
        }).join(''), { icon: '🚦', badge: 'RGR', variant: 'accent', accentColor: 'danger' }) : '') + (evidenceTypes.length > 0 ? Components.section('证据验证', evidenceTypes.map(function(e) {
          return Components.skillRow(e.key, e.desc);
        }).join(''), { icon: '✅', badge: evidenceTypes.length + '类', variant: 'collapsible' }) : '');
      }

      var siEl = $('skill-improver-panel');
      if (siEl) {
        var lrn = Store.get('learnings') ?? {};
        var lrnCount = lrn.count ?? 0;
        var lrnItems = lrn.learnings ?? [];
        var siHtml = Components.metricsRow([
          Components.metricBlock('学习记录', lrnCount, 'var(--success)'),
          Components.metricBlockSmall('自我改进', '✓ 启用', 'var(--success)'),
          Components.metricBlockSmall('对抗审查', '✓ 双审查者', 'var(--success)')
        ]);
        if (lrnItems.length > 0) {
          siHtml += Components.section('最近学习', lrnItems.slice(-3).reverse().map(function(r) {
            return Components.skillRow(r.skillId || '—', r.whatWorked ? r.whatWorked.length + ' 条经验' : '');
          }).join(''));
        } else {
          siHtml += Components.emptyState('', '暂无学习记录');
        }
        siEl.innerHTML = siHtml;
      }
    },

    agents: function(filter) {
      safeRender(function() {
        filter = filter || UIState.activeAgentFilter;
        UIState.activeAgentFilter = filter;
        var agents = (Store.get('agents') ?? []).filter(function(a) {
          if (filter === 'auto-route') return a.autoRoute;
          if (filter === 'tdd-enforced') return a.tddEnforced;
          return true;
        });

        var container = $('agent-list');
        if (!container) return;
        if (!agents.length) {
          container.innerHTML = Components.emptyState('🤖', '暂无匹配的角色数据');
          return;
        }

        var skillsList = Store.get('skills') ?? [];
        var skillIndex = {};
        for (var si = 0; si < skillsList.length; si++) {
          skillIndex[skillsList[si].id] = skillsList[si];
        }

        updateHTML(container, agents.map(function(a, i) {
          var c = AGENT_COLORS[i % AGENT_COLORS.length];
          var initials = getInitials(a.id);
          var badges = '';
          if (a.autoRoute) badges += '<span class="agent-badge badge-auto-route">自动路由</span>';
          if (a.tddEnforced) badges += '<span class="agent-badge badge-tdd-enforced">TDD 强制</span>';
          if (a.enforcement) badges += '<span class="agent-badge badge-' + escapeAttr(a.enforcement) + '">' + escapeHtml(a.enforcement) + '</span>';
          var collabHtml = '';
          if (a.collaboratesWith && a.collaboratesWith.length > 0) {
            collabHtml += '<div class="agent-meta"><span class="agent-meta-label">协作:</span> ' + a.collaboratesWith.map(function(c) { return escapeHtml(c); }).join(', ') + '</div>';
          }
          if (a.manages && a.manages.length > 0) {
            collabHtml += '<div class="agent-meta"><span class="agent-meta-label">管理:</span> ' + a.manages.map(function(m) { return escapeHtml(m); }).join(', ') + '</div>';
          }
          var skillsHtml = (a.skills ?? []).map(function(s) {
            var sk = skillIndex[s];
            var cls = sk ? escapeAttr(sk.enforcement) : '';
            if (sk && sk.infrastructure) cls = 'infra';
            return '<span class="skill-tag ' + cls + '">' + escapeHtml(s) + '</span>';
          }).join('');
          return '<div class="card agent-card">' +
            '<div class="agent-avatar" style="background:' + escapeAttr(c.bg) + ';color:' + escapeAttr(c.fg) + '">' + escapeHtml(initials) + '</div>' +
            '<div class="agent-info"><div class="agent-name">' + escapeHtml(a.role || a.id) + '</div>' +
            '<div class="agent-role">' + escapeHtml(a.id) + '</div>' +
            '<div class="agent-badges">' + badges + '</div>' +
            collabHtml +
            '<div class="agent-skills">' + skillsHtml + '</div></div></div>';
        }).join(''));
      });
    },

    skills: function(filter) {
      safeRender(function() {
        filter = filter || UIState.activeSkillFilter;
        UIState.activeSkillFilter = filter;
        var query = UIState.skillSearchQuery.toLowerCase();
        var skills = (Store.get('skills') ?? []).filter(function(s) {
          if (filter !== 'all' && s.enforcement !== filter) return false;
          if (query) {
            var nameMatch = (s.name || '').toLowerCase().indexOf(query) >= 0;
            var idMatch = (s.id || '').toLowerCase().indexOf(query) >= 0;
            var phaseMatch = phaseName(s.phase).toLowerCase().indexOf(query) >= 0;
            var agentMatch = (s.applicableAgents ?? []).join(' ').toLowerCase().indexOf(query) >= 0;
            if (!nameMatch && !idMatch && !phaseMatch && !agentMatch) return false;
          }
          return true;
        });

        var tbody = $('skill-table');
        tbody = tbody ? tbody.querySelector('tbody') : null;
        if (!tbody) return;
        var enfMap = { strict: '强制', recommended: '推荐', optional: '可选' };
        if (!skills.length) {
          tbody.innerHTML = Components.tableEmpty(7, '暂无匹配的技能数据');
          return;
        }
        updateHTML(tbody, skills.map(function(s) {
          var enfClass = s.enforcement === 'strict' ? 'badge-red' : s.enforcement === 'recommended' ? 'badge-yellow' : 'badge-green';
          var infraTag = s.infrastructure ? ' <span class="badge badge-blue badge-xs">基础设施</span>' : '';
          var verifiedTag = s.verified ? ' <span class="badge badge-green badge-xs">✓ 已验证</span>' : ' <span class="badge badge-yellow badge-xs">未验证</span>';
          var stabilityMap = { stable: 'badge-green', beta: 'badge-yellow', experimental: 'badge-red', unverified: 'badge-yellow' };
          var stabilityTag = s.stability ? ' <span class="badge ' + (stabilityMap[s.stability] || 'badge-yellow') + ' badge-xs">' + escapeHtml(s.stability) + '</span>' : '';
          var autoText = s.autoTrigger ? '✓ 是' : '✗ 否';
          var deps = (s.dependsOn && s.dependsOn.length) ? s.dependsOn.join('、') : '—';
          var agentNames = (s.applicableAgents && s.applicableAgents.length) ? s.applicableAgents.join('、') : '—';
          return '<tr>' +
            '<td><strong>' + escapeHtml(s.name || s.id) + '</strong>' + infraTag + verifiedTag + stabilityTag + '<br><span class="table-sub-text">' + escapeHtml(s.id) + '</span></td>' +
            '<td>' + escapeHtml(phaseName(s.phase)) + '</td>' +
            '<td><span class="badge ' + escapeAttr(enfClass) + '">' + escapeHtml(enfMap[s.enforcement] || s.enforcement) + '</span></td>' +
            '<td>' + escapeHtml(s.priority) + '</td>' +
            '<td>' + autoText + '</td>' +
            '<td>' + escapeHtml(deps) + '</td>' +
            '<td>' + escapeHtml(agentNames) + '</td></tr>';
        }).join(''));
      });
    },

    sessions: function() {
      safeRender(function() {
        var container = $('panel-sessions');
        if (!container) return;

        var query = UIState.sessionSearchQuery.toLowerCase();
        var allSessions = Store.get('sessions') ?? [];
        var filtered = allSessions.filter(function(s) {
          if (query) {
            var idMatch = (s.id || '').toLowerCase().indexOf(query) >= 0;
            var phaseMatch = phaseName(s.currentPhase).toLowerCase().indexOf(query) >= 0;
            if (!idMatch && !phaseMatch) return false;
          }
          return true;
        });

        var activeCount = allSessions.filter(function(s) { return s.status === 'active'; }).length;
        var totalTokens = allSessions.reduce(function(sum, s) { return sum + (s.tokensUsed ?? 0); }, 0);
        var headerEl = container.querySelector('.panel-header');
        if (headerEl) {
          headerEl.innerHTML =
            '<div class="panel-title-row"><span class="panel-title-icon" aria-hidden="true">💬</span><span class="panel-title">会话管理</span></div>' +
            '<div class="session-stats-row">' +
              '<div class="session-stat-pill pill-active"><span class="stat-num">' + activeCount + '</span> 活跃</div>' +
              '<div class="session-stat-pill"><span class="stat-num">' + allSessions.length + '</span> 总数</div>' +
              '<div class="session-stat-pill"><span class="stat-num">' + escapeHtml(formatTokens(totalTokens)) + '</span> 总消耗</div>' +
            '</div>';
        }

        var tbody = $('session-table');
        tbody = tbody ? tbody.querySelector('tbody') : null;
        if (!tbody) return;
        if (!filtered.length) {
          tbody.innerHTML = '<tr><td colspan="7" class="session-empty-state">暂无会话数据，请先创建会话</td></tr>';
          return;
        }
        var budget = (Store.get('config') ?? {}).token_budget;
        if (!budget || budget <= 0) budget = 1000000000;
        updateHTML(tbody, filtered.map(function(s) {
          var statusText = s.status === 'active' ? '活跃' : '已结束';
          var statusClass = s.status === 'active' ? 'badge-green' : 'badge-yellow';
          var lastAct = s.lastActivityAt && !isNaN(new Date(s.lastActivityAt).getTime()) ? new Date(s.lastActivityAt).toLocaleString('zh-CN') : '—';
          var completedCount = (s.completedSkills ?? []).length;
          var phaseColorClass = s.currentPhase ? 'session-phase-badge phase-' + s.currentPhase.replace(/\s+/g, '-').toLowerCase() : '';
          var tokens = s.tokensUsed ?? 0;
          var tokenRatio = budget > 0 ? tokens / budget : 0;
          var tokenCellClass = _tokenColorClass(tokenRatio) === 'c-success' ? '' : _tokenColorClass(tokenRatio);
          return '<tr>' +
            '<td class="session-id-cell">' + escapeHtml(s.id) + '</td>' +
            '<td><span class="' + escapeAttr(phaseColorClass) + '">' + escapeHtml(phaseName(s.currentPhase)) + '</span></td>' +
            '<td><span class="badge ' + escapeAttr(statusClass) + '">' + escapeHtml(statusText) + '</span></td>' +
            '<td class="session-token-cell ' + escapeAttr(tokenCellClass) + '">' + escapeHtml(formatTokens(tokens)) + '</td>' +
            '<td>' + completedCount + ' 个</td>' +
            '<td>' + safeNum(s.iterationCount) + '</td>' +
            '<td>' + escapeHtml(lastAct) + '</td></tr>';
        }).join(''));
      });
    },

    changelog: function() {
      safeRender(function() {
        var avtStats = Store.get('autoVersionStats') ?? {};
        var avtRecent = Store.get('autoVersionRecent') ?? {};
        var avtEl = $('auto-version-tracker');
        if (avtEl && avtStats.available) {
          var stats = avtStats.stats ?? {};
          var records = avtRecent.records ?? [];
          var avtHtml = Components.metricsRow([
            Components.metricBlock('自动记录', stats.recorded ?? 0, 'var(--primary-light)'),
            Components.metricBlockSmall('待写入', stats.pendingCount ?? 0, 'var(--warning)'),
            Components.metricBlockSmall('跳过', stats.skipped ?? 0, 'var(--text3)'),
            Components.metricBlockSmall('最新版本', stats.lastRecordedVersion || '—', 'var(--success)')
          ]);
          if (records.length > 0) {
            avtHtml += '<div class="auto-version-list">' + records.slice(0, 8).map(function(r) {
              var catColor = r.category === '新增' ? 'var(--success)' : r.category === '修复' ? 'var(--warning)' : 'var(--primary-light)';
              return '<div class="auto-version-item">' +
                '<span class="auto-version-v" style="color:' + catColor + '">v' + escapeHtml(r.version || '') + '</span>' +
                '<span class="auto-version-summary">' + escapeHtml(r.summary || '') + '</span>' +
                '<span class="auto-version-agent">' + escapeHtml(r.agent || '') + '</span>' +
                '<span class="auto-version-time">' + escapeHtml((r.timestamp || '').substring(11, 19)) + '</span>' +
                '</div>';
            }).join('') + '</div>';
          } else {
            avtHtml += Components.emptyState('', '暂无自动版本记录');
          }
          avtEl.innerHTML = avtHtml;
        } else if (avtEl) {
          avtEl.innerHTML = Components.emptyState('', '自动版本追踪未启用');
        }

        var allVersions = getFilteredChangelog();
        var container = $('changelog-list');
        if (!container) return;
        if (!allVersions.length) {
          container.innerHTML = Components.emptyState('📝', '暂无匹配的更新日志');
          renderChangelogPagination(0);
          return;
        }

        var total = allVersions.length;
        var totalPages = Math.ceil(total / UIState.changelogPageSize);
        if (UIState.changelogPage > totalPages) UIState.changelogPage = totalPages;
        if (UIState.changelogPage < 1) UIState.changelogPage = 1;
        var start = (UIState.changelogPage - 1) * UIState.changelogPageSize;
        var paged = allVersions.slice(start, start + UIState.changelogPageSize);

        var sectionNames = { '新增': 'add', '变更': 'change', '修复': 'fix', '移除': 'remove' };
        var sectionIcons = { '新增': '✨', '变更': '🔄', '修复': '🔧', '移除': '🗑️' };

        updateHTML(container, paged.map(function(v, vi) {
          var meta = v.meta ?? {};
          var isExpanded = vi === 0 && UIState.changelogPage === 1 ? ' expanded' : '';

          var metaHtml = '';
          if (meta.iterationRound) {
            var tokenBreakdown = meta.tokenBreakdown ?? {};
            var breakdownKeys = Object.keys(tokenBreakdown);
            var breakdownItems = breakdownKeys.length ? breakdownKeys.map(function(k) {
              return '<div class="token-grid-item"><span class="token-grid-label">' + escapeHtml(k) + '</span><span class="token-grid-value">' + escapeHtml(formatTokens(tokenBreakdown[k] ?? 0)) + '</span></div>';
            }).join('') : '';

            metaHtml = '<div class="changelog-meta">' +
              (breakdownItems ? '<div class="changelog-token-grid">' + breakdownItems + '</div>' : '') +
              '<div class="meta-item" aria-label="迭代轮次"><span class="meta-label">迭代轮次</span><span class="meta-value highlight">第 ' + escapeHtml(String(meta.iterationRound)) + ' 轮</span></div>' +
              '<div class="meta-item" aria-label="累计迭代"><span class="meta-label">累计迭代</span><span class="meta-value">' + escapeHtml(String(meta.cumulativeIterations ?? 0)) + ' 次</span></div>' +
              '<div class="meta-item" aria-label="开始时间"><span class="meta-label">开始时间</span><span class="meta-value">' + escapeHtml(meta.startTime || '—') + '</span></div>' +
              '<div class="meta-item" aria-label="结束时间"><span class="meta-label">结束时间</span><span class="meta-value">' + escapeHtml(meta.endTime || '—') + '</span></div>' +
              '<div class="meta-item" aria-label="迭代周期"><span class="meta-label">迭代周期</span><span class="meta-value highlight">' + escapeHtml(String(meta.durationHours ?? 0)) + ' 小时</span></div>' +
              '<div class="meta-item" aria-label="令牌消耗"><span class="meta-label">令牌消耗</span><span class="meta-value">' + escapeHtml(formatTokens(meta.tokenTotal ?? 0)) + '</span></div>' +
              '<div class="meta-item" aria-label="负责人"><span class="meta-label">负责人</span><span class="meta-value">' + escapeHtml(meta.responsible || '—') + '</span></div>' +
              '<div class="meta-item" aria-label="审核人"><span class="meta-label">审核人</span><span class="meta-value">' + escapeHtml(meta.reviewer || '—') + '</span></div></div>';
          }

          var sectionsHtml = '';
          var keys = Object.keys(sectionNames);
          for (var ki = 0; ki < keys.length; ki++) {
            var title = keys[ki];
            var cls = sectionNames[title];
            var icon = sectionIcons[title] || '';
            var items = (v.sections ?? {})[title];
            if (items && items.length) {
              var itemsHtml = '';
              for (var ii = 0; ii < items.length; ii++) {
                var item = items[ii];
                if (typeof item === 'string') {
                  itemsHtml += '<div class="changelog-item"><div class="changelog-item-title">' + escapeHtml(item) + '</div></div>';
                } else {
                  var tags = '';
                  if (item.module) tags += '<span class="changelog-item-tag mod">模块：' + escapeHtml(item.module) + '</span>';
                  if (item.method) tags += '<span class="changelog-item-tag impl">实现：' + escapeHtml(item.method) + '</span>';
                  if (item.value) tags += '<span class="changelog-item-tag val">价值：' + escapeHtml(item.value) + '</span>';
                  var subHtml = '';
                  if (item.subItems && item.subItems.length) {
                    subHtml = '<ul class="changelog-sub-items">' + item.subItems.map(function(si) { return '<li>' + escapeHtml(si) + '</li>'; }).join('') + '</ul>';
                  }
                  var filesHtml = '';
                  var fileMatch = RE_CHANGELOG_FILES.exec(item.raw || '');
                  if (fileMatch) {
                    var fileNames = fileMatch[1].split('`, `');
                    filesHtml = '<div class="changelog-item-files">' + fileNames.map(function(f) { return '<span>' + escapeHtml(f) + '</span>'; }).join('') + '</div>';
                  }
                  itemsHtml += '<div class="changelog-item">' +
                    '<div class="changelog-item-title">' + escapeHtml(item.title || item.raw) + '</div>' +
                    (tags ? '<div class="changelog-item-meta">' + tags + '</div>' : '') +
                    (item.value ? '<div class="changelog-item-value">' + escapeHtml(item.value) + '</div>' : '') +
                    subHtml + filesHtml + '</div>';
                }
              }
              sectionsHtml += '<div class="changelog-section ' + cls + '"><h4>' + icon + ' ' + title + '</h4>' + itemsHtml + '</div>';
            }
          }

          return '<div class="changelog-entry slide-up' + isExpanded + '" data-version="' + escapeAttr(v.version) + '">' +
            '<div class="changelog-header" data-action="toggle-changelog" role="button" tabindex="0" aria-expanded="false" aria-label="版本 v' + escapeAttr(v.version) + '">' +
            '<div class="changelog-header-left"><span class="changelog-ver">v' + escapeHtml(v.version) + '</span>' +
            '<span class="changelog-date">' + escapeHtml(v.date || '') + '</span>' +
            (meta.iterationRound ? '<span class="changelog-round">第' + escapeHtml(String(meta.iterationRound)) + '轮</span>' : '') +
            '</div><div class="changelog-toggle">▼</div></div>' +
            '<div class="changelog-body">' + metaHtml + '<div class="changelog-content">' + sectionsHtml + '</div></div></div>';
        }).join(''));

        renderChangelogPagination(total);
      });
    },

    compliance: function() {
      safeRender(function() {
        var c = Store.get('compliance') ?? {};
        var metricsEl = $('compliance-metrics');
        if (metricsEl) {
          var compliant = c.compliant !== false;
          var errorCount = c.errors ?? 0;
          var warningCount = c.warnings ?? 0;
          metricsEl.innerHTML = [
            Components.statCard('🛡️', '合规状态', compliant ? '通过' : '未通过', compliant ? '框架规范全部满足' : '存在 ' + errorCount + ' 个违规', compliant ? 'c-success' : 'c-danger', compliant ? 'var(--success-glow)' : 'var(--danger-glow)', compliant ? 'var(--success)' : 'var(--danger)'),
            Components.statCard('⚠️', '警告数量', warningCount, '条框架合规警告', 'c-warning', 'var(--warning-glow)', 'var(--warning)'),
            Components.statCard('❌', '违规数量', errorCount, '条框架合规违规', errorCount > 0 ? 'c-danger' : 'c-success', errorCount > 0 ? 'var(--danger-glow)' : 'var(--success-glow)', errorCount > 0 ? 'var(--danger)' : 'var(--success)'),
          ].join('');
        }

        var devEl = $('deviation-list');
        if (devEl) {
          var devs = Store.get('deviations') ?? {};
          var byStatus = devs.byStatus ?? {};
          var total = devs.total ?? 0;
          var devItems = devs.deviations ?? [];
          if (total === 0 && devItems.length === 0) {
            devEl.innerHTML = Components.emptyState('', '暂无偏离审批记录');
          } else {
            var devHtml = Components.metricsRow([
              Components.metricRow('待审批', byStatus.pending ?? 0, 'var(--warning)'),
              Components.metricRow('已批准', byStatus.approved ?? 0, 'var(--success)'),
              Components.metricRow('已拒绝', byStatus.rejected ?? 0, 'var(--danger)'),
              Components.metricRow('总计', total, '')
            ]);
            var bySeverity = devs.bySeverity ?? {};
            if (Object.keys(bySeverity).length > 0) {
              devHtml += '<div class="info-box info-box--warning-soft" style="margin-top:var(--space-2)"><div class="info-box__title info-box__title--warning">严重程度分布</div><div class="comm-modes">';
              for (var sev in bySeverity) {
                if (Object.prototype.hasOwnProperty.call(bySeverity, sev)) {
                  var sevColor = sev === 'critical' ? 'danger' : sev === 'warning' ? 'warning' : 'primary';
                  devHtml += '<span class="comm-mode-tag comm-mode-tag--' + sevColor + '">' + escapeHtml(sev) + ': ' + safeNum(bySeverity[sev]) + '</span>';
                }
              }
              devHtml += '</div></div>';
            }
            if (devItems.length > 0) {
              devHtml += '<div class="detail-card-list">' + devItems.slice(0, 10).map(function(d) {
                return Components.detailCard(d, 'deviation');
              }).join('') + '</div>';
            }
            devEl.innerHTML = devHtml;
          }
        }

        var reviewEl = $('review-list');
        if (reviewEl) {
          var reviews = Store.get('codeReviews') ?? {};
          var rByStatus = reviews.byStatus ?? {};
          var rTotal = reviews.total ?? 0;
          var reviewItems = reviews.reviews ?? [];
          if (rTotal === 0 && reviewItems.length === 0) {
            reviewEl.innerHTML = Components.emptyState('', '暂无代码审查记录');
          } else {
            var revHtml = Components.metricsRow([
              Components.metricRow('待审查', rByStatus.pending ?? 0, 'var(--warning)'),
              Components.metricRow('审查中', rByStatus.in_progress ?? 0, 'var(--primary-light)'),
              Components.metricRow('已通过', rByStatus.approved ?? 0, 'var(--success)'),
              Components.metricRow('总计', rTotal, '')
            ]);
            var byVerdict = reviews.byVerdict ?? {};
            if (Object.keys(byVerdict).length > 0) {
              revHtml += '<div class="info-box info-box--primary" style="margin-top:var(--space-2)"><div class="info-box__title info-box__title--primary">审查结论分布</div><div class="comm-modes">';
              for (var vrd in byVerdict) {
                if (Object.prototype.hasOwnProperty.call(byVerdict, vrd)) {
                  var vrdColor = vrd === 'approved' ? 'success' : vrd === 'changes_requested' ? 'warning' : vrd === 'rejected' ? 'danger' : 'primary';
                  revHtml += '<span class="comm-mode-tag comm-mode-tag--' + vrdColor + '">' + escapeHtml(vrd) + ': ' + safeNum(byVerdict[vrd]) + '</span>';
                }
              }
              revHtml += '</div></div>';
            }
            if (reviewItems.length > 0) {
              revHtml += '<div class="detail-card-list">' + reviewItems.slice(0, 10).map(function(r) {
                return Components.detailCard(r, 'review');
              }).join('') + '</div>';
            }
            reviewEl.innerHTML = revHtml;
          }
        }

        var klEl = $('knowledge-learnings-panel');
        if (klEl) {
          var mem = Store.get('memory') ?? {};
          var knowledge = mem.recentKnowledge ?? [];
          var recentSummaries = mem.recentSummaries ?? [];
          var memStats = mem.stats ?? {};
          var cpCount = (Store.get('checkpoints') ?? {}).count ?? 0;
          var lrnCount = (Store.get('learnings') ?? {}).count ?? 0;
          var klHtml = '<div class="metrics-row metrics-row-3">' +
            Components.metricBlock('知识条目', knowledge.length, 'var(--primary-light)') +
            Components.metricBlock('检查点', cpCount, 'var(--cyan)') +
            Components.metricBlock('学习记录', lrnCount, 'var(--success)') + '</div>';
          if (memStats.totalEntries || memStats.totalSize) {
            klHtml += '<div class="detail-grid" style="margin-top:var(--space-2)">';
            if (memStats.totalEntries) klHtml += '<div class="detail-item"><span class="detail-label">总条目数</span><span class="detail-value">' + memStats.totalEntries + '</span></div>';
            if (memStats.totalSize) klHtml += '<div class="detail-item"><span class="detail-label">总大小</span><span class="detail-value">' + escapeHtml(String(memStats.totalSize)) + '</span></div>';
            klHtml += '</div>';
          }
          if (knowledge.length > 0) {
            klHtml += Components.section('最近知识条目', knowledge.slice(-5).reverse().map(function(k) {
              return Components.skillRow(k.category || k.id || '—', k.content || '');
            }).join(''), { icon: '📚', badge: knowledge.length + '', variant: 'collapsible' });
          } else {
            klHtml += Components.emptyState('', '暂无知识库数据');
          }
          if (recentSummaries.length > 0) {
            klHtml += Components.section('最近摘要', recentSummaries.slice(-5).reverse().map(function(s) {
              return Components.skillRow(s.id || s.sessionId || '—', s.summary || '');
            }).join(''), { icon: '📝', variant: 'collapsible' });
          }
          klEl.innerHTML = klHtml;
        }
      });
    },

    architecture: function() {
      safeRender(function() {
        var archData = Store.get('frameworkArchitecture') ?? {};
        var featData = Store.get('frameworkFeatures') ?? {};
        var archEl = $('arch-overview');
        if (archEl) {
          var corePrinciples = archData.corePrinciples || [
            { icon: '🏗️', title: '分层分责', desc: '6个Agent角色各司其职' },
            { icon: '📄', title: '文档驱动', desc: 'Markdown+YAML Frontmatter自描述配置' },
            { icon: '🔒', title: '流程管控', desc: '六阶段强制流程编排，TDD门禁检查' },
            { icon: '🔄', title: '容错自愈', desc: '检查点恢复、指数退避重试' }
          ];
          var metrics = archData.metrics ?? {};
          var loadedModules = metrics.loadedModules ?? 0;
          var totalModules = metrics.totalModules ?? 0;
          archEl.innerHTML = Components.metricsRow([
            Components.metricBlock('核心模块', metrics.coreModuleCount ?? '25+', 'var(--primary-light)'),
            Components.metricBlock('已加载', loadedModules + '/' + totalModules, loadedModules === totalModules ? 'var(--success)' : 'var(--warning)'),
            Components.metricBlock('事件驱动', metrics.eventDriven ? '✓' : '—', 'var(--cyan)'),
            Components.metricBlock('原子写入', metrics.atomicWrite ? '✓' : '—', 'var(--warning)')
          ]) + '<div class="arch-principles-grid">' +
            corePrinciples.map(function(p) {
              return Components.principleCard(p.icon, p.title, p.desc);
            }).join('') + '</div>';
        }

        var runtimeEl = $('arch-runtime');
        if (runtimeEl) {
          var runtimeModules = archData.runtimeModules || [
            { name: 'SkillRouter', desc: '技能发现与路由', color: 'var(--primary-light)' },
            { name: 'SessionManager', desc: '会话状态管理', color: 'var(--purple)' }
          ];
          runtimeEl.innerHTML = '<div class="arch-modules-grid">' +
            runtimeModules.map(function(m) {
              var loadIndicator = m.loaded === true ? ' <span class="arch-load-dot arch-load-dot--loaded" title="已加载">●</span>' : m.loaded === false ? ' <span class="arch-load-dot arch-load-dot--unloaded" title="未加载">○</span>' : '';
              return Components.moduleCard(m.name, m.desc, m.color, loadIndicator);
            }).join('') + '</div>';
        }

        var permEl = $('arch-permission');
        if (permEl) {
          var permModules = archData.permModules ?? [];
          var permSecurityCapabilities = archData.permSecurityCapabilities ?? [];
          permEl.innerHTML = permModules.map(function(m) {
            return Components.archDetailModule(m.name, m.desc, m.color);
          }).join('') + (permSecurityCapabilities.length > 0 ? Components.section('安全防护能力',
            permSecurityCapabilities.map(function(s) {
              return Components.skillRow(s.name, s.status);
            }).join(''), { icon: '🔒', badge: permSecurityCapabilities.length + '项', variant: 'accent', accentColor: 'danger' }) : '');
        }

        var gateEl = $('arch-gate');
        if (gateEl) {
          var gateModules = archData.gateModules ?? [];
          gateEl.innerHTML = gateModules.map(function(m) {
            return Components.archDetailModule(m.name, m.desc, m.color);
          }).join('');
        }

        var dataflowEl = $('arch-dataflow');
        if (dataflowEl) {
          var initFlow = archData.initFlow ?? [];
          var eventFlow = archData.eventFlow ?? [];
          var apiDataFlow = archData.apiDataFlow ?? [];
          dataflowEl.innerHTML = (initFlow.length > 0 ? Components.section('核心初始化流程', initFlow.map(function(s) {
            return Components.skillRow(s.step, s.desc);
          }).join(''), { icon: '🚀', badge: initFlow.length + '步', variant: 'accent', accentColor: 'primary' }) : '') + (eventFlow.length > 0 ? Components.section('事件驱动数据流', eventFlow.map(function(e) {
            return Components.skillRow(e.event, e.flow);
          }).join(''), { icon: '⚡', badge: eventFlow.length + '事件', variant: 'bordered' }) : '') + (apiDataFlow.length > 0 ? Components.section('API → Store → Render 数据流', apiDataFlow.map(function(s) {
            return Components.skillRow(s.step, s.desc);
          }).join(''), { icon: '📊', badge: apiDataFlow.length + '层', variant: 'collapsible' }) : '');
        }

        var persistEl = $('arch-persistence');
        if (persistEl) {
          var persistMap = archData.persistenceMap ?? [];
          persistEl.innerHTML = persistMap.length > 0 ? '<div class="table-wrap"><table class="persist-table"><thead><tr>' +
            '<th>模块</th><th>持久化路径</th><th>写入策略</th>' +
            '</tr></thead><tbody>' +
            persistMap.map(function(p) {
              return '<tr><td class="persist-module">' + escapeHtml(p.module) + '</td>' +
                '<td class="persist-path">' + escapeHtml(p.path) + '</td>' +
                '<td><span class="badge badge-blue badge-xs">' + escapeHtml(p.strategy) + '</span></td></tr>';
            }).join('') + '</tbody></table></div>' : '';
        }
      });
    },

    audit: function() {
      safeRender(function() {
        var query = UIState.auditSearchQuery || '';
        var q = query.toLowerCase();
        var entries = (Store.get('audit') ?? []).filter(function(e) {
          if (!q) return true;
          var agentMatch = (e.agentId || '').toLowerCase().indexOf(q) >= 0;
          var actionMatch = (e.action || '').toLowerCase().indexOf(q) >= 0;
          var targetMatch = (e.target || '').toLowerCase().indexOf(q) >= 0;
          return agentMatch || actionMatch || targetMatch;
        });
        var tbody = $('audit-table');
        tbody = tbody ? tbody.querySelector('tbody') : null;
        if (!tbody) return;
        if (!entries.length) {
          tbody.innerHTML = Components.tableEmpty(6, '暂无审计日志数据');
          return;
        }
        var shown = entries.slice(-50).reverse();
        updateHTML(tbody, shown.map(function(e) {
          var ts = e.timestamp && !isNaN(new Date(e.timestamp).getTime()) ? new Date(e.timestamp).toLocaleString('zh-CN') : '—';
          var resultClass = e.result === 'allowed' || e.result === 'success' ? 'badge-green' : e.result === 'denied' || e.result === 'failed' ? 'badge-red' : 'badge-yellow';
          var resultText = e.result === 'allowed' || e.result === 'success' ? '通过' : e.result === 'denied' || e.result === 'failed' ? '拒绝' : e.result || '—';
          return '<tr>' +
            '<td class="table-nowrap table-xs">' + escapeHtml(ts) + '</td>' +
            '<td>' + escapeHtml(e.agentId || '—') + '</td>' +
            '<td>' + escapeHtml(e.action || '—') + '</td>' +
            '<td class="table-truncate">' + escapeHtml(e.target || '—') + '</td>' +
            '<td><span class="badge ' + escapeAttr(resultClass) + '">' + escapeHtml(resultText) + '</span></td>' +
            '<td class="table-truncate table-xs">' + escapeHtml(e.details || '') + '</td></tr>';
        }).join(''));
      });
    },

    design: function() {
      safeRender(function() {
        var stats = Store.get('designStats') ?? {};
        var presets = Store.get('designPresets') ?? {};

        var metricsEl = $('design-overview-metrics');
        if (metricsEl) {
          metricsEl.innerHTML = [
            Components.statCard('🎨', '反模式规则', stats.antiPatternRules ?? 0, '条设计规则', 'c-primary', 'var(--primary-glow)', 'var(--primary-light)'),
            Components.statCard('🔤', '排版级别', stats.typographyLevels ?? 0, '级字体阶梯', 'c-purple', 'rgba(167,139,250,.12)', 'var(--purple)'),
            Components.statCard('📐', '间距令牌', stats.spacingTokens ?? 0, '个间距值', 'c-cyan', 'rgba(6,182,212,.12)', 'var(--cyan)'),
            Components.statCard('🎯', '动效预设', stats.motionPresets ?? 0, '种动效方案', 'c-success', 'var(--success-glow)', 'var(--success)')
          ].join('');
        }

        var typoEl = $('design-typography-panel');
        if (typoEl) {
          var typo = presets.typography ?? {};
          var spacing = presets.spacing ?? {};
          var typoRows = Object.keys(typo).map(function(level) {
            var t = typo[level];
            return '<div class="phase-skill-row"><div class="phase-skill-name" style="font-weight:' + escapeAttr(t.weight) + '">' + escapeHtml(level) + '</div>' +
              '<div class="phase-skill-detail">' + escapeHtml(t.size) + ' / ' + escapeHtml(t.lineHeight) + ' / w' + t.weight + ' / ' + escapeHtml(t.tracking) + '</div></div>';
          }).join('');
          var spacingKeys = Object.keys(spacing);
          var spacingRows = spacingKeys.slice(0, 12).map(function(k) {
            return '<span class="skill-tag infra">' + escapeHtml(k) + ': ' + escapeHtml(spacing[k]) + '</span>';
          }).join('');
          typoEl.innerHTML = Components.section('字体阶梯', typoRows, { icon: '🔤', badge: '10', variant: 'accent', accentColor: 'purple' }) +
            Components.section('间距令牌', '<div class="agent-skills">' + spacingRows + '</div>', { icon: '📐', badge: '4px', variant: 'accent', accentColor: 'cyan' });
        }

        var colorEl = $('design-color-panel');
        if (colorEl) {
          var colorSystems = presets.colorSystems ?? [];
          var colorValues = presets.colorValues ?? {};
          var colorHtml = '';
          colorSystems.forEach(function(sysName) {
            var shades = colorValues[sysName] ?? {};
            colorHtml += '<div style="margin-bottom:var(--space-3)"><div class="phase-skill-name" style="margin-bottom:var(--space-2)">' + escapeHtml(sysName) + '</div>' +
              '<div class="color-swatch-grid">';
            [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].forEach(function(shade) {
              var hex = shades[shade] || '#333';
              colorHtml += '<div class="color-swatch" style="background:' + escapeAttr(hex) + '" title="' + escapeAttr(sysName + '-' + shade + ': ' + hex) + '"></div>';
            });
            colorHtml += '</div></div>';
          });
          colorEl.innerHTML = Components.section('色彩系统', colorHtml || Components.emptyState('', '暂无色彩系统数据'), { icon: '🎨', badge: colorSystems.length + '套', variant: 'bordered' });
        }

        var respEl = $('design-responsive-panel');
        if (respEl) {
          var bps = presets.responsiveBreakpoints ?? [];
          var bpValues = presets.responsiveValues ?? {};
          var bpRows = bps.map(function(bp) {
            var bpData = bpValues[bp] ?? {};
            var detail = bpData.minWidth ? 'min-width: ' + bpData.minWidth : 'base';
            if (bpData.maxWidth && bpData.maxWidth !== Infinity) detail += ' / max-width: ' + bpData.maxWidth;
            if (bpData.container) detail += ' / container: ' + bpData.container;
            if (bpData.columns) detail += ' / cols: ' + bpData.columns;
            return '<div class="phase-skill-row"><div class="phase-skill-name">' + escapeHtml(bp) + '</div>' +
              '<div class="phase-skill-detail">' + escapeHtml(detail) + '</div></div>';
          }).join('');
          respEl.innerHTML = bpRows ? Components.section('断点系统', bpRows, { icon: '📱', badge: bps.length + '级', variant: 'collapsible' }) : Components.emptyState('', '暂无响应式断点数据');
        }

        var motionEl = $('design-motion-panel');
        if (motionEl) {
          var motionNames = presets.motionPresets ?? [];
          var motionValues = presets.motionValues ?? {};
          var interactionNames = presets.microInteractions ?? [];
          var interactionValues = presets.microInteractionValues ?? {};
          var motionRows = motionNames.map(function(name) {
            var mData = motionValues[name] ?? {};
            var tip = mData.duration ? name + ': ' + mData.duration + 'ms' : name;
            return '<span class="skill-tag" title="' + escapeAttr(tip) + '">' + escapeHtml(name) + '</span>';
          }).join('');
          var interactionRows = interactionNames.map(function(name) {
            var iData = interactionValues[name] ?? {};
            var tip = iData.duration ? name + ': ' + iData.duration + 'ms' : name;
            return '<span class="skill-tag infra" title="' + escapeAttr(tip) + '">' + escapeHtml(name) + '</span>';
          }).join('');
          motionEl.innerHTML = Components.section('动效预设', '<div class="agent-skills">' + motionRows + '</div>', { icon: '🎯', badge: motionNames.length + '种', variant: 'accent', accentColor: 'success' }) +
            Components.section('微交互', '<div class="agent-skills">' + interactionRows + '</div>', { icon: '✨', badge: interactionNames.length + '种', variant: 'collapsible', defaultCollapsed: true });
        }

        var a11yEl = $('design-accessibility-panel');
        if (a11yEl) {
          var a11yAspects = presets.accessibilityStandards ?? [];
          var a11yValues = presets.accessibilityValues ?? {};
          var stateNames = presets.interactionStates ?? [];
          var a11yRows = a11yAspects.map(function(a) {
            var aData = a11yValues[a] ?? {};
            var tip = typeof aData === 'string' ? aData : (aData.description || a);
            return '<span class="skill-tag" title="' + escapeAttr(tip) + '">' + escapeHtml(a) + '</span>';
          }).join('');
          var stateRows = stateNames.map(function(s) {
            return '<span class="skill-tag infra">' + escapeHtml(s) + '</span>';
          }).join('');
          a11yEl.innerHTML = Components.section('WCAG AA 标准', '<div class="agent-skills">' + a11yRows + '</div>', { icon: '♿', badge: a11yAspects.length + '项', variant: 'accent', accentColor: 'danger' }) +
            Components.section('交互状态', '<div class="agent-skills">' + stateRows + '</div>', { icon: '🔄', badge: stateNames.length + '种', variant: 'collapsible', defaultCollapsed: true });
        }

        var compEl = $('design-components-panel');
        if (compEl) {
          var compNames = presets.componentTokens ?? [];
          var compValues = presets.componentValues ?? {};
          var varianceNames = presets.varianceLevels ?? [];
          var varianceValues = presets.varianceValues ?? {};
          var compRows = compNames.map(function(c) {
            var cData = compValues[c] ?? {};
            var tip = typeof cData === 'string' ? cData : (cData.description || c);
            return '<span class="skill-tag" title="' + escapeAttr(tip) + '">' + escapeHtml(c) + '</span>';
          }).join('');
          var varRows = varianceNames.map(function(v) {
            var vData = varianceValues[v] ?? {};
            var tip = typeof vData === 'string' ? vData : (vData.description || v);
            return '<span class="skill-tag infra" title="' + escapeAttr(tip) + '">' + escapeHtml(v) + '</span>';
          }).join('');
          compEl.innerHTML = Components.section('组件令牌', '<div class="agent-skills">' + compRows + '</div>', { icon: '🧩', badge: compNames.length + '个', variant: 'bordered', description: '设计系统核心组件的令牌定义' }) +
            Components.section('设计方差级别', '<div class="agent-skills">' + varRows + '</div>', { icon: '📊', badge: varianceNames.length + '级', variant: 'collapsible', defaultCollapsed: true }) +
            Components.section('Section 组件预览', Components.borderedSection('默认变体', '<p style="margin:0;color:var(--text2)">标准 Section 内容区域，支持标题、描述和内容。</p>', { description: '带描述的默认变体', icon: '📦', badge: '默认' }) +
              Components.accentSection('强调色变体', '<p style="margin:0;color:var(--text2)">左侧彩色边框突出重要区域。</p>', { accentColor: 'success', icon: '✅', badge: '成功' }) +
              Components.heroSection('英雄区变体', '<p style="margin:0;color:var(--text2)">大号标题和主色下划线，适合页面主区域。</p>', { icon: '🚀', badge: '主区' }), { icon: '🎨', badge: '5种', variant: 'collapsible', defaultCollapsed: true, description: '5 种变体 × 3 种间距 × 6 种强调色' });
        }

        var contrastEl = $('design-contrast-panel');
        if (contrastEl) {
          contrastEl.innerHTML =
            '<div class="contrast-form">' +
            '<div class="contrast-field"><label>前景色</label>' +
            '<input type="text" id="contrast-fg" value="#ffffff" placeholder="#rrggbb"></div>' +
            '<div class="contrast-field"><label>背景色</label>' +
            '<input type="text" id="contrast-bg" value="#000000" placeholder="#rrggbb"></div>' +
            '<button id="contrast-check-btn" class="contrast-btn">检测</button>' +
            '</div>' +
            '<div id="contrast-result" class="contrast-result"></div>';
          var checkBtn = $('contrast-check-btn');
          var _contrastAbortCtrl = null;
          if (checkBtn) {
            var _onContrastCheck = function() {
              var fg = ($('contrast-fg') ?? {}).value || '';
              var bg = ($('contrast-bg') ?? {}).value || '';
              var hexPattern = /^#[0-9a-fA-F]{6}$/;
              var resultEl = $('contrast-result');
              if (!resultEl) return;
              if (!hexPattern.test(fg) || !hexPattern.test(bg)) {
                resultEl.innerHTML = '<span class="contrast-error">请输入有效的十六进制颜色值（如 #ffffff）</span>';
                return;
              }
              if (_contrastAbortCtrl) { try { _contrastAbortCtrl.abort(); } catch (e) { if (CONFIG.DEBUG) console.warn('contrast abort failed:', e); } }
              _contrastAbortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
              checkBtn.disabled = true;
              checkBtn.textContent = '检测中...';
              _fetchWithTimeout(API + '/api/design/contrast-check?fg=' + encodeURIComponent(fg) + '&bg=' + encodeURIComponent(bg), _contrastAbortCtrl ? { signal: _contrastAbortCtrl.signal } : undefined)
                .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function(data) {
                  if (data.error) {
                    resultEl.innerHTML = '<span class="contrast-error">' + escapeHtml(data.error) + '</span>';
                    return;
                  }
                  var ratio = Number.isFinite(parseFloat(data.ratio)) ? parseFloat(data.ratio) : 0;
                  var aaColor = data.aa ? 'var(--success)' : 'var(--danger)';
                  var aaaColor = data.aaa ? 'var(--success)' : 'var(--danger)';
                  resultEl.innerHTML =
                    '<div class="contrast-result-row">' +
                    '<div class="contrast-ratio" style="color:' + (ratio >= 4.5 ? 'var(--success)' : ratio >= 3 ? 'var(--warning)' : 'var(--danger)') + '">' + escapeHtml(String(ratio)) + ':1</div>' +
                    '<div><span class="contrast-badge" style="color:' + aaColor + '">AA ' + (data.aa ? '✓' : '✗') + '</span> · <span class="contrast-badge" style="color:' + aaaColor + '">AAA ' + (data.aaa ? '✓' : '✗') + '</span></div>' +
                    '<div class="contrast-preview" style="background:' + escapeAttr(bg) + ';color:' + escapeAttr(fg) + '">示例文本预览</div>' +
                    '</div>';
                })
                .catch(function(e) {
                  if (e && e.name === 'AbortError') return;
                  resultEl.innerHTML = '<span class="text-danger">检测请求失败</span>';
                })
                .finally(function() {
                  checkBtn.disabled = false;
                  checkBtn.textContent = '检测';
                });
            };
            checkBtn.addEventListener('click', _onContrastCheck);
            _managedListeners.push({ el: checkBtn, type: 'click', fn: _onContrastCheck });
          }
        }
        if (DesignSection) DesignSection.initAll();
      });
    },

    panorama: function() {
      safeRender(function() {
        var o = Store.get('overview') ?? {};
        var agents = Store.get('agents') ?? [];
        var skills = Store.get('skills') ?? [];
        var sessions = Store.get('sessions') ?? [];
        var config = Store.get('config') ?? {};

        var v = o.version || '0.0.0';
        var verEl = $('version-badge');
        if (verEl) verEl.textContent = 'v' + v;
        var tddEl = $('tdd-badge');
        if (tddEl) {
          tddEl.textContent = o.tddEnabled ? 'TDD 已启用' : 'TDD 未启用';
          tddEl.className = 'badge ' + (o.tddEnabled ? 'badge-green' : 'badge-red');
        }

        var tokenRatio = o.tokenRatio ?? 0;
        var tokenPct = (tokenRatio * 100).toFixed(1);
        var tokenColorClass = _tokenColorClass(tokenRatio);
        var tokenColorStyle = _tokenColorStyle(tokenRatio);
        var isOverBudget = tokenRatio > 1;

        var statsEl = $('panorama-stats');
        if (statsEl) {
          var projectLabel = o.project ? escapeHtml(o.project) : 'Harness';
          var thSt = Store.get('thoughtsStats') ?? {};
          var trSt = (Store.get('thoughtRetrieverStats') ?? {}).stats ?? {};
          var msSt = (Store.get('modelSelectorStats') ?? {}).stats ?? {};
          var saSt = Store.get('subagentModelStats') ?? {};
          var fwStatus = Store.get('frameworkStatus') ?? {};
          var moduleCount = (fwStatus.modules && fwStatus.modules.total) ? fwStatus.modules.total : 52;
          var moduleLabel = '运行时+权限+门禁';
          if (fwStatus.modules && fwStatus.modules.allLoaded) {
            moduleLabel = moduleCount + '模块已加载';
          }
          var tokenExtra = isOverBudget
            ? '⚠ 超预算 ' + escapeHtml(formatTokens((o.tokensUsed ?? 0) - (o.tokenBudget ?? 0)))
            : '已使用 ' + escapeHtml(formatTokens(o.tokensUsed ?? 0));
          statsEl.innerHTML = [
            Components.statCard('🏗️', '架构模块', moduleCount + '', moduleLabel, 'c-primary', 'var(--primary-glow)', 'var(--primary-light)'),
            Components.statCard('👤', 'Agent角色', agents.length, projectLabel + ' · ' + (o.coverageThreshold ? '覆盖率≥' + o.coverageThreshold + '%' : ''), 'c-purple', 'rgba(167,139,250,.12)', 'var(--purple)'),
            Components.statCard('⚡', '技能总数', skills.length, '个技能+基础设施', 'c-cyan', 'rgba(6,182,212,.12)', 'var(--cyan)'),
            Components.statCard('💰', '令牌使用率', tokenPct + '%', tokenExtra, tokenColorClass + (isOverBudget ? ' token-over-budget' : ''), _tokenGlowStyle(tokenRatio), tokenColorStyle),
            Components.statCard('🧠', '思想记忆', safeNum(thSt.totalThoughts), '检索循环 ' + safeNum(trSt.totalCycles) + ' · ' + (trSt.retrievalMode || 'confidence'), 'c-amber', 'rgba(245,158,11,.12)', 'var(--amber)'),
            Components.statCard('🎯', '模型智能', safeNum(msSt.totalTokens), '选择 ' + safeNum(saSt.modelSelections) + ' · 覆盖 ' + safeNum(saSt.modelOverrides), 'c-emerald', 'rgba(16,185,129,.12)', 'var(--emerald)')
          ].join('');
          setTimeout(function() {
            var values = statsEl.querySelectorAll('.stat-value');
            for (var vi = 0; vi < values.length; vi++) {
              values[vi].classList.add('stat-value-updated');
            }
          }, 30);
        }

        Charts.budget(o);
        observeLazy('chart-phase-budget', function() { Charts.phaseBudget(config); });
        observeLazy('chart-enforcement', function() { Charts.enforcement(skills); });
        observeLazy('chart-agent-skills', function() { Charts.agentSkills(agents); });

        Renderers._panoramaRadar(agents, skills);
        Renderers._panoramaPulse(o, sessions);
        Renderers._panoramaTimeline(sessions, skills);

        if (!PanoramaEngine._initialized) {
          PanoramaEngine.init(agents, skills, config);
        } else {
          PanoramaEngine.update(agents, skills, config);
        }
      });
    },

    _panoramaRadar: function(agents, skills) {
      var el = $('panorama-radar');
      if (!el) return;
      var pMeta = Store.get('panoramaMetadata') ?? {};
      var capData = pMeta.agentCapabilities ?? {};
      var dims = capData.dimensions || ['调度', '设计', '实现', '测试', '运维', '文档'];
      var dimMap = capData.scores || {
        'team-lead': [10, 7, 3, 5, 6, 7],
        'domain-analyst': [6, 10, 4, 8, 3, 8],
        'task-worker': [4, 3, 10, 4, 3, 5],
        'quality-assurance': [5, 6, 4, 10, 4, 6],
        'devops-engineer': [5, 2, 3, 4, 10, 4],
        'technical-writer': [3, 4, 2, 3, 3, 10]
      };
      var cx = 100, cy = 100, maxR = 75;
      var n = dims.length;
      var angleStep = (2 * Math.PI) / n;

      function pt(dimIdx, val) {
        var a = -Math.PI / 2 + dimIdx * angleStep;
        var r = (val / 10) * maxR;
        return (cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1);
      }

      var gridLines = '';
      for (var lv = 2; lv <= 10; lv += 2) {
        var pts = [];
        for (var d = 0; d < n; d++) pts.push(pt(d, lv));
        gridLines += '<polygon points="' + pts.join(' ') + '" fill="none" stroke="rgba(148,163,184,.1)" stroke-width="1"/>';
      }
      var axisLines = '';
      for (var d = 0; d < n; d++) {
        axisLines += '<line x1="' + cx + '" y1="' + cy + '" x2="' + pt(d, 10).split(',')[0] + '" y2="' + pt(d, 10).split(',')[1] + '" stroke="rgba(148,163,184,.08)" stroke-width="1"/>';
      }
      var labels = '';
      for (var d = 0; d < n; d++) {
        var a = -Math.PI / 2 + d * angleStep;
        var lx = cx + (maxR + 14) * Math.cos(a);
        var ly = cy + (maxR + 14) * Math.sin(a);
        labels += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" fill="var(--text3)" font-size="10">' + escapeHtml(dims[d]) + '</text>';
      }

      var dataPolygons = '';
      var colors = ['rgba(129,140,248,.25)', 'rgba(167,139,250,.25)', 'rgba(6,182,212,.25)', 'rgba(52,211,153,.25)', 'rgba(251,191,36,.25)', 'rgba(248,113,113,.25)'];
      var strokes = ['#818cf8', '#a78bfa', '#22d3ee', '#34d399', '#fbbf24', '#f87171'];
      agents.forEach(function(ag, idx) {
        var vals = dimMap[ag.id] || [5, 5, 5, 5, 5, 5];
        var pts = [];
        for (var d = 0; d < n; d++) pts.push(pt(d, vals[d]));
        dataPolygons += '<polygon points="' + pts.join(' ') + '" fill="' + colors[idx % colors.length] + '" stroke="' + strokes[idx % strokes.length] + '" stroke-width="1.5" class="radar-poly">' +
          '<animate attributeName="opacity" from="0" to="1" dur="0.5s" fill="freeze" begin="' + (idx * 0.1) + 's"/></polygon>';
      });

      el.innerHTML = '<svg width="200" height="200" viewBox="0 0 200 200" class="panorama-radar-svg" role="img" aria-label="角色能力雷达图">' +
        gridLines + axisLines + dataPolygons + labels + '</svg>' +
        '<div class="radar-legend">' + agents.map(function(ag, idx) {
          return '<span class="radar-legend-item"><span class="radar-legend-dot" style="background:' + strokes[idx % strokes.length] + '"></span>' + escapeHtml(ag.role || ag.id) + '</span>';
        }).join('') + '</div>';
    },

    _panoramaPulse: function(overview, sessions) {
      var el = $('panorama-pulse');
      if (!el) return;
      var metrics = [
        { label: '令牌消耗', value: overview.tokensUsed ?? 0, max: overview.tokenBudget ?? 1e9, color: 'var(--primary)', unit: '' },
        { label: '活跃会话', value: overview.activeSessions ?? 0, max: Math.max(overview.totalSessions ?? 1, 1), color: 'var(--cyan)', unit: '' },
        { label: '技能完成', value: sessions.reduce(function(s, ss) { return s + (ss.completedSkills ?? []).length; }, 0), max: Math.max(sessions.length * 10, 1), color: 'var(--success)', unit: '' },
        { label: '迭代轮次', value: sessions.reduce(function(s, ss) { return s + (ss.iterationCount ?? 0); }, 0), max: 100, color: 'var(--warning)', unit: '' }
      ];
      el.innerHTML = metrics.map(function(m) {
        var pct = m.max > 0 ? Math.min((m.value / m.max) * 100, 100) : 0;
        return '<div class="pulse-metric">' +
          '<div class="pulse-metric-header"><span class="pulse-metric-label">' + escapeHtml(m.label) + '</span><span class="pulse-metric-value" style="color:' + escapeAttr(m.color) + '">' + (m.value > 999 ? formatTokens(m.value) : safeNum(m.value)) + '</span></div>' +
          '<div class="pulse-bar"><div class="pulse-bar-fill" style="width:' + pct.toFixed(1) + '%;background:' + escapeAttr(m.color) + '"></div><div class="pulse-bar-glow" style="left:' + pct.toFixed(1) + '%;background:' + escapeAttr(m.color) + '"></div></div>' +
          '</div>';
      }).join('');
    },

    _panoramaTimeline: function(sessions, skills) {
      var el = $('panorama-timeline');
      if (!el) return;
      var phases = ['需求探索', '需求分析', '架构设计', '模块开发', '集成测试', '部署上线'];
      var phaseKeys = ['brainstorming', 'requirement-analysis', 'architecture-design', 'module-development', 'integration-testing', 'deployment'];
      var phaseColors = ['#818cf8', '#a78bfa', '#22d3ee', '#34d399', '#fbbf24', '#f87171'];
      var phaseIcons = ['🔍', '📊', '🏗️', '⚡', '🧪', '🚀'];
      var skillCounts = {};
      (skills ?? []).forEach(function(s) {
        var p = s.phase || 'unknown';
        var idx = phaseKeys.indexOf(p);
        if (idx >= 0) {
          skillCounts[idx] = (skillCounts[idx] ?? 0) + 1;
        } else {
          skillCounts[p] = (skillCounts[p] ?? 0) + 1;
        }
      });
      var rawPhase = sessions.length > 0 ? (sessions[0].currentPhase ?? 0) : -1;
      var activePhase = typeof rawPhase === 'string' ? phaseKeys.indexOf(rawPhase) : (+rawPhase ?? 0);
      el.innerHTML = '<div class="timeline-track">' + phases.map(function(p, i) {
        var isActive = i === activePhase;
        var isPast = i < activePhase;
        var count = (skillCounts[i] ?? skillCounts[String(i)] ?? skillCounts[phaseKeys[i]]) ?? 0;
        return '<div class="timeline-node' + (isActive ? ' active' : '') + (isPast ? ' past' : '') + '">' +
          '<div class="timeline-dot" style="background:' + (isActive || isPast ? phaseColors[i] : 'var(--surface3)') + ';box-shadow:' + (isActive ? '0 0 12px ' + phaseColors[i] : 'none') + '">' +
          '<span class="timeline-dot-icon">' + phaseIcons[i] + '</span></div>' +
          '<div class="timeline-label">' + escapeHtml(p) + '</div>' +
          '<div class="timeline-count">' + count + ' 技能</div>' +
          (i < phases.length - 1 ? '<div class="timeline-connector' + (isPast ? ' past' : '') + '" style="' + (isPast ? 'background:' + phaseColors[i] : '') + '"></div>' : '') +
          '</div>';
      }).join('') + '</div>';
    },

    deepening: function() {
      safeRender(function() {
        var metrics = Store.get('deepeningMetrics') ?? {};
        var cache = Store.get('deepeningCache') ?? {};
        var metricsData = metrics.dashboard ?? {};
        var convergenceRate = metricsData.convergenceRate ?? 0;
        var avgDuration = metricsData.averageIterationDuration ?? 0;
        var totalMetrics = metricsData.totalMetrics ?? 0;
        var cacheStats = cache.stats ?? {};
        var cacheHitRate = cacheStats.hitRate ?? 0;

        var overviewEl = $('deepening-overview-metrics');
        if (overviewEl) {
          overviewEl.innerHTML = [
            Components.statCard('🔄', '收敛率', (convergenceRate * 100).toFixed(1) + '%', '迭代收敛比率', 'c-success', 'var(--success-glow)', 'var(--success)'),
            Components.statCard('⏱️', '平均迭代耗时', avgDuration + 'ms', '每次迭代平均时长', 'c-primary', 'var(--primary-glow)', 'var(--primary-light)'),
            Components.statCard('📊', '指标总数', totalMetrics, '已采集指标点数', 'c-purple', 'rgba(167,139,250,.12)', 'var(--purple)'),
            Components.statCard('💾', '缓存命中率', (cacheHitRate * 100).toFixed(1) + '%', '迭代结果缓存效率', 'c-warning', 'var(--warning-glow)', 'var(--warning)')
          ].join('');
        }

        var qualityEl = $('deepening-quality-trend');
        if (qualityEl) {
          var recentQuality = metricsData.recentQuality ?? [];
          if (recentQuality.length === 0) {
            qualityEl.innerHTML = Components.emptyState('', '暂无质量趋势数据');
          } else {
            var maxScore = Math.max.apply(null, recentQuality.map(function(q) { return q.value ?? 0; }));
            var bars = recentQuality.map(function(q, i) {
              var pct = maxScore > 0 ? ((q.value ?? 0) / maxScore * 100) : 0;
              var color = q.value >= 0.85 ? 'var(--success)' : q.value >= 0.6 ? 'var(--warning)' : 'var(--danger)';
              return '<div class="chart-bar-row">' +
                '<div class="chart-bar-label" style="width:30px">I' + (i + 1) + '</div>' +
                '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + escapeAttr(String(pct)) + '%;background:' + escapeAttr(color) + '"></div></div>' +
                '<div class="chart-bar-value" style="color:' + escapeAttr(color) + '">' + safeNum((q.value ?? 0).toFixed(3)) + '</div></div>';
            }).join('');
            qualityEl.innerHTML = Components.section('质量趋势', '<div class="chart-bars">' + bars + '</div>', { icon: '📈', badge: recentQuality.length + '次', variant: 'accent', accentColor: 'success' });
          }
        }

        DEEPENING_STATS_PANELS.forEach(function(cfg) {
          _renderDeepeningStatsPanel(cfg.elId, cfg.storeKey, cfg);
        });
      });
    },

    collaboration: function() {
      Charts.collaboration();
    },

    knowledge: function() {
      safeRender(function() {
        var sqliteData = Store.get('sqliteStats') ?? {};
        var memoryEntriesData = Store.get('memoryEntries') ?? {};
        var memoryUsageData = Store.get('memoryUsage') ?? {};
        var userProfileData = Store.get('userProfile') ?? {};
        var improvementPendingData = Store.get('skillImprovementPending') ?? {};
        var improvementStatsData = Store.get('skillImprovementStats') ?? {};
        var creationListData = Store.get('skillCreationList') ?? {};
        var creationStatsData = Store.get('skillCreationStats') ?? {};
        var curatorStatsData = Store.get('skillCuratorStats') ?? {};
        var nudgeStatsData = Store.get('nudgeStats') ?? {};
        var mcpStatusData = Store.get('mcpStatus') ?? {};
        var mcpToolsData = Store.get('mcpTools') ?? {};
        var affinityStatsData = Store.get('affinityStats') ?? {};
        var affinityRecordsData = Store.get('affinityRecords') ?? {};

        var stats = sqliteData.stats ?? {};
        var overviewEl = $('knowledge-overview-metrics');
        if (overviewEl) {
          overviewEl.innerHTML = [
            Components.statCard('🗄️', '知识条目', safeNum(stats.knowledge), 'SQLite知识库', 'c-primary', 'var(--primary-glow)', 'var(--primary-light)'),
            Components.statCard('🧠', '记忆条目', safeNum(stats.memoryEntries), '持久化记忆', 'c-success', 'var(--success-glow)', 'var(--success)'),
            Components.statCard('⚡', '亲和度记录', safeNum(stats.affinityRecords), 'Agent-任务亲和度', 'c-warning', 'var(--warning-glow)', 'var(--warning)'),
            Components.statCard('🔧', '技能学习', safeNum(stats.skillLearnings), '技能改进经验', 'c-info', 'var(--cyan-glow)', 'var(--cyan)')
          ].join('');
        }

        var sqliteEl = $('knowledge-sqlite-detail');
        if (sqliteEl) {
          var sHtml = '<div class="detail-grid">';
          sHtml += '<div class="detail-item"><span class="detail-label">知识条目</span><span class="detail-value">' + safeNum(stats.knowledge) + '</span></div>';
          sHtml += '<div class="detail-item"><span class="detail-label">会话摘要</span><span class="detail-value">' + safeNum(stats.sessionSummaries) + '</span></div>';
          sHtml += '<div class="detail-item"><span class="detail-label">技能学习</span><span class="detail-value">' + safeNum(stats.skillLearnings) + '</span></div>';
          sHtml += '<div class="detail-item"><span class="detail-label">记忆条目</span><span class="detail-value">' + safeNum(stats.memoryEntries) + '</span></div>';
          sHtml += '<div class="detail-item"><span class="detail-label">用户偏好键</span><span class="detail-value">' + safeNum(stats.userProfileKeys) + '</span></div>';
          sHtml += '<div class="detail-item"><span class="detail-label">亲和度记录</span><span class="detail-value">' + safeNum(stats.affinityRecords) + '</span></div>';
          var mu = stats.memoryUsage ?? {};
          sHtml += '<div class="detail-item"><span class="detail-label">记忆使用率</span><span class="detail-value">' + safeNum(mu.percentage) + '%</span></div>';
          var uu = stats.userUsage ?? {};
          sHtml += '<div class="detail-item"><span class="detail-label">用户画像使用率</span><span class="detail-value">' + safeNum(uu.percentage) + '%</span></div>';
          sHtml += '</div>';
          sqliteEl.innerHTML = sHtml;
        }

        var memEl = $('knowledge-memory-detail');
        if (memEl) {
          var memUsage = memoryUsageData.memory ?? {};
          var userUsage = memoryUsageData.user ?? {};
          var mHtml = '<div class="detail-grid">';
          mHtml += '<div class="detail-item"><span class="detail-label">记忆条目数</span><span class="detail-value">' + safeNum(memUsage.entries) + '</span></div>';
          mHtml += '<div class="detail-item"><span class="detail-label">记忆使用量</span><span class="detail-value">' + safeNum(memUsage.total) + '/' + safeNum(memUsage.limit) + ' 字符</span></div>';
          mHtml += '<div class="detail-item"><span class="detail-label">记忆使用率</span><span class="detail-value">' + safeNum(memUsage.percentage) + '%</span></div>';
          mHtml += '<div class="detail-item"><span class="detail-label">用户画像条目</span><span class="detail-value">' + safeNum(userUsage.entries) + '</span></div>';
          mHtml += '<div class="detail-item"><span class="detail-label">用户画像使用量</span><span class="detail-value">' + safeNum(userUsage.total) + '/' + safeNum(userUsage.limit) + ' 字符</span></div>';
          mHtml += '<div class="detail-item"><span class="detail-label">用户画像使用率</span><span class="detail-value">' + safeNum(userUsage.percentage) + '%</span></div>';
          mHtml += '</div>';
          memEl.innerHTML = mHtml;
        }

        var userEl = $('knowledge-user-profile-detail');
        if (userEl) {
          var prefs = userProfileData.preferences ?? {};
          var uHtml = '';
          if (Object.keys(prefs).length === 0) {
            uHtml = Components.emptyState('', '暂无用户画像数据');
          } else {
            uHtml = '<div class="detail-grid">';
            for (var pk in prefs) {
              if (!Object.prototype.hasOwnProperty.call(prefs, pk)) continue;
              var pv = prefs[pk];
              var displayVal = (pv == null) ? '—' : (Array.isArray(pv) ? pv.join(', ') : (typeof pv === 'object' ? JSON.stringify(pv) : String(pv)));
              uHtml += '<div class="detail-item"><span class="detail-label">' + escapeHtml(pk) + '</span><span class="detail-value">' + escapeHtml(displayVal) + '</span></div>';
            }
            uHtml += '</div>';
          }
          userEl.innerHTML = uHtml;
        }

        var affEl = $('knowledge-affinity-detail');
        if (affEl) {
          var affStats = affinityStatsData.stats ?? {};
          var affRecords = affinityRecordsData.records ?? [];
          var aHtml = '<div class="detail-grid">';
          aHtml += '<div class="detail-item"><span class="detail-label">总亲和度数</span><span class="detail-value">' + safeNum(affStats.totalAffinities) + '</span></div>';
          aHtml += '<div class="detail-item"><span class="detail-label">总执行记录</span><span class="detail-value">' + safeNum(affStats.totalRecords) + '</span></div>';
          aHtml += '<div class="detail-item"><span class="detail-label">已知Agent</span><span class="detail-value">' + safeNum(affStats.knownAgents) + '</span></div>';
          aHtml += '<div class="detail-item"><span class="detail-label">已知任务类型</span><span class="detail-value">' + safeNum(affStats.knownTaskTypes) + '</span></div>';
          aHtml += '<div class="detail-item"><span class="detail-label">持久化存储</span><span class="detail-value">' + (affStats.hasPersistentStore ? '✅ SQLite' : '❌ 内存') + '</span></div>';
          aHtml += '</div>';
          if (affRecords.length > 0) {
            aHtml += '<div style="margin-top:8px;font-size:12px;color:var(--text-secondary)">最近记录:</div>';
            aHtml += '<div class="detail-grid">';
            for (var ai = 0; ai < Math.min(affRecords.length, 6); ai++) {
              var ar = affRecords[ai];
              aHtml += '<div class="detail-item"><span class="detail-label">' + escapeHtml(ar.agent_id || '') + ' → ' + escapeHtml(ar.task_type || '') + '</span><span class="detail-value">' + safeNum((ar.score ?? 0).toFixed(2)) + ' (' + safeNum(ar.samples) + '次)</span></div>';
            }
            aHtml += '</div>';
          }
          affEl.innerHTML = aHtml;
        }

        var impEl = $('knowledge-skill-improvement-detail');
        if (impEl) {
          var impStats = improvementStatsData.stats ?? {};
          var impPatches = improvementPendingData.patches ?? {};
          var iHtml = '<div class="detail-grid">';
          iHtml += '<div class="detail-item"><span class="detail-label">待处理补丁</span><span class="detail-value">' + safeNum(impStats.pendingPatches) + '</span></div>';
          iHtml += '<div class="detail-item"><span class="detail-label">总学习记录</span><span class="detail-value">' + safeNum(impStats.totalLearnings) + '</span></div>';
          iHtml += '<div class="detail-item"><span class="detail-label">自动改进阈值</span><span class="detail-value">' + safeNum(impStats.autoImproveThreshold ?? 3) + '次</span></div>';
          iHtml += '</div>';
          var patchKeys = Object.keys(impPatches);
          if (patchKeys.length > 0) {
            iHtml += '<div style="margin-top:8px;font-size:12px;color:var(--text-secondary)">待处理改进:</div>';
            for (var pi = 0; pi < patchKeys.length; pi++) {
              var patch = impPatches[patchKeys[pi]];
              iHtml += '<div style="margin-top:4px;padding:4px 8px;background:var(--surface2);border-radius:4px;font-size:12px">';
              iHtml += '<strong>' + escapeHtml(patchKeys[pi]) + '</strong>: ' + (patch.tips ? patch.tips.length : 0) + ' tips, ' + (patch.avoidances ? patch.avoidances.length : 0) + ' avoidances';
              iHtml += '</div>';
            }
          }
          impEl.innerHTML = iHtml;
        }

        var nudgeEl = $('knowledge-nudge-detail');
        if (nudgeEl) {
          var nStats = nudgeStatsData.stats ?? {};
          var nHtml = '<div class="detail-grid">';
          nHtml += '<div class="detail-item"><span class="detail-label">触发次数</span><span class="detail-value">' + safeNum(nStats.nudgesTriggered) + '</span></div>';
          nHtml += '<div class="detail-item"><span class="detail-label">保存记忆</span><span class="detail-value">' + safeNum(nStats.memoriesSaved) + '</span></div>';
          nHtml += '<div class="detail-item"><span class="detail-label">跳过次数</span><span class="detail-value">' + safeNum(nStats.nudgesSkipped) + '</span></div>';
          nHtml += '<div class="detail-item"><span class="detail-label">规则数量</span><span class="detail-value">' + safeNum(nStats.rules) + '</span></div>';
          nHtml += '</div>';
          nudgeEl.innerHTML = nHtml;
        }

        var creEl = $('knowledge-skill-creation-detail');
        if (creEl) {
          var creStats = creationStatsData.stats ?? {};
          var creList = creationListData.skills ?? [];
          var crHtml = '<div class="detail-grid">';
          crHtml += '<div class="detail-item"><span class="detail-label">已评估</span><span class="detail-value">' + safeNum(creStats.evaluated) + '</span></div>';
          crHtml += '<div class="detail-item"><span class="detail-label">已创建</span><span class="detail-value">' + safeNum(creStats.created) + '</span></div>';
          crHtml += '<div class="detail-item"><span class="detail-label">已拒绝</span><span class="detail-value">' + safeNum(creStats.rejected) + '</span></div>';
          crHtml += '</div>';
          if (creList.length > 0) {
            crHtml += '<div style="margin-top:8px;font-size:12px;color:var(--text-secondary)">自动创建的技能:</div>';
            for (var ci = 0; ci < Math.min(creList.length, 5); ci++) {
              crHtml += '<div style="margin-top:4px;padding:4px 8px;background:var(--surface2);border-radius:4px;font-size:12px">' + escapeHtml(creList[ci] || '') + '</div>';
            }
          }
          creEl.innerHTML = crHtml;
        }

        var mcpEl = $('knowledge-mcp-detail');
        if (mcpEl) {
          var mcpServers = mcpStatusData.servers ?? {};
          var mcpStats = mcpStatusData.stats ?? {};
          var mcpTools = mcpToolsData.tools ?? [];
          var mcHtml = '<div class="detail-grid">';
          mcHtml += '<div class="detail-item"><span class="detail-label">已连接服务器</span><span class="detail-value">' + safeNum(mcpStats.serversConnected) + '</span></div>';
          mcHtml += '<div class="detail-item"><span class="detail-label">已发现工具</span><span class="detail-value">' + safeNum(mcpStats.toolsDiscovered) + '</span></div>';
          mcHtml += '<div class="detail-item"><span class="detail-label">工具调用</span><span class="detail-value">' + safeNum(mcpStats.toolCalls) + '</span></div>';
          mcHtml += '<div class="detail-item"><span class="detail-label">错误次数</span><span class="detail-value">' + safeNum(mcpStats.errors) + '</span></div>';
          mcHtml += '</div>';
          var serverNames = Object.keys(mcpServers);
          if (serverNames.length > 0) {
            mcHtml += '<div style="margin-top:8px;font-size:12px;color:var(--text-secondary)">服务器状态:</div>';
            for (var si = 0; si < serverNames.length; si++) {
              var sStatus = mcpServers[serverNames[si]];
              var statusText = sStatus.connected ? '✅ 已连接' : '❌ 未连接';
              mcHtml += '<div style="margin-top:4px;padding:4px 8px;background:var(--surface2);border-radius:4px;font-size:12px">' + escapeHtml(serverNames[si]) + ': ' + statusText + '</div>';
            }
          }
          if (mcpTools.length > 0) {
            mcHtml += '<div style="margin-top:8px;font-size:12px;color:var(--text-secondary)">可用工具:</div>';
            for (var ti = 0; ti < Math.min(mcpTools.length, 8); ti++) {
              mcHtml += '<div style="margin-top:2px;padding:2px 8px;background:var(--surface1);border-radius:3px;font-size:11px">' + escapeHtml(mcpTools[ti].name || mcpTools[ti] || '') + '</div>';
            }
          }
          mcpEl.innerHTML = mcHtml;
        }

        var cliAnythingEl = $('knowledge-cli-anything-detail');
        if (cliAnythingEl) {
          var cliHubData = Store.get('cliAnythingHub') ?? {};
          var cliStatusData = Store.get('cliAnythingStatus') ?? {};
          var caHtml = '<div class="detail-grid">';
          caHtml += '<div class="detail-item"><span class="detail-label">MCP连接</span><span class="detail-value">' + (cliStatusData.connected ? '✅ 已连接' : '❌ 未连接') + '</span></div>';
          caHtml += '<div class="detail-item"><span class="detail-label">目录工具数</span><span class="detail-value">' + safeNum(cliHubData.totalCatalogTools) + '</span></div>';
          caHtml += '<div class="detail-item"><span class="detail-label">已安装工具</span><span class="detail-value">' + safeNum(cliHubData.installedTools) + '</span></div>';
          caHtml += '</div>';
          var cliCategories = cliHubData.categories ?? [];
          if (cliCategories.length > 0) {
            caHtml += '<div style="margin-top:8px;font-size:12px;color:var(--text-secondary)">CLI工具目录:</div>';
            for (var cci = 0; cci < cliCategories.length; cci++) {
              var cat = cliCategories[cci];
              caHtml += '<div style="margin-top:6px">';
              caHtml += '<div style="font-size:12px;font-weight:600;color:var(--text-primary)">' + escapeHtml(cat.name ?? '') + '</div>';
              caHtml += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px">';
              var catTools = cat.tools ?? [];
              for (var cti = 0; cti < catTools.length; cti++) {
                caHtml += '<span class="comm-mode-tag" style="font-size:10px">' + escapeHtml(catTools[cti]) + '</span>';
              }
              caHtml += '</div></div>';
            }
          }
          if (cliHubData.hubInstallCommand) {
            caHtml += '<div class="info-box info-box--primary" style="margin-top:8px">';
            caHtml += '<div class="info-box__text" style="font-family:monospace;font-size:11px">' + escapeHtml(cliHubData.hubInstallCommand) + '</div>';
            caHtml += '</div>';
          }
          if (!cliHubData.available && !cliStatusData.available) {
            caHtml += '<div class="info-box info-box--warning"><div class="info-box__text">CLI-Anything MCP服务器未启用。在config.json中设置mcp_servers.cli-anything.enabled=true</div></div>';
          }
          cliAnythingEl.innerHTML = caHtml;
        }

        var curatorEl = $('knowledge-skill-curator-detail');
        if (curatorEl) {
          var curatorStats = curatorStatsData.stats ?? {};
          var cs = curatorStats.curatorStats ?? {};
          var skillStats = curatorStats.skillStats ?? {};
          var curHtml = '<div class="detail-grid">';
          curHtml += '<div class="detail-item"><span class="detail-label">已策划</span><span class="detail-value">' + safeNum(cs.curated) + '</span></div>';
          curHtml += '<div class="detail-item"><span class="detail-label">已归档</span><span class="detail-value">' + safeNum(cs.archived) + '</span></div>';
          curHtml += '<div class="detail-item"><span class="detail-label">已审查</span><span class="detail-value">' + safeNum(cs.reviewed) + '</span></div>';
          curHtml += '<div class="detail-item"><span class="detail-label">跟踪技能数</span><span class="detail-value">' + safeNum(curatorStats.totalTracked) + '</span></div>';
          curHtml += '<div class="detail-item"><span class="detail-label">过期阈值</span><span class="detail-value">' + safeNum(curatorStats.staleThresholdDays ?? 30) + '天</span></div>';
          curHtml += '</div>';
          var skillKeys = Object.keys(skillStats);
          if (skillKeys.length > 0) {
            curHtml += '<div class="info-box info-box--primary" style="margin-top:var(--space-2)">';
            curHtml += '<div class="info-box__title info-box__title--primary">技能使用统计</div>';
            curHtml += '<div class="comm-modes">';
            for (var ski = 0; ski < Math.min(skillKeys.length, 8); ski++) {
              var sks = skillStats[skillKeys[ski]];
              var sr = sks.successRate ?? 0;
              var srColor = sr >= 0.8 ? 'success' : sr >= 0.5 ? 'warning' : 'danger';
              curHtml += '<span class="comm-mode-tag comm-mode-tag--' + srColor + '">' + escapeHtml(skillKeys[ski]) + ': ' + (sr * 100).toFixed(0) + '% (' + safeNum(sks.calls) + '次)</span>';
            }
            curHtml += '</div></div>';
          }
          if (!curatorStatsData.available) {
            curHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载，数据暂不可用</div></div>';
          }
          curatorEl.innerHTML = curHtml;
        }

        var crStatsEl = $('knowledge-command-router-detail');
        if (crStatsEl) {
          var crData = Store.get('commandRouterStats') ?? {};
          var crStats = crData.stats ?? {};
          var crHtml = '<div class="detail-grid">';
          crHtml += '<div class="detail-item"><span class="detail-label">已发现命令</span><span class="detail-value">' + safeNum(crStats.totalCommands) + '</span></div>';
          crHtml += '<div class="detail-item"><span class="detail-label">命令别名</span><span class="detail-value">' + safeNum(crStats.totalAliases) + '</span></div>';
          crHtml += '</div>';
          var byPhase = crStats.commandsByPhase ?? {};
          var phaseKeys = Object.keys(byPhase);
          if (phaseKeys.length > 0) {
            crHtml += '<div style="margin-top:8px"><span class="detail-label">按阶段分布</span></div>';
            crHtml += '<div class="skill-tags" style="margin-top:4px">';
            for (var pi = 0; pi < phaseKeys.length; pi++) {
              crHtml += '<span class="skill-tag skill-tag--' + (pi % 4) + '">' + escapeHtml(phaseKeys[pi]) + ' (' + safeNum(byPhase[phaseKeys[pi]]) + ')</span>';
            }
            crHtml += '</div>';
          }
          if (!crData.available) {
            crHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载</div></div>';
          }
          crStatsEl.innerHTML = crHtml;
        }

        var phStatsEl = $('knowledge-programmable-hook-detail');
        if (phStatsEl) {
          var phData = Store.get('programmableHookStats') ?? {};
          var phStats = phData.stats ?? {};
          var phHtml = '<div class="detail-grid">';
          phHtml += '<div class="detail-item"><span class="detail-label">已注册钩子</span><span class="detail-value">' + safeNum(phStats.totalHooks) + '</span></div>';
          phHtml += '<div class="detail-item"><span class="detail-label">内置处理器</span><span class="detail-value">' + safeNum(phStats.builtinCount) + '</span></div>';
          phHtml += '</div>';
          var byEvent = phStats.hooksByEvent ?? {};
          var evtKeys = Object.keys(byEvent);
          if (evtKeys.length > 0) {
            phHtml += '<div style="margin-top:8px"><span class="detail-label">事件分布</span></div>';
            phHtml += '<div class="skill-tags" style="margin-top:4px">';
            for (var ei = 0; ei < evtKeys.length; ei++) {
              phHtml += '<span class="skill-tag skill-tag--' + (ei % 4) + '">' + escapeHtml(evtKeys[ei]) + ' (' + safeNum(byEvent[evtKeys[ei]]) + ')</span>';
            }
            phHtml += '</div>';
          }
          if (!phData.available) {
            phHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载</div></div>';
          }
          phStatsEl.innerHTML = phHtml;
        }

        var ccStatsEl = $('knowledge-context-compression-detail');
        if (ccStatsEl) {
          var ccData = Store.get('contextCompressionStats') ?? {};
          var ccStats = ccData.stats ?? {};
          var ccHtml = '<div class="detail-grid">';
          ccHtml += '<div class="detail-item"><span class="detail-label">压缩次数</span><span class="detail-value">' + safeNum(ccStats.totalCompressions) + '</span></div>';
          ccHtml += '<div class="detail-item"><span class="detail-label">平均压缩率</span><span class="detail-value">' + safeNum(((ccStats.avgCompressionRatio ?? 0) * 100).toFixed(1)) + '%</span></div>';
          ccHtml += '<div class="detail-item"><span class="detail-label">节省Token</span><span class="detail-value">' + safeNum(ccStats.totalTokensSaved) + '</span></div>';
          ccHtml += '</div>';
          var ratio = ccStats.avgCompressionRatio ?? 0;
          if (ratio > 0) {
            var barPct = Math.min(100, ratio * 100);
            ccHtml += '<div style="margin-top:8px"><span class="detail-label">压缩效率</span></div>';
            ccHtml += '<div class="progress-bar" style="margin-top:4px" role="progressbar" aria-valuenow="' + barPct + '" aria-valuemin="0" aria-valuemax="100" aria-label="压缩率"><div class="progress-bar__fill" style="width:' + barPct + '%;background:var(--success)"></div></div>';
          }
          if (!ccData.available) {
            ccHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载</div></div>';
          }
          ccStatsEl.innerHTML = ccHtml;
        }

        var hookMonEl = $('knowledge-hook-monitor-detail');
        if (hookMonEl) {
          var hmData = Store.get('hookMonitorData') ?? {};
          var hmGlobal = (hmData.data && hmData.data.global) ? hmData.data.global : {};
          var hmHtml = '<div class="detail-grid">';
          hmHtml += '<div class="detail-item"><span class="detail-label">总调用次数</span><span class="detail-value">' + safeNum(hmGlobal.calls) + '</span></div>';
          hmHtml += '<div class="detail-item"><span class="detail-label">成功率</span><span class="detail-value">' + safeNum(hmGlobal.successRate ?? 100) + '%</span></div>';
          hmHtml += '<div class="detail-item"><span class="detail-label">平均延迟</span><span class="detail-value">' + safeNum(hmGlobal.avgLatencyMs) + 'ms</span></div>';
          hmHtml += '<div class="detail-item"><span class="detail-label">慢钩子数</span><span class="detail-value" style="color:' + ((hmData.data && hmData.data.slowHookCount > 0) ? 'var(--warning)' : 'var(--success)') + '">' + safeNum((hmData.data && hmData.data.slowHookCount) ?? 0) + '</span></div>';
          hmHtml += '</div>';
          var sr = hmGlobal.successRate ?? 100;
          if (hmGlobal.calls > 0) {
            hmHtml += '<div style="margin-top:8px"><span class="detail-label">成功率</span></div>';
            hmHtml += '<div class="progress-bar" style="margin-top:4px" role="progressbar" aria-valuenow="' + sr + '" aria-valuemin="0" aria-valuemax="100" aria-label="健康检查成功率"><div class="progress-bar__fill" style="width:' + sr + '%;background:' + (sr >= 90 ? 'var(--success)' : sr >= 70 ? 'var(--warning)' : 'var(--danger)') + '"></div></div>';
          }
          if (!hmData.available) {
            hmHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载</div></div>';
          }
          hookMonEl.innerHTML = hmHtml;
        }

        var apEl = $('knowledge-agent-packs-detail');
        if (apEl) {
          var apStats = Store.get('agentPacksStats') ?? {};
          var apStat = apStats.stats ?? {};
          var apHtml = '<div class="detail-grid">';
          apHtml += '<div class="detail-item"><span class="detail-label">Pack总数</span><span class="detail-value">' + safeNum(apStat.totalPacks) + '</span></div>';
          apHtml += '<div class="detail-item"><span class="detail-label">已安装</span><span class="detail-value">' + safeNum(apStat.installedPacks) + '</span></div>';
          apHtml += '<div class="detail-item"><span class="detail-label">可用安装</span><span class="detail-value">' + safeNum(apStat.availablePacks) + '</span></div>';
          apHtml += '</div>';
          if (apStat.categories && Object.keys(apStat.categories).length > 0) {
            apHtml += '<div style="margin-top:8px"><span class="detail-label">分类</span></div>';
            apHtml += '<div class="tag-list" style="margin-top:4px">';
            for (var cat in apStat.categories) {
              if (!Object.prototype.hasOwnProperty.call(apStat.categories, cat)) continue;
              apHtml += '<span class="tag tag-sm">' + escapeHtml(cat) + ': ' + escapeHtml(String(apStat.categories[cat] ?? 0)) + '</span>';
            }
            apHtml += '</div>';
          }
          if (!apStats.available) {
            apHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载</div></div>';
          }
          apEl.innerHTML = apHtml;
        }

        var thEl = $('knowledge-thoughts-detail');
        if (thEl) {
          var thStats = Store.get('thoughtsStats') ?? {};
          var thHtml = '<div class="detail-grid">';
          thHtml += '<div class="detail-item"><span class="detail-label">思想总数</span><span class="detail-value">' + safeNum(thStats.totalThoughts) + '</span></div>';
          thHtml += '<div class="detail-item"><span class="detail-label">平均置信度</span><span class="detail-value">' + safeNum(((thStats.avgConfidence ?? 0) * 100).toFixed(1)) + '%</span></div>';
          thHtml += '</div>';
          if (thStats.byType && Object.keys(thStats.byType).length > 0) {
            thHtml += '<div style="margin-top:8px"><span class="detail-label">按类型</span></div>';
            thHtml += '<div class="tag-list" style="margin-top:4px">';
            for (var tt in thStats.byType) {
              if (!Object.prototype.hasOwnProperty.call(thStats.byType, tt)) continue;
              thHtml += '<span class="tag tag-sm">' + escapeHtml(tt) + ': ' + escapeHtml(String(thStats.byType[tt] ?? 0)) + '</span>';
            }
            thHtml += '</div>';
          }
          var emStats = Store.get('embeddingStats') ?? {};
          thHtml += '<div style="margin-top:8px"><span class="detail-label">嵌入服务</span></div>';
          thHtml += '<div class="detail-grid">';
          thHtml += '<div class="detail-item"><span class="detail-label">Provider</span><span class="detail-value">' + escapeHtml(emStats.provider || 'none') + '</span></div>';
          thHtml += '<div class="detail-item"><span class="detail-label">维度</span><span class="detail-value">' + safeNum(emStats.dimensions) + '</span></div>';
          thHtml += '<div class="detail-item"><span class="detail-label">总嵌入数</span><span class="detail-value">' + safeNum(emStats.totalEmbeddings) + '</span></div>';
          thHtml += '<div class="detail-item"><span class="detail-label">缓存命中</span><span class="detail-value">' + safeNum(emStats.cacheHits) + '</span></div>';
          thHtml += '</div>';

          var trStats = Store.get('thoughtRetrieverStats') ?? {};
          if (trStats.available) {
            var trSt = trStats.stats ?? {};
            thHtml += '<div style="margin-top:8px"><span class="detail-label">思想检索循环</span></div>';
            thHtml += '<div class="detail-grid">';
            thHtml += '<div class="detail-item"><span class="detail-label">总循环</span><span class="detail-value">' + safeNum(trSt.totalCycles) + '</span></div>';
            thHtml += '<div class="detail-item"><span class="detail-label">检索模式</span><span class="detail-value">' + escapeHtml(trSt.retrievalMode || 'confidence') + '</span></div>';
            thHtml += '<div class="detail-item"><span class="detail-label">思想检索</span><span class="detail-value">' + safeNum(trSt.thoughtsRetrieved) + '</span></div>';
            thHtml += '<div class="detail-item"><span class="detail-label">思想提炼</span><span class="detail-value">' + safeNum(trSt.thoughtsDistilled) + '</span></div>';
            thHtml += '<div class="detail-item"><span class="detail-label">去重合并</span><span class="detail-value">' + safeNum(trSt.thoughtsDeduplicated) + '</span></div>';
            thHtml += '<div class="detail-item"><span class="detail-label">语义检索</span><span class="detail-value">' + safeNum(trSt.semanticRetrievals) + '</span></div>';
            thHtml += '<div class="detail-item"><span class="detail-label">混合检索</span><span class="detail-value">' + safeNum(trSt.hybridRetrievals) + '</span></div>';
            thHtml += '<div class="detail-item"><span class="detail-label">嵌入服务</span><span class="detail-value">' + (trSt.hasEmbeddingService ? '已启用' : '未启用') + '</span></div>';
            thHtml += '</div>';
          }

          var msStats = Store.get('modelSelectorStats') ?? {};
          if (msStats.available) {
            var msSt = msStats.stats ?? {};
            thHtml += '<div style="margin-top:8px"><span class="detail-label">模型选择器</span></div>';
            thHtml += '<div class="detail-grid">';
            thHtml += '<div class="detail-item"><span class="detail-label">总Token</span><span class="detail-value">' + safeNum(msSt.totalTokens) + '</span></div>';
            thHtml += '<div class="detail-item"><span class="detail-label">总成本</span><span class="detail-value">$' + safeNum(((msSt.totalCost ?? 0)).toFixed(4)) + '</span></div>';
            thHtml += '<div class="detail-item"><span class="detail-label">节省</span><span class="detail-value">$' + safeNum(((msSt.savingsVsAllPremium ?? 0)).toFixed(4)) + '</span></div>';
            thHtml += '</div>';
            if (msSt.byModel && Object.keys(msSt.byModel).length > 0) {
              thHtml += '<div style="margin-top:4px"><span class="detail-label">模型使用</span></div>';
              thHtml += '<div class="tag-list" style="margin-top:4px">';
              for (var mdl in msSt.byModel) {
                if (!Object.prototype.hasOwnProperty.call(msSt.byModel, mdl)) continue;
                thHtml += '<span class="tag tag-sm">' + escapeHtml(mdl) + ': ' + safeNum(msSt.byModel[mdl].calls) + '次</span>';
              }
              thHtml += '</div>';
            }
          }

          var saStats = Store.get('subagentModelStats') ?? {};
          if (saStats.available) {
            thHtml += '<div style="margin-top:8px"><span class="detail-label">子代理模型</span></div>';
            thHtml += '<div class="detail-grid">';
            thHtml += '<div class="detail-item"><span class="detail-label">模型选择</span><span class="detail-value">' + safeNum(saStats.modelSelections) + '</span></div>';
            thHtml += '<div class="detail-item"><span class="detail-label">模型覆盖</span><span class="detail-value">' + safeNum(saStats.modelOverrides) + '</span></div>';
            thHtml += '</div>';
            if (saStats.activeModels && saStats.activeModels.length > 0) {
              thHtml += '<div style="margin-top:4px"><span class="detail-label">活跃子代理</span></div>';
              for (var ai = 0; ai < saStats.activeModels.length; ai++) {
                var am = saStats.activeModels[ai];
                thHtml += '<div class="detail-grid" style="margin-top:2px">';
                thHtml += '<div class="detail-item"><span class="detail-label">' + escapeHtml(am.agentId) + '</span><span class="detail-value">' + escapeHtml(am.model || 'default') + '</span></div>';
                thHtml += '<div class="detail-item"><span class="detail-label">来源</span><span class="detail-value">' + escapeHtml(am.modelSource || '-') + '</span></div>';
                thHtml += '</div>';
              }
            }
          }

          thEl.innerHTML = thHtml;
        }
      });
    },

    commands: function() {
      safeRender(function() {
        var crStats = Store.get('commandRouterStats') ?? {};
        var crCmds = Store.get('commandRouterCommands') ?? {};
        var phStats = Store.get('programmableHookStats') ?? {};
        var phHooks = Store.get('programmableHooks') ?? {};
        var ccStats = Store.get('contextCompressionStats') ?? {};
        var ccStrats = Store.get('contextCompressionStrategies') ?? {};

        var metricsEl = $('commands-overview-metrics');
        if (metricsEl) {
          var stats = crStats.stats ?? {};
          var phSt = phStats.stats ?? {};
          var ccSt = ccStats.stats ?? {};
          metricsEl.innerHTML = [
            Components.statCard('c-primary', '斜杠命令', safeNum(stats.totalCommands), '已发现命令数'),
            Components.statCard('c-success', '钩子处理器', safeNum(phSt.builtinCount), '内置处理器'),
            Components.statCard('c-warning', '压缩次数', safeNum(ccSt.totalCompressions), '上下文压缩'),
            Components.statCard('c-purple', '节省Token', safeNum(ccSt.totalTokensSaved), '累计节省'),
          ].join('');
        }

        var listEl = $('commands-list');
        if (listEl) {
          var cmds = crCmds.commands ?? [];
          if (cmds.length > 0) {
            var html = '<table class="data-table"><thead><tr><th>命令</th><th>名称</th><th>描述</th><th>技能链</th><th>Agent</th><th>级别</th></tr></thead><tbody>';
            for (var i = 0; i < cmds.length; i++) {
              var cmd = cmds[i];
              var enforcementBadge = cmd.enforcement === 'strict'
                ? '<span class="skill-tag skill-tag--0">强制</span>'
                : cmd.enforcement === 'optional'
                  ? '<span class="skill-tag skill-tag--2">可选</span>'
                  : '<span class="skill-tag skill-tag--1">推荐</span>';
              var skillChain = (cmd.skills ?? []).join(' → ');
              var aliasStr = cmd.aliases && cmd.aliases.length > 0 ? ' <span style="color:var(--muted)">(' + cmd.aliases.map(function(a) { return escapeHtml(a); }).join(', ') + ')</span>' : '';
              html += '<tr><td><code>' + escapeHtml(cmd.command_id) + '</code>' + aliasStr + '</td><td>' + escapeHtml(cmd.name) + '</td><td>' + escapeHtml(cmd.description) + '</td><td>' + escapeHtml(skillChain) + '</td><td>' + escapeHtml(cmd.agent || '') + '</td><td>' + enforcementBadge + '</td></tr>';
            }
            html += '</tbody></table>';
            listEl.innerHTML = html;
          } else {
            listEl.innerHTML = '<div class="info-box info-box--warning"><div class="info-box__text">暂无命令数据</div></div>';
          }
        }

        var hooksEl = $('commands-hooks');
        if (hooksEl) {
          var hooks = phHooks.hooks ?? {};
          var hookKeys = Object.keys(hooks);
          if (hookKeys.length > 0) {
            var hHtml = '<table class="data-table"><thead><tr><th>事件</th><th>钩子数</th><th>详情</th></tr></thead><tbody>';
            for (var hi = 0; hi < hookKeys.length; hi++) {
              var evt = hookKeys[hi];
              var evtHooks = hooks[evt] ?? [];
              var details = '';
              for (var hj = 0; hj < evtHooks.length; hj++) {
                details += '<span class="skill-tag skill-tag--' + (hj % 4) + '">' + escapeHtml(evtHooks[hj].type + ':' + (evtHooks[hj].name || evtHooks[hj].id)) + '</span> ';
              }
              hHtml += '<tr><td><code>' + escapeHtml(evt) + '</code></td><td>' + evtHooks.length + '</td><td>' + details + '</td></tr>';
            }
            hHtml += '</tbody></table>';
            hooksEl.innerHTML = hHtml;
          } else {
            var phSt2 = phStats.stats ?? {};
            var hHtml2 = '<div class="detail-grid">';
            hHtml2 += '<div class="detail-item"><span class="detail-label">已注册钩子</span><span class="detail-value">' + safeNum(phSt2.totalHooks) + '</span></div>';
            hHtml2 += '<div class="detail-item"><span class="detail-label">内置处理器</span><span class="detail-value">' + safeNum(phSt2.builtinCount) + '</span></div>';
            hHtml2 += '</div>';
            hooksEl.innerHTML = hHtml2;
          }
        }

        var compEl = $('commands-compression');
        if (compEl) {
          var ccSt2 = ccStats.stats ?? {};
          var cHtml = '<div class="detail-grid">';
          cHtml += '<div class="detail-item"><span class="detail-label">压缩次数</span><span class="detail-value">' + safeNum(ccSt2.totalCompressions) + '</span></div>';
          cHtml += '<div class="detail-item"><span class="detail-label">平均压缩率</span><span class="detail-value">' + safeNum(((ccSt2.avgCompressionRatio ?? 0) * 100).toFixed(1)) + '%</span></div>';
          cHtml += '<div class="detail-item"><span class="detail-label">节省Token</span><span class="detail-value">' + safeNum(ccSt2.totalTokensSaved) + '</span></div>';
          cHtml += '</div>';
          var ratio = ccSt2.avgCompressionRatio ?? 0;
          if (ratio > 0) {
            cHtml += '<div style="margin-top:8px"><span class="detail-label">压缩效率</span></div>';
            cHtml += '<div class="progress-bar" style="margin-top:4px" role="progressbar" aria-valuenow="' + Math.min(100, ratio * 100) + '" aria-valuemin="0" aria-valuemax="100" aria-label="连接池使用率"><div class="progress-bar__fill" style="width:' + Math.min(100, ratio * 100) + '%;background:var(--success)"></div></div>';
          }
          compEl.innerHTML = cHtml;
        }

        var stratEl = $('commands-strategies');
        if (stratEl) {
          var strats = ccStrats.strategies ?? {};
          var sKeys = Object.keys(strats);
          var sHtml = '<table class="data-table"><thead><tr><th>策略类别</th><th>当前策略</th><th>说明</th></tr></thead><tbody>';
          var stratDescs = { current_phase: '当前阶段Skill保留完整指令', completed_phase: '已完成Skill压缩为摘要', future_phase: '未来阶段Skill压缩为摘要', unclassified: '未分类Skill保留完整指令' };
          var stratLabels = { full: '完整保留', summary: '压缩摘要', discard: '丢弃' };
          for (var si = 0; si < sKeys.length; si++) {
            var sk = sKeys[si];
            var sv = strats[sk];
            var badge = sv === 'full' ? 'skill-tag--1' : sv === 'summary' ? 'skill-tag--0' : 'skill-tag--2';
            sHtml += '<tr><td><code>' + escapeHtml(sk) + '</code></td><td><span class="skill-tag ' + badge + '">' + escapeHtml(stratLabels[sv] || sv) + '</span></td><td>' + escapeHtml(stratDescs[sk] || '') + '</td></tr>';
          }
          sHtml += '</tbody></table>';
          stratEl.innerHTML = sHtml;
        }
      });
    },

    chat: function() {
      safeRender(function() {
        var chatData = Store.get('chatSessions') ?? {};
        var sessions = chatData.sessions ?? [];
        var activeId = chatData.activeSessionId ?? null;
        var sessionListEl = $('chat-session-list');
        if (!sessionListEl) return;

        if (!sessions.length) {
          sessionListEl.innerHTML = '<div class="chat-empty-sessions">暂无会话，点击 + 新建</div>';
        } else {
          var searchVal = (UIState.chatSessionSearchQuery || '').toLowerCase();
          var filtered = sessions.filter(function(s) {
            if (!searchVal) return true;
            return (s.sessionId || '').toLowerCase().indexOf(searchVal) >= 0 ||
                   (s.summary || '').toLowerCase().indexOf(searchVal) >= 0;
          });
          sessionListEl.innerHTML = filtered.map(function(s) {
            var isActive = s.sessionId === activeId;
            var initials = (s.sessionId || '??').slice(0, 2).toUpperCase();
            var timeStr = s.lastActivityAt && !isNaN(new Date(s.lastActivityAt).getTime())
              ? new Date(s.lastActivityAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : '';
            var name = s.summary ? escapeHtml(s.summary.slice(0, 30)) : escapeHtml((s.sessionId || '').slice(0, 16));
            var meta = s.turnCount + ' 条消息' + (timeStr ? ' · ' + timeStr : '');
            var cls = 'chat-session-item' + (isActive ? ' active' : '') + (s.pinned ? ' pinned' : '');
            return '<div class="' + cls + '" data-session-id="' + escapeAttr(s.sessionId) + '" role="option" aria-selected="' + isActive + '">' +
              '<div class="chat-session-avatar">' + escapeHtml(initials) + '</div>' +
              '<div class="chat-session-info">' +
                '<div class="chat-session-name">' + name + '</div>' +
                '<div class="chat-session-meta">' + escapeHtml(meta) + '</div>' +
              '</div>' +
              (s.pinned ? '<span class="chat-session-pin" aria-label="已固定">&#x1F4CC;</span>' : '') +
            '</div>';
          }).join('');
        }

        var headerTitle = $('chat-header-title');
        if (headerTitle && activeId) {
          var activeSession = sessions.filter(function(s) { return s.sessionId === activeId; })[0];
          headerTitle.textContent = activeSession && activeSession.summary ? activeSession.summary.slice(0, 40) : '会话 ' + (activeId || '').slice(0, 12);
        }
        var headerStatus = $('chat-header-status');
        if (headerStatus) {
          headerStatus.textContent = activeId ? '活跃' : '';
        }
      });
    }
  };

  var Charts = {
    budget: function(o) {
      var el = $('chart-budget');
      if (!el) return;
      var used = Number.isFinite(o.tokensUsed) ? o.tokensUsed : 0;
      var budget = Number.isFinite(o.tokenBudget) && o.tokenBudget > 0 ? o.tokenBudget : 1e9;
      var remaining = Math.max(0, budget - used);
      var pct = budget > 0 ? ((used / budget) * 100) : 0;
      var clampedPct = Math.min(pct, 100);
      var pctText = pct.toFixed(1);
      var isOverBudget = used > budget;
      var colorId = pct > 95 ? 'danger' : pct > 80 ? 'warning' : 'primary';
      var color = pct > 95 ? 'var(--danger)' : pct > 80 ? 'var(--warning)' : 'var(--primary)';
      var glowColor = pct > 95 ? 'rgba(248,113,113,.25)' : pct > 80 ? 'rgba(251,191,36,.25)' : 'rgba(129,140,248,.25)';
      var r = 70;
      var c = 2 * Math.PI * r;
      var offset = c * (1 - clampedPct / 100);
      var overBudgetHtml = isOverBudget
        ? '<div class="chart-ring-warning" style="color:var(--danger);font-size:var(--font-xs);margin-top:var(--space-2);font-weight:var(--weight-semibold)">⚠ 超出预算 ' + escapeHtml(formatTokens(used - budget)) + '</div>'
        : '';
      el.innerHTML = '<div class="chart-center">' +
        '<svg width="180" height="180" viewBox="0 0 180 180" class="chart-svg-rotate" role="img" aria-label="令牌预算使用率 ' + pct + '%">' +
        '<defs>' +
        '<linearGradient id="budget-grad" x1="0%" y1="0%" x2="100%" y2="100%">' +
        '<stop offset="0%" stop-color="' + color + '" stop-opacity="1"/>' +
        '<stop offset="100%" stop-color="' + color + '" stop-opacity=".7"/>' +
        '</linearGradient>' +
        '<filter id="budget-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
        '</defs>' +
        '<circle cx="90" cy="90" r="' + r + '" fill="none" stroke="var(--surface3)" stroke-width="10" opacity=".6"/>' +
        '<circle cx="90" cy="90" r="' + r + '" fill="none" stroke="url(#budget-grad)" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + offset + '" class="chart-ring-anim" filter="url(#budget-glow)"/>' +
        '</svg>' +
        '<div class="chart-ring-label">' +
        '<div class="chart-ring-pct" style="color:' + escapeAttr(color) + '">' + escapeHtml(pctText) + '%</div>' +
        '<div class="chart-ring-sub">' + (isOverBudget ? '已超预算' : '已使用') + '</div></div>' +
        '<div class="chart-legend">' +
        '<div class="chart-legend-item"><span class="chart-legend-dot" style="background:' + escapeAttr(color) + ';box-shadow:0 0 6px ' + escapeAttr(glowColor) + '"></span>已使用 ' + escapeHtml(formatTokens(used)) + '</div>' +
        '<div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--surface3)"></span>剩余 ' + escapeHtml(formatTokens(remaining)) + '</div></div>' +
        overBudgetHtml + '</div>';
    },

    phaseBudget: function(config) {
      var el = $('chart-phase-budget');
      if (!el) return;
      var alloc = (config ?? {}).phase_budget_allocation ?? {};
      var entries = Object.entries(alloc);
      if (!entries.length) { el.innerHTML = Components.emptyState('', '暂无预算分配数据'); return; }
      var colors = ['var(--primary)','var(--purple)','var(--cyan)','var(--success)','var(--warning)','var(--danger)'];
      var glowColors = ['rgba(129,140,248,.2)','rgba(167,139,250,.2)','rgba(34,211,238,.2)','rgba(52,211,153,.2)','rgba(251,191,36,.2)','rgba(248,113,113,.2)'];
      var maxVal = Math.max.apply(null, entries.map(function(e) { return Number.isFinite(e[1]) ? e[1] : 0; }));
      maxVal = Math.max(maxVal, 1);
      var bars = entries.map(function(e, i) {
        var val = Number.isFinite(e[1]) ? e[1] : 0;
        var pct = (val * 100).toFixed(0);
        var barWidth = maxVal > 0 ? (val / maxVal * 100) : 0;
        return '<div class="chart-bar-row">' +
          '<div class="chart-bar-label">' + escapeHtml(phaseName(e[0])) + '</div>' +
          '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + escapeAttr(String(barWidth)) + '%;background:' + escapeAttr(colors[i % colors.length]) + ';box-shadow:0 0 8px ' + escapeAttr(glowColors[i % glowColors.length]) + '"></div></div>' +
          '<div class="chart-bar-value" style="color:' + escapeAttr(colors[i % colors.length]) + '">' + escapeHtml(pct) + '%</div></div>';
      }).join('');
      el.innerHTML = '<div class="chart-bars">' + bars + '</div>';
    },

    enforcement: function(skills) {
      var el = $('chart-enforcement');
      if (!el) return;
      var counts = { strict: 0, recommended: 0, optional: 0 };
      (skills ?? []).forEach(function(s) {
        if (counts[s.enforcement] !== undefined) counts[s.enforcement]++;
      });
      var total = counts.strict + counts.recommended + counts.optional;
      if (total === 0) { el.innerHTML = Components.emptyState('', '暂无技能数据'); return; }
      var items = [
        { label: '强制执行', count: counts.strict, color: 'var(--danger)', glow: 'rgba(248,113,113,.2)' },
        { label: '推荐执行', count: counts.recommended, color: 'var(--primary-light)', glow: 'rgba(129,140,248,.2)' },
        { label: '可选执行', count: counts.optional, color: 'var(--success)', glow: 'rgba(52,211,153,.2)' },
      ];
      var r = 45;
      var c = 2 * Math.PI * r;
      var offset = 0;
      var arcs = '';
      for (var i = 0; i < items.length; i++) {
        var pct = total ? items[i].count / total : 0;
        var dash = pct * c;
        arcs += '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="' + escapeAttr(items[i].color) + '" stroke-width="10" stroke-dasharray="' + dash + ' ' + (c - dash) + '" stroke-dashoffset="' + (-offset) + '" stroke-linecap="round" class="chart-ring-anim" style="filter:drop-shadow(0 0 4px ' + escapeAttr(items[i].glow) + ')"/>';
        offset += dash;
      }
      var legend = items.map(function(it) {
        return '<div class="chart-legend-item">' +
          '<span class="chart-legend-dot" style="background:' + escapeAttr(it.color) + ';box-shadow:0 0 6px ' + escapeAttr(it.glow) + '"></span>' +
          escapeHtml(it.label) + ' <strong style="color:' + escapeAttr(it.color) + '">' + escapeHtml(String(it.count)) + '</strong></div>';
      }).join('');
      el.innerHTML = '<div class="chart-donut-wrap">' +
        '<svg width="90" height="90" viewBox="0 0 120 120" class="chart-svg-rotate">' + arcs + '</svg>' +
        '<div class="chart-legend-col">' + legend + '</div></div>';
    },

    agentSkills: function(agents) {
      var el = $('chart-agent-skills');
      if (!el) return;
      if (!agents || !agents.length) { el.innerHTML = Components.emptyState('', '暂无角色数据'); return; }
      var maxSkills = Math.max.apply(null, agents.map(function(a) { return (a.skills ?? []).length; }));
      maxSkills = Math.max(maxSkills, 1);
      var colors = ['var(--primary-light)','var(--purple)','var(--cyan)','var(--success)','var(--warning)','var(--danger)'];
      var glowColors = ['rgba(129,140,248,.2)','rgba(167,139,250,.2)','rgba(34,211,238,.2)','rgba(52,211,153,.2)','rgba(251,191,36,.2)','rgba(248,113,113,.2)'];
      var bars = agents.map(function(a, i) {
        var count = (a.skills ?? []).length;
        var barWidth = (count / maxSkills * 100);
        var shortName = escapeHtml(getInitials(a.id));
        return '<div class="chart-bar-row">' +
          '<div class="chart-bar-avatar" style="background:' + escapeAttr(colors[i % colors.length]) + ';box-shadow:0 2px 8px ' + escapeAttr(glowColors[i % glowColors.length]) + '">' + shortName + '</div>' +
          '<div class="chart-bar-track chart-bar-track-sm"><div class="chart-bar-fill" style="width:' + escapeAttr(String(barWidth)) + '%;background:' + escapeAttr(colors[i % colors.length]) + ';box-shadow:0 0 8px ' + escapeAttr(glowColors[i % glowColors.length]) + '"></div></div>' +
          '<div class="chart-bar-value" style="color:' + escapeAttr(colors[i % colors.length]) + '">' + count + '</div></div>';
      }).join('');
      el.innerHTML = '<div class="chart-bars">' + bars + '</div>';
    },

    collaboration: function() {
      safeRender(function() {
        var subagentData = Store.get('subagentStats') ?? {};
        var channelData = Store.get('channelStats') ?? {};
        var layerData = Store.get('skillLayerStats') ?? {};
        var frameworkData = Store.get('framework') ?? {};

        var subStats = subagentData.stats ?? {};
        var layerStats = layerData.stats ?? {};

        var overviewEl = $('collab-overview-metrics');
        if (overviewEl) {
          overviewEl.innerHTML = [
            Components.statCard('🤖', 'Subagent派生', safeNum(subStats.totalSpawned), '累计派生子智能体数', 'c-primary', 'var(--primary-glow)', 'var(--primary-light)'),
            Components.statCard('✅', '执行完成', safeNum(subStats.totalCompleted), '成功率 ' + safeNum(((subStats.successRate ?? 0) * 100).toFixed(0)) + '%', 'c-success', 'var(--success-glow)', 'var(--success)'),
            Components.statCard('🧩', 'L1技能数', safeNum(layerStats.l1Count), '元数据层常驻技能', 'c-warning', 'var(--warning-glow)', 'var(--warning)'),
            Components.statCard('📡', 'L2缓存命中', safeNum(((layerStats.l2HitRate ?? 0) * 100).toFixed(0)) + '%', '指令层缓存命中率', 'c-info', 'var(--cyan-glow)', 'var(--cyan)')
          ].join('');
        }

        var subDetailEl = $('collab-subagent-detail');
        if (subDetailEl) {
          var budgetData = Store.get('subagentBudget') ?? {};
          var budgetReport = budgetData.report ?? {};
          var subHtml = '<div class="detail-grid">';
          subHtml += '<div class="detail-item"><span class="detail-label">活跃句柄</span><span class="detail-value">' + safeNum(subStats.activeHandles) + '</span></div>';
          subHtml += '<div class="detail-item"><span class="detail-label">已完成</span><span class="detail-value">' + safeNum(subStats.totalCompleted) + '</span></div>';
          subHtml += '<div class="detail-item"><span class="detail-label">失败</span><span class="detail-value">' + safeNum(subStats.totalFailed) + '</span></div>';
          subHtml += '<div class="detail-item"><span class="detail-label">已取消</span><span class="detail-value">' + safeNum(subStats.totalCancelled) + '</span></div>';
          subHtml += '<div class="detail-item"><span class="detail-label">重试次数</span><span class="detail-value">' + safeNum(subStats.totalRetries) + '</span></div>';
          subHtml += '<div class="detail-item"><span class="detail-label">Token消耗</span><span class="detail-value">' + safeNum(subStats.totalTokensUsed) + '</span></div>';
          subHtml += '<div class="detail-item"><span class="detail-label">最大并发</span><span class="detail-value">' + safeNum(subStats.maxConcurrent ?? 5) + '</span></div>';
          subHtml += '<div class="detail-item"><span class="detail-label">成功率</span><span class="detail-value">' + safeNum(((subStats.successRate ?? 0) * 100).toFixed(1)) + '%</span></div>';
          subHtml += '</div>';
          if (budgetData.available) {
            subHtml += '<div class="info-box info-box--warning">';
            subHtml += '<div class="info-box__title info-box__title--warning">💰 Token预算</div>';
            subHtml += '<div class="info-box__text">默认预算/子智能体: ' + safeNum(budgetReport.defaultBudgetPerSubagent) + '</div>';
            subHtml += '<div class="info-box__text">预算超限次数: ' + safeNum(budgetReport.budgetExceeded) + '</div>';
            if (budgetReport.activeBudgets && budgetReport.activeBudgets.length > 0) {
              subHtml += '<div class="info-box__text">活跃预算: ' + budgetReport.activeBudgets.length + '个</div>';
            }
            subHtml += '</div>';
          }
          subDetailEl.innerHTML = subHtml;
        }

        var channelDetailEl = $('collab-channel-detail');
        if (channelDetailEl) {
          var chHtml = '<div class="detail-grid">';
          chHtml += '<div class="detail-item"><span class="detail-label">共享状态键</span><span class="detail-value">' + safeNum(channelData.sharedKeys) + '</span></div>';
          chHtml += '<div class="detail-item"><span class="detail-label">邮箱数</span><span class="detail-value">' + safeNum(channelData.totalMailboxes) + '</span></div>';
          chHtml += '<div class="detail-item"><span class="detail-label">消息总数</span><span class="detail-value">' + safeNum(channelData.totalMessages) + '</span></div>';
          chHtml += '<div class="detail-item"><span class="detail-label">开放提案</span><span class="detail-value">' + safeNum(channelData.openProposals) + '</span></div>';
          chHtml += '<div class="detail-item"><span class="detail-label">提案总数</span><span class="detail-value">' + safeNum(channelData.totalProposals) + '</span></div>';
          chHtml += '</div>';
          chHtml += '<div class="info-box info-box--primary">';
          chHtml += '<div class="info-box__title info-box__title--primary">支持的通信模式</div>';
          chHtml += '<div class="comm-modes">';
          chHtml += '<span class="comm-mode-tag comm-mode-tag--primary">📨 点对点消息</span>';
          chHtml += '<span class="comm-mode-tag comm-mode-tag--success">🔄 请求-响应</span>';
          chHtml += '<span class="comm-mode-tag comm-mode-tag--warning">🗳️ 提案-投票</span>';
          chHtml += '<span class="comm-mode-tag comm-mode-tag--cyan">🔒 乐观锁共享</span>';
          chHtml += '</div></div>';
          channelDetailEl.innerHTML = chHtml;
        }

        var layerDetailEl = $('collab-skill-layers-detail');
        if (layerDetailEl) {
          var ctxEst = (layerData.stats && layerData.stats.contextEstimate) ?? {};
          var lHtml = '<div class="detail-grid">';
          lHtml += '<div class="detail-item"><span class="detail-label">L1元数据层</span><span class="detail-value">' + safeNum(layerStats.l1Count) + ' 技能</span></div>';
          lHtml += '<div class="detail-item"><span class="detail-label">L2指令层缓存</span><span class="detail-value">' + safeNum(layerStats.l2Cached) + '</span></div>';
          lHtml += '<div class="detail-item"><span class="detail-label">L3资源层缓存</span><span class="detail-value">' + safeNum(layerStats.l3Cached) + '</span></div>';
          lHtml += '<div class="detail-item"><span class="detail-label">L2命中率</span><span class="detail-value">' + safeNum(((layerStats.l2HitRate ?? 0) * 100).toFixed(1)) + '%</span></div>';
          lHtml += '<div class="detail-item"><span class="detail-label">L1 Token</span><span class="detail-value">' + safeNum(ctxEst.l1Tokens) + '</span></div>';
          lHtml += '<div class="detail-item"><span class="detail-label">L2 Token</span><span class="detail-value">' + safeNum(ctxEst.l2Tokens) + '</span></div>';
          lHtml += '<div class="detail-item"><span class="detail-label">L3 Token</span><span class="detail-value">' + safeNum(ctxEst.l3Tokens) + '</span></div>';
          lHtml += '<div class="detail-item"><span class="detail-label">去重节省</span><span class="detail-value">' + safeNum(layerStats.deduplicationSavings) + ' 字符</span></div>';
          lHtml += '</div>';
          lHtml += '<div class="info-box info-box--warning-soft">';
          lHtml += '<div class="info-box__title info-box__title--primary">SkillReducer 三层架构</div>';
          lHtml += '<div class="skill-layer-arch">';
          lHtml += '<div class="skill-layer-node skill-layer-node--l1"><div class="skill-layer-node__label skill-layer-node__label--primary">L1 元数据</div><div class="skill-layer-node__sub">常驻·轻量</div></div>';
          lHtml += '<div class="skill-layer-arrow">→</div>';
          lHtml += '<div class="skill-layer-node skill-layer-node--l2"><div class="skill-layer-node__label skill-layer-node__label--success">L2 指令</div><div class="skill-layer-node__sub">按需·缓存</div></div>';
          lHtml += '<div class="skill-layer-arrow">→</div>';
          lHtml += '<div class="skill-layer-node skill-layer-node--l3"><div class="skill-layer-node__label skill-layer-node__label--info">L3 资源</div><div class="skill-layer-node__sub">按需·缓存</div></div>';
          lHtml += '</div></div>';
          layerDetailEl.innerHTML = lHtml;
        }

        var modeDetailEl = $('collab-mode-detail');
        if (modeDetailEl) {
          var collabModesData = Store.get('collaborationModes') ?? {};
          var collabStatsData = Store.get('collaborationStats') ?? {};
          var collabHistoryData = Store.get('collaborationHistory') ?? {};
          var modesFromApi = (collabModesData.available && collabModesData.modes) ?? [];
          var modeStats = (collabStatsData.available && collabStatsData.stats) ?? {};
          var modeHistory = (collabHistoryData.available && collabHistoryData.history) ?? [];

          var fwFeatures = Store.get('frameworkFeatures') ?? {};
          var defaultModes = fwFeatures.collaboration
            ? (fwFeatures.collaboration.defaultModes ?? [])
            : [
              { name: 'orchestrator-subagent', icon: '🎯', desc: '任务拆解→并行执行→结果汇总', color: 'primary', useCase: '多模块并行开发' },
              { name: 'generator-verifier', icon: '✅', desc: '生成→验证→反馈→迭代优化', color: 'success', useCase: '代码审查/报告校验' },
              { name: 'agent-teams', icon: '👥', desc: '直接通信→协调→投票决策', color: 'warning', useCase: '复杂协调任务' },
              { name: 'message-bus', icon: '📡', desc: '事件驱动→发布订阅→动态接入', color: 'info', useCase: '模块解耦扩展' },
              { name: 'shared-state', icon: '🔒', desc: '乐观锁→版本控制→实时协作', color: 'purple', useCase: '多源数据同步' }
            ];

          var displayModes = modesFromApi.length > 0 ? modesFromApi.map(function(m) {
            var dm = defaultModes.find(function(d) { return d.name === m.mode; });
            return { name: m.mode, icon: dm ? dm.icon : '🔄', desc: m.description || '', color: dm ? dm.color : 'primary', useCase: m.bestFor || '', minAgents: m.minAgents, maxAgents: m.maxAgents };
          }) : defaultModes;

          var modeCounts = modeStats.modeCounts ?? {};
          var mHtml = '';
          for (var mi = 0; mi < displayModes.length; mi++) {
            var m = displayModes[mi];
            var count = modeCounts[m.name] ?? 0;
            mHtml += '<div class="collab-mode-card">';
            mHtml += '<span class="collab-mode-card__icon">' + escapeHtml(m.icon) + '</span>';
            mHtml += '<div class="collab-mode-card__body"><div class="collab-mode-card__name">' + escapeHtml(m.name) + '</div>';
            mHtml += '<div class="collab-mode-card__desc">' + escapeHtml(m.desc) + '</div></div>';
            mHtml += '<div class="collab-mode-card__stats">';
            if (count > 0) mHtml += '<div class="collab-mode-card__count">' + count + '次</div>';
            if (m.minAgents) mHtml += '<div class="collab-mode-card__agents">' + safeNum(m.minAgents) + '-' + safeNum(m.maxAgents) + ' Agent</div>';
            mHtml += '</div>';
            mHtml += '</div>';
          }
          if (modeStats.totalSelections > 0) {
            mHtml += '<div class="collab-mode-summary">';
            mHtml += '累计选择: ' + safeNum(modeStats.totalSelections) + '次 · 可用模式: ' + safeNum(modeStats.availableModes ?? 5) + '种';
            mHtml += '</div>';
          }
          if (modeHistory.length > 0) {
            mHtml += '<div class="collab-mode-history-label">最近选择:</div>';
            for (var hi = modeHistory.length - 1; hi >= Math.max(0, modeHistory.length - 5); hi--) {
              var h = modeHistory[hi];
              mHtml += '<div class="collab-mode-history-item">' + escapeHtml(h.mode) + ' (' + (h.confidence * 100).toFixed(0) + '%)</div>';
            }
          }
          modeDetailEl.innerHTML = mHtml;
        }

        var pipelineEl = $('collab-pipeline-detail');
        if (pipelineEl) {
          var collabFeat = (Store.get('frameworkFeatures') ?? {}).collaboration ?? {};
          var steps = collabFeat.pipeline || [
            { name: 'StructuredIntent', label: '意图解析', desc: '解析用户消息为结构化意图' },
            { name: 'SkillRouter', label: '技能路由', desc: 'L1轻量匹配→L2按需加载' },
            { name: 'CollaborationModeRouter', label: '模式选择', desc: '根据任务特征选择协作模式' },
            { name: 'SubagentExecutor', label: '子智能体执行', desc: '派生独立Subagent并行执行' },
            { name: 'GeneratorVerifier', label: '质量验证', desc: '验证输出质量→反馈迭代' },
            { name: 'AgentChannel', label: '结果汇总', desc: 'P2P通信→投票→融合输出' }
          ];
          var pHtml = '<div class="pipeline-flow">';
          for (var pi = 0; pi < steps.length; pi++) {
            if (pi > 0) pHtml += '<span class="pipeline-arrow">→</span>';
            var s = steps[pi];
            pHtml += '<div class="pipeline-step">';
            pHtml += '<div class="pipeline-step__label">' + escapeHtml(s.label) + '</div>';
            pHtml += '<div class="pipeline-step__desc">' + escapeHtml(s.desc) + '</div>';
            pHtml += '</div>';
          }
          pHtml += '</div>';
          pipelineEl.innerHTML = pHtml;
        }

        var pairChatEl = $('collab-pairchat-detail');
        if (pairChatEl) {
          var pcStatsData = Store.get('pairChatStats') ?? {};
          var pcSessionsData = Store.get('pairChatSessions') ?? {};
          var pcStats = (pcStatsData.available && pcStatsData.stats) ?? {};
          var pcHtml = '<div class="detail-grid">';
          pcHtml += '<div class="detail-item"><span class="detail-label">活跃会话</span><span class="detail-value">' + safeNum(pcStats.activeSessions) + '</span></div>';
          pcHtml += '<div class="detail-item"><span class="detail-label">总会话数</span><span class="detail-value">' + safeNum(pcStats.totalSessions) + '</span></div>';
          pcHtml += '<div class="detail-item"><span class="detail-label">总轮次</span><span class="detail-value">' + safeNum(pcStats.totalRounds) + '</span></div>';
          pcHtml += '<div class="detail-item"><span class="detail-label">总修正数</span><span class="detail-value">' + safeNum(pcStats.totalCorrections) + '</span></div>';
          pcHtml += '<div class="detail-item"><span class="detail-label">平均修正/会话</span><span class="detail-value">' + safeNum(pcStats.avgCorrectionsPerSession) + '</span></div>';
          pcHtml += '<div class="detail-item"><span class="detail-label">平均轮次/会话</span><span class="detail-value">' + safeNum(pcStats.avgRoundsPerSession) + '</span></div>';
          pcHtml += '</div>';
          pcHtml += '<div class="info-box info-box--primary">';
          pcHtml += '<div class="info-box__title info-box__title--primary">PairChat 工作模式</div>';
          pcHtml += '<div class="comm-modes">';
          pcHtml += '<span class="comm-mode-tag comm-mode-tag--primary">📝 Proposer 提案</span>';
          pcHtml += '<span class="comm-mode-tag comm-mode-tag--success">🔍 Reviewer 审查</span>';
          pcHtml += '<span class="comm-mode-tag comm-mode-tag--warning">✅ 共识达成</span>';
          pcHtml += '</div></div>';
          if (!pcStatsData.available) {
            pcHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载，数据暂不可用</div></div>';
          }
          pairChatEl.innerHTML = pcHtml;
        }

        var chatChainEl = $('collab-chatchain-detail');
        if (chatChainEl) {
          var ccStatsData = Store.get('chatChainStats') ?? {};
          var ccChainsData = Store.get('chatChainChains') ?? {};
          var ccStats = (ccStatsData.available && ccStatsData.stats) ?? {};
          var ccHtml = '<div class="detail-grid">';
          ccHtml += '<div class="detail-item"><span class="detail-label">活跃链</span><span class="detail-value">' + safeNum(ccStats.activeChains) + '</span></div>';
          ccHtml += '<div class="detail-item"><span class="detail-label">总链数</span><span class="detail-value">' + safeNum(ccStats.totalChains) + '</span></div>';
          ccHtml += '<div class="detail-item"><span class="detail-label">已完成链</span><span class="detail-value">' + safeNum(ccStats.completedChains) + '</span></div>';
          ccHtml += '<div class="detail-item"><span class="detail-label">失败链</span><span class="detail-value">' + safeNum(ccStats.failedChains) + '</span></div>';
          ccHtml += '<div class="detail-item"><span class="detail-label">总任务数</span><span class="detail-value">' + safeNum(ccStats.totalTasks) + '</span></div>';
          ccHtml += '<div class="detail-item"><span class="detail-label">任务完成率</span><span class="detail-value">' + safeNum(((ccStats.taskCompletionRate ?? 0) * 100).toFixed(1)) + '%</span></div>';
          ccHtml += '</div>';
          ccHtml += '<div class="info-box info-box--success">';
          ccHtml += '<div class="info-box__title info-box__title--success">ChatChain 原子任务链</div>';
          ccHtml += '<div class="pipeline-flow" style="flex-wrap:wrap">';
          var phases = ['brainstorming', 'requirement-analysis', 'architecture-design', 'module-development', 'integration-testing', 'deployment'];
          for (var phi = 0; phi < phases.length; phi++) {
            if (phi > 0) ccHtml += '<span class="pipeline-arrow">→</span>';
            ccHtml += '<div class="pipeline-step"><div class="pipeline-step__label">' + escapeHtml(phases[phi]) + '</div></div>';
          }
          ccHtml += '</div></div>';
          if (!ccStatsData.available) {
            ccHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载，数据暂不可用</div></div>';
          }
          chatChainEl.innerHTML = ccHtml;
        }

        var outputFusionEl = $('collab-outputfusion-detail');
        if (outputFusionEl) {
          var ofStatsData = Store.get('outputFusionStats') ?? {};
          var ofStats = (ofStatsData.available && ofStatsData.stats) ?? {};
          var ofHtml = '<div class="detail-grid">';
          ofHtml += '<div class="detail-item"><span class="detail-label">总融合次数</span><span class="detail-value">' + safeNum(ofStats.totalFusions) + '</span></div>';
          ofHtml += '<div class="detail-item"><span class="detail-label">默认策略</span><span class="detail-value">' + escapeHtml(ofStats.defaultStrategy || 'cascade') + '</span></div>';
          ofHtml += '<div class="detail-item"><span class="detail-label">平均置信度</span><span class="detail-value">' + safeNum(ofStats.avgConfidence) + '</span></div>';
          ofHtml += '<div class="detail-item"><span class="detail-label">平均Agent数</span><span class="detail-value">' + safeNum(ofStats.avgAgentCount) + '</span></div>';
          ofHtml += '</div>';
          var strategyCounts = ofStats.strategyCounts ?? {};
          var strategyLabels = { cascade: '级联融合', vote: '投票融合', weighted: '加权融合', review: '审查融合' };
          ofHtml += '<div class="info-box info-box--primary">';
          ofHtml += '<div class="info-box__title info-box__title--primary">融合策略分布</div>';
          ofHtml += '<div class="comm-modes">';
          for (var sk in strategyCounts) {
            if (Object.prototype.hasOwnProperty.call(strategyCounts, sk)) {
              ofHtml += '<span class="comm-mode-tag comm-mode-tag--' + (sk === 'cascade' ? 'primary' : sk === 'vote' ? 'success' : sk === 'weighted' ? 'warning' : 'cyan') + '">' + (strategyLabels[sk] || sk) + ': ' + strategyCounts[sk] + '</span>';
            }
          }
          if (Object.keys(strategyCounts).length === 0) {
            ofHtml += '<span class="comm-mode-tag comm-mode-tag--primary">级联融合: 0</span>';
            ofHtml += '<span class="comm-mode-tag comm-mode-tag--success">投票融合: 0</span>';
            ofHtml += '<span class="comm-mode-tag comm-mode-tag--warning">加权融合: 0</span>';
            ofHtml += '<span class="comm-mode-tag comm-mode-tag--cyan">审查融合: 0</span>';
          }
          ofHtml += '</div></div>';
          if (!ofStatsData.available) {
            ofHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载，数据暂不可用</div></div>';
          }
          outputFusionEl.innerHTML = ofHtml;
        }

        var gvEl = $('collab-generator-verifier-detail');
        if (gvEl) {
          var gvStatsData = Store.get('generatorVerifierStats') ?? {};
          var gvHistoryData = Store.get('generatorVerifierHistory') ?? {};
          var gvStats = (gvStatsData.available && gvStatsData.stats) ?? {};
          var gvHtml = '<div class="detail-grid">';
          gvHtml += '<div class="detail-item"><span class="detail-label">总验证次数</span><span class="detail-value">' + safeNum(gvStats.totalVerifications) + '</span></div>';
          gvHtml += '<div class="detail-item"><span class="detail-label">通过次数</span><span class="detail-value" style="color:var(--success)">' + safeNum(gvStats.passedCount) + '</span></div>';
          gvHtml += '<div class="detail-item"><span class="detail-label">失败次数</span><span class="detail-value" style="color:var(--danger)">' + safeNum(gvStats.failedCount) + '</span></div>';
          gvHtml += '<div class="detail-item"><span class="detail-label">通过率</span><span class="detail-value">' + safeNum(((gvStats.passRate ?? 0) * 100).toFixed(1)) + '%</span></div>';
          gvHtml += '<div class="detail-item"><span class="detail-label">平均分数</span><span class="detail-value">' + safeNum((gvStats.averageScore ?? 0).toFixed(2)) + '</span></div>';
          gvHtml += '<div class="detail-item"><span class="detail-label">验证Agent数</span><span class="detail-value">' + safeNum(gvStats.verifierAgents) + '</span></div>';
          gvHtml += '</div>';
          var dimAvgs = gvStats.dimensionAverages ?? {};
          if (Object.keys(dimAvgs).length > 0) {
            gvHtml += '<div class="info-box info-box--primary" style="margin-top:var(--space-2)">';
            gvHtml += '<div class="info-box__title info-box__title--primary">维度评分</div>';
            gvHtml += '<div class="comm-modes">';
            for (var dim in dimAvgs) {
              if (Object.prototype.hasOwnProperty.call(dimAvgs, dim)) {
                var dimScore = dimAvgs[dim];
                var dimColor = dimScore >= 0.8 ? 'success' : dimScore >= 0.5 ? 'warning' : 'danger';
                gvHtml += '<span class="comm-mode-tag comm-mode-tag--' + dimColor + '">' + escapeHtml(dim) + ': ' + dimScore.toFixed(2) + '</span>';
              }
            }
            gvHtml += '</div></div>';
          }
          if (!gvStatsData.available) {
            gvHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载，数据暂不可用</div></div>';
          }
          gvEl.innerHTML = gvHtml;
        }

        var icEl = $('collab-isolated-context-detail');
        if (icEl) {
          var icStatsData = Store.get('isolatedContextStats') ?? {};
          var icActiveData = Store.get('isolatedContextActive') ?? {};
          var icStats = (icStatsData.available && icStatsData.stats) ?? {};
          var icHtml = '<div class="detail-grid">';
          icHtml += '<div class="detail-item"><span class="detail-label">活跃上下文</span><span class="detail-value" style="color:var(--success)">' + safeNum(icStats.activeContexts) + '</span></div>';
          icHtml += '<div class="detail-item"><span class="detail-label">已完成上下文</span><span class="detail-value">' + safeNum(icStats.completedContexts) + '</span></div>';
          icHtml += '<div class="detail-item"><span class="detail-label">总上下文数</span><span class="detail-value">' + safeNum(icStats.totalContexts) + '</span></div>';
          icHtml += '<div class="detail-item"><span class="detail-label">最大容量</span><span class="detail-value">' + safeNum(icStats.maxContexts) + '</span></div>';
          icHtml += '<div class="detail-item"><span class="detail-label">Token估算</span><span class="detail-value">' + safeNum(icStats.totalTokenEstimate) + '</span></div>';
          icHtml += '<div class="detail-item"><span class="detail-label">历史记录</span><span class="detail-value">' + safeNum(icStats.historyCount) + '</span></div>';
          icHtml += '</div>';
          var toolSets = icStats.toolSets ?? [];
          if (toolSets.length > 0) {
            icHtml += '<div class="info-box info-box--cyan" style="margin-top:var(--space-2)">';
            icHtml += '<div class="info-box__title info-box__title--cyan">工具集</div>';
            icHtml += '<div class="comm-modes">';
            for (var ti = 0; ti < toolSets.length; ti++) {
              icHtml += '<span class="comm-mode-tag comm-mode-tag--primary">' + escapeHtml(toolSets[ti]) + '</span>';
            }
            icHtml += '</div></div>';
          }
          if (!icStatsData.available) {
            icHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载，数据暂不可用</div></div>';
          }
          icEl.innerHTML = icHtml;
        }

        var planEl = $('collab-plan-detail');
        if (planEl) {
          var planStatsData = Store.get('planStats') ?? {};
          var planActiveData = Store.get('planActive') ?? {};
          var planStats = (planStatsData.available && planStatsData.stats) ?? {};
          var planHtml = '<div class="detail-grid">';
          planHtml += '<div class="detail-item"><span class="detail-label">内存中计划</span><span class="detail-value">' + safeNum(planStats.plansInMemory) + '</span></div>';
          planHtml += '<div class="detail-item"><span class="detail-label">已创建</span><span class="detail-value">' + safeNum(planStats.created) + '</span></div>';
          planHtml += '<div class="detail-item"><span class="detail-label">已更新</span><span class="detail-value">' + safeNum(planStats.updated) + '</span></div>';
          planHtml += '<div class="detail-item"><span class="detail-label">已加载</span><span class="detail-value">' + safeNum(planStats.loaded) + '</span></div>';
          planHtml += '<div class="detail-item"><span class="detail-label">已注入</span><span class="detail-value">' + safeNum(planStats.injected) + '</span></div>';
          planHtml += '<div class="detail-item"><span class="detail-label">最大计划数</span><span class="detail-value">' + safeNum(planStats.maxPlans) + '</span></div>';
          planHtml += '</div>';
          if (planActiveData.available && planActiveData.activePlan) {
            var ap = planActiveData.activePlan;
            planHtml += '<div class="info-box info-box--success" style="margin-top:var(--space-2)">';
            planHtml += '<div class="info-box__title info-box__title--success">活跃计划</div>';
            planHtml += '<div class="detail-grid">';
            planHtml += '<div class="detail-item"><span class="detail-label">计划ID</span><span class="detail-value">' + escapeHtml(ap.planId || '—') + '</span></div>';
            planHtml += '<div class="detail-item"><span class="detail-label">阶段</span><span class="detail-value">' + escapeHtml(ap.phase || '—') + '</span></div>';
            planHtml += '<div class="detail-item"><span class="detail-label">版本</span><span class="detail-value">' + safeNum(ap.version) + '</span></div>';
            var apTasks = ap.tasks ?? [];
            var apCompleted = apTasks.filter(function(t) { return t.status === 'completed'; }).length;
            planHtml += '<div class="detail-item"><span class="detail-label">任务进度</span><span class="detail-value">' + apCompleted + '/' + apTasks.length + '</span></div>';
            planHtml += '</div></div>';
          }
          if (!planStatsData.available) {
            planHtml += '<div class="info-box info-box--warning"><div class="info-box__text">模块未加载，数据暂不可用</div></div>';
          }
          planEl.innerHTML = planHtml;
        }
      });
    }
  };

  var RE_CHANGELOG_FILES = /修改文件：`(.+?)`/;

  function getFilteredChangelog() {
    var raw = Store.get('changelog');
    var versions = Array.isArray(raw) ? raw : [];
    var keyword = (($('changelog-search') ?? {}).value || '').substring(0, 256);
    var category = ($('changelog-category-filter') ?? {}).value || '';
    var since = ($('changelog-since') ?? {}).value || '';
    var until = ($('changelog-until') ?? {}).value || '';
    if (!keyword && !category && !since && !until) return versions;
    var results = versions;
    if (keyword) {
      var kw = keyword.toLowerCase();
      results = results.filter(function(v) {
        if ((v.version || '').toLowerCase().indexOf(kw) >= 0) return true;
        if ((v.date || '').indexOf(kw) >= 0) return true;
        var meta = v.meta ?? {};
        if ((meta.responsible || '').toLowerCase().indexOf(kw) >= 0) return true;
        if ((meta.reviewer || '').toLowerCase().indexOf(kw) >= 0) return true;
        var sections = v.sections ?? {};
        for (var secName in sections) {
          if (!Object.prototype.hasOwnProperty.call(sections, secName)) continue;
          if (secName.toLowerCase().indexOf(kw) >= 0) return true;
          var items = sections[secName];
          for (var j = 0; j < items.length; j++) {
            var item = items[j];
            if (typeof item === 'string' && item.toLowerCase().indexOf(kw) >= 0) return true;
            if (item.title && item.title.toLowerCase().indexOf(kw) >= 0) return true;
            if (item.raw && item.raw.toLowerCase().indexOf(kw) >= 0) return true;
            if (item.module && item.module.toLowerCase().indexOf(kw) >= 0) return true;
            if (item.value && item.value.toLowerCase().indexOf(kw) >= 0) return true;
            if (item.subItems) {
              for (var si = 0; si < item.subItems.length; si++) {
                if (String(item.subItems[si]).toLowerCase().indexOf(kw) >= 0) return true;
              }
            }
          }
        }
        return false;
      });
    }
    if (category) {
      results = results.filter(function(v) {
        var sections = v.sections ?? {};
        return Object.keys(sections).some(function(k) { return k === category && sections[k].length > 0; });
      });
    }
    if (since) { results = results.filter(function(v) { return (v.date || '') >= since; }); }
    if (until) { results = results.filter(function(v) { return (v.date || '') <= until; }); }
    return results;
  }

  function renderChangelogPagination(total) {
    var container = $('changelog-pagination');
    if (!container) return;
    var totalPages = Math.ceil(total / UIState.changelogPageSize);
    if (totalPages <= 1) { container.textContent = ''; return; }
    var html = '<button class="page-btn" data-page="' + (UIState.changelogPage - 1) + '"' + (UIState.changelogPage <= 1 ? ' disabled' : '') + ' aria-label="上一页">‹</button>';
    var startP = Math.max(1, UIState.changelogPage - 2);
    var endP = Math.min(totalPages, UIState.changelogPage + 2);
    if (startP > 1) html += '<button class="page-btn" data-page="1">1</button>';
    if (startP > 2) html += '<span class="page-info">...</span>';
    for (var i = startP; i <= endP; i++) {
      html += '<button class="page-btn' + (i === UIState.changelogPage ? ' active' : '') + '" data-page="' + i + '"' + (i === UIState.changelogPage ? ' aria-current="page"' : '') + '>' + i + '</button>';
    }
    if (endP < totalPages - 1) html += '<span class="page-info">...</span>';
    if (endP < totalPages) html += '<button class="page-btn" data-page="' + totalPages + '">' + totalPages + '</button>';
    html += '<button class="page-btn" data-page="' + (UIState.changelogPage + 1) + '"' + (UIState.changelogPage >= totalPages ? ' disabled' : '') + ' aria-label="下一页">›</button>';
    html += '<span class="page-info">共 ' + parseInt(total, 10) + ' 条</span>';
    container.innerHTML = html;
  }

  function changelogGoPage(page) {
    UIState.changelogPage = page;
    Renderers.changelog();
    var el = $('panel-changelog');
    if (el) el.scrollTop = 0;
  }

  var _tooltipInited = false;
  var _tooltipMouseoverHandler = null;
  var _tooltipMousemoveHandler = null;
  var _tooltipMouseoutHandler = null;
  function initTooltips() {
    if (_tooltipInited) return;
    _tooltipInited = true;
    var tooltip = $('tooltip');
    if (!tooltip) return;

    _tooltipMouseoverHandler = function(e) {
      var el = e.target.closest('[data-tooltip-title]');
      if (!el) return;
      var title = el.getAttribute('data-tooltip-title');
      var sub = el.getAttribute('data-tooltip-sub') || '';
      tooltip.innerHTML = '<div class="tooltip-title">' + escapeHtml(title) + '</div>' + (sub ? '<div class="tooltip-sub">' + escapeHtml(sub) + '</div>' : '');
      tooltip.classList.add('visible');
      positionTooltip(e);
    };
    var _tooltipRaf = false;
    var _tooltipLastX = 0;
    var _tooltipLastY = 0;
    _tooltipMousemoveHandler = function(e) {
      if (!e.target.closest('[data-tooltip-title]')) return;
      _tooltipLastX = e.clientX;
      _tooltipLastY = e.clientY;
      if (_tooltipRaf) return;
      _tooltipRaf = true;
      requestAnimationFrame(function() {
        _tooltipRaf = false;
        positionTooltipAt(_tooltipLastX, _tooltipLastY);
      });
    };
    _tooltipMouseoutHandler = function(e) {
      var el = e.target.closest('[data-tooltip-title]');
      if (!el) return;
      var related = e.relatedTarget;
      if (related && el.contains(related)) return;
      tooltip.classList.remove('visible');
      tooltip.setAttribute('aria-hidden', 'true');
    };

    document.addEventListener('mouseover', _tooltipMouseoverHandler, true);
    document.addEventListener('mousemove', _tooltipMousemoveHandler, true);
    document.addEventListener('mouseout', _tooltipMouseoutHandler, true);

    function positionTooltipAt(cx, cy) {
      var tooltip = $('tooltip');
      if (!tooltip) return;
      tooltip.setAttribute('aria-hidden', 'false');
      var x = cx + 12;
      var y = cy + 12;
      var rect = tooltip.getBoundingClientRect();
      if (x + rect.width > window.innerWidth - 16) x = cx - rect.width - 12;
      if (y + rect.height > window.innerHeight - 16) y = cy - rect.height - 12;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    }

    function positionTooltip(e) {
      positionTooltipAt(e.clientX, e.clientY);
    }
  }

  var DesignSection = {
    _sections: {},
    _animating: {},
    _handlers: {},
    _onToggle: null,
    _listeners: {},
    _persistKey: 'ds-section-state',

    onToggle: function(callback) {
      this._onToggle = typeof callback === 'function' ? callback : null;
    },

    on: function(event, callback) {
      if (typeof callback !== 'function') return;
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(callback);
    },

    off: function(event, callback) {
      if (!this._listeners[event]) return;
      if (!callback) { delete this._listeners[event]; return; }
      this._listeners[event] = this._listeners[event].filter(function(fn) { return fn !== callback; });
    },

    _emit: function(event, data) {
      var listeners = this._listeners[event];
      if (!listeners) return;
      listeners.forEach(function(fn) { try { fn(data); } catch (e) { if (CONFIG.DEBUG) console.error('[SectionManager] listener error:', e); } });
    },

    register: function(sectionEl) {
      if (!sectionEl || !sectionEl.id) return;
      var header = sectionEl.querySelector('.ds-section__header--toggle');
      if (!header) return;
      if (this._handlers[sectionEl.id]) {
        this.destroy(sectionEl.id);
      }
      this._sections[sectionEl.id] = {
        el: sectionEl,
        header: header,
        body: sectionEl.querySelector('.ds-section__body'),
        description: sectionEl.querySelector('.ds-section__description'),
        footer: sectionEl.querySelector('.ds-section__footer'),
        collapsed: sectionEl.classList.contains('ds-section--collapsed'),
        variant: sectionEl.getAttribute('data-variant') || 'default',
        spacing: sectionEl.getAttribute('data-spacing') || 'default'
      };
      var self = this;
      var clickHandler = function(e) {
        e.preventDefault();
        self.toggle(sectionEl.id);
      };
      var keyHandler = function(e) {
        var key = e.key || '';
        var code = e.keyCode ?? 0;
        if (key === 'Enter' || key === ' ' || code === 13 || code === 32) {
          e.preventDefault();
          self.toggle(sectionEl.id);
        }
      };
      header.addEventListener('click', clickHandler);
      header.addEventListener('keydown', keyHandler);
      this._handlers[sectionEl.id] = { click: clickHandler, keydown: keyHandler, header: header };
      this._emit('register', { id: sectionEl.id, variant: sectionEl.getAttribute('data-variant') });
    },

    toggle: function(sectionId) {
      var entry = this._sections[sectionId];
      if (!entry) return;
      var section = entry.el;
      var header = entry.header;
      var isCollapsed = section.classList.contains('ds-section--collapsed');
      section.classList.toggle('ds-section--collapsed');
      entry.collapsed = !isCollapsed;
      header.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false');
      var detail = { id: sectionId, collapsed: !isCollapsed, variant: entry.variant };
      if (this._onToggle) this._onToggle(sectionId, !isCollapsed);
      this._emit('toggle', detail);
      this._persistState();
    },

    collapse: function(sectionId) {
      var entry = this._sections[sectionId];
      if (!entry || entry.collapsed) return;
      var section = entry.el;
      var header = entry.header;
      section.classList.add('ds-section--collapsed');
      entry.collapsed = true;
      header.setAttribute('aria-expanded', 'false');
      this._emit('collapse', { id: sectionId, variant: entry.variant });
      this._persistState();
    },

    expand: function(sectionId) {
      var entry = this._sections[sectionId];
      if (!entry || !entry.collapsed) return;
      var section = entry.el;
      var header = entry.header;
      section.classList.remove('ds-section--collapsed');
      entry.collapsed = false;
      header.setAttribute('aria-expanded', 'true');
      this._emit('expand', { id: sectionId, variant: entry.variant });
      this._persistState();
    },

    expandAll: function() {
      var self = this;
      var expanded = [];
      Object.keys(this._sections).forEach(function(id) {
        if (self._sections[id].collapsed) { self.expand(id); expanded.push(id); }
      });
      this._emit('expandAll', { ids: expanded });
    },

    collapseAll: function() {
      var self = this;
      var collapsed = [];
      Object.keys(this._sections).forEach(function(id) {
        if (!self._sections[id].collapsed) { self.collapse(id); collapsed.push(id); }
      });
      this._emit('collapseAll', { ids: collapsed });
    },

    isCollapsed: function(sectionId) {
      var entry = this._sections[sectionId];
      return entry ? entry.collapsed : false;
    },

    getState: function(sectionId) {
      var entry = this._sections[sectionId];
      if (!entry) return null;
      return {
        id: sectionId,
        collapsed: entry.collapsed,
        variant: entry.variant,
        spacing: entry.spacing
      };
    },

    getAllStates: function() {
      var self = this;
      return Object.keys(this._sections).map(function(id) {
        return self.getState(id);
      });
    },

    getRegisteredIds: function() {
      return Object.keys(this._sections);
    },

    getByVariant: function(variant) {
      var self = this;
      return Object.keys(this._sections).filter(function(id) {
        return self._sections[id].variant === variant;
      });
    },

    _persistState: function() {
      try {
        var state = {};
        var self = this;
        Object.keys(this._sections).forEach(function(id) {
          state[id] = self._sections[id].collapsed;
        });
        sessionStorage.setItem(this._persistKey, JSON.stringify(state));
      } catch (e) { if (CONFIG.DEBUG) console.warn('[CollapsibleSection] saveState error:', e); }
    },

    restoreState: function() {
      try {
        var raw = sessionStorage.getItem(this._persistKey);
        if (!raw) return;
        var state = _sanitizeObj(JSON.parse(raw));
        if (typeof state !== 'object' || state === null) return;
        var self = this;
        Object.keys(state).forEach(function(id) {
          if (self._sections[id]) {
            if (state[id] && !self._sections[id].collapsed) self.collapse(id);
            else if (!state[id] && self._sections[id].collapsed) self.expand(id);
          }
        });
      } catch (e) { if (CONFIG.DEBUG) console.warn('[CollapsibleSection] restoreState error:', e); }
    },

    initAll: function() {
      var self = this;
      var existingIds = {};
      var collapsibles = document.querySelectorAll('.ds-section--collapsible');
      Array.prototype.forEach.call(collapsibles, function(el) {
        existingIds[el.id] = true;
        if (!self._sections[el.id] || !document.body.contains(self._sections[el.id].el)) {
          delete self._sections[el.id];
          self.register(el);
        }
      });
      Object.keys(this._sections).forEach(function(id) {
        if (!existingIds[id] || !document.body.contains(self._sections[id].el)) {
          self.destroy(id);
        }
      });
      this.restoreState();
    },

    destroy: function(sectionId) {
      if (sectionId) {
        var handlers = this._handlers[sectionId];
        if (handlers && handlers.header) {
          handlers.header.removeEventListener('click', handlers.click);
          handlers.header.removeEventListener('keydown', handlers.keydown);
        }
        delete this._sections[sectionId];
        delete this._animating[sectionId];
        delete this._handlers[sectionId];
        this._emit('destroy', { id: sectionId });
      } else {
        var self = this;
        Object.keys(this._handlers).forEach(function(id) {
          var h = self._handlers[id];
          if (h && h.header) {
            h.header.removeEventListener('click', h.click);
            h.header.removeEventListener('keydown', h.keydown);
          }
        });
        this._sections = {};
        this._animating = {};
        this._handlers = {};
      }
    }
  };

  var PanoramaVisibilityManager = {
    update: function(activePanel) {
      if (PanoramaEngine._initialized) {
        var panoramaSection = $('panel-panorama');
        if (panoramaSection) {
          if (activePanel === 'panorama') {
            panoramaSection.style.visibility = '';
            panoramaSection.style.position = '';
            panoramaSection.style.height = '';
            panoramaSection.style.overflow = '';
            PanoramaEngine.setVisibility(true);
            PanoramaEngine.restartAnimation();
          } else {
            PanoramaEngine.setVisibility(false);
            panoramaSection.style.visibility = 'hidden';
            panoramaSection.style.position = 'absolute';
            panoramaSection.style.height = '0';
            panoramaSection.style.overflow = 'hidden';
          }
        }
      }
    }
  };

  var _tabNavEl = null;
  var _tabClickHandler = null;
  var _tabKeydownHandler = null;
  var _tabGlobalKeydownHandler = null;
  var _hashchangeHandler = null;
  var _navDrawerKeydownHandler = null;
  var _navDrawerFocusTrapCleanup = null;
  var _tabObserver = null;
  var _tabIndicator = null;
  var _managedListeners = [];

  function _updateTabIndicator(tab) {
    if (!_tabIndicator || !_tabNavEl || !tab) return;
    var navRect = _tabNavEl.getBoundingClientRect();
    var tabRect = tab.getBoundingClientRect();
    _tabIndicator.style.left = (tabRect.left - navRect.left) + 'px';
    _tabIndicator.style.width = tabRect.width + 'px';
  }

  var _navDrawerOpen = false;

  function initNavDrawer() {
    var toggleBtn = $('nav-drawer-toggle');
    var closeBtn = $('nav-drawer-close');
    var drawer = $('nav-drawer');
    var backdrop = $('nav-drawer-backdrop');
    var drawerList = $('nav-drawer-list');
    if (!drawer || !toggleBtn) return;

    var tabs = document.querySelectorAll('.tab');
    var items = [];
    tabs.forEach(function(tab) {
      var iconEl = tab.querySelector('.tab-icon svg');
      var item = document.createElement('button');
      item.className = 'nav-drawer-item' + (tab.classList.contains('active') ? ' active' : '');
      item.setAttribute('role', 'tab');
      item.setAttribute('data-panel', tab.dataset.panel);
      if (iconEl) item.appendChild(iconEl.cloneNode(true));
      var labelSpan = document.createElement('span');
      labelSpan.textContent = tab.textContent.trim();
      item.appendChild(labelSpan);
      item.addEventListener('click', function() {
        var targetTab = document.querySelector('.tab[data-panel="' + tab.dataset.panel + '"]');
        if (targetTab) targetTab.click();
        closeNavDrawer();
      });
      items.push(item);
      drawerList.appendChild(item);
    });

    function openNavDrawer() {
      _navDrawerOpen = true;
      drawer.classList.add('active');
      backdrop.classList.add('active');
      toggleBtn.setAttribute('aria-expanded', 'true');
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'true');
      drawer.setAttribute('aria-label', '导航菜单');
      document.body.style.overflow = 'hidden';
      _navDrawerFocusTrapCleanup = A11y.trapFocus(drawer);
    }

    function closeNavDrawer() {
      _navDrawerOpen = false;
      drawer.classList.remove('active');
      backdrop.classList.remove('active');
      toggleBtn.setAttribute('aria-expanded', 'false');
      drawer.setAttribute('role', 'navigation');
      drawer.removeAttribute('aria-modal');
      drawer.removeAttribute('aria-label');
      document.body.style.overflow = '';
      if (_navDrawerFocusTrapCleanup) {
        _navDrawerFocusTrapCleanup();
        _navDrawerFocusTrapCleanup = null;
      }
      toggleBtn.focus();
    }

    toggleBtn.addEventListener('click', function() {
      if (_navDrawerOpen) closeNavDrawer(); else openNavDrawer();
    });
    if (closeBtn) closeBtn.addEventListener('click', closeNavDrawer);
    backdrop.addEventListener('click', closeNavDrawer);

    _navDrawerKeydownHandler = function(e) {
      if (e.key === 'Escape' && _navDrawerOpen) closeNavDrawer();
    };
    document.addEventListener('keydown', _navDrawerKeydownHandler);

    _tabObserver = new MutationObserver(function() {
      tabs.forEach(function(tab, idx) {
        if (items[idx]) {
          if (tab.classList.contains('active')) items[idx].classList.add('active');
          else items[idx].classList.remove('active');
        }
      });
    });
    tabs.forEach(function(tab) {
      _tabObserver.observe(tab, { attributes: true, attributeFilter: ['class'] });
    });
  }

  function initTabs() {
    var tabs = document.querySelectorAll('.tab');
    var tabArray = Array.prototype.slice.call(tabs);
    _tabNavEl = document.querySelector('.nav');

    if (_tabNavEl) {
      _tabNavEl.setAttribute('role', 'tablist');
      _tabIndicator = document.createElement('div');
      _tabIndicator.className = 'tab-indicator';
      _tabIndicator.setAttribute('aria-hidden', 'true');
      _tabNavEl.appendChild(_tabIndicator);
    }

    tabs.forEach(function(tab, idx) {
      tab.setAttribute('role', 'tab');
      var panelId = tab.getAttribute('data-panel');
      if (panelId) {
        tab.setAttribute('aria-controls', panelId);
        var panel = document.getElementById(panelId);
        if (panel) {
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('aria-labelledby', tab.id || ('tab-' + idx));
        }
      }
    });

    function activateTab(tab) {
      tabs.forEach(function(t) {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
        t.setAttribute('tabindex', '-1');
      });
      var prevPanel = document.querySelector('.panel.active');
      if (prevPanel) {
        prevPanel.classList.add('panel-exit');
        var prevPanelRef = prevPanel;
        setTimeout(function() { prevPanelRef.classList.remove('panel-exit', 'active'); }, 200);
      }
      document.querySelectorAll('.panel').forEach(function(p) { if (p !== prevPanel) p.classList.remove('active'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      tab.setAttribute('tabindex', '0');
      tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      _updateTabIndicator(tab);
      invalidateDomCache();
      var panelName = tab.dataset.panel;
      try { history.replaceState(null, '', '#' + panelName); } catch (e) { if (CONFIG.DEBUG && typeof console !== 'undefined') console.warn('[Harness] history.replaceState error:', e); }
      var panel = $('panel-' + panelName);
      if (panel) {
        panel.classList.add('active', 'panel-enter');
        setTimeout(function() {
          panel.classList.remove('panel-enter');
          var firstFocusable = panel.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (firstFocusable) firstFocusable.focus();
          else panel.focus();
        }, 400);
        if (PanoramaEngine._initialized) {
          PanoramaVisibilityManager.update(panelName);
        }
        if (Renderers[panelName]) {
          scheduleRender(panelName, function() { Renderers[panelName](); });
        }
        DataLayer.setActivePanel(panelName);
        if (typeof A11y !== 'undefined') {
          A11y.announce('已切换到' + tab.textContent.trim() + '面板');
        }
      }
    }

    var activeTab = document.querySelector('.tab.active');
    if (activeTab && _tabIndicator) {
      requestAnimationFrame(function() { _updateTabIndicator(activeTab); });
    }

    var hashPanel = window.location.hash.slice(1);
    if (hashPanel && /^[a-zA-Z0-9_-]+$/.test(hashPanel)) {
      var hashTab = document.querySelector('.tab[data-panel="' + hashPanel + '"]');
      if (hashTab) activateTab(hashTab);
    }

    _hashchangeHandler = function() {
      var h = window.location.hash.slice(1);
      if (h && /^[a-zA-Z0-9_-]+$/.test(h)) {
        var t = document.querySelector('.tab[data-panel="' + h + '"]');
        if (t) activateTab(t);
      }
    };
    window.addEventListener('hashchange', _hashchangeHandler);

    _tabGlobalKeydownHandler = function(e) {
      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        var idx = parseInt(e.key, 10) - 1;
        if (idx < tabArray.length) {
          e.preventDefault();
          activateTab(tabArray[idx]);
        }
      }
    };
    document.addEventListener('keydown', _tabGlobalKeydownHandler);

    _tabClickHandler = function(e) {
      var tab = e.target.closest('.tab');
      if (tab) activateTab(tab);
    };

    _tabKeydownHandler = function(e) {
      var tab = e.target.closest('.tab');
      if (!tab) return;
      var idx = tabArray.indexOf(tab);
      var newIdx = -1;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(tab); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); newIdx = (idx + 1) % tabArray.length; }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); newIdx = (idx - 1 + tabArray.length) % tabArray.length; }
      else if (e.key === 'Home') { e.preventDefault(); newIdx = 0; }
      else if (e.key === 'End') { e.preventDefault(); newIdx = tabArray.length - 1; }
      if (newIdx >= 0) activateTab(tabArray[newIdx]);
    };

    if (_tabNavEl) {
      _tabNavEl.addEventListener('click', _tabClickHandler);
      _tabNavEl.addEventListener('keydown', _tabKeydownHandler);
    }
  }

  var _globalClickHandler = null;
  var _globalKeydownHandler = null;
  var _pointerdownHandler = null;
  var _focusinHandler = null;
  var _focusoutHandler = null;

  function _toggleExpanded(triggerEl, parentSelector) {
    var parent = triggerEl.closest(parentSelector);
    if (parent) {
      parent.classList.toggle('expanded');
      var isExpanded = parent.classList.contains('expanded');
      triggerEl.setAttribute('aria-expanded', String(isExpanded));
    }
  }

  function initGlobalEventDelegation() {
    _globalClickHandler = function(e) {
      var reloadBtn = e.target.closest('[data-action="reload-page"]');
      if (reloadBtn) {
        location.reload();
        return;
      }

      var retryBtn = e.target.closest('[data-retry]');
      if (retryBtn) {
        var containerId = retryBtn.getAttribute('data-retry');
        if (containerId) {
          var container = $(containerId);
          if (container) DataLayer.fetchAll().catch(function(e) { if (CONFIG.DEBUG) console.warn('[Harness] retry fetch error:', e); });
        }
        return;
      }

      var toggleTarget = e.target.closest('[data-action="toggle-phase"], [data-action="toggle-changelog"]');
      if (toggleTarget) {
        var parentSel = toggleTarget.getAttribute('data-action') === 'toggle-phase' ? '.phase-detail-panel' : '.changelog-entry';
        _toggleExpanded(toggleTarget, parentSel);
        return;
      }

      var sectionToggle = e.target.closest('.ds-section__header--toggle');
      if (sectionToggle) {
        var section = sectionToggle.closest('.ds-section--collapsible');
        if (section && section.id && DesignSection) {
          DesignSection.toggle(section.id);
        }
        return;
      }

      var wfNode = e.target.closest('.wf-node[data-phase-index]');
      if (wfNode) {
        var idx = wfNode.getAttribute('data-phase-index');
        var detailPanel = document.querySelector('.phase-detail-panel[data-phase-index="' + idx + '"]');
        if (detailPanel) {
          detailPanel.classList.toggle('expanded');
          var header = detailPanel.querySelector('[aria-expanded]');
          if (header) header.setAttribute('aria-expanded', String(detailPanel.classList.contains('expanded')));
          if (detailPanel.classList.contains('expanded')) {
            detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
        return;
      }

      var pageBtn = e.target.closest('.changelog-pagination .page-btn[data-page]');
      if (pageBtn && !pageBtn.disabled) {
        var page = parseInt(pageBtn.getAttribute('data-page'), 10);
        if (!isNaN(page)) changelogGoPage(page);
        return;
      }

      var filterBtn = e.target.closest('.filter-btn[data-filter]');
      if (filterBtn) {
        var filterBar = filterBtn.closest('.filter-bar');
        if (filterBar) {
          filterBar.querySelectorAll('.filter-btn').forEach(function(b) {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
          });
          filterBtn.classList.add('active');
          filterBtn.setAttribute('aria-pressed', 'true');
          var filterValue = filterBtn.getAttribute('data-filter');
          var panel = filterBar.closest('[id^="panel-"]');
          if (panel) {
            var panelId = panel.id.replace('panel-', '');
            if (panelId === 'agents') Renderers.agents(filterValue);
            else if (panelId === 'skills') Renderers.skills(filterValue);
          }
        }
        return;
      }

      var closeModal = e.target.closest('[data-action="close-modal"]');
      if (closeModal) {
        ModalManager.close();
        return;
      }

      var refreshBtn = e.target.closest('#btn-refresh');
      if (refreshBtn) {
        refreshBtn.classList.add('spinning');
        DataLayer.clearCache();
        DataLayer.fetchAll().then(function() {
          setTimeout(function() { refreshBtn.classList.remove('spinning'); }, 600);
        }).catch(function(err) {
          refreshBtn.classList.remove('spinning');
          showToast('刷新失败，请稍后重试', 'error');
          if (CONFIG.DEBUG) console.error('Refresh failed:', err);
        });
        return;
      }

      var retryBtn = e.target.closest('.error-boundary-retry[data-retry]');
      if (retryBtn) {
        var retryFn = retryBtn.getAttribute('data-retry');
        var RETRY_FN_MAP = { 'location-reload': function() { location.reload(); }, 'data-layer-fetch': function() { DataLayer.fetchAll().catch(function(e) { if (CONFIG.DEBUG) console.warn('[Harness] retry fetch error:', e); }); } };
        if (retryFn && RETRY_FN_MAP[retryFn]) {
          RETRY_FN_MAP[retryFn]();
        } else {
          location.reload();
        }
        return;
      }
    };

    _globalKeydownHandler = function(e) {
      if (e.key === 'Escape') {
        var modal = document.querySelector('.modal-overlay--visible');
        if (modal) {
          ModalManager.close();
          e.preventDefault();
          return;
        }
      }
      if (e.key === 'Enter' || e.key === ' ') {
        var toggleEl = e.target.closest('[data-action="toggle-phase"], [data-action="toggle-changelog"]');
        if (toggleEl) {
          e.preventDefault();
          toggleEl.click();
          return;
        }
        var sectionToggle = e.target.closest('.ds-section__header--toggle');
        if (sectionToggle) {
          e.preventDefault();
          sectionToggle.click();
          return;
        }
      }
    };

    document.addEventListener('click', _globalClickHandler, { passive: true });
    document.addEventListener('keydown', _globalKeydownHandler);

    _pointerdownHandler = function(e) {
      var btn = e.target.closest('button, .tab, .filter-btn, .page-btn, .pill-btn, .icon-btn, .changelog-action-btn, .banner-action');
      if (btn && !btn.disabled) InteractionState.togglePressed(btn);
    };
    _focusinHandler = function(e) {
      var target = e.target;
      if (target.matches && target.matches('button, .tab, .filter-btn, .page-btn, .pill-btn, .icon-btn, .search-input, select, a[tabindex]')) {
        InteractionState.setFocusRing(target, true);
      }
    };
    _focusoutHandler = function(e) {
      InteractionState.setFocusRing(e.target, false);
    };
    document.addEventListener('pointerdown', _pointerdownHandler, { passive: true });
    document.addEventListener('focusin', _focusinHandler, { passive: true });
    document.addEventListener('focusout', _focusoutHandler, { passive: true });
  }

  function initFilters() {

    var skillSearch = $('skill-search');
    if (skillSearch) {
      skillSearch.setAttribute('maxlength', '256');
      skillSearch.setAttribute('aria-label', '搜索技能');
      var onSkillSearch = debounce(function() { UIState.skillSearchQuery = skillSearch.value.substring(0, 256); Renderers.skills(); }, 200);
      skillSearch.addEventListener('input', onSkillSearch);
      _managedListeners.push({ el: skillSearch, type: 'input', fn: onSkillSearch });
    }

    var sessionSearch = $('session-search');
    if (sessionSearch) {
      sessionSearch.setAttribute('maxlength', '256');
      sessionSearch.setAttribute('aria-label', '搜索会话');
      var onSessionSearch = debounce(function() { UIState.sessionSearchQuery = sessionSearch.value.substring(0, 256); Renderers.sessions(); }, 200);
      sessionSearch.addEventListener('input', onSessionSearch);
      _managedListeners.push({ el: sessionSearch, type: 'input', fn: onSessionSearch });
    }

    var auditSearch = $('audit-search');
    if (auditSearch) {
      auditSearch.setAttribute('maxlength', '256');
      auditSearch.setAttribute('aria-label', '搜索审计日志');
      var onAuditSearch = debounce(function() { UIState.auditSearchQuery = auditSearch.value.substring(0, 256); Renderers.audit(); }, 200);
      auditSearch.addEventListener('input', onAuditSearch);
      _managedListeners.push({ el: auditSearch, type: 'input', fn: onAuditSearch });
    }

    var expandAll = $('btn-expand-all');
    var collapseAll = $('btn-collapse-all');
    if (expandAll) {
      var onExpandAll = function() { document.querySelectorAll('.changelog-entry').forEach(function(e) { e.classList.add('expanded'); }); };
      expandAll.addEventListener('click', onExpandAll);
      _managedListeners.push({ el: expandAll, type: 'click', fn: onExpandAll });
    }
    if (collapseAll) {
      var onCollapseAll = function() { document.querySelectorAll('.changelog-entry').forEach(function(e) { e.classList.remove('expanded'); }); };
      collapseAll.addEventListener('click', onCollapseAll);
      _managedListeners.push({ el: collapseAll, type: 'click', fn: onCollapseAll });
    }

    var searchInput = $('changelog-search');
    var categoryFilter = $('changelog-category-filter');
    var sinceInput = $('changelog-since');
    var untilInput = $('changelog-until');
    function triggerChangelogSearch() {
      UIState.changelogPage = 1;
      Renderers.changelog();
    }
    if (searchInput) {
      var onChangelogSearch = debounce(triggerChangelogSearch, 300);
      searchInput.addEventListener('input', onChangelogSearch);
      _managedListeners.push({ el: searchInput, type: 'input', fn: onChangelogSearch });
    }
    if (categoryFilter) {
      categoryFilter.addEventListener('change', triggerChangelogSearch);
      _managedListeners.push({ el: categoryFilter, type: 'change', fn: triggerChangelogSearch });
    }
    if (sinceInput) {
      sinceInput.addEventListener('change', triggerChangelogSearch);
      _managedListeners.push({ el: sinceInput, type: 'change', fn: triggerChangelogSearch });
    }
    if (untilInput) {
      untilInput.addEventListener('change', triggerChangelogSearch);
      _managedListeners.push({ el: untilInput, type: 'change', fn: triggerChangelogSearch });
    }

    var _archiveAbortCtrl = null;
    var archiveBtn = $('btn-changelog-archive');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', function() {
        var panel = $('changelog-archive-panel');
        if (!panel) return;
        if (!panel.classList.contains('hidden') && panel.innerHTML) { panel.classList.add('hidden'); return; }
        panel.classList.remove('hidden');
        panel.innerHTML = '<div class="archive-panel"><div class="archive-panel-title">📦 存档记录</div><div class="loading-overlay"><div class="spinner"></div></div></div>';
        if (_archiveAbortCtrl) { try { _archiveAbortCtrl.abort(); } catch (e) { if (CONFIG.DEBUG) console.warn('archive abort failed:', e); } }
        _archiveAbortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        _fetchWithTimeout(API + '/api/changelog/archive', _archiveAbortCtrl ? { signal: _archiveAbortCtrl.signal } : undefined).then(function(r) { if (!r.ok) throw new Error('接口返回错误: ' + r.status); return r.json(); }).then(function(data) {
          var html = '<div class="archive-panel"><div class="archive-panel-title">📦 存档记录</div>';
          if (data && data.items && data.items.length > 0) {
            html += '<div class="archive-stats-grid"><div class="archive-stat-card"><div class="archive-stat-label">存档总数</div><div class="archive-stat-value">' + escapeHtml(String(data.total ?? 0)) + '</div></div>' +
              '<div class="archive-stat-card"><div class="archive-stat-label">当前页</div><div class="archive-stat-value">' + escapeHtml(String(data.page ?? 0)) + '/' + escapeHtml(String(data.totalPages ?? 0)) + '</div></div></div>';
            html += '<div class="archive-items-list">';
            for (var i = 0; i < data.items.length; i++) {
              var item = data.items[i];
              html += '<div class="changelog-item"><div class="changelog-item-title">v' + escapeHtml(item.version || '—') + '</div>' +
                '<div class="changelog-item-value">' + escapeHtml(item.date || '—') + ' · ' + escapeHtml(item.summary || '—') + ' · ' + escapeHtml(item.agent || '—') + '</div></div>';
            }
            html += '</div>';
          } else {
            html += Components.emptyState('', '暂无存档记录');
          }
          html += '</div>';
          panel.innerHTML = html;
        }).catch(function(err) { if (err && err.name === 'AbortError') return; panel.innerHTML = '<div class="archive-panel"><div class="verify-result fail">加载存档失败</div></div>'; });
      });
    }

    var _verifyAbortCtrl = null;
    var verifyBtn = $('btn-changelog-verify');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', function() {
        var panel = $('changelog-archive-panel');
        if (!panel) return;
        panel.classList.remove('hidden');
        panel.innerHTML = '<div class="archive-panel"><div class="archive-panel-title">🔍 完整性校验</div><div class="loading-overlay"><div class="spinner"></div></div></div>';
        if (_verifyAbortCtrl) { try { _verifyAbortCtrl.abort(); } catch (e) { if (CONFIG.DEBUG) console.warn('abort error:', e); } }
        _verifyAbortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        _fetchWithTimeout(API + '/api/changelog/verify', _verifyAbortCtrl ? { signal: _verifyAbortCtrl.signal } : undefined).then(function(r) { if (!r.ok) throw new Error('接口返回错误: ' + r.status); return r.json(); }).then(function(result) {
          var html = '<div class="archive-panel"><div class="archive-panel-title">🔍 完整性校验结果</div>';
          if (result && result.indexValid && result.recordsTampered === 0) {
            html += '<div class="verify-result pass">✅ 所有记录完整，未被篡改（共 ' + escapeHtml(String(result.total ?? 0)) + ' 条，' + escapeHtml(String(result.recordsValid ?? 0)) + ' 条有效）</div>';
          } else {
            html += '<div class="verify-result fail">❌ 检测到异常：索引有效=' + escapeHtml(String(result.indexValid ?? 'N/A')) + '，篡改记录=' + escapeHtml(String(result.recordsTampered ?? 'N/A')) + '</div>';
          }
          html += '</div>';
          panel.innerHTML = html;
        }).catch(function(err) { if (err && err.name === 'AbortError') return; panel.innerHTML = '<div class="archive-panel"><div class="verify-result fail">校验请求失败</div></div>'; });
      });
    }
  }

  var _storeUnsubscribers = [];

  function bindStoreSubscriptions() {
    var deepeningKeys = [
      'deepeningDashboard', 'deepeningMetrics', 'deepeningCache',
      'deepeningConvergence', 'deepeningReport', 'deepeningHealthMonitor',
      'deepeningDependencies', 'deepeningThrottle', 'deepeningValidator',
      'deepeningLocks', 'deepeningEventReplay', 'deepeningPriorityQueue',
      'deepeningMetricsAggregator', 'deepeningRateLimiter', 'deepeningSnapshotStore',
      'deepeningBackpressure', 'deepeningConnectionPool', 'deepeningRetryPolicy',
      'deepeningServiceRegistry', 'deepeningLoadBalancer', 'deepeningTimeoutManager',
      'deepeningGracefulShutdown', 'deepeningFeatureFlags', 'deepeningCircuitBreaker',
      'deepeningTaskScheduler', 'deepeningDataPipeline', 'deepeningStateManager',
      'deepeningEventBus', 'deepeningConfigManager', 'deepeningResourceManager',
      'deepeningAuditTrail'
    ];
    var deepeningRenderFn = function(key) {
      var panelCfg = null;
      for (var pi = 0; pi < DEEPENING_STATS_PANELS.length; pi++) {
        if (DEEPENING_STATS_PANELS[pi].storeKey === key) { panelCfg = DEEPENING_STATS_PANELS[pi]; break; }
      }
      if (panelCfg) {
        scheduleRender('deepening-' + key, function() {
          _renderDeepeningStatsPanel(panelCfg.elId, panelCfg.storeKey, panelCfg);
        });
      } else {
        scheduleRender('deepening', function() { Renderers.deepening(); });
      }
    };

    _storeUnsubscribers = [
      Store.subscribe('overview', function() { scheduleRender('panorama', function() { Renderers.panorama(); }); }),
      Store.subscribe('workflow', function() { scheduleRender('workflow', function() { Renderers.workflow(); }); }),
      Store.subscribe('agents', function() { scheduleRender('agents', function() { Renderers.agents(); }); scheduleRender('architecture', function() { Renderers.architecture(); }); scheduleRender('frameworkFeatures', function() { Renderers._frameworkFeatures(); }); scheduleRender('panorama', function() { Renderers.panorama(); }); }),
      Store.subscribe('skills', function() { scheduleRender('skills', function() { Renderers.skills(); }); scheduleRender('panorama', function() { Renderers.panorama(); }); }),
      Store.subscribe('sessions', function() { scheduleRender('sessions', function() { Renderers.sessions(); }); }),
      Store.subscribe('changelog', function() { scheduleRender('changelog', function() { Renderers.changelog(); }); }),
      Store.subscribe('autoVersionStats', function() { scheduleRender('changelog', function() { Renderers.changelog(); }); }),
      Store.subscribe('autoVersionRecent', function() { scheduleRender('changelog', function() { Renderers.changelog(); }); }),
      Store.subscribe('compliance', function() { scheduleRender('compliance', function() { Renderers.compliance(); }); }),
      Store.subscribe('audit', function() { scheduleRender('audit', function() { Renderers.audit(); }); }),
      Store.subscribe('config', function() { scheduleRender('panorama', function() { Renderers.panorama(); }); scheduleRender('architecture', function() { Renderers.architecture(); }); scheduleRender('frameworkFeatures', function() { Renderers._frameworkFeatures(); }); }),
      Store.subscribe('memory', function() { scheduleRender('compliance', function() { Renderers.compliance(); }); }),
      Store.subscribe('checkpoints', function() { scheduleRender('workflow', function() { Renderers.workflow(); }); scheduleRender('frameworkFeatures', function() { Renderers._frameworkFeatures(); }); }),
      Store.subscribe('learnings', function() { scheduleRender('workflow', function() { Renderers.workflow(); }); scheduleRender('frameworkFeatures', function() { Renderers._frameworkFeatures(); }); }),
      Store.subscribe('workflowTemplates', function() { scheduleRender('workflow', function() { Renderers.workflow(); }); scheduleRender('frameworkFeatures', function() { Renderers._frameworkFeatures(); }); }),
      Store.subscribe('deviations', function() { scheduleRender('compliance', function() { Renderers.compliance(); }); }),
      Store.subscribe('codeReviews', function() { scheduleRender('compliance', function() { Renderers.compliance(); }); }),
    ];
    deepeningKeys.forEach(function(key) {
      (function(k) {
        _storeUnsubscribers.push(Store.subscribe(k, function() { deepeningRenderFn(k); }));
      })(key);
    });
    var infrastructureKeys = ['infrastructureHealthChecker', 'infrastructurePriorityQueue', 'infrastructureEventBus'];
    var infrastructureRenderFn = function(key) {
      var panelCfg = null;
      for (var pi = 0; pi < INFRASTRUCTURE_STATS_PANELS.length; pi++) {
        if (INFRASTRUCTURE_STATS_PANELS[pi].storeKey === key) { panelCfg = INFRASTRUCTURE_STATS_PANELS[pi]; break; }
      }
      if (panelCfg) {
        scheduleRender('infrastructure-' + key, function() {
          _renderDeepeningStatsPanel(panelCfg.elId, panelCfg.storeKey, panelCfg);
        });
      }
    };
    infrastructureKeys.forEach(function(key) {
      (function(k) {
        _storeUnsubscribers.push(Store.subscribe(k, function() { infrastructureRenderFn(k); }));
      })(key);
    });
    _storeUnsubscribers.push(Store.subscribe('designStats', function() { scheduleRender('design', function() { Renderers.design(); }); }));
    _storeUnsubscribers.push(Store.subscribe('designPresets', function() { scheduleRender('design', function() { Renderers.design(); }); }));
    _storeUnsubscribers.push(Store.subscribe('frameworkArchitecture', function() { scheduleRender('architecture', function() { Renderers.architecture(); }); }));
    _storeUnsubscribers.push(Store.subscribe('frameworkFeatures', function() { scheduleRender('architecture', function() { Renderers.architecture(); }); scheduleRender('frameworkFeatures', function() { Renderers._frameworkFeatures(); }); }));
    _storeUnsubscribers.push(Store.subscribe('panoramaMetadata', function() { scheduleRender('panorama', function() { Renderers.panorama(); }); }));
    var _collaborationKeys = ['subagentStats', 'subagentBudget', 'skillLayerStats', 'skillDedup', 'skillContext', 'channelStats', 'collaborationModes', 'collaborationStats', 'collaborationHistory', 'intentStats', 'intentSchemas', 'pairChatStats', 'pairChatSessions', 'chatChainStats', 'chatChainChains', 'outputFusionStats', 'generatorVerifierStats', 'generatorVerifierHistory', 'isolatedContextStats', 'isolatedContextActive', 'planStats', 'planActive'];
    _collaborationKeys.forEach(function(key) {
      _storeUnsubscribers.push(Store.subscribe(key, function() { scheduleRender('collaboration', function() { Renderers.collaboration(); }); }));
    });
    var _knowledgeKeys = ['sqliteStats', 'memoryEntries', 'memoryUsage', 'userProfile', 'skillImprovementPending', 'skillImprovementStats', 'skillCreationList', 'skillCreationStats', 'skillCuratorStats', 'nudgeStats', 'mcpStatus', 'mcpTools', 'affinityStats', 'affinityRecords'];
    _knowledgeKeys.forEach(function(key) {
      _storeUnsubscribers.push(Store.subscribe(key, function() { scheduleRender('knowledge', function() { Renderers.knowledge(); }); }));
    });
  }

  var FrameworkMonitor = (function() {
    var _lastVersion = null;
    var _versionCheckInterval = null;
    var _statusCheckInterval = null;
    var _versionVerifyPending = false;
    var _reloadAttemptCount = 0;
    var _maxReloadAttempts = 3;
    var _COMPATIBLE_VERSION = '2.72.1';
    var _COMPATIBLE_VERSION_RANGE = { major: 2, minor: 72 };
    var _loadLog = [];
    var MAX_LOAD_LOG = 500;
    var _loadState = 'pending';
    var _loadStartTime = Date.now();
    var _resourceLoadOrder = [];
    var _criticalResources = [
      'frameworkVersion', 'frameworkStatus', 'config', 'overview'
    ];
    var _coreResources = [
      'overview', 'agents', 'skills', 'sessions', 'workflow',
      'changelog', 'audit', 'config', 'memory', 'checkpoints',
      'learnings', 'workflowTemplates', 'compliance', 'deviations',
      'codeReviews', 'designStats', 'designPresets',
      'frameworkVersion', 'frameworkStatus'
    ];
    var _deepeningResources = [
      'deepeningDashboard', 'deepeningMetrics', 'deepeningCache',
      'deepeningConvergence', 'deepeningReport', 'deepeningHealthMonitor',
      'deepeningDependencies', 'deepeningThrottle', 'deepeningValidator',
      'deepeningLocks', 'deepeningEventReplay', 'deepeningPriorityQueue',
      'deepeningMetricsAggregator', 'deepeningRateLimiter', 'deepeningSnapshotStore',
      'deepeningBackpressure', 'deepeningConnectionPool', 'deepeningRetryPolicy',
      'deepeningServiceRegistry', 'deepeningLoadBalancer', 'deepeningTimeoutManager',
      'deepeningGracefulShutdown', 'deepeningFeatureFlags', 'deepeningCircuitBreaker',
      'deepeningTaskScheduler', 'deepeningDataPipeline', 'deepeningStateManager',
      'deepeningEventBus', 'deepeningConfigManager', 'deepeningResourceManager',
      'deepeningAuditTrail'
    ];
    var _infrastructureResources = [
      'infrastructureHealthChecker', 'infrastructurePriorityQueue', 'infrastructureEventBus'
    ];
    var _expectedResources = _coreResources.slice();
    var MAX_EXPECTED_RESOURCES = 200;
    var _allResources = _coreResources.concat(_deepeningResources).concat(_infrastructureResources);
    var _loadedResources = {};
    var _failedResources = {};
    var _resourceTimings = {};
    var _healthCheckInterval = null;
    var _autoReloadEnabled = true;
    var _versionUpdateDetected = false;
    var _criticalResourceOrder = ['frameworkVersion', 'frameworkStatus', 'config', 'overview'];
    var _resourceConflictDetected = false;
    var _degradedModeActive = false;
    var _lastHealthStatus = null;
    var _consecutiveDegradedChecks = 0;
    var _performanceMetrics = { avgLoadTime: 0, slowResources: [], fastResources: [] };
    var _resourceRetryCount = {};
    var _maxResourceRetries = 2;
    var _resourceDependencyGraph = {
      'frameworkVersion': [],
      'frameworkStatus': ['frameworkVersion'],
      'config': [],
      'overview': ['config'],
      'agents': ['config'],
      'skills': ['config'],
      'sessions': ['config'],
      'workflow': ['config'],
      'changelog': ['config'],
      'audit': ['config'],
      'memory': ['config'],
      'checkpoints': ['config'],
      'learnings': ['config'],
      'workflowTemplates': ['config'],
      'compliance': ['config'],
      'deviations': ['config'],
      'codeReviews': ['config'],
      'designStats': ['config'],
      'designPresets': ['config'],
      'deepeningDashboard': ['config'],
      'deepeningMetrics': ['deepeningDashboard'],
      'deepeningCache': ['deepeningDashboard'],
      'deepeningConvergence': ['deepeningDashboard'],
      'deepeningReport': ['deepeningDashboard'],
      'deepeningHealthMonitor': ['deepeningDashboard'],
      'deepeningDependencies': ['deepeningDashboard'],
      'deepeningThrottle': ['deepeningDashboard'],
      'deepeningValidator': ['deepeningDashboard'],
      'deepeningLocks': ['deepeningDashboard'],
      'deepeningEventReplay': ['deepeningDashboard'],
      'deepeningPriorityQueue': ['deepeningDashboard'],
      'deepeningMetricsAggregator': ['deepeningMetrics'],
      'deepeningRateLimiter': ['deepeningDashboard'],
      'deepeningSnapshotStore': ['deepeningCache'],
      'deepeningBackpressure': ['deepeningDashboard'],
      'deepeningConnectionPool': ['deepeningDashboard'],
      'deepeningRetryPolicy': ['deepeningDashboard'],
      'deepeningServiceRegistry': ['deepeningDashboard'],
      'deepeningLoadBalancer': ['deepeningServiceRegistry'],
      'deepeningTimeoutManager': ['deepeningDashboard'],
      'deepeningGracefulShutdown': ['deepeningDashboard'],
      'deepeningFeatureFlags': ['deepeningConfigManager'],
      'deepeningCircuitBreaker': ['deepeningDashboard'],
      'deepeningTaskScheduler': ['deepeningDashboard'],
      'deepeningDataPipeline': ['deepeningDashboard'],
      'deepeningStateManager': ['deepeningDashboard'],
      'deepeningEventBus': ['deepeningDashboard'],
      'deepeningConfigManager': ['deepeningDashboard'],
      'deepeningResourceManager': ['deepeningDashboard'],
      'deepeningAuditTrail': ['deepeningDashboard'],
      'infrastructureHealthChecker': [],
      'infrastructurePriorityQueue': [],
      'infrastructureEventBus': []
    };
    var _errorCategories = {};
    var _MAX_ERROR_CATEGORIES = 100;
    var _loadProgressCallbacks = [];
    var _versionChangelog = [];
    var _forceUpdateRequired = false;
    var _loadTimeoutTiers = [
      { threshold: 5000, level: 'hint', message: '框架加载中，请稍候...' },
      { threshold: 10000, level: 'warn', message: '核心资源加载较慢', checkCritical: true },
      { threshold: 20000, level: 'warning', message: '框架加载缓慢，正在检查资源状态...' },
      { threshold: 60000, level: 'error', message: '框架加载超时，部分资源未能成功加载' },
    ];
    var _triggeredTimeoutTiers = {};

    function _parseSemver(v) {
      if (!v) return null;
      var match = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?(?:\+([a-zA-Z0-9.]+))?$/);
      if (!match) return null;
      return { major: parseInt(match[1], 10) || 0, minor: parseInt(match[2], 10) || 0, patch: parseInt(match[3], 10) || 0, prerelease: match[4] ?? null, build: match[5] ?? null };
    }

    function _compareSemver(a, b) {
      var pa = _parseSemver(a);
      var pb = _parseSemver(b);
      if (!pa || !pb) return 'unknown';
      if (pa.major !== pb.major) return pa.major > pb.major ? 'major-ahead' : 'major-behind';
      if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 'minor-ahead' : 'minor-behind';
      if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 'patch-ahead' : 'patch-behind';
      if (pa.prerelease && !pb.prerelease) return 'pre-release';
      if (!pa.prerelease && pb.prerelease) return 'stable-ahead';
      return 'exact';
    }

    function _isVersionCompatible(v) {
      var parsed = _parseSemver(v);
      if (!parsed) return { compatible: false, reason: '版本格式无效' };
      if (parsed.major !== _COMPATIBLE_VERSION_RANGE.major) {
        return { compatible: false, reason: '主版本不兼容 (要求 ' + _COMPATIBLE_VERSION_RANGE.major + '.x，当前 ' + parsed.major + '.' + parsed.minor + ')', forceUpdate: true };
      }
      if (parsed.minor < _COMPATIBLE_VERSION_RANGE.minor) {
        return { compatible: false, reason: '次版本过低 (要求 >=' + _COMPATIBLE_VERSION_RANGE.major + '.' + _COMPATIBLE_VERSION_RANGE.minor + '，当前 ' + parsed.major + '.' + parsed.minor + ')', forceUpdate: true };
      }
      if (parsed.minor > _COMPATIBLE_VERSION_RANGE.minor + 2) {
        return { compatible: true, warning: '次版本远高于适配版本，可能存在未测试的变更', level: 'warning' };
      }
      if (parsed.prerelease) {
        return { compatible: true, warning: '当前为预发布版本 (' + parsed.prerelease + ')，不建议在生产环境使用', level: 'warning' };
      }
      return { compatible: true, level: 'ok' };
    }

    function _getVersionChangeType(oldV, newV) {
      var comparison = _compareSemver(newV, oldV);
      switch (comparison) {
        case 'major-ahead': return { type: 'major', severity: 'critical', description: '主版本更新，可能包含破坏性变更' };
        case 'minor-ahead': return { type: 'minor', severity: 'important', description: '次版本更新，包含新功能' };
        case 'patch-ahead': return { type: 'patch', severity: 'low', description: '补丁更新，修复已知问题' };
        case 'stable-ahead': return { type: 'stable', severity: 'low', description: '从预发布版本升级到稳定版本' };
        case 'pre-release': return { type: 'prerelease', severity: 'warning', description: '切换到预发布版本' };
        default: return { type: 'unknown', severity: 'info', description: '版本变更' };
      }
    }

    function _recordVersionChange(oldV, newV) {
      var changeInfo = _getVersionChangeType(oldV, newV);
      var entry = {
        from: oldV,
        to: newV,
        type: changeInfo.type,
        severity: changeInfo.severity,
        description: changeInfo.description,
        ts: Date.now(),
      };
      _versionChangelog.push(entry);
      if (_versionChangelog.length > 50) _versionChangelog = _versionChangelog.slice(-50);
      if (changeInfo.severity === 'critical') {
        _forceUpdateRequired = true;
      }
      return entry;
    }

    function _log(level, category, message, details) {
      var entry = {
        ts: Date.now(),
        elapsed: Date.now() - _loadStartTime,
        level: level,
        category: category,
        message: message,
        details: details || null,
      };
      _loadLog.push(entry);
      if (_loadLog.length > MAX_LOAD_LOG) _loadLog.splice(0, _loadLog.length - MAX_LOAD_LOG);
      if (level === 'error' || level === 'warn') {
        var catKey = level + ':' + category + ':' + message.substring(0, 60);
        if (!_errorCategories[catKey]) {
          var catKeys = Object.keys(_errorCategories);
          if (catKeys.length >= _MAX_ERROR_CATEGORIES) {
            var oldest = catKeys.sort(function(a, b) { return _errorCategories[a].firstSeen - _errorCategories[b].firstSeen; })[0];
            delete _errorCategories[oldest];
          }
          _errorCategories[catKey] = { count: 0, firstSeen: Date.now(), lastSeen: Date.now(), level: level, category: category, message: message };
        }
        _errorCategories[catKey].count++;
        _errorCategories[catKey].lastSeen = Date.now();
      }
      if (level === 'error') {
        if (CONFIG.DEBUG) console.error('[FrameworkMonitor][' + category + '] ' + message, details || '');
      } else if (level === 'warn') {
        if (CONFIG.DEBUG) console.warn('[FrameworkMonitor][' + category + '] ' + message, details || '');
      } else if (CONFIG.DEBUG) {
        console.log('[FrameworkMonitor][' + category + '] ' + message, details || '');
      }
      _notifyProgress();
    }

    function getLoadLog(filter) {
      if (!filter) return _loadLog.slice();
      return _loadLog.filter(function(e) {
        if (filter.level && e.level !== filter.level) return false;
        if (filter.category && e.category !== filter.category) return false;
        if (filter.since && e.ts < filter.since) return false;
        return true;
      });
    }

    function exportLoadLog() {
      var report = getLoadReport();
      var logEntries = getLoadLog();
      var errorSummary = [];
      for (var k in _errorCategories) {
        if (Object.prototype.hasOwnProperty.call(_errorCategories, k)) {
          errorSummary.push(_errorCategories[k]);
        }
      }
      errorSummary.sort(function(a, b) { return b.count - a.count; });
      var exportData = {
        exportTime: new Date().toISOString(),
        frameworkVersion: _lastVersion,
        compatibleVersion: _COMPATIBLE_VERSION,
        loadState: _loadState,
        report: report,
        errorSummary: errorSummary,
        versionChangelog: _versionChangelog.slice(),
        log: logEntries,
      };
      var jsonStr = JSON.stringify(exportData, null, 2);
      var blob = new Blob([jsonStr], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'framework-load-report-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      _log('info', 'export', '加载报告已导出 (' + logEntries.length + ' 条日志, ' + errorSummary.length + ' 类错误)');
      return exportData;
    }

    function getLoadReport() {
      var loadedCount = Object.keys(_loadedResources).length;
      var failedCount = Object.keys(_failedResources).length;
      var totalExpected = _expectedResources.length;
      var timings = {};
      var slowResources = [];
      var fastResources = [];
      for (var k in _resourceTimings) {
        if (Object.prototype.hasOwnProperty.call(_resourceTimings, k)) {
          timings[k] = _resourceTimings[k];
          if (_resourceTimings[k] > 2000) slowResources.push({ key: k, time: _resourceTimings[k] });
          if (_resourceTimings[k] < 100) fastResources.push({ key: k, time: _resourceTimings[k] });
        }
      }
      slowResources.sort(function(a, b) { return b.time - a.time; });
      fastResources.sort(function(a, b) { return a.time - b.time; });
      var totalLoadTime = 0;
      for (var t in timings) { if (Object.prototype.hasOwnProperty.call(timings, t)) totalLoadTime += timings[t]; }
      var avgLoadTime = loadedCount > 0 ? Math.round(totalLoadTime / loadedCount) : 0;
      _performanceMetrics = { avgLoadTime: avgLoadTime, slowResources: slowResources.slice(0, 10), fastResources: fastResources.slice(0, 5) };

      var dependencyViolations = [];
      for (var resKey in _loadedResources) {
        if (Object.prototype.hasOwnProperty.call(_loadedResources, resKey) && _resourceDependencyGraph[resKey]) {
          var deps = _resourceDependencyGraph[resKey];
          for (var di = 0; di < deps.length; di++) {
            if (!_loadedResources[deps[di]]) {
              dependencyViolations.push({ resource: resKey, missingDependency: deps[di] });
            }
          }
        }
      }

      var errorSummary = [];
      for (var ek in _errorCategories) {
        if (Object.prototype.hasOwnProperty.call(_errorCategories, ek)) {
          errorSummary.push({ category: _errorCategories[ek].category, message: _errorCategories[ek].message, count: _errorCategories[ek].count, level: _errorCategories[ek].level });
        }
      }
      errorSummary.sort(function(a, b) { return b.count - a.count; });

      var retrySummary = [];
      for (var rk in _resourceRetryCount) {
        if (Object.prototype.hasOwnProperty.call(_resourceRetryCount, rk) && _resourceRetryCount[rk] > 0) {
          retrySummary.push({ resource: rk, retries: _resourceRetryCount[rk] });
        }
      }

      return {
        state: _loadState,
        startTime: _loadStartTime,
        elapsed: Date.now() - _loadStartTime,
        resources: {
          total: totalExpected,
          loaded: loadedCount,
          failed: failedCount,
          pending: totalExpected - loadedCount - failedCount,
          completeness: totalExpected > 0 ? Math.round((loadedCount / totalExpected) * 100) : 0,
        },
        loadOrder: _resourceLoadOrder.slice(),
        loadedResources: Object.keys(_loadedResources),
        failedResources: Object.keys(_failedResources).map(function(k) { return k + ': ' + (_failedResources[k].error || 'unknown'); }),
        timings: timings,
        performance: _performanceMetrics,
        version: _lastVersion,
        compatibleVersion: _COMPATIBLE_VERSION,
        versionCompatibility: _isVersionCompatible(_lastVersion),
        versionChangelog: _versionChangelog.slice(-10),
        forceUpdateRequired: _forceUpdateRequired,
        reloadAttempts: _reloadAttemptCount,
        versionUpdateDetected: _versionUpdateDetected,
        degradedMode: _degradedModeActive,
        conflictDetected: _resourceConflictDetected,
        dependencyViolations: dependencyViolations,
        errorSummary: errorSummary.slice(0, 20),
        retrySummary: retrySummary,
      };
    }

    function checkVersion() {
      var version = Store.get('frameworkVersion');
      if (!version || !version.canonicalVersion) {
        _log('warn', 'version', '版本信息不可用');
        return;
      }

      if (_lastVersion === null) {
        _lastVersion = version.canonicalVersion;
        _log('info', 'version', '框架版本已获取: v' + version.canonicalVersion);
      }

      if (_lastVersion !== version.canonicalVersion && _lastVersion !== null) {
        _versionUpdateDetected = true;
        var changeEntry = _recordVersionChange(_lastVersion, version.canonicalVersion);
        _log('warn', 'version', '检测到版本变更: v' + _lastVersion + ' → v' + version.canonicalVersion + ' (' + changeEntry.type + ', ' + changeEntry.description + ')');
        if (changeEntry.severity === 'critical') {
          showBanner('error', '检测到框架主版本更新: v' + escapeHtml(_lastVersion) + ' → v' + escapeHtml(version.canonicalVersion) + '，必须刷新页面以避免兼容性问题', true);
        } else if (changeEntry.severity === 'important') {
          showBanner('info', '检测到框架版本更新: v' + escapeHtml(_lastVersion) + ' → v' + escapeHtml(version.canonicalVersion) + '，建议刷新页面以获取新功能');
        } else {
          showBanner('info', '检测到框架版本更新: v' + escapeHtml(_lastVersion) + ' → v' + escapeHtml(version.canonicalVersion) + '，建议刷新页面');
        }
        _lastVersion = version.canonicalVersion;
        return;
      }
      _lastVersion = version.canonicalVersion;

      if (_versionVerifyPending) return;
      _versionVerifyPending = true;
      var vOpts = { cache: 'no-store' };
      if (CONFIG.API_TOKEN) vOpts.headers = { 'Authorization': 'Bearer ' + CONFIG.API_TOKEN };
      _fetchWithTimeout(API + '/api/version', vOpts).then(function(r) {
        if (r.status === 408 && r.headers && r.headers.get('Content-Type') && r.headers.get('Content-Type').indexOf('application/json') >= 0) {
          return r.json().then(function(d) { if (d && d._aborted) { _versionVerifyPending = false; return null; } return r; });
        }
        if (!r.ok) throw new Error('status ' + r.status);
        return r.json();
      }).then(function(fresh) {
        _versionVerifyPending = false;
        if (!fresh) return;
        var currentVersion = Store.get('frameworkVersion');
        var versionChanged = !currentVersion || currentVersion.canonicalVersion !== fresh.canonicalVersion;
        if (versionChanged) {
          Store.batchUpdate({ frameworkVersion: fresh });
        }
        if (fresh.versionMatch) {
          dismissBanner('warning');
          _log('info', 'version', '版本一致性验证通过（已刷新）');
        } else {
          showBanner('warning', '版本不一致: package.json (' + escapeHtml(fresh.packageVersion) + ') 与 config.json (' + escapeHtml(fresh.configVersion) + ') 版本不匹配');
        }
        var compat = _isVersionCompatible(fresh.canonicalVersion);
        if (!compat.compatible) {
          _log('error', 'version', '版本不兼容: ' + compat.reason);
          showBanner('error', '框架版本不兼容: ' + escapeHtml(compat.reason), !!compat.forceUpdate);
        } else if (compat.warning) {
          _log('warn', 'version', '版本兼容性警告: ' + compat.warning);
          showBanner('warning', '框架版本提示: ' + escapeHtml(compat.warning));
        } else {
          dismissBanner('error');
          _log('info', 'version', '版本兼容性验证通过: v' + fresh.canonicalVersion);
        }
      }).catch(function() {
        _versionVerifyPending = false;
        if (!version.versionMatch) {
          showBanner('warning', '版本不一致: package.json (' + escapeHtml(version.packageVersion) + ') 与 config.json (' + escapeHtml(version.configVersion) + ') 版本不匹配');
        } else {
          dismissBanner('warning');
          _log('info', 'version', '版本一致性验证通过（使用缓存）');
        }
        var compat = _isVersionCompatible(version.canonicalVersion);
        if (!compat.compatible) {
          _log('error', 'version', '版本不兼容: ' + compat.reason);
          showBanner('error', '框架版本不兼容: ' + escapeHtml(compat.reason), !!compat.forceUpdate);
        } else if (compat.warning) {
          _log('warn', 'version', '版本兼容性警告: ' + compat.warning);
          showBanner('warning', '框架版本提示: ' + escapeHtml(compat.warning));
        } else {
          dismissBanner('error');
        }
      });
    }

    function checkStatus() {
      var status = Store.get('frameworkStatus');
      if (!status || !status.status) {
        _log('warn', 'status', '框架状态信息不可用');
        return;
      }

      if (status.status === 'degraded') {
        _consecutiveDegradedChecks++;
        var failedModules = (status.modules && status.modules.failedModules) ?? [];
        var names = failedModules.join(', ');
        if (names) {
          _log('error', 'status', '框架模块加载异常: ' + names);
          showBanner('error', '框架模块加载异常: ' + escapeHtml(names));
        } else {
          var details = ((status.modules && status.modules.details) ?? []).filter(function(m) { return !m.loaded; });
          names = details.map(function(m) { return m.name; }).join(', ');
          _log('error', 'status', '框架模块加载异常: ' + names);
          showBanner('error', '框架模块加载异常: ' + escapeHtml(names));
        }
        _loadState = 'degraded';
        if (_consecutiveDegradedChecks >= 3 && !_degradedModeActive) {
          _degradedModeActive = true;
          _log('warn', 'status', '连续' + _consecutiveDegradedChecks + '次检测到降级状态，启用降级模式');
          showToast('框架进入降级模式，部分功能可能受限', 'error');
        }
      } else {
        dismissBanner('error');
        if (_consecutiveDegradedChecks > 0) {
          _consecutiveDegradedChecks = 0;
          if (_degradedModeActive) {
            _degradedModeActive = false;
            _log('info', 'status', '框架恢复正常，退出降级模式');
            showToast('框架已恢复正常运行', '');
          }
        }
        if (_loadState !== 'loaded') {
          _loadState = 'healthy';
        }
        _log('info', 'status', '框架状态正常 (模块: ' + (status.modules ? status.modules.loaded + '/' + status.modules.total : 'N/A') + ')');
      }
      _lastHealthStatus = status.status;

      if (status.modules && status.modules.dependencyIssues && status.modules.dependencyIssues.length > 0) {
        var depIssues = status.modules.dependencyIssues.map(function(d) {
          return d.module + ' 依赖 ' + d.missingDependency + ' (未加载)';
        });
        _log('warn', 'dependencies', '模块依赖问题: ' + depIssues.join('; '));
        showBanner('warning', '框架模块依赖异常: ' + escapeHtml(depIssues.slice(0, 3).join(', ')) + (depIssues.length > 3 ? ' 等' + depIssues.length + '项' : ''));
      }

      if (status.resources) {
        var missingDirs = [];
        if (!status.resources.agentsDir) missingDirs.push('agents');
        if (!status.resources.skillsDir) missingDirs.push('skills');
        if (!status.resources.rulesDir) missingDirs.push('rules');
        if (missingDirs.length > 0) {
          _log('warn', 'resources', '框架资源目录缺失: ' + missingDirs.join(', '));
          showBanner('warning', '框架资源目录缺失: ' + escapeHtml(missingDirs.join(', ')));
        }
        if (!status.resources.configLoaded) {
          _log('error', 'resources', '框架配置文件未正确加载');
          showBanner('error', '框架配置文件未正确加载');
        } else if (!status.resources.configValid) {
          _log('warn', 'resources', '框架配置文件缺少必要字段');
          showBanner('warning', '框架配置文件缺少必要字段 (version, project_name, skill_registry)');
        } else {
          _log('info', 'resources', '配置文件验证通过');
        }
      }

      if (status.runtime) {
        if (status.runtime.standaloneMode) {
          _log('info', 'runtime', '框架运行在独立模式');
        } else if (!status.runtime.initialized) {
          _log('warn', 'runtime', '框架运行时未初始化');
          showBanner('warning', '框架运行时未初始化，部分功能可能不可用');
        } else if (status.runtime.completeness < 80) {
          _log('warn', 'runtime', '运行时模块加载不完整: ' + status.runtime.completeness + '%');
          showBanner('warning', '框架运行时模块加载不完整 (' + status.runtime.completeness + '%)，建议检查模块依赖');
        } else {
          _log('info', 'runtime', '运行时初始化完成，模块完整性: ' + status.runtime.completeness + '%');
        }
      }
    }

    function trackResourceLoad(stateKey, success, error) {
      var now = Date.now();
      _resourceTimings[stateKey] = now - _loadStartTime;
      if (success) {
        _loadedResources[stateKey] = now;
        _resourceLoadOrder.push(stateKey);
        if (_resourceLoadOrder.length > 200) _resourceLoadOrder = _resourceLoadOrder.slice(-100);
        if (_failedResources[stateKey]) {
          delete _failedResources[stateKey];
          _log('info', 'resource', '资源重试加载成功: ' + stateKey);
        } else {
          _log('info', 'resource', '资源加载成功: ' + stateKey + ' (' + _resourceTimings[stateKey] + 'ms)');
        }
      } else {
        _failedResources[stateKey] = { error: error || 'unknown', ts: now };
        if (!_resourceRetryCount[stateKey]) _resourceRetryCount[stateKey] = 0;
        if (_resourceRetryCount[stateKey] < _maxResourceRetries) {
          _resourceRetryCount[stateKey]++;
          _log('warn', 'resource', '资源加载失败，将重试 (' + _resourceRetryCount[stateKey] + '/' + _maxResourceRetries + '): ' + stateKey + ' - ' + (error || 'unknown'));
          _retrySingleResource(stateKey);
        } else {
          _log('error', 'resource', '资源加载失败 (已达最大重试次数): ' + stateKey + ' - ' + (error || 'unknown'));
        }
      }
      _updateLoadState();
    }

    function _retrySingleResource(stateKey) {
      var endpointMap = {
        'frameworkVersion': 'version',
        'frameworkStatus': 'framework/status',
      };
      var endpoint = endpointMap[stateKey];
      if (!endpoint) {
        for (var i = 0; i < ENDPOINT_MAP.length; i++) {
          if (ENDPOINT_MAP[i].stateKey === stateKey) {
            endpoint = ENDPOINT_MAP[i].endpoint;
            break;
          }
        }
      }
      if (!endpoint) return;
      if (!_resourceRetryCount[stateKey]) _resourceRetryCount[stateKey] = 0;
      if (_resourceRetryCount[stateKey] >= _maxResourceRetries) return;
      var delay = Math.min(500 * _resourceRetryCount[stateKey], 3000);
      setTimeout(function() {
        var retryOpts = { cache: 'no-store' };
        if (CONFIG.API_TOKEN) retryOpts.headers = { 'Authorization': 'Bearer ' + CONFIG.API_TOKEN };
        _fetchWithTimeout(API + '/api/' + endpoint, retryOpts)
          .then(function(r) {
            if (!r.ok) throw new Error('status ' + r.status);
            return r.json();
          })
          .then(function(data) {
            var updates = {};
            updates[stateKey] = data;
            Store.batchUpdate(updates);
            trackResourceLoad(stateKey, true);
          })
          .catch(function(e) {
            trackResourceLoad(stateKey, false, e && e.message ? e.message : String(e));
          });
      }, delay);
    }

    function _updateLoadState() {
      var loadedCount = Object.keys(_loadedResources).length;
      var failedCount = Object.keys(_failedResources).length;
      var total = _expectedResources.length;
      var criticalLoaded = _criticalResources.filter(function(k) { return !!_loadedResources[k]; }).length;
      var criticalTotal = _criticalResources.length;

      if (loadedCount + failedCount >= total) {
        if (failedCount === 0) {
          _loadState = 'loaded';
          _log('info', 'lifecycle', '框架所有资源加载完成 (' + loadedCount + '/' + total + ')，耗时 ' + (Date.now() - _loadStartTime) + 'ms');
          dismissBanner('error');
        } else {
          _loadState = 'degraded';
          _log('warn', 'lifecycle', '框架资源加载不完整: ' + loadedCount + ' 成功, ' + failedCount + ' 失败');
        }
      } else if (criticalLoaded >= criticalTotal && _loadState === 'loading') {
        _loadState = 'ready';
        _log('info', 'lifecycle', '核心资源已加载完成 (' + criticalLoaded + '/' + criticalTotal + ')，非核心资源继续加载中 (' + loadedCount + '/' + total + ')');
        dismissBanner('error');
      } else if (failedCount > 0 && loadedCount > 0) {
        _loadState = 'partial';
      } else {
        _loadState = 'loading';
      }
    }

    function verifyResourceLoadOrder() {
      var criticalLoaded = true;
      var firstCriticalIdx = -1;
      var lastCriticalIdx = -1;
      for (var i = 0; i < _criticalResourceOrder.length; i++) {
        var key = _criticalResourceOrder[i];
        if (!_loadedResources[key]) {
          _log('warn', 'load-order', '关键资源尚未加载: ' + key);
          criticalLoaded = false;
        } else {
          var idx = _resourceLoadOrder.indexOf(key);
          if (idx >= 0) {
            if (firstCriticalIdx < 0 || idx < firstCriticalIdx) firstCriticalIdx = idx;
            if (idx > lastCriticalIdx) lastCriticalIdx = idx;
          }
        }
      }
      var nonCriticalBeforeCritical = false;
      if (firstCriticalIdx >= 0 && lastCriticalIdx >= 0) {
        for (var j = 0; j < firstCriticalIdx; j++) {
          var resKey = _resourceLoadOrder[j];
          if (_criticalResourceOrder.indexOf(resKey) < 0) {
            nonCriticalBeforeCritical = true;
            _log('warn', 'load-order', '非关键资源 ' + resKey + ' 在关键资源之前加载 (位置 ' + j + ')');
            break;
          }
        }
      }
      if (nonCriticalBeforeCritical) {
        _log('warn', 'load-order', '加载顺序异常: 非关键资源在关键资源之前加载');
        _resourceConflictDetected = true;
      }

      var depOrderViolations = [];
      var loadIdxMap = {};
      for (var li = 0; li < _resourceLoadOrder.length; li++) {
        loadIdxMap[_resourceLoadOrder[li]] = li;
      }
      for (var resK in _resourceDependencyGraph) {
        if (!Object.prototype.hasOwnProperty.call(_resourceDependencyGraph, resK)) continue;
        var deps = _resourceDependencyGraph[resK];
        if (!_loadedResources[resK]) continue;
        var resIdx = loadIdxMap[resK];
        if (resIdx === undefined) continue;
        for (var di = 0; di < deps.length; di++) {
          var depIdx = loadIdxMap[deps[di]];
          if (depIdx !== undefined && depIdx > resIdx) {
            depOrderViolations.push({ resource: resK, dependency: deps[di], resourceIdx: resIdx, dependencyIdx: depIdx });
          }
        }
      }
      if (depOrderViolations.length > 0) {
        _log('warn', 'load-order', '依赖加载顺序异常: ' + depOrderViolations.map(function(v) { return v.dependency + '(位置' + v.dependencyIdx + ') 在 ' + v.resource + '(位置' + v.resourceIdx + ') 之后加载'; }).join('; '));
        _resourceConflictDetected = true;
      }

      if (criticalLoaded && !nonCriticalBeforeCritical && depOrderViolations.length === 0) {
        _log('info', 'load-order', '关键资源加载顺序验证通过');
      }
      return criticalLoaded && !nonCriticalBeforeCritical && depOrderViolations.length === 0;
    }

    function verifyResourceIntegrity() {
      var status = Store.get('frameworkStatus');
      var version = Store.get('frameworkVersion');
      var config = Store.get('config');
      var overview = Store.get('overview');
      var issues = [];

      if (!version || !version.canonicalVersion) {
        issues.push('版本信息缺失');
      } else if (!version.versionMatch) {
        issues.push('版本信息不一致 (package: ' + version.packageVersion + ', config: ' + version.configVersion + ')');
      } else {
        var compat = _isVersionCompatible(version.canonicalVersion);
        if (!compat.compatible) {
          issues.push('版本不兼容: ' + compat.reason);
        }
      }
      if (!status || !status.status) {
        issues.push('框架状态信息缺失');
      } else if (status.status === 'degraded') {
        issues.push('框架状态降级');
      }
      if (!config || Object.keys(config).length === 0) {
        issues.push('配置数据为空');
      } else {
        var requiredConfigKeys = ['version', 'project_name', 'skill_registry'];
        var missingKeys = requiredConfigKeys.filter(function(k) { return !config[k]; });
        if (missingKeys.length > 0) {
          issues.push('配置缺少必要字段: ' + missingKeys.join(', '));
        }
      }
      if (!overview || Object.keys(overview).length === 0) {
        issues.push('概览数据为空');
      }

      if (status && status.modules && !status.modules.allLoaded) {
        issues.push((status.modules.failedModules ? status.modules.failedModules.length : 0) + ' 个模块加载失败');
      }
      if (status && status.modules && status.modules.dependencyIssues && status.modules.dependencyIssues.length > 0) {
        issues.push(status.modules.dependencyIssues.length + ' 个模块依赖问题');
      }

      var depViolations = [];
      for (var resKey in _loadedResources) {
        if (!Object.prototype.hasOwnProperty.call(_loadedResources, resKey) || !_resourceDependencyGraph[resKey]) continue;
        var deps = _resourceDependencyGraph[resKey];
        for (var di = 0; di < deps.length; di++) {
          if (!_loadedResources[deps[di]]) {
            depViolations.push(resKey + ' 缺少依赖 ' + deps[di]);
          }
        }
      }
      if (depViolations.length > 0) {
        issues.push('前端资源依赖缺失: ' + depViolations.slice(0, 5).join('; ') + (depViolations.length > 5 ? ' 等' + depViolations.length + '项' : ''));
      }

      var duplicateCheck = {};
      for (var ri = 0; ri < _resourceLoadOrder.length; ri++) {
        var rKey = _resourceLoadOrder[ri];
        if (duplicateCheck[rKey]) {
          issues.push('资源重复加载: ' + rKey);
        }
        duplicateCheck[rKey] = true;
      }

      if (issues.length > 0) {
        _log('warn', 'integrity', '资源完整性检查发现问题: ' + issues.join('; '));
        return false;
      }
      _log('info', 'integrity', '资源完整性验证通过');
      return true;
    }

    function showBanner(type, message, forceAction) {
      var existing = document.querySelector('.framework-banner.banner-' + type);
      if (existing && existing.getAttribute('data-msg') === message) return;
      if (existing) existing.parentNode.removeChild(existing);
      var banner = document.createElement('div');
      banner.className = 'framework-banner banner-' + type;
      banner.setAttribute('data-msg', message);
      banner.setAttribute('role', 'alert');
      var icon = type === 'error' ? '\u26A0' : type === 'warning' ? '\u26A1' : '\u2139';
      var actions = '';
      if (type === 'info' || forceAction) {
        actions += '<button class="banner-action" data-action="reload">刷新页面</button>';
      } else if (type === 'error' && _autoReloadEnabled) {
        actions += '<button class="banner-action" data-action="auto-reload">自动重试 (' + (_maxReloadAttempts - _reloadAttemptCount) + '/' + _maxReloadAttempts + ')</button>';
      }
      actions += '<button class="banner-action banner-action--sm" data-action="export-log">导出日志</button>';
      actions += '<button class="banner-close" aria-label="关闭">&times;</button>';
      banner.innerHTML = '<span class="banner-icon" aria-hidden="true">' + escapeHtml(icon) + '</span><span class="banner-text">' + escapeHtml(message) + '</span>' + actions;
      if (forceAction) {
        banner.setAttribute('data-force', 'true');
      }
      var app = document.querySelector('.app');
      if (app) app.insertBefore(banner, app.firstChild);
    }

    function dismissBanner(type) {
      var existing = document.querySelector('.framework-banner.banner-' + type);
      if (existing) existing.parentNode.removeChild(existing);
    }

    function handleBannerClick(e) {
      var target = e.target;
      if (!target) return;
      if (target.classList.contains('banner-close')) {
        var banner = target.closest('.framework-banner');
        if (banner && banner.getAttribute('data-force') === 'true') {
          showToast('此通知需要操作，无法关闭', 'error');
          return;
        }
        if (banner) banner.parentNode.removeChild(banner);
        return;
      }
      if (target.classList.contains('banner-action')) {
        if (target.dataset.action === 'reload' || target.dataset.action === 'auto-reload') {
          attemptReload();
        } else if (target.dataset.action === 'export-log') {
          exportLoadLog();
        }
      }
    }

    function attemptReload() {
      if (_reloadAttemptCount >= _maxReloadAttempts) {
        _log('error', 'reload', '已达到最大重试次数 (' + _maxReloadAttempts + ')，请手动刷新页面');
        showBanner('error', '多次重新加载失败，请手动刷新页面');
        return;
      }
      _reloadAttemptCount++;
      var delay = Math.min(1000 * Math.pow(2, _reloadAttemptCount - 1), 8000);
      _log('info', 'reload', '将在 ' + delay + 'ms 后重新加载 (第' + _reloadAttemptCount + '次)...');
      showToast('正在尝试重新加载框架资源 (第' + _reloadAttemptCount + '次)...', '');
      setTimeout(function() { window.location.reload(); }, delay);
    }

    function startPeriodicCheck() {
      if (_versionCheckInterval) clearInterval(_versionCheckInterval);
      var _versionFetchInFlight = false;
      _versionCheckInterval = setInterval(function() {
        if (_versionFetchInFlight) return;
        _versionFetchInFlight = true;
        var fmOpts = { cache: 'no-store' };
        if (CONFIG.API_TOKEN) fmOpts.headers = { 'Authorization': 'Bearer ' + CONFIG.API_TOKEN };
        _fetchWithTimeout(API + '/api/version', fmOpts)
          .then(function(r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
          .then(function(data) {
            if (data && data.canonicalVersion && data.canonicalVersion !== _lastVersion && _lastVersion !== null) {
              _versionUpdateDetected = true;
              var changeEntry = _recordVersionChange(_lastVersion, data.canonicalVersion);
              _log('warn', 'version-check', '检测到框架版本更新: v' + _lastVersion + ' → v' + data.canonicalVersion + ' (' + changeEntry.type + ', ' + changeEntry.description + ')');
              if (changeEntry.severity === 'critical') {
                showBanner('error', '检测到框架主版本更新: v' + escapeHtml(_lastVersion) + ' → v' + escapeHtml(data.canonicalVersion) + '，必须刷新页面', true);
              } else if (changeEntry.severity === 'important') {
                showBanner('info', '检测到框架版本更新: v' + escapeHtml(_lastVersion) + ' → v' + escapeHtml(data.canonicalVersion) + '，建议刷新页面以获取新功能');
              } else {
                showBanner('info', '检测到框架版本更新: v' + escapeHtml(_lastVersion) + ' → v' + escapeHtml(data.canonicalVersion));
              }
              _lastVersion = data.canonicalVersion;
            }
          })
          .catch(function(e) {
            _log('warn', 'version-check', '版本检查请求失败: ' + (e && e.message ? e.message : String(e)));
          })
          .finally(function() { _versionFetchInFlight = false; });
      }, 60000);

      if (_statusCheckInterval) clearInterval(_statusCheckInterval);
      _statusCheckInterval = setInterval(function() {
        var statusOpts = { cache: 'no-store' };
        if (CONFIG.API_TOKEN) statusOpts.headers = { 'Authorization': 'Bearer ' + CONFIG.API_TOKEN };
        _fetchWithTimeout(API + '/api/framework/status', statusOpts)
          .then(function(r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
          .then(function(data) {
            if (data && data.status === 'degraded') {
              var failed = (data.modules && data.modules.failedModules) ?? [];
              if (failed.length > 0) {
                _log('warn', 'health-check', '健康检查发现模块异常: ' + failed.join(', '));
              }
            } else if (data && data.status === 'healthy' && _degradedModeActive) {
              _degradedModeActive = false;
              _consecutiveDegradedChecks = 0;
              _log('info', 'health-check', '健康检查恢复正常');
            }
          })
          .catch(function(e) {
            _log('warn', 'health-check', '健康检查请求失败: ' + (e && e.message ? e.message : String(e)));
          });
      }, 30000);
    }

    function startHealthCheck() {
      if (_healthCheckInterval) clearInterval(_healthCheckInterval);
      _healthCheckInterval = setInterval(function() {
        var loadedCount = Object.keys(_loadedResources).length;
        var failedCount = Object.keys(_failedResources).length;
        var total = _expectedResources.length;
        var elapsed = Date.now() - _loadStartTime;
        var criticalLoaded = _criticalResources.filter(function(k) { return !!_loadedResources[k]; }).length;
        var criticalTotal = _criticalResources.length;

        for (var ti = 0; ti < _loadTimeoutTiers.length; ti++) {
          var tier = _loadTimeoutTiers[ti];
          if (elapsed > tier.threshold && !_triggeredTimeoutTiers[tier.threshold]) {
            _triggeredTimeoutTiers[tier.threshold] = true;
            if (tier.level === 'hint') {
              _log('info', 'health', tier.message + ' (' + loadedCount + '/' + total + ')');
            } else if (tier.level === 'warn') {
              if (tier.checkCritical && criticalLoaded >= criticalTotal) {
                _log('info', 'health', '核心资源已全部加载 (' + criticalLoaded + '/' + criticalTotal + ')，非核心资源加载中 (' + loadedCount + '/' + total + ')');
              } else {
                _log('warn', 'health', tier.message + ' (' + loadedCount + '/' + total + ', 核心: ' + criticalLoaded + '/' + criticalTotal + ')');
              }
            } else if (tier.level === 'warning') {
              _log('warn', 'health', tier.message + ' (' + loadedCount + '/' + total + ')');
              if (criticalLoaded < criticalTotal) {
                showBanner('warning', '框架加载缓慢，核心资源可能需要重试');
              }
            } else if (tier.level === 'error') {
              if (criticalLoaded < criticalTotal) {
                _log('error', 'health', '框架核心资源加载超时，已加载 ' + loadedCount + '/' + total + ' (核心: ' + criticalLoaded + '/' + criticalTotal + ')');
                if (_autoReloadEnabled && _reloadAttemptCount < _maxReloadAttempts) {
                  attemptReload();
                } else {
                  showBanner('error', '框架核心资源加载超时，请刷新页面');
                }
              } else {
                _log('warn', 'health', '框架非核心资源加载超时 (' + loadedCount + '/' + total + ')，核心资源已就绪');
              }
            }
          }
        }

        if (failedCount > 0 && _autoReloadEnabled && _reloadAttemptCount < _maxReloadAttempts) {
          var failedKeys = Object.keys(_failedResources);
          var retriableKeys = failedKeys.filter(function(k) {
            return !_resourceRetryCount[k] || _resourceRetryCount[k] < _maxResourceRetries;
          });
          if (retriableKeys.length > 0) {
            _log('info', 'health', '尝试重试 ' + retriableKeys.length + ' 个失败资源: ' + retriableKeys.join(', '));
            retriableKeys.forEach(function(key) {
              if (!_resourceRetryCount[key]) _resourceRetryCount[key] = 0;
              if (_resourceRetryCount[key] < _maxResourceRetries) {
                _resourceRetryCount[key]++;
                _retrySingleResource(key);
              }
            });
          }
        }
      }, 5000);
    }

    function onProgress(callback) {
      if (typeof callback === 'function') {
        _loadProgressCallbacks.push(callback);
        return function() {
          var idx = _loadProgressCallbacks.indexOf(callback);
          if (idx > -1) _loadProgressCallbacks.splice(idx, 1);
        };
      }
      return function() {};
    }

    function _notifyProgress() {
      var loadedCount = Object.keys(_loadedResources).length;
      var failedCount = Object.keys(_failedResources).length;
      var total = _expectedResources.length;
      var progress = total > 0 ? Math.round(((loadedCount + failedCount) / total) * 100) : 0;
      var info = {
        state: _loadState,
        progress: progress,
        loaded: loadedCount,
        failed: failedCount,
        total: total,
        elapsed: Date.now() - _loadStartTime,
      };
      for (var i = 0; i < _loadProgressCallbacks.length; i++) {
        try { _loadProgressCallbacks[i](info); } catch (e) { if (CONFIG.DEBUG) console.warn('Progress callback error:', e); }
      }
    }

    var _fmChangeHookUnsub = null;

    function _fmInit() {
      _loadStartTime = Date.now();
      _loadState = 'loading';
      _triggeredTimeoutTiers = {};
      _log('info', 'lifecycle', 'FrameworkMonitor 初始化开始');

      document.addEventListener('click', handleBannerClick);

      var initialPanelKeys = _panelEndpointGroups[_activePanel || 'panorama'];
      if (initialPanelKeys) {
        FrameworkMonitor.addExpectedResources(initialPanelKeys);
      }

      Store.subscribe('frameworkVersion', function() {
        trackResourceLoad('frameworkVersion', true);
        checkVersion();
      });
      Store.subscribe('frameworkStatus', function() {
        trackResourceLoad('frameworkStatus', true);
        checkStatus();
      });

      var _emptyAllowedResources = new Set(['audit', 'sessions', 'checkpoints', 'learnings', 'workflowTemplates', 'deviations', 'codeReviews', 'deepeningAuditTrail']);
      _fmChangeHookUnsub = Store.addChangeHook(function(key, value) {
        if (key === 'frameworkVersion' || key === 'frameworkStatus') return;
        var isEmpty = (value != null && Array.isArray(value) && value.length === 0) || (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
        var success = value != null && !(isEmpty && !_emptyAllowedResources.has(key));
        trackResourceLoad(key, success, success ? null : '数据为空');
      });

      startPeriodicCheck();
      startHealthCheck();

      setTimeout(function() {
        verifyResourceLoadOrder();
        verifyResourceIntegrity();
      }, 5000);

      setTimeout(function() {
        if (_loadState === 'loading' || _loadState === 'pending') {
          var loadedCount = Object.keys(_loadedResources).length;
          var total = _expectedResources.length;
          _log('warn', 'lifecycle', '框架加载缓慢: ' + loadedCount + '/' + total + ' 资源已加载');
          if (loadedCount === 0 && _autoReloadEnabled) {
            _log('info', 'lifecycle', '无资源加载成功，尝试自动重载...');
            attemptReload();
          }
        }
      }, 10000);

      _log('info', 'lifecycle', 'FrameworkMonitor 初始化完成，等待 ' + _expectedResources.length + ' 个资源加载');
    }

    function _fmDestroy() {
      if (_versionCheckInterval) { clearInterval(_versionCheckInterval); _versionCheckInterval = null; }
      if (_statusCheckInterval) { clearInterval(_statusCheckInterval); _statusCheckInterval = null; }
      if (_healthCheckInterval) { clearInterval(_healthCheckInterval); _healthCheckInterval = null; }
      if (_fmChangeHookUnsub) { _fmChangeHookUnsub(); _fmChangeHookUnsub = null; }
      document.removeEventListener('click', handleBannerClick);
      _loadProgressCallbacks = [];
      _log('info', 'lifecycle', 'FrameworkMonitor 已销毁');
    }

    return {
      init: _fmInit,
      destroy: _fmDestroy,
      checkVersion: checkVersion,
      checkStatus: checkStatus,
      getLoadLog: getLoadLog,
      getLoadReport: getLoadReport,
      exportLoadLog: exportLoadLog,
      verifyResourceLoadOrder: verifyResourceLoadOrder,
      verifyResourceIntegrity: verifyResourceIntegrity,
      trackResourceLoad: trackResourceLoad,
      onProgress: onProgress,
      getErrorSummary: function() {
        var result = [];
        for (var k in _errorCategories) {
          if (Object.prototype.hasOwnProperty.call(_errorCategories, k)) {
            result.push(_errorCategories[k]);
          }
        }
        result.sort(function(a, b) { return b.count - a.count; });
        return result;
      },
      getVersionChangelog: function() { return _versionChangelog.slice(); },
      getLoadProgress: function() {
        var loadedCount = Object.keys(_loadedResources).length;
        var failedCount = Object.keys(_failedResources).length;
        var total = _expectedResources.length;
        return {
          state: _loadState,
          progress: total > 0 ? Math.round(((loadedCount + failedCount) / total) * 100) : 0,
          loaded: loadedCount,
          failed: failedCount,
          total: total,
          elapsed: Date.now() - _loadStartTime,
        };
      },
      addExpectedResources: function(resourceKeys) {
        if (!resourceKeys || !resourceKeys.length) return;
        for (var i = 0; i < resourceKeys.length; i++) {
          if (_expectedResources.indexOf(resourceKeys[i]) === -1) {
            if (_expectedResources.length < MAX_EXPECTED_RESOURCES) {
              _expectedResources.push(resourceKeys[i]);
            }
          }
        }
        _updateLoadState();
        _log('info', 'resource', '添加预期资源: ' + resourceKeys.join(', ') + '，当前预期总数: ' + _expectedResources.length);
      },
      clearExpectedResources: function() {
        _expectedResources = [];
      },
      markResourceLoaded: function(stateKey) {
        if (!_loadedResources[stateKey]) {
          _loadedResources[stateKey] = Date.now();
          _resourceLoadOrder.push(stateKey);
          _updateLoadState();
        }
      },
    };
  })();

  var InteractionRecorder = (function() {
    var STORAGE_KEY = 'harness_interaction_records';
    var MAX_RECORDS = 500;
    var FLUSH_INTERVAL = 5000;
    var _queue = [];
    var _flushTimer = null;

    function _now() {
      var d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') + '.' + String(d.getMilliseconds()).padStart(3, '0');
    }

    function _validate(record) {
      if (!record || typeof record !== 'object') return false;
      if (!record.timestamp || typeof record.timestamp !== 'string') return false;
      if (!record.interactionType || typeof record.interactionType !== 'string') return false;
      if (!record.elementId && !record.elementClass && !record.elementLabel) return false;
      return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(record.timestamp);
    }

    function _createRecord(interactionType, element, extra) {
      var labelEl = element.querySelector('.meta-label');
      var valueEl = element.querySelector('.meta-value');
      var label = labelEl ? labelEl.textContent : '';
      var value = valueEl ? valueEl.textContent : '';
      var record = {
        id: 'ir_' + Date.now().toString(36),
        timestamp: _now(), interactionType: interactionType,
        elementId: element.id || '', elementClass: element.className || '',
        elementLabel: label, elementValue: value,
        version: element.closest('.changelog-entry') ? (element.closest('.changelog-entry').querySelector('.changelog-ver') ?? {}).textContent || '' : '',
        extra: extra ?? {},
      };
      return _validate(record) ? record : null;
    }

    function _loadFromStorage() {
      try { var stored = localStorage.getItem(STORAGE_KEY); return stored ? _sanitizeObj(JSON.parse(stored)) : []; } catch (e) { if (CONFIG.DEBUG) console.warn('[Harness] localStorage parse error:', e && e.message ? e.message : String(e)); return []; }
    }

    function _saveToStorage(records) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); } catch (e) { if (CONFIG.DEBUG) console.warn('localStorage.setItem failed:', e); }
    }

    function _flushQueue() {
      if (_queue.length === 0) return;
      var batch = _queue.splice(0, _queue.length);
      var stored = _loadFromStorage();
      for (var i = 0; i < batch.length; i++) stored.push(batch[i]);
      if (stored.length > MAX_RECORDS) stored = stored.slice(stored.length - MAX_RECORDS);
      _saveToStorage(stored);
    }

    function _startFlushTimer() {
      if (_flushTimer) return;
      _flushTimer = setInterval(function() { _flushQueue(); }, FLUSH_INTERVAL);
    }

    var _pendingTimers = [];

    function _removeTimer(t) {
      var idx = _pendingTimers.indexOf(t);
      if (idx >= 0) _pendingTimers.splice(idx, 1);
    }

    function record(interactionType, element, extra) {
      var rec = _createRecord(interactionType, element, extra);
      if (!rec) return null;
      _queue.push(rec);
      if (_queue.length >= 10) _flushQueue();
      element.setAttribute('data-recorded', 'true');
      var t = setTimeout(function() { element.removeAttribute('data-recorded'); _removeTimer(t); }, 1500);
      _pendingTimers.push(t);
      return rec;
    }

    function getRecords(filter) {
      _flushQueue();
      var stored = _loadFromStorage();
      if (!filter) return stored;
      var results = stored;
      if (filter.interactionType) results = results.filter(function(r) { return r.interactionType === filter.interactionType; });
      if (filter.elementLabel) results = results.filter(function(r) { return r.elementLabel === filter.elementLabel; });
      if (filter.version) results = results.filter(function(r) { return r.version === filter.version; });
      if (filter.since) results = results.filter(function(r) { return r.timestamp >= filter.since; });
      if (filter.limit && filter.limit > 0) results = results.slice(-filter.limit);
      return results;
    }

    function clearRecords() { _queue = []; try { localStorage.removeItem(STORAGE_KEY); } catch (e) { if (CONFIG.DEBUG) console.warn('localStorage removeItem error:', e); } }

    function getStats() {
      var records = getRecords();
      var stats = { total: records.length, byType: {}, byLabel: {}, byVersion: {} };
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        stats.byType[r.interactionType] = (stats.byType[r.interactionType] ?? 0) + 1;
        stats.byLabel[r.elementLabel] = (stats.byLabel[r.elementLabel] ?? 0) + 1;
        if (r.version) stats.byVersion[r.version] = (stats.byVersion[r.version] ?? 0) + 1;
      }
      return stats;
    }

    function exportRecords() { return JSON.stringify(getRecords(), null, 2); }

    var _irHandlers = [];

    function bindMetaItems() {
      var clickHandler = function(e) {
        var item = e.target.closest('.meta-item');
        if (!item || !item.closest('.changelog-meta')) return;
        record('click', item, { clientX: e.clientX, clientY: e.clientY, button: e.button });
      };
      var dblclickHandler = function(e) {
        var item = e.target.closest('.meta-item');
        if (!item || !item.closest('.changelog-meta')) return;
        record('dblclick', item, { clientX: e.clientX, clientY: e.clientY });
      };
      var contextmenuHandler = function(e) {
        var item = e.target.closest('.meta-item');
        if (!item || !item.closest('.changelog-meta')) return;
        record('contextmenu', item, { clientX: e.clientX, clientY: e.clientY });
      };
      var mouseoverHandler = function(e) {
        var item = e.target.closest('.meta-item');
        if (!item || !item.closest('.changelog-meta')) return;
        if (item._hoverRecorded) return;
        item._hoverRecorded = true;
        record('hover', item, {});
        var t = setTimeout(function() { item._hoverRecorded = false; _removeTimer(t); }, 2000);
        _pendingTimers.push(t);
      };
      var keydownHandler = function(e) {
        var item = e.target.closest('.meta-item');
        if (!item || !item.closest('.changelog-meta')) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); record('keydown', item, { key: e.key, keyCode: e.keyCode }); }
      };
      document.addEventListener('click', clickHandler, true);
      document.addEventListener('dblclick', dblclickHandler, true);
      document.addEventListener('contextmenu', contextmenuHandler, true);
      document.addEventListener('mouseover', mouseoverHandler, true);
      document.addEventListener('keydown', keydownHandler, true);
      _irHandlers = [
        { type: 'click', handler: clickHandler },
        { type: 'dblclick', handler: dblclickHandler },
        { type: 'contextmenu', handler: contextmenuHandler },
        { type: 'mouseover', handler: mouseoverHandler },
        { type: 'keydown', handler: keydownHandler },
      ];
    }

    var _beforeUnloadHandler = null;

    function init() {
      bindMetaItems();
      _startFlushTimer();
      _beforeUnloadHandler = function() { _flushQueue(); };
      window.addEventListener('beforeunload', _beforeUnloadHandler);
    }

    function destroy() {
      if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
      _flushQueue();
      _pendingTimers.forEach(function(t) { clearTimeout(t); });
      _pendingTimers = [];
      _irHandlers.forEach(function(item) {
        document.removeEventListener(item.type, item.handler, true);
      });
      _irHandlers = [];
      if (_beforeUnloadHandler) {
        window.removeEventListener('beforeunload', _beforeUnloadHandler);
        _beforeUnloadHandler = null;
      }
    }

    return { init: init, destroy: destroy, record: record, getRecords: getRecords, clearRecords: clearRecords, getStats: getStats, exportRecords: exportRecords };
  })();

  var _visibilityHandler = null;

  function initThemeToggle() {
    var THEMES = ['dark', 'light', 'ocean', 'forest', 'sunset'];
    var THEME_LABELS = { dark: '暗色', light: '亮色', ocean: '海洋', forest: '森林', sunset: '日落' };
    var saved = null;
    try { saved = localStorage.getItem('harness-theme'); } catch (e) { if (CONFIG.DEBUG && typeof console !== 'undefined') console.warn('[Harness] localStorage.getItem error:', e); }
    if (saved && THEMES.indexOf(saved) !== -1) {
      document.documentElement.setAttribute('data-theme', saved);
      document.documentElement.style.setProperty('color-scheme', saved === 'light' ? 'light' : 'dark');
    }
    var header = document.querySelector('header');
    if (!header) return;
    var btn = document.createElement('button');
    btn.className = 'theme-toggle-btn';
    var currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    btn.setAttribute('aria-label', '切换主题（当前：' + (THEME_LABELS[currentTheme] || currentTheme) + '）');
    btn.title = '切换主题';
    btn.style.cssText = 'position:absolute;right:16px;top:50%;transform:translateY(-50%);background:linear-gradient(135deg,var(--surface2),var(--surface3));border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 10px;cursor:pointer;font-size:12px;color:var(--text2);transition:all .3s cubic-bezier(.4,0,.2,1);z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.15);white-space:nowrap;';
    btn.textContent = THEME_LABELS[currentTheme] || '暗色';
    btn.addEventListener('mouseenter', function() { btn.style.borderColor = 'rgba(129,140,248,.3)'; btn.style.boxShadow = '0 4px 16px rgba(129,140,248,.15)'; btn.style.transform = 'translateY(-50%) scale(1.05)'; });
    btn.addEventListener('mouseleave', function() { btn.style.borderColor = 'var(--border)'; btn.style.boxShadow = '0 2px 8px rgba(0,0,0,.15)'; btn.style.transform = 'translateY(-50%) scale(1)'; });
    var onThemeToggle = function() {
      var cur = document.documentElement.getAttribute('data-theme') || 'dark';
      var idx = THEMES.indexOf(cur);
      var next = THEMES[(idx + 1) % THEMES.length];
      document.documentElement.setAttribute('data-theme', next);
      document.documentElement.style.setProperty('color-scheme', next === 'light' ? 'light' : 'dark');
      btn.textContent = THEME_LABELS[next] || next;
      btn.setAttribute('aria-label', '切换主题（当前：' + (THEME_LABELS[next] || next) + '）');
      try { localStorage.setItem('harness-theme', next); } catch (e) { if (CONFIG.DEBUG && typeof console !== 'undefined') console.warn('[Harness] localStorage.setItem error:', e); }
    };
    btn.addEventListener('click', onThemeToggle);
    _managedListeners.push({ el: btn, type: 'click', fn: onThemeToggle });
    header.style.position = 'relative';
    header.appendChild(btn);
  }

  /**
   * 对话管理面板初始化——融合自Hermes Desktop"一站式对话管理"功能。
   * 在知识面板中渲染已固定对话列表，提供搜索和导出操作。
   */
  function initConversationPanel() {
    var container = document.getElementById('conversation-panel');
    if (!container) return;

    function _escapeHtml(s) {
      if (!s || typeof s !== 'string') return '';
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderPinnedSessions() {
      var data = _state.conversationPinned;
      var sessions = (data && data.pinnedSessions) ? data.pinnedSessions : [];
      if (!Array.isArray(sessions) || sessions.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:16px;text-align:center;color:var(--text3);font-size:var(--text-sm);">暂无固定对话</div>';
        return;
      }
      var html = '<div class="conversation-list" style="display:flex;flex-direction:column;gap:8px;">';
      for (var i = 0; i < sessions.length; i++) {
        var s = sessions[i];
        var sid = _escapeHtml(s.sessionId || s.id || '');
        var label = _escapeHtml(s.label || s.title || sid.slice(0, 12));
        html += '<div class="conversation-item glass-card" style="padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px;">';
        html += '<span style="font-size:var(--text-sm);color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="' + sid + '">' + label + '</span>';
        html += '<div style="display:flex;gap:4px;flex-shrink:0;">';
        html += '<button class="conv-export-btn pill-btn" data-sid="' + sid + '" style="font-size:var(--text-3xs);padding:2px 8px;" title="导出对话">导出</button>';
        html += '<button class="conv-unpin-btn pill-btn" data-sid="' + sid + '" style="font-size:var(--text-3xs);padding:2px 8px;" title="取消固定">取消固定</button>';
        html += '</div></div>';
      }
      html += '</div>';
      container.innerHTML = html;
    }

    container.addEventListener('click', function(e) {
      var btn = e.target.closest('.conv-export-btn');
      if (btn) {
        var sid = btn.getAttribute('data-sid');
        if (sid) {
          _fetchWithTimeout(API + '/api/conversation/export', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, format: 'markdown', includeMetadata: true }),
          }).then(function(r) { return r.json(); }).then(function(data) {
            if (data && data.content) {
              var blob = new Blob([data.content], { type: 'text/markdown' });
              var url = URL.createObjectURL(blob);
              var a = document.createElement('a');
              a.href = url; a.download = 'conversation-' + sid.slice(0, 8) + '.md';
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }
          }).catch(function(err) { if (CONFIG.DEBUG) console.warn('[Harness] export error:', err); });
        }
      }
      var unpinBtn = e.target.closest('.conv-unpin-btn');
      if (unpinBtn) {
        var sid2 = unpinBtn.getAttribute('data-sid');
        if (sid2) {
          _fetchWithTimeout(API + '/api/conversation/pin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid2, pinned: false }),
          }).then(function(r) { return r.json(); }).then(function() {
            DataLayer.invalidateEndpoint('conversation/pinned');
          }).catch(function(err) { if (CONFIG.DEBUG) console.warn('[Harness] unpin error:', err); });
        }
      }
    });

    var searchInput = container.parentElement && container.parentElement.querySelector('.conv-search-input');
    if (searchInput) {
      var searchTimer = null;
      searchInput.addEventListener('input', function() {
        clearTimeout(searchTimer);
        var query = searchInput.value.trim();
        if (!query) { renderPinnedSessions(); return; }
        searchTimer = setTimeout(function() {
          _fetchWithTimeout(API + '/api/conversation/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query, limit: 20 }),
          }).then(function(r) { return r.json(); }).then(function(data) {
            var results = (data && data.results) ? data.results : [];
            if (results.length === 0) {
              container.innerHTML = '<div class="empty-state" style="padding:16px;text-align:center;color:var(--text3);font-size:var(--text-sm);">无搜索结果</div>';
              return;
            }
            var html = '<div class="conversation-list" style="display:flex;flex-direction:column;gap:8px;">';
            for (var i = 0; i < results.length; i++) {
              var r = results[i];
              var content = _escapeHtml((r.content || '').slice(0, 120));
              var role = _escapeHtml(r.role || '');
              html += '<div class="conversation-item glass-card" style="padding:10px 12px;">';
              html += '<div style="font-size:var(--text-3xs);color:var(--primary-light);margin-bottom:4px;">' + role + '</div>';
              html += '<div style="font-size:var(--text-sm);color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + content + '</div>';
              html += '</div>';
            }
            html += '</div>';
            container.innerHTML = html;
          }).catch(function(err) { if (CONFIG.DEBUG) console.warn('[Harness] search error:', err); });
        }, 400);
      });
    }

    Store.addChangeHook(function(key) {
      if (key === 'conversationPinned') renderPinnedSessions();
    });
    renderPinnedSessions();
  }

  var _chatActiveSessionId = null;
  var _chatSending = false;

  function initChatPanel() {
    var chatInput = $('chat-input');
    var sendBtn = $('btn-chat-send');
    var newBtn = $('btn-chat-new');
    var sidebarToggle = $('btn-chat-sidebar-toggle');
    var sidebar = $('chat-sidebar');
    var sessionList = $('chat-session-list');
    var sessionSearch = $('chat-session-search');
    var pinBtn = $('btn-chat-pin');
    var exportBtn = $('btn-chat-export');
    var endBtn = $('btn-chat-end');
    var charCount = $('chat-char-count');
    var messagesEl = $('chat-messages');
    var welcomeEl = $('chat-welcome');

    if (!chatInput || !sendBtn) return;

    function _chatEscapeHtml(s) {
      if (!s || typeof s !== 'string') return '';
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _formatTime(ts) {
      if (!ts || isNaN(new Date(ts).getTime())) return '';
      var d = new Date(ts);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }

    function _addMessageBubble(role, content, timestamp) {
      if (welcomeEl) welcomeEl.style.display = 'none';
      var div = document.createElement('div');
      div.className = 'chat-msg chat-msg-' + role;
      var avatarText = role === 'user' ? 'U' : 'H';
      var bubbleContent = content;
      try {
        var parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
          if (parsed.type === 'acknowledgment') {
            bubbleContent = '已收到消息。匹配技能: ' + ((parsed.matchedSkills ?? []).join(', ') || '无') + '\n上下文长度: ' + (parsed.contextLength ?? 0);
          } else if (parsed.type === 'echo') {
            bubbleContent = parsed.note || '消息已记录（Agent运行时不可用）';
          } else if (parsed.type === 'error') {
            bubbleContent = '处理失败: ' + (parsed.message || '未知错误');
          } else {
            bubbleContent = JSON.stringify(parsed, null, 2);
          }
        }
      } catch (_) { if (CONFIG.DEBUG) console.warn('Chat message JSON parse failed, using raw content'); }
      div.innerHTML =
        '<div class="chat-msg-avatar">' + avatarText + '</div>' +
        '<div>' +
          '<div class="chat-msg-bubble">' + _chatEscapeHtml(bubbleContent).replace(/\n/g, '<br>') + '</div>' +
          '<div class="chat-msg-time">' + _formatTime(timestamp) + '</div>' +
        '</div>';
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function _addTypingIndicator() {
      var div = document.createElement('div');
      div.className = 'chat-msg chat-msg-assistant';
      div.id = 'chat-typing-indicator';
      div.innerHTML =
        '<div class="chat-msg-avatar">H</div>' +
        '<div class="chat-msg-bubble"><div class="chat-msg-typing"><span></span><span></span><span></span></div></div>';
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function _removeTypingIndicator() {
      var el = $('chat-typing-indicator');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function sendMessage() {
      if (_chatSending) return;
      var msg = chatInput.value.trim();
      if (!msg) return;
      chatInput.value = '';
      chatInput.style.height = 'auto';
      if (charCount) charCount.textContent = '0 / 32000';
      sendBtn.disabled = true;

      _addMessageBubble('user', msg, Date.now());
      _chatSending = true;
      _addTypingIndicator();

      var body = { message: msg };
      if (_chatActiveSessionId) body.sessionId = _chatActiveSessionId;

      _fetchWithTimeout(API + '/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 15000).then(function(r) { return r.json(); }).then(function(data) {
        _removeTypingIndicator();
        if (data && data.success) {
          _chatActiveSessionId = data.sessionId;
          if (data.response) {
            var respContent = typeof data.response === 'string' ? data.response : JSON.stringify(data.response);
            _addMessageBubble('assistant', respContent, Date.now());
          }
          DataLayer.invalidateEndpoint('chat/sessions');
        } else {
          _addMessageBubble('assistant', '发送失败: ' + ((data && data.error) || '未知错误'), Date.now());
        }
      }).catch(function(err) {
        _removeTypingIndicator();
        _addMessageBubble('assistant', '网络错误: ' + (err && err.message ? err.message : String(err)), Date.now());
      }).finally(function() {
        _chatSending = false;
      });
    }

    function loadSessionHistory(sessionId) {
      _chatActiveSessionId = sessionId;
      if (messagesEl) {
        var welcome = messagesEl.querySelector('.chat-welcome');
        messagesEl.innerHTML = '';
        if (welcome) messagesEl.appendChild(welcome);
      }

      _fetchWithTimeout(API + '/api/chat/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, limit: 50 }),
      }, 10000).then(function(r) { return r.json(); }).then(function(data) {
        if (data && data.turns) {
          if (welcomeEl) welcomeEl.style.display = 'none';
          data.turns.forEach(function(t) {
            _addMessageBubble(t.role, t.content, t.timestamp);
          });
        }
      }).catch(function(err) {
        if (CONFIG.DEBUG) console.warn('[Harness] chat history error:', err);
      });

      DataLayer.invalidateEndpoint('chat/sessions');
    }

    function createNewSession() {
      _fetchWithTimeout(API + '/api/chat/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, 10000).then(function(r) { return r.json(); }).then(function(data) {
        if (data && data.success) {
          _chatActiveSessionId = data.sessionId;
          if (messagesEl) {
            var welcome = messagesEl.querySelector('.chat-welcome');
            messagesEl.innerHTML = '';
            if (welcome) {
              welcome.style.display = '';
              messagesEl.appendChild(welcome);
            }
          }
          DataLayer.invalidateEndpoint('chat/sessions');
          showToast('新会话已创建', 'success');
        }
      }).catch(function(err) {
        if (CONFIG.DEBUG) console.warn('[Harness] chat start error:', err);
        showToast('创建会话失败', 'error');
      });
    }

    chatInput.addEventListener('input', function() {
      var len = chatInput.value.length;
      if (charCount) charCount.textContent = len + ' / 32000';
      sendBtn.disabled = len === 0 || _chatSending;
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });

    chatInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener('click', function() {
      sendMessage();
    });

    if (newBtn) {
      newBtn.addEventListener('click', function() {
        createNewSession();
      });
    }

    if (sidebarToggle && sidebar) {
      sidebarToggle.addEventListener('click', function() {
        sidebar.classList.toggle('collapsed');
      });
    }

    if (sessionSearch) {
      var searchTimer = null;
      sessionSearch.addEventListener('input', function() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function() {
          UIState.chatSessionSearchQuery = sessionSearch.value.trim();
          Renderers.chat();
        }, 300);
      });
    }

    if (sessionList) {
      sessionList.addEventListener('click', function(e) {
        var item = e.target.closest('.chat-session-item');
        if (item) {
          var sid = item.getAttribute('data-session-id');
          if (sid) loadSessionHistory(sid);
        }
      });
    }

    if (pinBtn) {
      pinBtn.addEventListener('click', function() {
        if (!_chatActiveSessionId) return;
        _fetchWithTimeout(API + '/api/conversation/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: _chatActiveSessionId, pinned: true }),
        }).then(function(r) { return r.json(); }).then(function() {
          DataLayer.invalidateEndpoint('chat/sessions');
          showToast('会话已固定', 'success');
        }).catch(function(err) { if (CONFIG.DEBUG) console.warn('[Harness] pin error:', err); });
      });
    }

    if (exportBtn) {
      exportBtn.addEventListener('click', function() {
        if (!_chatActiveSessionId) return;
        _fetchWithTimeout(API + '/api/conversation/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: _chatActiveSessionId, format: 'markdown', includeMetadata: true }),
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (data && data.content) {
            var blob = new Blob([data.content], { type: 'text/markdown' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = 'chat-' + _chatActiveSessionId.slice(0, 8) + '.md';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
        }).catch(function(err) { if (CONFIG.DEBUG) console.warn('[Harness] export error:', err); });
      });
    }

    if (endBtn) {
      endBtn.addEventListener('click', function() {
        if (!_chatActiveSessionId) return;
        _fetchWithTimeout(API + '/api/chat/end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: '会话已结束' }),
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (data && data.success) {
            _chatActiveSessionId = null;
            if (messagesEl) {
              var welcome = messagesEl.querySelector('.chat-welcome');
              messagesEl.innerHTML = '';
              if (welcome) {
                welcome.style.display = '';
                messagesEl.appendChild(welcome);
              }
            }
            DataLayer.invalidateEndpoint('chat/sessions');
            showToast('会话已结束', 'success');
          }
        }).catch(function(err) { if (CONFIG.DEBUG) console.warn('[Harness] end error:', err); });
      });
    }

    var hintBtns = document.querySelectorAll('.chat-hint-btn');
    hintBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var hint = btn.getAttribute('data-hint');
        if (hint && chatInput) {
          chatInput.value = hint;
          chatInput.dispatchEvent(new Event('input'));
          chatInput.focus();
        }
      });
    });
  }

  var _mobileCardViewMediaQuery = null;
  var _mobileCardViewHandler = null;
  function initMobileCardView() {
    _mobileCardViewMediaQuery = window.matchMedia('(max-width: 768px)');
    function applyMobileCardView() {
      var isMobile = _mobileCardViewMediaQuery.matches;
      var wraps = document.querySelectorAll('.table-wrap');
      wraps.forEach(function(wrap) {
        var table = wrap.querySelector('.data-table');
        if (table && table.querySelectorAll('td[data-label]').length > 0) {
          if (isMobile) wrap.classList.add('mobile-card-view');
          else wrap.classList.remove('mobile-card-view');
        }
      });
    }
    applyMobileCardView();
    _mobileCardViewHandler = applyMobileCardView;
    if (_mobileCardViewMediaQuery.addEventListener) {
      _mobileCardViewMediaQuery.addEventListener('change', _mobileCardViewHandler);
    } else {
      _mobileCardViewMediaQuery.addListener(_mobileCardViewHandler);
    }
    var _origUpdateHTML = updateHTML;
    updateHTML = function(el, html) {
      _origUpdateHTML(el, html);
      if (el && el.querySelector && el.querySelector('.data-table')) {
        applyMobileCardView();
      }
    };
  }

  var _pullRefreshState = 'idle';
  var _pullStartY = 0;
  var _pullCurrentY = 0;
  var PULL_THRESHOLD = 60;

  function initPullRefresh() {
    var container = $('pull-refresh-container');
    var indicator = $('pull-refresh-indicator');
    var textEl = $('pull-refresh-text');
    if (!container || !indicator) return;

    var mainEl = $('main-content');
    if (!mainEl) return;

    function onTouchStart(e) {
      if (window.innerWidth > 768) return;
      if (document.documentElement.scrollTop > 0 || document.body.scrollTop > 0) return;
      _pullStartY = e.touches[0].clientY;
      _pullRefreshState = 'pulling';
    }

    function onTouchMove(e) {
      if (_pullRefreshState === 'idle' || _pullRefreshState === 'loading') return;
      _pullCurrentY = e.touches[0].clientY;
      var diff = _pullCurrentY - _pullStartY;
      if (diff <= 0) {
        indicator.classList.remove('visible', 'ready');
        _pullRefreshState = 'idle';
        return;
      }
      if (document.documentElement.scrollTop === 0 && document.body.scrollTop === 0) {
        e.preventDefault();
      }
      var pull = Math.min(diff * 0.5, 100);
      indicator.style.top = (-44 + pull) + 'px';
      indicator.classList.add('visible');
      if (pull >= PULL_THRESHOLD) {
        indicator.classList.add('ready');
        if (textEl) textEl.textContent = '释放刷新';
        _pullRefreshState = 'ready';
      } else {
        indicator.classList.remove('ready');
        if (textEl) textEl.textContent = '下拉刷新';
        _pullRefreshState = 'pulling';
      }
    }

    function onTouchEnd() {
      if (_pullRefreshState === 'ready') {
        _pullRefreshState = 'loading';
        indicator.classList.add('loading');
        indicator.classList.remove('ready');
        if (textEl) textEl.textContent = '刷新中...';
        DataLayer.clearCache();
        DataLayer.fetchAll().then(function() {
          finishPullRefresh();
        }).catch(function(err) {
          finishPullRefresh();
          showToast('刷新失败，请稍后重试', 'error');
          if (CONFIG.DEBUG) console.error('Pull refresh failed:', err);
        });
      } else if (_pullRefreshState === 'pulling') {
        indicator.classList.remove('visible');
        indicator.style.top = '-44px';
        _pullRefreshState = 'idle';
      }
    }

    function finishPullRefresh() {
      _pullRefreshState = 'idle';
      indicator.classList.remove('visible', 'loading');
      indicator.style.top = '-44px';
      if (textEl) textEl.textContent = '下拉刷新';
      showToast('数据已刷新', 'success');
    }

    mainEl.addEventListener('touchstart', onTouchStart, { passive: true });
    mainEl.addEventListener('touchmove', onTouchMove, { passive: false });
    mainEl.addEventListener('touchend', onTouchEnd, { passive: true });
    _managedListeners.push({ el: mainEl, type: 'touchstart', fn: onTouchStart });
    _managedListeners.push({ el: mainEl, type: 'touchmove', fn: onTouchMove });
    _managedListeners.push({ el: mainEl, type: 'touchend', fn: onTouchEnd });
  }

  function initNetworkMonitor() {
    OfflineDetector.onChange(function(isOnline) {
      var banner = $('offline-banner');
      if (isOnline) {
        if (!UIState._onlineStatus) {
          UIState._onlineStatus = true;
          _wsReconnectAttempts = 0;
          showToast('网络连接已恢复', '');
          if (banner) banner.classList.remove('visible');
          DataLayer.clearCache();
          DataLayer.fetchAll().catch(function(e) { if (CONFIG.DEBUG) console.warn('[Harness] reconnect fetch error:', e); });
          initWebSocket();
          if (FrameworkMonitor && FrameworkMonitor.checkVersion) {
            FrameworkMonitor.checkVersion();
            FrameworkMonitor.checkStatus();
          }
        }
      } else {
        UIState._onlineStatus = false;
        showToast('网络连接已断开，数据将无法更新', 'error');
        if (banner) banner.classList.add('visible');
      }
    });

    if (typeof document.addEventListener !== 'undefined' && document.visibilityState !== undefined) {
      _visibilityHandler = function() {
        if (document.visibilityState === 'visible') {
          _pageVisible = true;
          _wsReconnectAttempts = 0;
          if (!_connectionDown) {
            DataLayer.clearCache();
            DataLayer.fetchAll().catch(function(e) { if (CONFIG.DEBUG) console.warn('[Harness] ws reconnect fetch error:', e); });
            if (!_ws || _ws.readyState !== WebSocket.OPEN) {
              initWebSocket();
            }
          }
        } else {
          _pageVisible = false;
          if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
        }
      };
      document.addEventListener('visibilitychange', _visibilityHandler);
    }

    initWebSocket();
  }

  function _checkMsgDepth(msg, maxDepth) {
    var stack = [{obj: msg, depth: 0}];
    var totalKeys = 0;
    while (stack.length > 0) {
      var item = stack.pop();
      if (item.depth >= maxDepth) return false;
      if (item.obj && typeof item.obj === 'object' && item.obj !== null) {
        var keys = Object.keys(item.obj);
        totalKeys += keys.length;
        if (totalKeys > 1000) return false;
        for (var i = 0; i < keys.length; i++) {
          stack.push({obj: item.obj[keys[i]], depth: item.depth + 1});
        }
      }
    }
    return true;
  }

  var _ws = null;
  var _wsReconnectAttempts = 0;
  var _wsMaxReconnectAttempts = 10;
  var _wsReconnectTimer = null;

  function _hashToken(token) {
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
      var encoder = new TextEncoder();
      return crypto.subtle.digest('SHA-256', encoder.encode(token)).then(function(buf) {
        var arr = new Uint8Array(buf);
        var hex = '';
        for (var i = 0; i < arr.length; i++) hex += ('0' + arr[i].toString(16)).slice(-2);
        return hex;
      });
    }
    return Promise.resolve(token);
  }
  var _wsClosed = false;
  var _wsConnecting = false;

  function initWebSocket() {
    if (typeof WebSocket === 'undefined') return;
    if (_wsConnecting) return;
    if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) return;
    _wsClosed = false;
    _wsConnecting = true;
    var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = wsProtocol + '//' + location.host + '/ws';
    try {
      var wsOptions = undefined;
      if (CONFIG.API_TOKEN) {
        wsOptions = 'sha256-pending';
      }
      _ws = wsOptions ? new WebSocket(wsUrl, wsOptions) : new WebSocket(wsUrl);
      var currentWs = _ws;
      _ws.onopen = function() {
        _wsConnecting = false;
        _wsReconnectAttempts = 0;
        _wsClosed = false;
        if (CONFIG.API_TOKEN && currentWs.readyState === WebSocket.OPEN) {
          _hashToken(CONFIG.API_TOKEN).then(function(hashHex) {
            if (currentWs.readyState === WebSocket.OPEN) {
              currentWs.send(JSON.stringify({ type: 'auth', token: 'sha256-' + hashHex }));
            }
          }).catch(function(err) { if (CONFIG.DEBUG) console.warn('WS auth error:', err); });
        }
        if (UIState.loadError) {
          showToast('实时数据通道已恢复连接', '');
        }
      };
      _ws.onmessage = function(evt) {
        try {
          if (!evt.data || typeof evt.data !== 'string' || evt.data.length > 1048576) return;
          var msg = JSON.parse(evt.data);
          if (msg && typeof msg === 'object' && msg !== null) {
            if (!_checkMsgDepth(msg, 20)) return;
            _sanitizeObj(msg);
          }
          if (msg.event === 'data-update' && msg.data) {
            var stateKey = msg.data.key;
            var val = msg.data.value;
            if (stateKey && typeof stateKey === 'string' && stateKey.length <= 64 && _validStateKeys[stateKey] && val !== null && typeof val === 'object') {
              if (Array.isArray(val) && val.length > 5000) return;
              if (!Array.isArray(val)) {
                var vKeys = Object.keys(val);
                if (vKeys.length > 200) return;
              }
              var newHash = Store._shallowHash(val);
              var oldHash = _dataHashCache[stateKey];
              if (oldHash !== undefined && oldHash === newHash) {
                return;
              }
              var dhKeys = Object.keys(_dataHashCache);
              if (dhKeys.length >= MAX_DATAHASH_ENTRIES) {
                delete _dataHashCache[dhKeys[0]];
              }
              _dataHashCache[stateKey] = newHash;
              var rcKeys = Object.keys(_responseCache);
              if (rcKeys.length >= MAX_CACHE_ENTRIES) {
                delete _responseCache[rcKeys[0]];
              }
              _responseCache[stateKey] = { data: val, ts: Date.now() };
              var updates = {};
              updates[stateKey] = val;
              Store.batchUpdate(updates);
            }
          }
          if (msg.type === 'version-update' && msg.data && typeof msg.data === 'object') {
            var vVer = typeof msg.data.version === 'string' ? msg.data.version.slice(0, 32) : '';
            var vSum = typeof msg.data.summary === 'string' ? msg.data.summary.slice(0, 200) : '';
            DataLayer.invalidateEndpoint('changelog');
            DataLayer.invalidateEndpoint('auto-version/stats');
            DataLayer.invalidateEndpoint('auto-version/recent');
            DataLayer.fetchMultiple(['changelog', 'auto-version/stats', 'auto-version/recent'], function() {
              scheduleRender('changelog', function() { Renderers.changelog(); });
            });
            if (typeof showToast === 'function' && (vVer || vSum)) {
              showToast('版本更新: v' + vVer + ' — ' + vSum, 'info');
            }
          }
        } catch (e) {
          if (e instanceof SyntaxError) { /* ignore non-JSON messages */ }
          else { if (CONFIG.DEBUG) console.error('WebSocket message processing error:', e); }
        }
      };
      _ws.onclose = function() {
        _wsConnecting = false;
        if (_ws === currentWs) {
          currentWs.onmessage = null;
          currentWs.onopen = null;
          currentWs.onerror = null;
          _ws = null;
        }
        if (!_wsClosed) {
          _wsClosed = true;
          scheduleWsReconnect();
        }
      };
      _ws.onerror = function() {
        _wsConnecting = false;
        if (_ws === currentWs) {
          currentWs.onmessage = null;
          currentWs.onopen = null;
          currentWs.onclose = null;
          _ws = null;
        }
        if (!_wsClosed) {
          _wsClosed = true;
          scheduleWsReconnect();
        }
      };
    } catch (e) {
      _wsConnecting = false;
      if (!_wsClosed) {
        _wsClosed = true;
        scheduleWsReconnect();
      }
    }
  }

  function scheduleWsReconnect() {
    if (_connectionDown) return;
    if (_wsReconnectAttempts >= _wsMaxReconnectAttempts) {
      _wsTotalReconnectCycles++;
      if (_wsTotalReconnectCycles >= _WS_MAX_RECONNECT_CYCLES) {
        if (typeof showToast === 'function') showToast('WebSocket连接持续失败，已停止重连', 'error');
        return;
      }
      _wsReconnectTimer = setTimeout(function() {
        _wsReconnectAttempts = 0;
        initWebSocket();
      }, 300000);
      return;
    }
    if (_wsReconnectTimer) clearTimeout(_wsReconnectTimer);
    var delay = Math.min(1000 * Math.pow(2, _wsReconnectAttempts), 30000) + Math.floor(Math.random() * 1000);
    _wsReconnectAttempts++;
    _wsReconnectTimer = setTimeout(function() {
      initWebSocket();
    }, delay);
  }

  var _wsTotalReconnectCycles = 0;
  var _WS_MAX_RECONNECT_CYCLES = 6;

  var _scrollRevealObserver = null;
  function initScrollReveal() {
    if (typeof IntersectionObserver === 'undefined') return;
    _scrollRevealObserver = new IntersectionObserver(function(entries) {
      var observer = _scrollRevealObserver;
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('scroll-reveal-visible');
          if (observer) observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.card, .stat-card, .wf-node, .pipeline-step, .agent-card').forEach(function(el) {
      el.classList.add('scroll-reveal');
      _scrollRevealObserver.observe(el);
    });
  }

  var _rippleHandler = null;
  function _createRipple(e) {
    var target = e.target.closest('button, .btn, .btn-icon, .btn-outline, .btn-primary, .btn-danger, .btn-small, .stat-card, .tab, .filter-btn, .pipeline-step, .agent-card, .wf-node, .page-btn, .pill-btn');
    if (!target || target.disabled || target.closest('.toast')) return;
    var ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.setAttribute('aria-hidden', 'true');
    var rect = target.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height) * 1.2;
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    target.appendChild(ripple);
    ripple.addEventListener('animationend', function() { ripple.remove(); });
  }
  function initRippleEffect() {
    _rippleHandler = _createRipple;
    document.addEventListener('click', _rippleHandler, true);
  }

  // === Harness迁移性面板 ===
  function initHarnessPanel() {
    var panel = document.getElementById('panel-harness');
    if (!panel) return;
    loadHarnessData();
  }

  function initAITestPanel() {
    var panel = document.getElementById('panel-ai-test');
    if (!panel) return;
    loadAITestData();
  }

  function loadAITestData() {
    _fetchWithTimeout(API + '/api/ai-test/stats').then(function(r) { return r.json(); }).then(function(data) {
      renderAITestPanel(data);
    }).catch(function() {
      var panel = document.getElementById('panel-ai-test');
      if (panel) panel.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>加载AI测试数据失败</p></div>';
    });
  }

  function runAITest(type, config) {
    var endpoint = API + '/api/ai-test/' + encodeURIComponent(type);
    return _fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config ?? {}),
    }).then(function(r) { return r.json(); }).then(function(result) {
      loadAITestData();
      return result;
    }).catch(function() {
      showToast('AI测试运行失败', 'error');
    });
  }

  function renderAITestPanel(data) {
    var panel = document.getElementById('panel-ai-test');
    if (!panel) return;
    data = data ?? {};
    var stats = data.stats ?? {};
    var html = '<div class="harness-dashboard">'
      + '<div class="harness-section">'
      + '<h3>AI测试面板</h3>'
      + '<div class="lifecycle-stats">'
      + '<div class="stat-item"><label>总测试数</label><span>' + (stats.total ?? 0) + '</span></div>'
      + '<div class="stat-item"><label>通过数</label><span>' + (stats.passed ?? 0) + '</span></div>'
      + '<div class="stat-item"><label>失败数</label><span>' + (stats.failed ?? 0) + '</span></div>'
      + '<div class="stat-item"><label>通过率</label><span>' + ((stats.passRate ?? 0).toFixed(2)) + '</span></div>'
      + '</div>'
      + '</div>'
      + '</div>';
    panel.innerHTML = html;
  }

  function initProductGatePanel() {
    var panel = document.getElementById('panel-product-gate');
    if (!panel) return;
    _fetchWithTimeout(API + '/api/product-gate/proposal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then(function(r) { return r.json(); }).then(function(data) {
      renderProductGatePanel(data);
    }).catch(function() {
      if (panel) panel.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>加载产品门禁数据失败</p></div>';
    });
  }

  function renderProductGatePanel(data) {
    var panel = document.getElementById('panel-product-gate');
    if (!panel) return;
    data = data ?? {};
    var html = '<div class="harness-dashboard">'
      + '<div class="harness-section">'
      + '<h3>产品门禁</h3>'
      + '<div class="lifecycle-stats">'
      + '<div class="stat-item"><label>状态</label><span>' + escapeHtml(data.status || '未知') + '</span></div>'
      + '<div class="stat-item"><label>通过</label><span>' + (data.passed ? '是' : '否') + '</span></div>'
      + '</div>'
      + '</div>'
      + '</div>';
    panel.innerHTML = html;
  }

  function loadHarnessData() {
    Promise.allSettled([
      _fetchWithTimeout(API + '/api/harness/migration/report').then(function(r) { return r.json(); }),
      _fetchWithTimeout(API + '/api/harness/calibration/report').then(function(r) { return r.json(); }),
      _fetchWithTimeout(API + '/api/harness/lifecycle/status').then(function(r) { return r.json(); }),
    ]).then(function(results) {
      var migration = (results[0].status === 'fulfilled' ? results[0].value : null) ?? {};
      var calibration = (results[1].status === 'fulfilled' ? results[1].value : null) ?? {};
      var lifecycle = (results[2].status === 'fulfilled' ? results[2].value : null) ?? {};
      renderHarnessPanel(migration, calibration, lifecycle);
    }).catch(function() {
      var panel = document.getElementById('panel-harness');
      if (panel) panel.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>加载Harness数据失败</p></div>';
    });
  }

  function _buildCalibrationHtml(calibration) {
    var biasLabels = { overestimate: '高估偏差', underestimate: '低估偏差', calibrated: '已校准', unknown: '未知' };
    return '<div class="harness-section">'
      + '<h3>评估校准</h3>'
      + '<div class="calibration-stats">'
      + '<div class="stat-item"><label>样本数</label><span>' + (calibration.sampleSize ?? 0) + '</span></div>'
      + '<div class="stat-item"><label>平均置信度</label><span>' + ((calibration.avgConfidence ?? 0).toFixed(3)) + '</span></div>'
      + '<div class="stat-item"><label>通过率</label><span>' + ((calibration.passRate ?? 0).toFixed(3)) + '</span></div>'
      + '<div class="stat-item"><label>校准误差</label><span>' + ((calibration.calibrationError ?? 0).toFixed(3)) + '</span></div>'
      + '<div class="stat-item"><label>阈值调整</label><span>' + ((calibration.thresholdAdjustment ?? 0).toFixed(3)) + '</span></div>'
      + '<div class="stat-item"><label>偏差方向</label><span>' + escapeHtml(biasLabels[calibration.bias] || calibration.bias || '未知') + '</span></div>'
      + '</div>'
      + '</div>';
  }

  function _buildLifecycleHtml(lifecycle) {
    var phaseLabels = { idle: '空闲', planning: '规划中', generating: '生成中', evaluating: '评估中', completed: '已完成', failed: '失败', unavailable: '不可用' };
    return '<div class="harness-section">'
      + '<h3>任务生命周期</h3>'
      + '<div class="lifecycle-stats">'
      + '<div class="stat-item"><label>当前阶段</label><span>' + escapeHtml(phaseLabels[lifecycle.phase] || lifecycle.phase || '未知') + '</span></div>'
      + '<div class="stat-item"><label>当前轮次</label><span>' + (lifecycle.currentRound ?? 0) + ' / ' + (lifecycle.maxRounds ?? 0) + '</span></div>'
      + '<div class="stat-item"><label>上下文模式</label><span>' + escapeHtml(lifecycle.contextMode || 'normal') + '</span></div>'
      + '<div class="stat-item"><label>评估阈值</label><span>' + ((lifecycle.evaluationThreshold ?? 0).toFixed(2)) + '</span></div>'
      + '</div>'
      + '</div>';
  }

  function renderHarnessPanel(migration, calibration, lifecycle) {
    var panel = document.getElementById('panel-harness');
    if (!panel) return;

    var tierLabels = { weak: '弱模型', standard: '标准模型', strong: '强模型', frontier: '前沿模型' };
    var currentTier = migration.currentTier || 'standard';
    var tierHtml = Object.keys(tierLabels).map(function(t) {
      var isActive = t === currentTier ? ' active' : '';
      return '<button class="tier-btn' + isActive + '" data-tier="' + t + '">' + escapeHtml(tierLabels[t]) + '</button>';
    }).join('');

    var activeList = (migration.active ?? []).map(function(c) {
      return '<span class="tag tag-green">' + escapeHtml(c) + '</span>';
    }).join(' ');
    var inactiveList = (migration.inactive ?? []).map(function(c) {
      return '<span class="tag tag-gray">' + escapeHtml(c) + '</span>';
    }).join(' ');

    var html = '<div class="harness-dashboard">'
      + '<div class="harness-section">'
      + '<h3>模型能力等级</h3>'
      + '<div class="tier-selector">' + tierHtml + '</div>'
      + '<div class="tier-info">当前: <strong>' + escapeHtml(tierLabels[currentTier] || currentTier) + '</strong> | 活跃组件: ' + (migration.activeCount ?? 0) + ' | 非活跃: ' + (migration.inactiveCount ?? 0) + '</div>'
      + '</div>'
      + '<div class="harness-section">'
      + '<h3>组件状态</h3>'
      + '<div class="component-list"><label>活跃:</label> ' + (activeList || '<span class="tag tag-gray">无</span>') + '</div>'
      + '<div class="component-list"><label>非活跃:</label> ' + (inactiveList || '<span class="tag tag-gray">无</span>') + '</div>'
      + '</div>'
      + _buildCalibrationHtml(calibration)
      + _buildLifecycleHtml(lifecycle)
      + '</div>';

    panel.innerHTML = html;

    var tierBtns = panel.querySelectorAll('.tier-btn');
    tierBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tier = btn.getAttribute('data-tier');
        if (!tier) return;
        _fetchWithTimeout(API + '/api/harness/migration/tier', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier: tier }),
        }).then(function(r) { return r.json(); }).then(function() {
          loadHarnessData();
        }).catch(function(err) { if (CONFIG.DEBUG) console.warn('Harness tier update failed:', err); });
      });
    });
  }

  function init() {
    try {
      initTabs();
      initNavDrawer();
      initGlobalEventDelegation();
      initFilters();
      bindStoreSubscriptions();
      initLazyObserver();
      initRippleEffect();
      initScrollReveal();
      InteractionRecorder.init();
      FrameworkMonitor.init();
      OfflineDetector.init();
      initNetworkMonitor();
      initThemeToggle();
      initConversationPanel();
      initChatPanel();
      initHarnessPanel();
      initAITestPanel();
      initProductGatePanel();
      initMobileCardView();
      initPullRefresh();
      if (!navigator.onLine) {
        var banner = $('offline-banner');
        if (banner) banner.classList.add('visible');
      }
      DataLayer.fetchAll().catch(function(e) { if (CONFIG.DEBUG) console.warn('[Harness] online fetch error:', e); });
      setTimeout(function() {
        var loadingScreen = document.getElementById('app-loading-screen');
        if (loadingScreen) {
          loadingScreen.classList.add('fade-out');
          setTimeout(function() {
            if (loadingScreen.parentNode) loadingScreen.parentNode.removeChild(loadingScreen);
          }, 800);
        }
        document.documentElement.classList.add('app-loaded');
      }, 200);
    } catch (e) {
      if (CONFIG.DEBUG) console.error('Init error:', e);
      var container = document.getElementById('toast-container');
      if (container) {
        var el = document.createElement('div');
        el.className = 'toast error';
        el.textContent = '初始化错误，请刷新页面重试';
        container.appendChild(el);
        requestAnimationFrame(function() { el.classList.add('toast-visible'); });
      }
    }
  }

  function destroy() {
    DataLayer.stop();
    FrameworkMonitor.destroy();
    InteractionRecorder.destroy();
    _toastTimers.forEach(function(t) { clearTimeout(t); });
    _toastTimers.clear();
    if (_ws) { try { _ws.close(); } catch (e) { if (CONFIG.DEBUG && typeof console !== 'undefined') console.warn('[Harness] ws.close error:', e); } _ws = null; }
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
    if (_connectionRetryTimer) { clearTimeout(_connectionRetryTimer); _connectionRetryTimer = null; }
    _storeUnsubscribers.forEach(function(unsub) { try { unsub(); } catch (e) { if (CONFIG.DEBUG && typeof console !== 'undefined') console.warn('[Harness] unsubscribe error:', e); } });
    _storeUnsubscribers = [];
    if (_unhandledRejectionHandler) { window.removeEventListener('unhandledrejection', _unhandledRejectionHandler); }
    if (_globalErrorHandler) { window.removeEventListener('error', _globalErrorHandler); }
    if (_tooltipMouseoverHandler) { document.removeEventListener('mouseover', _tooltipMouseoverHandler, true); }
    if (_tooltipMousemoveHandler) { document.removeEventListener('mousemove', _tooltipMousemoveHandler, true); }
    if (_tooltipMouseoutHandler) { document.removeEventListener('mouseout', _tooltipMouseoutHandler, true); }
    if (_globalClickHandler) { document.removeEventListener('click', _globalClickHandler); }
    if (_pointerdownHandler) { document.removeEventListener('pointerdown', _pointerdownHandler); _pointerdownHandler = null; }
    if (_focusinHandler) { document.removeEventListener('focusin', _focusinHandler); _focusinHandler = null; }
    if (_focusoutHandler) { document.removeEventListener('focusout', _focusoutHandler); _focusoutHandler = null; }
    if (_rippleHandler) { document.removeEventListener('click', _rippleHandler, true); _rippleHandler = null; }
    if (_scrollRevealObserver) { _scrollRevealObserver.disconnect(); _scrollRevealObserver = null; }
    if (_globalKeydownHandler) { document.removeEventListener('keydown', _globalKeydownHandler); }
    if (_tabNavEl) {
      if (_tabClickHandler) _tabNavEl.removeEventListener('click', _tabClickHandler);
      if (_tabKeydownHandler) _tabNavEl.removeEventListener('keydown', _tabKeydownHandler);
    }
    if (_tabGlobalKeydownHandler) { document.removeEventListener('keydown', _tabGlobalKeydownHandler); }
    if (_hashchangeHandler) { window.removeEventListener('hashchange', _hashchangeHandler); }
    if (_navDrawerKeydownHandler) { document.removeEventListener('keydown', _navDrawerKeydownHandler); }
    if (_navDrawerFocusTrapCleanup) { _navDrawerFocusTrapCleanup(); _navDrawerFocusTrapCleanup = null; }
    if (_tabObserver) { _tabObserver.disconnect(); }
    if (_visibilityHandler) { document.removeEventListener('visibilitychange', _visibilityHandler); }
    if (_mobileCardViewMediaQuery && _mobileCardViewHandler) {
      if (_mobileCardViewMediaQuery.removeEventListener) {
        _mobileCardViewMediaQuery.removeEventListener('change', _mobileCardViewHandler);
      } else {
        _mobileCardViewMediaQuery.removeListener(_mobileCardViewHandler);
      }
    }
    _mobileCardViewMediaQuery = null;
    _mobileCardViewHandler = null;
    invalidateDomCache();
    _rafQueue = {};
    _lastHtmlHash = new WeakMap();
    _responseCache = {};
    _dataHashCache = {};
    if (_lazyObserver) {
      _lazyObserver.disconnect();
      _lazyObserver = null;
    }
    _lazyCallbacks = {};
    if (PanoramaEngine._initialized) {
      PanoramaEngine.destroy();
    }
    OfflineDetector.destroy();
    for (var mi = 0; mi < _managedListeners.length; mi++) {
      var ml = _managedListeners[mi];
      if (ml.el && ml.fn) { try { ml.el.removeEventListener(ml.type, ml.fn); } catch (e) { if (CONFIG.DEBUG) console.warn('removeEventListener failed:', e); } }
    }
    _managedListeners.length = 0;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('beforeunload', destroy);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      navigator.serviceWorker.register('/sw.js?v=2.72.1').then(function(reg) {
        reg.addEventListener('updatefound', function() {
          var newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', function() {
            if (newWorker.state === 'activated') {
              showToast('应用已更新至最新版本', 'success');
            }
          });
        });
      }).catch(function() {
        if (CONFIG.DEBUG) console.warn('SW registration failed');
      });
    });
  }

})();
