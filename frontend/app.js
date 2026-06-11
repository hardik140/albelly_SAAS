// ==========================================
// Albelly ERP Frontend JavaScript Application
// ==========================================

// For automated testing verification support
if (window.location.search.includes('bypassConfirm=true')) {
  window.confirm = () => true;
}

// State variables
let state = {
  activeRole: 'ADMIN',
  activeScreen: 'sales-desk',
  recipes: [],
  rawMaterials: [],
  inventoryBatches: [],
  productionBatches: [],
  finishedGoods: [],
  orders: [],
  auditLogs: [],
  cart: {}, // Format: { "Product Name": quantity }
  settings: { gst_rate: 0.05 },
  isDarkMode: localStorage.getItem('isDarkMode') !== 'false',
  salesCategoryFilter: 'all',
  salesSearchQuery: '',
  workers: [],
  workerShifts: [],
  selectedColdProduct: null,
  coldProductAnalytics: null,
  distPage: 1,
  distPageSize: 15,
  distSearchQuery: '',
  workerSearchQuery: ''
};

let charts = {
  annualFinancials: null,
  annualDoughnut: null,
  monthlyDaily: null,
  distributorAnnual: null,
  distributorMonthly: null,
  distributorHistoryLine: null,
  yearlySalesComparison: null,
  distributorYoYTimeline: null
};

// ==========================================
// 🌐 BACKEND CONFIGURATION
// ==========================================
// For local development, this defaults to relative paths (empty string).
// In production, update this with your actual Render URL (e.g. 'https://albelly-backend.onrender.com') without trailing slash.
const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? ''
  : 'https://albelly-backend.onrender.com'; // Replace with your actual Render URL

let wsUrl;
if (BACKEND_URL) {
  wsUrl = BACKEND_URL.replace(/^http/, 'ws');
} else {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl = `${wsProtocol}//${window.location.host}`;
}
let ws;

// ==========================================
// 🔑 SUPABASE CONFIGURATION
// ==========================================
const supabaseUrl = 'https://mqkaatsydqiaksjeesdi.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1xa2FhdHN5ZHFpYWtzamVlc2RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1ODUzODIsImV4cCI6MjA5NjE2MTM4Mn0.Pcv1OeTaVGGNzJCcc6UGck45XG2UeG57hGjdo03O8Y0';
let supabaseClient = null;

let isAuthBypass = true;

function initSupabase() {
  if (supabaseAnonKey && supabaseAnonKey !== 'your_supabase_anon_public_key_here') {
    try {
      supabaseClient = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
      isAuthBypass = false;
      console.log('Supabase client successfully initialized!');
    } catch (e) {
      console.error('Supabase initialization failed:', e);
      isAuthBypass = true;
    }
  } else {
    isAuthBypass = true;
    console.log('Supabase key is placeholder. Running in bypass testing mode.');
  }
}

function getRequestHeaders() {
  const headers = {};
  if (state.accessToken) {
    headers['Authorization'] = `Bearer ${state.accessToken}`;
  }
  return headers;
}

// DOM Elements
const screenTitle = document.getElementById('screen-title');
const screenSubtitle = document.getElementById('screen-subtitle');
const userDisplayName = document.getElementById('user-display-name');
const roleSelect = document.getElementById('role-select');
const themeToggle = document.getElementById('theme-toggle');

// Modals
const modalStartBatch = document.getElementById('modal-start-batch');

const modalAddInventory = document.getElementById('modal-add-inventory');
const modalInvoiceViewer = document.getElementById('modal-invoice-viewer');
const modalAddFinishedBatch = document.getElementById('modal-add-finished-batch');
const invoiceFrame = document.getElementById('invoice-frame');

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  setupAuth();
  setupMobileSidebar();
  setupNavigation();
  setupRoleManager();
  applyRoleRestrictions();
  setupThemeToggle();
  setupModalCloses();
  setupFormHandlers();
  setupWS();
  setupManualSalesDesk();
  
  // Start continuous ticking intervals (for truck duration logs and aging counts)
  setInterval(tickLiveElements, 1000);
});

// Load all API endpoints
async function loadAllData() {
  await Promise.all([
    loadSettings(),
    loadDistributors(),
    loadRawMaterials(),
    loadRecipes(),
    loadProductionBatches(),
    loadFinishedGoods(),
    loadOrders(),
    loadAuditLogs(),
    loadWorkers(),
    loadWorkerShifts()
  ]);
  renderAll();
}

// ==========================================
// 📡 WEBSOCKET CONNECTION
// ==========================================
function setupWS() {
  // Prevent duplicate connection attempts if already connecting or open
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  // Clean up any existing socket state/listeners before reconnecting
  if (ws) {
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  try {
    ws = new WebSocket(wsUrl);

    // Update connection status in sidebar UI
    const connStatusEl = document.querySelector('.connection-status');
    if (connStatusEl) {
      connStatusEl.innerHTML = '<span class="status-dot"></span> Websocket Reconnecting...';
    }

    ws.onopen = () => {
      const dot = document.querySelector('.status-dot');
      if (dot) dot.className = 'status-dot online';
      if (connStatusEl) {
        connStatusEl.innerHTML = '<span class="status-dot online"></span> Websocket Online';
      }
    };
    ws.onmessage = (event) => {
      const { event: evType, data } = JSON.parse(event.data);
      console.log('WS Message received:', evType, data);
      
      // Reactive reload based on event types
      if (evType === 'INVENTORY_UPDATED') {
        Promise.all([
          loadRawMaterials(),
          loadWorkers(),
          loadWorkerShifts()
        ]).then(() => { renderAll(); });
      } else if (evType === 'PRODUCTION_STARTED' || evType === 'PRODUCTION_UPDATED') {
        loadProductionBatches().then(() => { loadFinishedGoods().then(() => { renderAll(); }); });
      } else if (evType === 'ORDER_CREATED' || evType === 'ORDER_UPDATED' || evType === 'ORDER_CANCELLED') {
        loadOrders().then(() => { loadFinishedGoods().then(() => { loadProductionBatches().then(() => { loadDistributors().then(() => { renderAll(); }); }); }); });
      } else if (evType === 'FINISHED_GOOD_STOCK_UPDATED') {
        loadFinishedGoods().then(() => { renderAll(); });

      } else if (evType === 'SETTINGS_UPDATED') {
        loadSettings().then(() => { renderAll(); });
      } else if (evType === 'DISTRIBUTORS_UPDATED') {
        Promise.all([loadDistributors(), loadOrders()]).then(() => { renderAll(); });
      }
      
      // Always reload audit logs
      loadAuditLogs().then(renderAuditLogsScreen);
    };
    ws.onclose = () => {
      const dot = document.querySelector('.status-dot');
      if (dot) dot.className = 'status-dot';
      if (connStatusEl) {
        connStatusEl.innerHTML = '<span class="status-dot"></span> Websocket Offline (Reconnecting...)';
      }
      // Attempt reconnect in 5s
      setTimeout(setupWS, 5000);
    };
    ws.onerror = () => {
      // Quietly log connection errors
      console.log('Websocket connection error.');
    };
  } catch (err) {
    console.error('WebSocket connection failed:', err);
  }
}

// ==========================================
// 📥 API REQUEST HANDLERS
// ==========================================
async function apiGet(path) {
  const url = path.startsWith('/') ? `${BACKEND_URL}${path}` : path;
  const res = await fetch(url, {
    headers: getRequestHeaders()
  });
  return await res.json();
}

async function apiPost(path, body) {
  const url = path.startsWith('/') ? `${BACKEND_URL}${path}` : path;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getRequestHeaders() },
    body: JSON.stringify({ ...body, user_role: state.activeRole, user_name: userDisplayName.textContent })
  });
  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.error || 'API Error');
  }
  return await res.json();
}

async function apiPut(path, body) {
  const url = path.startsWith('/') ? `${BACKEND_URL}${path}` : path;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getRequestHeaders() },
    body: JSON.stringify({ ...body, user_role: state.activeRole, user_name: userDisplayName.textContent })
  });
  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.error || 'API Error');
  }
  return await res.json();
}

async function apiDelete(path) {
  const url = path.startsWith('/') ? `${BACKEND_URL}${path}` : path;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...getRequestHeaders() },
    body: JSON.stringify({ user_role: state.activeRole, user_name: userDisplayName.textContent })
  });
  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.error || 'API Error');
  }
  return await res.json();
}

// Fetchers
async function loadSettings() {
  try {
    state.settings = await apiGet('/api/v1/settings');
    const gstInput = document.getElementById('gst-rate-input');
    if (gstInput && state.settings.gst_rate !== undefined) {
      gstInput.value = (state.settings.gst_rate * 100).toFixed(1).replace('.0', '');
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

async function loadRawMaterials() {
  const data = await apiGet('/api/v1/inventory/raw-materials');
  state.rawMaterials = data.rawMaterials;
  state.inventoryBatches = data.batches;
}

async function loadRecipes() {
  state.recipes = await apiGet('/api/v1/recipes');
}

async function loadProductionBatches() {
  state.productionBatches = await apiGet('/api/v1/production/batches');
}

async function loadFinishedGoods() {
  state.finishedGoods = await apiGet('/api/v1/finished-goods');
}

async function loadOrders() {
  state.orders = await apiGet('/api/v1/sales/orders');
  state.rebuildMonthlySelect = true;
}



async function loadAuditLogs() {
  if (state.activeRole === 'ADMIN') {
    state.auditLogs = await apiGet('/api/v1/audit-trails');
  }
}

async function loadWorkers() {
  try {
    state.workers = await apiGet('/api/v1/workers');
  } catch (err) {
    console.error('Failed to load workers:', err);
  }
}

async function loadWorkerShifts() {
  try {
    state.workerShifts = await apiGet('/api/v1/workers/shifts');
  } catch (err) {
    console.error('Failed to load worker shifts:', err);
  }
}

// ==========================================
// 🛠️ NAVIGATION & ACCESS CONTROL (RBAC)
// ==========================================
window.viewOrderInvoice = function(orderId) {
  invoiceFrame.src = BACKEND_URL ? `${BACKEND_URL}/api/v1/sales/orders/${orderId}/invoice` : `/api/v1/sales/orders/${orderId}/invoice`;
  openModal('modal-invoice-viewer');
};

async function loadDistributors() {
  try {
    state.distributors = await apiGet('/api/v1/distributors');
    
    // Populate checkout datalist
    const datalist = document.getElementById('distributor-list');
    if (datalist) {
      datalist.innerHTML = '';
      state.distributors.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name;
        datalist.appendChild(opt);
      });
    }


  } catch (err) {
    console.error('Failed to load distributors:', err);
  }
}

function setupNavigation() {


  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const screenId = btn.getAttribute('data-screen');
      switchScreen(screenId);
    });
  });
}

function switchScreen(screenId) {
  state.activeScreen = screenId;
  
  // Highlight nav button
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-screen') === screenId);
  });
  
  // Display screen section
  document.querySelectorAll('.screen-view').forEach(view => {
    view.classList.toggle('active', view.id === `screen-${screenId}`);
  });

  // Set titles
  let title = 'Dashboard';
  let subtitle = 'Albelly Ice Cream ERP';
  if (screenId === 'sales-desk') {
    title = 'Interactive Sales & Billing Desk';
    subtitle = 'Distributor order book POS and dispatch queuing';
  } else if (screenId === 'audit-logs') {
    title = 'Immutable Audit Trail Ledger';
    subtitle = 'System write audit events matching database hooks';
  } else if (screenId === 'financial-full-year') {
    title = 'Full Year Financials Analysis';
    subtitle = 'Comprehensive annual revenue, profit margins, and GST auditing';
  } else if (screenId === 'monthly-dashboard') {
    title = 'Monthly Operations Dashboard';
    subtitle = 'Monthly billing, production output, and resource consumption';
    state.rebuildMonthlySelect = true;
  } else if (screenId === 'raw-materials') {
    title = 'Raw Material Stock & Safety Matrix';
    subtitle = 'Ingredient inventory levels, safety thresholds, and replenishment status';
  } else if (screenId === 'cold-room') {
    title = 'Cold Room Finished Goods Stock';
    subtitle = 'Finished goods inventory logs, cold-chain temperature metrics, and valuations';
  } else if (screenId === 'product-bridge') {
    title = 'Product Description & Production Bridge';
    subtitle = 'Bridge raw materials, finished product templates, and historical lot consumption';
  } else if (screenId === 'workers') {
    title = 'Worker Attendance & Payroll Dashboard';
    subtitle = 'Register workers, manage hourly rates, track shifts, and process payroll logs';
  } else if (screenId === 'distributors') {
    title = '➕ Ledger Directory';
    subtitle = 'Manage registered Party Ledgers (Distributors), contact details, and GSTINs';
  }
  
  screenTitle.textContent = title;
  screenSubtitle.textContent = subtitle;
  
  renderAll();
}

function applyRoleRestrictions() {
  const salesBtn = document.getElementById('nav-sales-desk');
  const auditsBtn = document.getElementById('nav-audits');
  const finFullBtn = document.getElementById('nav-financial-full-year');
  const monthlyBtn = document.getElementById('nav-monthly-dashboard');
  const rawBtn = document.getElementById('nav-raw-materials');
  const coldBtn = document.getElementById('nav-cold-room');
  const bridgeBtn = document.getElementById('nav-product-bridge');
  const workersBtn = document.getElementById('nav-workers');
  const distBtn = document.getElementById('nav-distributors');
  const gstSetting = document.getElementById('gst-setting-container');
  
  const role = state.activeRole || 'ADMIN';

  // 1. Hide/Show Nav Buttons based on user role module access
  if (salesBtn) salesBtn.style.display = (role === 'ADMIN' || role === 'SALES_AGENT') ? 'block' : 'none';
  if (finFullBtn) finFullBtn.style.display = (role === 'ADMIN') ? 'block' : 'none';
  if (monthlyBtn) monthlyBtn.style.display = (role === 'ADMIN') ? 'block' : 'none';
  if (rawBtn) rawBtn.style.display = (role === 'ADMIN' || role === 'INVENTORY_MANAGER') ? 'block' : 'none';
  if (coldBtn) coldBtn.style.display = (role === 'ADMIN' || role === 'INVENTORY_MANAGER') ? 'block' : 'none';
  if (bridgeBtn) bridgeBtn.style.display = (role === 'ADMIN' || role === 'PRODUCTION_SUPERVISOR') ? 'block' : 'none';
  if (workersBtn) workersBtn.style.display = (role === 'ADMIN' || role === 'PRODUCTION_SUPERVISOR') ? 'block' : 'none';
  if (distBtn) distBtn.style.display = (role === 'ADMIN' || role === 'SALES_AGENT' || role === 'INVENTORY_MANAGER') ? 'block' : 'none';
  if (auditsBtn) auditsBtn.style.display = (role === 'ADMIN') ? 'block' : 'none';
  if (gstSetting) gstSetting.style.display = (role === 'ADMIN') ? 'block' : 'none';

  // 2. Fallback active screen if current screen is restricted
  const allowedScreens = [];
  if (role === 'ADMIN') {
    allowedScreens.push('sales-desk', 'financial-full-year', 'monthly-dashboard', 'raw-materials', 'cold-room', 'product-bridge', 'workers', 'distributors', 'audit-logs');
  } else if (role === 'INVENTORY_MANAGER') {
    allowedScreens.push('raw-materials', 'cold-room', 'distributors');
  } else if (role === 'PRODUCTION_SUPERVISOR') {
    allowedScreens.push('product-bridge', 'workers');
  } else if (role === 'SALES_AGENT') {
    allowedScreens.push('sales-desk', 'distributors');
  }

  if (!allowedScreens.includes(state.activeScreen)) {
    const fallback = allowedScreens[0] || 'sales-desk';
    switchScreen(fallback);
  }
}

function setupRoleManager() {
  const roleSelect = document.getElementById('role-select');
  if (roleSelect) {
    // Sync UI dropdown to actual active role
    roleSelect.value = state.activeRole || 'ADMIN';

    // Add change event listener for dynamic role switching in mock/testing bypass mode
    roleSelect.addEventListener('change', (e) => {
      const selectedRole = e.target.value;
      state.activeRole = selectedRole;
      
      // Update local storage bypass role if previously set
      const bypassUser = localStorage.getItem('bypass_user');
      if (bypassUser) {
        const u = JSON.parse(bypassUser);
        u.role = selectedRole;
        localStorage.setItem('bypass_user', JSON.stringify(u));
      }

      // Update mock user display name
      let mockUser = 'System Admin';
      if (selectedRole === 'INVENTORY_MANAGER') mockUser = 'Vikram (Inv Mgr)';
      else if (selectedRole === 'PRODUCTION_SUPERVISOR') mockUser = 'Rajesh (Prod Supv)';
      else if (selectedRole === 'SALES_AGENT') mockUser = 'Priya (Sales Desk)';
      userDisplayName.textContent = mockUser;

      applyRoleRestrictions();
      renderAll();
    });
  }
}

// Check role permissions for interactive actions
function hasPermission(action) {
  const role = state.activeRole || 'ADMIN';
  if (role === 'ADMIN') return true;

  if (action === 'ADD_INVENTORY') {
    return role === 'INVENTORY_MANAGER';
  }
  if (action === 'EDIT_DISTRIBUTOR') {
    return role === 'SALES_AGENT' || role === 'INVENTORY_MANAGER';
  }
  if (action === 'TRANSITION_PRODUCTION') {
    return role === 'PRODUCTION_SUPERVISOR';
  }
  if (action === 'CREATE_ORDER') {
    return role === 'SALES_AGENT';
  }

  return false;
}

// ==========================================
// 📱 MOBILE SIDEBAR SYSTEM
// ==========================================
function setupMobileSidebar() {
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebar = document.querySelector('.sidebar');
  if (!sidebarToggle || !sidebar) return;

  let overlay = document.querySelector('.sidebar-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);
  }

  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('mobile-open');
    overlay.classList.toggle('active');
  });

  overlay.addEventListener('click', () => {
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('active');
  });

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('active');
    });
  });
}

// ==========================================
// 💡 THEME MANAGER
// ==========================================
function setupThemeToggle() {
  const isDark = localStorage.getItem('isDarkMode') !== 'false';
  state.isDarkMode = isDark;
  document.body.classList.toggle('light-mode', !isDark);
  themeToggle.innerHTML = isDark ? '<span>☀️</span> Light Mode' : '<span>🌙</span> Dark Mode';

  themeToggle.addEventListener('click', () => {
    state.isDarkMode = !state.isDarkMode;
    localStorage.setItem('isDarkMode', state.isDarkMode);
    document.body.classList.toggle('light-mode', !state.isDarkMode);
    themeToggle.innerHTML = state.isDarkMode ? '<span>☀️</span> Light Mode' : '<span>🌙</span> Dark Mode';
    renderAll();
  });
}

// ==========================================
// 🧱 MODALS SYSTEM
// ==========================================
function setupModalCloses() {
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close');
      document.getElementById(modalId).classList.remove('active');
    });
  });
}

function openModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

// ==========================================
// 🏭 SCREEN A: FACTORY FLOOR MONITORING
// ==========================================
function renderMetrics() {
  // Metric B: Dairy gauge levels
  const milkStock = state.rawMaterials.find(r => r.SKU === 'RM-MILK-01')?.current_stock || 0;
  const creamStock = state.rawMaterials.find(r => r.SKU === 'RM-CREAM-02')?.current_stock || 0;
  const totalDairy = milkStock + creamStock;
  const maxDairy = 3000; // Capacity assumption (Milk 2000L + Cream 1000L)
  const percentage = Math.min(Math.round((totalDairy / maxDairy) * 100), 100);

  // SVG Gauge calculations
  // Path length standard is approx 125.6 (half circle stroke radius 40)
  const dashoffset = 125.6 - (125.6 * percentage) / 100;
  document.getElementById('dairy-gauge-fill').style.strokeDashoffset = dashoffset;
  document.getElementById('dairy-level-text').textContent = `${Math.round(totalDairy)}L (${percentage}%)`;

  // Metric C: Cold room total pieces
  const coldPieces = state.finishedGoods.reduce((sum, item) => sum + item.stock_qty, 0);
  document.getElementById('metric-cold-room').textContent = `${coldPieces} pcs`;


}

function renderFactoryScreen() {
  renderMetrics();
  renderKanbanBoard();
}

