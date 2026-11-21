/* AGNi Development Assistant — behaviour only.
 *
 * Plain classic script (no modules, no imports). Must work when loaded with `defer`.
 * All DOM is built with createElement / textContent — model output can never inject HTML.
 * See docs/assistant-ui-contract.md for the authoritative contract.
 */
(function () {
  'use strict';

  var API_BASE = '/api/agni/assistant';
  var ROOT_ID = 'agni-dev-assistant';
  var PAGE_LAB = 'agni-lab';
  var PAGE_AGNI = 'agni';

  var dom = {};
  var page = PAGE_AGNI;
  var challenge = null;
  var busy = false;
  var history = [];
  var weightsSnapshot = null;
  var lastRun = null;
  var hasRun = false;
  var runObserver = null;

  /* ── user API settings (optional, never sent back to the browser) ── */
  var STORAGE_KEY = 'agni-assistant-settings';
  var userSettings = { apiKey: '', baseUrl: '', model: '', persisted: false };

  function loadUserSettings() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        userSettings.apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
        userSettings.baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '';
        userSettings.model = typeof parsed.model === 'string' ? parsed.model : '';
        userSettings.persisted = parsed.persisted === true;
      }
    } catch (err) {
      userSettings = { apiKey: '', baseUrl: '', model: '', persisted: false };
    }
  }

  function persistUserSettings() {
    try {
      if (!userSettings.persisted) {
        window.localStorage.removeItem(STORAGE_KEY);
        return;
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        apiKey: userSettings.apiKey,
        baseUrl: userSettings.baseUrl,
        model: userSettings.model,
        persisted: true
      }));
    } catch (err) {
      /* storage unavailable (private mode) — keep the key in memory only */
      userSettings.persisted = false;
    }
  }

  function settingsPayload() {
    var payload = {};
    if (userSettings.apiKey) payload.apiKey = userSettings.apiKey;
    if (userSettings.baseUrl) payload.baseUrl = userSettings.baseUrl;
    if (userSettings.model) payload.model = userSettings.model;
    return payload;
  }

  /* ── tiny helpers ─────────────────────────────────────── */

  function byId(id) { return document.getElementById(id); }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function dispatch(el, type) {
    if (!el) return;
    try {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    } catch (err) {
      /* older browsers: ignore */
    }
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setStatus(text) {
    if (dom.status) dom.status.textContent = text || '';
  }

  var NEXI_TEXT = {
    'idle': 'NEXI · idle — तैयार है',
    'thinking': 'NEXI · thinking — सोच रहा है',
    'running tool': 'NEXI · running tool — tool चल रहा है',
    'error': 'NEXI · error — कुछ गड़बड़ हुई',
    'done': 'NEXI · done — जवाब तैयार है'
  };

  function setNexi(state) {
    if (dom.nexiStatus) {
      dom.nexiStatus.textContent = NEXI_TEXT[state] || NEXI_TEXT['idle'];
      dom.nexiStatus.setAttribute('data-state', state);
    }
  }

  function scrollMessages() {
    if (!dom.messages) return;
    dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  /* ── bubbles ──────────────────────────────────────────── */

  /**
   * Minimal, injection-safe markdown → DOM renderer.
   * Only **bold**, `code` and newlines are interpreted; everything else stays
   * plain text. No innerHTML is ever used, so model output cannot inject markup.
   */
  function renderRichText(target, text) {
    target.textContent = '';
    var lines = String(text === undefined || text === null ? '' : text).split('\n');
    lines.forEach(function (line, index) {
      if (index > 0) target.appendChild(document.createElement('br'));
      var parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
      parts.forEach(function (part) {
        if (!part) return;
        if (part.length > 4 && part.slice(0, 2) === '**' && part.slice(-2) === '**') {
          var strong = document.createElement('strong');
          strong.textContent = part.slice(2, -2);
          target.appendChild(strong);
          return;
        }
        if (part.length > 2 && part.charAt(0) === '`' && part.charAt(part.length - 1) === '`') {
          var code = document.createElement('code');
          code.textContent = part.slice(1, -1);
          target.appendChild(code);
          return;
        }
        target.appendChild(document.createTextNode(part));
      });
    });
  }

  function addBubble(role, text, opts) {
    opts = opts || {};
    var bubble = make('div', 'agni-assistant-bubble');
    bubble.setAttribute('data-role', role);
    if (opts.error) bubble.setAttribute('data-error', 'true');
    else bubble.setAttribute('data-error', 'false');
    if (opts.teaching) bubble.classList.add('is-teaching');

    var label = { user: 'आप', assistant: 'सहायक', system: 'सिस्टम' }[role] || 'सिस्टम';
    bubble.appendChild(make('span', 'agni-assistant-bubble-role', label + (opts.teaching ? ' · शिक्षण' : '')));
    var body = make('span', 'agni-assistant-bubble-text');
    renderRichText(body, text);
    bubble.appendChild(body);

    dom.messages.appendChild(bubble);
    scrollMessages();
    return bubble;
  }

  function addSystem(text) { return addBubble('system', text, {}); }

  function addError(text) {
    setStatus(text);
    setNexi('error');
    return addBubble('system', text, { error: true });
  }

  /* ── network (only the two contract endpoints + approve) ── */

  function postJson(path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (response) {
      return response.text().then(function (raw) {
        var data = {};
        if (raw) {
          try { data = JSON.parse(raw); } catch (err) { data = {}; }
        }
        if (!response.ok) {
          var message = (data && (data.error || data.message)) ? String(data.error || data.message) : ('अनुरोध पूरा नहीं हुआ (HTTP ' + response.status + ')।');
          throw new Error(message);
        }
        return data;
      });
    });
  }

  /* ── challenge ────────────────────────────────────────── */

  function loadChallenge() {
    challenge = null;
    dom.challengeQuestion.textContent = 'मानव-जाँच लोड हो रही है…';
    dom.challengeAnswer.value = '';
    updateControls();
    return postJson(API_BASE + '/challenge', {}).then(function (data) {
      if (!data || typeof data.id !== 'string' || typeof data.question !== 'string') {
        throw new Error('मानव-जाँच उपलब्ध नहीं है।');
      }
      challenge = { id: data.id };
      dom.challengeQuestion.textContent = 'मानव-जाँच: ' + data.question;
      setStatus('');
      updateControls();
    }).catch(function (error) {
      challenge = null;
      dom.challengeQuestion.textContent = 'मानव-जाँच अभी उपलब्ध नहीं है।';
      setStatus(error && error.message ? error.message : 'नया प्रश्न लोड नहीं हुआ।');
      updateControls();
    });
  }

  function updateControls() {
    if (dom.send) dom.send.disabled = busy || !challenge;
    if (dom.challengeAnswer) dom.challengeAnswer.disabled = busy || !challenge;
    if (dom.challengeRefresh) dom.challengeRefresh.disabled = busy;
  }

  /* ── page context ─────────────────────────────────────── */

  function valueOf(id) {
    var el = byId(id);
    return el && typeof el.value === 'string' ? el.value : '';
  }

  function numberOrNull(text) {
    var n = Number(text);
    return isFinite(n) ? n : null;
  }

  /* The Lab page currently ships input ids x0..x3 in some builds and x1..x4 in
     others — read whichever set exists so the context never goes empty. */
  function readLabInputs() {
    var candidates = [['x1', 'x2', 'x3', 'x4'], ['x0', 'x1', 'x2', 'x3']];
    var ids = null;
    for (var i = 0; i < candidates.length; i++) {
      var complete = true;
      for (var k = 0; k < candidates[i].length; k++) {
        if (!byId(candidates[i][k])) { complete = false; break; }
      }
      if (complete) { ids = candidates[i]; break; }
    }
    if (!ids) {
      for (var m = 0; m < candidates.length; m++) {
        if (byId(candidates[m][0])) { ids = candidates[m]; break; }
      }
    }
    if (!ids) return [];
    var values = [];
    for (var j = 0; j < ids.length; j++) {
      var raw = valueOf(ids[j]);
      values.push(raw === '' ? null : numberOrNull(raw));
    }
    return values;
  }

  function parseWeightField(id) {
    var raw = valueOf(id);
    if (raw === '') return { ok: false, missing: true };
    try {
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { ok: false };
      return { ok: true, value: parsed };
    } catch (err) {
      return { ok: false };
    }
  }

  function currentWeightsText() {
    return { w1: valueOf('w1'), b1: valueOf('b1'), w2: valueOf('w2'), b2: valueOf('b2') };
  }

  function weightsTextChanged() {
    if (!weightsSnapshot) return false;
    var now = currentWeightsText();
    return now.w1 !== weightsSnapshot.w1 || now.b1 !== weightsSnapshot.b1 ||
           now.w2 !== weightsSnapshot.w2 || now.b2 !== weightsSnapshot.b2;
  }

  function readWeights() {
    var keys = [['w1', 'w1'], ['b1', 'b1'], ['w2', 'w2'], ['b2', 'b2']];
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      var parsed = parseWeightField(keys[i][0]);
      if (!parsed.ok) return { ok: false, weights: null };
      out[keys[i][1]] = parsed.value;
    }
    return { ok: true, weights: out };
  }

  function currentVisibleSectionId() {
    var sections = document.querySelectorAll('section[id]');
    var best = null;
    var bestScore = -1;
    var viewportTop = window.scrollY || 0;
    var viewportBottom = viewportTop + window.innerHeight;
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      if (!section.id || section.id === ROOT_ID) continue;
      var rect = section.getBoundingClientRect();
      var visible = Math.max(0, Math.min(rect.bottom, viewportBottom) - Math.max(rect.top, viewportTop));
      var score = visible - Math.abs(rect.top) * 0.001;
      if (score > bestScore) { bestScore = score; best = section.id; }
    }
    return best;
  }

  function buildLabContext() {
    var weightsResult = readWeights();
    var inputs = readLabInputs();
    var hidden = byId('hidden-activation');
    var output = byId('output-activation');
    var dirty = weightsTextChanged() || !weightsResult.ok;

    var context = {
      page: PAGE_LAB,
      model: {
        architecture: '4-16-3',
        hiddenActivation: hidden && hidden.value ? hidden.value : 'relu',
        outputActivation: output && output.value ? output.value : 'softmax'
      },
      inputs: inputs,
      projectState: {
        section: 'playground',
        lastRun: lastRun || '',
        hasRun: hasRun,
        dirty: dirty
      }
    };
    if (weightsResult.ok) context.weights = weightsResult.weights;
    return context;
  }

  function buildAgniContext() {
    return {
      page: PAGE_AGNI,
      projectState: {
        section: currentVisibleSectionId() || '',
        lastRun: '',
        hasRun: false,
        dirty: false
      }
    };
  }

  function buildContext() {
    return page === PAGE_LAB ? buildLabContext() : buildAgniContext();
  }

  /* ── context chips ────────────────────────────────────── */

  function addChip(text, warn) {
    var chip = make('span', 'agni-assistant-chip' + (warn ? ' is-warn' : ''), text);
    dom.context.appendChild(chip);
  }

  function renderContextChips(context) {
    clear(dom.context);
    if (page === PAGE_LAB) {
      var model = context.model || {};
      addChip('पेज: AGNi Lab');
      addChip('आर्किटेक्चर: ' + (model.architecture || '4-16-3'));
      addChip('activation: ' + (model.hiddenActivation || '?') + ' → ' + (model.outputActivation || '?'));
      if (context.weights) addChip('weights पढ़े गए');
      else addChip('weights JSON त्रुटि — नहीं भेजे गए', true);
      if (context.projectState && context.projectState.dirty) addChip('बदलाव लागू नहीं (dirty)', true);
      if (context.projectState && context.projectState.hasRun) addChip('पिछला forward pass चला है');
    } else {
      addChip('पेज: AGNi');
      var section = context.projectState ? context.projectState.section : null;
      addChip(section ? ('दृश्यमान section: ' + section) : 'दृश्यमान section: अज्ञात');
    }
    addChip(userSettings.apiKey ? 'API key: आपकी key' : 'API key: server secret',
      !userSettings.apiKey);
  }

  /* ── tool rows ────────────────────────────────────────── */

  function summarizeResult(result) {
    if (result === null || result === undefined) return 'कोई विवरण नहीं';
    if (typeof result === 'string') return result;
    if (typeof result !== 'object') return String(result);
    var keys = ['summary', 'message', 'output', 'result', 'value', 'note'];
    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(result, keys[i])) {
        var v = result[keys[i]];
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      }
    }
    try {
      var text = JSON.stringify(result);
      return text.length > 140 ? text.slice(0, 140) + '…' : text;
    } catch (err) {
      return 'कोई विवरण नहीं';
    }
  }

  function renderToolCalls(toolCalls) {
    clear(dom.tools);
    if (!Array.isArray(toolCalls) || !toolCalls.length) return;
    for (var i = 0; i < toolCalls.length; i++) {
      var call = toolCalls[i] || {};
      var isError = call.status === 'error' || call.status === 'failed';
      var row = make('div', 'agni-assistant-tool ' + (isError ? 'is-error' : 'is-ok'));
      row.setAttribute('data-tool', String(call.name || ''));
      row.setAttribute('data-status', String(call.status || (isError ? 'error' : 'ok')));
      row.appendChild(make('span', 'agni-assistant-tool-name', call.name || 'tool'));
      row.appendChild(make('span', 'agni-assistant-tool-state', isError ? 'त्रुटि' : 'सफल'));
      if (typeof call.ms === 'number') row.appendChild(make('span', 'agni-assistant-tool-ms', call.ms + ' ms'));
      var detail = '';
      if (isError && typeof call.error === 'string' && call.error) detail = call.error;
      else detail = summarizeResult(call.result !== undefined ? call.result : call.input);
      row.appendChild(make('span', 'agni-assistant-tool-result', detail));
      dom.tools.appendChild(row);
    }
  }

  /* ── proposal preview ─────────────────────────────────── */

  function renderDiff(diff) {
    var box = make('pre', 'agni-assistant-diff');
    if (!Array.isArray(diff) || !diff.length) {
      box.textContent = 'कोई diff नहीं।';
      return box;
    }
    for (var i = 0; i < diff.length; i++) {
      var item = diff[i] || {};
      var line = make('span', 'agni-assistant-diff-line');
      var path = make('span', 'is-path', String(item.path !== undefined ? item.path : '') + ': ');
      line.appendChild(path);
      if (item.before !== undefined) line.appendChild(make('span', 'is-before', String(item.before)));
      if (item.before !== undefined && item.after !== undefined) line.appendChild(make('span', '', ' → '));
      if (item.after !== undefined) line.appendChild(make('span', 'is-after', String(item.after)));
      box.appendChild(line);
    }
    return box;
  }

  function renderProposal(proposal) {
    clear(dom.preview);
    if (!proposal || typeof proposal !== 'object') return;

    var block = make('div', 'agni-assistant-proposal');
    block.setAttribute('data-proposal-id', String(proposal.id || ''));

    var kindLabel = { weights: 'weights', activation: 'activation', architecture: 'architecture', code: 'code' }[proposal.kind] || proposal.kind || 'बदलाव';
    block.appendChild(make('strong', 'agni-assistant-proposal-title', 'preview · ' + kindLabel + (proposal.title ? ' · ' + proposal.title : '')));
    if (proposal.summary) block.appendChild(make('p', 'agni-assistant-proposal-summary', proposal.summary));
    block.appendChild(renderDiff(proposal.diff));

    var actions = make('div', 'agni-assistant-proposal-actions');
    var approve = make('button', 'agni-assistant-approve', 'स्वीकारें (Approve)');
    approve.type = 'button';
    var reject = make('button', 'agni-assistant-reject', 'अस्वीकारें (Reject)');
    reject.type = 'button';
    actions.appendChild(approve);
    actions.appendChild(reject);
    block.appendChild(actions);

    approve.addEventListener('click', function () {
      approveProposal(proposal, approve, reject);
    });
    reject.addEventListener('click', function () {
      rejectProposal(proposal, approve, reject);
    });

    dom.preview.appendChild(block);
  }

  /* ── applying an approved payload ─────────────────────── */

  function setSelectValue(id, value) {
    var el = byId(id);
    if (!el || typeof value !== 'string' || !value) return false;
    var options = el.options || [];
    for (var i = 0; i < options.length; i++) {
      if (options[i].value === value) {
        el.value = value;
        dispatch(el, 'input');
        dispatch(el, 'change');
        return true;
      }
    }
    return false;
  }

  function applyPayload(payload) {
    var changes = [];
    if (!payload || typeof payload !== 'object') return changes;

    var type = typeof payload.type === 'string' ? payload.type : '';
    var weightKeys = [['w1', 'W₁'], ['b1', 'b₁'], ['w2', 'W₂'], ['b2', 'b₂']];

    if (type === 'set-weights' || payload.w1 || payload.b1 || payload.w2 || payload.b2) {
      for (var i = 0; i < weightKeys.length; i++) {
        var key = weightKeys[i][0];
        if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
        var value = payload[key];
        if (!Array.isArray(value)) continue;
        var el = byId(key);
        if (!el) continue;
        el.value = JSON.stringify(value, null, 2);
        dispatch(el, 'input');
        changes.push(weightKeys[i][1]);
      }
    }

    if (type === 'set-activation' || payload.hiddenActivation || payload.outputActivation || payload.activation) {
      var hidden = payload.hiddenActivation || payload.hidden || null;
      var output = payload.outputActivation || payload.output || null;
      if (!hidden && !output && payload.activation) hidden = payload.activation;
      if (hidden && setSelectValue('hidden-activation', hidden)) changes.push('hidden activation (' + hidden + ')');
      if (output && setSelectValue('output-activation', output)) changes.push('output activation (' + output + ')');
    }

    if (type === 'set-architecture' || payload.architecture) {
      changes.push('architecture (' + String(payload.architecture || '') + ') — इस पेज पर लागू नहीं हुआ');
    }

    return changes;
  }

  function runPlayground() {
    var run = byId('run');
    if (!run || typeof run.click !== 'function') return;
    try {
      run.click();
      hasRun = true;
      lastRun = new Date().toISOString();
    } catch (err) {
      /* playground run failed silently — the page shows its own error */
    }
  }

  function approveProposal(proposal, approveBtn, rejectBtn) {
    if (busy) return;
    if (!proposal || !proposal.id) {
      addError('इस preview में proposal id नहीं है—कृपया नया जवाब माँगें।');
      return;
    }
    busy = true;
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    setNexi('thinking');
    setStatus('बदलाव स्वीकार किया जा रहा है…');

    postJson(API_BASE + '/approve', { proposalId: String(proposal.id), approve: true })
      .then(function (data) {
        if (!data || data.ok === false) {
          throw new Error((data && (data.error || data.message)) ? String(data.error || data.message) : 'बदलाव स्वीकार नहीं हुआ।');
        }
        var payload = (data && data.payload) ? data.payload : proposal.payload;
        var changes = applyPayload(payload);
        weightsSnapshot = currentWeightsText();
        if (page === PAGE_LAB && changes.length) runPlayground();
        if (!changes.length) {
          addSystem('स्वीकृत बदलाव इस पेज पर लागू नहीं हुआ (यह AGNi पेज है)।');
        } else {
          addSystem('स्वीकृत बदलाव लागू हुआ: ' + changes.join(', ') + '।');
        }
        setStatus('');
        setNexi('done');
        clear(dom.preview);
      })
      .catch(function (error) {
        addError(error && error.message ? error.message : 'बदलाव स्वीकार नहीं हुआ।');
      })
      .then(function () {
        busy = false;
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
        updateControls();
      });
  }

  function rejectProposal(proposal, approveBtn, rejectBtn) {
    if (busy) return;
    busy = true;
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    setStatus('बदलाव अस्वीकार किया जा रहा है…');

    var done = function () {
      addSystem('बदलाव अस्वीकार कर दिया गया—पेज का कोई हिस्सा नहीं बदला गया।');
      setStatus('');
      setNexi('done');
      clear(dom.preview);
      busy = false;
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
      updateControls();
    };

    if (!proposal || !proposal.id) {
      done();
      return;
    }

    postJson(API_BASE + '/approve', { proposalId: String(proposal.id), approve: false })
      .then(done)
      .catch(function () {
        addError('अस्वीकार करने की सूचना सर्वर तक नहीं पहुँची—बदलाव लागू नहीं हुआ।');
        busy = false;
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
        updateControls();
      });
  }

  /* ── chat ─────────────────────────────────────────────── */

  function sendMessage() {
    if (busy) return;

    var content = dom.input.value.trim();
    var code = dom.challengeAnswer.value.trim();

    if (!content) {
      setStatus('पहले अपना सवाल लिखें।');
      dom.input.focus();
      return;
    }
    if (!challenge) {
      setStatus('पहले मानव-जाँच का नया प्रश्न लोड करें।');
      return;
    }
    if (!/^\d{1,2}$/.test(code)) {
      setStatus('मानव-जाँच का उत्तर 1–2 अंकों में लिखें।');
      dom.challengeAnswer.focus();
      return;
    }

    var activeChallenge = challenge;
    var context = buildContext();
    renderContextChips(context);

    busy = true;
    updateControls();
    dom.input.value = '';
    dom.challengeAnswer.value = '';
    challenge = null;
    setNexi('thinking');
    setStatus('उत्तर तैयार हो रहा है…');
    addBubble('user', content, {});

    var nextHistory = history.concat([{ role: 'user', content: content }]);

    postJson(API_BASE + '/chat', {
      message: content,
      challenge: { id: activeChallenge.id, answer: code },
      page: page,
      teachingMode: dom.teaching.checked === true,
      context: context,
      history: nextHistory.slice(-8),
      settings: settingsPayload()
    })
      .then(function (data) {
        data = data || {};
        if (data.errors && data.errors.length) {
          for (var i = 0; i < data.errors.length; i++) {
            addBubble('system', String(data.errors[i]), { error: true });
          }
        }
        renderToolCalls(data.toolCalls);

        var hasErrors = !!(data.errors && data.errors.length);
        var reply = typeof data.reply === 'string' && data.reply
          ? data.reply
          : (hasErrors ? '' : 'कोई जवाब नहीं मिला।');
        if (reply) addBubble('assistant', reply, {});
        if (typeof data.teaching === 'string' && data.teaching) {
          addBubble('system', data.teaching, { teaching: true });
        }
        history = history.concat([{ role: 'user', content: content }, { role: 'assistant', content: reply }]);

        if (data.proposal) renderProposal(data.proposal);
        else clear(dom.preview);

        setStatus('');
        setNexi('done');
      })
      .catch(function (error) {
        addError(error && error.message ? error.message : 'उत्तर नहीं मिल सका।');
        history = history.concat([{ role: 'user', content: content }]);
      })
      .then(function () {
        busy = false;
        updateControls();
        loadChallenge();
      });
  }

  /* ── page detection ───────────────────────────────────── */

  function detectPage() {
    var path = window.location.pathname || '';
    if (path.indexOf('/hi/agni/lab') === 0 || path.indexOf('/agni/lab') !== -1) return PAGE_LAB;
    if (path.indexOf('/agni') !== -1) return PAGE_AGNI;
    return byId('w1') && byId('run') ? PAGE_LAB : PAGE_AGNI;
  }

  /* ── lab run tracking ─────────────────────────────────── */

  function watchLabRuns() {
    var status = byId('z-status');
    if (status && /tested/i.test(status.textContent || '')) hasRun = true;
    var summary = byId('summary');
    if (!summary || typeof MutationObserver !== 'function') return;
    runObserver = new MutationObserver(function () {
      var text = summary.textContent || '';
      if (text.indexOf('वास्तविक output') !== -1 || text.indexOf('Tested') !== -1) {
        hasRun = true;
        lastRun = new Date().toISOString();
      }
    });
    runObserver.observe(summary, { childList: true, subtree: true, characterData: true });
  }

  /* ── init ─────────────────────────────────────────────── */

  function collectDom() {
    dom.root = byId(ROOT_ID);
    dom.toggle = byId('agni-assistant-toggle');
    dom.panel = byId('agni-assistant-panel');
    dom.close = byId('agni-assistant-close');
    dom.messages = byId('agni-assistant-messages');
    dom.form = byId('agni-assistant-form');
    dom.input = byId('agni-assistant-input');
    dom.send = byId('agni-assistant-send');
    dom.challengeQuestion = byId('agni-assistant-challenge-question');
    dom.challengeAnswer = byId('agni-assistant-challenge-answer');
    dom.challengeRefresh = byId('agni-assistant-challenge-refresh');
    dom.status = byId('agni-assistant-status');
    dom.context = byId('agni-assistant-context');
    dom.tools = byId('agni-assistant-tools');
    dom.preview = byId('agni-assistant-preview');
    dom.teaching = byId('agni-assistant-teaching-toggle');
    dom.settingsBtn = byId('agni-assistant-settings');
    dom.settingsWindow = byId('agni-assistant-settings-window');
    dom.settingsClose = byId('agni-assistant-settings-close');
    dom.settingsSave = byId('agni-assistant-settings-save');
    dom.settingsClear = byId('agni-assistant-settings-clear');
    dom.apiKey = byId('agni-assistant-api-key');
    dom.baseUrl = byId('agni-assistant-base-url');
    dom.model = byId('agni-assistant-model');
    dom.saveKey = byId('agni-assistant-save-key');
    dom.settingsStatus = byId('agni-assistant-settings-status');
    dom.nexi = byId('agni-assistant-nexi');
    dom.nexiStatus = byId('agni-assistant-nexi-status');
  }

  function openPanel(open) {
    if (!dom.panel || !dom.toggle) return;
    dom.panel.hidden = !open;
    dom.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      renderContextChips(buildContext());
      if (dom.input) dom.input.focus();
    }
  }


  /* ── settings window (own API key / provider / model) ────── */

  function openSettings(open) {
    if (!dom.settingsWindow) return;
    if (open) {
      if (dom.apiKey) dom.apiKey.value = userSettings.apiKey || '';
      if (dom.baseUrl) dom.baseUrl.value = userSettings.baseUrl || '';
      if (dom.model) dom.model.value = userSettings.model || '';
      if (dom.saveKey) dom.saveKey.checked = userSettings.persisted === true;
      if (dom.settingsStatus) {
        dom.settingsStatus.textContent = userSettings.apiKey
          ? 'आपकी key इस्तेमाल हो रही है।'
          : 'अभी Worker का server secret इस्तेमाल हो रहा है।';
      }
      dom.settingsWindow.hidden = false;
      if (dom.apiKey) { try { dom.apiKey.focus(); } catch (err) { /* ignore */ } }
    } else {
      dom.settingsWindow.hidden = true;
    }
  }

  function saveSettings() {
    userSettings.apiKey = dom.apiKey ? String(dom.apiKey.value || '').trim() : '';
    userSettings.baseUrl = dom.baseUrl ? String(dom.baseUrl.value || '') : '';
    userSettings.model = dom.model ? String(dom.model.value || '').trim() : '';
    userSettings.persisted = dom.saveKey ? dom.saveKey.checked === true : false;
    persistUserSettings();
    if (dom.settingsStatus) {
      dom.settingsStatus.textContent = userSettings.apiKey
        ? (userSettings.persisted
          ? 'Key सेव हो गई (localStorage) और अगले request से इस्तेमाल होगी।'
          : 'Key सिर्फ़ इस session में रहेगी (पेज reload करने पर मिट जाएगी)।')
        : 'Key हटा दी गई — अब Worker का server secret इस्तेमाल होगा।';
    }
    renderContextChips(buildContext());
  }

  function clearSettings() {
    userSettings = { apiKey: '', baseUrl: '', model: '', persisted: false };
    persistUserSettings();
    if (dom.apiKey) dom.apiKey.value = '';
    if (dom.baseUrl) dom.baseUrl.value = '';
    if (dom.model) dom.model.value = '';
    if (dom.saveKey) dom.saveKey.checked = false;
    if (dom.settingsStatus) dom.settingsStatus.textContent = 'सभी सेटिंग्स हटा दी गईं।';
    renderContextChips(buildContext());
  }

  function init() {
    collectDom();
    if (!dom.root || !dom.panel || !dom.form) return;

    page = detectPage();
    dom.root.setAttribute('data-agni-page', page);

    if (page === PAGE_LAB) {
      weightsSnapshot = currentWeightsText();
      watchLabRuns();
    }

    dom.toggle.addEventListener('click', function () {
      openPanel(dom.panel.hidden);
    });
    if (dom.close) {
      dom.close.addEventListener('click', function () { openPanel(false); });
    }
    dom.challengeRefresh.addEventListener('click', function () {
      if (!busy) loadChallenge();
    });
    if (dom.settingsBtn) {
      dom.settingsBtn.addEventListener('click', function () { openSettings(true); });
    }
    if (dom.settingsClose) {
      dom.settingsClose.addEventListener('click', function () { openSettings(false); });
    }
    if (dom.settingsSave) {
      dom.settingsSave.addEventListener('click', function () { saveSettings(); });
    }
    if (dom.settingsClear) {
      dom.settingsClear.addEventListener('click', function () { clearSettings(); });
    }
    if (dom.settingsWindow) {
      dom.settingsWindow.addEventListener('click', function (event) {
        if (event.target === dom.settingsWindow) openSettings(false);
      });
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && dom.settingsWindow && !dom.settingsWindow.hidden) openSettings(false);
    });
    dom.form.addEventListener('submit', function (event) {
      event.preventDefault();
      sendMessage();
    });
    dom.input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        sendMessage();
      }
    });

    loadUserSettings();
    setNexi('idle');
    addSystem('नमस्ते! मैं NEXI हूँ—AGNi के weights, activation और forward pass पर मदद करता हूँ। अपना सवाल लिखें।');
    renderContextChips(buildContext());
    updateControls();
    loadChallenge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
