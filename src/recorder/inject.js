// Keyrun recorder: runs inside every frame of the page being recorded (Playwright init script,
// or the Chrome extension's content script). It watches clicks and typing, works out several
// ways to find each element again (role, label, placeholder, text, test id, CSS), and sends a
// small event to the recorder. It never sends what was typed into a password or code field.
(function () {
  if (window.__keyrunRecorder) return;
  window.__keyrunRecorder = true;

  function send(evt) {
    evt.url = location.href;
    evt.framePath = framePath();
    evt.ts = Date.now();
    try {
      if (typeof window.__keyrunRecord === 'function') window.__keyrunRecord(evt);
      else if (typeof window.__keyrunSend === 'function') window.__keyrunSend(evt);
    } catch (e) { /* recorder gone */ }
  }

  // ---------- helpers ----------
  function looksRandom(s) {
    if (!s) return true;
    if (/^[a-f0-9]{6,}$/i.test(s)) return true; // hex blobs
    if (/^[a-z]{0,2}[a-z0-9]{6,}$/i.test(s) && /\d/.test(s) && /[a-z]/i.test(s)) return true; // f8d33631b, r4kq9x2
    if (/[_-][a-z0-9]{5,}$/i.test(s) && /\d/.test(s)) return true; // btn_bff75a
    if (/^(css|sc|jsx|emotion)-/i.test(s)) return true; // CSS-in-JS class names
    return false;
  }
  function cssStr(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }

  function framePath() {
    var out = [];
    var w = window;
    try {
      while (w !== w.top) {
        var fe = w.frameElement;
        if (!fe) break;
        out.unshift(iframeSelector(fe));
        w = w.parent;
      }
    } catch (e) { /* cross-origin parent */ }
    return out;
  }
  function iframeSelector(fe) {
    if (fe.title) return 'iframe[title=' + cssStr(fe.title) + ']';
    if (fe.name && !looksRandom(fe.name)) return 'iframe[name=' + cssStr(fe.name) + ']';
    var src = fe.getAttribute('src');
    if (src) {
      var p = new URL(src, location.href).pathname.split('/').filter(Boolean).slice(-2).join('/');
      return "iframe[src*='" + p + "']";
    }
    return 'iframe';
  }

  var TEXTY = ['text', 'email', 'tel', 'url', 'search', 'number', 'password', ''];
  function isTextField(el) {
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TEXTY.indexOf((el.getAttribute('type') || '').toLowerCase()) >= 0;
  }
  function isField(el) { return isTextField(el) || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && /checkbox|radio/i.test(el.type)); }

  function role(el) {
    var r = el.getAttribute('role');
    if (r) return r.split(/\s+/)[0];
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (/^(button|submit|reset)$/.test(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (/^(text|email|tel|url|)$/.test(type)) return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'dialog') return 'dialog';
    return null;
  }
  function labelText(el) {
    var ids = el.getAttribute('aria-labelledby');
    if (ids) {
      var t = norm(ids.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ''; }).join(' '));
      if (t) return t;
    }
    if (el.getAttribute('aria-label')) return norm(el.getAttribute('aria-label'));
    if (el.id) {
      var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return norm(l.textContent);
    }
    var wrap = el.closest('label');
    if (wrap) return norm(wrap.textContent);
    return '';
  }
  function name(el) {
    var lbl = labelText(el);
    if (lbl) return lbl;
    var r = role(el);
    if (r === 'button' || r === 'link' || r === 'menuitem' || r === 'tab' || r === 'option' || r === 'heading') {
      var t = norm(el.innerText || el.textContent);
      if (t) return t;
      if (el.tagName === 'INPUT' && el.value) return el.value;
    }
    if (el.getAttribute('title')) return norm(el.getAttribute('title'));
    if (el.getAttribute('placeholder')) return norm(el.getAttribute('placeholder'));
    return '';
  }

  var CANDIDATES = 'button,a,input,select,textarea,[role],h1,h2,h3,h4,h5,h6,label,dialog';
  function within(scopeEl) { return scopeEl ? Array.prototype.slice.call(scopeEl.querySelectorAll(CANDIDATES)) : []; }
  // Mirrors Playwright's default matching: case-insensitive substring, or exact when asked.
  function matches(actual, wanted, exact) {
    if (exact) return actual === wanted;
    return actual.toLowerCase().indexOf(wanted.toLowerCase()) >= 0;
  }
  function countRole(scopeEl, r, n, exact) {
    return within(scopeEl).filter(function (e) { return visible(e) && role(e) === r && matches(name(e), n, exact); }).length;
  }
  function countLabel(scopeEl, l, exact) {
    return within(scopeEl).filter(function (e) { return visible(e) && isField(e) && matches(labelText(e), l, exact); }).length;
  }
  function countText(scopeEl, t, exact) {
    return within(scopeEl).filter(function (e) { return visible(e) && !isField(e) && matches(norm(e.innerText || e.textContent), t, exact); }).length;
  }

  // CSS path from `el` up to (not including) `scopeEl`, unique within the scope.
  function stableCss(el, scopeEl) {
    var root = scopeEl || document;
    var parts = [];
    var cur = el;
    for (var depth = 0; cur && cur.nodeType === 1 && cur !== scopeEl && depth < 4; depth++) {
      var tag = cur.tagName.toLowerCase();
      var sel = tag;
      if (cur.id && !looksRandom(cur.id)) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      var tid = cur.getAttribute('data-testid');
      if (tid) sel += '[data-testid=' + cssStr(tid) + ']';
      else {
        ['name', 'type', 'aria-label', 'placeholder', 'autocomplete'].forEach(function (a) {
          var v = cur.getAttribute(a);
          if (v && !looksRandom(v) && v.length < 40) sel += '[' + a + '=' + cssStr(v) + ']';
        });
      }
      parts.unshift(sel);
      var full = parts.join(' > ');
      if (root.querySelectorAll(full).length === 1) return full;
      // Disambiguate this level by position among siblings of the same tag.
      if (cur.parentElement) {
        var same = Array.prototype.filter.call(cur.parentElement.children, function (c) { return c.tagName === cur.tagName; });
        if (same.length > 1) parts[0] = sel + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        if (root.querySelectorAll(parts.join(' > ')).length === 1) return parts.join(' > ');
      }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  var EMAILISH = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
  function rowScope(el) {
    var row = el.closest('tr,li,[role=row],[role=listitem]');
    if (!row) return null;
    var key = (norm(row.innerText || row.textContent).match(EMAILISH) || [])[0];
    if (!key) {
      var cell = row.querySelector('td,th,[role=cell]');
      key = cell ? norm(cell.textContent) : '';
    }
    if (!key) return null;
    var r = role(row) || (row.tagName === 'TR' ? 'row' : 'listitem');
    return { el: row, target: { role: { role: r }, css: row.tagName.toLowerCase(), hasExactText: key } };
  }
  function dialogScope(el) {
    var d = el.closest('[role=dialog],[role=alertdialog],dialog');
    if (!d) return null;
    var n = name(d);
    var r = role(d) || 'dialog';
    return { el: d, target: n ? { role: { role: r, name: n.slice(0, 40) } } : { role: { role: r } } };
  }

  /** Build every strategy we can for this element, made unique where possible. */
  function targetFor(el) {
    var t = {};
    var scope = null;
    var r = role(el);
    var n = name(el);
    var root = document;
    function rescope(s) { scope = s; root = s.el; }

    if (r && n) {
      var rn = { role: r, name: n.slice(0, 80) };
      if (countRole(root, r, rn.name, false) > 1) {
        if (countRole(root, r, rn.name, true) === 1) rn.exact = true;
        else {
          var s = dialogScope(el) || rowScope(el);
          if (s) {
            rescope(s);
            if (countRole(root, r, rn.name, false) > 1) rn.exact = true;
          }
        }
      }
      t.role = rn;
    }
    var lbl = isField(el) ? labelText(el) : '';
    if (lbl) {
      t.label = lbl;
      if (countLabel(root, lbl, false) > 1) t.exact = true;
    }
    if (el.getAttribute('placeholder')) t.placeholder = el.getAttribute('placeholder');
    if (!isField(el)) {
      var txt = norm(el.innerText || el.textContent);
      if (txt && txt.length <= 60 && countText(root, txt, false) === 1) t.text = txt;
    }
    if (el.getAttribute('data-testid')) t.testId = el.getAttribute('data-testid');
    t.css = stableCss(el, scope ? scope.el : null);
    if (scope) t.within = scope.target;
    return t;
  }

  // ---------- secrets ----------
  function secretKind(el) {
    if (!isTextField(el)) return null;
    var type = (el.getAttribute('type') || '').toLowerCase();
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    var hint = (labelText(el) + ' ' + (el.getAttribute('name') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();
    if (type === 'password') {
      if (ac === 'new-password') return 'newPassword';
      var form = el.form || document;
      var pws = Array.prototype.slice.call(form.querySelectorAll('input[type=password]'));
      if (pws.length > 1 && pws.indexOf(el) > 0) return 'newPassword';
      return 'password';
    }
    if (ac === 'one-time-code' || /\b(otp|2fa|verification|authentication) ?code\b|\bdigit \d\b/.test(hint)) return 'totp';
    if (ac === 'username') return 'username';
    // The first text/email field of a form that also has a password field is the username.
    var f = el.form || el.closest('form') || document;
    var pw = f.querySelector('input[type=password]');
    if (pw && (type === 'email' || type === 'text' || type === '')) {
      var firstText = f.querySelector('input[type=email], input[type=text], input:not([type])');
      if (firstText === el) return 'username';
    }
    return null;
  }
  function isOtpBox(el) {
    return isTextField(el) && (el.getAttribute('maxlength') === '1' || /^digit \d$/i.test(labelText(el)) || el.hasAttribute('data-otp'));
  }

  // ---------- listeners ----------
  var ACTIONABLE = 'button,a[href],[role=button],[role=link],[role=menuitem],[role=tab],[role=option],input[type=submit],input[type=button],summary';
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest(ACTIONABLE) : null;
    if (!el || !ev.isTrusted) return;
    send({ type: 'click', target: targetFor(el) });
  }, true);

  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (!el || !isTextField(el)) return;
    if (isOtpBox(el)) {
      send({ type: 'otp', target: targetFor(el), box: el.getAttribute('aria-label') || '' });
      return;
    }
    var secret = secretKind(el);
    send({ type: 'fill', target: targetFor(el), secret: secret, value: secret ? null : el.value, fieldName: labelText(el) || el.getAttribute('placeholder') || el.getAttribute('name') || '' });
  }, true);

  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (!el) return;
    if (el.tagName === 'SELECT') {
      var opt = el.options[el.selectedIndex];
      send({ type: 'select', target: targetFor(el), value: opt ? norm(opt.textContent) : el.value, fieldName: labelText(el) });
    } else if (el.tagName === 'INPUT' && /checkbox|radio/i.test(el.type) && el.checked) {
      send({ type: 'check', target: targetFor(el), fieldName: labelText(el) });
    }
  }, true);

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target && isTextField(ev.target) && !secretKind(ev.target)) {
      send({ type: 'press', key: 'Enter', target: targetFor(ev.target) });
    }
  }, true);
})();