function renderKanbanBoard() {
  const columns = {
    'MIXING': { cardsEl: document.getElementById('cards-mixing'), countEl: document.getElementById('count-mixing'), nextStatus: 'AGING', nextLabel: 'Start Aging ⏳' },
    'AGING': { cardsEl: document.getElementById('cards-aging'), countEl: document.getElementById('count-aging'), nextStatus: 'CHURNING_FREEZING', nextLabel: 'Churn & Freeze 🌀' },
    'CHURNING_FREEZING': { cardsEl: document.getElementById('cards-churning'), countEl: document.getElementById('count-churning'), nextStatus: 'HARDENING', nextLabel: 'Start Hardening ❄️' },
    'HARDENING': { cardsEl: document.getElementById('cards-hardening'), countEl: document.getElementById('count-hardening'), nextStatus: 'COMPLETED', nextLabel: 'Complete ✅' }
  };

  // Reset columns
  Object.keys(columns).forEach(status => {
    if (columns[status].cardsEl) columns[status].cardsEl.innerHTML = '';
    if (columns[status].countEl) columns[status].countEl.textContent = '0';
  });

  const activeBatches = (state.productionBatches || []).filter(b => columns[b.status]);

  activeBatches.forEach(batch => {
    const col = columns[batch.status];
    if (!col) return;

    // Increment count
    col.countEl.textContent = parseInt(col.countEl.textContent) + 1;

    // Create card element
    const card = document.createElement('div');
    card.className = 'kanban-card';
    
    // Add border-left style based on status
    if (batch.status === 'MIXING') card.style.borderLeftColor = 'var(--cobalt)';
    else if (batch.status === 'AGING') card.style.borderLeftColor = 'var(--soft-amber)';
    else if (batch.status === 'CHURNING_FREEZING') card.style.borderLeftColor = 'var(--ice-blue)';
    else if (batch.status === 'HARDENING') card.style.borderLeftColor = 'var(--mint-green)';

    // Timer/duration html
    let timerHtml = '';
    if (batch.status === 'AGING' && batch.aging_end_time) {
      timerHtml = `
        <div class="card-timer-row">
          <span>⏳</span>
          <span class="aging-timer" data-endtime="${batch.aging_end_time}">Calculating...</span>
        </div>
      `;
    } else {
      timerHtml = `
        <div class="card-timer-row" style="color: var(--text-muted);">
          <span>⏱️</span>
          <span class="live-batch-duration" data-starttime="${batch.start_time}">0m 0s</span>
        </div>
      `;
    }

    // Actions html (only if supervisor/admin has permission)
    let actionsHtml = '';
    if (hasPermission('TRANSITION_PRODUCTION')) {
      actionsHtml = `
        <div class="card-actions-row">
          <button class="btn btn-danger action-dot-btn" onclick="transitionBatch(${batch.id}, 'FAILED')">Fail ❌</button>
          <button class="btn btn-primary action-dot-btn" onclick="transitionBatch(${batch.id}, '${col.nextStatus}')">${col.nextLabel}</button>
        </div>
      `;
    } else {
      actionsHtml = `
        <div class="card-actions-row" style="font-size: 10px; color: var(--text-muted); justify-content: center; width: 100%;">
          <span>Read-Only</span>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="card-title-row">
        <span class="card-code">${batch.batch_code}</span>
      </div>
      <div class="card-flavor">${batch.flavor_name}</div>
      ${timerHtml}
      ${actionsHtml}
    `;

    col.cardsEl.appendChild(card);
  });
}

// Transition batch states
async function transitionBatch(batchId, nextStatus) {
  try {
    await apiPut(`/api/v1/production/batches/${batchId}/status`, { status: nextStatus });
  } catch (err) {
    alert('Failed to update status: ' + err.message);
  }
}



// ==========================================
// 💰 SCREEN B: SALES POS & INVOICING
// ==========================================

// Customer-specific price overrides stored per cart session
// Format: { "Product Name": overriddenPrice }
if (!state.cartPriceOverrides) state.cartPriceOverrides = {};
if (!state.tallyVoucher) {
  state.tallyVoucher = {
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/ /g, '-'),
    partyName: '',
    narration: '',
    gstType: 'gst',
    rows: [
      { name: '', qty: '', rate: '', unit: '', amount: 0 }
    ],
    activeRowIndex: 0,
    activeCell: '',
    helperList: [],
    helperSelectedIndex: 0
  };
}


function getProductCategory(prod) {
  const name = (prod.name || '').toLowerCase();
  const sku = (prod.SKU || '').toLowerCase();
  if (name.includes('brick') || sku.includes('brick')) return 'Bricks';
  if (name.includes('cone') || sku.includes('cone')) return 'Cones';
  if (name.includes('tub') || sku.includes('tub')) return 'Tubs';
  if (name.includes('kulfi') || sku.includes('kulfi')) return 'Kulfi';
  return 'Special'; // default for Special Items
}

function renderInvoicesLedger() {
  const tableBody = document.getElementById('pos-invoices-table-body');
  const countLabel = document.getElementById('invoice-ledger-count');
  if (!tableBody) return;

  tableBody.innerHTML = '';
  const orders = state.orders || [];
  
  if (countLabel) {
    countLabel.textContent = `Total: ${orders.length} invoices`;
  }

  if (orders.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 20px;">No invoices or bills have been generated yet.</td></tr>`;
    return;
  }

  orders.forEach(order => {
    const subtotal = order.total_amount - order.tax_amount;
    const isGst = order.gst_rate > 0;
    const billingTypeBadge = isGst 
      ? `<span style="font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: rgba(56, 189, 248, 0.15); color: #38bdf8;">📄 GST (${(order.gst_rate * 100).toFixed(0)}%)</span>`
      : `<span style="font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: rgba(148, 163, 184, 0.15); color: #94a3b8;">🧾 Non-GST / Cash</span>`;

    const statusClass = order.status === 'COMPLETED' ? 'status-completed' : order.status === 'DISPATCHED' ? 'status-dispatched' : 'status-pending';
    const statusSelect = `
      <select class="tally-status-select ${statusClass}" onchange="changeOrderStatus(${order.id}, this.value)">
        <option value="PENDING" ${order.status === 'PENDING' ? 'selected' : ''}>PENDING</option>
        <option value="DISPATCHED" ${order.status === 'DISPATCHED' ? 'selected' : ''}>DISPATCHED</option>
        <option value="COMPLETED" ${order.status === 'COMPLETED' ? 'selected' : ''}>COMPLETED</option>
      </select>
    `;

    const paymentStatus = order.payment_status || 'UNPAID';
    const paymentClass = paymentStatus === 'PAID' ? 'status-paid' : 'status-unpaid';
    const paymentSelect = `
      <select class="tally-status-select ${paymentClass}" onchange="changeOrderPaymentStatus(${order.id}, this.value)">
        <option value="UNPAID" ${paymentStatus === 'UNPAID' ? 'selected' : ''}>UNPAID</option>
        <option value="PAID" ${paymentStatus === 'PAID' ? 'selected' : ''}>PAID</option>
      </select>
    `;

    const orderDate = new Date(order.order_date).toLocaleString();

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${orderDate}</td>
      <td><code>${order.order_code}</code></td>
      <td><strong>${order.customer_name}</strong></td>
      <td>${billingTypeBadge}</td>
      <td>₹${subtotal.toFixed(2)}</td>
      <td>₹${order.tax_amount.toFixed(2)}</td>
      <td><strong>₹${order.total_amount.toFixed(2)}</strong></td>
      <td>${paymentSelect}</td>
      <td>${statusSelect}</td>
      <td>
        <button class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px; height: auto;" onclick="viewPosInvoice(${order.id})">🧾 View Invoice</button>
      </td>
    `;
    tableBody.appendChild(row);
  });
}

window.viewPosInvoice = function(orderId) {
  const invoiceFrame = document.getElementById('invoice-frame');
  if (invoiceFrame) {
    state.activeInvoiceOrderId = orderId;
    invoiceFrame.src = BACKEND_URL ? `${BACKEND_URL}/api/v1/sales/orders/${orderId}/invoice` : `/api/v1/sales/orders/${orderId}/invoice`;
    const btnClose = document.getElementById('btn-modal-close-invoice');
    if (btnClose) btnClose.style.display = 'block';
    openModal('modal-invoice-viewer');
  }
};

function renderSalesScreen() {
  renderInvoicesLedger();
  
  // Set default date if input is blank
  const dateInput = document.getElementById('tally-date-input');
  if (dateInput && !dateInput.value) {
    dateInput.value = state.tallyVoucher.date;
  }
  
  renderTallyTableRows();
  recalcTallyVoucherTotals();
  updateTallyHelperList();
}

// Worker Dashboard Actions (Admin only)
window.clockOutShift = async function(shiftId) {
  try {
    await apiPut(`/api/v1/workers/shifts/${shiftId}/clock-out`, {});
    await loadWorkerShifts();
    renderAll();
    alert('Worker clocked out successfully!');
  } catch (err) {
    alert('Failed to clock out: ' + err.message);
  }
};

window.toggleShiftPayment = async function(shiftId, isPaid) {
  try {
    await apiPut(`/api/v1/workers/shifts/${shiftId}/paid`, { is_paid: isPaid });
    await loadWorkerShifts();
    renderAll();
  } catch (err) {
    alert('Failed to update payment status: ' + err.message);
  }
};

window.deleteShiftLog = async function(shiftId) {
  if (confirm('Are you sure you want to delete this shift log? This cannot be undone.')) {
    try {
      await apiDelete(`/api/v1/workers/shifts/${shiftId}`);
      await loadWorkerShifts();
      renderAll();
    } catch (err) {
      alert('Failed to delete shift log: ' + err.message);
    }
  }
};

window.deleteWorker = async function(workerId, workerName) {
  if (confirm(`Are you sure you want to discontinue / remove worker "${workerName}"? All their shift logs will be deleted.`)) {
    try {
      await apiDelete(`/api/v1/workers/${workerId}`);
      await loadWorkers();
      await loadWorkerShifts();
      renderAll();
    } catch (err) {
      alert('Failed to delete worker: ' + err.message);
    }
  }
};

// Edit product base price (Admin only)
window.editProductPrice = async function(productId, productName, currentPrice) {
  const newPrice = prompt(`Edit base price for "${productName}"\n\nCurrent price: ₹${currentPrice.toFixed(2)}\n\nEnter new base price (₹):`, currentPrice.toFixed(2));
  
  if (newPrice === null) return; // Cancelled
  
  const parsed = parseFloat(newPrice);
  if (isNaN(parsed) || parsed <= 0) {
    alert('Please enter a valid positive number for the price.');
    return;
  }

  try {
    await apiPut(`/api/v1/finished-goods/${productId}/price`, { price: parsed });
    await loadFinishedGoods();
    renderAll();
  } catch (err) {
    alert('Failed to update price: ' + err.message);
  }
};

// Delete/Discontinue product (Admin only)
window.deleteProduct = async function(productId, productName) {
  if (confirm(`⚠️ Are you sure you want to discontinue and delete the product "${productName}"?\n\nThis will remove the product from the catalog entirely.`)) {
    try {
      await apiDelete(`/api/v1/finished-goods/${productId}`);
      // Remove from cart if present
      delete state.cart[productName];
      delete state.cartPriceOverrides[productName];
      await loadFinishedGoods();
      renderAll();
    } catch (err) {
      alert('Failed to delete product: ' + err.message);
    }
  }
};

// Adjust product stock quantity (Admin/Inv Manager)
window.adjustProductStock = async function(productId, productName, currentStock) {
  const newStock = prompt(`Adjust stock quantity for "${productName}"\n\nCurrent stock: ${currentStock} pcs\n\nEnter new stock quantity:`, currentStock);
  if (newStock === null) return; // Cancelled
  const parsed = parseInt(newStock);
  if (isNaN(parsed) || parsed < 0) {
    alert('Please enter a valid non-negative integer.');
    return;
  }
  try {
    await apiPut(`/api/v1/finished-goods/${productId}/stock`, { stock_qty: parsed });
    await loadFinishedGoods();
    renderAll();
  } catch (err) {
    alert('Failed to adjust stock: ' + err.message);
  }
};

// Handle customer-specific price override from cart
window.updateCartPriceOverride = function(prodName, inputEl) {
  const val = parseFloat(inputEl.value);
  if (isNaN(val) || val <= 0) {
    // Reset to default
    delete state.cartPriceOverrides[prodName];
  } else {
    state.cartPriceOverrides[prodName] = val;
  }
  // Re-render cart totals without full re-render to avoid losing focus
  recalcCartTotals();
};

function updateTallyHelperList() {
  const titleEl = document.getElementById('tally-helper-list-title');
  const bodyEl = document.getElementById('tally-helper-list-body');
  if (!titleEl || !bodyEl) return;

  const cell = state.tallyVoucher.activeCell;
  const index = state.tallyVoucher.activeRowIndex;

  if (cell === 'party') {
    titleEl.textContent = 'List of Ledger Accounts';
    const query = (state.tallyVoucher.partyName || '').toLowerCase();
    
    // Filter distributors
    const filtered = state.distributors.filter(d => 
      d.name.toLowerCase().includes(query) || (d.location && d.location.toLowerCase().includes(query))
    );

    state.tallyVoucher.helperList = filtered.map(d => ({ type: 'party', name: d.name, sub: d.location || 'No Location' }));
    
    if (state.tallyVoucher.helperSelectedIndex >= filtered.length) {
      state.tallyVoucher.helperSelectedIndex = Math.max(0, filtered.length - 1);
    }

    if (filtered.length === 0) {
      bodyEl.innerHTML = `<div style="padding: 15px; color: var(--text-muted); font-size: 11px;">No matching Ledgers found. Press Alt+C to create new.</div>`;
      return;
    }

    bodyEl.innerHTML = filtered.map((d, i) => `
      <div class="tally-list-item ${i === state.tallyVoucher.helperSelectedIndex ? 'selected' : ''}" data-index="${i}" onclick="selectTallyHelperItem(${i})">
        <strong>${d.name}</strong>
        <span style="font-size: 10px; color: var(--text-muted);">${d.location || ''}</span>
      </div>
    `).join('');
    
  } else if (cell === 'item-name') {
    titleEl.textContent = 'List of Stock Items';
    const row = state.tallyVoucher.rows[index];
    const query = (row ? row.name : '').toLowerCase();

    // Filter finished goods
    const filtered = state.finishedGoods.filter(fg => 
      fg.name.toLowerCase().includes(query) || fg.SKU.toLowerCase().includes(query)
    );

    state.tallyVoucher.helperList = filtered.map(fg => ({ 
      type: 'item', 
      name: fg.name, 
      sub: `${fg.stock_qty} ${fg.unit || 'pcs'} available`,
      stock: fg.stock_qty
    }));

    if (state.tallyVoucher.helperSelectedIndex >= filtered.length) {
      state.tallyVoucher.helperSelectedIndex = Math.max(0, filtered.length - 1);
    }

    if (filtered.length === 0) {
      bodyEl.innerHTML = `<div style="padding: 15px; color: var(--text-muted); font-size: 11px;">No matching Stock Items found.</div>`;
      return;
    }

    bodyEl.innerHTML = filtered.map((fg, i) => {
      let stockColor = 'var(--mint-green)';
      if (fg.stock_qty === 0) stockColor = 'var(--pastel-red)';
      else if (fg.stock_qty < 25) stockColor = 'var(--soft-amber)';

      const partyName = state.tallyVoucher.partyName;
      const lastPrice = getLastPriceForPartyItem(partyName, fg.name);
      const priceText = lastPrice !== null 
        ? `₹${lastPrice.toFixed(2)} (Custom)` 
        : `₹${fg.price.toFixed(2)}`;

      return `
        <div class="tally-list-item ${i === state.tallyVoucher.helperSelectedIndex ? 'selected' : ''}" data-index="${i}" onclick="selectTallyHelperItem(${i})">
          <div style="display: flex; flex-direction: column;">
            <strong>${fg.name}</strong>
            <span style="font-size: 9px; color: var(--text-muted); font-family: monospace;">${fg.SKU} - ${priceText}</span>
          </div>
          <span style="font-size: 10px; font-weight: bold; color: ${stockColor};">${fg.stock_qty} ${fg.unit || 'pcs'}</span>
        </div>
      `;
    }).join('');
    
  } else {
    // Clear helper list
    titleEl.textContent = 'Information Panel';
    bodyEl.innerHTML = `
      <div style="padding: 15px; color: var(--text-secondary); font-size: 11px; line-height: 1.5;">
        <div style="font-weight: bold; margin-bottom: 8px; color: #f59e0b;">VOUCHER KEYS:</div>
        <div>&bull; <kbd>Enter</kbd>: Next Field / Save Cell</div>
        <div>&bull; <kbd>Esc</kbd>: Cancel / Clear Form</div>
        <div>&bull; <kbd>Ctrl+A</kbd>: Accept/Save immediately</div>
        <div>&bull; <kbd>Alt+C</kbd>: Add New Ledger</div>
        <div>&bull; <kbd>Alt+A</kbd>: Add Product Row</div>
        <div>&bull; <kbd>F2</kbd>: Change Voucher Date</div>
      </div>
    `;
  }
}

async function loadLastPricesForCustomer(customerName) {
  try {
    state.lastPrices = await apiGet(`/api/v1/sales/last-prices?customer_name=${encodeURIComponent(customerName)}`);
  } catch (err) {
    console.error('Failed to load last prices:', err);
    state.lastPrices = {};
  }
}

function getLastPriceForPartyItem(partyName, itemName) {
  if (!state.lastPrices || !itemName) return null;
  return state.lastPrices[itemName] !== undefined ? state.lastPrices[itemName] : null;
}

window.selectTallyHelperItem = function(index) {
  const cell = state.tallyVoucher.activeCell;
  const rowIndex = state.tallyVoucher.activeRowIndex;
  const item = state.tallyVoucher.helperList[index];

  if (!item) return;

  if (item.type === 'party') {
    state.tallyVoucher.partyName = item.name;
    const input = document.getElementById('tally-party-input');
    if (input) {
      input.value = item.name;
    }
    
    // Use pre-calculated distributor balance directly
    const balance = item.balance || 0;
    const balanceEl = document.getElementById('tally-party-balance');
    if (balanceEl) {
      balanceEl.textContent = `₹${balance.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    }

    // Load last prices for custom pricing, then update rates and render
    loadLastPricesForCustomer(item.name).then(() => {
      state.tallyVoucher.rows.forEach((row, idx) => {
        if (row.name) {
          const fg = state.finishedGoods.find(f => f.name === row.name);
          if (fg) {
            const lastPrice = getLastPriceForPartyItem(item.name, fg.name);
            row.rate = lastPrice !== null ? lastPrice : fg.price;
            row.amount = (parseInt(row.qty) || 0) * row.rate;
          }
        }
      });

      renderTallyTableRows();
      recalcTallyVoucherTotals();

      state.tallyVoucher.activeCell = '';
      updateTallyHelperList();
    });

    // Focus on first row's item-name input
    setTimeout(() => {
      const firstRowInput = document.querySelector('.tally-item-name[data-index="0"]');
      if (firstRowInput) firstRowInput.focus();
    }, 10);

  } else if (item.type === 'item') {
    const row = state.tallyVoucher.rows[rowIndex];
    if (row) {
      const fg = state.finishedGoods.find(f => f.name === item.name);
      row.name = fg.name;
      row.resolvedName = fg.name;
      row.unit = fg.unit || 'pcs';
      
      const lastPrice = getLastPriceForPartyItem(state.tallyVoucher.partyName, fg.name);
      row.rate = lastPrice !== null ? lastPrice : fg.price;
      
      // Default quantity to 1 when selecting a new item
      if (!row.qty || row.qty <= 0) {
        row.qty = 1;
      }
      row.amount = row.qty * row.rate;

      // Update input fields in current row
      const nameInput = document.querySelector(`.tally-item-name[data-index="${rowIndex}"]`);
      if (nameInput) nameInput.value = fg.name;

      const qtyInput = document.querySelector(`.tally-item-qty[data-index="${rowIndex}"]`);
      if (qtyInput) qtyInput.value = row.qty;

      const rateInput = document.querySelector(`.tally-item-rate[data-index="${rowIndex}"]`);
      if (rateInput) rateInput.value = row.rate;

      const unitSpan = document.querySelector(`.tally-voucher-table tr[data-index="${rowIndex}"] .tally-item-unit`);
      if (unitSpan) unitSpan.textContent = fg.unit || 'pcs';

      // Update amount display in cell
      const rowEl = document.querySelector(`.tally-voucher-table tr[data-index="${rowIndex}"]`);
      if (rowEl) {
        rowEl.querySelector('td:nth-child(6)').textContent = `₹${row.amount.toFixed(2)}`;
      }

      recalcTallyVoucherTotals();

      state.tallyVoucher.activeCell = 'qty';
      updateTallyHelperList();

      // Focus on Qty input of current row and select content
      setTimeout(() => {
        const qtyInput = document.querySelector(`.tally-item-qty[data-index="${rowIndex}"]`);
        if (qtyInput) {
          qtyInput.focus();
          qtyInput.select();
        }
      }, 10);
    }
  }
}

function recalcTallyVoucherTotals() {
  let subtotal = 0;
  state.tallyVoucher.rows.forEach(row => {
    subtotal += parseFloat(row.amount || 0);
  });

  const includeGst = state.tallyVoucher.gstType === 'gst';
  const gstRateSetting = (state.settings && state.settings.gst_rate !== undefined) ? state.settings.gst_rate : 0.05;
  const gstRate = includeGst ? gstRateSetting : 0;
  
  const tax = subtotal * gstRate;
  const total = subtotal + tax;

  const gstLabel = document.getElementById('tally-gst-rate');
  if (gstLabel) gstLabel.textContent = (gstRateSetting * 100).toFixed(1).replace('.0', '');

  const taxRow = document.getElementById('tally-tax-row');
  if (taxRow) {
    taxRow.style.display = includeGst ? 'flex' : 'none';
  }

  document.getElementById('tally-subtotal').textContent = `₹${subtotal.toFixed(2)}`;
  document.getElementById('tally-tax').textContent = `₹${tax.toFixed(2)}`;
  document.getElementById('tally-total').textContent = `₹${total.toFixed(2)}`;
}

function renderTallyTableRows() {
  const tbody = document.getElementById('tally-voucher-table-body');
  if (!tbody) return;

  tbody.innerHTML = state.tallyVoucher.rows.map((row, index) => `
    <tr data-index="${index}">
      <td style="text-align: center; color: var(--text-muted); font-size: 11px;">${index + 1}</td>
      <td>
        <input type="text" class="tally-row-input tally-item-name" value="${row.name}" placeholder="Select Stock Item..." data-index="${index}" autocomplete="off">
      </td>
      <td>
        <input type="number" class="tally-row-input tally-item-qty" value="${row.qty}" style="text-align: right;" placeholder="0" min="1" data-index="${index}">
      </td>
      <td style="text-align: center; color: var(--text-secondary); font-size: 12px;">
        <span class="tally-item-unit">${row.unit || ''}</span>
      </td>
      <td>
        <input type="number" class="tally-row-input tally-item-rate" value="${row.rate}" style="text-align: right;" placeholder="0.00" min="0.01" step="0.01" data-index="${index}">
      </td>
      <td style="text-align: right; font-weight: bold; color: #fff;">
        ₹${parseFloat(row.amount || 0).toFixed(2)}
      </td>
      <td style="text-align: center;">
        <button type="button" class="tally-row-delete-btn" onclick="deleteTallyRow(${index})" title="Delete Row">&times;</button>
      </td>
    </tr>
  `).join('');

  attachTallyRowEventListeners();
}

window.addTallyRow = function() {
  const lastRow = state.tallyVoucher.rows[state.tallyVoucher.rows.length - 1];
  if (lastRow && !lastRow.name && !lastRow.qty && !lastRow.rate) {
    const lastInput = document.querySelector(`.tally-item-name[data-index="${state.tallyVoucher.rows.length - 1}"]`);
    if (lastInput) lastInput.focus();
    return;
  }

  state.tallyVoucher.rows.push({ name: '', qty: '', rate: '', unit: '', amount: 0, resolvedName: '' });
  renderTallyTableRows();
  
  setTimeout(() => {
    const newInput = document.querySelector(`.tally-item-name[data-index="${state.tallyVoucher.rows.length - 1}"]`);
    if (newInput) newInput.focus();
  }, 10);
};

window.deleteTallyRow = function(index) {
  state.tallyVoucher.rows.splice(index, 1);
  if (state.tallyVoucher.rows.length === 0) {
    state.tallyVoucher.rows.push({ name: '', qty: '', rate: '', unit: '', amount: 0, resolvedName: '' });
  }
  renderTallyTableRows();
  recalcTallyVoucherTotals();
};

window.resetTallyVoucher = function() {
  state.tallyVoucher = {
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/ /g, '-'),
    partyName: '',
    narration: '',
    gstType: 'gst',
    rows: [
      { name: '', qty: '', rate: '', unit: '', amount: 0, resolvedName: '' }
    ],
    activeRowIndex: 0,
    activeCell: '',
    helperList: [],
    helperSelectedIndex: 0
  };
  
  const partyInput = document.getElementById('tally-party-input');
  if (partyInput) partyInput.value = '';
  
  const balanceEl = document.getElementById('tally-party-balance');
  if (balanceEl) balanceEl.textContent = '₹0.00';
  
  const narrationInput = document.getElementById('tally-narration-input');
  if (narrationInput) narrationInput.value = '';
  
  const gstYes = document.getElementById('tally-gst-yes');
  if (gstYes) gstYes.checked = true;

  const dateInput = document.getElementById('tally-date-input');
  if (dateInput) dateInput.value = state.tallyVoucher.date;

  renderTallyTableRows();
  recalcTallyVoucherTotals();
  updateTallyHelperList();
};

