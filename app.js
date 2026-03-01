/* ===== DoujinPOS - 同人イベント会計アプリ ===== */

(function () {
  'use strict';

  // ===== Default Firebase Config =====
  const DEFAULT_FIREBASE_CONFIG = {
    apiKey: "AIzaSyB-VDnHeMXSCR-Jxpv44RpEl_p8U5n2HL4",
    authDomain: "doujinpos.firebaseapp.com",
    projectId: "doujinpos",
    storageBucket: "doujinpos.firebasestorage.app",
    messagingSenderId: "434485410092",
    appId: "1:434485410092:web:dea8d0852296a180281489",
  };

  // ===== State =====
  const state = {
    events: [],
    products: [],     // グローバル商品マスター (eventId不要)
    sales: [],
    sets: [],         // グローバルセットマスター
    gifts: [],
    inventoryLogs: [], // 在庫変動ログ
    currentEventId: null,
    cart: [],
    memos: [],
    badges: [],
    settings: {
      darkMode: false,
      goal: 0,
      plan: 'free',
      proActivatedAt: null,
      saleSound: true,
      confetti: true,
      goalCelebration: true,
    },
    editingProductId: null,
    editingEventId: null,
    editingSetId: null,
    editingGiftId: null,
    selectedPaymentMethod: 'cash',
    giftPhotoData: null,
    productCoverImageData: null,
    auth: {
      user: null,
      userDoc: null,
      loading: true,
    },
  };

  const STORAGE_KEY = 'doujinpos_data';

  // ===== Persistence =====
  function save() {
    const data = {
      events: state.events,
      products: state.products,
      sales: state.sales,
      sets: state.sets,
      gifts: state.gifts,
      memos: state.memos,
      badges: state.badges,
      inventoryLogs: state.inventoryLogs,
      currentEventId: state.currentEventId,
      settings: state.settings,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    // UID-based sync (authenticated)
    if (state.auth.user) {
      pushAppData(state.auth.user.uid);
    }
  }

  function load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      state.events = data.events || [];
      state.products = data.products || [];
      state.sales = data.sales || [];
      state.sets = data.sets || [];
      state.gifts = data.gifts || [];
      state.memos = data.memos || [];
      state.badges = data.badges || [];
      state.inventoryLogs = data.inventoryLogs || [];
      state.currentEventId = data.currentEventId || null;
      if (data.settings) Object.assign(state.settings, data.settings);
      // Migration: 演出設定がない場合はデフォルトで有効化
      if (state.settings.saleSound === undefined) state.settings.saleSound = true;
      if (state.settings.confetti === undefined) state.settings.confetti = true;
      if (state.settings.goalCelebration === undefined) state.settings.goalCelebration = true;
      // Migration: イベントにvisitorCountがない場合は0で初期化
      state.events.forEach(ev => {
        if (ev.visitorCount === undefined) ev.visitorCount = 0;
      });

      // Migration: 旧データからeventId依存の商品をグローバルに移行
      state.products.forEach(p => {
        if (p.eventId) {
          delete p.eventId;
        }
        // 原価フィールドがない場合は0で初期化
        if (p.cost === undefined) p.cost = 0;
      });
      // Migration: セットもグローバルに
      state.sets.forEach(s => {
        if (s.eventId) {
          delete s.eventId;
        }
      });
      // Migration: イベントにeventProductsがない場合は旧データから推測
      state.events.forEach(ev => {
        if (!ev.eventProducts) {
          // 旧データ: そのイベントの売上から使われた商品を推測
          ev.eventProducts = [];
        }
        // Migration: statusフィールドがない場合はpreparingで初期化
        if (!ev.status) ev.status = 'preparing';
      });
      // Migration: plan設定がない場合はfreeで初期化
      if (!state.settings.plan) state.settings.plan = 'free';
      if (state.settings.proActivatedAt === undefined) state.settings.proActivatedAt = null;
      // Migration: 商品にtagsフィールドがない場合は空配列で初期化
      state.products.forEach(p => {
        if (!p.tags) p.tags = [];
      });
    } catch (e) {
      console.error('Failed to load data:', e);
    }
  }

  // ===== Utilities =====
  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  function formatYen(n) {
    return '¥' + Number(n).toLocaleString();
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function formatDate(str) {
    if (!str) return '';
    const d = new Date(str);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  // ===== Toast =====
  let toastTimer;
  function showToast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  // ===== Sound =====
  function playSound(type) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.value = 0.12;

      if (type === 'sale') {
        osc.frequency.value = 800;
        osc.type = 'sine';
        osc.start();
        osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 0.1);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
        osc.stop(ctx.currentTime + 0.2);
      } else if (type === 'add') {
        osc.frequency.value = 600;
        osc.type = 'sine';
        osc.start();
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);
        osc.stop(ctx.currentTime + 0.08);
      } else if (type === 'error') {
        osc.frequency.value = 300;
        osc.type = 'square';
        osc.start();
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
        osc.stop(ctx.currentTime + 0.3);
      }
    } catch (e) { /* Audio not available */ }
  }

  // ===== Navigation =====
  function switchView(viewName) {
    if (viewName === 'analysis' && !isPro()) {
      showUpgradeModal('分析機能はProプラン限定です');
      return;
    }

    $$('.view').forEach(v => v.classList.remove('active'));
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    $(`#view-${viewName}`).classList.add('active');
    $(`.nav-item[data-view="${viewName}"]`).classList.add('active');

    const titles = {
      home: 'イベント',
      products: '商品マスター',
      register: 'レジ',
      sales: '売上管理',
      gifts: '差し入れメモ',
      analysis: '分析',
      settings: '設定',
    };
    $('#page-title').textContent = titles[viewName] || 'DoujinPOS';

    if (viewName === 'register') renderRegister();
    if (viewName === 'sales') renderSales();
    if (viewName === 'products') renderProducts();
    if (viewName === 'home') renderEvents();
    if (viewName === 'gifts') renderGifts();
    if (viewName === 'analysis') renderAnalysis();
  }

  // ===== Modal =====
  function openModal(id) {
    $(`#${id}`).classList.add('active');
  }

  function closeModal(id) {
    $(`#${id}`).classList.remove('active');
  }

  function closeAllModals() {
    $$('.modal').forEach(m => m.classList.remove('active'));
  }

  // ===== Current Event Helpers =====
  function currentEvent() {
    return state.events.find(e => e.id === state.currentEventId);
  }

  // イベントに紐づく商品を取得（eventProductsから）
  function eventProducts() {
    const ev = currentEvent();
    if (!ev || !ev.eventProducts) return [];
    return ev.eventProducts.map(ep => {
      const product = state.products.find(p => p.id === ep.productId);
      if (!product) return null;
      return { ...product, initialStock: ep.initialStock };
    }).filter(Boolean);
  }

  function eventSales() {
    return state.sales.filter(s => s.eventId === state.currentEventId && !s.voided);
  }

  function eventSets() {
    // セットはグローバルだが、含まれる商品がすべてイベントに持ち込まれている場合のみ表示
    const ev = currentEvent();
    if (!ev || !ev.eventProducts) return [];
    const eventProdIds = new Set(ev.eventProducts.map(ep => ep.productId));
    return state.sets.filter(s => {
      return s.items.every(si => eventProdIds.has(si.productId));
    });
  }

  // ===== Events =====
  const statusLabels = { preparing: '準備中', active: '開催中', ended: '終了' };
  const statusColors = { preparing: '#E65100', active: '#2E7D32', ended: '#546E7F' };

  function renderEvents() {
    const container = $('#event-list');

    // Auto-select active event
    const activeEvent = state.events.find(e => e.status === 'active');
    if (activeEvent && state.currentEventId !== activeEvent.id) {
      const currentSelected = state.events.find(e => e.id === state.currentEventId);
      if (!currentSelected || currentSelected.status !== 'active') {
        state.currentEventId = activeEvent.id;
        save();
      }
    }

    // Update header event selector
    renderHeaderEventSelector();

    if (state.events.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📅</span>
          <p>イベントがありません</p>
          <p class="text-muted">「新規イベント」ボタンで追加しましょう</p>
        </div>`;
      return;
    }

    container.innerHTML = state.events.map(ev => {
      const sales = state.sales.filter(s => s.eventId === ev.id && !s.voided);
      const total = sales.reduce((sum, s) => sum + s.total, 0);
      const prods = (ev.eventProducts || []).length;
      const isSelected = ev.id === state.currentEventId;
      const status = ev.status || 'preparing';
      return `
        <div class="card event-card ${isSelected ? 'selected' : ''}" data-id="${ev.id}">
          <div class="card-header">
            <div>
              <div class="event-card-header-row">
                <div class="card-title">${esc(ev.name)}</div>
                <span class="event-status-badge ${status}">${statusLabels[status]}</span>
              </div>
              <div class="card-subtitle">${esc(ev.location || '')}</div>
            </div>
            <div class="card-actions">
              <span class="event-date-badge">${formatDate(ev.date)}</span>
            </div>
          </div>
          <div class="product-meta">
            <span>持込商品: <strong>${prods}</strong></span>
            <span>売上: <strong>${formatYen(total)}</strong></span>
            <span>取引: <strong>${sales.length}</strong></span>
          </div>
          <div class="card-actions" style="margin-top:8px;justify-content:flex-end;flex-wrap:wrap;">
            <select class="btn btn-outline btn-sm btn-status-change" data-id="${ev.id}" style="padding:5px 8px;font-size:12px;cursor:pointer;">
              <option value="preparing" ${status === 'preparing' ? 'selected' : ''}>準備中</option>
              <option value="active" ${status === 'active' ? 'selected' : ''}>開催中</option>
              <option value="ended" ${status === 'ended' ? 'selected' : ''}>終了</option>
            </select>
            ${isSelected ? `<button class="btn btn-outline btn-sm btn-oshinagaki" data-id="${ev.id}">お品書き</button>` : ''}
            <button class="btn btn-outline btn-sm btn-copy-event" data-id="${ev.id}">コピー</button>
            <button class="btn btn-outline btn-sm btn-edit-event" data-id="${ev.id}">編集</button>
            <button class="btn btn-danger btn-sm btn-delete-event" data-id="${ev.id}">削除</button>
          </div>
        </div>`;
    }).join('');

    // Update add event button state
    const addEventBtn = $('#btn-add-event');
    if (!isPro() && state.events.length >= 3) {
      addEventBtn.disabled = true;
      addEventBtn.textContent = '上限到達（Pro: 無制限）';
    } else {
      addEventBtn.disabled = false;
      addEventBtn.textContent = '+ 新規イベント';
    }

    // Click to select event
    container.querySelectorAll('.event-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn') || e.target.closest('select')) return;
        state.currentEventId = card.dataset.id;
        save();
        renderEvents();
        showToast(`${currentEvent().name} を選択しました`);
      });
    });

    // Status change
    container.querySelectorAll('.btn-status-change').forEach(sel => {
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        const ev = state.events.find(x => x.id === sel.dataset.id);
        if (!ev) return;
        ev.status = sel.value;
        save();
        renderEvents();
        showToast(`${ev.name} を「${statusLabels[ev.status]}」に変更しました`);
      });
      sel.addEventListener('click', (e) => e.stopPropagation());
    });

    container.querySelectorAll('.btn-edit-event').forEach(btn => {
      btn.addEventListener('click', () => {
        const ev = state.events.find(e => e.id === btn.dataset.id);
        if (!ev) return;
        state.editingEventId = ev.id;
        $('#modal-event-title').textContent = 'イベント編集';
        $('#event-name').value = ev.name;
        $('#event-date').value = ev.date;
        $('#event-location').value = ev.location || '';
        $('#event-template-group').style.display = 'none';
        renderEventProductChecklist(ev);
        openModal('modal-event');
      });
    });

    // Copy event
    container.querySelectorAll('.btn-copy-event').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!isPro() && state.events.length >= 3) {
          showUpgradeModal('イベントは3件までです（Proプランで無制限）');
          return;
        }
        copyEvent(btn.dataset.id);
      });
    });

    container.querySelectorAll('.btn-delete-event').forEach(btn => {
      btn.addEventListener('click', () => {
        const ev = state.events.find(e => e.id === btn.dataset.id);
        if (!ev) return;
        showConfirm(
          'イベント削除',
          `「${ev.name}」を削除しますか？関連する売上データもすべて削除されます。`,
          () => {
            state.sales = state.sales.filter(s => s.eventId !== ev.id);
            state.gifts = state.gifts.filter(g => g.eventId !== ev.id);
            state.events = state.events.filter(e => e.id !== ev.id);
            if (state.currentEventId === ev.id) state.currentEventId = null;
            save();
            renderEvents();
            showToast('イベントを削除しました');
          }
        );
      });
    });

    container.querySelectorAll('.btn-oshinagaki').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!requirePro('お品書き画像生成はProプラン限定です')) return;
        openOshinagakiModal();
      });
    });

    // Update calendar if visible
    const calendarEl = $('#event-calendar');
    if (calendarEl && calendarEl.style.display !== 'none') {
      renderCalendar();
    }
  }

  // ===== Event Copy =====
  function copyEvent(eventId) {
    const source = state.events.find(e => e.id === eventId);
    if (!source) return;
    const newEvent = {
      id: genId(),
      name: source.name + ' (コピー)',
      date: '',
      location: source.location || '',
      status: 'preparing',
      eventProducts: (source.eventProducts || []).map(ep => ({ ...ep })),
    };
    state.events.push(newEvent);
    state.currentEventId = newEvent.id;
    save();
    renderEvents();
    showToast(`「${source.name}」をコピーしました`);
  }

  // ===== Header Event Selector =====
  function renderHeaderEventSelector() {
    const selector = $('#header-event-selector');
    if (!selector) return;

    if (state.events.length === 0) {
      selector.style.display = 'none';
      return;
    }
    selector.style.display = 'block';

    const ev = currentEvent();
    $('#header-event-name').textContent = ev ? ev.name : '未選択';

    const dropdown = $('#header-event-dropdown');
    dropdown.innerHTML = state.events.map(e => {
      const status = e.status || 'preparing';
      const dotColor = statusColors[status] || '#888';
      return `
        <div class="header-event-dropdown-item ${e.id === state.currentEventId ? 'selected' : ''}" data-id="${e.id}">
          <span class="event-status-dot" style="background:${dotColor}"></span>
          <span>${esc(e.name)}</span>
        </div>`;
    }).join('');

    dropdown.querySelectorAll('.header-event-dropdown-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        state.currentEventId = item.dataset.id;
        save();
        dropdown.classList.remove('open');
        renderEvents();
        const selected = currentEvent();
        if (selected) showToast(`${selected.name} を選択しました`);
      });
    });
  }

  // ===== Calendar View =====
  let calendarMonth = new Date().getMonth();
  let calendarYear = new Date().getFullYear();

  function renderCalendar() {
    const label = $('#cal-month-label');
    if (!label) return;
    label.textContent = `${calendarYear}年${calendarMonth + 1}月`;

    const container = $('#cal-days');
    const firstDay = new Date(calendarYear, calendarMonth, 1);
    const lastDay = new Date(calendarYear, calendarMonth + 1, 0);
    const startDow = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Build map of events by date
    const eventsByDate = {};
    state.events.forEach(ev => {
      if (!ev.date) return;
      const d = ev.date;
      if (!eventsByDate[d]) eventsByDate[d] = [];
      eventsByDate[d].push(ev);
    });

    let html = '';

    // Previous month padding
    const prevMonthLast = new Date(calendarYear, calendarMonth, 0).getDate();
    for (let i = startDow - 1; i >= 0; i--) {
      html += `<div class="cal-day other-month"><span class="cal-day-num">${prevMonthLast - i}</span></div>`;
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isToday = dateStr === todayStr;
      const dayEvents = eventsByDate[dateStr] || [];
      const hasEvent = dayEvents.length > 0;

      let dots = '';
      let eventNames = '';
      if (hasEvent) {
        dots = `<div class="cal-event-dots">` +
          dayEvents.map(ev => {
            const c = statusColors[ev.status || 'preparing'] || '#6C5CE7';
            return `<span class="cal-event-dot" style="background:${c}"></span>`;
          }).join('') + `</div>`;
        eventNames = dayEvents.map(ev => `<div class="cal-event-name">${esc(ev.name)}</div>`).join('');
      }

      html += `
        <div class="cal-day ${isToday ? 'today' : ''} ${hasEvent ? 'has-event' : ''}" data-date="${dateStr}">
          <span class="cal-day-num">${d}</span>
          ${dots}
          ${eventNames}
        </div>`;
    }

    // Next month padding
    const endDow = lastDay.getDay();
    for (let i = 1; i <= 6 - endDow; i++) {
      html += `<div class="cal-day other-month"><span class="cal-day-num">${i}</span></div>`;
    }

    container.innerHTML = html;

    // Click on days with events
    container.querySelectorAll('.cal-day.has-event').forEach(day => {
      day.addEventListener('click', () => {
        const dateStr = day.dataset.date;
        const dayEvts = eventsByDate[dateStr];
        if (dayEvts && dayEvts.length > 0) {
          state.currentEventId = dayEvts[0].id;
          save();
          renderEvents();
          showToast(`${dayEvts[0].name} を選択しました`);
        }
      });
    });
  }

  // ===== Event Template =====
  function populateEventTemplateSelect() {
    const select = $('#event-template-select');
    if (!select) return;
    select.innerHTML = '<option value="">新規作成（引き継ぎなし）</option>';
    state.events.forEach(ev => {
      select.innerHTML += `<option value="${ev.id}">${esc(ev.name)}</option>`;
    });
  }

  function applyEventTemplate(eventId) {
    const source = state.events.find(e => e.id === eventId);
    if (!source) return;
    renderEventProductChecklist(source);
  }

  function renderEventProductChecklist(ev) {
    const checklist = $('#event-product-checklist');
    if (state.products.length === 0) {
      checklist.innerHTML = '<p class="text-muted" style="font-size:13px;">商品マスターに商品を登録してください</p>';
      return;
    }

    const existing = ev ? (ev.eventProducts || []) : [];
    checklist.innerHTML = state.products.map(p => {
      const ep = existing.find(x => x.productId === p.id);
      return `
        <div class="set-check-item">
          <input type="checkbox" id="ev-chk-${p.id}" data-id="${p.id}" ${ep ? 'checked' : ''}>
          <label for="ev-chk-${p.id}">${esc(p.name)} (${formatYen(p.price)})</label>
          <input type="number" class="ev-check-stock" data-id="${p.id}" value="${ep ? ep.initialStock : 30}" min="0" placeholder="持込数">
        </div>`;
    }).join('');
  }

  function saveEvent() {
    const name = $('#event-name').value.trim();
    const date = $('#event-date').value;
    const location = $('#event-location').value.trim();
    if (!name) { showToast('イベント名を入力してください'); return; }

    // 持ち込み商品を収集
    const eventProds = [];
    $$('#event-product-checklist input[type="checkbox"]:checked').forEach(chk => {
      const stock = parseInt($(`.ev-check-stock[data-id="${chk.dataset.id}"]`).value) || 0;
      eventProds.push({ productId: chk.dataset.id, initialStock: stock });
    });

    if (state.editingEventId) {
      const ev = state.events.find(e => e.id === state.editingEventId);
      if (ev) {
        ev.name = name;
        ev.date = date;
        ev.location = location;
        ev.eventProducts = eventProds;
      }
      state.editingEventId = null;
    } else {
      const ev = { id: genId(), name, date, location, status: 'preparing', eventProducts: eventProds };
      state.events.push(ev);
      state.currentEventId = ev.id;
    }
    save();
    closeModal('modal-event');
    renderEvents();
    showToast('イベントを保存しました');
  }

  // ===== Products (グローバル商品マスター) =====
  function renderProducts() {
    const container = $('#product-list');

    if (state.products.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📦</span>
          <p>商品がありません</p>
          <p class="text-muted">「商品追加」ボタンで追加しましょう</p>
        </div>`;
      renderSets();
      return;
    }

    container.innerHTML = state.products.map(p => {
      const catLabels = { doujinshi: '同人誌', goods: 'グッズ', cd: 'CD/音楽', other: 'その他' };
      const tagChips = (p.tags || []).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('');
      return `
        <div class="card">
          <div class="product-card">
            <div class="product-color-tag" style="background:${p.color || '#6C5CE7'}"></div>
            <div class="product-info">
              <div class="card-title">${esc(p.name)}</div>
              <div class="product-meta">
                <span>${formatYen(p.price)}</span>
                <span>原価 ${formatYen(p.cost || 0)}</span>
                <span>${catLabels[p.category] || p.category}</span>
              </div>
              ${tagChips ? `<div class="tag-chips">${tagChips}</div>` : ''}
            </div>
            <div class="card-actions">
              <button class="btn btn-outline btn-sm btn-edit-product" data-id="${p.id}">編集</button>
              <button class="btn btn-danger btn-sm btn-delete-product" data-id="${p.id}">削除</button>
            </div>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.btn-edit-product').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = state.products.find(x => x.id === btn.dataset.id);
        if (!p) return;
        state.editingProductId = p.id;
        state.productCoverImageData = p.coverImage || null;
        $('#modal-product-title').textContent = '商品編集';
        $('#product-name').value = p.name;
        $('#product-price').value = p.price;
        $('#product-cost').value = p.cost || 0;
        $('#product-category').value = p.category;
        $('#product-tags').value = (p.tags || []).join(', ');
        $$('.color-opt').forEach(c => c.classList.toggle('selected', c.dataset.color === p.color));
        // Restore cover image preview
        if (state.productCoverImageData) {
          $('#product-cover-preview').src = state.productCoverImageData;
          $('#product-cover-preview').style.display = 'block';
          $('#product-cover-placeholder').style.display = 'none';
          $('#product-cover-remove').style.display = 'flex';
        } else {
          $('#product-cover-preview').style.display = 'none';
          $('#product-cover-placeholder').style.display = 'block';
          $('#product-cover-remove').style.display = 'none';
        }
        openModal('modal-product');
      });
    });

    container.querySelectorAll('.btn-delete-product').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = state.products.find(x => x.id === btn.dataset.id);
        if (!p) return;
        showConfirm('商品削除', `「${p.name}」を削除しますか？`, () => {
          state.products = state.products.filter(x => x.id !== p.id);
          // イベントの持ち込みリストからも削除
          state.events.forEach(ev => {
            if (ev.eventProducts) {
              ev.eventProducts = ev.eventProducts.filter(ep => ep.productId !== p.id);
            }
          });
          save();
          renderProducts();
          showToast('商品を削除しました');
        });
      });
    });

    // Render sets
    renderSets();
  }

  // ===== Sets (グローバル) =====
  function renderSets() {
    const container = $('#set-list');

    if (state.sets.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:20px;">
          <span class="empty-icon" style="font-size:32px;">🎁</span>
          <p style="font-size:13px;">セット販売を設定すると、レジにセットボタンが表示されます</p>
        </div>`;
      return;
    }

    container.innerHTML = state.sets.map(s => {
      const itemNames = s.items.map(si => {
        const p = state.products.find(x => x.id === si.productId);
        return p ? `${p.name}×${si.quantity}` : '(削除済み)';
      }).join(', ');
      const originalPrice = s.items.reduce((sum, si) => {
        const p = state.products.find(x => x.id === si.productId);
        return sum + (p ? p.price * si.quantity : 0);
      }, 0);
      const discount = originalPrice - s.price;
      return `
        <div class="card">
          <div class="product-card">
            <div class="product-color-tag" style="background:${s.color || '#E17055'}"></div>
            <div class="product-info">
              <div class="card-title">${esc(s.name)}</div>
              <div class="product-meta">
                <span>${formatYen(s.price)}</span>
                ${discount > 0 ? `<span style="color:var(--danger);">(-${formatYen(discount)} OFF)</span>` : ''}
              </div>
              <div class="set-card-items">${esc(itemNames)}</div>
            </div>
            <div class="card-actions">
              <button class="btn btn-outline btn-sm btn-edit-set" data-id="${s.id}">編集</button>
              <button class="btn btn-danger btn-sm btn-delete-set" data-id="${s.id}">削除</button>
            </div>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.btn-edit-set').forEach(btn => {
      btn.addEventListener('click', () => openSetModal(btn.dataset.id));
    });

    container.querySelectorAll('.btn-delete-set').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = state.sets.find(x => x.id === btn.dataset.id);
        if (!s) return;
        showConfirm('セット削除', `「${s.name}」を削除しますか？`, () => {
          state.sets = state.sets.filter(x => x.id !== s.id);
          save();
          renderProducts();
          showToast('セットを削除しました');
        });
      });
    });
  }

  function openSetModal(editId) {
    if (state.products.length === 0) { showToast('先に商品を登録してください'); return; }

    const editing = editId ? state.sets.find(s => s.id === editId) : null;
    state.editingSetId = editing ? editing.id : null;
    $('#modal-set-title').textContent = editing ? 'セット編集' : 'セット追加';
    $('#set-name').value = editing ? editing.name : '';
    $('#set-price').value = editing ? editing.price : '';

    // Build checklist from all products
    const checklist = $('#set-product-checklist');
    checklist.innerHTML = state.products.map(p => {
      const inSet = editing ? editing.items.find(i => i.productId === p.id) : null;
      return `
        <div class="set-check-item">
          <input type="checkbox" id="set-chk-${p.id}" data-id="${p.id}" ${inSet ? 'checked' : ''}>
          <label for="set-chk-${p.id}">${esc(p.name)} (${formatYen(p.price)})</label>
          <input type="number" class="set-check-qty" data-id="${p.id}" value="${inSet ? inSet.quantity : 1}" min="1" max="99">
        </div>`;
    }).join('');

    // Color picker
    const currentColor = editing ? editing.color : '#E17055';
    $$('.color-opt-set').forEach(c => c.classList.toggle('selected', c.dataset.color === currentColor));

    openModal('modal-set');
  }

  function saveSet() {
    const name = $('#set-name').value.trim();
    const price = parseInt($('#set-price').value) || 0;
    if (!name) { showToast('セット名を入力してください'); return; }
    if (price <= 0) { showToast('セット価格を入力してください'); return; }

    const items = [];
    $$('#set-product-checklist input[type="checkbox"]:checked').forEach(chk => {
      const qty = parseInt($(`.set-check-qty[data-id="${chk.dataset.id}"]`).value) || 1;
      items.push({ productId: chk.dataset.id, quantity: qty });
    });
    if (items.length === 0) { showToast('商品を1つ以上選択してください'); return; }

    const color = $('.color-opt-set.selected')?.dataset.color || '#E17055';

    if (state.editingSetId) {
      const s = state.sets.find(x => x.id === state.editingSetId);
      if (s) { s.name = name; s.price = price; s.items = items; s.color = color; }
      state.editingSetId = null;
    } else {
      state.sets.push({
        id: genId(),
        name, price, items, color,
      });
    }

    save();
    closeModal('modal-set');
    renderProducts();
    showToast('セットを保存しました');
  }

  function getSoldCount(productId) {
    return eventSales().reduce((sum, s) => {
      let count = 0;
      s.items.forEach(i => {
        if (i.isSet && i.items) {
          const si = i.items.find(x => x.productId === productId);
          if (si) count += si.quantity * i.quantity;
        } else if (i.productId === productId) {
          count += i.quantity;
        }
      });
      return sum + count;
    }, 0);
  }

  // ===== 在庫管理ヘルパー =====
  // 手動調整量を取得（イベント+商品単位）
  function getManualAdjustment(productId) {
    if (!state.currentEventId) return 0;
    return state.inventoryLogs
      .filter(log => log.eventId === state.currentEventId && log.productId === productId && log.type === 'adjustment')
      .reduce((sum, log) => sum + log.delta, 0);
  }

  // 実際の残り在庫を算出
  function getRemainingStock(productId, initialStock) {
    const sold = getSoldCount(productId);
    const adjustment = getManualAdjustment(productId);
    return initialStock + adjustment - sold;
  }

  // 在庫変動ログを記録
  function addInventoryLog(productId, type, delta, reason) {
    state.inventoryLogs.push({
      id: genId(),
      eventId: state.currentEventId,
      productId: productId,
      type: type, // 'sale', 'adjustment'
      delta: delta,
      reason: reason || '',
      timestamp: Date.now(),
    });
  }

  // 在庫回転率（時間あたり販売ペース）から残り予測時間を算出
  function getEstimatedTimeRemaining(productId, remaining) {
    if (remaining <= 0) return null;
    const sales = eventSales();
    if (sales.length === 0) return null;

    // この商品の販売タイムスタンプを収集
    const saleTimes = [];
    sales.forEach(s => {
      let count = 0;
      s.items.forEach(i => {
        if (i.isSet && i.items) {
          const si = i.items.find(x => x.productId === productId);
          if (si) count += si.quantity * i.quantity;
        } else if (i.productId === productId) {
          count += i.quantity;
        }
      });
      if (count > 0) saleTimes.push({ ts: s.timestamp, count });
    });

    if (saleTimes.length < 2) return null;

    saleTimes.sort((a, b) => a.ts - b.ts);
    const firstSale = saleTimes[0].ts;
    const lastSale = saleTimes[saleTimes.length - 1].ts;
    const totalSold = saleTimes.reduce((s, t) => s + t.count, 0);
    const elapsed = (lastSale - firstSale) / 60000; // 分

    if (elapsed <= 0 || totalSold <= 0) return null;

    const ratePerMin = totalSold / elapsed;
    const minutesRemaining = remaining / ratePerMin;

    if (minutesRemaining > 600) return null; // 10時間以上は表示しない

    if (minutesRemaining < 60) {
      return `約${Math.round(minutesRemaining)}分`;
    }
    const hours = Math.floor(minutesRemaining / 60);
    const mins = Math.round(minutesRemaining % 60);
    return `約${hours}時間${mins > 0 ? mins + '分' : ''}`;
  }

  // 在庫調整モーダルを開く
  function openInventoryAdjustModal(productId) {
    const product = state.products.find(p => p.id === productId);
    const ev = currentEvent();
    if (!product || !ev) return;

    const ep = ev.eventProducts.find(x => x.productId === productId);
    const initialStock = ep ? ep.initialStock : 0;
    const remaining = getRemainingStock(productId, initialStock);

    $('#inv-adjust-product-name').textContent = product.name;
    $('#inv-adjust-current-stock').textContent = remaining;
    $('#inv-adjust-quantity').value = '';
    $('#inv-adjust-reason').value = 'tanaoroshi';
    $('#inv-adjust-product-id').value = productId;

    openModal('modal-inventory-adjust');
    setTimeout(() => $('#inv-adjust-quantity').focus(), 300);
  }

  // 在庫調整を保存
  function saveInventoryAdjustment() {
    const productId = $('#inv-adjust-product-id').value;
    const quantity = parseInt($('#inv-adjust-quantity').value);
    const reason = $('#inv-adjust-reason').value;

    if (isNaN(quantity) || quantity === 0) {
      showToast('数量を入力してください');
      return;
    }

    const reasonLabels = {
      tanaoroshi: '棚卸し',
      hason: '破損',
      tsuika: '追加搬入',
      henpin: '返品',
      sonota: 'その他',
    };

    addInventoryLog(productId, 'adjustment', quantity, reasonLabels[reason] || reason);
    save();
    closeModal('modal-inventory-adjust');
    renderRegister();

    const product = state.products.find(p => p.id === productId);
    const label = quantity > 0 ? `+${quantity}` : `${quantity}`;
    showToast(`「${product.name}」の在庫を${label}しました（${reasonLabels[reason]}）`);
  }

  function saveProduct() {
    const name = $('#product-name').value.trim();
    const price = parseInt($('#product-price').value) || 0;
    const cost = parseInt($('#product-cost').value) || 0;
    const category = $('#product-category').value;
    const color = $('.color-opt.selected')?.dataset.color || '#6C5CE7';
    const tagsRaw = $('#product-tags').value.trim();
    const tags = isPro() ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    if (!name) { showToast('商品名を入力してください'); return; }
    if (price <= 0) { showToast('販売価格を正しく入力してください'); return; }

    if (state.editingProductId) {
      const p = state.products.find(x => x.id === state.editingProductId);
      if (p) {
        p.name = name;
        p.price = price;
        p.cost = cost;
        p.category = category;
        p.color = color;
        p.tags = tags;
        p.coverImage = state.productCoverImageData !== null ? state.productCoverImageData : (p.coverImage || null);
      }
      state.editingProductId = null;
    } else {
      state.products.push({
        id: genId(),
        name, price, cost, category, color, tags,
        coverImage: state.productCoverImageData || null,
      });
    }
    state.productCoverImageData = null;

    save();
    closeModal('modal-product');
    renderProducts();
    showToast('商品を保存しました');
  }

  // ===== Register =====
  function renderRegister() {
    renderRegisterProducts();
    renderCart();
    renderGoal();
    renderVisitorCounter();
  }

  function renderRegisterProducts() {
    const container = $('#register-products');
    const prods = eventProducts();

    if (!currentEvent() || prods.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;">
          <span class="empty-icon">📦</span>
          <p>${currentEvent() ? '持ち込み商品を設定してください' : 'イベントを選択してください'}</p>
        </div>`;
      renderInventorySummary();
      return;
    }

    container.innerHTML = prods.map(p => {
      const remaining = getRemainingStock(p.id, p.initialStock);
      const soldOut = remaining <= 0 && p.initialStock > 0;
      const lowStock = remaining <= 3 && remaining > 1 && p.initialStock > 0;
      const criticalStock = remaining === 1 && p.initialStock > 0;
      const estTime = p.initialStock > 0 ? getEstimatedTimeRemaining(p.id, remaining) : null;

      let stockBadgeClass = '';
      if (soldOut) stockBadgeClass = 'stock-soldout';
      else if (criticalStock) stockBadgeClass = 'stock-critical';
      else if (lowStock) stockBadgeClass = 'stock-low';

      return `
        <button class="register-product-btn ${soldOut ? 'sold-out sold-out-animate' : ''} ${stockBadgeClass}"
                data-id="${p.id}" style="background:${p.color || '#6C5CE7'}">
          ${soldOut ? '<div class="sold-out-badge">完売!</div>' : ''}
          ${criticalStock ? '<div class="stock-alert-badge critical">残1</div>' : ''}
          ${lowStock ? `<div class="stock-alert-badge low">残${remaining}</div>` : ''}
          <div class="product-btn-name">${esc(p.name)}</div>
          <div class="product-btn-price">${formatYen(p.price)}</div>
          <div class="product-btn-stock">${p.initialStock > 0 ? `残 ${remaining}` : ''}</div>
          ${estTime ? `<div class="product-btn-eta">${estTime}</div>` : ''}
          ${p.initialStock > 0 ? `<button class="inv-adjust-btn" data-id="${p.id}" title="在庫調整">&#9998;</button>` : ''}
        </button>`;
    }).join('');

    // Add set buttons
    const sets = eventSets();
    const setHtml = sets.map(s => `
      <button class="register-set-btn" data-set-id="${s.id}" style="background:linear-gradient(135deg,${s.color || '#E17055'},${s.color || '#E17055'}CC);">
        <div class="set-btn-label">SET</div>
        <div class="product-btn-name">${esc(s.name)}</div>
        <div class="product-btn-price">${formatYen(s.price)}</div>
      </button>
    `).join('');
    container.innerHTML = setHtml + container.innerHTML;

    container.querySelectorAll('.register-product-btn:not(.sold-out)').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.inv-adjust-btn')) return;
        addToCart(btn.dataset.id);
      });
    });

    container.querySelectorAll('.register-set-btn').forEach(btn => {
      btn.addEventListener('click', () => addSetToCart(btn.dataset.setId));
    });

    // 在庫調整ボタン
    container.querySelectorAll('.inv-adjust-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openInventoryAdjustModal(btn.dataset.id);
      });
    });

    renderInventorySummary();
  }

  // ===== 在庫サマリーバー =====
  function renderInventorySummary() {
    let summaryEl = document.getElementById('inventory-summary-bar');
    const ev = currentEvent();
    if (!ev || !ev.eventProducts || ev.eventProducts.length === 0) {
      if (summaryEl) summaryEl.style.display = 'none';
      return;
    }

    if (!summaryEl) {
      summaryEl = document.createElement('div');
      summaryEl.id = 'inventory-summary-bar';
      summaryEl.className = 'inventory-summary-bar';
      const registerTop = $('.register-top');
      if (registerTop) registerTop.parentNode.insertBefore(summaryEl, registerTop);
    }
    summaryEl.style.display = '';

    let totalStock = 0;
    let lowStockCount = 0;
    let soldOutCount = 0;

    ev.eventProducts.forEach(ep => {
      if (ep.initialStock <= 0) return;
      const remaining = getRemainingStock(ep.productId, ep.initialStock);
      totalStock += Math.max(0, remaining);
      if (remaining <= 0) soldOutCount++;
      else if (remaining <= 3) lowStockCount++;
    });

    summaryEl.innerHTML = `
      <div class="inv-summary-item">
        <span class="inv-summary-label">総在庫</span>
        <span class="inv-summary-value">${totalStock}</span>
      </div>
      <div class="inv-summary-item ${lowStockCount > 0 ? 'warning' : ''}">
        <span class="inv-summary-label">残少</span>
        <span class="inv-summary-value">${lowStockCount}</span>
      </div>
      <div class="inv-summary-item ${soldOutCount > 0 ? 'danger' : ''}">
        <span class="inv-summary-label">完売</span>
        <span class="inv-summary-value">${soldOutCount}</span>
      </div>`;
  }

  function addSetToCart(setId) {
    const set = state.sets.find(s => s.id === setId);
    if (!set) return;

    const ev = currentEvent();
    // Check stock for all items in the set
    for (const si of set.items) {
      const product = state.products.find(p => p.id === si.productId);
      if (!product) { showToast('セットに含まれる商品が見つかりません'); return; }
      const ep = ev.eventProducts.find(x => x.productId === si.productId);
      const stock = ep ? ep.initialStock : 0;
      const remaining = getRemainingStock(si.productId, stock);
      const inCart = state.cart.reduce((s, c) => s + (c.productId === si.productId ? c.quantity : 0), 0);
      if (stock > 0 && remaining - inCart - si.quantity < 0) {
        showToast(`「${product.name}」の在庫が不足しています`);
        playSound('error');
        return;
      }
    }

    // Add a special cart entry for the set
    state.cart.push({
      isSet: true,
      setId: set.id,
      name: set.name,
      price: set.price,
      quantity: 1,
      items: set.items.map(si => ({ productId: si.productId, quantity: si.quantity })),
    });
    playSound('add');
    renderCart();
  }

  function addToCart(productId) {
    const product = state.products.find(p => p.id === productId);
    if (!product) return;

    const ev = currentEvent();
    const ep = ev ? ev.eventProducts.find(x => x.productId === productId) : null;
    const stock = ep ? ep.initialStock : 0;

    const remaining = getRemainingStock(productId, stock);
    const inCart = getCartProductCount(productId);
    if (stock > 0 && remaining - inCart <= 0) {
      showToast('在庫がありません');
      playSound('error');
      return;
    }

    const existing = state.cart.find(c => c.productId === productId);
    if (existing) {
      existing.quantity++;
    } else {
      state.cart.push({ productId, quantity: 1, price: product.price, name: product.name });
    }
    playSound('add');
    renderCart();
  }

  function getCartProductCount(productId) {
    let count = 0;
    state.cart.forEach(c => {
      if (c.isSet) {
        const si = c.items.find(i => i.productId === productId);
        if (si) count += si.quantity * c.quantity;
      } else if (c.productId === productId) {
        count += c.quantity;
      }
    });
    return count;
  }

  function renderCart() {
    const container = $('#register-cart');
    if (state.cart.length === 0) {
      container.innerHTML = '<div class="cart-empty">商品をタップして追加</div>';
      $('#cart-total').textContent = '¥0';
      $('#btn-payment').disabled = true;
      return;
    }

    const total = state.cart.reduce((s, c) => s + c.price * c.quantity, 0);
    container.innerHTML = state.cart.map((c, idx) => `
      <div class="cart-item">
        <span class="cart-item-name">${c.isSet ? '🎁 ' : ''}${esc(c.name)}</span>
        <div class="cart-item-qty">
          <button class="cart-qty-btn" data-idx="${idx}" data-action="minus">-</button>
          <span>${c.quantity}</span>
          ${c.isSet ? '' : `<button class="cart-qty-btn" data-idx="${idx}" data-action="plus">+</button>`}
          <span style="min-width:60px;text-align:right;font-weight:700;">${formatYen(c.price * c.quantity)}</span>
        </div>
      </div>
    `).join('');

    $('#cart-total').textContent = formatYen(total);
    $('#btn-payment').disabled = false;

    container.querySelectorAll('.cart-qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const item = state.cart[idx];
        if (!item) return;
        if (btn.dataset.action === 'plus') {
          if (!item.isSet) {
            const product = state.products.find(p => p.id === item.productId);
            const ev = currentEvent();
            const ep = ev ? ev.eventProducts.find(x => x.productId === item.productId) : null;
            const stock = ep ? ep.initialStock : 0;
            const remaining = getRemainingStock(item.productId, stock);
            const inCart = getCartProductCount(item.productId);
            if (product && stock > 0 && remaining - inCart <= 0) {
              showToast('在庫がありません');
              return;
            }
          }
          item.quantity++;
        } else {
          item.quantity--;
          if (item.quantity <= 0) {
            state.cart.splice(idx, 1);
          }
        }
        renderCart();
      });
    });
  }

  function renderGoal() {
    const goal = state.settings.goal;
    const totalSales = eventSales().reduce((s, sale) => s + sale.total, 0);

    if (goal > 0) {
      const pct = Math.min(100, Math.round((totalSales / goal) * 100));
      $('#goal-fill').style.width = pct + '%';
      $('#goal-text').textContent = `目標: ${formatYen(totalSales)} / ${formatYen(goal)} (${pct}%)`;
    } else {
      $('#goal-fill').style.width = '0%';
      $('#goal-text').textContent = `売上: ${formatYen(totalSales)}　※設定で目標を設定できます`;
    }
  }

  // ===== Payment =====
  function openPayment() {
    const total = state.cart.reduce((s, c) => s + c.price * c.quantity, 0);
    if (total <= 0) return;

    state.selectedPaymentMethod = 'cash';
    $('#payment-total-amount').textContent = formatYen(total);
    $('#payment-received').value = '';
    $('#change-display').style.display = 'none';
    $('#btn-confirm-payment').disabled = true;
    $('#cash-payment-section').style.display = 'block';

    // Reset payment method buttons
    $$('.payment-method-btn').forEach(b => b.classList.remove('active'));
    $('.payment-method-btn[data-method="cash"]').classList.add('active');

    // Quick amount buttons
    const quickAmounts = generateQuickAmounts(total);
    $('#quick-amounts').innerHTML = quickAmounts.map(a =>
      `<button class="quick-amount-btn" data-amount="${a}">${formatYen(a)}</button>`
    ).join('') + `<button class="quick-amount-btn" data-amount="${total}">ぴったり</button>`;

    $$('.quick-amount-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('#payment-received').value = btn.dataset.amount;
        updateChange();
      });
    });

    openModal('modal-payment');
    setTimeout(() => $('#payment-received').focus(), 300);
  }

  function selectPaymentMethod(method) {
    state.selectedPaymentMethod = method;
    $$('.payment-method-btn').forEach(b => b.classList.remove('active'));
    $(`.payment-method-btn[data-method="${method}"]`).classList.add('active');

    if (method === 'cash') {
      $('#cash-payment-section').style.display = 'block';
      $('#btn-confirm-payment').disabled = true;
      updateChange();
    } else {
      // Electronic payment: no change needed
      $('#cash-payment-section').style.display = 'none';
      $('#btn-confirm-payment').disabled = false;
    }
  }

  function generateQuickAmounts(total) {
    const amounts = [];
    const bases = [500, 1000, 2000, 3000, 5000, 10000];
    for (const b of bases) {
      if (b >= total && amounts.length < 5) amounts.push(b);
    }
    if (amounts.length === 0) {
      const rounded = Math.ceil(total / 1000) * 1000;
      amounts.push(rounded);
      if (rounded + 1000 <= 50000) amounts.push(rounded + 1000);
    }
    return [...new Set(amounts)].slice(0, 5);
  }

  function updateChange() {
    const total = state.cart.reduce((s, c) => s + c.price * c.quantity, 0);
    const received = parseInt($('#payment-received').value) || 0;
    const change = received - total;

    if (received >= total) {
      $('#change-display').style.display = 'block';
      $('#change-amount').textContent = formatYen(change);
      $('#change-breakdown').textContent = change > 0 ? getChangeBreakdown(change) : '';
      $('#btn-confirm-payment').disabled = false;
    } else {
      $('#change-display').style.display = 'none';
      $('#btn-confirm-payment').disabled = true;
    }
  }

  function getChangeBreakdown(amount) {
    const denominations = [
      { value: 10000, label: '一万円' },
      { value: 5000, label: '五千円' },
      { value: 1000, label: '千円' },
      { value: 500, label: '500円' },
      { value: 100, label: '100円' },
      { value: 50, label: '50円' },
      { value: 10, label: '10円' },
      { value: 5, label: '5円' },
      { value: 1, label: '1円' },
    ];
    const parts = [];
    let remaining = amount;
    for (const d of denominations) {
      if (remaining >= d.value) {
        const count = Math.floor(remaining / d.value);
        parts.push(`${d.label}×${count}`);
        remaining -= d.value * count;
      }
    }
    return parts.join('　');
  }

  function confirmPayment() {
    const total = state.cart.reduce((s, c) => s + c.price * c.quantity, 0);
    const method = state.selectedPaymentMethod;
    const previousTotal = eventSales().reduce((s, sale) => s + sale.total, 0);

    if (method === 'cash') {
      const received = parseInt($('#payment-received').value) || 0;
      if (received < total) return;
      var saleReceived = received;
      var saleChange = received - total;
    } else {
      var saleReceived = total;
      var saleChange = 0;
    }

    // Flatten cart items (expand sets into individual product entries for stock tracking)
    const saleItems = [];
    state.cart.forEach(c => {
      if (c.isSet) {
        // Record as a set in sale items
        saleItems.push({
          isSet: true,
          setId: c.setId,
          name: c.name,
          quantity: c.quantity,
          price: c.price,
          items: c.items,
        });
      } else {
        saleItems.push({
          productId: c.productId,
          name: c.name,
          quantity: c.quantity,
          price: c.price,
        });
      }
    });

    const sale = {
      id: genId(),
      eventId: state.currentEventId,
      timestamp: Date.now(),
      items: saleItems,
      total,
      received: saleReceived,
      change: saleChange,
      paymentMethod: method,
      voided: false,
    };

    state.sales.push(sale);

    // 在庫変動ログを記録（販売）
    saleItems.forEach(item => {
      if (item.isSet && item.items) {
        item.items.forEach(si => {
          addInventoryLog(si.productId, 'sale', -si.quantity * item.quantity, '販売（セット）');
        });
      } else if (item.productId) {
        addInventoryLog(item.productId, 'sale', -item.quantity, '販売');
      }
    });

    // 完売チェック＆エフェクト
    const ev = currentEvent();
    if (ev && ev.eventProducts) {
      saleItems.forEach(item => {
        const productIds = [];
        if (item.isSet && item.items) {
          item.items.forEach(si => productIds.push(si.productId));
        } else if (item.productId) {
          productIds.push(item.productId);
        }
        productIds.forEach(pid => {
          const ep = ev.eventProducts.find(x => x.productId === pid);
          if (ep && ep.initialStock > 0) {
            const remaining = getRemainingStock(pid, ep.initialStock);
            if (remaining <= 0) {
              const product = state.products.find(p => p.id === pid);
              if (product) {
                setTimeout(() => showToast(`「${product.name}」が完売しました!`), 500);
              }
            }
          }
        });
      });
    }

    state.cart = [];
    save();

    closeModal('modal-payment');
    playSaleSound();
    launchConfetti();
    const methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    showToast(`${methodLabels[method]} ${formatYen(total)} を記録しました！`);
    renderRegister();

    // Check goal celebration and badges after sale
    checkGoalCelebration(previousTotal);
    checkBadges();
    renderVisitorCounter();
  }

  // ===== Sales =====
  function calcNetProfit(sales) {
    let totalCost = 0;
    sales.forEach(s => {
      s.items.forEach(item => {
        if (item.isSet && item.items) {
          // セット: 各商品の原価を合算
          item.items.forEach(si => {
            const product = state.products.find(p => p.id === si.productId);
            if (product) totalCost += (product.cost || 0) * si.quantity * item.quantity;
          });
        } else if (item.productId) {
          const product = state.products.find(p => p.id === item.productId);
          if (product) totalCost += (product.cost || 0) * item.quantity;
        }
      });
    });
    return totalCost;
  }

  function renderSales() {
    const sales = eventSales();
    const totalSales = sales.reduce((s, sale) => s + sale.total, 0);
    const totalItems = sales.reduce((s, sale) => s + sale.items.reduce((ss, i) => ss + i.quantity, 0), 0);
    const avgPrice = sales.length > 0 ? Math.round(totalSales / sales.length) : 0;
    const totalCost = calcNetProfit(sales);
    const netProfit = totalSales - totalCost;

    $('#stat-total-sales').textContent = formatYen(totalSales);
    $('#stat-net-profit').textContent = formatYen(netProfit);
    $('#stat-transactions').textContent = sales.length.toLocaleString();
    $('#stat-avg-price').textContent = formatYen(avgPrice);

    renderDailySummary(sales, totalSales, netProfit, avgPrice);
    renderPaymentMethodStats(sales);
    renderPaymentDoughnutChart(sales);
    renderHourlyChart(sales);
    renderHourlyDetail(sales);
    renderCategoryBarChart(sales);
    renderCategoryDetail(sales);
    renderProductSales();
    renderBadges();
    renderTimeline();
    renderSalesHistory(sales);
  }

  function renderPaymentMethodStats(sales) {
    const methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    const methods = {};
    sales.forEach(s => {
      const m = s.paymentMethod || 'cash';
      if (!methods[m]) methods[m] = { count: 0, total: 0 };
      methods[m].count++;
      methods[m].total += s.total;
    });

    // Insert after stats grid
    let existingEl = document.getElementById('payment-method-stats');
    if (!existingEl) {
      existingEl = document.createElement('div');
      existingEl.id = 'payment-method-stats';
      existingEl.className = 'method-stats';
      const statsGrid = $('.stats-grid');
      if (statsGrid) statsGrid.after(existingEl);
    }

    existingEl.innerHTML = Object.entries(methods).map(([m, data]) =>
      `<span class="method-stat-chip sale-method-badge ${m}">
        ${methodLabels[m] || m}: ${formatYen(data.total)} (${data.count}件)
      </span>`
    ).join('');
  }


  // ===== Daily Summary Card =====
  function renderDailySummary(sales, totalSales, netProfit, avgPrice) {
    var ev = currentEvent();
    var summaryCard = $('#daily-summary-card');
    if (!summaryCard) return;
    var evName = ev ? ev.name : 'イベント未選択';
    $('#daily-summary-event').textContent = evName;
    $('#daily-summary-total').textContent = formatYen(totalSales);
    $('#daily-summary-profit').textContent = formatYen(netProfit);
    $('#daily-summary-txn').textContent = sales.length.toLocaleString();
    $('#daily-summary-avg').textContent = formatYen(avgPrice);

    var goal = state.settings.goal;
    var goalSection = $('#daily-summary-goal');
    if (goal > 0) {
      goalSection.style.display = '';
      var pct = Math.min(100, Math.round((totalSales / goal) * 100));
      $('#daily-goal-pct').textContent = pct + '%';
      $('#daily-goal-fill').style.width = pct + '%';
      var remaining = goal - totalSales;
      $('#daily-goal-detail').textContent = remaining > 0
        ? '目標まであと ' + formatYen(remaining)
        : '目標達成！';
    } else {
      goalSection.style.display = 'none';
    }

    var compEl = $('#daily-summary-comparison');
    if (ev && state.events.length > 1) {
      var otherEvents = state.events.filter(function(e) { return e.id !== ev.id; });
      var prevEv = otherEvents.sort(function(a, b) {
        var da = a.date ? new Date(a.date).getTime() : 0;
        var db = b.date ? new Date(b.date).getTime() : 0;
        return db - da;
      })[0];
      if (prevEv) {
        var prevSales = state.sales.filter(function(s) { return s.eventId === prevEv.id && !s.voided; });
        var prevTotal = prevSales.reduce(function(s, sale) { return s + sale.total; }, 0);
        var prevAvg = prevSales.length > 0 ? Math.round(prevTotal / prevSales.length) : 0;
        var totalDiff = totalSales - prevTotal;
        var avgDiff = avgPrice - prevAvg;
        var txnDiff = sales.length - prevSales.length;

        function diffBadge(val) {
          if (val > 0) return '<span class="daily-comparison-diff up">+' + formatYen(val) + '</span>';
          if (val < 0) return '<span class="daily-comparison-diff down">' + formatYen(val) + '</span>';
          return '<span class="daily-comparison-diff">--</span>';
        }
        function diffBadgeNum(val) {
          if (val > 0) return '<span class="daily-comparison-diff up">+' + val + '</span>';
          if (val < 0) return '<span class="daily-comparison-diff down">' + val + '</span>';
          return '<span class="daily-comparison-diff">--</span>';
        }

        compEl.style.display = '';
        compEl.innerHTML =
          '<div style="font-size:11px;opacity:0.7;margin-bottom:6px;">vs ' + esc(prevEv.name) + '</div>' +
          '<div class="daily-comparison-row"><span class="daily-comparison-label">売上</span><span class="daily-comparison-value">' + formatYen(prevTotal) + ' ' + diffBadge(totalDiff) + '</span></div>' +
          '<div class="daily-comparison-row"><span class="daily-comparison-label">客単価</span><span class="daily-comparison-value">' + formatYen(prevAvg) + ' ' + diffBadge(avgDiff) + '</span></div>' +
          '<div class="daily-comparison-row"><span class="daily-comparison-label">取引数</span><span class="daily-comparison-value">' + prevSales.length + ' ' + diffBadgeNum(txnDiff) + '</span></div>';
      } else {
        compEl.style.display = 'none';
      }
    } else {
      compEl.style.display = 'none';
    }
  }

  // ===== Payment Doughnut Chart =====
  function renderPaymentDoughnutChart(sales) {
    var canvas = $('#payment-doughnut-chart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);

    var w = rect.width;
    var h = rect.height;
    var cx = w / 2;
    var cy = h / 2;
    var radius = Math.min(cx, cy) - 8;
    var innerRadius = radius * 0.55;

    var methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    var methodColors = { cash: '#00B894', paypay: '#FF6B35', credit: '#74B9FF', other_pay: '#A29BFE' };
    var methods = {};
    var doughnutTotal = 0;
    sales.forEach(function(s) {
      var m = s.paymentMethod || 'cash';
      if (!methods[m]) methods[m] = 0;
      methods[m] += s.total;
      doughnutTotal += s.total;
    });

    ctx.clearRect(0, 0, w, h);

    if (doughnutTotal === 0) {
      ctx.fillStyle = document.body.classList.contains('dark') ? '#3A3A5C' : '#E1E4E8';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2, true);
      ctx.fill();
      ctx.fillStyle = '#888';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('データなし', cx, cy);
      var legendEl = $('#payment-legend');
      if (legendEl) legendEl.innerHTML = '';
      return;
    }

    var startAngle = -Math.PI / 2;
    var entries = Object.entries(methods).sort(function(a, b) { return b[1] - a[1]; });

    entries.forEach(function(entry) {
      var m = entry[0], val = entry[1];
      var sliceAngle = (val / doughnutTotal) * Math.PI * 2;
      ctx.fillStyle = methodColors[m] || '#999';
      ctx.beginPath();
      ctx.moveTo(cx + innerRadius * Math.cos(startAngle), cy + innerRadius * Math.sin(startAngle));
      ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
      ctx.arc(cx, cy, innerRadius, startAngle + sliceAngle, startAngle, true);
      ctx.closePath();
      ctx.fill();
      startAngle += sliceAngle;
    });

    var isDark = document.body.classList.contains('dark');
    ctx.fillStyle = isDark ? '#E8E8F0' : '#2D3436';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatYen(doughnutTotal), cx, cy);

    var legendEl2 = $('#payment-legend');
    if (legendEl2) {
      legendEl2.innerHTML = entries.map(function(entry) {
        var m = entry[0], val = entry[1];
        var pct = Math.round((val / doughnutTotal) * 100);
        return '<div class="payment-legend-item">' +
          '<span class="payment-legend-color" style="background:' + (methodColors[m] || '#999') + '"></span>' +
          '<span class="payment-legend-label">' + (methodLabels[m] || m) + '</span>' +
          '<span class="payment-legend-value">' + formatYen(val) + '</span>' +
          '<span class="payment-legend-pct">' + pct + '%</span>' +
        '</div>';
      }).join('');
    }
  }

  // ===== Hourly Detail (peak highlight + unit price) =====
  function renderHourlyDetail(sales) {
    var container = $('#hourly-detail');
    if (!container) return;

    var hourlyData = {};
    sales.forEach(function(s) {
      var hour = new Date(s.timestamp).getHours();
      if (!hourlyData[hour]) hourlyData[hour] = { total: 0, count: 0 };
      hourlyData[hour].total += s.total;
      hourlyData[hour].count++;
    });

    var hours = Object.keys(hourlyData).map(Number).sort(function(a, b) { return a - b; });
    if (hours.length === 0) {
      container.innerHTML = '';
      return;
    }

    var maxTotal = Math.max.apply(null, hours.map(function(h) { return hourlyData[h].total; }));
    var peakHour = hours.find(function(h) { return hourlyData[h].total === maxTotal; });

    container.innerHTML = hours.map(function(h) {
      var data = hourlyData[h];
      var avg = data.count > 0 ? Math.round(data.total / data.count) : 0;
      var isPeak = h === peakHour && data.total > 0;
      return '<div class="hourly-detail-item' + (isPeak ? ' peak' : '') + '">' +
        '<div class="hourly-detail-time">' + h + ':00 - ' + (h + 1) + ':00</div>' +
        '<div class="hourly-detail-row"><span>売上</span><strong>' + formatYen(data.total) + '</strong></div>' +
        '<div class="hourly-detail-row"><span>取引数</span><strong>' + data.count + '件</strong></div>' +
        '<div class="hourly-detail-row"><span>客単価</span><strong>' + formatYen(avg) + '</strong></div>' +
      '</div>';
    }).join('');
  }

  // ===== Category Bar Chart =====
  function renderCategoryBarChart(sales) {
    var canvas = $('#category-bar-chart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);

    var w = rect.width;
    var h = rect.height;
    var padding = { top: 20, right: 16, bottom: 40, left: 50 };
    var chartW = w - padding.left - padding.right;
    var chartH = h - padding.top - padding.bottom;

    var categoryLabels = { doujinshi: '同人誌', goods: 'グッズ', cd: 'CD/音楽', other: 'その他' };
    var categoryColors = { doujinshi: '#6C5CE7', goods: '#00B894', cd: '#74B9FF', other: '#FDCB6E' };
    var categories = {};

    sales.forEach(function(s) {
      s.items.forEach(function(item) {
        if (item.isSet && item.items) {
          item.items.forEach(function(si) {
            var product = state.products.find(function(p) { return p.id === si.productId; });
            if (product) {
              var cat = product.category || 'other';
              if (!categories[cat]) categories[cat] = { revenue: 0, cost: 0, qty: 0 };
              categories[cat].revenue += product.price * si.quantity * item.quantity;
              categories[cat].cost += (product.cost || 0) * si.quantity * item.quantity;
              categories[cat].qty += si.quantity * item.quantity;
            }
          });
        } else if (item.productId) {
          var product = state.products.find(function(p) { return p.id === item.productId; });
          var cat = product ? (product.category || 'other') : 'other';
          if (!categories[cat]) categories[cat] = { revenue: 0, cost: 0, qty: 0 };
          categories[cat].revenue += item.price * item.quantity;
          categories[cat].cost += (product ? (product.cost || 0) : 0) * item.quantity;
          categories[cat].qty += item.quantity;
        }
      });
    });

    var catEntries = Object.entries(categories).sort(function(a, b) { return b[1].revenue - a[1].revenue; });

    ctx.clearRect(0, 0, w, h);
    var isDark = document.body.classList.contains('dark');
    var textColor = '#888';
    var gridColor = isDark ? '#3A3A5C' : '#E1E4E8';

    if (catEntries.length === 0) {
      ctx.fillStyle = textColor;
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('データなし', w / 2, h / 2);
      var detailEl = $('#category-detail');
      if (detailEl) detailEl.innerHTML = '';
      return;
    }

    var maxVal = Math.max.apply(null, catEntries.map(function(e) { return e[1].revenue; }).concat([1]));

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    for (var gi = 0; gi <= 4; gi++) {
      var gy = padding.top + (chartH / 4) * gi;
      ctx.beginPath();
      ctx.moveTo(padding.left, gy);
      ctx.lineTo(w - padding.right, gy);
      ctx.stroke();
      ctx.fillStyle = textColor;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(formatYen(Math.round(maxVal * (4 - gi) / 4)), padding.left - 6, gy + 4);
    }

    var groupWidth = chartW / catEntries.length;
    var barWidth = Math.min(30, groupWidth * 0.35);
    var barGap = 3;

    catEntries.forEach(function(entry, i) {
      var cat = entry[0], data = entry[1];
      var groupX = padding.left + groupWidth * i;
      var barCenterX = groupX + groupWidth / 2;
      var r = Math.min(3, barWidth / 2);

      var revH = (data.revenue / maxVal) * chartH;
      var revX = barCenterX - barWidth - barGap / 2;
      var revY = padding.top + chartH - revH;
      ctx.fillStyle = categoryColors[cat] || '#999';
      ctx.beginPath();
      ctx.moveTo(revX + r, revY);
      ctx.lineTo(revX + barWidth - r, revY);
      ctx.quadraticCurveTo(revX + barWidth, revY, revX + barWidth, revY + r);
      ctx.lineTo(revX + barWidth, padding.top + chartH);
      ctx.lineTo(revX, padding.top + chartH);
      ctx.lineTo(revX, revY + r);
      ctx.quadraticCurveTo(revX, revY, revX + r, revY);
      ctx.fill();

      var costH = (data.cost / maxVal) * chartH;
      var costX = barCenterX + barGap / 2;
      var costY = padding.top + chartH - costH;
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = categoryColors[cat] || '#999';
      ctx.beginPath();
      ctx.moveTo(costX + r, costY);
      ctx.lineTo(costX + barWidth - r, costY);
      ctx.quadraticCurveTo(costX + barWidth, costY, costX + barWidth, costY + r);
      ctx.lineTo(costX + barWidth, padding.top + chartH);
      ctx.lineTo(costX, padding.top + chartH);
      ctx.lineTo(costX, costY + r);
      ctx.quadraticCurveTo(costX, costY, costX + r, costY);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = textColor;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(categoryLabels[cat] || cat, barCenterX, h - padding.bottom + 16);
    });

    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    var legendY = padding.top - 6;
    ctx.fillStyle = '#6C5CE7';
    ctx.fillRect(w - padding.right - 90, legendY - 7, 10, 10);
    ctx.fillStyle = textColor;
    ctx.fillText('売上', w - padding.right - 60, legendY + 2);
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#6C5CE7';
    ctx.fillRect(w - padding.right - 50, legendY - 7, 10, 10);
    ctx.globalAlpha = 1;
    ctx.fillStyle = textColor;
    ctx.fillText('原価', w - padding.right - 20, legendY + 2);
  }

  // ===== Category Detail Cards =====
  function renderCategoryDetail(sales) {
    var container = $('#category-detail');
    if (!container) return;

    var categoryLabels = { doujinshi: '同人誌', goods: 'グッズ', cd: 'CD/音楽', other: 'その他' };
    var categoryColors = { doujinshi: '#6C5CE7', goods: '#00B894', cd: '#74B9FF', other: '#FDCB6E' };
    var categories = {};

    sales.forEach(function(s) {
      s.items.forEach(function(item) {
        if (item.isSet && item.items) {
          item.items.forEach(function(si) {
            var product = state.products.find(function(p) { return p.id === si.productId; });
            if (product) {
              var cat = product.category || 'other';
              if (!categories[cat]) categories[cat] = { revenue: 0, cost: 0, qty: 0 };
              categories[cat].revenue += product.price * si.quantity * item.quantity;
              categories[cat].cost += (product.cost || 0) * si.quantity * item.quantity;
              categories[cat].qty += si.quantity * item.quantity;
            }
          });
        } else if (item.productId) {
          var product = state.products.find(function(p) { return p.id === item.productId; });
          var cat = product ? (product.category || 'other') : 'other';
          if (!categories[cat]) categories[cat] = { revenue: 0, cost: 0, qty: 0 };
          categories[cat].revenue += item.price * item.quantity;
          categories[cat].cost += (product ? (product.cost || 0) : 0) * item.quantity;
          categories[cat].qty += item.quantity;
        }
      });
    });

    var entries = Object.entries(categories).sort(function(a, b) { return b[1].revenue - a[1].revenue; });
    if (entries.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = entries.map(function(entry) {
      var cat = entry[0], data = entry[1];
      var profit = data.revenue - data.cost;
      var margin = data.revenue > 0 ? Math.round((profit / data.revenue) * 100) : 0;
      return '<div class="category-detail-card" style="border-left-color:' + (categoryColors[cat] || '#999') + '">' +
        '<div class="category-detail-name">' + (categoryLabels[cat] || cat) + '</div>' +
        '<div class="category-detail-stats">' +
          '<div>売上: <strong>' + formatYen(data.revenue) + '</strong></div>' +
          '<div>原価: <strong>' + formatYen(data.cost) + '</strong></div>' +
          '<div>利益: <strong style="color:var(--success)">' + formatYen(profit) + '</strong> (' + margin + '%)</div>' +
          '<div>販売数: <strong>' + data.qty + '個</strong></div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ===== Share Report =====
  function shareReport() {
    var ev = currentEvent();
    var sales = eventSales();
    var totalSales = sales.reduce(function(s, sale) { return s + sale.total; }, 0);
    var totalCost = calcNetProfit(sales);
    var netProfit = totalSales - totalCost;
    var avgPrice = sales.length > 0 ? Math.round(totalSales / sales.length) : 0;

    var canvas = document.createElement('canvas');
    var scale = 2;
    canvas.width = 600 * scale;
    canvas.height = 400 * scale;
    var ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    var grad = ctx.createLinearGradient(0, 0, 600, 400);
    grad.addColorStop(0, '#6C5CE7');
    grad.addColorStop(1, '#A29BFE');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 600, 400);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(ev ? ev.name : 'DoujinPOS', 30, 45);
    ctx.font = '13px sans-serif';
    ctx.globalAlpha = 0.8;
    ctx.fillText(ev && ev.date ? formatDate(ev.date) : '', 30, 68);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, 82);
    ctx.lineTo(570, 82);
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText(formatYen(totalSales), 30, 135);
    ctx.font = '14px sans-serif';
    ctx.globalAlpha = 0.7;
    ctx.fillText('総売上', 30, 155);
    ctx.globalAlpha = 1;

    var statsY = 195;
    var statsData = [
      { label: '純利益', value: formatYen(netProfit) },
      { label: '取引数', value: sales.length + '件' },
      { label: '客単価', value: formatYen(avgPrice) },
    ];
    statsData.forEach(function(s, i) {
      var sx = 30 + i * 185;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText(s.value, sx, statsY);
      ctx.font = '12px sans-serif';
      ctx.globalAlpha = 0.7;
      ctx.fillText(s.label, sx, statsY + 20);
      ctx.globalAlpha = 1;
    });

    var goal = state.settings.goal;
    if (goal > 0) {
      var pct = Math.min(100, Math.round((totalSales / goal) * 100));
      var barY = 250;
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      _roundRect(ctx, 30, barY, 540, 14, 7);
      ctx.fill();
      ctx.fillStyle = '#fff';
      _roundRect(ctx, 30, barY, Math.max(1, 540 * (pct / 100)), 14, 7);
      ctx.fill();
      ctx.font = '12px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = 0.8;
      ctx.fillText('目標達成率: ' + pct + '%', 30, barY + 32);
      ctx.globalAlpha = 1;
    }

    var methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    var methodColors = { cash: '#00B894', paypay: '#FF6B35', credit: '#74B9FF', other_pay: '#CE93D8' };
    var methods = {};
    sales.forEach(function(s) {
      var m = s.paymentMethod || 'cash';
      if (!methods[m]) methods[m] = 0;
      methods[m] += s.total;
    });
    var methodEntries = Object.entries(methods).sort(function(a, b) { return b[1] - a[1]; });
    var methY = goal > 0 ? 310 : 270;
    methodEntries.forEach(function(entry, i) {
      var m = entry[0], val = entry[1];
      var mx = 30 + i * 140;
      ctx.fillStyle = methodColors[m] || '#999';
      _roundRect(ctx, mx, methY, 10, 10, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '13px sans-serif';
      ctx.fillText(methodLabels[m] || m, mx + 16, methY + 10);
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(formatYen(val), mx + 16, methY + 28);
    });

    ctx.font = '11px sans-serif';
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.fillText('DoujinPOS', 570, 388);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;

    canvas.toBlob(function(blob) {
      if (!blob) { showToast('画像の生成に失敗しました'); return; }
      if (navigator.share && navigator.canShare) {
        var file = new File([blob], 'doujinpos_report.png', { type: 'image/png' });
        var shareData = {
          title: ev ? ev.name + ' 売上レポート' : 'DoujinPOS 売上レポート',
          text: (ev ? ev.name : 'DoujinPOS') + ' 売上: ' + formatYen(totalSales) + ' / ' + sales.length + '件',
          files: [file],
        };
        if (navigator.canShare(shareData)) {
          navigator.share(shareData).catch(function() {});
          return;
        }
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (ev ? ev.name : 'doujinpos') + '_report.png';
      a.click();
      URL.revokeObjectURL(url);
      showToast('レポート画像を保存しました');
    }, 'image/png');
  }

  function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function renderHourlyChart(sales) {
    const canvas = $('#hourly-chart');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padding = { top: 20, right: 16, bottom: 32, left: 50 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // Aggregate by hour
    const hourly = {};
    for (let i = 6; i <= 22; i++) hourly[i] = 0;
    sales.forEach(s => {
      const hour = new Date(s.timestamp).getHours();
      hourly[hour] = (hourly[hour] || 0) + s.total;
    });

    const hours = Object.keys(hourly).map(Number).sort((a, b) => a - b);
    const values = hours.map(h => hourly[h]);
    const maxVal = Math.max(...values, 1);

    ctx.clearRect(0, 0, w, h);

    const isDark = document.body.classList.contains('dark');
    const textColor = isDark ? '#888' : '#888';
    const gridColor = isDark ? '#3A3A5C' : '#E1E4E8';

    // Grid lines
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();

      ctx.fillStyle = textColor;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(formatYen(Math.round(maxVal * (4 - i) / 4)), padding.left - 6, y + 4);
    }

    // Bars
    const barWidth = Math.max(8, (chartW / hours.length) - 4);
    const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
    gradient.addColorStop(0, '#6C5CE7');
    gradient.addColorStop(1, '#A29BFE');

    hours.forEach((hour, i) => {
      const x = padding.left + (chartW / hours.length) * i + (chartW / hours.length - barWidth) / 2;
      const barH = (values[i] / maxVal) * chartH;
      const y = padding.top + chartH - barH;

      ctx.fillStyle = gradient;
      ctx.beginPath();
      const r = Math.min(4, barWidth / 2);
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + barWidth - r, y);
      ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + r);
      ctx.lineTo(x + barWidth, padding.top + chartH);
      ctx.lineTo(x, padding.top + chartH);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.fill();

      // Hour label
      ctx.fillStyle = textColor;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(hour + '時', x + barWidth / 2, h - padding.bottom + 16);
    });
  }

  function renderProductSales() {
    const container = $('#product-sales-list');
    const prods = eventProducts();
    const sales = eventSales();

    const productStats = prods.map(p => {
      let qty = 0;
      let revenue = 0;
      sales.forEach(s => {
        s.items.forEach(item => {
          if (item.isSet && item.items) {
            const si = item.items.find(x => x.productId === p.id);
            if (si) { qty += si.quantity * item.quantity; }
          } else if (item.productId === p.id) {
            qty += item.quantity;
            revenue += item.price * item.quantity;
          }
        });
      });
      // For items sold as part of sets, estimate revenue by unit price
      revenue = revenue || qty * p.price;
      const cost = (p.cost || 0) * qty;
      const profit = revenue - cost;
      return { ...p, qty, revenue, cost, profit };
    }).sort((a, b) => b.revenue - a.revenue);

    const maxQty = Math.max(...productStats.map(p => p.qty), 1);

    container.innerHTML = productStats.map((p, i) => `
      <div class="card">
        <div class="product-rank">
          <span class="rank-num">${i + 1}</span>
          <div class="rank-info">
            <div class="card-title" style="font-size:14px;">${esc(p.name)}</div>
            <div class="rank-bar-bg">
              <div class="rank-bar-fill" style="width:${(p.qty / maxQty * 100)}%;background:${p.color || '#6C5CE7'}"></div>
            </div>
          </div>
          <div class="rank-count">
            <div style="font-weight:800;">${formatYen(p.revenue)}</div>
            <div class="text-muted">${p.qty}個</div>
            <div style="font-size:11px;color:var(--success);">利益 ${formatYen(p.profit)}</div>
          </div>
        </div>
      </div>
    `).join('');
  }

  function renderSalesHistory(sales) {
    const container = $('#sales-history');
    const sorted = [...sales].sort((a, b) => b.timestamp - a.timestamp);

    if (sorted.length === 0) {
      container.innerHTML = '<div class="empty-state"><p class="text-muted">取引履歴がありません</p></div>';
      return;
    }

    const methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    container.innerHTML = sorted.slice(0, 50).map(s => {
      const m = s.paymentMethod || 'cash';
      return `
      <div class="card">
        <div class="sale-item">
          <div>
            <div class="sale-time">${formatTime(s.timestamp)} <span class="sale-method-badge ${m}">${methodLabels[m] || m}</span></div>
            <div class="sale-details">${s.items.map(i => `${i.isSet ? '🎁' : ''}${esc(i.name)}×${i.quantity}`).join(', ')}</div>
          </div>
          <div style="text-align:right;">
            <div class="sale-amount">${formatYen(s.total)}</div>
            <button class="sale-undo" data-id="${s.id}">取消</button>
          </div>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.sale-undo').forEach(btn => {
      btn.addEventListener('click', () => {
        showConfirm('取引取消', 'この取引を取り消しますか？在庫が元に戻ります。', () => {
          const sale = state.sales.find(s => s.id === btn.dataset.id);
          if (sale) sale.voided = true;
          save();
          renderSales();
          renderRegister();
          showToast('取引を取り消しました');
        });
      });
    });
  }

  // ===== Export / Import =====
  function exportCSV() {
    const sales = eventSales();
    const ev = currentEvent();
    if (!ev || sales.length === 0) { showToast('エクスポートするデータがありません'); return; }

    const methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    const rows = [['時刻', '商品名', '数量', '単価', '原価', '小計', '合計', '決済方法', 'お預かり', 'お釣り']];
    sales.sort((a, b) => a.timestamp - b.timestamp).forEach(s => {
      s.items.forEach((item, i) => {
        const product = item.productId ? state.products.find(p => p.id === item.productId) : null;
        const cost = product ? (product.cost || 0) : 0;
        rows.push([
          i === 0 ? formatTime(s.timestamp) : '',
          item.isSet ? `[セット]${item.name}` : item.name,
          item.quantity,
          item.price,
          cost,
          item.price * item.quantity,
          i === 0 ? s.total : '',
          i === 0 ? (methodLabels[s.paymentMethod] || '現金') : '',
          i === 0 ? s.received : '',
          i === 0 ? s.change : '',
        ]);
      });
    });

    const csv = rows.map(r => r.join(',')).join('\n');
    const bom = '\uFEFF';
    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `${ev.name}_売上_${new Date().toISOString().slice(0, 10)}.csv`);
    showToast('CSVをエクスポートしました');
  }

  function exportData() {
    const data = {
      events: state.events,
      products: state.products,
      sales: state.sales,
      sets: state.sets,
      gifts: state.gifts,
      memos: state.memos,
      badges: state.badges,
      inventoryLogs: state.inventoryLogs,
      settings: state.settings,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `doujinpos_backup_${new Date().toISOString().slice(0, 10)}.json`);
    showToast('データをエクスポートしました');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.events) state.events = data.events;
        if (data.products) state.products = data.products;
        if (data.sales) state.sales = data.sales;
        if (data.sets) state.sets = data.sets;
        if (data.gifts) state.gifts = data.gifts;
        if (data.memos) state.memos = data.memos;
        if (data.badges) state.badges = data.badges;
        if (data.inventoryLogs) state.inventoryLogs = data.inventoryLogs;
        if (data.settings) Object.assign(state.settings, data.settings);
        state.currentEventId = state.events.length > 0 ? state.events[0].id : null;
        save();
        applySettings();
        renderEvents();
        showToast('データをインポートしました');
      } catch (err) {
        showToast('インポートに失敗しました');
      }
    };
    reader.readAsText(file);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ===== Confirm Dialog =====
  let confirmCallback = null;
  function showConfirm(title, message, onConfirm) {
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    confirmCallback = onConfirm;
    openModal('modal-confirm');
  }

  // ===== Settings =====
  function applySettings() {
    document.body.classList.toggle('dark', state.settings.darkMode);
    $('#btn-dark-mode').textContent = state.settings.darkMode ? '☀️' : '🌙';
    $('#setting-goal').value = state.settings.goal || '';
    // Effect settings
    const soundChk = $('#setting-sale-sound');
    const confettiChk = $('#setting-confetti');
    const goalCelebChk = $('#setting-goal-celebration');
    if (soundChk) soundChk.checked = state.settings.saleSound !== false;
    if (confettiChk) confettiChk.checked = state.settings.confetti !== false;
    if (goalCelebChk) goalCelebChk.checked = state.settings.goalCelebration !== false;
    renderPlanStatus();
  }

  // ===== Firebase Auth =====
  let firebaseDb = null;
  let userDocUnsubscribe = null;
  let appDataUnsubscribe = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function initFirebaseAuth() {
    const config = DEFAULT_FIREBASE_CONFIG;
    if (!config || !config.apiKey) {
      state.auth.loading = false;
      renderAuthUI();
      return;
    }
    const sdkBase = 'https://www.gstatic.com/firebasejs/10.12.0/';

    const loadIfNeeded = (lib) => {
      const src = sdkBase + lib;
      if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
      return loadScript(src);
    };

    // Load app + auth + firestore + functions SDKs
    loadIfNeeded('firebase-app-compat.js')
      .then(() => Promise.all([
        loadIfNeeded('firebase-auth-compat.js'),
        loadIfNeeded('firebase-firestore-compat.js'),
      ]))
      .then(() => {
        if (!firebase.apps.length) {
          firebase.initializeApp(config);
        }
        firebaseDb = firebase.firestore();

        firebase.auth().onAuthStateChanged((user) => {
          state.auth.user = user;
          state.auth.loading = false;

          if (user) {
            startUserDocListener(user.uid);
            startAppDataSync(user.uid);
          } else {
            stopUserDocListener();
            stopAppDataSync();
            state.auth.userDoc = null;
            state.settings.plan = 'free';
          }

          renderAuthUI();
          renderPlanStatus();
        });
      })
      .catch((err) => {
        console.error('Firebase Auth SDK load error:', err);
        state.auth.loading = false;
        renderAuthUI();
      });
  }

  function loginWithGoogle() {
    if (!window.firebase || !firebase.auth) {
      showToast('Firebase認証を読み込み中です…');
      return;
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    firebase.auth().signInWithPopup(provider)
      .then(() => {
        closeModal('modal-login');
        showToast('ログインしました');
      })
      .catch((err) => {
        if (err.code !== 'auth/popup-closed-by-user') {
          console.error('Google login error:', err);
          showToast('ログインに失敗しました: ' + (err.message || ''));
        }
      });
  }

  function loginWithEmail(email, password) {
    if (!window.firebase || !firebase.auth) {
      showToast('Firebase認証を読み込み中です…');
      return;
    }
    if (!email || !password) {
      showToast('メールアドレスとパスワードを入力してください');
      return;
    }
    if (password.length < 6) {
      showToast('パスワードは6文字以上で入力してください');
      return;
    }

    firebase.auth().signInWithEmailAndPassword(email, password)
      .then(() => {
        closeModal('modal-login');
        showToast('ログインしました');
      })
      .catch((err) => {
        if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
          // Auto-create account
          firebase.auth().createUserWithEmailAndPassword(email, password)
            .then(() => {
              closeModal('modal-login');
              showToast('アカウントを作成しました');
            })
            .catch((createErr) => {
              console.error('Create account error:', createErr);
              showToast('アカウント作成に失敗しました: ' + (createErr.message || ''));
            });
        } else {
          console.error('Email login error:', err);
          showToast('ログインに失敗しました: ' + (err.message || ''));
        }
      });
  }

  function logout() {
    if (!window.firebase || !firebase.auth) return;
    showConfirm('ログアウト', 'ログアウトしますか？ローカルデータは保持されます。', () => {
      firebase.auth().signOut().then(() => {
        state.settings.plan = 'free';
        save();
        closeAllModals();
        showToast('ログアウトしました');
        renderPlanStatus();
        // Re-render current view
        const activeView = $('.view.active');
        if (activeView) {
          const viewId = activeView.id.replace('view-', '');
          switchView(viewId);
        }
      });
    });
  }

  // ===== Auth Header UI =====
  function renderAuthUI() {
    const container = $('#auth-area');
    if (!container) return;

    if (state.auth.loading) {
      container.innerHTML = '';
      return;
    }

    if (state.auth.user) {
      const user = state.auth.user;
      if (user.photoURL) {
        container.innerHTML = `
          <button class="user-avatar-btn" id="btn-open-account" title="アカウント">
            <img src="${user.photoURL}" class="user-avatar-img" alt="Avatar" referrerpolicy="no-referrer">
          </button>`;
      } else {
        const initial = (user.displayName || user.email || '?')[0].toUpperCase();
        container.innerHTML = `
          <button class="user-avatar-btn" id="btn-open-account" title="アカウント">
            <div class="user-avatar-placeholder">${esc(initial)}</div>
          </button>`;
      }
      $('#btn-open-account').addEventListener('click', openAccountModal);
    } else {
      container.innerHTML = `
        <button class="btn-header-login" id="btn-header-login">ログイン</button>`;
      $('#btn-header-login').addEventListener('click', () => openModal('modal-login'));
    }
  }

  function openAccountModal() {
    const user = state.auth.user;
    if (!user) return;

    // Avatar
    const avatarContainer = $('#account-avatar');
    if (user.photoURL) {
      avatarContainer.innerHTML = `<img src="${user.photoURL}" alt="Avatar" referrerpolicy="no-referrer">`;
    } else {
      const initial = (user.displayName || user.email || '?')[0].toUpperCase();
      avatarContainer.innerHTML = `<span class="account-avatar-initial">${esc(initial)}</span>`;
    }

    // Details
    const details = $('#account-details');
    details.innerHTML = `
      <div class="account-name">${esc(user.displayName || 'ユーザー')}</div>
      <div class="account-email">${esc(user.email || '')}</div>`;

    // Plan status in account modal
    const planContainer = $('#account-plan-status');
    if (isPro()) {
      planContainer.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="pro-badge">PRO</span>
          <span style="font-weight:600;">有効</span>
        </div>`;
    } else {
      planContainer.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-weight:600;">Freeプラン</span>
          <button id="btn-account-upgrade" class="btn btn-primary btn-sm">Proにアップグレード</button>
        </div>`;
      setTimeout(() => {
        const btn = $('#btn-account-upgrade');
        if (btn) btn.addEventListener('click', () => { closeModal('modal-account'); showUpgradeModal(); });
      }, 0);
    }

    openModal('modal-account');
  }

  // ===== User Document Listener =====
  function startUserDocListener(uid) {
    stopUserDocListener();
    if (!firebaseDb) return;

    userDocUnsubscribe = firebaseDb.doc(`users/${uid}`).onSnapshot((doc) => {
      if (doc.exists) {
        state.auth.userDoc = doc.data();
        // Sync plan from Firestore
        if (state.auth.userDoc.plan) {
          state.settings.plan = state.auth.userDoc.plan;
        }
        renderPlanStatus();
        // Re-render analysis tab lock state
        const activeView = $('.view.active');
        if (activeView && activeView.id === 'view-analysis') {
          renderAnalysis();
        }
      } else {
        // First login: create user document
        firebaseDb.doc(`users/${uid}`).set({
          plan: 'free',
          createdAt: Date.now(),
        }).catch(err => console.error('User doc init error:', err));
      }
    }, (err) => {
      console.error('User doc listener error:', err);
    });
  }

  function stopUserDocListener() {
    if (userDocUnsubscribe) {
      userDocUnsubscribe();
      userDocUnsubscribe = null;
    }
  }

  // ===== UID-based App Data Sync =====
  function startAppDataSync(uid) {
    stopAppDataSync();
    if (!firebaseDb) return;

    const docRef = firebaseDb.doc(`users/${uid}/appData/main`);
    appDataUnsubscribe = docRef.onSnapshot((doc) => {
      if (doc.exists) {
        const remoteData = doc.data();
        if (remoteData.lastUpdatedBy !== getDeviceId() && remoteData.updatedAt > (state._lastSyncAt || 0)) {
          if (remoteData.events) state.events = remoteData.events;
          if (remoteData.products) state.products = remoteData.products;
          if (remoteData.sales) state.sales = remoteData.sales;
          if (remoteData.sets) state.sets = remoteData.sets;
          if (remoteData.gifts) state.gifts = remoteData.gifts;
          if (remoteData.memos) state.memos = remoteData.memos;
          if (remoteData.badges) state.badges = remoteData.badges;
          if (remoteData.inventoryLogs) state.inventoryLogs = remoteData.inventoryLogs;
          state._lastSyncAt = remoteData.updatedAt;
          // Save to localStorage for offline
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            events: state.events,
            products: state.products,
            sales: state.sales,
            sets: state.sets,
            gifts: state.gifts,
            memos: state.memos,
            badges: state.badges,
            inventoryLogs: state.inventoryLogs,
            currentEventId: state.currentEventId,
            settings: state.settings,
          }));
          // Re-render
          const activeView = $('.view.active');
          if (activeView) {
            const viewId = activeView.id.replace('view-', '');
            switchView(viewId);
          }
          showToast('データが同期されました');
        }
      } else {
        // No cloud data yet — offer to upload local data
        migrateLocalDataToCloud(uid);
      }
    }, (err) => {
      console.error('App data sync error:', err);
    });
  }

  function stopAppDataSync() {
    if (appDataUnsubscribe) {
      appDataUnsubscribe();
      appDataUnsubscribe = null;
    }
  }

  function migrateLocalDataToCloud(uid) {
    const hasLocalData = state.events.length > 0 || state.products.length > 0 || state.sales.length > 0;
    if (!hasLocalData) return;

    showConfirm(
      'データのアップロード',
      'ローカルデータをクラウドにアップロードしますか？',
      () => {
        pushAppData(uid);
        showToast('データをアップロードしました');
      }
    );
  }

  function pushAppData(uid) {
    if (!firebaseDb || !uid) return;
    const docRef = firebaseDb.doc(`users/${uid}/appData/main`);
    const payload = {
      events: state.events,
      products: state.products,
      sales: state.sales,
      sets: state.sets || [],
      gifts: state.gifts || [],
      memos: state.memos || [],
      badges: state.badges || [],
      inventoryLogs: state.inventoryLogs || [],
      updatedAt: Date.now(),
      lastUpdatedBy: getDeviceId(),
    };
    state._lastSyncAt = payload.updatedAt;
    docRef.set(payload, { merge: true }).catch(err => console.error('App data push error:', err));
  }

  // ===== Gifts / 差し入れ =====
  function eventGifts() {
    return state.gifts.filter(g => g.eventId === state.currentEventId);
  }

  function renderGifts() {
    const container = $('#gift-list');
    const ev = currentEvent();

    if (!ev) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📅</span>
          <p>イベントを選択してください</p>
        </div>`;
      return;
    }

    const gifts = eventGifts().sort((a, b) => b.timestamp - a.timestamp);
    if (gifts.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🎀</span>
          <p>差し入れの記録がありません</p>
          <p class="text-muted">いただいた差し入れを写真付きで記録しましょう</p>
        </div>`;
      return;
    }

    container.innerHTML = gifts.map(g => `
      <div class="card gift-card">
        <div class="gift-card-content">
          ${g.photo ? `<img src="${g.photo}" class="gift-card-photo" data-id="${g.id}" alt="差し入れ写真">` : ''}
          <div class="gift-card-info">
            <div class="gift-card-from">${esc(g.from || '(送り主不明)')}</div>
            <div class="gift-card-note">${esc(g.note || '')}</div>
            <div class="gift-card-time">${formatTime(g.timestamp)} - ${formatDate(new Date(g.timestamp).toISOString().slice(0, 10))}</div>
          </div>
        </div>
        <div class="gift-card-actions">
          <button class="btn btn-outline btn-sm btn-edit-gift" data-id="${g.id}">編集</button>
          <button class="btn btn-danger btn-sm btn-delete-gift" data-id="${g.id}">削除</button>
        </div>
      </div>
    `).join('');

    // Photo lightbox
    container.querySelectorAll('.gift-card-photo').forEach(img => {
      img.addEventListener('click', () => showLightbox(img.src));
    });

    container.querySelectorAll('.btn-edit-gift').forEach(btn => {
      btn.addEventListener('click', () => openGiftModal(btn.dataset.id));
    });

    container.querySelectorAll('.btn-delete-gift').forEach(btn => {
      btn.addEventListener('click', () => {
        showConfirm('差し入れ削除', 'この記録を削除しますか？', () => {
          state.gifts = state.gifts.filter(g => g.id !== btn.dataset.id);
          save();
          renderGifts();
          showToast('記録を削除しました');
        });
      });
    });
  }

  function openGiftModal(editId) {
    if (!currentEvent()) { showToast('先にイベントを選択してください'); return; }

    const editing = editId ? state.gifts.find(g => g.id === editId) : null;
    state.editingGiftId = editing ? editing.id : null;
    state.giftPhotoData = editing ? editing.photo : null;

    $('#modal-gift-title').textContent = editing ? '差し入れ編集' : '差し入れを記録';
    $('#gift-from').value = editing ? (editing.from || '') : '';
    $('#gift-note').value = editing ? (editing.note || '') : '';

    if (state.giftPhotoData) {
      $('#gift-photo-preview').src = state.giftPhotoData;
      $('#gift-photo-preview').style.display = 'block';
      $('#gift-photo-placeholder').style.display = 'none';
      $('#gift-photo-remove').style.display = 'inline-flex';
    } else {
      $('#gift-photo-preview').style.display = 'none';
      $('#gift-photo-placeholder').style.display = 'flex';
      $('#gift-photo-remove').style.display = 'none';
    }

    openModal('modal-gift');
  }

  function handleGiftPhoto(file) {
    if (!file) return;
    // Resize image to save localStorage space
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSize = 800;
        let w = img.width, h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) { h = (h / w) * maxSize; w = maxSize; }
          else { w = (w / h) * maxSize; h = maxSize; }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        state.giftPhotoData = canvas.toDataURL('image/jpeg', 0.7);

        $('#gift-photo-preview').src = state.giftPhotoData;
        $('#gift-photo-preview').style.display = 'block';
        $('#gift-photo-placeholder').style.display = 'none';
        $('#gift-photo-remove').style.display = 'inline-flex';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ===== Product Cover Image =====
  function handleProductCover(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSize = 600;
        let w = img.width, h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) { h = (h / w) * maxSize; w = maxSize; }
          else { w = (w / h) * maxSize; h = maxSize; }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        state.productCoverImageData = canvas.toDataURL('image/jpeg', 0.8);

        $('#product-cover-preview').src = state.productCoverImageData;
        $('#product-cover-preview').style.display = 'block';
        $('#product-cover-placeholder').style.display = 'none';
        $('#product-cover-remove').style.display = 'flex';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function saveGift() {
    const from = $('#gift-from').value.trim();
    const note = $('#gift-note').value.trim();
    if (!from && !note && !state.giftPhotoData) {
      showToast('送り主、メモ、写真のいずれかを入力してください');
      return;
    }

    if (state.editingGiftId) {
      const g = state.gifts.find(x => x.id === state.editingGiftId);
      if (g) {
        g.from = from;
        g.note = note;
        g.photo = state.giftPhotoData;
      }
      state.editingGiftId = null;
    } else {
      state.gifts.push({
        id: genId(),
        eventId: state.currentEventId,
        timestamp: Date.now(),
        from, note,
        photo: state.giftPhotoData,
      });
    }

    state.giftPhotoData = null;
    save();
    closeModal('modal-gift');
    renderGifts();
    showToast('差し入れを記録しました');
  }

  // Lightbox
  function showLightbox(src) {
    let lb = document.getElementById('lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'lightbox';
      lb.className = 'lightbox';
      lb.innerHTML = '<img>';
      lb.addEventListener('click', () => lb.classList.remove('active'));
      document.body.appendChild(lb);
    }
    lb.querySelector('img').src = src;
    lb.classList.add('active');
  }

  // ===== Analysis (Pro) =====
  function renderAnalysis() {
    renderEventComparison();
    renderComparisonChart();
    renderInventorySimulation();
    renderAnnualSummary();
    renderTagAnalysis();
  }

  // --- Event Comparison ---
  function renderEventComparison() {
    const container = $('#analysis-comparison');
    if (state.events.length === 0) {
      container.innerHTML = '<div class="empty-state"><p class="text-muted">イベントデータがありません</p></div>';
      return;
    }

    const eventStats = state.events.map(ev => {
      const sales = state.sales.filter(s => s.eventId === ev.id && !s.voided);
      const totalSales = sales.reduce((sum, s) => sum + s.total, 0);
      const txCount = sales.length;
      const avgPrice = txCount > 0 ? Math.round(totalSales / txCount) : 0;
      let totalCost = 0;
      sales.forEach(s => {
        s.items.forEach(item => {
          if (item.isSet && item.items) {
            item.items.forEach(si => {
              const p = state.products.find(x => x.id === si.productId);
              if (p) totalCost += (p.cost || 0) * si.quantity * item.quantity;
            });
          } else if (item.productId) {
            const p = state.products.find(x => x.id === item.productId);
            if (p) totalCost += (p.cost || 0) * item.quantity;
          }
        });
      });
      const profit = totalSales - totalCost;
      return { name: ev.name, date: ev.date, totalSales, txCount, avgPrice, totalCost, profit };
    });

    // Chart canvas
    let chartHtml = '';
    if (eventStats.length >= 2) {
      chartHtml = `<div class="chart-container" style="margin-bottom:12px;"><canvas id="comparison-chart"></canvas></div>`;
    }

    // Table
    const tableHtml = `
      <div class="card" style="overflow-x:auto;">
        <table class="analysis-table">
          <thead>
            <tr>
              <th>イベント</th>
              <th>売上</th>
              <th>取引数</th>
              <th>客単価</th>
              <th>原価</th>
              <th>利益</th>
            </tr>
          </thead>
          <tbody>
            ${eventStats.map(ev => `
              <tr>
                <td><strong>${esc(ev.name)}</strong><br><span class="text-muted">${formatDate(ev.date)}</span></td>
                <td>${formatYen(ev.totalSales)}</td>
                <td>${ev.txCount}</td>
                <td>${formatYen(ev.avgPrice)}</td>
                <td>${formatYen(ev.totalCost)}</td>
                <td style="color:var(--success);font-weight:700;">${formatYen(ev.profit)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;

    container.innerHTML = chartHtml + tableHtml;
  }

  function renderComparisonChart() {
    const canvas = $('#comparison-chart');
    if (!canvas) return;

    const eventStats = state.events.map(ev => {
      const sales = state.sales.filter(s => s.eventId === ev.id && !s.voided);
      return { name: ev.name, totalSales: sales.reduce((sum, s) => sum + s.total, 0) };
    });

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padding = { top: 20, right: 16, bottom: 40, left: 55 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    const values = eventStats.map(e => e.totalSales);
    const maxVal = Math.max(...values, 1);

    ctx.clearRect(0, 0, w, h);
    const isDark = document.body.classList.contains('dark');
    const textColor = '#888';
    const gridColor = isDark ? '#3A3A5C' : '#E1E4E8';

    // Grid lines
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
      ctx.fillStyle = textColor;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(formatYen(Math.round(maxVal * (4 - i) / 4)), padding.left - 6, y + 4);
    }

    // Bars
    const barWidth = Math.max(20, Math.min(60, (chartW / eventStats.length) - 10));
    const colors = ['#6C5CE7', '#00B894', '#FD79A8', '#FDCB6E', '#74B9FF', '#E17055'];

    eventStats.forEach((ev, i) => {
      const x = padding.left + (chartW / eventStats.length) * i + (chartW / eventStats.length - barWidth) / 2;
      const barH = (ev.totalSales / maxVal) * chartH;
      const y = padding.top + chartH - barH;

      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      const r = Math.min(4, barWidth / 2);
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + barWidth - r, y);
      ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + r);
      ctx.lineTo(x + barWidth, padding.top + chartH);
      ctx.lineTo(x, padding.top + chartH);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.fill();

      // Label
      ctx.fillStyle = textColor;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      const label = ev.name.length > 6 ? ev.name.slice(0, 6) + '…' : ev.name;
      ctx.fillText(label, x + barWidth / 2, h - padding.bottom + 16);
    });
  }

  // --- Inventory Simulation ---
  function renderInventorySimulation() {
    const container = $('#analysis-simulation');
    if (state.products.length === 0 || state.events.length === 0) {
      container.innerHTML = '<div class="empty-state"><p class="text-muted">商品・イベントデータが必要です</p></div>';
      return;
    }

    const simCards = state.products.map(p => {
      // Gather sales data per event
      const eventData = state.events.map(ev => {
        const sales = state.sales.filter(s => s.eventId === ev.id && !s.voided);
        let sold = 0;
        sales.forEach(s => {
          s.items.forEach(item => {
            if (item.isSet && item.items) {
              const si = item.items.find(x => x.productId === p.id);
              if (si) sold += si.quantity * item.quantity;
            } else if (item.productId === p.id) {
              sold += item.quantity;
            }
          });
        });
        const ep = (ev.eventProducts || []).find(x => x.productId === p.id);
        const stock = ep ? ep.initialStock : 0;
        return { eventName: ev.name, sold, stock, soldOutRate: stock > 0 ? sold / stock : 0 };
      }).filter(d => d.stock > 0 || d.sold > 0);

      if (eventData.length === 0) return null;

      const avgSold = Math.round(eventData.reduce((s, d) => s + d.sold, 0) / eventData.length);
      const maxSold = Math.max(...eventData.map(d => d.sold));
      const avgSoldOutRate = eventData.reduce((s, d) => s + d.soldOutRate, 0) / eventData.length;
      // Recommend: if sold out rate > 80%, suggest 1.3x max; else 1.1x avg
      const recommended = avgSoldOutRate > 0.8
        ? Math.ceil(maxSold * 1.3)
        : Math.ceil(avgSold * 1.1);

      return {
        name: p.name,
        color: p.color,
        avgSold,
        maxSold,
        avgSoldOutRate,
        recommended,
        eventData,
      };
    }).filter(Boolean);

    if (simCards.length === 0) {
      container.innerHTML = '<div class="empty-state"><p class="text-muted">販売データがありません</p></div>';
      return;
    }

    container.innerHTML = simCards.map(sim => `
      <div class="card sim-card">
        <div class="sim-card-header">
          <div class="product-color-tag" style="background:${sim.color || '#6C5CE7'}"></div>
          <div style="flex:1;">
            <div class="card-title">${esc(sim.name)}</div>
            <div class="product-meta">
              <span>平均販売: <strong>${sim.avgSold}個</strong></span>
              <span>最大: <strong>${sim.maxSold}個</strong></span>
              <span>完売率: <strong>${Math.round(sim.avgSoldOutRate * 100)}%</strong></span>
            </div>
          </div>
        </div>
        <div class="sim-recommend">
          <span>推奨持込数:</span>
          <span class="sim-recommend-num">${sim.recommended}個</span>
        </div>
        <div class="sim-events text-muted">
          ${sim.eventData.map(d => `${esc(d.eventName)}: ${d.sold}/${d.stock}個`).join(' / ')}
        </div>
      </div>
    `).join('');
  }

  // --- Annual Summary ---
  function renderAnnualSummary() {
    const container = $('#analysis-annual');
    if (state.events.length === 0) {
      container.innerHTML = '<div class="empty-state"><p class="text-muted">イベントデータがありません</p></div>';
      return;
    }

    // Collect years
    const years = [...new Set(state.events.map(ev => {
      if (!ev.date) return null;
      return new Date(ev.date).getFullYear();
    }).filter(Boolean))].sort((a, b) => b - a);

    if (years.length === 0) {
      container.innerHTML = '<div class="empty-state"><p class="text-muted">日付が設定されたイベントがありません</p></div>';
      return;
    }

    // Year selector
    let html = `<div class="card">
      <div class="form-group" style="margin-bottom:12px;">
        <label>年度</label>
        <select id="annual-year-select" class="input" style="width:auto;">
          ${years.map(y => `<option value="${y}">${y}年</option>`).join('')}
        </select>
      </div>
      <div id="annual-summary-content"></div>
      <div style="margin-top:12px;">
        <button id="btn-export-pdf" class="btn btn-primary btn-sm">PDF出力（印刷）</button>
      </div>
    </div>`;

    container.innerHTML = html;

    const renderYear = (year) => {
      const yearEvents = state.events.filter(ev => ev.date && new Date(ev.date).getFullYear() === year);
      let yearTotalSales = 0, yearTotalCost = 0;
      const methodTotals = {};

      const rows = yearEvents.map(ev => {
        const sales = state.sales.filter(s => s.eventId === ev.id && !s.voided);
        const total = sales.reduce((sum, s) => sum + s.total, 0);
        let cost = 0;
        sales.forEach(s => {
          s.items.forEach(item => {
            if (item.isSet && item.items) {
              item.items.forEach(si => {
                const p = state.products.find(x => x.id === si.productId);
                if (p) cost += (p.cost || 0) * si.quantity * item.quantity;
              });
            } else if (item.productId) {
              const p = state.products.find(x => x.id === item.productId);
              if (p) cost += (p.cost || 0) * item.quantity;
            }
          });
          const m = s.paymentMethod || 'cash';
          methodTotals[m] = (methodTotals[m] || 0) + s.total;
        });
        yearTotalSales += total;
        yearTotalCost += cost;
        return { name: ev.name, date: ev.date, total, cost, profit: total - cost };
      });

      const methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
      const methodHtml = Object.entries(methodTotals).map(([m, t]) =>
        `<span class="method-stat-chip sale-method-badge ${m}">${methodLabels[m] || m}: ${formatYen(t)}</span>`
      ).join('');

      $('#annual-summary-content').innerHTML = `
        <table class="analysis-table">
          <thead>
            <tr><th>イベント</th><th>売上</th><th>原価</th><th>粗利</th></tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td><strong>${esc(r.name)}</strong><br><span class="text-muted">${formatDate(r.date)}</span></td>
                <td>${formatYen(r.total)}</td>
                <td>${formatYen(r.cost)}</td>
                <td style="color:var(--success);font-weight:700;">${formatYen(r.profit)}</td>
              </tr>
            `).join('')}
            <tr style="font-weight:800;border-top:2px solid var(--border);">
              <td>合計</td>
              <td>${formatYen(yearTotalSales)}</td>
              <td>${formatYen(yearTotalCost)}</td>
              <td style="color:var(--success);">${formatYen(yearTotalSales - yearTotalCost)}</td>
            </tr>
          </tbody>
        </table>
        <div class="method-stats" style="margin-top:8px;">${methodHtml}</div>`;
    };

    renderYear(years[0]);

    $('#annual-year-select').addEventListener('change', (e) => {
      renderYear(parseInt(e.target.value));
    });

    $('#btn-export-pdf').addEventListener('click', () => {
      if (!requirePro('PDF出力はProプラン限定です')) return;
      const year = parseInt($('#annual-year-select').value);
      exportPDF(year);
    });
  }

  function exportPDF(year) {
    const htmlContent = generateAnnualReportHTML(year);
    const printWindow = window.open('', '_blank');
    printWindow.document.write(htmlContent);
    printWindow.document.close();
    printWindow.onload = () => {
      printWindow.print();
    };
  }

  function generateAnnualReportHTML(year) {
    const yearEvents = state.events.filter(ev => ev.date && new Date(ev.date).getFullYear() === year);
    let yearTotalSales = 0, yearTotalCost = 0;
    const methodTotals = {};

    const rows = yearEvents.map(ev => {
      const sales = state.sales.filter(s => s.eventId === ev.id && !s.voided);
      const total = sales.reduce((sum, s) => sum + s.total, 0);
      let cost = 0;
      sales.forEach(s => {
        s.items.forEach(item => {
          if (item.isSet && item.items) {
            item.items.forEach(si => {
              const p = state.products.find(x => x.id === si.productId);
              if (p) cost += (p.cost || 0) * si.quantity * item.quantity;
            });
          } else if (item.productId) {
            const p = state.products.find(x => x.id === item.productId);
            if (p) cost += (p.cost || 0) * item.quantity;
          }
        });
        const m = s.paymentMethod || 'cash';
        methodTotals[m] = (methodTotals[m] || 0) + s.total;
      });
      yearTotalSales += total;
      yearTotalCost += cost;
      return { name: ev.name, date: ev.date, total, cost, profit: total - cost, txCount: sales.length };
    });

    const methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    const methodRows = Object.entries(methodTotals).map(([m, t]) =>
      `<tr><td>${methodLabels[m] || m}</td><td style="text-align:right;">${formatYen(t)}</td></tr>`
    ).join('');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>DoujinPOS ${year}年 年間集計レポート</title>
<style>
  body { font-family: -apple-system, 'Hiragino Sans', sans-serif; padding: 40px; color: #333; max-width: 800px; margin: 0 auto; }
  h1 { font-size: 20px; border-bottom: 2px solid #6C5CE7; padding-bottom: 8px; }
  h2 { font-size: 16px; margin-top: 24px; color: #6C5CE7; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #ddd; text-align: left; font-size: 13px; }
  th { background: #f5f5f5; font-weight: 700; }
  .total-row { font-weight: 800; border-top: 2px solid #333; }
  .profit { color: #00B894; }
  .footer { margin-top: 32px; font-size: 11px; color: #888; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
<h1>DoujinPOS ${year}年 年間集計レポート</h1>
<p>出力日: ${new Date().toLocaleDateString('ja-JP')}</p>

<h2>イベント別売上</h2>
<table>
  <thead><tr><th>イベント名</th><th>日付</th><th>取引数</th><th>売上</th><th>原価</th><th>粗利</th></tr></thead>
  <tbody>
    ${rows.map(r => `<tr><td>${r.name}</td><td>${formatDate(r.date)}</td><td>${r.txCount}</td><td style="text-align:right;">${formatYen(r.total)}</td><td style="text-align:right;">${formatYen(r.cost)}</td><td class="profit" style="text-align:right;">${formatYen(r.profit)}</td></tr>`).join('')}
    <tr class="total-row"><td colspan="3">合計</td><td style="text-align:right;">${formatYen(yearTotalSales)}</td><td style="text-align:right;">${formatYen(yearTotalCost)}</td><td class="profit" style="text-align:right;">${formatYen(yearTotalSales - yearTotalCost)}</td></tr>
  </tbody>
</table>

<h2>決済方法別内訳</h2>
<table>
  <thead><tr><th>決済方法</th><th style="text-align:right;">金額</th></tr></thead>
  <tbody>${methodRows}</tbody>
</table>

<div class="footer">
  <p>このレポートはDoujinPOSにより自動生成されました。</p>
</div>
</body>
</html>`;
  }

  // --- Tag Analysis ---
  function renderTagAnalysis() {
    const container = $('#analysis-tags');
    // Collect all tags
    const allTags = new Set();
    state.products.forEach(p => {
      (p.tags || []).forEach(t => allTags.add(t));
    });

    if (allTags.size === 0) {
      container.innerHTML = '<div class="empty-state"><p class="text-muted">タグが設定された商品がありません</p></div>';
      return;
    }

    const tagStats = [...allTags].map(tag => {
      const products = state.products.filter(p => (p.tags || []).includes(tag));
      let totalSales = 0, totalQty = 0;
      products.forEach(p => {
        state.sales.filter(s => !s.voided).forEach(s => {
          s.items.forEach(item => {
            if (item.isSet && item.items) {
              const si = item.items.find(x => x.productId === p.id);
              if (si) { totalQty += si.quantity * item.quantity; totalSales += p.price * si.quantity * item.quantity; }
            } else if (item.productId === p.id) {
              totalQty += item.quantity;
              totalSales += item.price * item.quantity;
            }
          });
        });
      });
      return { tag, productCount: products.length, totalSales, totalQty };
    }).sort((a, b) => b.totalSales - a.totalSales);

    container.innerHTML = `
      <div class="card" style="overflow-x:auto;">
        <table class="analysis-table">
          <thead><tr><th>タグ</th><th>商品数</th><th>販売数</th><th>売上</th></tr></thead>
          <tbody>
            ${tagStats.map(ts => `
              <tr>
                <td><span class="tag-chip">${esc(ts.tag)}</span></td>
                <td>${ts.productCount}</td>
                <td>${ts.totalQty}</td>
                <td>${formatYen(ts.totalSales)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ===== Oshinagaki (お品書き) =====
  function openOshinagakiModal() {
    const ev = currentEvent();
    if (!ev) { showToast('イベントを選択してください'); return; }
    $('#oship-title').value = ev.name;
    $('#oship-subtitle').value = '';
    // Reset bg options
    $$('.oship-bg-opt').forEach((b, i) => b.classList.toggle('selected', i === 0));
    // Reset col options
    $$('.oship-col-opt').forEach((b, i) => b.classList.toggle('selected', i === 0));
    $('#oship-include-sets').checked = true;
    openModal('modal-oshinagaki');
  }

  function generateOshinagaki() {
    const ev = currentEvent();
    if (!ev) return;

    const title = $('#oship-title').value.trim() || ev.name;
    const subtitle = $('#oship-subtitle').value.trim();
    const bgColor = $('.oship-bg-opt.selected')?.dataset.bg || '#FFFFFF';
    const cols = parseInt($('.oship-col-opt.selected')?.dataset.cols) || 2;
    const includeSets = $('#oship-include-sets').checked;

    const isDark = bgColor === '#1a1a2e';
    const textColor = isDark ? '#E8E8F0' : '#2D3436';
    const mutedColor = isDark ? '#9CA3AF' : '#6B7280';
    const cardBg = isDark ? '#25253E' : '#FFFFFF';
    const cardBorder = isDark ? '#3A3A5C' : '#E1E4E8';

    // Gather products
    const prods = (ev.eventProducts || []).map(ep => {
      const p = state.products.find(x => x.id === ep.productId);
      return p ? { ...p } : null;
    }).filter(Boolean);

    const sets = includeSets ? eventSets() : [];

    // Load cover images
    const imagePromises = prods.map(p => {
      if (p.coverImage) {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ id: p.id, img });
          img.onerror = () => resolve({ id: p.id, img: null });
          img.src = p.coverImage;
        });
      }
      return Promise.resolve({ id: p.id, img: null });
    });

    Promise.all(imagePromises).then((imageResults) => {
      const imageMap = {};
      imageResults.forEach(r => { imageMap[r.id] = r.img; });

      const canvasW = 1200;
      const padding = 40;
      const contentW = canvasW - padding * 2;

      // Header height
      const headerH = subtitle ? 120 : 90;

      // Product card dimensions
      const cardGap = 16;
      const cardW = (contentW - cardGap * (cols - 1)) / cols;
      const coverH = 160;
      const cardTextH = 70;
      const cardH = coverH + cardTextH;

      const productRows = Math.ceil(prods.length / cols);
      const productsH = productRows * (cardH + cardGap);

      // Set section
      let setsH = 0;
      if (sets.length > 0) {
        setsH = 50 + sets.length * 80 + 20; // header + cards + margin
      }

      // Footer
      const footerH = 50;

      const canvasH = headerH + 20 + productsH + setsH + footerH + padding * 2;

      const canvas = document.createElement('canvas');
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext('2d');

      // Background
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, canvasW, canvasH);

      let y = padding;

      // === Header ===
      ctx.fillStyle = textColor;
      ctx.font = 'bold 36px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(title, canvasW / 2, y + 40);

      if (subtitle) {
        ctx.fillStyle = mutedColor;
        ctx.font = '22px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
        ctx.fillText(subtitle, canvasW / 2, y + 75);
      }

      y += headerH;

      // Separator line
      ctx.strokeStyle = cardBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(canvasW - padding, y);
      ctx.stroke();
      y += 20;

      // === Product Cards ===
      ctx.textAlign = 'left';
      const catIcons = { doujinshi: '\uD83D\uDCD6', goods: '\uD83C\uDF81', cd: '\uD83C\uDFB5', other: '\uD83D\uDCE6' };

      prods.forEach((p, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = padding + col * (cardW + cardGap);
        const cy = y + row * (cardH + cardGap);

        // Card background
        roundRect(ctx, cx, cy, cardW, cardH, 12);
        ctx.fillStyle = cardBg;
        ctx.fill();
        ctx.strokeStyle = cardBorder;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Cover image or placeholder
        const coverImg = imageMap[p.id];
        if (coverImg) {
          // Draw cover image fitted within card top area
          ctx.save();
          roundRectClip(ctx, cx, cy, cardW, coverH, 12, true);
          const imgAspect = coverImg.width / coverImg.height;
          const areaAspect = cardW / coverH;
          let drawW, drawH, drawX, drawY;
          if (imgAspect > areaAspect) {
            drawH = coverH;
            drawW = coverH * imgAspect;
            drawX = cx + (cardW - drawW) / 2;
            drawY = cy;
          } else {
            drawW = cardW;
            drawH = cardW / imgAspect;
            drawX = cx;
            drawY = cy + (coverH - drawH) / 2;
          }
          ctx.drawImage(coverImg, drawX, drawY, drawW, drawH);
          ctx.restore();
        } else {
          // Color block placeholder
          ctx.save();
          roundRectClip(ctx, cx, cy, cardW, coverH, 12, true);
          ctx.fillStyle = p.color || '#6C5CE7';
          ctx.fillRect(cx, cy, cardW, coverH);
          // Category icon
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.font = '48px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(catIcons[p.category] || catIcons.other, cx + cardW / 2, cy + coverH / 2 + 16);
          ctx.textAlign = 'left';
          ctx.restore();
        }

        // Product name
        ctx.fillStyle = textColor;
        ctx.font = 'bold 18px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
        const nameText = truncateText(ctx, p.name, cardW - 20);
        ctx.fillText(nameText, cx + 10, cy + coverH + 28);

        // Price
        ctx.fillStyle = isDark ? '#A29BFE' : '#6C5CE7';
        ctx.font = 'bold 22px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
        ctx.fillText(formatYen(p.price), cx + 10, cy + coverH + 56);
      });

      y += productsH;

      // === Set Section ===
      if (sets.length > 0) {
        // Section header
        ctx.fillStyle = textColor;
        ctx.font = 'bold 22px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('セット販売', padding, y + 30);
        y += 50;

        sets.forEach((s, i) => {
          const sy = y + i * 80;
          // Card
          roundRect(ctx, padding, sy, contentW, 70, 10);
          ctx.fillStyle = cardBg;
          ctx.fill();
          ctx.strokeStyle = cardBorder;
          ctx.lineWidth = 1;
          ctx.stroke();

          // Color tag
          ctx.fillStyle = s.color || '#E17055';
          roundRect(ctx, padding, sy, 6, 70, 3);
          ctx.fill();

          // Set name
          ctx.fillStyle = textColor;
          ctx.font = 'bold 18px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
          ctx.fillText(s.name, padding + 20, sy + 28);

          // Items
          const itemNames = s.items.map(si => {
            const p = state.products.find(x => x.id === si.productId);
            return p ? p.name : '';
          }).filter(Boolean).join(', ');
          ctx.fillStyle = mutedColor;
          ctx.font = '14px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
          const itemText = truncateText(ctx, itemNames, contentW - 200);
          ctx.fillText(itemText, padding + 20, sy + 50);

          // Price & discount
          const originalPrice = s.items.reduce((sum, si) => {
            const p = state.products.find(x => x.id === si.productId);
            return sum + (p ? p.price * si.quantity : 0);
          }, 0);
          const discount = originalPrice - s.price;

          ctx.fillStyle = isDark ? '#A29BFE' : '#6C5CE7';
          ctx.font = 'bold 22px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(formatYen(s.price), canvasW - padding - 16, sy + 30);

          if (discount > 0) {
            ctx.fillStyle = '#E17055';
            ctx.font = 'bold 14px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
            ctx.fillText(`${formatYen(discount)} OFF`, canvasW - padding - 16, sy + 52);
          }
          ctx.textAlign = 'left';
        });
      }

      // === Footer ===
      ctx.fillStyle = mutedColor;
      ctx.font = '13px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Powered by DoujinPOS', canvasW / 2, canvasH - padding + 10);

      // Download
      canvas.toBlob((blob) => {
        if (blob) {
          downloadBlob(blob, `oshinagaki_${ev.name}.png`);
          showToast('お品書き画像をダウンロードしました');
          closeModal('modal-oshinagaki');
        }
      }, 'image/png');
    });
  }

  // Canvas helpers
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function roundRectClip(ctx, x, y, w, h, r, topOnly) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    if (topOnly) {
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
    } else {
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    }
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.clip();
  }

  function truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let truncated = text;
    while (truncated.length > 0 && ctx.measureText(truncated + '…').width > maxWidth) {
      truncated = truncated.slice(0, -1);
    }
    return truncated + '…';
  }

  // ===== Demo Data =====
  function loadDemoData() {
    // Products
    const p1 = { id: genId(), name: '新刊「星空のカンタータ」', price: 700, cost: 250, category: 'doujinshi', color: '#6C5CE7', tags: ['新刊', 'シリーズA'] };
    const p2 = { id: genId(), name: '既刊「月夜のセレナーデ」', price: 500, cost: 180, category: 'doujinshi', color: '#00B894', tags: ['既刊', 'シリーズA'] };
    const p3 = { id: genId(), name: '既刊「夜明けのプレリュード」', price: 500, cost: 180, category: 'doujinshi', color: '#74B9FF', tags: ['既刊', 'シリーズA'] };
    const p4 = { id: genId(), name: 'アクリルキーホルダー', price: 600, cost: 200, category: 'goods', color: '#FD79A8', tags: ['グッズ'] };
    const p5 = { id: genId(), name: 'ポストカードセット(5枚)', price: 300, cost: 80, category: 'goods', color: '#FDCB6E', tags: ['グッズ'] };
    const p6 = { id: genId(), name: 'ステッカー', price: 200, cost: 50, category: 'goods', color: '#E17055', tags: ['グッズ'] };
    const products = [p1, p2, p3, p4, p5, p6];
    state.products.push(...products);

    // Sets
    const s1 = { id: genId(), name: '既刊2冊セット', price: 800, color: '#E17055', items: [
      { productId: p2.id, quantity: 1 }, { productId: p3.id, quantity: 1 }
    ]};
    const s2 = { id: genId(), name: '全巻セット', price: 1500, color: '#6C5CE7', items: [
      { productId: p1.id, quantity: 1 }, { productId: p2.id, quantity: 1 }, { productId: p3.id, quantity: 1 }
    ]};
    state.sets.push(s1, s2);

    // Event 1 — past event
    const ev1Id = genId();
    const ev1 = {
      id: ev1Id, name: 'コミケC104', date: '2025-08-17', location: '東京ビッグサイト 東ホール',
      eventProducts: [
        { productId: p1.id, initialStock: 50 },
        { productId: p2.id, initialStock: 30 },
        { productId: p3.id, initialStock: 30 },
        { productId: p4.id, initialStock: 20 },
        { productId: p5.id, initialStock: 40 },
        { productId: p6.id, initialStock: 50 },
      ],
    };

    // Event 2 — recent event
    const ev2Id = genId();
    const ev2 = {
      id: ev2Id, name: 'コミティア150', date: '2025-11-23', location: '東京ビッグサイト 西ホール',
      eventProducts: [
        { productId: p1.id, initialStock: 40 },
        { productId: p2.id, initialStock: 20 },
        { productId: p4.id, initialStock: 15 },
        { productId: p5.id, initialStock: 30 },
      ],
    };

    state.events.push(ev1, ev2);

    // Generate sales for Event 1
    const baseTime1 = new Date('2025-08-17T10:00:00').getTime();
    const methods = ['cash', 'cash', 'cash', 'paypay', 'paypay', 'credit'];
    const salesEv1 = [];
    for (let i = 0; i < 35; i++) {
      const t = baseTime1 + i * 8 * 60000 + Math.random() * 5 * 60000;
      const r = Math.random();
      let items, total;
      if (r < 0.25) {
        items = [{ productId: p1.id, name: p1.name, quantity: 1, price: p1.price }];
        total = p1.price;
      } else if (r < 0.4) {
        items = [
          { productId: p1.id, name: p1.name, quantity: 1, price: p1.price },
          { productId: p4.id, name: p4.name, quantity: 1, price: p4.price },
        ];
        total = p1.price + p4.price;
      } else if (r < 0.55) {
        items = [{ isSet: true, setId: s2.id, name: s2.name, quantity: 1, price: s2.price, items: s2.items }];
        total = s2.price;
      } else if (r < 0.7) {
        items = [{ productId: p5.id, name: p5.name, quantity: 1, price: p5.price }];
        total = p5.price;
      } else if (r < 0.82) {
        items = [
          { productId: p4.id, name: p4.name, quantity: 1, price: p4.price },
          { productId: p6.id, name: p6.name, quantity: 2, price: p6.price },
        ];
        total = p4.price + p6.price * 2;
      } else {
        items = [{ productId: p2.id, name: p2.name, quantity: 1, price: p2.price }];
        total = p2.price;
      }
      const m = methods[Math.floor(Math.random() * methods.length)];
      salesEv1.push({
        id: genId(), eventId: ev1Id, timestamp: t, items, total,
        received: total, change: 0, paymentMethod: m, voided: false,
      });
    }
    state.sales.push(...salesEv1);

    // Generate sales for Event 2
    const baseTime2 = new Date('2025-11-23T10:30:00').getTime();
    const salesEv2 = [];
    for (let i = 0; i < 22; i++) {
      const t = baseTime2 + i * 10 * 60000 + Math.random() * 6 * 60000;
      const r = Math.random();
      let items, total;
      if (r < 0.3) {
        items = [{ productId: p1.id, name: p1.name, quantity: 1, price: p1.price }];
        total = p1.price;
      } else if (r < 0.5) {
        items = [
          { productId: p1.id, name: p1.name, quantity: 1, price: p1.price },
          { productId: p5.id, name: p5.name, quantity: 1, price: p5.price },
        ];
        total = p1.price + p5.price;
      } else if (r < 0.65) {
        items = [{ productId: p4.id, name: p4.name, quantity: 1, price: p4.price }];
        total = p4.price;
      } else if (r < 0.8) {
        items = [{ productId: p2.id, name: p2.name, quantity: 1, price: p2.price }];
        total = p2.price;
      } else {
        items = [{ productId: p5.id, name: p5.name, quantity: 2, price: p5.price }];
        total = p5.price * 2;
      }
      const m = methods[Math.floor(Math.random() * methods.length)];
      salesEv2.push({
        id: genId(), eventId: ev2Id, timestamp: t, items, total,
        received: total, change: 0, paymentMethod: m, voided: false,
      });
    }
    state.sales.push(...salesEv2);

    // Gifts for Event 1
    state.gifts.push(
      { id: genId(), eventId: ev1Id, timestamp: baseTime1 + 60 * 60000, from: 'Aさん', note: 'お菓子の詰め合わせ', photo: null },
      { id: genId(), eventId: ev1Id, timestamp: baseTime1 + 150 * 60000, from: 'Bさん', note: '手紙とジュース', photo: null },
    );

    state.currentEventId = ev1Id;
    state.settings.goal = 30000;
    save();
    applySettings();
    renderEvents();
    showToast('デモデータを挿入しました（商品6, イベント2, 売上57件）');
  }

  // ===== HTML Escape =====
  function esc(str) {
    const el = document.createElement('span');
    el.textContent = str || '';
    return el.innerHTML;
  }

  // ===== Pro Plan =====
  function isPro() {
    if (state.auth.user && state.auth.userDoc) {
      return state.auth.userDoc.plan === 'pro';
    }
    return state.settings.plan === 'pro';
  }

  function requirePro(featureName) {
    if (isPro()) return true;
    showUpgradeModal(featureName);
    return false;
  }

  function showUpgradeModal(featureName) {
    const modal = $('#modal-upgrade');
    if (featureName) {
      $('#upgrade-feature-name').textContent = featureName;
    }
    openModal('modal-upgrade');
  }

  function startCheckout() {
    if (!state.auth.user) {
      closeModal('modal-upgrade');
      openModal('modal-login');
      showToast('まずログインしてください');
      return;
    }

    const btn = $('#btn-activate-pro');
    btn.disabled = true;
    btn.textContent = '処理中…';

    fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.auth.user.uid,
        email: state.auth.user.email || undefined,
      }),
    })
      .then(r => r.json())
      .then((data) => {
        if (data.url) {
          window.location.href = data.url;
        } else {
          showToast('Checkout URLの取得に失敗しました: ' + (data.error || ''));
          btn.disabled = false;
          btn.textContent = 'Proプランを購入する（¥500）';
        }
      })
      .catch((err) => {
        console.error('Checkout error:', err);
        showToast('エラーが発生しました: ' + (err.message || ''));
        btn.disabled = false;
        btn.textContent = 'Proプランを購入する（¥500）';
      });
  }

  // ===== Tip (投げ銭) =====
  function getSelectedTipAmount() {
    const customInput = $('#tip-custom-amount');
    if (customInput && customInput.value) {
      return parseInt(customInput.value, 10);
    }
    const selected = document.querySelector('.tip-amount-btn.selected');
    return selected ? parseInt(selected.dataset.amount, 10) : 0;
  }

  function startTipCheckout(amount) {
    if (!state.auth.user) {
      openModal('modal-login');
      showToast('まずログインしてください');
      return;
    }

    if (!amount || amount < 100 || amount > 100000) {
      showToast('金額は¥100〜¥100,000の範囲で指定してください');
      return;
    }

    const btn = $('#btn-send-tip');
    btn.disabled = true;
    btn.textContent = '処理中…';

    fetch('/api/create-tip-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.auth.user.uid,
        email: state.auth.user.email || undefined,
        amount: amount,
      }),
    })
      .then(r => r.json())
      .then((data) => {
        if (data.url) {
          window.location.href = data.url;
        } else {
          showToast('Checkout URLの取得に失敗しました: ' + (data.error || ''));
          btn.disabled = false;
          btn.textContent = '応援する';
        }
      })
      .catch((err) => {
        console.error('Tip checkout error:', err);
        showToast('エラーが発生しました: ' + (err.message || ''));
        btn.disabled = false;
        btn.textContent = '応援する';
      });
  }

  function renderPlanStatus() {
    const container = $('#plan-status');
    if (!container) return;
    if (isPro()) {
      let purchasedText = '';
      if (state.auth.userDoc && state.auth.userDoc.purchasedAt) {
        const d = new Date(state.auth.userDoc.purchasedAt);
        purchasedText = `購入日: ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
      } else if (state.settings.proActivatedAt) {
        purchasedText = formatDate(new Date(state.settings.proActivatedAt).toISOString().slice(0, 10)) + '〜';
      }
      container.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <span class="pro-badge">PRO</span>
            <span style="font-weight:600;margin-left:8px;">有効</span>
            ${purchasedText ? `<span class="text-muted" style="margin-left:8px;">${purchasedText}</span>` : ''}
          </div>
        </div>`;
    } else {
      container.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <span style="font-weight:600;">Freeプラン</span>
            <span class="text-muted" style="margin-left:8px;">イベント3件まで</span>
          </div>
          <button id="btn-upgrade-pro" class="btn btn-primary btn-sm">Proにアップグレード</button>
        </div>`;
      $('#btn-upgrade-pro').addEventListener('click', () => showUpgradeModal());
    }
  }

  // ===== Confetti Effect =====
  function launchConfetti() {
    if (!state.settings.confetti) return;
    const canvas = document.getElementById('confetti-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const colors = ['#6C5CE7', '#00B894', '#FD79A8', '#FDCB6E', '#74B9FF', '#E17055', '#FF6B6B', '#A29BFE'];
    const pieces = [];
    for (let i = 0; i < 80; i++) {
      pieces.push({ x: Math.random() * canvas.width, y: -20 - Math.random() * 100, w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, color: colors[Math.floor(Math.random() * colors.length)], vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 4, rot: Math.random() * Math.PI * 2, rotV: (Math.random() - 0.5) * 0.2 });
    }
    let frame = 0;
    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      pieces.forEach(p => { p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.rot += p.rotV; if (p.y < canvas.height + 20) alive = true; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); });
      frame++;
      if (alive && frame < 180) { requestAnimationFrame(animate); } else { ctx.clearRect(0, 0, canvas.width, canvas.height); }
    }
    animate();
  }

  // ===== Enhanced Sale Sound =====
  function playSaleSound() {
    if (!state.settings.saleSound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc1 = ctx.createOscillator(); const osc2 = ctx.createOscillator();
      const gain1 = ctx.createGain(); const gain2 = ctx.createGain();
      osc1.connect(gain1); gain1.connect(ctx.destination);
      osc2.connect(gain2); gain2.connect(ctx.destination);
      gain1.gain.value = 0.15; gain2.gain.value = 0.12;
      osc1.frequency.value = 1200; osc1.type = 'sine'; osc1.start(ctx.currentTime);
      gain1.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15); osc1.stop(ctx.currentTime + 0.15);
      osc2.frequency.value = 1600; osc2.type = 'sine'; osc2.start(ctx.currentTime + 0.08);
      gain2.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25); osc2.stop(ctx.currentTime + 0.25);
    } catch (e) { /* Audio not available */ }
  }

  function playFanfare() {
    if (!state.settings.saleSound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [523, 659, 784, 1047];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq; osc.type = 'sine'; gain.gain.value = 0.15;
        osc.start(ctx.currentTime + i * 0.12);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + i * 0.12 + 0.4);
        osc.stop(ctx.currentTime + i * 0.12 + 0.4);
      });
    } catch (e) { /* Audio not available */ }
  }

  // ===== Goal Celebration =====
  function checkGoalCelebration(previousTotal) {
    if (!state.settings.goalCelebration) return;
    const goal = state.settings.goal;
    if (goal <= 0) return;
    const newTotal = eventSales().reduce((s, sale) => s + sale.total, 0);
    if (previousTotal < goal && newTotal >= goal) {
      playFanfare(); launchConfetti(); launchConfetti();
      const el = document.getElementById('goal-celebration');
      if (el) {
        el.innerHTML = '<div class="goal-celebration-inner"><span class="goal-celebration-icon">🎉</span><div class="goal-celebration-text">目標達成！</div></div>';
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 3500);
      }
    }
  }

  // ===== Visitor Counter =====
  function renderVisitorCounter() {
    const ev = currentEvent();
    const count = ev ? (ev.visitorCount || 0) : 0;
    const countEl = document.getElementById('visitor-count');
    const rateEl = document.getElementById('visitor-rate');
    if (countEl) countEl.textContent = count;
    if (rateEl) {
      if (ev && count > 0) {
        const txCount = eventSales().length;
        const rate = Math.round((txCount / count) * 100);
        rateEl.textContent = '(購入率 ' + rate + '%)';
      } else { rateEl.textContent = ''; }
    }
  }

  function changeVisitorCount(delta) {
    const ev = currentEvent();
    if (!ev) { showToast('イベントを選択してください'); return; }
    ev.visitorCount = Math.max(0, (ev.visitorCount || 0) + delta);
    save(); renderVisitorCounter();
  }


  // ===== Init =====

  // ===== Quick Memo =====
  function eventMemos() {
    return state.memos.filter(m => m.eventId === state.currentEventId);
  }

  function saveMemo() {
    const text = document.getElementById('memo-text').value.trim();
    if (!text) { showToast('メモを入力してください'); return; }
    if (!currentEvent()) { showToast('イベントを選択してください'); return; }
    state.memos.push({
      id: genId(),
      eventId: state.currentEventId,
      text: text,
      timestamp: Date.now(),
    });
    document.getElementById('memo-text').value = '';
    save();
    renderMemoList();
    showToast('メモを保存しました');
  }

  function renderMemoList() {
    const container = document.getElementById('memo-list');
    if (!container) return;
    const memos = eventMemos().sort((a, b) => b.timestamp - a.timestamp);
    if (memos.length === 0) {
      container.innerHTML = '<p class="text-muted" style="text-align:center;font-size:13px;">メモはまだありません</p>';
      return;
    }
    container.innerHTML = memos.map(m => `
      <div class="memo-item">
        <div class="memo-item-content">
          <div class="memo-item-text">${esc(m.text)}</div>
          <div class="memo-item-time">${formatTime(m.timestamp)}</div>
        </div>
        <button class="btn btn-danger btn-sm btn-delete-memo" data-id="${m.id}">削除</button>
      </div>
    `).join('');
    container.querySelectorAll('.btn-delete-memo').forEach(btn => {
      btn.addEventListener('click', () => {
        state.memos = state.memos.filter(m => m.id !== btn.dataset.id);
        save();
        renderMemoList();
      });
    });
  }

  // ===== Sales Timeline =====
  function renderTimeline() {
    const container = document.getElementById('sales-timeline');
    if (!container) return;
    const sales = eventSales().sort((a, b) => a.timestamp - b.timestamp);
    if (sales.length === 0) {
      container.innerHTML = '<div class="timeline-empty">販売データがありません</div>';
      return;
    }
    container.innerHTML = sales.map(s => {
      const itemsText = s.items.map(i => `${i.isSet ? '🎁' : ''}${esc(i.name)}×${i.quantity}`).join(', ');
      return `
        <div class="timeline-item">
          <div class="timeline-time">${formatTime(s.timestamp)}</div>
          <div class="timeline-content">
            <span class="timeline-amount">${formatYen(s.total)}</span>
            <div class="timeline-items">${itemsText}</div>
          </div>
        </div>`;
    }).join('');
  }

  // ===== Event Badges =====
  const BADGE_DEFINITIONS = [
    { id: 'first_sale', icon: '🎉', name: '初売上', desc: '最初の取引を記録', check: (sales) => sales.length >= 1 },
    { id: 'ten_sales', icon: '🔟', name: '10取引', desc: '10件の取引を達成', check: (sales) => sales.length >= 10 },
    { id: 'fifty_sales', icon: '🔥', name: '50取引', desc: '50件の取引を達成', check: (sales) => sales.length >= 50 },
    { id: 'goal_reached', icon: '🏆', name: '目標達成', desc: '売上目標を達成', check: (sales, st) => {
      const goal = st.settings.goal;
      if (goal <= 0) return false;
      return sales.reduce((s, sale) => s + sale.total, 0) >= goal;
    }},
    { id: 'ten_k', icon: '💰', name: '1万円突破', desc: '売上1万円を突破', check: (sales) => sales.reduce((s, sale) => s + sale.total, 0) >= 10000 },
    { id: 'fifty_k', icon: '💎', name: '5万円突破', desc: '売上5万円を突破', check: (sales) => sales.reduce((s, sale) => s + sale.total, 0) >= 50000 },
    { id: 'hundred_k', icon: '👑', name: '10万円突破', desc: '売上10万円を突破', check: (sales) => sales.reduce((s, sale) => s + sale.total, 0) >= 100000 },
    { id: 'soldout', icon: '🎊', name: '完売達成', desc: '商品を完売させた', check: (sales, st) => {
      const ev = st.events.find(e => e.id === st.currentEventId);
      if (!ev || !ev.eventProducts) return false;
      return ev.eventProducts.some(ep => {
        if (ep.initialStock <= 0) return false;
        let sold = 0;
        sales.forEach(s => {
          s.items.forEach(item => {
            if (item.isSet && item.items) {
              const si = item.items.find(x => x.productId === ep.productId);
              if (si) sold += si.quantity * item.quantity;
            } else if (item.productId === ep.productId) {
              sold += item.quantity;
            }
          });
        });
        return sold >= ep.initialStock;
      });
    }},
  ];

  function checkBadges() {
    const sales = eventSales();
    const evId = state.currentEventId;
    if (!evId) return;
    BADGE_DEFINITIONS.forEach(def => {
      const badgeKey = `${evId}_${def.id}`;
      const already = state.badges.find(b => b.key === badgeKey);
      if (already) return;
      if (def.check(sales, state)) {
        state.badges.push({ key: badgeKey, eventId: evId, badgeId: def.id, earnedAt: Date.now() });
        save();
        showBadgeNotification(def);
      }
    });
  }

  function showBadgeNotification(def) {
    const el = document.getElementById('badge-notification');
    if (!el) return;
    el.innerHTML = `
      <span class="badge-notif-icon">${def.icon}</span>
      <div class="badge-notif-title">バッジ獲得！</div>
      <div class="badge-notif-desc">${def.name} - ${def.desc}</div>
    `;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2600);
  }

  function renderBadges() {
    const container = document.getElementById('badges-list');
    if (!container) return;
    const evId = state.currentEventId;
    if (!evId) {
      container.innerHTML = '<p class="text-muted" style="font-size:13px;">イベントを選択してください</p>';
      return;
    }
    const earnedIds = new Set(state.badges.filter(b => b.eventId === evId).map(b => b.badgeId));
    container.innerHTML = BADGE_DEFINITIONS.map(def => {
      const earned = earnedIds.has(def.id);
      return `
        <div class="badge-card ${earned ? 'earned' : 'locked'}">
          <span class="badge-icon">${def.icon}</span>
          <span class="badge-name">${def.name}</span>
          <span class="badge-desc">${def.desc}</span>
        </div>`;
    }).join('');
  }

  function init() {
    load();
    applySettings();
    renderEvents();

    // Navigation
    $$('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Event modal
    $('#btn-add-event').addEventListener('click', () => {
      if (!isPro() && state.events.length >= 3) {
        showUpgradeModal('イベントは3件までです（Proプランで無制限）');
        return;
      }
      state.editingEventId = null;
      $('#modal-event-title').textContent = '新規イベント';
      $('#event-name').value = '';
      $('#event-date').value = new Date().toISOString().slice(0, 10);
      $('#event-location').value = '';
      // Show template selector for new events
      if (state.events.length > 0) {
        $('#event-template-group').style.display = 'block';
        populateEventTemplateSelect();
        $('#event-template-select').value = '';
      } else {
        $('#event-template-group').style.display = 'none';
      }
      renderEventProductChecklist(null);
      openModal('modal-event');
    });
    $('#btn-save-event').addEventListener('click', saveEvent);

    // Product modal (グローバル - イベント選択不要)
    $('#btn-add-product').addEventListener('click', () => {
      state.editingProductId = null;
      state.productCoverImageData = null;
      $('#modal-product-title').textContent = '商品追加';
      $('#product-name').value = '';
      $('#product-price').value = '';
      $('#product-cost').value = '';
      $('#product-tags').value = '';
      $('#product-category').value = 'doujinshi';
      $$('.color-opt').forEach((c, i) => c.classList.toggle('selected', i === 0));
      // Reset cover image
      $('#product-cover-preview').style.display = 'none';
      $('#product-cover-placeholder').style.display = 'block';
      $('#product-cover-remove').style.display = 'none';
      openModal('modal-product');
    });
    $('#btn-save-product').addEventListener('click', saveProduct);

    // Color picker (product modal)
    $$('.color-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        $$('.color-opt').forEach(c => c.classList.remove('selected'));
        opt.classList.add('selected');
      });
    });

    // Color picker (set modal)
    $$('.color-opt-set').forEach(opt => {
      opt.addEventListener('click', () => {
        $$('.color-opt-set').forEach(c => c.classList.remove('selected'));
        opt.classList.add('selected');
      });
    });

    // Set modal
    $('#btn-add-set').addEventListener('click', () => openSetModal());
    $('#btn-save-set').addEventListener('click', saveSet);

    // Inventory adjust modal
    $('#btn-save-inv-adjust').addEventListener('click', saveInventoryAdjustment);

    // Gift modal
    $('#btn-add-gift').addEventListener('click', () => openGiftModal());
    $('#btn-save-gift').addEventListener('click', saveGift);
    $('#gift-photo-area').addEventListener('click', (e) => {
      if (e.target.closest('#gift-photo-remove')) return;
      $('#gift-photo-input').click();
    });
    $('#gift-photo-input').addEventListener('change', (e) => {
      if (e.target.files[0]) handleGiftPhoto(e.target.files[0]);
      e.target.value = '';
    });
    $('#gift-photo-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      state.giftPhotoData = null;
      $('#gift-photo-preview').style.display = 'none';
      $('#gift-photo-placeholder').style.display = 'flex';
      $('#gift-photo-remove').style.display = 'none';
    });

    // Product cover image
    $('#product-cover-area').addEventListener('click', (e) => {
      if (e.target.closest('#product-cover-remove')) return;
      $('#product-cover-input').click();
    });
    $('#product-cover-input').addEventListener('change', (e) => {
      if (e.target.files[0]) handleProductCover(e.target.files[0]);
      e.target.value = '';
    });
    $('#product-cover-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      state.productCoverImageData = null;
      $('#product-cover-preview').style.display = 'none';
      $('#product-cover-placeholder').style.display = 'block';
      $('#product-cover-remove').style.display = 'none';
    });

    // Payment method selector
    $$('.payment-method-btn').forEach(btn => {
      btn.addEventListener('click', () => selectPaymentMethod(btn.dataset.method));
    });

    // Visitor counter
    $('#btn-visitor-plus').addEventListener('click', () => changeVisitorCount(1));
    $('#btn-visitor-minus').addEventListener('click', () => changeVisitorCount(-1));

    // Quick memo
    $('#btn-open-memo').addEventListener('click', () => {
      renderMemoList();
      openModal('modal-memo');
    });
    $('#btn-save-memo').addEventListener('click', saveMemo);

    // Register actions
    $('#btn-payment').addEventListener('click', openPayment);
    $('#btn-clear-cart').addEventListener('click', () => {
      state.cart = [];
      renderCart();
    });

    // Payment
    $('#payment-received').addEventListener('input', updateChange);
    $('#btn-confirm-payment').addEventListener('click', confirmPayment);

    // Sales
    $('#btn-export-csv').addEventListener('click', exportCSV);
    $('#btn-share-report').addEventListener('click', shareReport);

    // Settings
    $('#btn-dark-mode').addEventListener('click', () => {
      state.settings.darkMode = !state.settings.darkMode;
      applySettings();
      save();
    });

    $('#btn-save-goal').addEventListener('click', () => {
      state.settings.goal = parseInt($('#setting-goal').value) || 0;
      save();
      renderGoal();
      showToast('売上目標を保存しました');
    });

    // Effect settings toggles
    $('#setting-sale-sound').addEventListener('change', (e) => {
      state.settings.saleSound = e.target.checked;
      save();
    });
    $('#setting-confetti').addEventListener('change', (e) => {
      state.settings.confetti = e.target.checked;
      save();
    });
    $('#setting-goal-celebration').addEventListener('change', (e) => {
      state.settings.goalCelebration = e.target.checked;
      save();
    });

    // Data management
    $('#btn-export-data').addEventListener('click', exportData);
    $('#btn-import-data').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });
    $('#btn-reset-data').addEventListener('click', () => {
      showConfirm('全データリセット', 'すべてのデータが削除されます。この操作は元に戻せません。', () => {
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
      });
    });

    // Demo data
    $('#btn-load-demo').addEventListener('click', () => {
      showConfirm('デモデータ挿入', 'サンプルの商品・イベント・売上データを追加します。既存データは保持されます。', loadDemoData);
    });

    // Test Pro toggle
    $('#btn-toggle-pro-test').addEventListener('click', () => {
      if (isPro()) {
        state.settings.plan = 'free';
        state.settings.proActivatedAt = null;
        save();
        renderPlanStatus();
        showToast('Freeプランに切り替えました（テスト）');
      } else {
        state.settings.plan = 'pro';
        state.settings.proActivatedAt = Date.now();
        save();
        renderPlanStatus();
        showToast('Proプランを有効化しました（テスト）');
      }
      const activeView = $('.view.active');
      if (activeView) switchView(activeView.id.replace('view-', ''));
    });

    // Header event selector dropdown toggle
    const headerEventBtn = $('#btn-header-event');
    if (headerEventBtn) {
      headerEventBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const dropdown = $('#header-event-dropdown');
        dropdown.classList.toggle('open');
      });
      document.addEventListener('click', () => {
        const dropdown = $('#header-event-dropdown');
        if (dropdown) dropdown.classList.remove('open');
      });
    }

    // Calendar view toggle
    const btnViewList = $('#btn-view-list');
    const btnViewCalendar = $('#btn-view-calendar');
    if (btnViewList && btnViewCalendar) {
      btnViewList.addEventListener('click', () => {
        btnViewList.classList.add('active');
        btnViewCalendar.classList.remove('active');
        $('#event-list').style.display = '';
        $('#event-calendar').style.display = 'none';
      });
      btnViewCalendar.addEventListener('click', () => {
        btnViewCalendar.classList.add('active');
        btnViewList.classList.remove('active');
        $('#event-list').style.display = 'none';
        $('#event-calendar').style.display = 'block';
        renderCalendar();
      });
    }

    // Calendar navigation
    const btnCalPrev = $('#btn-cal-prev');
    const btnCalNext = $('#btn-cal-next');
    if (btnCalPrev) {
      btnCalPrev.addEventListener('click', () => {
        calendarMonth--;
        if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
        renderCalendar();
      });
    }
    if (btnCalNext) {
      btnCalNext.addEventListener('click', () => {
        calendarMonth++;
        if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
        renderCalendar();
      });
    }

    // Event template selector
    const templateSelect = $('#event-template-select');
    if (templateSelect) {
      templateSelect.addEventListener('change', () => {
        const selectedId = templateSelect.value;
        if (selectedId) {
          applyEventTemplate(selectedId);
        } else {
          renderEventProductChecklist(null);
        }
      });
    }

    // Confirm modal
    $('#btn-confirm-ok').addEventListener('click', () => {
      closeModal('modal-confirm');
      if (confirmCallback) { confirmCallback(); confirmCallback = null; }
    });

    // Modal close
    $$('.modal-overlay, .modal-cancel').forEach(el => {
      el.addEventListener('click', closeAllModals);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllModals();
    });

    // Pro plan - upgrade modal → Stripe Checkout
    $('#btn-activate-pro').addEventListener('click', startCheckout);

    // Tip (投げ銭) - preset amount buttons
    $$('.tip-amount-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.tip-amount-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const customInput = $('#tip-custom-amount');
        if (customInput) customInput.value = '';
      });
    });

    // Tip - custom amount clears preset selection
    const tipCustomInput = $('#tip-custom-amount');
    if (tipCustomInput) {
      tipCustomInput.addEventListener('input', () => {
        if (tipCustomInput.value) {
          $$('.tip-amount-btn').forEach(b => b.classList.remove('selected'));
        }
      });
    }

    // Tip - send button
    $('#btn-send-tip').addEventListener('click', () => {
      startTipCheckout(getSelectedTipAmount());
    });

    // Oshinagaki modal
    $$('.oship-bg-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        $$('.oship-bg-opt').forEach(b => b.classList.remove('selected'));
        opt.classList.add('selected');
      });
    });
    $$('.oship-col-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        $$('.oship-col-opt').forEach(b => b.classList.remove('selected'));
        opt.classList.add('selected');
      });
    });
    $('#btn-generate-oshinagaki').addEventListener('click', generateOshinagaki);

    // Login modal
    $('#btn-login-google').addEventListener('click', loginWithGoogle);
    $('#btn-login-email').addEventListener('click', () => {
      const email = $('#login-email').value.trim();
      const password = $('#login-password').value;
      loginWithEmail(email, password);
    });
    // Allow Enter key in login form
    $('#login-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const email = $('#login-email').value.trim();
        const password = $('#login-password').value;
        loginWithEmail(email, password);
      }
    });

    // Account modal
    $('#btn-logout').addEventListener('click', logout);

    // Checkout return handling
    const urlParams = new URLSearchParams(window.location.search);
    const checkoutResult = urlParams.get('checkout');
    if (checkoutResult === 'success') {
      showToast('Proプランの購入が完了しました！');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (checkoutResult === 'canceled') {
      showToast('お支払いがキャンセルされました');
      window.history.replaceState({}, '', window.location.pathname);
    }

    // Tip return handling
    const tipResult = urlParams.get('tip');
    if (tipResult === 'success') {
      openModal('modal-tip-thanks');
      launchConfetti();
      window.history.replaceState({}, '', window.location.pathname);
    } else if (tipResult === 'canceled') {
      showToast('応援がキャンセルされました');
      window.history.replaceState({}, '', window.location.pathname);
    }

    // Initialize Firebase Auth (loads SDKs and sets up listeners)
    initFirebaseAuth();
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
