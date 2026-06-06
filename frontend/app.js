// ==========================================
// Stitch ERP Frontend JavaScript Application
// ==========================================

// For automated testing verification support
if (window.location.search.includes('bypassConfirm=true')) {
  window.confirm = () => true;
}

// State variables
let state = {
  activeRole: 'ADMIN',
  activeScreen: 'factory-floor',
  recipes: [],
  rawMaterials: [],
  inventoryBatches: [],
  productionBatches: [],
  finishedGoods: [],
  orders: [],
  gateLogs: [],
  auditLogs: [],
  cart: {}, // Format: { "Product Name": quantity }
  settings: { gst_rate: 0.18 },
  isDarkMode: true
};

let charts = {
  annualFinancials: null,
  annualDoughnut: null,
  monthlyDaily: null,
  coldRoomTemp: null,
  distributorAnnual: null,
  distributorMonthly: null
};

const wsUrl = `ws://${window.location.host}`;
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
const modalGateCheckin = document.getElementById('modal-gate-checkin');
const modalAddInventory = document.getElementById('modal-add-inventory');
const modalInvoiceViewer = document.getElementById('modal-invoice-viewer');
const invoiceFrame = document.getElementById('invoice-frame');

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  setupAuth();
  setupNavigation();
  setupRoleManager();
  applyRoleRestrictions();
  setupThemeToggle();
  setupModalCloses();
  setupFormHandlers();
  setupWS();
  
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
    loadGateLogs(),
    loadAuditLogs()
  ]);
  renderAll();
}

// ==========================================
// 📡 WEBSOCKET CONNECTION
// ==========================================
function setupWS() {
  try {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      document.querySelector('.status-dot').className = 'status-dot online';
    };
    ws.onmessage = (event) => {
      const { event: evType, data } = JSON.parse(event.data);
      console.log('WS Message received:', evType, data);
      
      // Reactive reload based on event types
      if (evType === 'INVENTORY_UPDATED') {
        loadRawMaterials().then(() => { renderAll(); });
      } else if (evType === 'PRODUCTION_STARTED' || evType === 'PRODUCTION_UPDATED') {
        loadProductionBatches().then(() => { loadFinishedGoods().then(() => { renderAll(); }); });
      } else if (evType === 'ORDER_CREATED' || evType === 'ORDER_UPDATED') {
        loadOrders().then(() => { loadFinishedGoods().then(() => { loadDistributors().then(() => { renderAll(); }); }); });
      } else if (evType === 'GATE_IN_EVENT' || evType === 'GATE_OUT_EVENT') {
        loadGateLogs().then(() => { renderAll(); });
      } else if (evType === 'SETTINGS_UPDATED') {
        loadSettings().then(() => { renderAll(); });
      } else if (evType === 'DISTRIBUTORS_UPDATED') {
        loadDistributors().then(() => { renderAll(); });
      }
      
      // Always reload audit logs
      loadAuditLogs().then(renderAuditLogsScreen);
    };
    ws.onclose = () => {
      document.querySelector('.status-dot').className = 'status-dot';
      // Attempt reconnect in 5s
      setTimeout(setupWS, 5000);
    };
  } catch (err) {
    console.error('WebSocket connection failed:', err);
  }
}

// ==========================================
// 📥 API REQUEST HANDLERS
// ==========================================
async function apiGet(path) {
  const res = await fetch(path, {
    headers: getRequestHeaders()
  });
  return await res.json();
}