function handleTallyHelperNavigation(e, callback) {
  const list = state.tallyVoucher.helperList;
  if (list.length === 0) {
    if (e.key === 'Enter') {
      e.preventDefault();
      callback();
    }
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    state.tallyVoucher.helperSelectedIndex = (state.tallyVoucher.helperSelectedIndex + 1) % list.length;
    updateTallyHelperList();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    state.tallyVoucher.helperSelectedIndex = (state.tallyVoucher.helperSelectedIndex - 1 + list.length) % list.length;
    updateTallyHelperList();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    callback();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    state.tallyVoucher.activeCell = '';
    updateTallyHelperList();
    e.target.blur();
  }
}

function resolveTallyItemByName(idx) {
  const row = state.tallyVoucher.rows[idx];
  if (!row || !row.name) return;

  // Find a matching finished good (exact match first, then case-insensitive, then prefix match)
  let fg = state.finishedGoods.find(f => f.name.toLowerCase() === row.name.toLowerCase());
  if (!fg) {
    fg = state.finishedGoods.find(f => f.name.toLowerCase().includes(row.name.toLowerCase()) || f.SKU.toLowerCase() === row.name.toLowerCase());
  }

  if (fg) {
    const nameChanged = (row.resolvedName || '') !== fg.name;
    row.name = fg.name;
    row.unit = fg.unit || 'pcs';
    if (nameChanged || !row.rate || row.rate === 0) {
      const lastPrice = getLastPriceForPartyItem(state.tallyVoucher.partyName, fg.name);
      row.rate = lastPrice !== null ? lastPrice : fg.price;
      row.resolvedName = fg.name;
    }
    if (!row.qty || row.qty <= 0) {
      row.qty = 1;
    }
    row.amount = row.qty * row.rate;

    // Update the DOM inputs and labels
    const nameInput = document.querySelector(`.tally-item-name[data-index="${idx}"]`);
    if (nameInput && nameInput.value !== fg.name) nameInput.value = fg.name;

    const qtyInput = document.querySelector(`.tally-item-qty[data-index="${idx}"]`);
    if (qtyInput && qtyInput.value != row.qty) qtyInput.value = row.qty;

    const rateInput = document.querySelector(`.tally-item-rate[data-index="${idx}"]`);
    if (rateInput && rateInput.value != row.rate) rateInput.value = row.rate;

    const unitSpan = document.querySelector(`.tally-voucher-table tr[data-index="${idx}"] .tally-item-unit`);
    if (unitSpan) unitSpan.textContent = fg.unit || 'pcs';

    const rowEl = document.querySelector(`.tally-voucher-table tr[data-index="${idx}"]`);
    if (rowEl) {
      rowEl.querySelector('td:nth-child(6)').textContent = `₹${row.amount.toFixed(2)}`;
    }
    
    recalcTallyVoucherTotals();
  }
}