async function apiPost(path, body) {
  const res = await fetch(path, {
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
  const res = await fetch(path, {
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
  const res = await fetch(path, {
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
}

async function loadGateLogs() {
  state.gateLogs = await apiGet('/api/v1/logistics/gate-logs');
}

async function loadAuditLogs() {
  if (state.activeRole === 'ADMIN') {
    state.auditLogs = await apiGet('/api/v1/audit-trails');
  }
}

// ==========================================
// 🛠️ NAVIGATION & ACCESS CONTROL (RBAC)
// ==========================================
window.viewOrderInvoice = function(orderId) {
  invoiceFrame.src = `/api/v1/sales/orders/${orderId}/invoice`;
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
  let subtitle = 'Stitch Ice Cream ERP';
  if (screenId === 'factory-floor') {
    title = 'Live Factory Floor Dashboard';
    subtitle = 'Real-time production monitoring and logistics tracker';
  } else if (screenId === 'sales-desk') {
    title = 'Interactive Sales & Billing Desk';
    subtitle = 'Distributor order book POS and dispatch queuing';
  } else if (screenId === 'inventory-matrix') {
    title = 'Batch Inventory & Traceability Matrix';
    subtitle = 'Expiry monitoring and end-to-end batch lot mapping';
  } else if (screenId === 'audit-logs') {
    title = 'Immutable Audit Trail Ledger';
    subtitle = 'System write audit events matching database hooks';
  } else if (screenId === 'financial-full-year') {
    title = 'Full Year Financials Analysis';
    subtitle = 'Comprehensive annual revenue, profit margins, and GST auditing';
  } else if (screenId === 'monthly-dashboard') {
    title = 'Monthly Operations Dashboard';
    subtitle = 'Monthly billing, production output, and resource consumption';
  } else if (screenId === 'raw-materials') {
    title = 'Raw Material Stock & Safety Matrix';
    subtitle = 'Ingredient inventory levels, safety thresholds, and replenishment status';
  } else if (screenId === 'cold-room') {
    title = 'Cold Room Finished Goods Stock';
    subtitle = 'Finished goods inventory logs, cold-chain temperature metrics, and valuations';
  }
  
  screenTitle.textContent = title;
  screenSubtitle.textContent = subtitle;
  
  renderAll();
}

function applyRoleRestrictions() {
  const auditsBtn = document.getElementById('nav-audits');
  const finFullBtn = document.getElementById('nav-financial-full-year');
  const monthlyBtn = document.getElementById('nav-monthly-dashboard');
  const rawBtn = document.getElementById('nav-raw-materials');
  const coldBtn = document.getElementById('nav-cold-room');
  const gstSetting = document.getElementById('gst-setting-container');
  
  const r = state.activeRole;
  
  // Audits and the 4 dashboards are Admin only, hidden for all other users
  auditsBtn.style.display = (r === 'ADMIN') ? 'block' : 'none';
  finFullBtn.style.display = (r === 'ADMIN') ? 'block' : 'none';
  monthlyBtn.style.display = (r === 'ADMIN') ? 'block' : 'none';
  rawBtn.style.display = (r === 'ADMIN') ? 'block' : 'none';
  coldBtn.style.display = (r === 'ADMIN') ? 'block' : 'none';
  if (gstSetting) {
    gstSetting.style.display = (r === 'ADMIN') ? 'block' : 'none';
  }

  // Redirect to safe fallback (factory-floor) if the active screen is restricted for non-admin
  const restrictedScreens = ['audit-logs', 'financial-full-year', 'monthly-dashboard', 'raw-materials', 'cold-room'];
  if (r !== 'ADMIN' && restrictedScreens.includes(state.activeScreen)) {
    switchScreen('factory-floor');
  }
}

function setupRoleManager() {
  roleSelect.addEventListener('change', (e) => {
    state.activeRole = e.target.value;
    
    // Set mock user display name
    let mockUser = 'System Admin';
    if (state.activeRole === 'INVENTORY_MANAGER') mockUser = 'Vikram (Inv Mgr)';
    else if (state.activeRole === 'PRODUCTION_SUPERVISOR') mockUser = 'Rajesh (Prod Supv)';
    else if (state.activeRole === 'SALES_AGENT') mockUser = 'Priya (Sales Desk)';
    userDisplayName.textContent = mockUser;

    applyRoleRestrictions();

    // Refresh UI permissions
    renderAll();
  });
}

// Check role permissions for interactive actions
function hasPermission(action) {
  if (state.activeRole === 'ADMIN') return true;
  
  if (action === 'START_PRODUCTION') return state.activeRole === 'PRODUCTION_SUPERVISOR';
  if (action === 'TRANSITION_PRODUCTION') return state.activeRole === 'PRODUCTION_SUPERVISOR';
  if (action === 'ADD_INVENTORY') return state.activeRole === 'INVENTORY_MANAGER';
  if (action === 'VEHICLE_LOGISTICS') return state.activeRole === 'SALES_AGENT';
  if (action === 'CREATE_ORDER') return state.activeRole === 'SALES_AGENT';
  
  return false;
}

// ==========================================
// 💡 THEME MANAGER
// ==========================================
function setupThemeToggle() {
  themeToggle.addEventListener('click', () => {
    state.isDarkMode = !state.isDarkMode;
    document.body.classList.toggle('light-mode', !state.isDarkMode);
    themeToggle.innerHTML = state.isDarkMode ? '<span>☀️</span> Light Mode' : '<span>🌙</span> Dark Mode';
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
  // Metric A: Active batches
  const activeCount = state.productionBatches.filter(b => ['MIXING', 'AGING', 'CHURNING_FREEZING', 'HARDENING'].includes(b.status)).length;
  document.getElementById('metric-active-batches').textContent = activeCount;

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

  // Metric D: Trucks in gate
  const trucksIn = state.gateLogs.filter(t => !t.time_out).length;
  document.getElementById('metric-gate-trucks').textContent = trucksIn;
}

function renderFactoryScreen() {
  renderMetrics();

  // Render Kanban Columns
  const columns = {
    'MIXING': document.getElementById('cards-mixing'),
    'AGING': document.getElementById('cards-aging'),
    'CHURNING_FREEZING': document.getElementById('cards-churning'),
    'HARDENING': document.getElementById('cards-hardening')
  };

  // Clear columns
  Object.keys(columns).forEach(key => {
    columns[key].innerHTML = '';
    document.getElementById(`count-${key.toLowerCase().replace('_freezing','')}`).textContent = 0;
  });

  const columnCounters = { 'MIXING': 0, 'AGING': 0, 'CHURNING_FREEZING': 0, 'HARDENING': 0 };

  state.productionBatches.forEach(batch => {
    const col = columns[batch.status];
    if (!col) return;

    columnCounters[batch.status]++;
    
    // Construct Card
    const card = document.createElement('div');
    card.className = `kanban-card`;
    
    // Color code left border based on recipe status
    if (batch.status === 'AGING') card.style.borderLeftColor = 'var(--soft-amber)';
    else if (batch.status === 'CHURNING_FREEZING') card.style.borderLeftColor = 'var(--ice-blue)';
    else if (batch.status === 'HARDENING') card.style.borderLeftColor = 'var(--cobalt)';

    let timerHtml = '';
    if (batch.status === 'AGING' && batch.aging_end_time) {
      timerHtml = `
        <div class="card-timer-row">
          <span>🕒 Aging: </span>
          <span class="aging-timer" data-endtime="${batch.aging_end_time}">Calculating...</span>
        </div>
      `;
    }

    // Role check to show state action buttons
    let actionButtonsHtml = '';
    if (hasPermission('TRANSITION_PRODUCTION')) {
      if (batch.status === 'MIXING') {
        actionButtonsHtml = `<button class="btn btn-secondary action-dot-btn" onclick="transitionBatch(${batch.id}, 'AGING')">Send to Aging &rarr;</button>`;
      } else if (batch.status === 'AGING') {
        actionButtonsHtml = `<button class="btn btn-secondary action-dot-btn" onclick="transitionBatch(${batch.id}, 'CHURNING_FREEZING')">Freeze &rarr;</button>`;
      } else if (batch.status === 'CHURNING_FREEZING') {
        actionButtonsHtml = `<button class="btn btn-secondary action-dot-btn" onclick="transitionBatch(${batch.id}, 'HARDENING')">Hardening &rarr;</button>`;
      } else if (batch.status === 'HARDENING') {
        actionButtonsHtml = `<button class="btn btn-primary action-dot-btn" onclick="transitionBatch(${batch.id}, 'COMPLETED')">Complete Batch 🎉</button>`;
      }
    }

    card.innerHTML = `
      <div class="card-title-row">
        <span class="card-code">${batch.batch_code}</span>
        <span class="badge ${batch.status === 'AGING' ? 'badge-warning' : 'badge-success'}">${batch.status.replace('_', ' ')}</span>
      </div>
      <div class="card-flavor">${batch.flavor_name}</div>
      ${timerHtml}
      <div class="card-actions-row">${actionButtonsHtml}</div>
    `;

    col.appendChild(card);
  });

  // Update counters
  Object.keys(columnCounters).forEach(key => {
    document.getElementById(`count-${key.toLowerCase().replace('_freezing','')}`).textContent = columnCounters[key];
  });

  // Render Gate Logs Table
  const tableBody = document.getElementById('gate-logs-table-body');
  tableBody.innerHTML = '';

  const activeGateLogs = state.gateLogs.slice(0, 10); // Show top 10 logs
  
  if (activeGateLogs.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No vehicle logs currently checked in.</td></tr>`;
    return;
  }

  activeGateLogs.forEach(log => {
    let actionCell = '';
    if (!log.time_out) {
      if (hasPermission('VEHICLE_LOGISTICS')) {
        actionCell = `<button class="btn btn-danger action-dot-btn" onclick="checkoutVehicle(${log.id})">Out-Gate Log</button>`;
      } else {
        actionCell = `<span class="badge badge-warning">IN FACTORY</span>`;
      }
    } else {
      actionCell = `<span class="badge badge-success">CHECKED OUT</span>`;
    }

    let durationCell = '';
    if (log.time_out) {
      const elapsed = Math.round((new Date(log.time_out) - new Date(log.time_in)) / 60000);
      durationCell = `${elapsed} min`;
    } else {
      durationCell = `<span class="live-truck-timer" data-timein="${log.time_in}">Ticking...</span>`;
    }

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${log.vehicle_number}</strong></td>
      <td>${log.driver_name}</td>
      <td>${log.purpose}</td>
      <td>${log.time_in.substring(11, 19)}</td>
      <td>${durationCell}</td>
      <td>${actionCell}</td>
    `;
    tableBody.appendChild(row);
  });

  // Enable/Disable Launch Batch button
  const launchBtn = document.getElementById('btn-start-batch-trigger');
  launchBtn.disabled = !hasPermission('START_PRODUCTION');
  launchBtn.style.opacity = hasPermission('START_PRODUCTION') ? '1' : '0.4';

  // Enable/Disable Register Truck button
  const truckBtn = document.getElementById('btn-btn-checkin-trigger');
  const registerBtn = document.getElementById('btn-checkin-trigger');
  registerBtn.disabled = !hasPermission('VEHICLE_LOGISTICS');
  registerBtn.style.opacity = hasPermission('VEHICLE_LOGISTICS') ? '1' : '0.4';
}

// Transition batch states
async function transitionBatch(batchId, nextStatus) {
  try {
    await apiPut(`/api/v1/production/batches/${batchId}/status`, { status: nextStatus });
  } catch (err) {
    alert('Failed to update status: ' + err.message);
  }
}

// Log a truck out
async function checkoutVehicle(logId) {
  try {
    await apiPut(`/api/v1/logistics/gate-out/${logId}`);
  } catch (err) {
    alert('Log checkout failed: ' + err.message);
  }
}

// ==========================================
// 💰 SCREEN B: SALES POS & INVOICING
// ==========================================

// Customer-specific price overrides stored per cart session
// Format: { "Product Name": overriddenPrice }
if (!state.cartPriceOverrides) state.cartPriceOverrides = {};

function renderSalesScreen() {
  const container = document.getElementById('product-grid-container');
  container.innerHTML = '';

  const isAdmin = state.activeRole === 'ADMIN';

  state.finishedGoods.forEach(prod => {
    const card = document.createElement('div');
    card.className = 'product-card';

    // Stock Badge formatting
    let badgeClass = 'badge-success';
    let badgeText = 'IN STOCK';
    if (prod.stock_qty === 0) {
      badgeClass = 'badge-danger';
      badgeText = 'OUT OF STOCK';
    } else if (prod.stock_qty < 25) {
      badgeClass = 'badge-warning';
      badgeText = 'LOW STOCK';
    }

    const qtyInCart = state.cart[prod.name] || 0;

    // Escape product name for onclick handlers (handle single quotes in names)
    const escapedName = prod.name.replace(/'/g, "\\'");

    // Admin action buttons (Edit Price + Delete)
    let adminActions = '';
    if (isAdmin) {
      adminActions = `
        <div class="prod-admin-actions">
          <button class="btn-edit-price" onclick="editProductPrice(${prod.id}, '${escapedName}', ${prod.price})" title="Edit Base Price">
            ✏️ Edit Price
          </button>
          <button class="btn-delete-product" onclick="deleteProduct(${prod.id}, '${escapedName}')" title="Delete / Discontinue Product">
            🗑️ Delete
          </button>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="prod-meta">
        <div class="prod-sku">${prod.SKU}</div>
        <div class="prod-name">${prod.name}</div>
      </div>
      <div class="prod-details">
        <div class="prod-price">₹${prod.price.toFixed(2)}</div>
        <span class="badge ${badgeClass}">${badgeText} (${prod.stock_qty} pcs)</span>
      </div>
      ${adminActions}
      <div class="prod-action-row">
        <div class="counter-ctrl">
          <button class="btn-counter" onclick="adjustCart('${escapedName}', -1)">-</button>
          <span class="counter-value">${qtyInCart}</span>
          <button class="btn-counter" onclick="adjustCart('${escapedName}', 1)">+</button>
        </div>
        <button class="btn btn-secondary action-dot-btn" onclick="addToCart('${escapedName}', 5)">+5</button>
      </div>
    `;
    container.appendChild(card);
  });

  renderCart();


}

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

function adjustCart(prodName, amount) {
  const prod = state.finishedGoods.find(p => p.name === prodName);
  if (!prod) return;

  const current = state.cart[prodName] || 0;
  const next = current + amount;

  if (next <= 0) {
    delete state.cart[prodName];
  } else if (next > prod.stock_qty) {
    alert(`Cannot exceed available warehouse stock: ${prod.stock_qty} units.`);
    state.cart[prodName] = prod.stock_qty;
  } else {
    state.cart[prodName] = next;
  }

  renderSalesScreen();
}

function addToCart(prodName, count) {
  const prod = state.finishedGoods.find(p => p.name === prodName);
  if (!prod) return;

  const current = state.cart[prodName] || 0;
  const next = current + count;

  if (next > prod.stock_qty) {
    state.cart[prodName] = prod.stock_qty;
  } else {
    state.cart[prodName] = next;
  }

  renderSalesScreen();
}

function renderCart() {
  const container = document.getElementById('cart-items-list');
  container.innerHTML = '';

  const cartKeys = Object.keys(state.cart);
  
  if (cartKeys.length === 0) {
    container.innerHTML = `<div class="empty-cart-message">Your cart is empty. Click [Add +] on catalog cards to book items.</div>`;
    document.getElementById('price-subtotal').textContent = '₹0.00';
    document.getElementById('price-tax').textContent = '₹0.00';
    document.getElementById('price-total').textContent = '₹0.00';
    document.getElementById('btn-generate-invoice').disabled = true;
    document.getElementById('btn-print-invoice').disabled = true;
    return;
  }

  let subtotal = 0;

  cartKeys.forEach(name => {
    const prod = state.finishedGoods.find(p => p.name === name);
    if (!prod) return;

    const qty = state.cart[name];
    // Use customer-specific price override if set, otherwise default
    const effectivePrice = state.cartPriceOverrides[name] !== undefined ? state.cartPriceOverrides[name] : prod.price;
    const cost = effectivePrice * qty;
    subtotal += cost;

    const isOverridden = state.cartPriceOverrides[name] !== undefined && state.cartPriceOverrides[name] !== prod.price;
    const escapedName = name.replace(/'/g, "\\'");

    const row = document.createElement('div');
    row.className = 'cart-item-row';
    row.innerHTML = `
      <div class="cart-item-info">
        <span class="cart-item-title">${name}</span>
        <span class="cart-item-qty">${qty} pcs &times;
          <span class="cart-price-edit-wrapper">
            ₹<input type="number" class="cart-price-input" value="${effectivePrice.toFixed(2)}" step="0.01" min="0.01" 
              onchange="updateCartPriceOverride('${escapedName}', this)"
              onblur="updateCartPriceOverride('${escapedName}', this)"
              title="Edit price for this customer order" />
          </span>
          ${isOverridden ? '<span class="price-override-badge">CUSTOM</span>' : ''}
        </span>
      </div>
      <div class="cart-item-actions">
        <div class="cart-item-price">₹${cost.toFixed(2)}</div>
        <button class="btn-cart-remove" onclick="removeFromCart('${escapedName}')" title="Remove item">✕</button>
      </div>
    `;
    container.appendChild(row);
  });

  const gstRate = (state.settings && state.settings.gst_rate !== undefined) ? state.settings.gst_rate : 0.18;
  const tax = subtotal * gstRate;
  const total = subtotal + tax;

  const cartGstLabel = document.getElementById('cart-gst-rate');
  if (cartGstLabel) {
    cartGstLabel.textContent = (gstRate * 100).toFixed(1).replace('.0', '');
  }

  document.getElementById('price-subtotal').textContent = `₹${subtotal.toFixed(2)}`;
  document.getElementById('price-tax').textContent = `₹${tax.toFixed(2)}`;
  document.getElementById('price-total').textContent = `₹${total.toFixed(2)}`;

  // Checkout Permissions Check
  const canCheckout = hasPermission('CREATE_ORDER');
  document.getElementById('btn-generate-invoice').disabled = !canCheckout;
  document.getElementById('btn-print-invoice').disabled = !canCheckout;
}

// Recalculate cart totals without full re-render (avoids losing input focus)
function recalcCartTotals() {
  let subtotal = 0;
  Object.keys(state.cart).forEach(name => {
    const prod = state.finishedGoods.find(p => p.name === name);
    if (!prod) return;
    const effectivePrice = state.cartPriceOverrides[name] !== undefined ? state.cartPriceOverrides[name] : prod.price;
    subtotal += effectivePrice * state.cart[name];
  });
  const gstRate = (state.settings && state.settings.gst_rate !== undefined) ? state.settings.gst_rate : 0.18;
  const tax = subtotal * gstRate;
  const total = subtotal + tax;
  document.getElementById('price-subtotal').textContent = `₹${subtotal.toFixed(2)}`;
  document.getElementById('price-tax').textContent = `₹${tax.toFixed(2)}`;
  document.getElementById('price-total').textContent = `₹${total.toFixed(2)}`;
}

// Remove item from cart
window.removeFromCart = function(prodName) {
  delete state.cart[prodName];
  delete state.cartPriceOverrides[prodName];
  renderSalesScreen();
};

// Generate bill trigger helper
async function processCheckout(autoPrint = false) {
  const customerName = document.getElementById('customer-name-input').value.trim();
  if (!customerName) {
    alert('Please enter a distributor or customer name.');
    return;
  }

  // Build items with customer-specific price overrides
  const items = Object.keys(state.cart).map(name => {
    const item = { name, quantity: state.cart[name] };
    // Attach price override if set
    if (state.cartPriceOverrides[name] !== undefined) {
      item.price = state.cartPriceOverrides[name];
    }
    return item;
  });

  try {
    const customerLocation = document.getElementById('customer-location-input').value.trim();
    const result = await apiPost('/api/v1/sales/orders', {
      customer_name: customerName,
      location: customerLocation,
      items
    });

    // Clear cart, price overrides, and customer info
    state.cart = {};
    state.cartPriceOverrides = {};
    document.getElementById('customer-name-input').value = '';
    const locInput = document.getElementById('customer-location-input');
    if (locInput) {
      locInput.value = '';
      locInput.disabled = false;
    }
    
    // Refresh POS catalog view
    renderSalesScreen();

    // Setup print hook on iframe load if requested
    if (autoPrint) {
      invoiceFrame.onload = () => {
        try {
          invoiceFrame.contentWindow.print();
        } catch (e) {
          console.error('Auto print failed:', e);
        }
        invoiceFrame.onload = null; // Clean up hook
      };
    } else {
      invoiceFrame.onload = null;
    }

    // Open invoice preview frame in modal
    invoiceFrame.src = `/api/v1/sales/orders/${result.orderId}/invoice`;
    openModal('modal-invoice-viewer');

  } catch (err) {
    alert('Checkout failed: ' + err.message);
  }
}

document.getElementById('btn-generate-invoice').addEventListener('click', () => processCheckout(false));
document.getElementById('btn-print-invoice').addEventListener('click', () => processCheckout(true));

// ==========================================
// 📦 SCREEN C: EXPIRY & TRACEABILITY MATRIX
// ==========================================
function renderInventoryScreen() {
  const tableBody = document.getElementById('inventory-matrix-table-body');
  tableBody.innerHTML = '';

  const now = new Date();
  const warningThreshold = 3 * 24 * 60 * 60 * 1000; // 3 days

  state.inventoryBatches.forEach(batch => {
    const expiry = new Date(batch.expiry_date);
    const timeLeft = expiry - now;

    let warningClass = '';
    let statusText = 'SAFE';
    let statusBadge = 'badge-success';

    if (timeLeft <= 0) {
      warningClass = 'row-danger';
      statusText = 'EXPIRED';
      statusBadge = 'badge-danger';
    } else if (timeLeft <= warningThreshold) {
      warningClass = 'row-warning';
      statusText = 'FEFO PRIORITIZED';
      statusBadge = 'badge-warning';
    }

    const row = document.createElement('tr');
    if (warningClass) row.className = warningClass;

    row.innerHTML = `
      <td><strong>${batch.material_name}</strong></td>
      <td>${batch.SKU}</td>
      <td><span class="card-code">${batch.batch_number}</span></td>
      <td>${batch.quantity_received} ${batch.unit}</td>
      <td><strong>${batch.remaining_quantity} ${batch.unit}</strong></td>
      <td>${batch.expiry_date.split(' ')[0]}</td>
      <td><span class="badge ${statusBadge}">${statusText}</span></td>
    `;
    tableBody.appendChild(row);
  });

  // Enable/Disable Add Stock button
  const addStockBtn = document.getElementById('btn-add-inventory-trigger');
  addStockBtn.disabled = !hasPermission('ADD_INVENTORY');
  addStockBtn.style.opacity = hasPermission('ADD_INVENTORY') ? '1' : '0.4';

  // Fill traceability select dropdown options
  const select = document.getElementById('traceability-batch-select');
  select.innerHTML = '<option value="">-- Choose Completed Batch --</option>';

  const completedBatches = state.productionBatches.filter(b => b.status === 'COMPLETED');
  completedBatches.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.batch_code;
    opt.textContent = `${b.batch_code} - ${b.flavor_name} (${b.quantity_produced} units)`;
    select.appendChild(opt);
  });
}

// Traceability diagram drawing logic
document.getElementById('traceability-batch-select').addEventListener('change', async (e) => {
  const batchCode = e.target.value;
  const canvasContainer = document.getElementById('trace-diagram-canvas-container');
  canvasContainer.innerHTML = '';

  if (!batchCode) {
    canvasContainer.innerHTML = `
      <div class="trace-placeholder">
        <div class="placeholder-icon">🔍</div>
        <p>Click on any completed production batch above or select from the dropdown to construct the ingredients traceability tree.</p>
      </div>
    `;
    return;
  }

  try {
    const trace = await apiGet(`/api/v1/traceability/${batchCode}`);
    
    // Draw SVG Tree
    const treeDiv = document.createElement('div');
    treeDiv.className = 'trace-tree';

    // Root Node (Finished Batch)
    const rootNode = document.createElement('div');
    rootNode.className = 'tree-node';
    rootNode.style.borderColor = 'var(--cobalt)';
    rootNode.style.borderWidth = '2px';
    rootNode.innerHTML = `
      <div class="node-title">${trace.flavor_name}</div>
      <div class="node-desc">Finished Batch: <strong>${trace.batch_code}</strong></div>
      <div class="node-desc">Mfg Date: ${trace.start_time.split(' ')[0]}</div>
    `;
    treeDiv.appendChild(rootNode);

    // Connector Line
    const line = document.createElement('div');
    line.className = 'tree-connector';
    treeDiv.appendChild(line);

    // Children Grid (Ingredients Batch details)
    const childrenGrid = document.createElement('div');
    childrenGrid.className = 'tree-children';

    trace.ingredients.forEach(ing => {
      const childNode = document.createElement('div');
      childNode.className = 'tree-node';
      childNode.style.borderColor = 'var(--border-card)';
      
      const isExpired = new Date(ing.expiry_date) < new Date();
      
      childNode.innerHTML = `
        <div class="node-title" style="font-size:11px;">${ing.raw_material_name}</div>
        <div class="node-desc">Lot Batch: <strong>${ing.supplier_batch}</strong></div>
        <div class="node-desc">Deducted: ${ing.quantity_used}</div>
        <div class="node-desc" style="color: ${isExpired ? 'var(--pastel-red)' : 'var(--text-muted)'}; font-size: 9px;">
          Exp: ${ing.expiry_date.split(' ')[0]}
        </div>
      `;
      childrenGrid.appendChild(childNode);
    });

    treeDiv.appendChild(childrenGrid);
    canvasContainer.appendChild(treeDiv);

  } catch (err) {
    canvasContainer.innerHTML = `<div class="alert-amber" style="background-color: var(--pastel-red-bg); border-color: var(--pastel-red); color: var(--pastel-red)">Failed to construct traceability map: ${err.message}</div>`;
  }
});

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
  // 1. Tick Gate Log Duration timers
  document.querySelectorAll('.live-truck-timer').forEach(el => {
    const timeIn = new Date(el.getAttribute('data-timein'));
    const seconds = Math.floor((new Date() - timeIn) / 1000);
    
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    el.textContent = `${hrs > 0 ? hrs + 'h ' : ''}${mins}m ${secs}s`;
  });

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

  // 3. Tick Cold Room Temperature Simulator
  const tempEl = document.getElementById('cold-room-temp');
  if (tempEl && state.activeScreen === 'cold-room') {
    let currentTemp = parseFloat(tempEl.textContent);
    if (isNaN(currentTemp)) currentTemp = -20.4;
    const variation = (Math.random() - 0.5) * 0.25;
    let nextTemp = currentTemp + variation;
    // Bounds check
    if (nextTemp < -21.5) nextTemp = -21.5;
    if (nextTemp > -18.5) nextTemp = -18.5;
    tempEl.textContent = `${nextTemp.toFixed(1)} °C`;

    // Feed to temperature chart
    if (charts.coldRoomTemp) {
      const chart = charts.coldRoomTemp;
      chart.data.labels.shift();
      chart.data.labels.push(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      chart.data.datasets[0].data.shift();
      chart.data.datasets[0].data.push(nextTemp);
      chart.update('none');
    }
  }
}

// Render coordinator
function renderAll() {
  if (state.activeScreen === 'factory-floor') renderFactoryScreen();
  else if (state.activeScreen === 'sales-desk') renderSalesScreen();
  else if (state.activeScreen === 'inventory-matrix') renderInventoryScreen();
  else if (state.activeScreen === 'audit-logs') renderAuditLogsScreen();
  else if (state.activeScreen === 'financial-full-year') renderFinancialFullYear();
  else if (state.activeScreen === 'monthly-dashboard') renderMonthlyDashboard();
  else if (state.activeScreen === 'raw-materials') renderRawMaterials();
  else if (state.activeScreen === 'cold-room') renderColdRoom();
}

// ==========================================
// 📊 NEW DASHBOARDS CONTROLLERS
// ==========================================

// 1. FULL YEAR FINANCIAL DASHBOARD
async function renderFinancialFullYear() {
  try {
    const data = await apiGet('/api/v1/dashboard/financials/full-year');

    // Update KPIs
    document.getElementById('fin-annual-revenue').textContent = `₹${data.summary.totalRevenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('fin-net-profit').textContent = `₹${data.summary.totalProfit.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('fin-taxes').textContent = `₹${data.summary.totalTax.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('fin-total-orders').textContent = data.summary.totalOrders;

    const finGstLabel = document.getElementById('fin-gst-rate');
    if (finGstLabel && state.settings && state.settings.gst_rate !== undefined) {
      finGstLabel.textContent = (state.settings.gst_rate * 100).toFixed(1).replace('.0', '');
    }

    // Draw Bar/Line Chart: Revenue & Tax performance
    const ctxTrend = document.getElementById('chart-annual-financials').getContext('2d');
    if (charts.annualFinancials) {
      charts.annualFinancials.destroy();
    }
    charts.annualFinancials = new Chart(ctxTrend, {
      type: 'bar',
      data: {
        labels: data.monthlySeries.map(m => m.label),
        datasets: [
          {
            label: 'Monthly Sales Revenue (₹)',
            data: data.monthlySeries.map(m => m.revenue),
            backgroundColor: 'rgba(14, 165, 233, 0.65)',
            borderColor: 'rgba(14, 165, 233, 1)',
            borderWidth: 1,
            order: 2
          },
          {
            label: 'GST Collected (₹)',
            data: data.monthlySeries.map(m => m.tax),
            borderColor: '#f59e0b',
            borderWidth: 2.5,
            fill: false,
            type: 'line',
            tension: 0.3,
            order: 1
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

    // Draw Doughnut Chart: Top product shares
    const ctxDoughnut = document.getElementById('chart-annual-doughnut').getContext('2d');
    if (charts.annualDoughnut) {
      charts.annualDoughnut.destroy();
    }
    charts.annualDoughnut = new Chart(ctxDoughnut, {
      type: 'doughnut',
      data: {
        labels: data.topSellers.map(s => s.product_name),
        datasets: [{
          data: data.topSellers.map(s => s.revenue),
          backgroundColor: ['#0ea5e9', '#2563eb', '#10b981', '#f59e0b', '#ef4444'],
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

    // Best Sellers table body
    const sellersBody = document.getElementById('fin-best-sellers-body');
    sellersBody.innerHTML = '';
    data.topSellers.forEach(s => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><strong>${s.product_name}</strong></td>
        <td>${s.quantity_sold} units</td>
        <td><strong>₹${s.revenue.toFixed(2)}</strong></td>
      `;
      sellersBody.appendChild(row);
    });

    // Monthly ledger table body
    const ledgerBody = document.getElementById('fin-monthly-ledger-body');
    ledgerBody.innerHTML = '';
    [...data.monthlySeries].reverse().forEach(m => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><strong>${m.label}</strong></td>
        <td>₹${m.revenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
        <td><span class="badge badge-success">${m.orderCount} sales</span></td>
      `;
      ledgerBody.appendChild(row);
    });

    // Distributor Performance table body
    const distributorBody = document.getElementById('distributor-annual-matrix-body');
    if (distributorBody) {
      distributorBody.innerHTML = '';
      data.distributorMatrix.forEach(d => {
        const locSuffix = d.location ? ` <span style="font-size:11px; color:var(--text-muted);">(${d.location})</span>` : '';
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><strong>${d.name}</strong>${locSuffix}</td>
          <td>${d.orderCount}</td>
          <td>₹${d.totalTax.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
          <td>${d.totalQty} pcs</td>
          <td><strong>₹${d.totalSales.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</strong></td>
        `;
        distributorBody.appendChild(row);
      });
    }

    // Draw Distributor Annual Sales Chart (Horizontal Bar Chart)
    const ctxDist = document.getElementById('chart-distributor-annual').getContext('2d');
    if (charts.distributorAnnual) {
      charts.distributorAnnual.destroy();
    }
    
    const sortedDists = [...data.distributorMatrix].slice(0, 7);
    
    charts.distributorAnnual = new Chart(ctxDist, {
      type: 'bar',
      data: {
        labels: sortedDists.map(d => d.name),
        datasets: [{
          label: 'Annual Purchases (₹)',
          data: sortedDists.map(d => d.totalSales),
          backgroundColor: 'rgba(37, 99, 235, 0.75)',
          borderColor: 'rgba(37, 99, 235, 1)',
          borderWidth: 1
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: { ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569' }, grid: { display: false } }
        }
      }
    });

  } catch (err) {
    console.error('Error rendering full year financials:', err);
  }
}

// 2. MONTHLY OPERATIONS DASHBOARD
async function renderMonthlyDashboard() {
  try {
    const select = document.getElementById('monthly-period-select');
    if (select.children.length === 0) {
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthKey = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
        const monthLabel = d.toLocaleString('default', { month: 'short', year: 'numeric' });
        const opt = document.createElement('option');
        opt.value = monthKey;
        opt.textContent = monthLabel;
        if (i === 0) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        renderMonthlyDashboard();
      });
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
        <span>Capacity: ${capacity} ${mat.unit}</span>
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

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${b.material_name}</strong></td>
      <td><code>${b.SKU}</code></td>
      <td><span class="card-code">${b.batch_number}</span></td>
      <td>${b.received_date ? b.received_date.split(' ')[0] : 'N/A'}</td>
      <td><strong>${b.remaining_quantity} ${b.unit}</strong></td>
      <td>${b.expiry_date.split(' ')[0]}</td>
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
    row.innerHTML = `
      <td><code>${prod.SKU}</code></td>
      <td><strong>${prod.name}</strong></td>
      <td>₹${prod.price.toFixed(2)}</td>
      <td><strong>${prod.stock_qty} pcs</strong></td>
      <td><strong>₹${(prod.stock_qty * prod.price).toFixed(2)}</strong></td>
      <td><span class="badge ${badgeClass}">${badgeText}</span></td>
    `;
    finishedBody.appendChild(row);
  });

  const completedBody = document.getElementById('cold-batches-expiry-body');
  completedBody.innerHTML = '';

  const completed = state.productionBatches.filter(b => b.status === 'COMPLETED');
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

      const row = document.createElement('tr');
      row.innerHTML = `
        <td><span class="card-code">${b.batch_code}</span></td>
        <td><strong>${b.flavor_name}</strong></td>
        <td>${b.quantity_produced} pcs</td>
        <td>${b.start_time.split(' ')[0]}</td>
        <td>${b.expiry_date ? b.expiry_date.split(' ')[0] : 'N/A'}</td>
        <td style="color:${ratingClass}; font-weight:700; font-size:11px;">${ratingText} (${daysLeft > 0 ? daysLeft + ' days' : 'EXPIRED'})</td>
      `;
      completedBody.appendChild(row);
    });
  }

  const ctxTemp = document.getElementById('chart-cold-room-temp').getContext('2d');
  
  if (!charts.coldRoomTemp) {
    const tempLabels = [];
    const tempData = [];
    const timeNow = new Date();
    for (let i = 9; i >= 0; i--) {
      const pastTime = new Date(timeNow.getTime() - i * 60 * 1000);
      tempLabels.push(pastTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      tempData.push(-20.4 + (Math.random() - 0.5) * 0.4);
    }

    charts.coldRoomTemp = new Chart(ctxTemp, {
      type: 'line',
      data: {
        labels: tempLabels,
        datasets: [{
          label: 'Air Probe Temp (°C)',
          data: tempData,
          borderColor: '#0ea5e9',
          backgroundColor: 'rgba(14, 165, 233, 0.05)',
          fill: true,
          borderWidth: 1.5,
          pointRadius: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: { display: false },
          y: {
            min: -22.5,
            max: -17.5,
            ticks: { color: state.isDarkMode ? '#94a3b8' : '#475569', font: { size: 9 } },
            grid: { color: 'rgba(255,255,255,0.03)' }
          }
        }
      }
    });
  }
}

// ==========================================
// ✍️ FORMS EVENT TRIGGERS
// ==========================================
function setupFormHandlers() {


  const customerNameInput = document.getElementById('customer-name-input');
  if (customerNameInput) {
    customerNameInput.addEventListener('input', (e) => {
      const name = e.target.value;
      const match = state.distributors.find(d => d.name === name);
      const locInput = document.getElementById('customer-location-input');
      if (locInput) {
        if (match) {
          locInput.value = match.location || '';
          locInput.disabled = true;
        } else {
          locInput.value = '';
          locInput.disabled = false;
        }
      }
    });
  }

  // Modal Buttons
  document.getElementById('btn-start-batch-trigger').addEventListener('click', () => {
    // Generate new code
    document.getElementById('batch-code-input').value = `PB-26-${Date.now().toString().slice(-3)}`;
    
    // Load select options
    const select = document.getElementById('batch-recipe-select');
    select.innerHTML = '';
    state.recipes.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      select.appendChild(opt);
    });

    triggerRecipePreview();
    openModal('modal-start-batch');
  });

  document.getElementById('batch-recipe-select').addEventListener('change', triggerRecipePreview);

  document.getElementById('btn-checkin-trigger').addEventListener('click', () => {
    openModal('modal-gate-checkin');
  });

  document.getElementById('btn-add-inventory-trigger').addEventListener('click', () => {
    // Set default date today
    document.getElementById('inv-expiry-input').valueAsDate = new Date();
    openModal('modal-add-inventory');
  });

  // Submit start batch
  document.getElementById('start-batch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const recipeId = document.getElementById('batch-recipe-select').value;
    const batchCode = document.getElementById('batch-code-input').value;
    
    try {
      await apiPost('/api/v1/production/start', { recipe_id: recipeId, batch_code: batchCode });
      closeModal('modal-start-batch');
    } catch (err) {
      alert('Error launching batch: ' + err.message);
    }
  });

  // Submit checkin gate log
  document.getElementById('gate-checkin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const plate = document.getElementById('vehicle-no-input').value.toUpperCase();
    const driver = document.getElementById('driver-name-input').value;
    const purpose = document.getElementById('purpose-input').value;

    try {
      await apiPost('/api/v1/logistics/gate-in', { vehicle_number: plate, driver_name: driver, purpose });
      closeModal('modal-gate-checkin');
      document.getElementById('gate-checkin-form').reset();
    } catch (err) {
      alert('Gate check-in failed: ' + err.message);
    }
  });

  // Submit raw inventory batch
  document.getElementById('add-inventory-form').addEventListener('submit', async (e) => {
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
    const expiry = document.getElementById('inv-expiry-input').value;

    try {
      await apiPost('/api/v1/inventory/raw-materials', {
        name,
        SKU: sku,
        unit,
        quantity,
        expiry_date: expiry
      });
      closeModal('modal-add-inventory');
      document.getElementById('add-inventory-form').reset();
    } catch (err) {
      alert('Inventory add failed: ' + err.message);
    }
  });

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
      const expiry = document.getElementById('new-mat-expiry').value;

      try {
        await apiPost('/api/v1/inventory/raw-materials', {
          name,
          SKU: sku,
          unit,
          quantity: initialStock,
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

  const addProductForm = document.getElementById('add-product-form');
  if (addProductForm) {
    addProductForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const name = document.getElementById('new-prod-name').value;
      const sku = document.getElementById('new-prod-sku').value;
      const price = document.getElementById('new-prod-price').value;
      const stockQty = document.getElementById('new-prod-stock').value;
      const unit = document.getElementById('new-prod-unit').value;

      try {
        await apiPost('/api/v1/finished-goods', {
          name,
          SKU: sku,
          price: parseFloat(price),
          stock_qty: parseInt(stockQty),
          unit
        });
        closeModal('modal-add-product');
        addProductForm.reset();
        await loadFinishedGoods();
        renderAll();
      } catch (err) {
        alert('Product registration failed: ' + err.message);
      }
    });
  }

  // ---- CUSTOMER / DISTRIBUTOR REGISTRATION ----
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
      const location = document.getElementById('new-dist-location').value.trim();

      try {
        await apiPost('/api/v1/distributors', {
          name,
          location,
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
        
        const locInput = document.getElementById('customer-location-input');
        if (locInput) {
          locInput.value = location;
          locInput.disabled = true; // Lock location field since it is registered
        }

        // Render to update charts/dropdowns
        renderAll();
        alert('Customer / Distributor registered successfully!');
      } catch (err) {
        alert('Distributor registration failed: ' + err.message);
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
  if (!isAuthBypass && supabaseClient) {
    try {
      const { data: { session }, error } = await supabaseClient.auth.getSession();
      if (session) {
        handleSuccessfulLogin(session.user, session.access_token);
        return;
      }
    } catch (e) {
      console.error("Session check failed, falling back to login:", e);
    }
  } else {
    // Check if user previously logged in via bypass mode
    const bypassUser = localStorage.getItem('bypass_user');
    if (bypassUser) {
      const u = JSON.parse(bypassUser);
      handleBypassLogin(u.email, u.role);
      return;
    }
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
      groupRole.style.display = 'block';
    } else {
      authTitle.textContent = 'Access Secure Workspace';
      authSubtitle.textContent = 'Please authenticate to access the manufacturing floor and ledger';
      authToggleText.textContent = "Don't have an account?";
      authToggleBtn.textContent = 'Request Access';
      btnAuthSubmit.textContent = 'Sign In';
      groupFullname.style.display = 'none';
      groupRole.style.display = 'none';
    }
  });

  // Handle Form Submit (Login / Register)
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.style.display = 'none';

    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    const fullname = document.getElementById('auth-fullname') ? document.getElementById('auth-fullname').value.trim() : '';
    const role = document.getElementById('auth-role') ? document.getElementById('auth-role').value : 'SALES_AGENT';

    if (isAuthBypass) {
      const mockRole = isSignUpMode ? role : 'ADMIN';
      handleBypassLogin(email, mockRole);
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
          const regRes = await fetch('/api/v1/auth/register-role', {
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
    roleSelectBox.style.display = 'block';
    authForm.reset();
    authError.style.display = 'none';
    
    // Reset to Login overlay
    authContainer.classList.add('active');
  });

  async function handleSuccessfulLogin(user, token) {
    state.accessToken = token;
    
    try {
      // Query backend for role details
      const meRes = await fetch('/api/v1/auth/me', {
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
        state.activeRole = 'SALES_AGENT';
        userDisplayName.textContent = user.email;
      }
      
      // Update sidebar footer
      authUserEmail.textContent = user.email;
      authUserInfo.style.display = 'block';
      roleSelectBox.style.display = 'none'; // Hide active role selection dropdown
      
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
    roleSelectBox.style.display = 'block'; // Keep dropdown visible for mock switching

    authContainer.classList.remove('active');
    applyRoleRestrictions();
    loadAllData();
  }
}