function resolveTallyPartyName() {
  const partyInput = document.getElementById('tally-party-input');
  if (!partyInput) return;
  const name = partyInput.value.trim();
  if (!name) return;

  const match = state.distributors.find(d => d.name.toLowerCase() === name.toLowerCase() || (d.location && d.location.toLowerCase() === name.toLowerCase()));
  if (match) {
    state.tallyVoucher.partyName = match.name;
    partyInput.value = match.name;
    
    // Use pre-calculated distributor balance directly
    const balance = match.balance || 0;
    const balanceEl = document.getElementById('tally-party-balance');
    if (balanceEl) {
      balanceEl.textContent = `₹${balance.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    }

    // Load last prices for custom pricing, then update rates and render
    loadLastPricesForCustomer(match.name).then(() => {
      state.tallyVoucher.rows.forEach((row, idx) => {
        if (row.name) {
          const fg = state.finishedGoods.find(f => f.name === row.name);
          if (fg) {
            const lastPrice = getLastPriceForPartyItem(match.name, fg.name);
            row.rate = lastPrice !== null ? lastPrice : fg.price;
            row.amount = (parseInt(row.qty) || 0) * row.rate;
          }
        }
      });

      renderTallyTableRows();
      recalcTallyVoucherTotals();

      // Focus on first row's item-name input after rendering to prevent losing focus
      setTimeout(() => {
        const firstRowInput = document.querySelector('.tally-item-name[data-index="0"]');
        if (firstRowInput) {
          firstRowInput.focus();
        }
      }, 50);
    });
  }
}

function attachTallyRowEventListeners() {
  document.querySelectorAll('.tally-item-name').forEach(input => {
    const idx = parseInt(input.getAttribute('data-index'));
    input.onfocus = () => {
      state.tallyVoucher.activeCell = 'item-name';
      state.tallyVoucher.activeRowIndex = idx;
      state.tallyVoucher.helperSelectedIndex = 0;
      updateTallyHelperList();
    };
    input.oninput = () => {
      state.tallyVoucher.rows[idx].name = input.value;
      updateTallyHelperList();
    };
    input.onblur = () => {
      setTimeout(() => {
        resolveTallyItemByName(idx);
      }, 150);
    };
    input.onkeydown = (e) => {
      const list = state.tallyVoucher.helperList;
      if (list.length > 0 && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        handleTallyHelperNavigation(e, () => {});
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const qtyInput = document.querySelector(`.tally-item-qty[data-index="${idx}"]`);
        if (qtyInput) qtyInput.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextName = document.querySelector(`.tally-item-name[data-index="${idx + 1}"]`);
        if (nextName) {
          nextName.focus();
        } else {
          const narrationInput = document.getElementById('tally-narration-input');
          if (narrationInput) narrationInput.focus();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx > 0) {
          const prevName = document.querySelector(`.tally-item-name[data-index="${idx - 1}"]`);
          if (prevName) prevName.focus();
        } else {
          const partyInput = document.getElementById('tally-party-input');
          if (partyInput) partyInput.focus();
        }
      } else {
        handleTallyHelperNavigation(e, () => {
          if (!input.value.trim()) {
            const narrationInput = document.getElementById('tally-narration-input');
            if (narrationInput) narrationInput.focus();
          } else {
            const list = state.tallyVoucher.helperList;
            if (list && list.length > 0) {
              selectTallyHelperItem(state.tallyVoucher.helperSelectedIndex);
            } else {
              resolveTallyItemByName(idx);
              setTimeout(() => {
                const qtyInput = document.querySelector(`.tally-item-qty[data-index="${idx}"]`);
                if (qtyInput) {
                  qtyInput.focus();
                  qtyInput.select();
                }
              }, 50);
            }
          }
        });
      }
    };
  });

  document.querySelectorAll('.tally-item-qty').forEach(input => {
    const idx = parseInt(input.getAttribute('data-index'));
    input.onfocus = () => {
      resolveTallyItemByName(idx);
      state.tallyVoucher.activeCell = 'qty';
      state.tallyVoucher.activeRowIndex = idx;
      updateTallyHelperList();
    };
    input.oninput = () => {
      const qtyVal = parseInt(input.value);
      const row = state.tallyVoucher.rows[idx];
      if (!isNaN(qtyVal) && qtyVal > 0) {
        row.qty = qtyVal;
        row.amount = qtyVal * (parseFloat(row.rate) || 0);
      } else {
        row.qty = '';
        row.amount = 0;
      }
      
      const rowEl = document.querySelector(`.tally-voucher-table tr[data-index="${idx}"]`);
      if (rowEl) {
        rowEl.querySelector('td:nth-child(6)').textContent = `₹${(row.amount || 0).toFixed(2)}`;
      }
      recalcTallyVoucherTotals();
    };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const nameInput = document.querySelector(`.tally-item-name[data-index="${idx}"]`);
        if (nameInput) nameInput.focus();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const rateInput = document.querySelector(`.tally-item-rate[data-index="${idx}"]`);
        if (rateInput) rateInput.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextQty = document.querySelector(`.tally-item-qty[data-index="${idx + 1}"]`);
        if (nextQty) {
          nextQty.focus();
        } else {
          const narrationInput = document.getElementById('tally-narration-input');
          if (narrationInput) narrationInput.focus();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx > 0) {
          const prevQty = document.querySelector(`.tally-item-qty[data-index="${idx - 1}"]`);
          if (prevQty) prevQty.focus();
        } else {
          const partyInput = document.getElementById('tally-party-input');
          if (partyInput) partyInput.focus();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const qtyVal = parseInt(input.value);
        const row = state.tallyVoucher.rows[idx];
        if (!row.name) {
          alert("Please select a stock item first.");
          const nameInput = document.querySelector(`.tally-item-name[data-index="${idx}"]`);
          if (nameInput) nameInput.focus();
          return;
        }

        const fg = state.finishedGoods.find(f => f.name === row.name);
        if (!fg) return;

        if (isNaN(qtyVal) || qtyVal <= 0) {
          alert("Please enter a valid quantity.");
          return;
        }

        if (qtyVal > fg.stock_qty) {
          alert(`Insufficient stock. Available stock is ${fg.stock_qty} pcs for "${fg.name}".`);
          return;
        }

        row.qty = qtyVal;
        row.amount = qtyVal * (row.rate || 0);

        const rowEl = document.querySelector(`.tally-voucher-table tr[data-index="${idx}"]`);
        if (rowEl) {
          rowEl.querySelector('td:nth-child(6)').textContent = `₹${row.amount.toFixed(2)}`;
        }

        recalcTallyVoucherTotals();

        const rateInput = document.querySelector(`.tally-item-rate[data-index="${idx}"]`);
        if (rateInput) {
          rateInput.focus();
          rateInput.select();
        }
      }
    };
  });

  document.querySelectorAll('.tally-item-rate').forEach(input => {
    const idx = parseInt(input.getAttribute('data-index'));
    input.onfocus = () => {
      resolveTallyItemByName(idx);
      state.tallyVoucher.activeCell = 'rate';
      state.tallyVoucher.activeRowIndex = idx;
      updateTallyHelperList();
    };
    input.oninput = () => {
      const rateVal = parseFloat(input.value);
      const row = state.tallyVoucher.rows[idx];
      if (!isNaN(rateVal) && rateVal >= 0) {
        row.rate = rateVal;
        row.amount = (parseInt(row.qty) || 0) * rateVal;
      } else {
        row.rate = '';
        row.amount = 0;
      }
      
      const rowEl = document.querySelector(`.tally-voucher-table tr[data-index="${idx}"]`);
      if (rowEl) {
        rowEl.querySelector('td:nth-child(6)').textContent = `₹${(row.amount || 0).toFixed(2)}`;
      }
      recalcTallyVoucherTotals();
    };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const qtyInput = document.querySelector(`.tally-item-qty[data-index="${idx}"]`);
        if (qtyInput) qtyInput.focus();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const nextName = document.querySelector(`.tally-item-name[data-index="${idx + 1}"]`);
        if (nextName) {
          nextName.focus();
        } else {
          const narrationInput = document.getElementById('tally-narration-input');
          if (narrationInput) narrationInput.focus();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextRate = document.querySelector(`.tally-item-rate[data-index="${idx + 1}"]`);
        if (nextRate) {
          nextRate.focus();
        } else {
          const narrationInput = document.getElementById('tally-narration-input');
          if (narrationInput) narrationInput.focus();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx > 0) {
          const prevRate = document.querySelector(`.tally-item-rate[data-index="${idx - 1}"]`);
          if (prevRate) prevRate.focus();
        } else {
          const partyInput = document.getElementById('tally-party-input');
          if (partyInput) partyInput.focus();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const rateVal = parseFloat(input.value);
        const row = state.tallyVoucher.rows[idx];

        if (isNaN(rateVal) || rateVal <= 0) {
          alert("Please enter a valid price/rate.");
          return;
        }

        row.rate = rateVal;
        row.amount = (row.qty || 0) * rateVal;

        const rowEl = document.querySelector(`.tally-voucher-table tr[data-index="${idx}"]`);
        if (rowEl) {
          rowEl.querySelector('td:nth-child(6)').textContent = `₹${row.amount.toFixed(2)}`;
        }

        recalcTallyVoucherTotals();

        if (idx === state.tallyVoucher.rows.length - 1) {
          addTallyRow();
        } else {
          const nextNameInput = document.querySelector(`.tally-item-name[data-index="${idx + 1}"]`);
          if (nextNameInput) nextNameInput.focus();
        }
      }
    };
  });
}

window.openTallyAcceptDialog = function() {
  const validRows = state.tallyVoucher.rows.filter(row => row.name && row.qty > 0 && row.rate > 0);
  if (validRows.length === 0) {
    alert("Voucher is empty. Please add at least one stock item to accept.");
    return;
  }
  if (!state.tallyVoucher.partyName) {
    alert("Please select a Party Ledger (Distributor) to accept.");
    const partyInput = document.getElementById('tally-party-input');
    if (partyInput) partyInput.focus();
    return;
  }
  const overlay = document.getElementById('tally-accept-overlay');
  if (overlay) overlay.classList.add('active');
};

window.closeTallyAcceptDialog = function() {
  const overlay = document.getElementById('tally-accept-overlay');
  if (overlay) overlay.classList.remove('active');
  const narrationInput = document.getElementById('tally-narration-input');
  if (narrationInput) narrationInput.focus();
};

function setupTallyEventListeners() {
  const dateBtn = document.getElementById('shortcut-btn-date');
  if (dateBtn) {
    dateBtn.onclick = () => {
      const newDate = prompt("Enter Voucher Date (DD-MMM-YYYY):", state.tallyVoucher.date);
      if (newDate) {
        state.tallyVoucher.date = newDate;
        const dateInput = document.getElementById('tally-date-input');
        if (dateInput) dateInput.value = newDate;
      }
    };
  }

  const addPartyBtn = document.getElementById('shortcut-btn-add-party');
  if (addPartyBtn) {
    addPartyBtn.onclick = () => {
      openModal('modal-add-distributor');
    };
  }

  const addRowBtn = document.getElementById('shortcut-btn-add-row');
  if (addRowBtn) {
    addRowBtn.onclick = () => {
      addTallyRow();
    };
  }

  const printBtn = document.getElementById('shortcut-btn-print');
  if (printBtn) {
    printBtn.onclick = () => {
      processTallyCheckout(true);
    };
  }

  const acceptBtn = document.getElementById('shortcut-btn-accept');
  if (acceptBtn) {
    acceptBtn.onclick = () => {
      openTallyAcceptDialog();
    };
  }

  const resetBtn = document.getElementById('shortcut-btn-reset');
  if (resetBtn) {
    resetBtn.onclick = () => {
      if (confirm("Clear current voucher details? All entered rows will be lost.")) {
        resetTallyVoucher();
      }
    };
  }

  const gstYes = document.getElementById('tally-gst-yes');
  const gstNo = document.getElementById('tally-gst-no');
  [gstYes, gstNo].forEach(radio => {
    if (radio) {
      radio.onchange = () => {
        state.tallyVoucher.gstType = document.querySelector('input[name="tally-gst-opt"]:checked').value;
        recalcTallyVoucherTotals();
      };
    }
  });

  const dateInput = document.getElementById('tally-date-input');
  if (dateInput) {
    dateInput.onfocus = () => {
      state.tallyVoucher.activeCell = 'date';
      updateTallyHelperList();
    };
    dateInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        state.tallyVoucher.date = dateInput.value;
        const partyInput = document.getElementById('tally-party-input');
        if (partyInput) partyInput.focus();
      }
    };
  }

  const partyInput = document.getElementById('tally-party-input');
  if (partyInput) {
    partyInput.onfocus = () => {
      state.tallyVoucher.activeCell = 'party';
      state.tallyVoucher.helperSelectedIndex = 0;
      updateTallyHelperList();
    };
    partyInput.oninput = () => {
      state.tallyVoucher.partyName = partyInput.value;
      updateTallyHelperList();
    };
    partyInput.onblur = () => {
      setTimeout(() => {
        resolveTallyPartyName();
      }, 150);
    };
    partyInput.onkeydown = (e) => {
      handleTallyHelperNavigation(e, () => {
        selectTallyHelperItem(state.tallyVoucher.helperSelectedIndex);
      });
    };
  }

  const narrationInput = document.getElementById('tally-narration-input');
  if (narrationInput) {
    narrationInput.onfocus = () => {
      state.tallyVoucher.activeCell = 'narration';
      updateTallyHelperList();
    };
    narrationInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        state.tallyVoucher.narration = narrationInput.value.trim();
        openTallyAcceptDialog();
      }
    };
  }

  const btnAcceptYes = document.getElementById('btn-tally-accept-yes');
  const btnAcceptNo = document.getElementById('btn-tally-accept-no');
  if (btnAcceptYes) {
    btnAcceptYes.onclick = () => {
      processTallyCheckout(false);
      closeTallyAcceptDialog();
    };
  }
  if (btnAcceptNo) {
    btnAcceptNo.onclick = () => {
      closeTallyAcceptDialog();
    };
  }

  const btnTallyAddDist = document.getElementById('btn-tally-add-distributor');
  if (btnTallyAddDist) {
    btnTallyAddDist.onclick = () => {
      openModal('modal-add-distributor');
    };
  }
}

async function processTallyCheckout(autoPrint = false) {
  const canCheckout = hasPermission('CREATE_ORDER');
  if (!canCheckout) {
    alert("Access denied. You do not have permission to create sales orders.");
    return;
  }

  const customerName = (state.tallyVoucher.partyName || '').trim();
  if (!customerName) {
    alert('Please select a distributor.');
    const partyInput = document.getElementById('tally-party-input');
    if (partyInput) partyInput.focus();
    return;
  }

  const match = state.distributors.find(d => d.name.toLowerCase() === customerName.toLowerCase());
  if (!match) {
    alert(`Ledger "${customerName}" is not registered in the system.\n\nPlease register the distributor first by clicking Alt+C before accepting the voucher.`);
    return;
  }

  const items = state.tallyVoucher.rows
    .filter(row => row.name && row.qty > 0 && row.rate > 0)
    .map(row => ({
      name: row.name,
      quantity: parseInt(row.qty),
      price: parseFloat(row.rate)
    }));

  if (items.length === 0) {
    alert('Voucher items list is empty.');
    return;
  }

  const includeGst = state.tallyVoucher.gstType === 'gst';

  try {
    const result = await apiPost('/api/v1/sales/orders', {
      customer_name: customerName,
      items,
      include_gst: includeGst
    });

    resetTallyVoucher();
    
    await loadFinishedGoods();
    await loadOrders();
    renderAll();

    if (autoPrint) {
      invoiceFrame.onload = () => {
        try {
          invoiceFrame.contentWindow.print();
        } catch (e) {
          console.error('Auto print failed:', e);
        }
        invoiceFrame.onload = null;
      };
    } else {
      invoiceFrame.onload = null;
    }

    state.activeInvoiceOrderId = result.orderId;
    invoiceFrame.src = BACKEND_URL ? `${BACKEND_URL}/api/v1/sales/orders/${result.orderId}/invoice` : `/api/v1/sales/orders/${result.orderId}/invoice`;
    const btnClose = document.getElementById('btn-modal-close-invoice');
    if (btnClose) btnClose.style.display = 'none';
    openModal('modal-invoice-viewer');

  } catch (err) {
    alert('Checkout failed: ' + err.message);
  }
}

const btnModalPrintInvoice = document.getElementById('btn-modal-print-invoice');
if (btnModalPrintInvoice) {
  btnModalPrintInvoice.addEventListener('click', () => {
    const frame = document.getElementById('invoice-frame');
    if (frame && frame.contentWindow) {
      frame.contentWindow.print();
      closeModal('modal-invoice-viewer');
    }
  });
}

const btnModalCancelInvoice = document.getElementById('btn-modal-cancel-invoice');
if (btnModalCancelInvoice) {
  btnModalCancelInvoice.addEventListener('click', async () => {
    if (!state.activeInvoiceOrderId) return;
    if (confirm("Are you sure you want to cancel this invoice? This will delete the order and restore the finished goods stock.")) {
      try {
        await apiDelete(`/api/v1/sales/orders/${state.activeInvoiceOrderId}`);
        closeModal('modal-invoice-viewer');
        state.activeInvoiceOrderId = null;
        alert("Invoice cancelled and stock restored successfully.");
      } catch (err) {
        alert("Failed to cancel invoice: " + err.message);
      }
    }
  });
}

// ==========================================
// 📜 SCREEN D: SYSTEM AUDIT LEDGER
// ==========================================
function renderAuditLogsScreen() {
  const tableBody = document.getElementById('audit-logs-table-body');
  tableBody.innerHTML = '';

  if (state.activeRole !== 'ADMIN') {
    tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--pastel-red)">⛔ Access Denied. Audit Logs are restricted to Administrator Role only.</td></tr>`;
    return;
  }

  if (state.auditLogs.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No audit records captured in system.</td></tr>`;
    return;
  }

  state.auditLogs.forEach(log => {
    const row = document.createElement('tr');
    
    let changeSetHtml = '';
    if (log.new_value) {
      changeSetHtml = `
        <div><strong>New:</strong> <span class="code-snippet">${log.new_value}</span></div>
      `;
    }
    if (log.old_value) {
      changeSetHtml = `
        <div><strong>Old:</strong> <span class="code-snippet">${log.old_value}</span></div>
        ${changeSetHtml}
      `;
    }

    row.innerHTML = `
      <td>${log.timestamp}</td>
      <td><span class="badge badge-success" style="font-size: 8px;">${log.user_role}</span></td>
      <td><strong>${log.user_name}</strong></td>
      <td><code>${log.action}</code></td>
      <td>${log.table_name}</td>
      <td>${changeSetHtml || '<span style="color:var(--text-muted)">None</span>'}</td>
    `;
    tableBody.appendChild(row);
  });
}

// ==========================================
// ⏱️ LIVE TICKING SYSTEM TIMERS
// ==========================================
function tickLiveElements() {


  // 2. Tick Batch Aging countdown timers
  document.querySelectorAll('.aging-timer').forEach(el => {
    const endTime = new Date(el.getAttribute('data-endtime'));
    const secondsLeft = Math.floor((endTime - new Date()) / 1000);

    if (secondsLeft <= 0) {
      el.textContent = 'Ready for freezing!';
      el.style.color = 'var(--mint-green)';
    } else {
      const hrs = Math.floor(secondsLeft / 3600);
      const mins = Math.floor((secondsLeft % 3600) / 60);
      const secs = secondsLeft % 60;
      el.textContent = `${hrs > 0 ? hrs + 'h ' : ''}${mins}m ${secs}s left`;
    }
  });

  // 3. Tick Active Shift Duration timers
  document.querySelectorAll('.live-shift-duration').forEach(el => {
    const timeIn = new Date(el.getAttribute('data-timein'));
    const seconds = Math.floor((new Date() - timeIn) / 1000);
    
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    el.textContent = `${hrs > 0 ? hrs + 'h ' : ''}${mins}m ${secs}s`;
  });

  // 4. Tick Active Batch Duration timers
  document.querySelectorAll('.live-batch-duration').forEach(el => {
    const startTime = new Date(el.getAttribute('data-starttime'));
    const seconds = Math.floor((new Date() - startTime) / 1000);
    
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    el.textContent = `${hrs > 0 ? hrs + 'h ' : ''}${mins}m ${secs}s`;
  });
}

// Render coordinator
function renderAll() {
  if (state.activeScreen === 'sales-desk') renderSalesScreen();
  else if (state.activeScreen === 'audit-logs') renderAuditLogsScreen();
  else if (state.activeScreen === 'financial-full-year') renderFinancialFullYear();
  else if (state.activeScreen === 'monthly-dashboard') renderMonthlyDashboard();
  else if (state.activeScreen === 'raw-materials') renderRawMaterials();
  else if (state.activeScreen === 'cold-room') renderColdRoom();
  else if (state.activeScreen === 'product-bridge') renderProductBridgeScreen();
  else if (state.activeScreen === 'workers') renderWorkersScreen();
  else if (state.activeScreen === 'distributors') renderDistributorsScreen();
}

// ==========================================
// 📊 NEW DASHBOARDS CONTROLLERS
// ==========================================

// 1. FULL YEAR FINANCIAL DASHBOARD
async function renderFinancialFullYear() {
  try {
    const data = await apiGet('/api/v1/dashboard/financials/full-year');
    const orders = state.orders || [];

    // 1. Calculate cumulative total sales value
    const totalSalesValue = data.summary.totalRevenue;
    const totalSalesEl = document.getElementById('fin-total-sales-value');
    if (totalSalesEl) {
      totalSalesEl.textContent = `₹${totalSalesValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    }

    // 2. Set dynamic years labels from backend
    const y3 = data.summary.y3 || new Date().getFullYear();
    const y2 = data.summary.y2 || (y3 - 1);
    const y1 = data.summary.y1 || (y2 - 1);
    
    // Set variables for outer scope compatibility (like interactive YoY comparison timeline)
    const currentYear = y3;
    const pastYear = y2;

    const valY1El = document.getElementById('val-yearly-sales-y1');
    const lblY1El = document.getElementById('lbl-yearly-sales-y1');
    const valY2El = document.getElementById('val-yearly-sales-y2');
    const lblY2El = document.getElementById('lbl-yearly-sales-y2');
    const valY3El = document.getElementById('val-yearly-sales-y3');
    const lblY3El = document.getElementById('lbl-yearly-sales-y3');

    const getFYLabel = (year) => {
      const pad = (n) => n.toString().padStart(2, '0');
      return `FY ${pad((year - 1) % 100)}-${pad(year % 100)}`;
    };

    if (valY1El && lblY1El) {
      valY1El.textContent = `₹${data.summary.salesY1.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
      lblY1El.textContent = getFYLabel(y1);
    }
    if (valY2El && lblY2El) {
      valY2El.textContent = `₹${data.summary.salesY2.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
      lblY2El.textContent = getFYLabel(y2);
    }
    if (valY3El && lblY3El) {
      valY3El.textContent = `₹${data.summary.salesY3.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
      lblY3El.textContent = getFYLabel(y3);
    }

    const overallGrowth = data.summary.salesY2 > 0 ? ((data.summary.salesY3 - data.summary.salesY2) / data.summary.salesY2) * 100 : 0;
    const growthBadge = document.getElementById('val-yearly-sales-growth');
    if (growthBadge) {
      growthBadge.textContent = `${overallGrowth >= 0 ? '+' : ''}${overallGrowth.toFixed(1)}%`;
      growthBadge.className = `badge ${overallGrowth >= 0 ? 'badge-success' : 'badge-danger'}`;
    }

    // Draw YoY Sales Comparison Chart (3 bars)
    const ctxYearlyComp = document.getElementById('chart-yearly-sales-comparison').getContext('2d');
    if (charts.yearlySalesComparison) {
      charts.yearlySalesComparison.destroy();
    }
    charts.yearlySalesComparison = new Chart(ctxYearlyComp, {
      type: 'bar',
      data: {
        labels: [getFYLabel(y1), getFYLabel(y2), getFYLabel(y3)],
        datasets: [{
          label: 'Annual Sales (₹)',
          data: data.yearlySeries,
          backgroundColor: ['rgba(148, 163, 184, 0.45)', 'rgba(59, 130, 246, 0.55)', 'rgba(16, 185, 129, 0.65)'],
          borderColor: ['rgba(148, 163, 184, 1)', 'rgba(59, 130, 246, 1)', 'rgba(16, 185, 129, 1)'],
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: { ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569' }, grid: { display: false } },
          y: { ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569' }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });

    // 4. Render Distributor Sales Yearly Comparison Table
    const distBody = document.getElementById('distributor-yearly-comparison-body');
    if (distBody) {
      distBody.innerHTML = '';
      
      const hdrDistY1 = document.getElementById('hdr-dist-y1');
      if (hdrDistY1) hdrDistY1.textContent = `${getFYLabel(y1)} (₹)`;
      const hdrDistY2 = document.getElementById('hdr-dist-y2');
      if (hdrDistY2) hdrDistY2.textContent = `${getFYLabel(y2)} (₹)`;
      const hdrDistY3 = document.getElementById('hdr-dist-y3');
      if (hdrDistY3) hdrDistY3.textContent = `${getFYLabel(y3)} (₹)`;

      data.distributorYearlyComparison.forEach(d => {
        const growth = d.sales_y2 > 0 ? ((d.sales_y3 - d.sales_y2) / d.sales_y2) * 100 : 0;
        const row = document.createElement('tr');
        row.style.cursor = 'pointer';
        row.onclick = () => { viewDistributorDetails(d.name); };
        row.innerHTML = `
          <td><strong>${d.name}</strong></td>
          <td>₹${d.sales_y1.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
          <td>₹${d.sales_y2.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
          <td><strong>₹${d.sales_y3.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong></td>
          <td><span class="badge ${growth >= 0 ? 'badge-success' : 'badge-danger'}">${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%</span></td>
        `;
        distBody.appendChild(row);
      });
    }

    // 5. Interactive Distributor YoY Comparison Autocomplete Search Setup
    const input = document.getElementById('comparison-distributor-input');
    const datalist = document.getElementById('distributors-datalist');
    const distributors = state.distributors || [];
    if (input && datalist) {
      datalist.innerHTML = '';
      distributors.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name;
        datalist.appendChild(opt);
      });

      let defaultVal = state.selectedComparisonDistributor;
      if (!defaultVal || !distributors.some(d => d.name === defaultVal)) {
        defaultVal = distributors[0] ? distributors[0].name : '';
      }

      const newInput = input.cloneNode(true);
      input.parentNode.replaceChild(newInput, input);

      newInput.value = defaultVal;
      state.selectedComparisonDistributor = defaultVal;

      newInput.addEventListener('focus', (e) => {
        e.target.select();
      });

      newInput.addEventListener('change', (e) => {
        const val = e.target.value;
        const match = distributors.find(d => d.name.toLowerCase() === val.toLowerCase());
        if (match) {
          state.selectedComparisonDistributor = match.name;
          e.target.value = match.name;
          updateDistributorYoYComparison();
        } else {
          e.target.value = state.selectedComparisonDistributor || '';
        }
      });
    }

    // Helper to calculate and draw interactive YoY timeline (calls backend endpoint)
    async function updateDistributorYoYComparison() {
      const distName = state.selectedComparisonDistributor;
      if (!distName) return;

      try {
        const compData = await apiGet(`/api/v1/dashboard/distributors/${encodeURIComponent(distName)}/yoy-comparison`);
        
        const distComp2025El = document.getElementById('dist-comp-total-2025');
        if (distComp2025El) {
          distComp2025El.textContent = `₹${compData.totalPast.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
          distComp2025El.previousElementSibling.textContent = `${compData.pastYear} Total Purchase`;
        }
        const distComp2026El = document.getElementById('dist-comp-total-2026');
        if (distComp2026El) {
          distComp2026El.textContent = `₹${compData.totalCurrent.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
          distComp2026El.previousElementSibling.textContent = `${compData.currentYear} Total Purchase`;
        }

        const growth = compData.totalPast > 0 ? ((compData.totalCurrent - compData.totalPast) / compData.totalPast) * 100 : 0;
        const growthRateLabel = document.getElementById('dist-comp-growth-rate');
        if (growthRateLabel) {
          growthRateLabel.textContent = `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`;
          growthRateLabel.className = `badge ${growth >= 0 ? 'badge-success' : 'badge-danger'}`;
        }

        const ctxDistYoY = document.getElementById('chart-distributor-yoy-timeline').getContext('2d');
        if (charts.distributorYoYTimeline) {
          charts.distributorYoYTimeline.destroy();
        }

        charts.distributorYoYTimeline = new Chart(ctxDistYoY, {
          type: 'line',
          data: {
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
            datasets: [
              {
                label: `${compData.pastYear} Sales (₹)`,
                data: compData.monthlyPast,
                borderColor: '#94a3b8',
                backgroundColor: 'rgba(148, 163, 184, 0.05)',
                borderWidth: 2,
                fill: true,
                tension: 0.3
              },
              {
                label: `${compData.currentYear} Sales (₹)`,
                data: compData.monthlyCurrent,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.05)',
                borderWidth: 2.5,
                fill: true,
                tension: 0.3
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { labels: { color: state.isDarkMode ? '#f8fafc' : '#0f172a' } }
            },
            scales: {
              x: { ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569' }, grid: { color: 'rgba(255,255,255,0.05)' } },
              y: { ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569' }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
          }
        });
      } catch (err) {
        console.error('Failed to load distributor YoY comparison timeline:', err);
      }
    }

    // Call interactive chart drawing initially
    await updateDistributorYoYComparison();

    // 6. Render Recent Generated Invoices & Bills Log Table
    const logBody = document.getElementById('fin-invoices-log-body');
    const logCountEl = document.getElementById('fin-invoices-log-count');
    if (logBody) {
      logBody.innerHTML = '';
      if (logCountEl) {
        logCountEl.textContent = `Showing latest ${orders.length} transactions`;
      }

      orders.forEach(order => {
        const orderDate = new Date(order.order_date).toLocaleString();
        const isGst = order.gst_rate > 0;
        const billingModeBadge = isGst
          ? '<span class="badge badge-success" style="font-size:10px;">GST Invoice</span>'
          : '<span class="badge badge-secondary" style="font-size:10px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.1); color:var(--text-secondary);">Non-GST Bill</span>';

        const subtotal = order.total_amount - order.tax_amount;
        const statusClass = order.status === 'COMPLETED' ? 'status-completed' : order.status === 'DISPATCHED' ? 'status-dispatched' : 'status-pending';
        const statusSelect = `
          <select class="tally-status-select ${statusClass}" onchange="changeOrderStatus(${order.id}, this.value)">
            <option value="PENDING" ${order.status === 'PENDING' ? 'selected' : ''}>PENDING</option>
            <option value="DISPATCHED" ${order.status === 'DISPATCHED' ? 'selected' : ''}>DISPATCHED</option>
            <option value="COMPLETED" ${order.status === 'COMPLETED' ? 'selected' : ''}>COMPLETED</option>
          </select>
        `;

        const paymentStatus = order.payment_status || 'UNPAID';
        const paymentClass = paymentStatus === 'PAID' ? 'status-paid' : 'status-unpaid';
        const paymentSelect = `
          <select class="tally-status-select ${paymentClass}" onchange="changeOrderPaymentStatus(${order.id}, this.value)">
            <option value="UNPAID" ${paymentStatus === 'UNPAID' ? 'selected' : ''}>UNPAID</option>
            <option value="PAID" ${paymentStatus === 'PAID' ? 'selected' : ''}>PAID</option>
          </select>
        `;

        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${orderDate}</td>
          <td><code>${order.order_code}</code></td>
          <td><strong>${order.customer_name}</strong></td>
          <td>${billingModeBadge}</td>
          <td>₹${subtotal.toFixed(2)}</td>
          <td>₹${order.tax_amount.toFixed(2)}</td>
          <td><strong>₹${order.total_amount.toFixed(2)}</strong></td>
          <td>${paymentSelect}</td>
          <td>${statusSelect}</td>
          <td>
            <button class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px; height: auto;" onclick="viewPosInvoice(${order.id})">🧾 View Invoice</button>
          </td>
        `;
        logBody.appendChild(row);
      });
    }

  } catch (err) {
    console.error('Error rendering full year financials:', err);
  }
}

window.changeOrderStatus = async function(orderId, newStatus) {
  try {
    await apiPut(`/api/v1/sales/orders/${orderId}/status`, {
      status: newStatus,
      user_role: state.activeRole,
      user_name: 'Sales Desk'
    });
    // Refresh state and re-render all screens
    await loadOrders();
    renderAll();
    alert(`Order status updated to ${newStatus} successfully!`);
  } catch (err) {
    alert('Failed to update order status: ' + err.message);
    renderAll(); // reload to revert UI to last synced database state
  }
};

window.changeOrderPaymentStatus = async function(orderId, newPaymentStatus) {
  try {
    await apiPut(`/api/v1/sales/orders/${orderId}/payment`, {
      payment_status: newPaymentStatus,
      user_role: state.activeRole,
      user_name: 'Sales Desk'
    });
    // Refresh state and re-render all screens
    await loadOrders();
    renderAll();
    alert(`Order payment status updated to ${newPaymentStatus} successfully!`);
  } catch (err) {
    alert('Failed to update order payment status: ' + err.message);
    renderAll();
  }
};

// Distributor detailed analysis viewer (Admin only)
// Distributor detailed analysis viewer (Admin only)
window.viewDistributorDetails = async function(name) {
  try {
    const data = await apiGet(`/api/v1/dashboard/distributors/${encodeURIComponent(name)}`);
    
    // Update Modal Headers & Details
    document.getElementById('dist-modal-title').textContent = `👷 ${data.name} Performance Details`;
    
    // Update KPIs
    document.getElementById('dist-metric-revenue').textContent = `₹${data.summary.totalRevenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('dist-metric-tax').textContent = `₹${data.summary.totalTax.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('dist-metric-qty').textContent = `${data.summary.totalQty} pcs`;
    document.getElementById('dist-metric-orders').textContent = data.summary.totalOrders;

    // Calculate YoY comparison for the distributor dynamically
    const years = new Set();
    (state.orders || []).forEach(o => {
      if (o.order_date) {
        years.add(new Date(o.order_date).getFullYear());
      }
    });
    const sortedYears = Array.from(years).sort((a, b) => b - a);
    const currentYear = sortedYears[0] || new Date().getFullYear();
    const pastYear = sortedYears[1] || (currentYear - 1);

    let salesPast = 0;
    let salesCurrent = 0;

    data.orders.forEach(o => {
      if (!o.order_date) return;
      const yr = new Date(o.order_date).getFullYear();
      if (yr === currentYear) {
        salesCurrent += o.total_amount || 0;
      } else if (yr === pastYear) {
        salesPast += o.total_amount || 0;
      }
    });

    const lblPast = document.getElementById('lbl-dist-past-year');
    if (lblPast) lblPast.textContent = `${pastYear} purchases`;
    const lblCurrent = document.getElementById('lbl-dist-current-year');
    if (lblCurrent) lblCurrent.textContent = `${currentYear} purchases`;
    
    const valPast = document.getElementById('dist-comp-past-val');
    if (valPast) valPast.textContent = `₹${salesPast.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    const valCurrent = document.getElementById('dist-comp-current-val');
    if (valCurrent) valCurrent.textContent = `₹${salesCurrent.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

    const growth = salesPast > 0 ? ((salesCurrent - salesPast) / salesPast) * 100 : 0;
    const growthBadge = document.getElementById('dist-comp-growth-badge');
    if (growthBadge) {
      growthBadge.textContent = `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`;
      growthBadge.className = `badge ${growth >= 0 ? 'badge-success' : 'badge-danger'}`;
    }

    // Set export statement action
    const printBtn = document.getElementById('btn-print-distributor-history');
    if (printBtn) {
      printBtn.onclick = () => {
        const printWindow = window.open(BACKEND_URL ? `${BACKEND_URL}/api/v1/sales/distributors/${encodeURIComponent(data.name)}/invoice-history` : `/api/v1/sales/distributors/${encodeURIComponent(data.name)}/invoice-history`, '_blank');
        if (printWindow) printWindow.focus();
      };
    }

    // Custom Period Inputs & Filtering Elements
    const fromInput = document.getElementById('dist-filter-from');
    const toInput = document.getElementById('dist-filter-to');
    const applyBtn = document.getElementById('btn-dist-filter-apply');
    const resetBtn = document.getElementById('btn-dist-filter-reset');
    const periodBusinessVal = document.getElementById('dist-period-business-val');
    const countBadge = document.getElementById('dist-invoice-log-count-badge');
    
    // Set initial custom period values
    if (periodBusinessVal) {
      periodBusinessVal.textContent = `₹${data.summary.totalRevenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    }
    if (countBadge) {
      countBadge.textContent = data.orders.length;
    }
    if (fromInput) fromInput.value = '';
    if (toInput) toInput.value = '';

    // Collapsible detailed orders logic
    const toggleHeader = document.getElementById('dist-invoice-toggle-header');
    const toggleArrow = document.getElementById('dist-invoice-toggle-arrow');
    const tableContainer = document.getElementById('dist-invoice-table-container');
    
    if (tableContainer) tableContainer.style.display = 'none';
    if (toggleArrow) {
      toggleArrow.textContent = '▶';
      toggleArrow.style.transform = 'rotate(0deg)';
    }
    
    if (toggleHeader) {
      toggleHeader.onclick = () => {
        const isHidden = tableContainer.style.display === 'none';
        tableContainer.style.display = isHidden ? 'block' : 'none';
        if (toggleArrow) {
          toggleArrow.textContent = isHidden ? '▼' : '▶';
          toggleArrow.style.transform = isHidden ? 'rotate(90deg)' : 'rotate(0deg)';
        }
      };
    }

    // Render helper function for orders inside modal
    function renderOrderRows(ordersList) {
      const ordersBody = document.getElementById('dist-modal-orders-body');
      if (!ordersBody) return;
      ordersBody.innerHTML = '';
      if (ordersList.length === 0) {
        ordersBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No orders found.</td></tr>';
      } else {
        ordersList.forEach(o => {
          const row = document.createElement('tr');
          const dDate = new Date(o.order_date).toLocaleDateString();
          row.innerHTML = `
            <td>${dDate}</td>
            <td><code>${o.order_code}</code></td>
            <td>${o.items ? o.items.length : 0} items</td>
            <td>₹${o.tax_amount.toFixed(2)}</td>
            <td><strong>₹${o.total_amount.toFixed(2)}</strong></td>
            <td><span class="badge ${o.status === 'COMPLETED' ? 'badge-success' : 'badge-warning'}">${o.status}</span></td>
            <td>
              <button class="btn btn-secondary" onclick="viewOrderInvoice(${o.id})" style="padding: 2px 8px; font-size: 10px;">🧾 View</button>
            </td>
          `;
          ordersBody.appendChild(row);
        });
      }
    }

    // Initialize list
    renderOrderRows(data.orders);

    if (applyBtn) {
      applyBtn.onclick = () => {
        const fromDateVal = fromInput.value ? new Date(fromInput.value + 'T00:00:00') : null;
        const toDateVal = toInput.value ? new Date(toInput.value + 'T23:59:59') : null;
        
        const filteredOrders = data.orders.filter(o => {
          if (!o.order_date) return false;
          const oDate = new Date(o.order_date);
          if (fromDateVal && oDate < fromDateVal) return false;
          if (toDateVal && oDate > toDateVal) return false;
          return true;
        });

        const totalAmt = filteredOrders.reduce((sum, o) => sum + (o.total_amount || 0), 0);
        if (periodBusinessVal) {
          periodBusinessVal.textContent = `₹${totalAmt.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        }
        if (countBadge) {
          countBadge.textContent = filteredOrders.length;
        }
        renderOrderRows(filteredOrders);
      };
    }

    if (resetBtn) {
      resetBtn.onclick = () => {
        if (fromInput) fromInput.value = '';
        if (toInput) toInput.value = '';
        if (periodBusinessVal) {
          periodBusinessVal.textContent = `₹${data.summary.totalRevenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        }
        if (countBadge) {
          countBadge.textContent = data.orders.length;
        }
        renderOrderRows(data.orders);
      };
    }

    // Open Modal
    openModal('modal-distributor-detail');

    // Draw Line Chart: Purchases Scale Trend over 12 months
    setTimeout(() => {
      const ctxLine = document.getElementById('chart-distributor-history-line').getContext('2d');
      if (charts.distributorHistoryLine) {
        charts.distributorHistoryLine.destroy();
      }
      
      charts.distributorHistoryLine = new Chart(ctxLine, {
        type: 'line',
        data: {
          labels: data.monthlySeries.map(m => m.label),
          datasets: [{
            label: 'Monthly Purchase Scale (₹)',
            data: data.monthlySeries.map(m => m.revenue),
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37, 99, 235, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointBackgroundColor: '#2563eb'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            x: { ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569' }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569' }, grid: { color: 'rgba(255,255,255,0.05)' } }
          }
        }
      });
    }, 150);

  } catch (err) {
    alert('Failed to load distributor details: ' + err.message);
  }
};

// 2. MONTHLY OPERATIONS DASHBOARD
async function renderMonthlyDashboard() {
  try {
    const select = document.getElementById('monthly-period-select');
    if (select.children.length === 0 || state.rebuildMonthlySelect) {
      state.rebuildMonthlySelect = false;

      // Determine date range (from 24 months ago to 6 months into the future)
      let minDate = new Date();
      minDate.setMonth(minDate.getMonth() - 24);
      
      let maxDate = new Date();
      maxDate.setMonth(maxDate.getMonth() + 6);

      // Generate option tags month-by-month
      select.innerHTML = '';
      let current = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
      const end = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);

      while (current <= end) {
        const monthKey = `${current.getFullYear()}-${(current.getMonth() + 1).toString().padStart(2, '0')}`;
        const monthLabel = current.toLocaleString('default', { month: 'short', year: 'numeric' });
        const opt = document.createElement('option');
        opt.value = monthKey;
        opt.textContent = monthLabel;

        const defaultSelected = state.selectedMonthlyPeriod || `${new Date().getFullYear()}-${(new Date().getMonth() + 1).toString().padStart(2, '0')}`;
        if (monthKey === defaultSelected) {
          opt.selected = true;
        }

        select.appendChild(opt);
        current.setMonth(current.getMonth() + 1);
      }

      if (!select.dataset.listenerBound) {
        select.addEventListener('change', () => {
          state.selectedMonthlyPeriod = select.value;
          renderMonthlyDashboard();
        });
        select.dataset.listenerBound = 'true';
      }
    }

    const monthKey = select.value;
    const data = await apiGet(`/api/v1/dashboard/operations/monthly?month=${monthKey}`);

    // Update KPI metrics
    document.getElementById('op-monthly-sales').textContent = `₹${data.summary.totalSales.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('op-monthly-batches').textContent = data.summary.batchesCompleted;
    document.getElementById('op-monthly-traffic').textContent = `${data.summary.gateTraffic} vehicles`;
    document.getElementById('op-monthly-production').textContent = `${data.summary.totalProduced} units`;

    // Daily Production vs Sales Chart
    const ctxDaily = document.getElementById('chart-monthly-daily').getContext('2d');
    if (charts.monthlyDaily) {
      charts.monthlyDaily.destroy();
    }
    charts.monthlyDaily = new Chart(ctxDaily, {
      type: 'line',
      data: {
        labels: data.dailyData.map(d => `${d.day}`),
        datasets: [
          {
            label: 'Sales Revenue (₹)',
            data: data.dailyData.map(d => d.sales),
            borderColor: '#0ea5e9',
            backgroundColor: 'rgba(14, 165, 233, 0.1)',
            fill: true,
            borderWidth: 2,
            tension: 0.2
          },
          {
            label: 'Production Yield (Pcs)',
            data: data.dailyData.map(d => d.production),
            borderColor: '#10b981',
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0.2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: state.isDarkMode ? '#f8fafc' : '#0f172a' } }
        },
        scales: {
          x: { ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569' }, grid: { color: 'rgba(255,255,255,0.03)' } },
          y: { ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569' }, grid: { color: 'rgba(255,255,255,0.03)' } }
        }
      }
    });

    // Recipe breakdown table
    const recipeBody = document.getElementById('op-recipe-breakdown-body');
    recipeBody.innerHTML = '';
    if (data.recipeBreakdown.length === 0) {
      recipeBody.innerHTML = `<tr><td colspan="3" style="text-align:center;">No batches completed this month.</td></tr>`;
    } else {
      data.recipeBreakdown.forEach(r => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><strong>${r.flavor_name}</strong></td>
          <td>${r.batch_count} batches</td>
          <td><strong>${r.total_qty} units</strong></td>
        `;
        recipeBody.appendChild(row);
      });
    }

    // Raw materials consumed progress
    const materialsContainer = document.getElementById('op-materials-consumption-container');
    materialsContainer.innerHTML = '';
    if (data.summary.rawMaterialsUsed.length === 0) {
      materialsContainer.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:16px;">No raw ingredients consumed in this period.</div>`;
    } else {
      data.summary.rawMaterialsUsed.forEach(m => {
        const card = document.createElement('div');
        card.className = 'consumption-progress-card';
        card.innerHTML = `
          <div class="consumption-title">${m.name}</div>
          <div class="consumption-val">${m.total_used.toFixed(1)} <span class="consumption-unit">${m.unit}</span></div>
        `;
        materialsContainer.appendChild(card);
      });
    }

    // Monthly Distributor Matrix table body
    const monthlyDistBody = document.getElementById('distributor-monthly-matrix-body');
    if (monthlyDistBody) {
      monthlyDistBody.innerHTML = '';
      if (!data.distributorMatrix || data.distributorMatrix.length === 0) {
        monthlyDistBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); font-size:12px; padding:16px;">No sales booked in this period.</td></tr>`;
      } else {
        data.distributorMatrix.forEach(d => {
          const locSuffix = d.location ? ` <span style="font-size:11px; color:var(--text-muted);">(${d.location})</span>` : '';
          const row = document.createElement('tr');
          row.innerHTML = `
            <td><strong>${d.name}</strong>${locSuffix}</td>
            <td>${d.orderCount} orders</td>
            <td>${d.totalQty} pcs</td>
            <td>₹${d.totalTax.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
            <td><strong>₹${d.totalSales.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong></td>
          `;
          monthlyDistBody.appendChild(row);
        });
      }
    }

    // Monthly Distributor Purchase Shares Chart (Doughnut Chart)
    const ctxMonthlyDist = document.getElementById('chart-distributor-monthly').getContext('2d');
    if (charts.distributorMonthly) {
      charts.distributorMonthly.destroy();
    }
    
    if (data.distributorMatrix && data.distributorMatrix.length > 0) {
      const topMonthly = [...data.distributorMatrix].slice(0, 5);
      charts.distributorMonthly = new Chart(ctxMonthlyDist, {
        type: 'doughnut',
        data: {
          labels: topMonthly.map(d => d.name),
          datasets: [{
            data: topMonthly.map(d => d.totalSales),
            backgroundColor: ['#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: state.isDarkMode ? '#f8fafc' : '#0f172a', boxWidth: 12, font: { size: 10 } }
            }
          }
        }
      });
    }

  } catch (err) {
    console.error('Error rendering monthly dashboard:', err);
  }
}

// 3. RAW MATERIAL STOCK DASHBOARD
function populateMaterialSelect() {
  const select = document.getElementById('inv-material-select');
  if (!select) return;
  
  const currentValue = select.value;
  select.innerHTML = '';
  
  state.rawMaterials.forEach(mat => {
    const opt = document.createElement('option');
    opt.value = mat.name;
    opt.setAttribute('data-sku', mat.SKU);
    opt.setAttribute('data-unit', mat.unit);
    opt.textContent = `${mat.name} (${mat.unit})`;
    select.appendChild(opt);
  });
  
  if (currentValue) {
    select.value = currentValue;
  }
}

function renderRawMaterials() {
  const materials = state.rawMaterials;

  let totalDairy = 0;
  let totalDry = 0;
  let lowStockCount = 0;

  const metersGrid = document.getElementById('raw-material-meters-grid');
  metersGrid.innerHTML = '';

  materials.forEach(mat => {
    const stock = mat.current_stock;
    const capacity = mat.capacity || 100.0;
    const safety = mat.safety || 20.0;

    if (mat.unit === "L") {
      totalDairy += stock;
    } else {
      totalDry += stock;
    }

    const isLow = stock <= safety;
    if (isLow) lowStockCount++;

    const fillPercent = Math.min((stock / capacity) * 100, 100);

    let progressColor = 'var(--mint-green)';
    let statusText = 'HEALTHY';
    let statusBadge = 'badge-success';

    if (stock <= safety) {
      progressColor = 'var(--pastel-red)';
      statusText = 'CRITICAL STOCK';
      statusBadge = 'badge-danger';
    } else if (stock <= safety * 1.5) {
      progressColor = 'var(--soft-amber)';
      statusText = 'REORDER ZONE';
      statusBadge = 'badge-warning';
    }

    // Calculate Weighted Average Cost of active stock
    const materialBatches = state.inventoryBatches.filter(b => b.raw_material_id === mat.id);
    let avgCost = 0;
    let totalCostForActive = 0;
    let activeStockQty = 0;

    materialBatches.forEach(b => {
      if (b.remaining_quantity > 0) {
        activeStockQty += b.remaining_quantity;
        totalCostForActive += (b.remaining_quantity * (b.unit_price || 0.0));
      }
    });

    if (activeStockQty > 0) {
      avgCost = totalCostForActive / activeStockQty;
    } else if (materialBatches.length > 0) {
      const batchesWithPrice = materialBatches.filter(b => (b.unit_price || 0.0) > 0.0);
      if (batchesWithPrice.length > 0) {
        avgCost = batchesWithPrice.reduce((sum, b) => sum + b.unit_price, 0) / batchesWithPrice.length;
      }
    }

    const card = document.createElement('div');
    card.className = 'raw-material-stock-card';
    card.innerHTML = `
      <div class="raw-card-header">
        <div>
          <div class="raw-card-title">${mat.name}</div>
          <div class="raw-card-sku">${mat.SKU}</div>
        </div>
        <span class="badge ${statusBadge}" style="font-size:8px;">${statusText}</span>
      </div>
      <div class="progress-bar-container">
        <div class="progress-bar-fill" style="width: ${fillPercent}%; background-color: ${progressColor};"></div>
      </div>
      <div class="stock-stats-row">
        <span><strong>${stock.toFixed(1)} ${mat.unit}</strong> in stock</span>
        <span>${fillPercent.toFixed(0)}% Full</span>
      </div>
      <div class="stock-limits-row">
        <span>Safety: ${safety} ${mat.unit}</span>
        <span>Avg Cost: <strong>${avgCost > 0 ? '₹' + avgCost.toFixed(2) + '/' + mat.unit : 'N/A'}</strong></span>
      </div>
      <div class="quick-restock-row" style="display: flex; gap: 8px;">
        <button class="btn-quick-order" onclick="triggerQuickRestock('${mat.name}')" style="flex: 1;">⚡ Quick Restock</button>
        <button class="btn-delete-material" onclick="discontinueRawMaterial(${mat.id}, '${mat.name}')" title="Discontinue Material">🗑️ Discontinue</button>
      </div>
    `;
    metersGrid.appendChild(card);
  });

  document.getElementById('raw-total-dairy').textContent = `${totalDairy.toFixed(1)} L`;
  document.getElementById('raw-total-dry').textContent = `${totalDry.toFixed(1)} kg`;
  document.getElementById('raw-low-stock-count').textContent = `${lowStockCount} items`;
  
  const alertIcon = document.getElementById('raw-alert-icon');
  if (lowStockCount > 0) {
    alertIcon.textContent = '⚠️';
    alertIcon.style.color = 'var(--pastel-red)';
  } else {
    alertIcon.textContent = '✅';
    alertIcon.style.color = 'var(--mint-green)';
  }

  // Populate dynamic select list for restocking
  populateMaterialSelect();

  const batchesBody = document.getElementById('raw-supplier-batches-body');
  batchesBody.innerHTML = '';

  const now = new Date();
  state.inventoryBatches.forEach(b => {
    const expiry = new Date(b.expiry_date);
    const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    
    let warningBadge = 'badge-success';
    let warningText = 'GOOD';
    if (daysLeft <= 0) {
      warningBadge = 'badge-danger';
      warningText = 'EXPIRED';
    } else if (daysLeft <= 3) {
      warningBadge = 'badge-warning';
      warningText = 'FEFO';
    }

    const uPrice = b.unit_price || 0.0;
    const totalVal = b.remaining_quantity * uPrice;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${b.material_name}</strong></td>
      <td><code>${b.SKU}</code></td>
      <td><span class="card-code">${b.batch_number}</span></td>
      <td>${formatDateOnly(b.received_date)}</td>
      <td><strong>${b.remaining_quantity} ${b.unit}</strong></td>
      <td>₹${uPrice.toFixed(2)}</td>
      <td><strong>₹${totalVal.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong></td>
      <td>${formatDateOnly(b.expiry_date)}</td>
      <td><span class="badge ${warningBadge}">${warningText}</span></td>
    `;
    batchesBody.appendChild(row);
  });
}

// Quick Restock helper
window.triggerQuickRestock = function(materialName) {
  if (!hasPermission('ADD_INVENTORY')) {
    alert("Role Permissions: Restricted to Inventory Managers.");
    return;
  }
  const select = document.getElementById('inv-material-select');
  select.value = materialName;
  document.getElementById('inv-expiry-input').valueAsDate = new Date(Date.now() + 7*24*60*60*1000); // Expiry target standard +7 days

  const lastBatch = state.inventoryBatches.find(b => b.material_name === materialName);
  if (lastBatch && lastBatch.unit_price) {
    document.getElementById('inv-price-input').value = lastBatch.unit_price;
  } else {
    document.getElementById('inv-price-input').value = '';
  }

  openModal('modal-add-inventory');
};

// Discontinue raw material helper
window.discontinueRawMaterial = async function(id, name) {
  if (!hasPermission('ADD_INVENTORY')) {
    alert("Role Permissions: Restricted to Inventory Managers / Admins.");
    return;
  }
  
  if (confirm(`⚠️ Are you sure you want to discontinue and delete the raw material "${name}"?\nThis will remove all stock history, inventory batches, and tracking for this ingredient.`)) {
    try {
      await apiDelete(`/api/v1/inventory/raw-materials/${id}`);
      await loadRawMaterials();
      renderAll();
    } catch (err) {
      alert('Failed to discontinue material: ' + err.message);
    }
  }
};

// 4. COLD ROOM finished goods
function renderColdRoom() {
  const coldPieces = state.finishedGoods.reduce((sum, item) => sum + item.stock_qty, 0);
  document.getElementById('cold-total-qty').textContent = `${coldPieces} pcs`;

  const coldValuation = state.finishedGoods.reduce((sum, item) => sum + (item.stock_qty * item.price), 0);
  document.getElementById('cold-total-value').textContent = `₹${coldValuation.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

  const finishedBody = document.getElementById('cold-finished-goods-body');
  finishedBody.innerHTML = '';

  state.finishedGoods.forEach(prod => {
    let badgeClass = 'badge-success';
    let badgeText = 'HEALTHY';
    if (prod.stock_qty === 0) {
      badgeClass = 'badge-danger';
      badgeText = 'DEPLETED';
    } else if (prod.stock_qty < 25) {
      badgeClass = 'badge-warning';
      badgeText = 'LOW STOCK';
    }

    const row = document.createElement('tr');
    const escapedName = prod.name.replace(/'/g, "\\'");
    row.innerHTML = `
      <td><code>${prod.SKU}</code></td>
      <td><strong>${prod.name}</strong></td>
      <td>₹${prod.price.toFixed(2)}</td>
      <td><strong>${prod.stock_qty} pcs</strong></td>
      <td><strong>₹${(prod.stock_qty * prod.price).toFixed(2)}</strong></td>
      <td><span class="badge ${badgeClass}">${badgeText}</span></td>
      <td>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-secondary action-dot-btn" onclick="adjustProductStock(${prod.id}, '${escapedName}', ${prod.stock_qty})" style="padding: 2px 8px; font-size: 11px;">✏️ Adjust</button>
          <button class="btn btn-secondary action-dot-btn" onclick="deleteProduct(${prod.id}, '${escapedName}')" style="padding: 2px 8px; font-size: 11px; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: #ef4444;">🗑️ Delete</button>
        </div>
      </td>
    `;
    finishedBody.appendChild(row);
  });

  const completedBody = document.getElementById('cold-batches-expiry-body');
  completedBody.innerHTML = '';

  const completed = state.productionBatches.filter(b => b.status === 'COMPLETED' && (b.remaining_quantity === null || b.remaining_quantity === undefined || b.remaining_quantity > 0));
  const now = new Date();

  if (completed.length === 0) {
    completedBody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No finished batches logged in cold room.</td></tr>`;
  } else {
    completed.slice(0, 15).forEach(b => {
      const expiry = new Date(b.expiry_date);
      const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      
      let ratingClass = 'var(--mint-green)';
      let ratingText = 'Optimal Freshness';
      if (daysLeft <= 0) {
        ratingClass = 'var(--pastel-red)';
        ratingText = 'Expired - Discard Lot!';
      } else if (daysLeft <= 30) {
        ratingClass = 'var(--soft-amber)';
        ratingText = 'Consume Fast';
      }

      const remainingVal = b.remaining_quantity !== null && b.remaining_quantity !== undefined ? b.remaining_quantity : b.quantity_produced;

      const row = document.createElement('tr');
      row.innerHTML = `
        <td><span class="card-code">${b.batch_code}</span></td>
        <td><strong>${b.flavor_name}</strong></td>
        <td><strong>${remainingVal} pcs</strong></td>
        <td>${b.quantity_produced} pcs</td>
        <td>${formatDateOnly(b.start_time)}</td>
        <td>${formatDateOnly(b.expiry_date)}</td>
        <td style="color:${ratingClass}; font-weight:700; font-size:11px;">${ratingText} (${daysLeft > 0 ? daysLeft + ' days' : 'EXPIRED'})</td>
      `;
      completedBody.appendChild(row);
    });
  }
}

// 5. WORKER ATTENDANCE & PAYROLL SCREEN
function renderWorkersScreen() {
  const query = (state.workerSearchQuery || '').toLowerCase().trim();

  // Filter workers based on search query
  const filteredWorkers = state.workers.filter(w => {
    return (w.name || '').toLowerCase().includes(query);
  });

  // Filter shifts based on search query
  const filteredShifts = state.workerShifts.filter(s => {
    return (s.worker_name || '').toLowerCase().includes(query);
  });

  const activeShifts = state.workerShifts.filter(s => !s.time_out);
  const unpaidWages = state.workerShifts.filter(s => s.time_out && !s.is_paid).reduce((sum, s) => sum + (s.payment_amount || 0), 0);
  const paidWages = state.workerShifts.filter(s => s.time_out && s.is_paid).reduce((sum, s) => sum + (s.payment_amount || 0), 0);

  // Update Metrics
  const activeMetric = document.getElementById('work-metric-active');
  const unpaidMetric = document.getElementById('work-metric-unpaid');
  const paidMetric = document.getElementById('work-metric-paid');

  if (activeMetric) activeMetric.textContent = activeShifts.length;
  if (unpaidMetric) unpaidMetric.textContent = `₹${unpaidWages.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  if (paidMetric) paidMetric.textContent = `₹${paidWages.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

  // Populate Clock In Select Dropdown
  const clockInSelect = document.getElementById('work-select-clockin');
  if (clockInSelect) {
    const activeWorkerIds = new Set(activeShifts.map(s => s.worker_id));
    const eligibleWorkers = state.workers.filter(w => !activeWorkerIds.has(w.id));
    
    clockInSelect.innerHTML = '<option value="">-- Choose Worker --</option>';
    eligibleWorkers.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = `${w.name} (₹${w.hourly_rate.toFixed(2)}/hr)`;
      clockInSelect.appendChild(opt);
    });
  }

  // Populate Active Shifts list
  const activeListContainer = document.getElementById('work-active-list');
  if (activeListContainer) {
    activeListContainer.innerHTML = '';
    const activeShiftsFiltered = activeShifts.filter(s => (s.worker_name || '').toLowerCase().includes(query));
    if (activeShiftsFiltered.length === 0) {
      activeListContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); font-size: 12px; padding: 10px 0;">No matching workers on shift.</div>';
    } else {
      activeShiftsFiltered.forEach(s => {
        const item = document.createElement('div');
        item.className = 'active-shift-item';
        item.style = 'display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-card); border-radius: 8px;';
        
        let startTimeFormatted = '';
        try {
          const dateIn = new Date(s.time_in);
          startTimeFormatted = dateIn.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (err) {
          startTimeFormatted = s.time_in;
        }

        item.innerHTML = `
          <div>
            <div style="font-weight: 600; font-size: 13px; color: var(--text-primary);">${s.worker_name || 'Worker'}</div>
            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
              In: ${startTimeFormatted} | Rate: ₹${s.hourly_rate.toFixed(2)}/hr
            </div>
            <div style="font-size: 11px; margin-top: 4px;">
              Duration: <span class="live-shift-duration" data-timein="${s.time_in}" style="font-weight: 700; color: var(--soft-blue);">0m 0s</span>
            </div>
          </div>
          <button class="btn btn-secondary" onclick="clockOutShift(${s.id})" style="padding: 4px 10px; font-size: 11px; background: var(--soft-blue); color: white; border-color: var(--soft-blue);">Clock Out</button>
        `;
        activeListContainer.appendChild(item);
      });
    }
  }

  // Populate Worker Directory Table
  const directoryBody = document.getElementById('work-directory-body');
  if (directoryBody) {
    directoryBody.innerHTML = '';
    if (filteredWorkers.length === 0) {
      directoryBody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-secondary);">No matching workers found.</td></tr>';
    } else {
      filteredWorkers.forEach(w => {
        const row = document.createElement('tr');
        const escapedName = w.name.replace(/'/g, "\\'");
        row.style.cursor = 'pointer';
        row.onclick = (e) => {
          if (e.target.tagName !== 'BUTTON') {
            window.viewWorkerDetails(w.id, w.name);
          }
        };
        row.innerHTML = `
          <td><strong>${w.name}</strong></td>
          <td>₹${w.hourly_rate.toFixed(2)}/hr</td>
          <td>
            <div style="display: flex; gap: 4px; align-items: center;">
              <button class="btn btn-secondary" onclick="window.viewWorkerDetails(${w.id}, '${escapedName}')" style="padding: 2px 6px; font-size: 10px;">View</button>
              <button class="btn btn-secondary action-dot-btn" onclick="deleteWorker(${w.id}, '${escapedName}')" style="padding: 2px 6px; font-size: 10px; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: #ef4444;">Delete</button>
            </div>
          </td>
        `;
        directoryBody.appendChild(row);
      });
    }
  }

  // Populate Shift Attendance & Payroll Ledger Table
  const ledgerBody = document.getElementById('work-ledger-body');
  if (ledgerBody) {
    ledgerBody.innerHTML = '';
    if (filteredShifts.length === 0) {
      ledgerBody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-secondary);">No matching shift logs.</td></tr>';
    } else {
      filteredShifts.forEach(s => {
        const row = document.createElement('tr');
        
        let clockInStr = '';
        let clockOutStr = '';
        try {
          const dIn = new Date(s.time_in);
          clockInStr = dIn.toLocaleString();
        } catch (err) {
          clockInStr = s.time_in;
        }

        let hoursStr = '-';
        let wagesStr = '-';
        let statusBadge = '';
        let actionButtons = '';

        if (s.time_out) {
          try {
            const dOut = new Date(s.time_out);
            clockOutStr = dOut.toLocaleString();
          } catch (err) {
            clockOutStr = s.time_out;
          }
          hoursStr = `${s.total_hours.toFixed(2)} hrs`;
          wagesStr = `₹${s.payment_amount.toFixed(2)}`;

          if (s.is_paid) {
            statusBadge = `<span class="badge badge-success" style="cursor: pointer;" onclick="toggleShiftPayment(${s.id}, false)">PAID</span>`;
            actionButtons = `<button class="btn btn-secondary" onclick="toggleShiftPayment(${s.id}, false)" style="padding: 2px 6px; font-size: 10px;">Mark Unpaid</button>`;
          } else {
            statusBadge = `<span class="badge badge-warning" style="cursor: pointer;" onclick="toggleShiftPayment(${s.id}, true)">UNPAID</span>`;
            actionButtons = `<button class="btn btn-secondary" onclick="toggleShiftPayment(${s.id}, true)" style="padding: 2px 6px; font-size: 10px; background: var(--mint-green); border-color: var(--mint-green); color: white;">Mark Paid</button>`;
          }
        } else {
          clockOutStr = `<span class="badge badge-info" style="background: var(--soft-blue);">ACTIVE</span>`;
          statusBadge = `<span class="badge badge-info" style="background: var(--soft-blue);">ON SHIFT</span>`;
          actionButtons = `<button class="btn btn-secondary" onclick="clockOutShift(${s.id})" style="padding: 2px 6px; font-size: 10px; background: var(--soft-blue); border-color: var(--soft-blue); color: white;">Clock Out</button>`;
        }

        actionButtons += ` <button class="btn btn-secondary" onclick="deleteShiftLog(${s.id})" style="padding: 2px 6px; font-size: 10px; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: #ef4444; margin-left: 4px;">Delete</button>`;

        row.innerHTML = `
          <td><strong>${s.worker_name || 'Worker'}</strong></td>
          <td>${clockInStr}</td>
          <td>${clockOutStr}</td>
          <td>${hoursStr}</td>
          <td>₹${s.hourly_rate.toFixed(2)}/hr</td>
          <td><strong>${wagesStr}</strong></td>
          <td>${statusBadge}</td>
          <td>
            <div style="display: flex; gap: 4px; align-items: center;">
              ${actionButtons}
            </div>
          </td>
        `;
        ledgerBody.appendChild(row);
      });
    }
  }
}

window.viewWorkerDetails = function(workerId, workerName) {
  const worker = state.workers.find(w => w.id === workerId);
  const shifts = state.workerShifts.filter(s => s.worker_id === workerId);

  const hourlyRate = worker ? worker.hourly_rate : 0;
  const totalShifts = shifts.length;
  const totalHours = shifts.filter(s => s.time_out).reduce((sum, s) => sum + (s.total_hours || 0), 0);
  const totalWages = shifts.filter(s => s.time_out).reduce((sum, s) => sum + (s.payment_amount || 0), 0);
  const unpaidWages = shifts.filter(s => s.time_out && !s.is_paid).reduce((sum, s) => sum + (s.payment_amount || 0), 0);
  const paidWages = shifts.filter(s => s.time_out && s.is_paid).reduce((sum, s) => sum + (s.payment_amount || 0), 0);
  
  const isActive = state.workerShifts.some(s => s.worker_id === workerId && !s.time_out);

  document.getElementById('worker-modal-title').textContent = `👷 ${workerName} Performance Details`;
  document.getElementById('worker-metric-rate').textContent = `₹${hourlyRate.toFixed(2)}/hr`;
  document.getElementById('worker-metric-shifts').textContent = totalShifts;
  document.getElementById('worker-metric-hours').textContent = `${totalHours.toFixed(2)} hrs`;
  document.getElementById('worker-metric-wages').textContent = `₹${totalWages.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  document.getElementById('worker-comp-unpaid-val').textContent = `₹${unpaidWages.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  document.getElementById('worker-comp-paid-val').textContent = `₹${paidWages.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

  const statusBadge = document.getElementById('worker-status-badge');
  if (statusBadge) {
    if (isActive) {
      statusBadge.textContent = 'ON SHIFT';
      statusBadge.className = 'badge badge-info';
      statusBadge.style = 'font-size: 12px; padding: 4px 8px; font-weight: 700; background: var(--soft-blue);';
    } else {
      statusBadge.textContent = 'OFF SHIFT';
      statusBadge.className = 'badge';
      statusBadge.style = 'font-size: 12px; padding: 4px 8px; font-weight: 700; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.1); color: var(--text-secondary);';
    }
  }

  const shiftsBody = document.getElementById('worker-modal-shifts-body');
  if (shiftsBody) {
    shiftsBody.innerHTML = '';
    if (shifts.length === 0) {
      shiftsBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">No shift history recorded.</td></tr>';
    } else {
      shifts.forEach(s => {
        const row = document.createElement('tr');
        
        let clockInStr = '';
        let clockOutStr = '';
        try {
          clockInStr = new Date(s.time_in).toLocaleString();
        } catch (err) {
          clockInStr = s.time_in;
        }

        let hoursStr = '-';
        let wagesStr = '-';
        let statusBadgeText = '';

        if (s.time_out) {
          try {
            clockOutStr = new Date(s.time_out).toLocaleString();
          } catch (err) {
            clockOutStr = s.time_out;
          }
          hoursStr = `${s.total_hours.toFixed(2)} hrs`;
          wagesStr = `₹${s.payment_amount.toFixed(2)}`;

          if (s.is_paid) {
            statusBadgeText = `<span class="badge badge-success" style="cursor: pointer;" onclick="window.toggleShiftPaymentInModal(${s.id}, false)">PAID</span>`;
          } else {
            statusBadgeText = `<span class="badge badge-warning" style="cursor: pointer;" onclick="window.toggleShiftPaymentInModal(${s.id}, true)">UNPAID</span>`;
          }
        } else {
          clockOutStr = `<span class="badge badge-info" style="background: var(--soft-blue);">ACTIVE</span>`;
          statusBadgeText = `<span class="badge badge-info" style="background: var(--soft-blue);">ON SHIFT</span>`;
        }

        row.innerHTML = `
          <td>${clockInStr}</td>
          <td>${clockOutStr}</td>
          <td>${hoursStr}</td>
          <td>₹${s.hourly_rate.toFixed(2)}/hr</td>
          <td><strong>${wagesStr}</strong></td>
          <td>${statusBadgeText}</td>
        `;
        shiftsBody.appendChild(row);
      });
    }
  }

  openModal('modal-worker-detail');
};

window.toggleShiftPaymentInModal = async function(shiftId, markPaid) {
  try {
    await window.toggleShiftPayment(shiftId, markPaid);
    // Find who the active worker details belong to and refresh modal content
    const shift = state.workerShifts.find(s => s.id === shiftId);
    if (shift) {
      // Re-trigger modal render
      window.viewWorkerDetails(shift.worker_id, shift.worker_name);
    }
  } catch (err) {
    alert("Failed to toggle shift payment in modal: " + err.message);
  }
};

// Distributors Screen Rendering & Control
function renderDistributorsScreen() {
  const query = (state.distSearchQuery || '').toLowerCase().trim();
  
  // Filter distributors based on search query
  const filtered = (state.distributors || []).filter(d => {
    return (
      (d.name || '').toLowerCase().includes(query) ||
      (d.location || '').toLowerCase().includes(query) ||
      (d.gstin || '').toLowerCase().includes(query) ||
      (d.phone || '').toLowerCase().includes(query)
    );
  });

  // Sort by name A-Z
  filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // Update Metrics
  const totalCountEl = document.getElementById('distributors-total-count');
  if (totalCountEl) {
    totalCountEl.textContent = (state.distributors || []).length;
  }

  // Last registered metric
  const lastReg = (state.distributors || []).reduce((latest, current) => {
    if (!latest || current.id > latest.id) return current;
    return latest;
  }, null);
  
  const lastRegEl = document.getElementById('distributors-last-registered');
  const lastRegTimeEl = document.getElementById('distributors-last-registered-time');
  if (lastRegEl) {
    lastRegEl.textContent = lastReg ? lastReg.name : 'None';
  }
  if (lastRegTimeEl) {
    lastRegTimeEl.textContent = lastReg && lastReg.created_at ? new Date(lastReg.created_at).toLocaleDateString() : 'No recent entries';
  }

  // Handle Pagination bounds
  const totalCount = filtered.length;
  const totalPages = Math.ceil(totalCount / state.distPageSize) || 1;
  if (state.distPage > totalPages) {
    state.distPage = totalPages;
  }
  if (state.distPage < 1) {
    state.distPage = 1;
  }

  const startIdx = (state.distPage - 1) * state.distPageSize;
  const endIdx = Math.min(startIdx + state.distPageSize, totalCount);
  const pageDists = filtered.slice(startIdx, endIdx);

  // Update Pagination UI Info & Buttons
  const infoEl = document.getElementById('distributors-pagination-info');
  if (infoEl) {
    if (totalCount === 0) {
      infoEl.textContent = 'Showing 0-0 of 0 entries';
    } else {
      infoEl.textContent = `Showing ${startIdx + 1}-${endIdx} of ${totalCount} entries`;
    }
  }

  const prevBtn = document.getElementById('distributors-prev-btn');
  const nextBtn = document.getElementById('distributors-next-btn');
  if (prevBtn) prevBtn.disabled = (state.distPage <= 1);
  if (nextBtn) nextBtn.disabled = (state.distPage >= totalPages);

  // Render Table Rows
  const tableBody = document.getElementById('distributors-table-body');
  if (tableBody) {
    tableBody.innerHTML = '';
    if (pageDists.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-secondary);">No party ledgers found.</td></tr>`;
    } else {
      const isAuthorized = hasPermission('EDIT_DISTRIBUTOR');
      pageDists.forEach(d => {
        const row = document.createElement('tr');
        row.style.cursor = 'pointer';
        row.onclick = (e) => {
          if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input') || e.target.closest('a')) {
            return;
          }
          viewDistributorDetails(d.name);
        };
        
        let actionButtons = '';
        if (isAuthorized) {
          actionButtons = `
            <button class="btn btn-secondary action-dot-btn" onclick="openEditDistributorModal(${d.id})" style="padding: 2px 6px; font-size: 10px; background: rgba(14, 165, 233, 0.1); border-color: rgba(14, 165, 233, 0.2); color: var(--ice-blue);">Edit</button>
            <button class="btn btn-secondary action-dot-btn" onclick="deleteDistributor(${d.id}, '${d.name.replace(/'/g, "\\'")}')" style="padding: 2px 6px; font-size: 10px; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: #ef4444; margin-left: 4px;">Delete</button>
          `;
        } else {
          actionButtons = `<span style="font-size: 11px; color: var(--text-secondary);">View Only</span>`;
        }

        row.innerHTML = `
          <td><strong style="color: var(--ice-blue); text-decoration: underline; text-decoration-style: dashed; text-underline-offset: 3px;">${d.name || ''}</strong></td>
          <td>${d.location || '<span style="color: var(--text-secondary);">N/A</span>'}</td>
          <td><code>${d.gstin || '<span style="color: var(--text-secondary);">N/A</span>'}</code></td>
          <td>${d.phone || '<span style="color: var(--text-secondary);">N/A</span>'}</td>
          <td>
            <div style="display: flex; align-items: center;">
              ${actionButtons}
              <button class="btn btn-secondary action-dot-btn" onclick="event.stopPropagation(); viewDistributorDetails('${d.name.replace(/'/g, "\\'")}')" style="padding: 2px 6px; font-size: 10px; background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.2); color: var(--mint-green); margin-left: 4px;">📊 Details</button>
            </div>
          </td>
        `;
        tableBody.appendChild(row);
      });
    }
  }
}

// Open Edit Distributor Modal
window.openEditDistributorModal = function(id) {
  const dist = state.distributors.find(d => d.id === id);
  if (!dist) return;

  document.getElementById('edit-dist-id').value = dist.id;
  document.getElementById('edit-dist-name').value = dist.name || '';
  document.getElementById('edit-dist-location').value = dist.location || '';
  document.getElementById('edit-dist-gstin').value = dist.gstin || '';
  document.getElementById('edit-dist-phone').value = dist.phone || '';

  openModal('modal-edit-distributor');
};

// Delete Distributor
window.deleteDistributor = async function(id, name) {
  if (!confirm(`Are you sure you want to delete the party ledger "${name}"?\n\nThis will remove the distributor from the system directory.`)) {
    return;
  }

  try {
    await apiDelete(`/api/v1/distributors/${id}`);
    
    // Refresh distributors
    await loadDistributors();
    renderAll();
  } catch (err) {
    console.error('Failed to delete distributor:', err);
    alert('Failed to delete distributor: ' + err.message);
  }
};

// ==========================================
// ✍️ FORMS EVENT TRIGGERS
// ==========================================
function setupFormHandlers() {




  // Modal Buttons
  const startBatchBtn = document.getElementById('btn-start-batch-trigger');
  if (startBatchBtn) {
    startBatchBtn.addEventListener('click', () => {
      // Generate new code
      const batchCodeInput = document.getElementById('batch-code-input');
      if (batchCodeInput) {
        batchCodeInput.value = `PB-26-${Date.now().toString().slice(-3)}`;
      }
      
      // Load select options
      const select = document.getElementById('batch-recipe-select');
      if (select) {
        select.innerHTML = '';
        state.recipes.forEach(r => {
          const opt = document.createElement('option');
          opt.value = r.id;
          opt.textContent = r.name;
          select.appendChild(opt);
        });
      }

      triggerRecipePreview();
      openModal('modal-start-batch');
    });
  }

  const recipeSelect = document.getElementById('batch-recipe-select');
  if (recipeSelect) {
    recipeSelect.addEventListener('change', triggerRecipePreview);
  }

  const addInventoryBtn = document.getElementById('btn-add-inventory-trigger');
  if (addInventoryBtn) {
    addInventoryBtn.addEventListener('click', () => {
      // Set default date today
      const expiryInput = document.getElementById('inv-expiry-input');
      if (expiryInput) {
        expiryInput.valueAsDate = new Date();
      }
      openModal('modal-add-inventory');
    });
  }

  // Submit start batch
  const startBatchForm = document.getElementById('start-batch-form');
  if (startBatchForm) {
    startBatchForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const recipeSelect = document.getElementById('batch-recipe-select');
      const batchCodeInput = document.getElementById('batch-code-input');
      const recipeId = recipeSelect ? recipeSelect.value : '';
      const batchCode = batchCodeInput ? batchCodeInput.value : '';
      
      try {
        await apiPost('/api/v1/production/start', { recipe_id: recipeId, batch_code: batchCode });
        closeModal('modal-start-batch');
      } catch (err) {
        alert('Error launching batch: ' + err.message);
      }
    });
  }

  const addInventoryForm = document.getElementById('add-inventory-form');
  if (addInventoryForm) {
    addInventoryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const materialSelect = document.getElementById('inv-material-select');
      const option = materialSelect.options[materialSelect.selectedIndex];
      if (!option) {
        alert('Please register a raw material type first.');
        return;
      }
      
      const name = materialSelect.value;
      const sku = option.getAttribute('data-sku');
      const unit = option.getAttribute('data-unit');
      const quantity = document.getElementById('inv-quantity-input').value;
      const price = document.getElementById('inv-price-input').value;
      const expiry = document.getElementById('inv-expiry-input').value;

      try {
        await apiPost('/api/v1/inventory/raw-materials', {
          name,
          SKU: sku,
          unit,
          quantity,
          unit_price: parseFloat(price || 0),
          expiry_date: expiry
        });
        closeModal('modal-add-inventory');
        addInventoryForm.reset();
      } catch (err) {
        alert('Inventory add failed: ' + err.message);
      }
    });
  }




  // Modal open for registering new raw material type
  const addMaterialTrigger = document.getElementById('btn-add-material-trigger');
  if (addMaterialTrigger) {
    addMaterialTrigger.addEventListener('click', () => {
      // Expiry target standard default: today + 30 days
      const d = new Date();
      d.setDate(d.getDate() + 30);
      document.getElementById('new-mat-expiry').valueAsDate = d;
      openModal('modal-add-new-material');
    });
  }

  // Submit new raw material registration
  const addNewMaterialForm = document.getElementById('add-new-material-form');
  if (addNewMaterialForm) {
    addNewMaterialForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const name = document.getElementById('new-mat-name').value;
      const sku = document.getElementById('new-mat-sku').value;
      const unit = document.getElementById('new-mat-unit').value;
      const capacity = document.getElementById('new-mat-capacity').value;
      const safety = document.getElementById('new-mat-safety').value;
      const initialStock = document.getElementById('new-mat-initial-stock').value;
      const initialPrice = document.getElementById('new-mat-initial-price').value;
      const expiry = document.getElementById('new-mat-expiry').value;

      try {
        await apiPost('/api/v1/inventory/raw-materials', {
          name,
          SKU: sku,
          unit,
          quantity: initialStock,
          unit_price: parseFloat(initialPrice || 0),
          expiry_date: expiry,
          capacity,
          safety
        });
        closeModal('modal-add-new-material');
        addNewMaterialForm.reset();
        await loadRawMaterials();
        renderAll();
      } catch (err) {
        alert('Material registration failed: ' + err.message);
      }
    });
  }

  // ---- FINISHED GOODS PRODUCT REGISTRATION ----
  const addProductTrigger = document.getElementById('btn-add-product-trigger');
  if (addProductTrigger) {
    addProductTrigger.addEventListener('click', () => {
      openModal('modal-add-product');
    });
  }

  const bridgeAddProductTrigger = document.getElementById('btn-bridge-add-product-trigger');
  if (bridgeAddProductTrigger) {
    bridgeAddProductTrigger.addEventListener('click', () => {
      openModal('modal-add-product');
    });
  }



  const newProdUnitSelect = document.getElementById('new-prod-unit');
  const newProdBoxDetails = document.getElementById('new-prod-box-details');
  const newProdBoxUnitsInput = document.getElementById('new-prod-box-units');
  const newProdUnitMlInput = document.getElementById('new-prod-unit-ml');

  if (newProdUnitSelect && newProdBoxDetails) {
    newProdUnitSelect.addEventListener('change', (e) => {
      if (e.target.value === 'box') {
        newProdBoxDetails.style.display = 'block';
        if (newProdBoxUnitsInput) newProdBoxUnitsInput.required = true;
        if (newProdUnitMlInput) newProdUnitMlInput.required = true;
      } else {
        newProdBoxDetails.style.display = 'none';
        if (newProdBoxUnitsInput) {
          newProdBoxUnitsInput.required = false;
          newProdBoxUnitsInput.value = '';
        }
        if (newProdUnitMlInput) {
          newProdUnitMlInput.required = false;
          newProdUnitMlInput.value = '';
        }
      }
    });
  }

  const addProductForm = document.getElementById('add-product-form');
  if (addProductForm) {
    addProductForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const name = document.getElementById('new-prod-name').value;
      const sku = document.getElementById('new-prod-sku').value;
      const price = document.getElementById('new-prod-price').value;
      const stockQty = document.getElementById('new-prod-stock').value;
      const unit = document.getElementById('new-prod-unit').value;
      const unitsPerBox = unit === 'box' && newProdBoxUnitsInput ? newProdBoxUnitsInput.value : null;
      const mlPerUnit = unit === 'box' && newProdUnitMlInput ? newProdUnitMlInput.value : null;

      try {
        await apiPost('/api/v1/finished-goods', {
          name,
          SKU: sku,
          price: parseFloat(price),
          stock_qty: parseInt(stockQty),
          unit,
          units_per_box: unitsPerBox ? parseInt(unitsPerBox) : null,
          ml_per_unit: mlPerUnit ? parseFloat(mlPerUnit) : null
        });
        closeModal('modal-add-product');
        addProductForm.reset();
        if (newProdBoxDetails) newProdBoxDetails.style.display = 'none';
        await loadFinishedGoods();
        renderAll();
      } catch (err) {
        alert('Product registration failed: ' + err.message);
      }
    });
  }

  // ---- DISTRIBUTOR REGISTRATION ----
  const addDistributorTrigger = document.getElementById('btn-add-distributor-trigger');
  if (addDistributorTrigger) {
    addDistributorTrigger.addEventListener('click', () => {
      openModal('modal-add-distributor');
    });
  }

  const addDistributorForm = document.getElementById('add-distributor-form');
  if (addDistributorForm) {
    addDistributorForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const name = document.getElementById('new-dist-name').value.trim();
      const locationInput = document.getElementById('new-dist-location');
      const location = locationInput ? locationInput.value.trim() : '';
      const gstinInput = document.getElementById('new-dist-gstin');
      const gstin = gstinInput ? gstinInput.value.trim() : '';
      const phoneInput = document.getElementById('new-dist-phone');
      const phone = phoneInput ? phoneInput.value.trim() : '';

      try {
        await apiPost('/api/v1/distributors', {
          name,
          location,
          gstin,
          phone,
          user_role: state.activeRole,
          user_name: 'System Admin'
        });
        
        closeModal('modal-add-distributor');
        addDistributorForm.reset();
        
        // Refresh distributors state
        await loadDistributors();

        // Auto-select the newly created distributor in the checkout form
        const customerNameInput = document.getElementById('customer-name-input');
        if (customerNameInput) {
          customerNameInput.value = name;
        }

        // Auto-select the newly created distributor in the Tally-style party input
        const partyInput = document.getElementById('tally-party-input');
        if (partyInput) {
          partyInput.value = name;
          state.tallyVoucher.partyName = name;
          // Trigger balance update
          setTimeout(() => {
            resolveTallyPartyName();
          }, 50);
        }
        


        // Render to update charts/dropdowns
        renderAll();
        alert('Distributor registered successfully!');
      } catch (err) {
        alert('Distributor registration failed: ' + err.message);
      }
    });
  }

  // ---- LEDGER DIRECTORY PANEL HANDLERS ----
  const btnDistributorsAddNew = document.getElementById('btn-distributors-add-new');
  if (btnDistributorsAddNew) {
    btnDistributorsAddNew.addEventListener('click', () => {
      openModal('modal-add-distributor');
    });
  }

  const distSearchInput = document.getElementById('distributors-search-input');
  if (distSearchInput) {
    distSearchInput.addEventListener('input', (e) => {
      state.distSearchQuery = e.target.value;
      state.distPage = 1;
      renderDistributorsScreen();
    });
  }

  const distPrevBtn = document.getElementById('distributors-prev-btn');
  if (distPrevBtn) {
    distPrevBtn.addEventListener('click', () => {
      if (state.distPage > 1) {
        state.distPage--;
        renderDistributorsScreen();
      }
    });
  }

  const distNextBtn = document.getElementById('distributors-next-btn');
  if (distNextBtn) {
    distNextBtn.addEventListener('click', () => {
      state.distPage++;
      renderDistributorsScreen();
    });
  }

  const editDistributorForm = document.getElementById('edit-distributor-form');
  if (editDistributorForm) {
    editDistributorForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const id = document.getElementById('edit-dist-id').value;
      const name = document.getElementById('edit-dist-name').value.trim();
      const location = document.getElementById('edit-dist-location').value.trim();
      const gstin = document.getElementById('edit-dist-gstin').value.trim();
      const phone = document.getElementById('edit-dist-phone').value.trim();

      try {
        await apiPut(`/api/v1/distributors/${id}`, {
          name,
          location,
          gstin,
          phone
        });

        closeModal('modal-edit-distributor');
        
        // Reload all data
        await Promise.all([loadDistributors(), loadOrders()]);
        renderAll();
        
        alert('Distributor ledger updated successfully!');
      } catch (err) {
        alert('Failed to update distributor: ' + err.message);
      }
    });
  }

  // ---- GST UPDATE SUBMIT HANDLER ----
  const btnUpdateGst = document.getElementById('btn-update-gst');
  if (btnUpdateGst) {
    btnUpdateGst.addEventListener('click', async () => {
      const gstInput = document.getElementById('gst-rate-input');
      const val = parseFloat(gstInput.value);
      if (isNaN(val) || val < 0 || val > 100) {
        alert('Please enter a valid GST percentage between 0 and 100.');
        return;
      }
      
      const decimalValue = val / 100;
      try {
        await apiPut('/api/v1/settings', {
          key: 'gst_rate',
          value: decimalValue,
          user_role: state.activeRole,
          user_name: 'System Admin'
        });
        alert('GST rate updated successfully to ' + val + '%');
      } catch (err) {
        alert('Failed to update GST rate: ' + err.message);
      }
    });
  }

  // ---- PRODUCT CATALOG SEARCH AND CATEGORY FILTERS ----
  document.querySelectorAll('.filter-buttons .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-buttons .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.salesCategoryFilter = btn.getAttribute('data-category');
      renderSalesScreen();
    });
  });

  const salesSearchInput = document.getElementById('sales-search');
  if (salesSearchInput) {
    salesSearchInput.addEventListener('input', (e) => {
      state.salesSearchQuery = e.target.value.toLowerCase().trim();
      renderSalesScreen();
    });
  }

  const workersSearchInput = document.getElementById('workers-search-input');
  if (workersSearchInput) {
    workersSearchInput.addEventListener('input', (e) => {
      state.workerSearchQuery = e.target.value.toLowerCase().trim();
      renderWorkersScreen();
    });
  }

  // ---- WORKER FORM HANDLERS ----
  const registerWorkerForm = document.getElementById('register-worker-form');
  if (registerWorkerForm) {
    registerWorkerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('work-new-name').value.trim();
      const hourlyRate = parseFloat(document.getElementById('work-new-rate').value);
      
      try {
        await apiPost('/api/v1/workers', { name, hourly_rate: hourlyRate });
        registerWorkerForm.reset();
        await loadWorkers();
        renderAll();
        alert('Worker registered successfully!');
      } catch (err) {
        alert('Failed to register worker: ' + err.message);
      }
    });
  }

  const clockInForm = document.getElementById('clock-in-form');
  if (clockInForm) {
    clockInForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const workerId = document.getElementById('work-select-clockin').value;
      if (!workerId) return;
      
      try {
        await apiPost('/api/v1/workers/clock-in', { worker_id: parseInt(workerId) });
        await loadWorkerShifts();
        renderAll();
        alert('Worker clocked in successfully!');
      } catch (err) {
        alert('Failed to clock in: ' + err.message);
      }
    });
  }

  // ---- BILLING TYPE SWITCHER ----
  document.querySelectorAll('input[name="billing-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      renderCart();
    });
  });

  // ---- SALES DESK TAB SWITCHER ----
  const btnTabPosBooking = document.getElementById('btn-tab-pos-booking');
  const btnTabPosInvoices = document.getElementById('btn-tab-pos-invoices');
  const posBookingView = document.getElementById('pos-booking-view');
  const posInvoicesView = document.getElementById('pos-invoices-view');

  if (btnTabPosBooking && btnTabPosInvoices && posBookingView && posInvoicesView) {
    btnTabPosBooking.addEventListener('click', () => {
      btnTabPosBooking.classList.add('active');
      btnTabPosInvoices.classList.remove('active');
      posBookingView.style.display = 'block';
      posInvoicesView.style.display = 'none';
    });

    btnTabPosInvoices.addEventListener('click', () => {
      btnTabPosBooking.classList.remove('active');
      btnTabPosInvoices.classList.add('active');
      posBookingView.style.display = 'none';
      posInvoicesView.style.display = 'block';
      renderInvoicesLedger();
    });
  }

  // ---- COLD ROOM RECIPE BRIDGE & CALCULATOR ----
  const btnSetupRecipe = document.getElementById('btn-setup-recipe-bridge');
  if (btnSetupRecipe) {
    btnSetupRecipe.addEventListener('click', () => {
      const prodName = state.selectedColdProduct;
      if (!prodName) return;

      const displayEl = document.getElementById('recipe-product-display-name');
      const nameEl = document.getElementById('recipe-product-name');
      const yieldQtyEl = document.getElementById('recipe-yield-quantity');
      const container = document.getElementById('recipe-rows-container');

      if (displayEl) displayEl.textContent = prodName;
      if (nameEl) nameEl.value = prodName;
      if (container) container.innerHTML = '';

      const recipe = state.recipes.find(r => r.name === prodName);
      if (recipe) {
        if (yieldQtyEl) yieldQtyEl.value = recipe.yield_quantity;
        recipe.ingredients.forEach(ing => {
          addRecipeIngredientRow(ing.raw_material_id, ing.quantity_required);
        });
      } else {
        if (yieldQtyEl) yieldQtyEl.value = 100;
        addRecipeIngredientRow(); // Add one empty row to start
      }

      openModal('modal-manage-recipe');
    });
  }

  const btnRecipeAddRow = document.getElementById('btn-recipe-add-row');
  if (btnRecipeAddRow) {
    btnRecipeAddRow.addEventListener('click', () => {
      addRecipeIngredientRow();
    });
  }

  const manageRecipeForm = document.getElementById('manage-recipe-form');
  if (manageRecipeForm) {
    manageRecipeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('recipe-product-name').value;
      const yieldQty = parseFloat(document.getElementById('recipe-yield-quantity').value);
      const yieldUnit = document.getElementById('recipe-yield-unit').value;

      const rows = document.querySelectorAll('#recipe-rows-container .recipe-row');
      const ingredients = [];

      rows.forEach(row => {
        const matSelect = row.querySelector('.recipe-mat-select');
        const qtyInput = row.querySelector('.recipe-qty-input');
        
        if (matSelect && qtyInput && matSelect.value) {
          ingredients.push({
            raw_material_id: parseInt(matSelect.value),
            quantity_required: parseFloat(qtyInput.value)
          });
        }
      });

      if (ingredients.length === 0) {
        alert('Please add at least one ingredient.');
        return;
      }

      try {
        await apiPost('/api/v1/recipes', {
          name,
          yield_quantity: yieldQty,
          yield_unit: yieldUnit,
          ingredients
        });
        closeModal('modal-manage-recipe');
        await loadRecipes();
        await selectColdProduct(name);
      } catch (err) {
        alert('Failed to save recipe bridge: ' + err.message);
      }
    });
  }

  const bridgeCalcTarget = document.getElementById('bridge-calc-target');
  if (bridgeCalcTarget) {
    bridgeCalcTarget.addEventListener('input', updateBridgeCalculator);
  }

  const btnBridgeExecuteProduction = document.getElementById('btn-bridge-execute-production');
  if (btnBridgeExecuteProduction) {
    btnBridgeExecuteProduction.addEventListener('click', async () => {
      const inputEl = document.getElementById('bridge-calc-target');
      const targetQty = parseFloat(inputEl ? inputEl.value : '0') || 0;
      if (targetQty <= 0) {
        alert('Please enter a valid quantity to produce.');
        return;
      }

      const recipe = state.recipes.find(r => r.name === state.selectedColdProduct);
      if (!recipe) {
        alert('No recipe found for the selected finished good.');
        return;
      }

      const overrides = [];
      document.querySelectorAll('#bridge-calc-tbody .calc-override-input').forEach(input => {
        const ingId = parseInt(input.getAttribute('data-ingid'));
        const qtyUsed = parseFloat(input.value) || 0;
        overrides.push({
          raw_material_id: ingId,
          quantity_used: qtyUsed
        });
      });

      const confirmRun = confirm(`Are you sure you want to deduct raw materials and add ${targetQty} pcs of "${recipe.name}" to the Cold Room finished goods stock?`);
      if (!confirmRun) return;

      try {
        await apiPost('/api/v1/production/execute-calculator', {
          recipe_id: recipe.id,
          target_quantity: targetQty,
          ingredients_override: overrides
        });

        alert(`Successfully produced ${targetQty} pcs of "${recipe.name}"! Raw materials deducted (FEFO) and finished goods added to Cold Room.`);
        
        await Promise.all([
          loadRawMaterials(),
          loadFinishedGoods(),
          loadProductionBatches()
        ]);
        
        renderAll();
      } catch (err) {
        alert('Failed to execute calculator production: ' + err.message);
      }
    });
  }
}

function triggerRecipePreview() {
  const recipeId = document.getElementById('batch-recipe-select').value;
  const recipe = state.recipes.find(r => r.id == recipeId);
  const container = document.getElementById('recipe-preview-section');
  
  if (!recipe) {
    container.innerHTML = '';
    return;
  }

  let html = '<strong>Recipe Deductions Required:</strong><ul>';
  recipe.ingredients.forEach(ing => {
    html += `<li>${ing.quantity_required} ${ing.unit} &mdash; ${ing.name}</li>`;
  });
  html += '</ul>';
  container.innerHTML = html;
}

// ==========================================
// 🔑 SUPABASE AUTHENTICATION SYSTEM
// ==========================================
async function setupAuth() {
  initSupabase();

  const authContainer = document.getElementById('auth-container');
  const authForm = document.getElementById('auth-form');
  const authTitle = document.getElementById('auth-title');
  const authSubtitle = document.getElementById('auth-subtitle');
  const authToggleBtn = document.getElementById('auth-toggle-btn');
  const authToggleText = document.getElementById('auth-toggle-text');
  const authError = document.getElementById('auth-error');
  const groupFullname = document.getElementById('group-fullname');
  const groupRole = document.getElementById('group-role');
  const btnAuthSubmit = document.getElementById('btn-auth-submit');
  const authUserInfo = document.getElementById('auth-user-info');
  const authUserEmail = document.getElementById('auth-user-email');
  const btnAuthLogout = document.getElementById('btn-auth-logout');
  const roleSelectBox = document.getElementById('role-select-box');

  let isSignUpMode = false;

  // Check if we are in bypass/testing mode
  if (isAuthBypass) {
    authSubtitle.innerHTML = '⚠️ <strong>Local Testing Mode:</strong> Supabase API keys are not yet configured in `.env`. You can log in using any email to test the UI.';
  }

  // Check for existing session on page load
  let sessionRecovered = false;
  if (!isAuthBypass && supabaseClient) {
    try {
      const { data: { session }, error } = await supabaseClient.auth.getSession();
      if (session) {
        handleSuccessfulLogin(session.user, session.access_token);
        sessionRecovered = true;
      }
    } catch (e) {
      console.error("Session check failed, falling back to login:", e);
    }
  }

  if (!sessionRecovered) {
    // Check if user previously logged in via bypass mode
    const bypassUser = localStorage.getItem('bypass_user');
    if (bypassUser) {
      const u = JSON.parse(bypassUser);
      handleBypassLogin(u.email, u.role);
      return;
    }
  } else {
    return;
  }

  // Show auth modal overlay if no active session
  authContainer.classList.add('active');

  // Toggle signup/login mode
  authToggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    isSignUpMode = !isSignUpMode;
    authError.style.display = 'none';

    if (isSignUpMode) {
      authTitle.textContent = 'Create Workspace Account';
      authSubtitle.textContent = 'Register a new operator profile with designated access role';
      authToggleText.textContent = 'Already have an account?';
      authToggleBtn.textContent = 'Login Here';
      btnAuthSubmit.textContent = 'Request Access';
      groupFullname.style.display = 'block';
      if (groupRole) groupRole.style.display = 'block';
    } else {
      authTitle.textContent = 'Access Secure Workspace';
      authSubtitle.textContent = 'Please authenticate to access the manufacturing floor and ledger';
      authToggleText.textContent = "Don't have an account?";
      authToggleBtn.textContent = 'Request Access';
      btnAuthSubmit.textContent = 'Sign In';
      groupFullname.style.display = 'none';
      if (groupRole) groupRole.style.display = 'none';
    }
  });

  // Handle Form Submit (Login / Register)
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.style.display = 'none';

    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    const fullname = document.getElementById('auth-fullname') ? document.getElementById('auth-fullname').value.trim() : '';
    const role = document.getElementById('auth-role') ? document.getElementById('auth-role').value : 'ADMIN';

    if (isAuthBypass) {
      handleBypassLogin(email, role);
      return;
    }

    try {
      if (isSignUpMode) {
        // Sign Up with Supabase
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullname
            }
          }
        });

        if (error) throw error;
        
        if (data.user) {
          // Register the user's role in the database via backend
          const regRes = await fetch(`${BACKEND_URL}/api/v1/auth/register-role`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: data.user.id, email: data.user.email, role })
          });

          if (!regRes.ok) {
            const errJson = await regRes.json();
            throw new Error(errJson.error || 'Failed to register role mapping');
          }

          alert('Registration successful! Logging in...');
          
          // Try to sign in automatically
          const loginRes = await supabaseClient.auth.signInWithPassword({ email, password });
          if (loginRes.error) throw loginRes.error;
          if (loginRes.data.session) {
            handleSuccessfulLogin(loginRes.data.session.user, loginRes.data.session.access_token);
          }
        }
      } else {
        // Sign In with Supabase
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.session) {
          handleSuccessfulLogin(data.session.user, data.session.access_token);
        }
      }
    } catch (err) {
      authError.textContent = err.message || 'Authentication failed';
      authError.style.display = 'block';
    }
  });

  // Handle Logout
  btnAuthLogout.addEventListener('click', async () => {
    if (!isAuthBypass && supabaseClient) {
      await supabaseClient.auth.signOut();
    }
    
    // Clear state & storage
    state.accessToken = null;
    localStorage.removeItem('bypass_user');
    authUserInfo.style.display = 'none';
    if (roleSelectBox) roleSelectBox.style.display = 'block';
    authForm.reset();
    authError.style.display = 'none';
    
    // Reset to Login overlay
    authContainer.classList.add('active');
  });

  async function handleSuccessfulLogin(user, token) {
    state.accessToken = token;
    
    try {
      // Query backend for role details
      const meRes = await fetch(`${BACKEND_URL}/api/v1/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (meRes.ok) {
        const meData = await meRes.json();
        state.activeRole = meData.role;
        userDisplayName.textContent = meData.name;
        
        // Sync the mock selector dropdown for compatibility checks
        if (roleSelect) {
          roleSelect.value = meData.role;
        }
      } else {
        state.activeRole = 'ADMIN';
        userDisplayName.textContent = user.email;
      }
      
      // Update sidebar footer
      authUserEmail.textContent = user.email;
      authUserInfo.style.display = 'block';
      if (roleSelectBox) roleSelectBox.style.display = 'none';
      
      authContainer.classList.remove('active');
      
      // Refresh UI state with proper role credentials
      applyRoleRestrictions();
      loadAllData();
    } catch (err) {
      console.error("Failed to load user credentials:", err);
      authContainer.classList.remove('active');
    }
  }

  function handleBypassLogin(email, role) {
    state.accessToken = null;
    state.activeRole = role;
    userDisplayName.textContent = email.split('@')[0];
    localStorage.setItem('bypass_user', JSON.stringify({ email, role }));

    if (roleSelect) {
      roleSelect.value = role;
    }

    authUserEmail.textContent = email;
    authUserInfo.style.display = 'block';
    if (roleSelectBox) roleSelectBox.style.display = 'block';

    authContainer.classList.remove('active');
    applyRoleRestrictions();
    loadAllData();
  }
}

// ==========================================
// ❄️ COLD ROOM BRIDGE & CALCULATOR FUNCTIONS
// ==========================================

window.selectColdProduct = async function(prodName) {
  state.selectedColdProduct = prodName;
  
  if (state.activeScreen === 'product-bridge') {
    const container = document.getElementById('bridge-product-list');
    if (container) {
      const buttons = container.querySelectorAll('button');
      state.finishedGoods.forEach((prod, idx) => {
        if (buttons[idx]) {
          if (prod.name === prodName) {
            buttons[idx].style.background = 'rgba(56, 189, 248, 0.08)';
            buttons[idx].style.borderColor = '#38bdf8';
          } else {
            buttons[idx].style.background = 'rgba(255, 255, 255, 0.02)';
            buttons[idx].style.borderColor = 'var(--border-card)';
          }
        }
      });
    }
  } else {
    const rows = document.querySelectorAll('#cold-finished-goods-body tr');
    state.finishedGoods.forEach((prod, idx) => {
      if (rows[idx]) {
        if (prod.name === prodName) {
          rows[idx].style.background = 'rgba(56, 189, 248, 0.08)';
        } else {
          rows[idx].style.background = '';
        }
      }
    });
  }

  // Load production/consumption analytics for this product
  try {
    const data = await apiGet(`/api/v1/production/analytics/${encodeURIComponent(prodName)}`);
    state.coldProductAnalytics = data;
  } catch (err) {
    console.error('Failed to load cold product analytics:', err);
    state.coldProductAnalytics = null;
  }

  renderColdRoomBridgePanel();
};

function renderColdRoomBridgePanel() {
  const noProductEl = document.getElementById('bridge-no-product');
  const detailsContainer = document.getElementById('bridge-details-container');
  if (!noProductEl || !detailsContainer) return;

  if (!state.selectedColdProduct) {
    noProductEl.style.display = 'block';
    detailsContainer.style.display = 'none';
    return;
  }

  noProductEl.style.display = 'none';
  detailsContainer.style.display = 'flex';

  const prodName = state.selectedColdProduct;
  const prod = state.finishedGoods.find(p => p.name === prodName);
  
  document.getElementById('bridge-product-name').textContent = prodName;
  document.getElementById('bridge-product-sku').textContent = prod ? prod.SKU : 'N/A';

  const recipe = state.recipes.find(r => r.name === prodName);
  const warningEl = document.getElementById('recipe-bridge-warning');
  const infoEl = document.getElementById('recipe-bridge-info');
  const setupBtn = document.getElementById('btn-setup-recipe-bridge');
  const calcSection = document.getElementById('bridge-calculator-section');

  if (!recipe) {
    warningEl.style.display = 'block';
    infoEl.style.display = 'none';
    calcSection.style.display = 'none';
    setupBtn.textContent = '➕ Setup Bridge';
  } else {
    warningEl.style.display = 'none';
    infoEl.style.display = 'block';
    calcSection.style.display = 'block';
    setupBtn.textContent = '✏️ Edit Bridge';

    document.getElementById('recipe-bridge-yield').textContent = `${recipe.yield_quantity} ${recipe.yield_unit}`;
    
    const ingredientsBody = document.getElementById('recipe-bridge-ingredients-body');
    ingredientsBody.innerHTML = '';
    
    recipe.ingredients.forEach(ing => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td style="padding: 6px 10px; font-size: 12px; border-bottom: 1px solid var(--border-card);">${ing.name} <span style="font-size:10px; color:var(--text-muted);">(${ing.SKU})</span></td>
        <td style="padding: 6px 10px; font-size: 12px; text-align: right; font-weight:600; border-bottom: 1px solid var(--border-card);">${ing.quantity_required} ${ing.unit}</td>
      `;
      ingredientsBody.appendChild(row);
    });
  }

  const analytics = state.coldProductAnalytics || { totalBatches: 0, totalFinishedProductFormed: 0, actualMaterialsUsed: [] };
  
  document.getElementById('bridge-runs-count').textContent = `${analytics.totalBatches} batches`;
  document.getElementById('bridge-goods-formed').textContent = `${analytics.totalFinishedProductFormed} pcs`;

  const historyContainer = document.getElementById('bridge-production-history-container');
  const noHistoryEl = document.getElementById('bridge-no-production-history');

  if (analytics.totalBatches > 0) {
    historyContainer.style.display = 'block';
    noHistoryEl.style.display = 'none';
    
    const historyBody = document.getElementById('bridge-history-consumption-body');
    historyBody.innerHTML = '';

    const materialConsumptionMap = {};

    if (recipe) {
      recipe.ingredients.forEach(ing => {
        materialConsumptionMap[ing.raw_material_id] = {
          name: ing.name,
          SKU: ing.SKU,
          unit: ing.unit,
          actual: 0,
          theoretical: (analytics.totalFinishedProductFormed / recipe.yield_quantity) * ing.quantity_required
        };
      });
    }

    analytics.actualMaterialsUsed.forEach(actual => {
      if (!materialConsumptionMap[actual.raw_material_id]) {
        materialConsumptionMap[actual.raw_material_id] = {
          name: actual.name,
          SKU: actual.SKU,
          unit: actual.unit,
          actual: 0,
          theoretical: 0
        };
      }
      materialConsumptionMap[actual.raw_material_id].actual = actual.total_used;
    });

    Object.values(materialConsumptionMap).forEach(mat => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td style="padding: 6px 10px; font-size: 12px; border-bottom: 1px solid var(--border-card);">${mat.name}</td>
        <td style="padding: 6px 10px; font-size: 12px; text-align: right; font-weight: 600; border-bottom: 1px solid var(--border-card);">${mat.actual.toFixed(2)} ${mat.unit}</td>
        <td style="padding: 6px 10px; font-size: 12px; text-align: right; color: var(--text-secondary); border-bottom: 1px solid var(--border-card);">${mat.theoretical > 0 ? mat.theoretical.toFixed(2) + ' ' + mat.unit : 'N/A'}</td>
      `;
      historyBody.appendChild(row);
    });
  } else {
    historyContainer.style.display = 'none';
    noHistoryEl.style.display = 'block';
  }

  updateBridgeCalculator();
}

function updateBridgeCalculator() {
  const calcTbody = document.getElementById('bridge-calc-tbody');
  const inputEl = document.getElementById('bridge-calc-target');
  const warningEl = document.getElementById('bridge-calc-warning');
  const executeBtn = document.getElementById('btn-bridge-execute-production');
  if (!calcTbody || !inputEl) return;

  const targetQty = parseFloat(inputEl.value) || 0;
  calcTbody.innerHTML = '';

  const recipe = state.recipes.find(r => r.name === state.selectedColdProduct);
  if (!recipe || targetQty <= 0) {
    calcTbody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 12px; font-size: 12px; color: var(--text-muted);">Enter a valid quantity to project.</td></tr>`;
    if (warningEl && executeBtn) {
      warningEl.style.display = 'none';
      executeBtn.disabled = true;
      executeBtn.style.opacity = '0.5';
      executeBtn.style.cursor = 'not-allowed';
    }
    return;
  }

  function checkOverallShortage() {
    let overallShortage = false;
    calcTbody.querySelectorAll('tr').forEach(tr => {
      const input = tr.querySelector('.calc-override-input');
      if (!input) return;
      const ingId = parseInt(input.getAttribute('data-ingid'));
      const customQty = parseFloat(input.value) || 0;
      const rawMat = state.rawMaterials.find(rm => rm.id === ingId);
      const currentStock = rawMat ? rawMat.current_stock : 0;
      
      const statusCell = tr.querySelector('.status-cell');
      if (currentStock >= customQty) {
        statusCell.innerHTML = `<span class="badge badge-success" style="font-size: 10px; padding: 2px 6px;">Available</span>`;
      } else {
        overallShortage = true;
        const shortage = customQty - currentStock;
        statusCell.innerHTML = `<span class="badge badge-danger" style="font-size: 10px; padding: 2px 6px;">Shortage: ${shortage.toFixed(1)} ${rawMat ? rawMat.unit : ''}</span>`;
      }
    });

    if (warningEl && executeBtn) {
      if (overallShortage) {
        warningEl.style.display = 'block';
        executeBtn.disabled = true;
        executeBtn.style.opacity = '0.5';
        executeBtn.style.cursor = 'not-allowed';
      } else {
        warningEl.style.display = 'none';
        executeBtn.disabled = false;
        executeBtn.style.opacity = '1';
        executeBtn.style.cursor = 'pointer';
      }
    }
  }

  recipe.ingredients.forEach(ing => {
    const required = (targetQty / recipe.yield_quantity) * ing.quantity_required;
    const rawMat = state.rawMaterials.find(rm => rm.id === ing.raw_material_id);
    
    const row = document.createElement('tr');
    row.innerHTML = `
      <td style="padding: 6px 10px; font-size: 12px; border-bottom: 1px solid var(--border-card);">${ing.name}</td>
      <td style="padding: 6px 10px; font-size: 12px; text-align: right; border-bottom: 1px solid var(--border-card);">
        <input type="number" 
               class="form-control calc-override-input" 
               data-ingid="${ing.raw_material_id}" 
               step="0.001" 
               min="0" 
               value="${required.toFixed(2)}" 
               style="width: 100px; text-align: right; display: inline-block; padding: 4px 6px; font-size: 12px; height: 28px; margin-right: 4px; border: 1px solid var(--border-card); background: rgba(0,0,0,0.2); color: var(--text-primary); border-radius: 4px;">
        <span style="font-size: 11px; color: var(--text-secondary);">${ing.unit}</span>
      </td>
      <td style="padding: 6px 10px; font-size: 12px; text-align: center; border-bottom: 1px solid var(--border-card);" class="status-cell">
        <!-- Status badge rendered dynamically -->
      </td>
    `;
    calcTbody.appendChild(row);
    
    const inputField = row.querySelector('.calc-override-input');
    inputField.addEventListener('input', checkOverallShortage);
  });

  checkOverallShortage();
}

window.addRecipeIngredientRow = function(selectedId = '', quantity = '') {
  const container = document.getElementById('recipe-rows-container');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'recipe-row';
  row.style.display = 'flex';
  row.style.gap = '10px';
  row.style.alignItems = 'center';

  let options = '<option value="">-- Select Material --</option>';
  state.rawMaterials.forEach(rm => {
    const isSelected = rm.id == selectedId ? 'selected' : '';
    options += `<option value="${rm.id}" ${isSelected}>${rm.name} (${rm.unit})</option>`;
  });

  row.innerHTML = `
    <select class="form-control recipe-mat-select" style="flex: 2; min-width: 0;" required>
      ${options}
    </select>
    <input type="number" class="form-control recipe-qty-input" style="flex: 1; min-width: 0;" step="0.001" min="0.001" placeholder="Qty" value="${quantity}" required>
    <button type="button" class="btn btn-secondary action-dot-btn btn-remove-recipe-row" style="background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: #ef4444; padding: 6px 10px; height: auto;">&times;</button>
  `;

  row.querySelector('.btn-remove-recipe-row').onclick = () => {
    row.remove();
  };

  container.appendChild(row);
};

function renderProductBridgeScreen() {
  const container = document.getElementById('bridge-product-list');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (state.finishedGoods.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 12px; padding: 20px;">No finished goods found.</div>`;
    return;
  }
  
  state.finishedGoods.forEach(prod => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.style.width = '100%';
    btn.style.textAlign = 'left';
    btn.style.padding = '10px 12px';
    btn.style.display = 'flex';
    btn.style.flexDirection = 'column';
    btn.style.gap = '4px';
    btn.style.borderRadius = '6px';
    btn.style.border = '1px solid var(--border-card)';
    btn.style.cursor = 'pointer';
    
    if (state.selectedColdProduct === prod.name) {
      btn.style.background = 'rgba(56, 189, 248, 0.08)';
      btn.style.borderColor = '#38bdf8';
    } else {
      btn.style.background = 'rgba(255, 255, 255, 0.02)';
    }
    
    btn.onclick = () => {
      selectColdProduct(prod.name);
    };
    
    btn.innerHTML = `
      <div style="font-weight: 700; font-size: 13px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${prod.name}</div>
      <div style="font-size: 10px; color: var(--text-muted); font-family: monospace;">SKU: ${prod.SKU}</div>
    `;
    container.appendChild(btn);
  });
  
  renderColdRoomBridgePanel();
}

function setupManualSalesDesk() {
  setupTallyEventListeners();
  resetTallyVoucher();

  // Register global hotkey listeners for Tally Billing Screen
  window.addEventListener('keydown', (e) => {
    if (state.activeScreen !== 'sales-desk') return;
    const tabBooking = document.getElementById('btn-tab-pos-booking');
    if (tabBooking && !tabBooking.classList.contains('active')) return;

    const acceptOverlay = document.getElementById('tally-accept-overlay');
    const isAcceptOpen = acceptOverlay && acceptOverlay.classList.contains('active');

    if (isAcceptOpen) {
      if (e.key.toLowerCase() === 'y' || e.key === 'Enter') {
        e.preventDefault();
        processTallyCheckout(false);
        closeTallyAcceptDialog();
      } else if (e.key.toLowerCase() === 'n' || e.key === 'Escape') {
        e.preventDefault();
        closeTallyAcceptDialog();
      }
      return;
    }

    if (e.key === 'F2') {
      e.preventDefault();
      document.getElementById('shortcut-btn-date').click();
    }
    
    if (e.altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      document.getElementById('shortcut-btn-add-party').click();
    }

    if (e.altKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      document.getElementById('shortcut-btn-add-row').click();
    }

    if (e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      processTallyCheckout(true);
    }

    if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      openTallyAcceptDialog();
    }

    if (e.key === 'Escape') {
      if (document.activeElement && document.activeElement.tagName === 'INPUT') {
        document.activeElement.blur();
        state.tallyVoucher.activeCell = '';
        updateTallyHelperList();
      } else {
        document.getElementById('shortcut-btn-reset').click();
      }
    }
  });
}



// Robust date formatting helper function
function formatDateOnly(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) {
      return dateStr.split(/[ T]/)[0] || 'N/A';
    }
    const yy = d.getFullYear();
    const mm = (d.getMonth() + 1).toString().padStart(2, '0');
    const dd = d.getDate().toString().padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  } catch (e) {
    return dateStr.split(/[ T]/)[0] || 'N/A';
  }
}

