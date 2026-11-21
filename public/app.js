// API Base URL
const API_BASE = '/api';

// State
let currentEditingId = null;
let currentUpgradeSale = null; // Sale being upgraded
let currentRenewSale = null; // Sale being renewed (Expirations tab)
let expiringSales = []; // Sales expiring within 4 days
let currentMonth = '';
let currentYear = '';
let allSales = []; // Store all sales for filtering
let currentSearchQuery = ''; // Store current search query for filtering

// Plan catalogue loaded from the database.
// PLAN_DATA is kept as a lookup for the sales form and existing-sale editing.
const PLAN_DATA = {};
let plans = [];

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    updateRegistrationVisibility();
    checkAuth();
    setupEventListeners();
});


// Keep public sign-up hidden after the first account is created.
async function updateRegistrationVisibility() {
    const registerButton = document.querySelector('.tab-btn[data-tab="register"]');
    const registerPanel = document.getElementById('registerTab');
    try {
        const response = await fetch(`${API_BASE}/registration-status`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        const isOpen = Boolean(data.registrationOpen);
        if (registerButton) registerButton.classList.toggle('hidden', !isOpen);
        if (registerPanel && !isOpen) registerPanel.classList.remove('active');
        if (!isOpen) {
            const loginButton = document.querySelector('.tab-btn[data-tab="login"]');
            const loginPanel = document.getElementById('loginTab');
            if (loginButton) loginButton.classList.add('active');
            if (loginPanel) loginPanel.classList.add('active');
        }
    } catch (error) {
        console.warn('Could not check registration availability:', error.message);
    }
}

// Check authentication status
async function checkAuth() {
    try {
        const response = await fetch(`${API_BASE}/session`, {
            credentials: 'include' // Include cookies in request
        });
        const data = await response.json();
        
        if (data.authenticated) {
            showApp();
        } else {
            showAuthModal();
        }
    } catch (error) {
        console.error('Error checking auth:', error);
        showAuthModal();
    }
}

// Show authentication modal
function showAuthModal() {
    document.getElementById('authModal').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
}

// Show main app
function showApp() {
    try {
        const authModal = document.getElementById('authModal');
        const app = document.getElementById('app');
        
        if (authModal) authModal.classList.add('hidden');
        if (app) app.classList.remove('hidden');
        
        // Initialize with home tab
        switchMainTab('home');
        // Load plans from the database so the catalogue and sales form stay in sync
        loadPlans();
        // Load statistics for home page
        loadStatistics();
        // Convert the panel's USD cost to PHP at the current rate
        updatePanelCurrency();
    } catch (error) {
        console.error('Error showing app:', error);
    }
}

// Fetch the live USD->PHP rate and update the Panel line (and VDS total) to match
async function updatePanelCurrency() {
    const panelEl = document.getElementById('panelAmount');
    if (!panelEl) return; // this page doesn't have the VDS expenses widget

    const usdCost = parseFloat(panelEl.dataset.usd || '5.35');

    try {
        const response = await fetch(`${API_BASE}/exchange-rate`, {
            credentials: 'include'
        });
        const data = await response.json();
        if (!data || !data.rate) {
            throw new Error('No rate returned from exchange-rate endpoint');
        }

        const panelPHP = usdCost * data.rate;
        panelEl.textContent = `₱${formatCurrency(panelPHP)} ($${usdCost.toFixed(2)})`;
        panelEl.title = data.stale
            ? 'Using last known exchange rate — live rate temporarily unavailable'
            : `1 USD ≈ ₱${data.rate.toFixed(2)}`;

        recalculateVpsTotal();
    } catch (error) {
        console.error('Error updating panel currency:', error);
        // Leave the static fallback amount already in the HTML untouched
    }
}

// Sum all .vps-item amounts (Panel + VDS 1, etc.) into the total row
function recalculateVpsTotal() {
    const totalEl = document.getElementById('vpsTotal');
    if (!totalEl) return;

    const amountEls = document.querySelectorAll('.vps-item .vps-amount');
    let total = 0;
    amountEls.forEach(el => {
        const numeric = parseFloat(el.textContent.replace(/[₱,]/g, ''));
        if (!isNaN(numeric)) total += numeric;
    });

    totalEl.textContent = `₱${formatCurrency(total)}`;
}

// Switch main tabs (Home/Sales Management)
function switchMainTab(tabName) {
    try {
        // Update tab buttons
        const tabButtons = document.querySelectorAll('.main-tab-btn');
        if (tabButtons.length === 0) {
            console.warn('Main tab buttons not found');
            return;
        }
        
        tabButtons.forEach(btn => {
            if (btn.dataset.mainTab === tabName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // Update tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });

        if (tabName === 'home') {
            const homeTab = document.getElementById('homeTab');
            if (homeTab) {
                homeTab.classList.add('active');
            }
            // Hide header month filter when on home tab (we have one on the page)
            const monthFilterContainer = document.getElementById('monthFilterContainer');
            if (monthFilterContainer) {
                monthFilterContainer.style.display = 'none';
            }
            // Reset home month filter to "All Time" when switching to home tab
            const homeMonthFilter = document.getElementById('homeMonthFilter');
            if (homeMonthFilter) {
                homeMonthFilter.value = '';
            }
            // Reset month filter to show all time statistics
            currentMonth = '';
            currentYear = '';
            // Load months for home page filter
            loadHomeMonths();
            // Load statistics for home page (all time initially)
            loadStatistics();
        } else if (tabName === 'sales') {
            const salesTab = document.getElementById('salesTab');
            if (salesTab) {
                salesTab.classList.add('active');
            }
            // Show month filter when on sales tab
            const monthFilterContainer = document.getElementById('monthFilterContainer');
            if (monthFilterContainer) {
                monthFilterContainer.style.display = 'block';
            }
            // Reset month filter when switching to sales tab (show all sales initially)
            currentMonth = '';
            currentYear = '';
            const monthFilter = document.getElementById('monthFilter');
            if (monthFilter) {
                monthFilter.value = '';
            }
            // Reset search when switching to sales tab
            const customerSearch = document.getElementById('customerSearch');
            if (customerSearch) {
                customerSearch.value = '';
            }
            currentSearchQuery = '';
            const statusFilterEl = document.getElementById('statusFilter');
            if (statusFilterEl) {
                statusFilterEl.value = '';
            }
            const planFilterEl = document.getElementById('planFilter');
            if (planFilterEl) {
                planFilterEl.value = '';
            }
            // Reset load flag to allow fresh load when switching tabs
            hasLoadedSales = false;
            // Load sales data when switching to sales tab
            loadMonths();
            loadSales();
        } else if (tabName === 'plans') {
            const plansTab = document.getElementById('plansTab');
            if (plansTab) {
                plansTab.classList.add('active');
            }
            const monthFilterContainer = document.getElementById('monthFilterContainer');
            if (monthFilterContainer) {
                monthFilterContainer.style.display = 'none';
            }
            loadPlans();
        } else if (tabName === 'expirations') {
            const expirationsTab = document.getElementById('expirationsTab');
            if (expirationsTab) {
                expirationsTab.classList.add('active');
            }
            const monthFilterContainer = document.getElementById('monthFilterContainer');
            if (monthFilterContainer) {
                monthFilterContainer.style.display = 'none';
            }
            loadExpiringSales();
        } else if (tabName === 'statistics') {            const statisticsTab = document.getElementById('statisticsTab');
            if (statisticsTab) {
                statisticsTab.classList.add('active');
            }
            const monthFilterContainer = document.getElementById('monthFilterContainer');
            if (monthFilterContainer) {
                monthFilterContainer.style.display = 'none';
            }
            // Reset statistics month filter to "All Time" when switching to statistics tab
            const statisticsMonthFilter = document.getElementById('statisticsMonthFilter');
            if (statisticsMonthFilter) {
                statisticsMonthFilter.value = '';
            }
            // Reset month filter to show all time statistics
            currentMonth = '';
            currentYear = '';
            // Load months for statistics page filter
            loadStatisticsMonths();
            // Load statistics for statistics page (all time initially)
            loadDetailedStatistics();
        } else if (tabName === 'discord') {
            const discordTab = document.getElementById('discordTab');
            if (discordTab) {
                discordTab.classList.add('active');
            }
            const monthFilterContainer = document.getElementById('monthFilterContainer');
            if (monthFilterContainer) {
                monthFilterContainer.style.display = 'none';
            }
            loadDiscordSettings();
        } else if (tabName === 'customers') {
            const customersTab = document.getElementById('customersTab');
            if (customersTab) {
                customersTab.classList.add('active');
            }
            const monthFilterContainer = document.getElementById('monthFilterContainer');
            if (monthFilterContainer) {
                monthFilterContainer.style.display = 'none';
            }
            loadCustomersList();
        } else if (tabName === 'backups') {
            const backupsTab = document.getElementById('backupsTab');
            if (backupsTab) {
                backupsTab.classList.add('active');
            }
            const monthFilterContainer = document.getElementById('monthFilterContainer');
            if (monthFilterContainer) {
                monthFilterContainer.style.display = 'none';
            }
            loadBackups();
        }
    } catch (error) {
        console.error('Error switching main tab:', error);
    }
}


// Setup event listeners
function setupEventListeners() {
    // Auth tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tab = e.target.dataset.tab;
            switchTab(tab);
        });
    });


    // Login form
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    } else {
        console.error('Login form not found!');
    }

    // Register form
    const registerForm = document.getElementById('registerForm');
    if (registerForm) {
        registerForm.addEventListener('submit', handleRegister);
    } else {
        console.error('Register form not found!');
    }

    // Logout
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);

    // Main tabs (Home/Sales Management)
    document.querySelectorAll('.main-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tab = e.target.dataset.mainTab;
            switchMainTab(tab);
        });
    });

    // Month filter
    const monthFilter = document.getElementById('monthFilter');
    if (monthFilter) {
        monthFilter.addEventListener('change', handleMonthFilter);
    }

    // Home page month filter
    const homeMonthFilter = document.getElementById('homeMonthFilter');
    if (homeMonthFilter) {
        homeMonthFilter.addEventListener('change', handleHomeMonthFilter);
    }

    // Statistics page month filter
    const statisticsMonthFilter = document.getElementById('statisticsMonthFilter');
    if (statisticsMonthFilter) {
        statisticsMonthFilter.addEventListener('change', handleStatisticsMonthFilter);
    }

    // Discord settings buttons
    const discordSaveBtn = document.getElementById('discordSaveBtn');
    if (discordSaveBtn) {
        discordSaveBtn.addEventListener('click', saveDiscordSettings);
    }
    const discordTestBtn = document.getElementById('discordTestBtn');
    if (discordTestBtn) {
        discordTestBtn.addEventListener('click', sendDiscordTest);
    }

    // Sales tab extra filters
    const statusFilter = document.getElementById('statusFilter');
    if (statusFilter) {
        statusFilter.addEventListener('change', filterAndDisplaySales);
    }
    const planFilter = document.getElementById('planFilter');
    if (planFilter) {
        planFilter.addEventListener('change', filterAndDisplaySales);
    }

    // Expirations tab filters
    const expirationsSearch = document.getElementById('expirationsSearch');
    if (expirationsSearch) {
        expirationsSearch.addEventListener('input', filterExpiringSales);
    }
    const expirationsStatusFilter = document.getElementById('expirationsStatusFilter');
    if (expirationsStatusFilter) {
        expirationsStatusFilter.addEventListener('change', filterExpiringSales);
    }

    // Customers tab
    const customerListSearch = document.getElementById('customerListSearch');
    if (customerListSearch) {
        customerListSearch.addEventListener('input', displayFilteredCustomers);
    }

    // Customer modal
    const customerForm = document.getElementById('customerForm');
    if (customerForm) {
        customerForm.addEventListener('submit', handleCustomerForm);
    }
    const customerCancelBtn = document.getElementById('customerCancelBtn');
    if (customerCancelBtn) {
        customerCancelBtn.addEventListener('click', closeCustomerModal);
    }
    const customerCloseBtn = document.getElementById('customerCloseBtn');
    if (customerCloseBtn) {
        customerCloseBtn.addEventListener('click', closeCustomerModal);
    }
    const customerDeleteBtn = document.getElementById('customerDeleteBtn');
    if (customerDeleteBtn) {
        customerDeleteBtn.addEventListener('click', deleteCurrentCustomer);
    }

    // Backups tab
    const createBackupBtn = document.getElementById('createBackupBtn');
    if (createBackupBtn) {
        createBackupBtn.addEventListener('click', createBackupNow);
    }
    const refreshBackupsBtn = document.getElementById('refreshBackupsBtn');
    if (refreshBackupsBtn) {
        refreshBackupsBtn.addEventListener('click', loadBackups);
    }

    // Add sale button
    const addSaleBtn = document.getElementById('addSaleBtn');
    if (addSaleBtn) {
        addSaleBtn.addEventListener('click', () => openSaleModal());
    }

    // Export button
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', handleExport);
    }

    // Import file input
    const importFile = document.getElementById('importFile');
    if (importFile) {
        importFile.addEventListener('change', handleImport);
    }

    // Customer search (not present on every page that loads app.js)
    const customerSearch = document.getElementById('customerSearch');
    if (customerSearch) {
        customerSearch.addEventListener('input', handleCustomerSearch);
    }

    // Sale form
    const saleForm = document.getElementById('saleForm');
    if (saleForm) {
        saleForm.addEventListener('submit', handleSaleSubmit);
        // Calculate expiry date when date bought or duration changes
        saleForm.addEventListener('change', (e) => {
            if (e.target.id === 'dateBought' || e.target.id === 'duration') {
                calculateExpiryDate();
            }
        });
        saleForm.addEventListener('input', (e) => {
            if (e.target.id === 'dateBought' || e.target.id === 'duration') {
                calculateExpiryDate();
            }
        });
    }

    // Plan selection handler
    const planSelect = document.getElementById('planSelect');
    if (planSelect) {
        planSelect.addEventListener('change', handlePlanSelection);
    }

    // Promo code handler
    const promoInput = document.getElementById('promo');
    if (promoInput) {
        promoInput.addEventListener('input', handlePromoChange);
        promoInput.addEventListener('blur', handlePromoChange);
    }

    // Amount input handler for custom plans (to update originalAmount)
    const amountInput = document.getElementById('amount');
    if (amountInput) {
        amountInput.addEventListener('change', () => {
            // If amount is not readonly (custom plan), update originalAmount
            if (!amountInput.hasAttribute('readonly')) {
                const currentAmount = parseFloat(amountInput.value) || 0;
                if (currentAmount > 0) {
                    originalAmount = currentAmount;
                    // Recalculate promo if exists
                    if (promoInput && promoInput.value) {
                        handlePromoChange();
                    }
                }
            }
        });
    }

    // Auto-format CPU, RAM, and DISK fields for custom plan
    const cpuInput = document.getElementById('cpu');
    const ramInput = document.getElementById('ram');
    const diskInput = document.getElementById('disk');

    if (cpuInput) {
        cpuInput.addEventListener('input', formatCPU);
        cpuInput.addEventListener('blur', formatCPU);
    }
    if (ramInput) {
        ramInput.addEventListener('input', formatRAM);
        ramInput.addEventListener('blur', formatRAM);
    }
    if (diskInput) {
        diskInput.addEventListener('input', formatDISK);
        diskInput.addEventListener('blur', formatDISK);
    }
    
    // Event delegation should handle most cases, but we'll also ensure
    // the calculation runs when the modal opens

    // Plan management
    const addPlanBtn = document.getElementById('addPlanBtn');
    if (addPlanBtn) {
        addPlanBtn.addEventListener('click', () => openPlanModal());
    }

    const planForm = document.getElementById('planForm');
    if (planForm) {
        planForm.addEventListener('submit', handlePlanSubmit);
    }

    const cancelPlanBtn = document.getElementById('cancelPlanBtn');
    if (cancelPlanBtn) {
        cancelPlanBtn.addEventListener('click', closePlanModal);
    }

    document.querySelectorAll('.plan-close').forEach(btn => {
        btn.addEventListener('click', closePlanModal);
    });

    const planModal = document.getElementById('planModal');
    if (planModal) {
        planModal.addEventListener('click', (e) => {
            if (e.target.id === 'planModal') {
                closePlanModal();
            }
        });
    }

    // Modal close
    const closeBtn = document.querySelector('.close');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeSaleModal);
    }
    
    const cancelBtn = document.getElementById('cancelBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeSaleModal);
    }

    // Close modal on outside click
    const saleModal = document.getElementById('saleModal');
    if (saleModal) {
        saleModal.addEventListener('click', (e) => {
            if (e.target.id === 'saleModal') {
                closeSaleModal();
            }
        });
    }

    // Upgrade modal
    const upgradeForm = document.getElementById('upgradeForm');
    if (upgradeForm) {
        upgradeForm.addEventListener('submit', handleUpgradeSubmit);
    }
    const upgradeCancelBtn = document.getElementById('upgradeCancelBtn');
    if (upgradeCancelBtn) {
        upgradeCancelBtn.addEventListener('click', closeUpgradeModal);
    }
    document.querySelectorAll('.upgrade-close').forEach(btn => {
        btn.addEventListener('click', closeUpgradeModal);
    });
    const upgradeModal = document.getElementById('upgradeModal');
    if (upgradeModal) {
        upgradeModal.addEventListener('click', (e) => {
            if (e.target.id === 'upgradeModal') {
                closeUpgradeModal();
            }
        });
    }

    // Renew modal (Expirations tab)
    const renewForm = document.getElementById('renewForm');
    if (renewForm) {
        renewForm.addEventListener('submit', handleRenewSubmit);
    }
    const renewCancelBtn = document.getElementById('renewCancelBtn');
    if (renewCancelBtn) {
        renewCancelBtn.addEventListener('click', closeRenewModal);
    }
    document.querySelectorAll('.renew-close').forEach(btn => {
        btn.addEventListener('click', closeRenewModal);
    });
    const renewModal = document.getElementById('renewModal');
    if (renewModal) {
        renewModal.addEventListener('click', (e) => {
            if (e.target.id === 'renewModal') {
                closeRenewModal();
            }
        });
    }
}

// Handle actions for dynamically rendered tables. This avoids inline onclick handlers
// and keeps buttons working after filtering, importing, refreshing, or switching tabs.
document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const action = button.dataset.action;
    const id = button.dataset.id;
    const file = button.dataset.file;

    switch (action) {
        case 'edit-plan':
            openPlanModal(Number(id));
            break;
        case 'delete-plan':
            deletePlan(Number(id));
            break;
        case 'edit-sale':
            editSale(Number(id));
            break;
        case 'upgrade-sale':
            openUpgradeModal(Number(id));
            break;
        case 'renew-sale':
            renewSale(Number(id));
            break;
        case 'delete-sale':
            deleteSale(Number(id));
            break;
        case 'renew-expiring':
            openRenewModalFromId(Number(id));
            break;
        case 'no-renew':
            markNoRenew(Number(id));
            break;
        case 'view-customer':
            if (id) openCustomerModal(Number(id));
            break;
        case 'download-backup':
            if (file) downloadBackup(file);
            break;
        case 'delete-backup':
            if (file) deleteBackup(file);
            break;
    }
});

// Switch auth tabs
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelectorAll('.auth-tab').forEach(t => {
        t.classList.remove('active');
    });

    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    document.getElementById(`${tab}Tab`).classList.add('active');

    // Clear errors
    document.getElementById('loginError').textContent = '';
    document.getElementById('registerError').textContent = '';
}

// Handle login
async function handleLogin(e) {
    e.preventDefault();
    
    const errorDiv = document.getElementById('loginError');
    const submitButton = e.target.querySelector('button[type="submit"]');
    
    if (!errorDiv) {
        console.error('Error div not found!');
        alert('Error: Could not find error display element');
        return;
    }
    
    errorDiv.textContent = '';
    errorDiv.style.color = '#ef4444'; // Reset to error color

    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;

    if (!username || !password) {
        errorDiv.textContent = 'Please enter both username and password';
        return;
    }

    // Show loading state
    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Logging in...';
    }
    errorDiv.textContent = 'Logging in...';
    errorDiv.style.color = '#3b82f6';

    
    // Add timeout to fetch request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
    
    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: controller.signal,
            body: JSON.stringify({ username, password })
        });

        clearTimeout(timeoutId);
        
        // Handle timeout errors
        if (response.status === 504 || response.status === 503) {
            errorDiv.textContent = 'Server timeout. This may be due to database initialization. Please try again in a few seconds.';
            errorDiv.style.color = '#ef4444';
            console.error('Server timeout - likely database initialization issue');
            return;
        }
        
        let data;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            try {
                data = await response.json();
            } catch (jsonError) {
                const text = await response.text();
                console.error('Failed to parse JSON response:', text.substring(0, 200));
                if (response.status === 504 || response.status === 503) {
                    errorDiv.textContent = 'Server timeout. The database may be initializing. Please wait a moment and try again.';
                } else {
                    errorDiv.textContent = `Server error: ${response.status} ${response.statusText}`;
                }
                return;
            }
        } else {
            const text = await response.text();
            console.error('Non-JSON response:', text.substring(0, 200));
            if (response.status === 504 || response.status === 503) {
                errorDiv.textContent = 'Server timeout. Please try again in a few seconds.';
            } else {
                errorDiv.textContent = `Server error: ${response.status} ${response.statusText}`;
            }
            return;
        }


        if (response.ok && data.success) {
            // Wait a moment for session to be saved, then verify
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Verify session was created
            const sessionCheck = await fetch(`${API_BASE}/session`, {
                credentials: 'include'
            });
            const sessionData = await sessionCheck.json();
            
            
            if (sessionData.authenticated) {
                showApp();
                document.getElementById('loginForm').reset();
            } else {
                // Try one more time after a longer delay
                await new Promise(resolve => setTimeout(resolve, 500));
                const retryCheck = await fetch(`${API_BASE}/session`, {
                    credentials: 'include'
                });
                const retryData = await retryCheck.json();
                
                if (retryData.authenticated) {
                    showApp();
                    document.getElementById('loginForm').reset();
                } else {
                    errorDiv.textContent = 'Login failed: Session not created. Please try again.';
                    errorDiv.style.color = '#ef4444';
                    console.error('Session check failed after retry:', retryData);
                }
            }
        } else {
            errorDiv.textContent = data.error || 'Login failed';
            errorDiv.style.color = '#ef4444';
            console.error('Login error:', data);
        }
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            errorDiv.textContent = 'Request timed out. The server may be initializing the database. Please wait a moment and try again.';
            errorDiv.style.color = '#ef4444';
            console.error('Login request timed out after 15 seconds');
        } else {
            errorDiv.textContent = 'Network error. Please check console for details.';
            errorDiv.style.color = '#ef4444';
            console.error('Login network error:', error);
            console.error('Error details:', {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
        }
    } finally {
        // Restore button state
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = 'Login';
        }
    }
}

// Handle register
async function handleRegister(e) {
    e.preventDefault();
    
    const errorDiv = document.getElementById('registerError');
    const submitButton = e.target.querySelector('button[type="submit"]');
    
    if (!errorDiv) {
        console.error('Error div not found!');
        alert('Error: Could not find error display element');
        return;
    }
    
    errorDiv.textContent = '';
    errorDiv.style.color = '#ef4444'; // Reset to error color

    const username = document.getElementById('registerUsername').value;
    const password = document.getElementById('registerPassword').value;
    const repeatPassword = document.getElementById('repeatPassword').value;

    if (!username || !password || !repeatPassword) {
        errorDiv.textContent = 'Please fill in all fields';
        return;
    }

    if (password !== repeatPassword) {
        errorDiv.textContent = 'Passwords do not match';
        return;
    }

    if (password.length < 8) {
        errorDiv.textContent = 'Password must be at least 8 characters';
        return;
    }

    // Show loading state
    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Registering...';
    }
    errorDiv.textContent = 'Registering...';
    errorDiv.style.color = '#3b82f6';

    
    // Add timeout to fetch request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
    
    try {
        const response = await fetch(`${API_BASE}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: controller.signal,
            body: JSON.stringify({ username, password, repeatPassword })
        });

        clearTimeout(timeoutId);
        
        // Handle timeout errors
        if (response.status === 504 || response.status === 503) {
            errorDiv.textContent = 'Server timeout. This may be due to database initialization. Please try again in a few seconds.';
            errorDiv.style.color = '#ef4444';
            console.error('Server timeout - likely database initialization issue');
            return;
        }
        
        let data;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            try {
                data = await response.json();
            } catch (jsonError) {
                const text = await response.text();
                console.error('Failed to parse JSON response:', text);
                if (response.status === 504 || response.status === 503) {
                    errorDiv.textContent = 'Server timeout. The database may be initializing. Please wait a moment and try again.';
                } else {
                    errorDiv.textContent = `Server error: ${response.status} ${response.statusText}`;
                }
                return;
            }
        } else {
            const text = await response.text();
            console.error('Non-JSON response:', text.substring(0, 200));
            if (response.status === 504 || response.status === 503) {
                errorDiv.textContent = 'Server timeout. Please try again in a few seconds.';
            } else {
                errorDiv.textContent = `Server error: ${response.status} ${response.statusText}`;
            }
            return;
        }


        if (response.ok && data.success) {
            errorDiv.textContent = 'Registration successful! Please login.';
            errorDiv.style.color = '#10b981';
            await updateRegistrationVisibility();
            setTimeout(() => {
                switchTab('login');
                document.getElementById('registerForm').reset();
            }, 1000);
        } else {
            errorDiv.textContent = data.error || 'Registration failed';
            errorDiv.style.color = '#ef4444';
            console.error('Registration error:', data);
        }
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            errorDiv.textContent = 'Request timed out. The server may be initializing the database. Please wait a moment and try again.';
            errorDiv.style.color = '#ef4444';
            console.error('Registration request timed out after 15 seconds');
        } else {
            errorDiv.textContent = 'Network error. Please check console for details.';
            errorDiv.style.color = '#ef4444';
            console.error('Registration network error:', error);
            console.error('Error details:', {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
        }
    } finally {
        // Restore button state
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = 'Register';
        }
    }
}

// Handle logout
async function handleLogout() {
    try {
        await fetch(`${API_BASE}/logout`, { 
            method: 'POST',
            credentials: 'include' // Include cookies in request
        });
        showAuthModal();
        const salesTableBody = document.getElementById('salesTableBody');
        if (salesTableBody) {
            salesTableBody.innerHTML = '<tr><td colspan="11" class="empty-state">No sales records found</td></tr>';
        }
    } catch (error) {
        console.error('Logout error:', error);
    }
}

// Load available months
async function loadPlans() {
    try {
        const response = await fetch(`${API_BASE}/plans`, {
            credentials: 'include'
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Failed to load plans');
        }

        plans = Array.isArray(data) ? data : [];

        // Rebuild the lookup used by the sales form and existing-sale editor.
        Object.keys(PLAN_DATA).forEach(key => delete PLAN_DATA[key]);
        plans.forEach(plan => {
            PLAN_DATA[plan.name] = {
                id: plan.id,
                amount: Number(plan.amount),
                ram: plan.ram,
                cpu: plan.cpu,
                disk: plan.disk,
                category: plan.category
            };
        });

        renderPlans();
        populatePlanSelect();
    } catch (error) {
        console.error('Error loading plans:', error);
        const tableBody = document.getElementById('plansTableBody');
        if (tableBody) {
            tableBody.innerHTML = `<tr><td colspan="7" class="empty-state">Unable to load plans</td></tr>`;
        }
        const planSelect = document.getElementById('planSelect');
        if (planSelect) {
            planSelect.innerHTML = '<option value="">Unable to load plans</option><option value="Custom Plan">Custom Plan</option>';
        }
    }
}

function populatePlanSelect(selectedName = null) {
    const select = document.getElementById('planSelect');
    if (!select) return;

    const previousValue = selectedName !== null ? selectedName : select.value;
    const options = ['<option value="">Select a Plan</option>'];

    plans.forEach(plan => {
        options.push(`<option value="${escapeHtml(plan.name)}">${escapeHtml(plan.name)}${plan.category ? ` · ${escapeHtml(plan.category)}` : ''}</option>`);
    });

    options.push('<option value="Custom Plan">Custom Plan</option>');
    select.innerHTML = options.join('');

    if (previousValue) {
        const exists = Array.from(select.options).some(option => option.value === previousValue);
        select.value = exists ? previousValue : '';
    }
}

function renderPlans() {
    const tableBody = document.getElementById('plansTableBody');
    if (!tableBody) return;

    if (!plans.length) {
        tableBody.innerHTML = '<tr><td colspan="7" class="empty-state">No plans found. Click + Add Plan to create one.</td></tr>';
        return;
    }

    tableBody.innerHTML = plans.map(plan => `
        <tr>
            <td><strong>${escapeHtml(plan.name)}</strong></td>
            <td>${escapeHtml(plan.category || 'General')}</td>
            <td>${escapeHtml(plan.cpu)}</td>
            <td>${escapeHtml(plan.ram)}</td>
            <td>${escapeHtml(plan.disk)}</td>
            <td>₱${formatCurrency(Number(plan.amount) || 0)}</td>
            <td>
                <div class="table-actions">
                    <button class="btn btn-edit" type="button" data-action="edit-plan" data-id="${plan.id}">Edit</button>
                    <button class="btn btn-danger" type="button" data-action="delete-plan" data-id="${plan.id}">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function openPlanModal(planId = null) {
    const modal = document.getElementById('planModal');
    const form = document.getElementById('planForm');
    const title = document.getElementById('planModalTitle');
    const error = document.getElementById('planFormError');
    if (!modal || !form) return;

    form.reset();
    error.textContent = '';
    form.dataset.planId = planId ? String(planId) : '';

    if (planId) {
        const plan = plans.find(item => Number(item.id) === Number(planId));
        if (!plan) return;
        title.textContent = 'Edit Plan';
        document.getElementById('planName').value = plan.name;
        document.getElementById('planCategory').value = plan.category || 'General';
        document.getElementById('planCpu').value = plan.cpu;
        document.getElementById('planRam').value = plan.ram;
        document.getElementById('planDisk').value = plan.disk;
        document.getElementById('planAmount').value = plan.amount;
        document.getElementById('savePlanBtn').textContent = 'Update Plan';
    } else {
        title.textContent = 'Add Plan';
        document.getElementById('planCategory').value = 'General';
        document.getElementById('savePlanBtn').textContent = 'Save Plan';
    }

    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('planName')?.focus(), 0);
}

function closePlanModal() {
    const modal = document.getElementById('planModal');
    const form = document.getElementById('planForm');
    if (modal) modal.classList.add('hidden');
    if (form) {
        form.reset();
        form.dataset.planId = '';
    }
    const error = document.getElementById('planFormError');
    if (error) error.textContent = '';
    const saveBtn = document.getElementById('savePlanBtn');
    if (saveBtn) saveBtn.textContent = 'Save Plan';
}

async function handlePlanSubmit(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const planId = form.dataset.planId;
    const error = document.getElementById('planFormError');
    const saveBtn = document.getElementById('savePlanBtn');
    const payload = {
        name: document.getElementById('planName').value.trim(),
        category: document.getElementById('planCategory').value.trim(),
        cpu: document.getElementById('planCpu').value.trim(),
        ram: document.getElementById('planRam').value.trim(),
        disk: document.getElementById('planDisk').value.trim(),
        amount: Number(document.getElementById('planAmount').value)
    };

    error.textContent = '';
    saveBtn.disabled = true;
    saveBtn.textContent = planId ? 'Updating...' : 'Saving...';

    try {
        const response = await fetch(`${API_BASE}/plans${planId ? `/${encodeURIComponent(planId)}` : ''}`, {
            method: planId ? 'PUT' : 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Unable to save plan');
        }

        closePlanModal();
        await loadPlans();
    } catch (err) {
        console.error('Error saving plan:', err);
        error.textContent = err.message;
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = planId ? 'Update Plan' : 'Save Plan';
    }
}

async function deletePlan(planId) {
    const plan = plans.find(item => Number(item.id) === Number(planId));
    if (!plan) return;

    const confirmed = window.confirm(
        `Delete "${plan.name}"? Existing sales using this plan will keep their saved details, but the plan will no longer appear for new sales.`
    );
    if (!confirmed) return;

    try {
        const response = await fetch(`${API_BASE}/plans/${encodeURIComponent(planId)}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Unable to delete plan');
        }
        await loadPlans();
    } catch (error) {
        console.error('Error deleting plan:', error);
        window.alert(error.message);
    }
}

async function loadMonths() {
    try {
        const response = await fetch(`${API_BASE}/sales/months`, {
            credentials: 'include'
        });
        const months = await response.json();

        const select = document.getElementById('monthFilter');
        select.innerHTML = '<option value="">All Months</option>';

        months.forEach(month => {
            const date = new Date(`${month.year_month}-01`);
            const option = document.createElement('option');
            option.value = `${month.month}-${month.year}`;
            option.textContent = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading months:', error);
    }
}

// Load available months for home page filter
async function loadHomeMonths() {
    try {
        const response = await fetch(`${API_BASE}/sales/months`, {
            credentials: 'include'
        });
        const months = await response.json();

        const select = document.getElementById('homeMonthFilter');
        if (!select) return;
        
        select.innerHTML = '<option value="">All Time</option>';

        months.forEach(month => {
            const date = new Date(`${month.year_month}-01`);
            const option = document.createElement('option');
            option.value = `${month.month}-${month.year}`;
            option.textContent = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading home months:', error);
    }
}

// Handle month filter
function handleMonthFilter(e) {
    const value = e.target.value;
    if (value) {
        const [month, year] = value.split('-');
        currentMonth = month;
        currentYear = year;
    } else {
        currentMonth = '';
        currentYear = '';
    }
    // Apply filters (month + search) and display
    filterAndDisplaySales();
}

// Handle home page month filter
function handleHomeMonthFilter(e) {
    const value = e.target.value;
    if (value) {
        const [month, year] = value.split('-');
        currentMonth = month;
        currentYear = year;
    } else {
        currentMonth = '';
        currentYear = '';
    }
    // Reload statistics with the selected month
    loadStatistics();
}

// Handle customer search
function handleCustomerSearch(e) {
    currentSearchQuery = e.target.value.trim().toLowerCase();
    filterAndDisplaySales();
}

// Filter and display sales based on month filter and search query
let isLoadingSales = false; // Prevent infinite loops
let hasLoadedSales = false; // Track if we've attempted to load sales

function filterAndDisplaySales() {
    const tbody = document.getElementById('salesTableBody');
    if (!tbody) return;
    
    // If we haven't loaded yet and not currently loading, trigger load
    if (!hasLoadedSales && !isLoadingSales) {
        isLoadingSales = true;
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Loading...</td></tr>';
        loadSales().finally(() => {
            isLoadingSales = false;
        });
        return;
    }
    
    // If we've loaded but have no sales, show empty state
    if (hasLoadedSales && (!allSales || allSales.length === 0)) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No sales records found</td></tr>';
        return;
    }
    
    // If allSales exists and has data, filter and display
    if (allSales && allSales.length > 0) {
        let filteredSales = [...allSales];

        // Apply month filter if set
        if (currentMonth && currentYear) {
            filteredSales = filteredSales.filter(sale => {
                const saleDate = new Date(sale.date_bought);
                const saleMonth = String(saleDate.getMonth() + 1).padStart(2, '0');
                const saleYear = String(saleDate.getFullYear());
                return saleMonth === currentMonth.padStart(2, '0') && saleYear === currentYear;
            });
        }

        // Apply status filter if set
        const statusFilterEl = document.getElementById('statusFilter');
        if (statusFilterEl && statusFilterEl.value) {
            filteredSales = filteredSales.filter(sale => sale.status && sale.status.toLowerCase() === statusFilterEl.value);
        }

        // Apply plan filter if set
        const planFilterEl = document.getElementById('planFilter');
        if (planFilterEl && planFilterEl.value) {
            filteredSales = filteredSales.filter(sale => sale.plan === planFilterEl.value);
        }

        // Apply search filter if set
        if (currentSearchQuery) {
            filteredSales = filteredSales.filter(sale => {
                const haystack = [
                    sale.customer_name,
                    sale.plan,
                    sale.payment_method,
                    sale.promo || ''
                ].join(' ').toLowerCase();
                return haystack.includes(currentSearchQuery);
            });
        }

        // Display filtered sales
        displaySales(filteredSales);
    } else if (hasLoadedSales) {
        // If we've loaded but have no sales after filtering, show empty state
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No sales records found</td></tr>';
    }
}

// Display sales in the table
function displaySales(sales) {
    const tbody = document.getElementById('salesTableBody');
    
    if (sales.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No sales records found</td></tr>';
        return;
    }

    tbody.innerHTML = sales.map(sale => `
        <tr>
            <td>${formatDate(sale.date_bought)}</td>
            <td>${sale.date_expiry ? formatDate(sale.date_expiry) : '-'}</td>
            <td>${escapeHtml(sale.customer_name)}</td>
            <td>${escapeHtml(sale.plan)}</td>
            <td>₱${formatCurrency(sale.amount)}</td>
            <td>${sale.promo ? escapeHtml(sale.promo) : '-'}</td>
            <td>${escapeHtml(sale.payment_method)}</td>
            <td><span class="status-badge ${sale.status.toLowerCase()}">${sale.status}</span></td>
            <td>${escapeHtml(sale.created_by_username)}</td>
            <td>
                <div class="action-buttons">
                    <button type="button" class="btn btn-edit" data-action="edit-sale" data-id="${sale.id}">Edit</button>
                    <button type="button" class="btn btn-upgrade" data-action="upgrade-sale" data-id="${sale.id}" title="Upgrade server resources">Upgrade</button>
                    <button type="button" class="btn btn-renew" data-action="renew-sale" data-id="${sale.id}" title="Renew subscription">Renew</button>
                    <button type="button" class="btn btn-danger" data-action="delete-sale" data-id="${sale.id}">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

// Load sales
async function loadSales() {
    try {
        const params = new URLSearchParams();
        const response = await fetch(`${API_BASE}/sales?${params}`, {
            credentials: 'include'
        });
        const data = await response.json();

        if (!response.ok) {
            // API error (401, 500, etc.) - don't treat error body as sales array
            allSales = [];
            hasLoadedSales = true;
            filterAndDisplaySales();
            if (response.status === 401) {
                console.warn('Not authenticated when loading sales');
            } else {
                console.error('Error loading sales:', response.status, data);
            }
            return;
        }

        // Ensure we have an array (API can return [] or null)
        allSales = Array.isArray(data) ? data : [];
        hasLoadedSales = true;

        // Populate the plan filter dropdown with the plans present in sales
        const planFilterEl = document.getElementById('planFilter');
        if (planFilterEl) {
            const selected = planFilterEl.value;
            const plans = [...new Set(allSales.map(s => s.plan).filter(Boolean))].sort();
            planFilterEl.innerHTML = '<option value="">All Plans</option>' +
                plans.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
            planFilterEl.value = selected;
        }

        filterAndDisplaySales();
    } catch (error) {
        console.error('Error loading sales:', error);
        allSales = [];
        hasLoadedSales = true;
        const tbody = document.getElementById('salesTableBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Error loading sales</td></tr>';
        }
    }
}

// Days left until date_expiry (0 = today, negative = past)
function getDaysLeft(dateExpiryStr) {
    if (!dateExpiryStr) return null;
    const expiry = new Date(dateExpiryStr);
    expiry.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
    return diff;
}

// Load and display sales expiring within the next 4 days or expired up to 5 days ago (-5 to +4 days)
async function loadExpiringSales() {
    const tbody = document.getElementById('expirationsTableBody');
    if (!tbody) return;
    try {
        const response = await fetch(`${API_BASE}/sales`, { credentials: 'include' });
        const data = await response.json();
        if (!response.ok) {
            expiringSales = [];
            tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Unable to load expirations</td></tr>';
            return;
        }
        const sales = Array.isArray(data) ? data : [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        expiringSales = sales.filter(sale => {
            if (!sale.date_expiry) return false;
            if (sale.no_renew) return false; // Exclude marked "No Renew"
            const daysLeft = getDaysLeft(sale.date_expiry);
            // Show clients from 5 days after due date up to 4 days before due date
            return daysLeft !== null && daysLeft >= -5 && daysLeft <= 4;
        });
        displayExpiringSales(expiringSales);
    } catch (error) {
        console.error('Error loading expiring sales:', error);
        expiringSales = [];
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Error loading expirations</td></tr>';
    }
}

function displayExpiringSales(sales) {
    const tbody = document.getElementById('expirationsTableBody');
    if (!tbody) return;
    if (!sales || sales.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No sales expiring soon</td></tr>';
        return;
    }
    tbody.innerHTML = sales.map(sale => {
        const daysLeft = getDaysLeft(sale.date_expiry);
        let daysText;
        if (daysLeft === 0) {
            daysText = 'Today';
        } else if (daysLeft === 1) {
            daysText = '1 day';
        } else if (daysLeft > 1) {
            daysText = `${daysLeft} days`;
        } else if (daysLeft === -1) {
            daysText = '1 day overdue';
        } else {
            daysText = `${Math.abs(daysLeft)} days overdue`;
        }
        return `
        <tr>
            <td>${formatDate(sale.date_bought)}</td>
            <td>${sale.date_expiry ? formatDate(sale.date_expiry) : '-'}</td>
            <td>${daysText}</td>
            <td>${escapeHtml(sale.customer_name)}</td>
            <td>${escapeHtml(sale.plan)}</td>
            <td>₱${formatCurrency(sale.amount)}</td>
            <td><span class="status-badge ${(sale.status || '').toLowerCase()}">${sale.status || '-'}</span></td>
            <td>
                <div class="action-buttons">
                    <button type="button" class="btn btn-renew" data-action="renew-expiring" data-id="${sale.id}" title="Renew subscription">Renew</button>
                    <button type="button" class="btn btn-secondary" data-action="no-renew" data-id="${sale.id}" title="Customer will not renew">No Renew</button>
                </div>
            </td>
        </tr>
    `;
    }).join('');
}

function openRenewModalFromId(id) {
    const sale = expiringSales.find(s => s.id === id);
    if (sale) openRenewModal(sale);
}

function openRenewModal(sale) {
    currentRenewSale = sale;
    const infoEl = document.getElementById('renewCurrentInfo');
    if (infoEl) {
        infoEl.textContent = `${escapeHtml(sale.customer_name)} — ${escapeHtml(sale.plan)} (expires ${sale.date_expiry ? formatDate(sale.date_expiry) : '-'})`;
    }
    const durationEl = document.getElementById('renewDuration');
    if (durationEl) {
        durationEl.value = sale.duration || '';
    }
    const amountEl = document.getElementById('renewAmount');
    if (amountEl) {
        amountEl.value = sale.amount != null ? sale.amount : '';
    }
    document.getElementById('renewModal').classList.remove('hidden');
}

function closeRenewModal() {
    currentRenewSale = null;
    document.getElementById('renewModal').classList.add('hidden');
    document.getElementById('renewForm').reset();
}

async function handleRenewSubmit(e) {
    e.preventDefault();
    if (!currentRenewSale) return;
    const durationEl = document.getElementById('renewDuration');
    const amountEl = document.getElementById('renewAmount');
    const duration = durationEl ? durationEl.value.trim() : '';
    const amount = amountEl && amountEl.value.trim() !== '' ? amountEl.value : undefined;
    if (!duration) {
        alert('Please select a duration.');
        return;
    }
    try {
        const body = { duration };
        if (amount !== undefined) body.amount = amount;
        const response = await fetch(`${API_BASE}/sales/${currentRenewSale.id}/renew`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        if (response.ok) {
            closeRenewModal();
            loadExpiringSales();
            loadStatistics();
            if (typeof loadSales === 'function') loadSales();
            alert('Subscription renewed successfully!');
        } else {
            alert(data.error || 'Error renewing subscription');
        }
    } catch (err) {
        alert('Network error. Please try again.');
    }
}

async function markNoRenew(id) {
    if (!confirm('Mark this sale as "No Renew"? It will be removed from the Expirations list (customer will not renew).')) {
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/sales/${id}/no-renew`, {
            method: 'POST',
            credentials: 'include'
        });
        const data = await response.json();
        if (response.ok) {
            loadExpiringSales();
            loadStatistics();
            if (typeof loadSales === 'function') loadSales();
            alert('Marked as No Renew. It will no longer appear in Expirations.');
        } else {
            alert(data.error || 'Failed to update.');
        }
    } catch (err) {
        alert('Network error. Please try again.');
    }
}

// Load statistics
async function loadStatistics() {
    try {
        const params = new URLSearchParams();
        if (currentMonth && currentYear) {
            params.append('month', currentMonth);
            params.append('year', currentYear);
        }

        const response = await fetch(`${API_BASE}/statistics?${params}`, {
            credentials: 'include'
        });
        const stats = await response.json();

        // Update month display
        const monthDisplay = document.getElementById('totalSalesMonth');
        if (currentMonth && currentYear) {
            const date = new Date(`${currentYear}-${currentMonth.padStart(2, '0')}-01`);
            monthDisplay.textContent = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
            monthDisplay.style.display = 'block';
        } else {
            monthDisplay.textContent = 'All Time';
            monthDisplay.style.display = 'block';
        }

        document.getElementById('totalSales').textContent = stats.totalSales;
        document.getElementById('totalAmount').textContent = `₱${formatCurrency(stats.totalAmount)}`;
        document.getElementById('paidSales').textContent = stats.paidSales;
        document.getElementById('paidAmount').textContent = `₱${formatCurrency(stats.paidAmount)}`;
        document.getElementById('pendingAmount').textContent = `₱${formatCurrency(stats.pendingAmount)}`;
        document.getElementById('ownerSalary').textContent = `₱${formatCurrency(stats.salaries.owner)}`;
        document.getElementById('developerSalary').textContent = `₱${formatCurrency(stats.salaries.developer)}`;
        document.getElementById('staffSalary').textContent = `₱${formatCurrency(stats.salaries.staff)}`;
    } catch (error) {
        console.error('Error loading statistics:', error);
    }
}

// Format CPU field - auto-add % if not present
function formatCPU(e) {
    const input = e.target;
    const planSelect = document.getElementById('planSelect');
    
    // Only format if Custom Plan is selected
    if (planSelect.value === 'Custom Plan' && !input.hasAttribute('readonly')) {
        let value = input.value.trim();
        // Remove existing % if present
        value = value.replace(/%/g, '');
        // Add % if there's a value
        if (value && !value.endsWith('%')) {
            input.value = value + '%';
        } else if (value) {
            input.value = value;
        }
    }
}

// Format RAM field - auto-add GB if not present
function formatRAM(e) {
    const input = e.target;
    const planSelect = document.getElementById('planSelect');
    
    // Only format if Custom Plan is selected
    if (planSelect.value === 'Custom Plan' && !input.hasAttribute('readonly')) {
        let value = input.value.trim();
        // Remove existing GB if present
        value = value.replace(/GB/gi, '');
        // Add GB if there's a value
        if (value && !value.endsWith('GB') && !value.endsWith('gb')) {
            input.value = value + 'GB';
        } else if (value) {
            input.value = value;
        }
    }
}

// Format DISK field - auto-add GB if not present
function formatDISK(e) {
    const input = e.target;
    const planSelect = document.getElementById('planSelect');
    
    // Only format if Custom Plan is selected
    if (planSelect.value === 'Custom Plan' && !input.hasAttribute('readonly')) {
        let value = input.value.trim();
        // Remove existing GB if present
        value = value.replace(/GB/gi, '');
        // Add GB if there's a value
        if (value && !value.endsWith('GB') && !value.endsWith('gb')) {
            input.value = value + 'GB';
        } else if (value) {
            input.value = value;
        }
    }
}

// Store original amount for promo calculation
let originalAmount = 0;

// Handle plan selection
function handlePlanSelection() {
    const planSelect = document.getElementById('planSelect');
    const selectedPlan = planSelect.value;
    const cpuInput = document.getElementById('cpu');
    const ramInput = document.getElementById('ram');
    const diskInput = document.getElementById('disk');
    const amountInput = document.getElementById('amount');
    const promoInput = document.getElementById('promo');

    if (selectedPlan === 'Custom Plan') {
        // Enable manual input for custom plan specs
        cpuInput.removeAttribute('readonly');
        cpuInput.placeholder = '150%';
        ramInput.removeAttribute('readonly');
        ramInput.placeholder = '6GB';
        diskInput.removeAttribute('readonly');
        diskInput.placeholder = '10GB';
        amountInput.removeAttribute('readonly');
        // Clear fields
        cpuInput.value = '';
        ramInput.value = '';
        diskInput.value = '';
        amountInput.value = '';
        originalAmount = 0;
        // Recalculate promo if exists
        if (promoInput && promoInput.value) {
            handlePromoChange();
        }
    } else if (selectedPlan && PLAN_DATA[selectedPlan] && PLAN_DATA[selectedPlan].amount !== 0) {
        // Auto-fill fields for predefined plans
        const planData = PLAN_DATA[selectedPlan];
        cpuInput.value = planData.cpu;
        cpuInput.setAttribute('readonly', 'readonly');
        cpuInput.placeholder = '';
        ramInput.value = planData.ram;
        ramInput.setAttribute('readonly', 'readonly');
        ramInput.placeholder = '';
        diskInput.value = planData.disk;
        diskInput.setAttribute('readonly', 'readonly');
        diskInput.placeholder = '';
        originalAmount = planData.amount;
        amountInput.value = originalAmount;
        amountInput.setAttribute('readonly', 'readonly');
        // Recalculate promo if exists
        if (promoInput && promoInput.value) {
            handlePromoChange();
        }
    } else {
        // No plan selected - clear all fields
        cpuInput.value = '';
        cpuInput.removeAttribute('readonly');
        cpuInput.placeholder = '';
        ramInput.value = '';
        ramInput.removeAttribute('readonly');
        ramInput.placeholder = '';
        diskInput.value = '';
        diskInput.removeAttribute('readonly');
        diskInput.placeholder = '';
        amountInput.value = '';
        amountInput.removeAttribute('readonly');
        originalAmount = 0;
        // Clear promo calculation
        if (promoInput && promoInput.value) {
            handlePromoChange();
        }
    }
}

// Handle promo code change
function handlePromoChange() {
    const promoInput = document.getElementById('promo');
    const amountInput = document.getElementById('amount');
    
    if (!promoInput || !amountInput) return;
    
    const promoValue = promoInput.value.trim();
    
    // If no promo, restore original amount
    if (!promoValue) {
        if (originalAmount > 0) {
            amountInput.value = originalAmount;
        }
        return;
    }
    
    // Get current base amount (either from originalAmount or from amountInput if it's not readonly)
    let baseAmount = originalAmount;
    if (baseAmount === 0 && !amountInput.hasAttribute('readonly')) {
        baseAmount = parseFloat(amountInput.value) || 0;
    }
    
    if (baseAmount === 0) {
        return; // Can't apply discount if no base amount
    }
    
    let discount = 0;
    
    // Check if promo is a percentage (ends with %)
    if (promoValue.endsWith('%')) {
        const percentage = parseFloat(promoValue.replace('%', ''));
        if (!isNaN(percentage) && percentage >= 0 && percentage <= 100) {
            discount = (baseAmount * percentage) / 100;
        }
    } else {
        // Treat as fixed discount amount
        const fixedDiscount = parseFloat(promoValue);
        if (!isNaN(fixedDiscount) && fixedDiscount >= 0) {
            discount = Math.min(fixedDiscount, baseAmount); // Don't allow negative amounts
        }
    }
    
    // Calculate final amount
    const finalAmount = Math.max(0, baseAmount - discount);
    
    // Update amount field (temporarily remove readonly if needed)
    const wasReadonly = amountInput.hasAttribute('readonly');
    if (wasReadonly) {
        amountInput.removeAttribute('readonly');
    }
    amountInput.value = finalAmount.toFixed(2);
    if (wasReadonly) {
        amountInput.setAttribute('readonly', 'readonly');
    }
}

// Calculate expiry date based on date bought and duration
function calculateExpiryDate() {
    const dateBoughtInput = document.getElementById('dateBought');
    const durationInput = document.getElementById('duration');
    const dateExpiryInput = document.getElementById('dateExpiry');

    if (!dateBoughtInput || !durationInput || !dateExpiryInput) {
        return;
    }

    const dateBought = dateBoughtInput.value.trim();
    const duration = durationInput.value.trim();

    if (!dateBought || !duration) {
        if (dateExpiryInput) {
            dateExpiryInput.value = '';
        }
        return;
    }

    try {
        // Parse the date bought - ensure it's in YYYY-MM-DD format
        const dateParts = dateBought.split('-');
        if (dateParts.length !== 3) {
            dateExpiryInput.value = '';
            return;
        }

        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1; // Month is 0-indexed
        const day = parseInt(dateParts[2]);
        
        const startDate = new Date(year, month, day);
        if (isNaN(startDate.getTime())) {
            dateExpiryInput.value = '';
            return;
        }

        const expiryDate = new Date(startDate);

        // Calculate expiry based on duration
        switch (duration) {
            case '1 month':
                expiryDate.setMonth(expiryDate.getMonth() + 1);
                break;
            case '6 Months':
                expiryDate.setMonth(expiryDate.getMonth() + 6);
                break;
            case '1 Year':
                expiryDate.setFullYear(expiryDate.getFullYear() + 1);
                break;
            default:
                dateExpiryInput.value = '';
                return;
        }

        // Format as YYYY-MM-DD for date input
        const expiryYear = expiryDate.getFullYear();
        const expiryMonth = String(expiryDate.getMonth() + 1).padStart(2, '0');
        const expiryDay = String(expiryDate.getDate()).padStart(2, '0');
        const formattedDate = `${expiryYear}-${expiryMonth}-${expiryDay}`;
        
        // Remove readonly temporarily to set value
        dateExpiryInput.removeAttribute('readonly');
        
        // Set the value using multiple methods to ensure it works
        dateExpiryInput.value = formattedDate;
        dateExpiryInput.setAttribute('value', formattedDate);
        
        // Force a change event to ensure the value is recognized
        const event = new Event('input', { bubbles: true });
        dateExpiryInput.dispatchEvent(event);
        
        // Restore readonly
        dateExpiryInput.setAttribute('readonly', 'readonly');
        
        // Verify it was set correctly
        if (dateExpiryInput.value !== formattedDate) {
            // Try one more time without readonly
            dateExpiryInput.removeAttribute('readonly');
            dateExpiryInput.value = formattedDate;
            dateExpiryInput.setAttribute('value', formattedDate);
            dateExpiryInput.setAttribute('readonly', 'readonly');
        }
        
        console.log('Expiry date calculated:', {
            dateBought,
            duration,
            calculatedExpiry: formattedDate,
            actualValue: dateExpiryInput.value
        });
    } catch (error) {
        console.error('Error calculating expiry date:', error);
        if (dateExpiryInput) {
            dateExpiryInput.value = '';
        }
    }
}

// Open sale modal
function openSaleModal(sale = null) {
    currentEditingId = sale ? sale.id : null;
    const modal = document.getElementById('saleModal');
    const form = document.getElementById('saleForm');
    const title = document.getElementById('modalTitle');

    if (sale) {
        title.textContent = 'Edit Sale';
        document.getElementById('dateBought').value = sale.date_bought;
        document.getElementById('duration').value = sale.duration || '';
        document.getElementById('dateExpiry').value = sale.date_expiry || '';
        document.getElementById('customerName').value = sale.customer_name;
        document.getElementById('paymentMethod').value = sale.payment_method;
        document.getElementById('status').value = sale.status;
        
        // Set promo if exists
        const promoInput = document.getElementById('promo');
        if (promoInput && sale.promo) {
            promoInput.value = sale.promo;
        }
        
        // Handle plan selection
        const planSelect = document.getElementById('planSelect');
        const planName = sale.plan;
        
        // Check if it's a predefined plan
        if (PLAN_DATA[planName]) {
            planSelect.value = planName;
            // Apply readonly state and auto-fill for predefined plans
            handlePlanSelection();
            // For editing, we need to set originalAmount to the plan's base amount
            // and then apply promo if it exists
            if (sale.promo) {
                setTimeout(() => {
                    handlePromoChange();
                }, 100);
            }
        } else {
            // It's a custom plan or unknown plan - set to Custom Plan
            planSelect.value = 'Custom Plan';
            // Enable manual input for custom plan
            handlePlanSelection();
            // Set the actual values from the sale
            document.getElementById('cpu').value = sale.cpu;
            document.getElementById('ram').value = sale.ram;
            document.getElementById('disk').value = sale.disk;
            // For custom plans, we need to figure out the original amount
            // If there's a promo, we'll need to reverse calculate, but for now just set the amount
            originalAmount = parseFloat(sale.amount) || 0;
            document.getElementById('amount').value = sale.amount;
            if (sale.promo) {
                setTimeout(() => {
                    handlePromoChange();
                }, 100);
            }
        }
        
        // Always recalculate expiry date when editing to ensure it's up to date
        // If expiry is missing but we have date_bought and duration, calculate it
        if ((!sale.date_expiry || sale.date_expiry === '') && sale.date_bought && sale.duration) {
            setTimeout(() => {
                calculateExpiryDate();
            }, 100);
        } else if (sale.date_bought && sale.duration) {
            // Even if expiry exists, recalculate to ensure it's correct
            setTimeout(() => {
                calculateExpiryDate();
            }, 100);
        }
    } else {
        title.textContent = 'Add New Sale';
        form.reset();
        // Set default date to today
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('dateBought').value = today;
        document.getElementById('dateExpiry').value = '';
        // Reset plan selection
        document.getElementById('planSelect').value = '';
        handlePlanSelection();
    }

    modal.classList.remove('hidden');
    
    // Trigger calculation multiple times to ensure it works
    // The event delegation should handle field changes, but we also
    // trigger it when modal opens in case fields already have values
    setTimeout(() => {
        calculateExpiryDate();
    }, 50);
    
    setTimeout(() => {
        calculateExpiryDate();
    }, 200);
    
    setTimeout(() => {
        calculateExpiryDate();
    }, 500);
}

// Close sale modal
function closeSaleModal() {
    document.getElementById('saleModal').classList.add('hidden');
    document.getElementById('saleForm').reset();
    document.getElementById('planSelect').value = '';
    handlePlanSelection(); // Reset readonly states
    currentEditingId = null;
}

// Parse current RAM string to number (e.g. "6GB" -> 6)
function parseRamValue(str) {
    if (!str || typeof str !== 'string') return 0;
    const num = parseFloat(String(str).replace(/GB/gi, '').trim());
    return isNaN(num) ? 0 : num;
}

// Parse current CPU string to number (e.g. "3 vCores" -> 3, "150%" -> 150)
function parseCpuValue(str) {
    if (!str || typeof str !== 'string') return 0;
    const s = str.trim();
    const vCoreMatch = s.match(/(\d+(?:\.\d+)?)\s*vcores?/i);
    if (vCoreMatch) return parseFloat(vCoreMatch[1]);
    const pctMatch = s.match(/(\d+(?:\.\d+)?)\s*%?/);
    if (pctMatch) return parseFloat(pctMatch[1]);
    const num = parseFloat(s);
    return isNaN(num) ? 0 : num;
}

// Parse current disk/storage string to number (e.g. "20GB" -> 20)
function parseDiskValue(str) {
    if (!str || typeof str !== 'string') return 0;
    const num = parseFloat(String(str).replace(/GB/gi, '').trim());
    return isNaN(num) ? 0 : num;
}

// Format number back to RAM string (e.g. 7 -> "7GB")
function formatRamDisplay(num) {
    const n = parseFloat(num);
    return isNaN(n) ? '0GB' : (n % 1 === 0 ? n + 'GB' : n.toFixed(1) + 'GB');
}

// Format number back to CPU string - prefer vCores if it looks like whole number, else %
function formatCpuDisplay(num, originalStr) {
    const n = parseFloat(num);
    if (isNaN(n)) return originalStr || '0';
    if (originalStr && /%/.test(originalStr)) return n + '%';
    return n === 1 ? '1 vCore' : n + ' vCores';
}

// Format number back to disk string (e.g. 25 -> "25GB")
function formatDiskDisplay(num) {
    const n = parseFloat(num);
    return isNaN(n) ? '0GB' : (n % 1 === 0 ? n + 'GB' : n.toFixed(1) + 'GB');
}

// Open upgrade modal
function openUpgradeModal(id) {
    const sale = allSales.find(s => s.id === id);
    if (!sale) {
        console.error('Sale not found for upgrade:', id);
        return;
    }
    const modal = document.getElementById('upgradeModal');
    if (!modal) {
        console.error('Upgrade modal not found. Ensure you are on the sales page.');
        return;
    }
    currentUpgradeSale = sale;
    const infoEl = document.getElementById('upgradeCurrentInfo');
    if (infoEl) {
        infoEl.textContent = `Current: ${sale.ram} RAM, ${sale.cpu} CPU, ${sale.disk} Storage — ₱${formatCurrency(sale.amount)}. Enter amounts to add (leave blank to keep same).`;
    }
    const ramEl = document.getElementById('upgradeRam');
    const cpuEl = document.getElementById('upgradeCpu');
    const storageEl = document.getElementById('upgradeStorage');
    const amountEl = document.getElementById('upgradeAmount');
    if (ramEl) ramEl.value = '';
    if (cpuEl) cpuEl.value = '';
    if (storageEl) storageEl.value = '';
    if (amountEl) amountEl.value = '';
    modal.classList.remove('hidden');
}

// Close upgrade modal
function closeUpgradeModal() {
    document.getElementById('upgradeModal').classList.add('hidden');
    document.getElementById('upgradeForm').reset();
    currentUpgradeSale = null;
}

// Handle upgrade form submit — add values to current and PUT
async function handleUpgradeSubmit(e) {
    e.preventDefault();
    if (!currentUpgradeSale) return;

    const addRam = document.getElementById('upgradeRam').value.trim();
    const addCpu = document.getElementById('upgradeCpu').value.trim();
    const addStorage = document.getElementById('upgradeStorage').value.trim();
    const addAmount = document.getElementById('upgradeAmount').value.trim();

    const currentRam = parseRamValue(currentUpgradeSale.ram);
    const currentCpu = parseCpuValue(currentUpgradeSale.cpu);
    const currentDisk = parseDiskValue(currentUpgradeSale.disk);
    const currentAmount = parseFloat(currentUpgradeSale.amount) || 0;

    let newRam = currentRam;
    let newCpu = currentCpu;
    let newDisk = currentDisk;
    let newAmount = currentAmount;

    if (addRam) {
        const add = parseFloat(addRam.replace(/GB/gi, '').trim()) || 0;
        newRam = currentRam + add;
    }
    if (addCpu) {
        const add = parseFloat(addCpu.replace(/vcores?/gi, '').replace(/%/g, '').trim()) || 0;
        newCpu = currentCpu + add;
    }
    if (addStorage) {
        const add = parseFloat(addStorage.replace(/GB/gi, '').trim()) || 0;
        newDisk = currentDisk + add;
    }
    if (addAmount) {
        const add = parseFloat(addAmount) || 0;
        newAmount = currentAmount + add;
    }

    const saleData = {
        date_bought: currentUpgradeSale.date_bought,
        duration: currentUpgradeSale.duration || null,
        date_expiry: currentUpgradeSale.date_expiry || null,
        customer_name: currentUpgradeSale.customer_name,
        plan: currentUpgradeSale.plan,
        cpu: formatCpuDisplay(newCpu, currentUpgradeSale.cpu),
        ram: formatRamDisplay(newRam),
        disk: formatDiskDisplay(newDisk),
        amount: newAmount,
        promo: currentUpgradeSale.promo || null,
        payment_method: currentUpgradeSale.payment_method,
        status: currentUpgradeSale.status
    };

    try {
        const response = await fetch(`${API_BASE}/sales/${currentUpgradeSale.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(saleData)
        });

        const data = await response.json();

        if (response.ok) {
            closeUpgradeModal();
            setTimeout(() => {
                loadSales();
                loadStatistics();
            }, 100);
        } else {
            alert(data.error || 'Error saving upgrade');
        }
    } catch (err) {
        alert('Network error. Please try again.');
    }
}

// Handle sale form submit
async function handleSaleSubmit(e) {
    e.preventDefault();

    // Get form values
    const dateBought = document.getElementById('dateBought').value;
    const duration = document.getElementById('duration').value;
    const dateExpiryInput = document.getElementById('dateExpiry');
    
    // Force calculate expiry date synchronously before submit
    if (dateBought && duration) {
        // Calculate immediately
        calculateExpiryDate();
        
        // If expiry is still empty, calculate it manually here
        if (!dateExpiryInput.value) {
            try {
                const dateParts = dateBought.split('-');
                if (dateParts.length === 3) {
                    const startDate = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
                    const expiryDate = new Date(startDate);
                    
                    switch (duration) {
                        case '1 month':
                            expiryDate.setMonth(expiryDate.getMonth() + 1);
                            break;
                        case '6 Months':
                            expiryDate.setMonth(expiryDate.getMonth() + 6);
                            break;
                        case '1 Year':
                            expiryDate.setFullYear(expiryDate.getFullYear() + 1);
                            break;
                    }
                    
                    const year = expiryDate.getFullYear();
                    const month = String(expiryDate.getMonth() + 1).padStart(2, '0');
                    const day = String(expiryDate.getDate()).padStart(2, '0');
                    const formattedDate = `${year}-${month}-${day}`;
                    
                    // Force set the value
                    dateExpiryInput.removeAttribute('readonly');
                    dateExpiryInput.value = formattedDate;
                    dateExpiryInput.setAttribute('value', formattedDate);
                    dateExpiryInput.setAttribute('readonly', 'readonly');
                }
            } catch (error) {
                console.error('Error calculating expiry in submit:', error);
            }
        }
    }

    // Get plan name directly from dropdown
    const planName = document.getElementById('planSelect').value;

    const promoInput = document.getElementById('promo');
    const promoValue = promoInput ? promoInput.value.trim() : '';

    const saleData = {
        date_bought: dateBought,
        duration: duration,
        date_expiry: dateExpiryInput.value || null,
        customer_name: document.getElementById('customerName').value,
        plan: planName,
        cpu: document.getElementById('cpu').value,
        ram: document.getElementById('ram').value,
        disk: document.getElementById('disk').value,
        amount: parseFloat(document.getElementById('amount').value),
        payment_method: document.getElementById('paymentMethod').value,
        status: document.getElementById('status').value,
        promo: promoValue || null
    };
    
    // Debug: log the data being sent (can remove this later)
    if (!saleData.date_expiry) {
        console.warn('Warning: date_expiry is empty before submit!', {
            dateBought: saleData.date_bought,
            duration: saleData.duration,
            dateExpiryValue: dateExpiryInput.value
        });
    } else {
        console.log('Sale data ready to submit:', saleData);
    }

    try {
        const url = currentEditingId 
            ? `${API_BASE}/sales/${currentEditingId}`
            : `${API_BASE}/sales`;
        
        const method = currentEditingId ? 'PUT' : 'POST';

        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(saleData)
        });

        const data = await response.json();

        if (response.ok) {
            closeSaleModal();
            // Small delay to ensure database write is complete
            setTimeout(() => {
                loadSales();
                loadStatistics();
                // Switch to sales page to see the new/updated sale
                switchMainTab('sales');
            }, 100);
        } else {
            console.error('Error saving sale:', data);
            alert(data.error || 'Error saving sale');
        }
    } catch (error) {
        alert('Network error. Please try again.');
    }
}

// Edit sale
async function editSale(id) {
    try {
        const response = await fetch(`${API_BASE}/sales`, {
            credentials: 'include'
        });
        const sales = await response.json();
        const sale = sales.find(s => s.id === id);
        
        if (sale) {
            openSaleModal(sale);
        }
    } catch (error) {
        console.error('Error loading sale:', error);
    }
}

// Renew sale
async function renewSale(id) {
    if (!confirm('Are you sure you want to renew this subscription? The expiry date will be extended based on the duration.')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/sales/${id}/renew`, {
            method: 'POST',
            credentials: 'include'
        });

        const data = await response.json();

        if (response.ok) {
            loadSales();
            loadStatistics();
            alert('Subscription renewed successfully!');
            // Switch to sales page to see the updated expiry
            switchMainTab('sales');
        } else {
            alert(data.error || 'Error renewing subscription');
        }
    } catch (error) {
        alert('Network error. Please try again.');
    }
}

// Delete sale
async function deleteSale(id) {
    if (!confirm('Are you sure you want to delete this sale?')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/sales/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        const data = await response.json();

        if (response.ok) {
            // Remove from local array immediately for instant UI update
            allSales = allSales.filter(sale => sale.id !== id);
            
            // Update display immediately without calling loadSales (which would spam)
            // Just filter and display what we have
            let filteredSales = [...allSales];

            // Apply month filter if set
            if (currentMonth && currentYear) {
                filteredSales = filteredSales.filter(sale => {
                    const saleDate = new Date(sale.date_bought);
                    const saleMonth = String(saleDate.getMonth() + 1).padStart(2, '0');
                    const saleYear = String(saleDate.getFullYear());
                    return saleMonth === currentMonth.padStart(2, '0') && saleYear === currentYear;
                });
            }

            // Apply search filter if set
            if (currentSearchQuery) {
                filteredSales = filteredSales.filter(sale => {
                    const haystack = [
                        sale.customer_name,
                        sale.plan,
                        sale.payment_method,
                        sale.promo || ''
                    ].join(' ').toLowerCase();
                    return haystack.includes(currentSearchQuery);
                });
            }

            // Display filtered sales immediately
            displaySales(filteredSales);
            
            // Reload statistics and refresh from server in background (but only once)
            loadStatistics();
            
            // Reload from server after a short delay to ensure consistency
            setTimeout(async () => {
                await loadSales();
            }, 500);
        } else {
            alert(data.error || 'Error deleting sale');
        }
    } catch (error) {
        console.error('Delete error:', error);
        alert('Network error. Please try again.');
    }
}

// Export sales to Excel
async function handleExport() {
    try {
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) {
            exportBtn.disabled = true;
            exportBtn.textContent = 'Exporting...';
        }

        const response = await fetch(`${API_BASE}/sales/export`, {
            credentials: 'include'
        });

        if (!response.ok) {
            // Check if response is JSON or HTML/text
            const contentType = response.headers.get('content-type');
            let errorMessage = 'Export failed';
            
            if (contentType && contentType.includes('application/json')) {
                try {
                    const error = await response.json();
                    errorMessage = error.error || errorMessage;
                } catch (e) {
                    errorMessage = `Server error: ${response.status} ${response.statusText}`;
                }
            } else {
                // If it's HTML or text, read as text
                const text = await response.text();
                if (text.includes('Unauthorized') || response.status === 401) {
                    errorMessage = 'Unauthorized. Please login again.';
                } else {
                    errorMessage = `Server error: ${response.status} ${response.statusText}`;
                }
            }
            throw new Error(errorMessage);
        }

        // Check if response is actually an Excel file
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('spreadsheet') && !contentType.includes('excel')) {
            const text = await response.text();
            console.error('Unexpected response:', text.substring(0, 200));
            throw new Error('Server returned an unexpected response. Please check console for details.');
        }

        // Get the blob
        const blob = await response.blob();
        
        // Create download link
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sales_export_${new Date().toISOString().split('T')[0]}.xlsx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);

        // Show success message
        alert('Sales data exported successfully!');
    } catch (error) {
        console.error('Export error:', error);
        alert('Error exporting sales: ' + error.message);
    } finally {
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.textContent = '📥 Export';
        }
    }
}

// Import sales from Excel
async function handleImport(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    // Validate file type
    const validTypes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv'
    ];
    const validExtensions = ['.xlsx', '.xls', '.csv'];
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();

    if (!validTypes.includes(file.type) && !validExtensions.includes(fileExtension)) {
        alert('Invalid file type. Please upload an Excel file (.xlsx, .xls) or CSV file.');
        event.target.value = '';
        return;
    }

    if (!confirm(`Are you sure you want to import ${file.name}? This will add new sales records to the database.`)) {
        event.target.value = '';
        return;
    }

    try {
        const formData = new FormData();
        formData.append('file', file);

        // Show loading
        const importLabel = document.querySelector('label[for="importFile"]');
        if (importLabel) {
            importLabel.style.opacity = '0.6';
            importLabel.style.pointerEvents = 'none';
        }

        const response = await fetch(`${API_BASE}/sales/import`, {
            method: 'POST',
            credentials: 'include',
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Import failed');
        }

        // Show results
        let message = `Import completed!\n\n`;
        message += `✅ Successful: ${data.successCount}\n`;
        message += `❌ Errors: ${data.errorCount}\n\n`;
        
        if (data.errors && data.errors.length > 0) {
            message += `First few errors:\n${data.errors.slice(0, 5).join('\n')}`;
            if (data.errors.length > 5) {
                message += `\n... and ${data.errors.length - 5} more errors`;
            }
        }

        alert(message);

        // Force refresh sales list and show Sales tab so imported rows are visible
        if (data.successCount > 0) {
            hasLoadedSales = false;
            loadSales();
            loadStatistics();
            switchMainTab('sales');
        }
    } catch (error) {
        console.error('Import error:', error);
        alert('Error importing sales: ' + error.message);
    } finally {
        // Reset file input
        event.target.value = '';
        
        // Reset loading state
        const importLabel = document.querySelector('label[for="importFile"]');
        if (importLabel) {
            importLabel.style.opacity = '1';
            importLabel.style.pointerEvents = 'auto';
        }
    }
}

// Utility functions
function formatCurrency(amount) {
    return parseFloat(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Load available months for statistics page filter
async function loadStatisticsMonths() {
    try {
        const response = await fetch(`${API_BASE}/sales/months`, {
            credentials: 'include'
        });
        const months = await response.json();
        const select = document.getElementById('statisticsMonthFilter');
        if (!select) return;
        select.innerHTML = '<option value="">All Time</option>';
        months.forEach(month => {
            const date = new Date(`${month.year_month}-01`);
            const option = document.createElement('option');
            option.value = `${month.month}-${month.year}`;
            option.textContent = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading statistics months:', error);
    }
}

// Handle statistics page month filter change
function handleStatisticsMonthFilter(e) {
    const value = e.target.value;
    if (value) {
        const [month, year] = value.split('-');
        currentMonth = month;
        currentYear = year;
    } else {
        currentMonth = '';
        currentYear = '';
    }
    // Reload detailed statistics with the selected month
    loadDetailedStatistics();
}

// Load detailed statistics for statistics page
async function loadDetailedStatistics() {
    try {
        const params = new URLSearchParams();
        if (currentMonth && currentYear) {
            params.append('month', currentMonth);
            params.append('year', currentYear);
        }
        const response = await fetch(`${API_BASE}/statistics?${params}`, {
            credentials: 'include'
        });
        const stats = await response.json();

        // Update revenue overview
        document.getElementById('statsTotalSales').textContent = stats.totalSales;
        document.getElementById('statsTotalAmount').textContent = `₱${formatCurrency(stats.totalAmount)}`;
        document.getElementById('statsPaidSales').textContent = stats.paidSales;
        document.getElementById('statsPaidAmount').textContent = `₱${formatCurrency(stats.paidAmount)}`;
        document.getElementById('statsPendingSales').textContent = stats.totalSales - stats.paidSales;
        document.getElementById('statsPendingAmount').textContent = `₱${formatCurrency(stats.pendingAmount)}`;

        // Calculate expenses
        const vdsExpenses = 7471; // Fixed VPS expenses from home page: Panel ₱471 + VDS 1 ₱5,000 + Ryzen 9 ₱2,000
        const totalSalaries = stats.salaries.owner + stats.salaries.developer + stats.salaries.staff;
        const totalExpenses = vdsExpenses + totalSalaries;
        document.getElementById('statsVdsExpenses').textContent = `₱${formatCurrency(vdsExpenses)}`;
        document.getElementById('statsTotalSalaries').textContent = `₱${formatCurrency(totalSalaries)}`;
        document.getElementById('statsTotalExpenses').textContent = `₱${formatCurrency(totalExpenses)}`;

        // Calculate profit analysis
        const netProfit = stats.paidAmount - totalExpenses;
        const profitMargin = stats.paidAmount > 0 ? (netProfit / stats.paidAmount) * 100 : 0;
        document.getElementById('statsNetProfit').textContent = `₱${formatCurrency(netProfit)}`;
        document.getElementById('statsProfitMargin').textContent = `${profitMargin.toFixed(1)}%`;
        
        // Add color coding for profit
        const netProfitEl = document.getElementById('statsNetProfit');
        const profitMarginEl = document.getElementById('statsProfitMargin');
        if (netProfit >= 0) {
            netProfitEl.style.color = 'var(--success)';
            profitMarginEl.style.color = 'var(--success)';
        } else {
            netProfitEl.style.color = 'var(--danger)';
            profitMarginEl.style.color = 'var(--danger)';
        }

        // Render charts
        renderStatisticsCharts(stats, vdsExpenses, totalSalaries, totalExpenses, netProfit);
    } catch (error) {
        console.error('Error loading detailed statistics:', error);
    }
}

// Store chart instances to destroy them before re-rendering
let chartInstances = {
    revenueChart: null,
    salesStatusChart: null,
    expenseChart: null,
    profitChart: null
};

// Render all statistics charts
function renderStatisticsCharts(stats, vdsExpenses, totalSalaries, totalExpenses, netProfit) {
    // Destroy existing charts before creating new ones
    Object.keys(chartInstances).forEach(key => {
        if (chartInstances[key]) {
            chartInstances[key].destroy();
            chartInstances[key] = null;
        }
    });

    // Chart colors matching the theme
    const colors = {
        primary: '#4c7bfa',
        success: '#34c98f',
        warning: '#e6a53a',
        danger: '#e35a6c',
        surface: '#1a2130',
        text: '#edf0f6'
    };

    // 1. Revenue Breakdown (Doughnut Chart)
    const revenueCtx = document.getElementById('revenueChart');
    if (revenueCtx) {
        chartInstances.revenueChart = new Chart(revenueCtx, {
            type: 'doughnut',
            data: {
                labels: ['Paid Amount', 'Pending Amount'],
                datasets: [{
                    data: [stats.paidAmount, stats.pendingAmount],
                    backgroundColor: [colors.success, colors.warning],
                    borderColor: colors.surface,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: colors.text,
                            padding: 15,
                            font: { size: 12 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return context.label + ': ₱' + context.parsed.toLocaleString();
                            }
                        }
                    }
                }
            }
        });
    }

    // 2. Sales Status (Pie Chart)
    const salesStatusCtx = document.getElementById('salesStatusChart');
    if (salesStatusCtx) {
        chartInstances.salesStatusChart = new Chart(salesStatusCtx, {
            type: 'pie',
            data: {
                labels: ['Paid Sales', 'Pending Sales'],
                datasets: [{
                    data: [stats.paidSales, stats.totalSales - stats.paidSales],
                    backgroundColor: [colors.success, colors.warning],
                    borderColor: colors.surface,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: colors.text,
                            padding: 15,
                            font: { size: 12 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return context.label + ': ' + context.parsed + ' sales';
                            }
                        }
                    }
                }
            }
        });
    }

    // 3. Expense Distribution (Doughnut Chart)
    const expenseCtx = document.getElementById('expenseChart');
    if (expenseCtx) {
        chartInstances.expenseChart = new Chart(expenseCtx, {
            type: 'doughnut',
            data: {
                labels: ['VPS Expenses', 'Owner Salary', 'Developer Salary', 'Staff Salary'],
                datasets: [{
                    data: [vdsExpenses, stats.salaries.owner, stats.salaries.developer, stats.salaries.staff],
                    backgroundColor: [colors.primary, colors.danger, colors.warning, colors.success],
                    borderColor: colors.surface,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: colors.text,
                            padding: 15,
                            font: { size: 12 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return context.label + ': ₱' + context.parsed.toLocaleString();
                            }
                        }
                    }
                }
            }
        });
    }

    // 4. Profit Overview (Bar Chart)
    const profitCtx = document.getElementById('profitChart');
    if (profitCtx) {
        chartInstances.profitChart = new Chart(profitCtx, {
            type: 'bar',
            data: {
                labels: ['Paid Amount', 'Total Expenses', 'Net Profit'],
                datasets: [{
                    label: 'Amount (PHP)',
                    data: [stats.paidAmount, totalExpenses, netProfit],
                    backgroundColor: [colors.success, colors.danger, netProfit >= 0 ? colors.success : colors.danger],
                    borderColor: colors.surface,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return '₱' + context.parsed.y.toLocaleString();
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: colors.text,
                            callback: function(value) {
                                return '₱' + value.toLocaleString();
                            }
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        }
                    },
                    x: {
                        ticks: {
                            color: colors.text
                        },
                        grid: {
                            display: false
                        }
                    }
                }
            }
        });
    }
}

// Filter the expirations table by search text and status
function filterExpiringSales() {
    const searchEl = document.getElementById('expirationsSearch');
    const statusEl = document.getElementById('expirationsStatusFilter');
    const query = searchEl ? searchEl.value.trim().toLowerCase() : '';
    const status = statusEl ? statusEl.value : '';
    let filtered = [...(expiringSales || [])];
    if (status) {
        filtered = filtered.filter(sale => (sale.status || '').toLowerCase() === status);
    }
    if (query) {
        filtered = filtered.filter(sale => {
            return `${sale.customer_name} ${sale.plan}`.toLowerCase().includes(query);
        });
    }
    displayExpiringSales(filtered);
}

// ============================================================================
// Customers (Customers tab)
// ============================================================================

let allCustomers = [];
let currentCustomer = null;

async function loadCustomersList() {
    const tbody = document.getElementById('customersTableBody');
    if (!tbody) return;
    try {
        const response = await fetch(`${API_BASE}/customers`, { credentials: 'include' });
        if (!response.ok) throw new Error('Unable to load customers');
        allCustomers = await response.json();
        displayFilteredCustomers();
    } catch (err) {
        console.error('Error loading customers:', err);
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Unable to load customers</td></tr>';
    }
}

function displayFilteredCustomers() {
    const tbody = document.getElementById('customersTableBody');
    if (!tbody) return;
    const searchEl = document.getElementById('customerListSearch');
    const query = searchEl ? searchEl.value.trim().toLowerCase() : '';
    let customers = [...allCustomers];
    if (query) {
        customers = customers.filter(c =>
            `${c.name} ${c.discord_id || ''} ${c.contact || ''}`.toLowerCase().includes(query)
        );
    }
    if (!customers.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No customers found</td></tr>';
        return;
    }
    tbody.innerHTML = customers.map(c => `
        <tr>
            <td>${escapeHtml(c.name)}</td>
            <td>${c.discord_id ? escapeHtml(c.discord_id) : '-'}</td>
            <td>${c.contact ? escapeHtml(c.contact) : '-'}</td>
            <td>${c.total_orders || 0}</td>
            <td>₱${formatCurrency(c.total_spent || 0)}</td>
            <td>${c.latest_expiry ? formatDate(c.latest_expiry) : '-'}</td>
            <td>
                <div class="action-buttons">
                    <button type="button" class="btn btn-secondary" data-action="view-customer" data-id="${c.id}">View / Edit</button>
                </div>
            </td>
        </tr>
    `).join('');
}

async function openCustomerModal(id) {
    try {
        const response = await fetch(`${API_BASE}/customers/${id}`, { credentials: 'include' });
        if (!response.ok) throw new Error('Customer not found');
        currentCustomer = await response.json();
        document.getElementById('customerNameInput').value = currentCustomer.name;
        document.getElementById('customerDiscordInput').value = currentCustomer.discord_id || '';
        document.getElementById('customerContactInput').value = currentCustomer.contact || '';
        document.getElementById('customerNotesInput').value = currentCustomer.notes || '';
        const errEl = document.getElementById('customerFormError');
        if (errEl) errEl.textContent = '';

        const tbody = document.getElementById('customerSalesBody');
        const sales = currentCustomer.sales || [];
        if (!sales.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No purchases</td></tr>';
        } else {
            tbody.innerHTML = sales.map(s => `
                <tr>
                    <td>${formatDate(s.date_bought)}</td>
                    <td>${s.date_expiry ? formatDate(s.date_expiry) : '-'}</td>
                    <td>${escapeHtml(s.plan)}</td>
                    <td>₱${formatCurrency(s.amount)}</td>
                    <td><span class="status-badge ${(s.status || '').toLowerCase()}">${s.status || '-'}</span></td>
                </tr>
            `).join('');
        }
        document.getElementById('customerModal').classList.remove('hidden');
    } catch (err) {
        console.error('Error opening customer:', err);
        alert('Could not load customer details');
    }
}

function closeCustomerModal() {
    document.getElementById('customerModal').classList.add('hidden');
    currentCustomer = null;
}

async function handleCustomerForm(e) {
    e.preventDefault();
    if (!currentCustomer) return;
    const errEl = document.getElementById('customerFormError');
    if (errEl) errEl.textContent = '';
    const payload = {
        name: document.getElementById('customerNameInput').value.trim(),
        discord_id: document.getElementById('customerDiscordInput').value.trim(),
        contact: document.getElementById('customerContactInput').value.trim(),
        notes: document.getElementById('customerNotesInput').value.trim(),
    };
    if (!payload.name) {
        errEl.textContent = 'Customer name is required';
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/customers/${currentCustomer.id}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not save customer');
        closeCustomerModal();
        await loadCustomersList();
    } catch (err) {
        console.error('Error saving customer:', err);
        errEl.textContent = err.message;
    }
}

async function deleteCurrentCustomer() {
    if (!currentCustomer) return;
    if (!confirm(`Delete customer record "${currentCustomer.name}"? Their purchase history stays, only the saved customer details are removed.`)) {
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/customers/${currentCustomer.id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        if (!response.ok) throw new Error('Could not delete customer');
        closeCustomerModal();
        await loadCustomersList();
    } catch (err) {
        console.error('Error deleting customer:', err);
        alert(err.message);
    }
}

// ============================================================================
// Backups (Backups tab)
// ============================================================================

function setBackupMessage(text, isError) {
    const el = document.getElementById('backupMessage');
    if (el) {
        el.textContent = text || '';
        el.classList.toggle('is-error', !!isError);
    }
}

function formatFileSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / 1024).toFixed(1) + ' KB';
}

async function loadBackups() {
    const tbody = document.getElementById('backupsTableBody');
    if (!tbody) return;
    setBackupMessage('');
    try {
        const response = await fetch(`${API_BASE}/backup`, { credentials: 'include' });
        if (!response.ok) throw new Error('Unable to load backups');
        const backups = await response.json();
        if (!backups.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No backups yet</td></tr>';
            return;
        }
        tbody.innerHTML = backups.map(b => `
            <tr>
                <td>${escapeHtml(b.file)}</td>
                <td>${formatFileSize(b.size)}</td>
                <td>${formatDate(b.created)}</td>
                <td>
                    <div class="action-buttons">
                        <button type="button" class="btn btn-secondary" data-action="download-backup" data-file="${escapeHtml(b.file)}">Download</button>
                        <button type="button" class="btn btn-renew" data-action="delete-backup" data-file="${escapeHtml(b.file)}">Delete</button>
                    </div>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        console.error('Error loading backups:', err);
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Unable to load backups</td></tr>';
    }
}

async function createBackupNow() {
    const btn = document.getElementById('createBackupBtn');
    btn.disabled = true;
    btn.textContent = 'Creating...';
    try {
        const response = await fetch(`${API_BASE}/backup`, { method: 'POST', credentials: 'include' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Backup failed');
        setBackupMessage(data.message || 'Backup created successfully', false);
        await loadBackups();
    } catch (err) {
        console.error('Error creating backup:', err);
        setBackupMessage(err.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create Backup Now';
    }
}

async function downloadBackup(file) {
    try {
        const response = await fetch(`${API_BASE}/backup/download?file=${encodeURIComponent(file)}`, { credentials: 'include' });
        if (!response.ok) throw new Error('Download failed');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('Error downloading backup:', err);
        alert(err.message);
    }
}

async function deleteBackup(file) {
    if (!confirm(`Delete backup "${file}"?`)) return;
    try {
        const response = await fetch(`${API_BASE}/backup?file=${encodeURIComponent(file)}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'Could not delete backup');
        }
        await loadBackups();
    } catch (err) {
        console.error('Error deleting backup:', err);
        alert(err.message);
    }
}

// ============================================================================
// Discord Bot Settings (Discord tab)
// ============================================================================

function setDiscordMessage(text, isError) {
    const el = document.getElementById('discordMessage');
    if (el) {
        el.textContent = text || '';
        el.classList.toggle('is-error', !!isError);
    }
}

async function refreshDiscordStatus() {
    const statusEl = document.getElementById('discordBotStatus');
    const userEl = document.getElementById('discordBotUser');
    if (!statusEl) return;
    try {
        const response = await fetch(`${API_BASE}/discord/status`, { credentials: 'include' });
        const data = await response.json();
        const label = {
            online: { text: '🟢 Online', color: '#57f287' },
            connecting: { text: '🟡 Connecting...', color: '#fee75c' },
            starting: { text: '🟡 Starting...', color: '#fee75c' },
            not_configured: { text: '⚪ Not configured', color: '' },
            error: { text: '🔴 Error', color: '#ed4245' },
            stopped: { text: '⚪ Stopped', color: '' },
        }[data.status] || { text: '⚪ Unknown', color: '' };
        statusEl.textContent = label.text;
        statusEl.style.color = label.color;
        if (userEl) userEl.textContent = data.user || '—';
        if (data.error) {
            console.error('Discord integration message:', data.error);
        }
    } catch (err) {
        console.error('Error fetching Discord status:', err);
        statusEl.textContent = '⚪ Unknown';
    }
}

async function loadDiscordSettings() {
    if (!document.getElementById('discordTab')) return;
    setDiscordMessage('');
    refreshDiscordStatus();
    try {
        const response = await fetch(`${API_BASE}/discord/settings`, { credentials: 'include' });
        if (!response.ok) throw new Error('Could not load Discord settings');
        const settings = await response.json();
        document.getElementById('discordGuildId').value = settings.guild_id || '';
        document.getElementById('discordAdminRoleId').value = settings.admin_role_id || '';
        document.getElementById('discordChannelId').value = settings.channel_id || '';
        document.getElementById('discordWebhook').value = settings.webhook_url || '';
        document.getElementById('discordExpiringDays').value = settings.expiring_days || 7;
        document.getElementById('discordNotifySales').checked = settings.notify_sales !== 'false';
        document.getElementById('discordNotifyRenewals').checked = settings.notify_renewals !== 'false';
        document.getElementById('discordNotifyExpiring').checked = settings.notify_expiring !== 'false';
        const maskedEl = document.getElementById('discordTokenMasked');
        if (maskedEl) maskedEl.textContent = settings.bot_token_masked ? `Current token: ${settings.bot_token_masked}` : 'No token configured yet';
        // Refresh bot status after a short delay in case it is still connecting
        setTimeout(refreshDiscordStatus, 4000);
    } catch (err) {
        console.error('Error loading Discord settings:', err);
        setDiscordMessage('Could not load Discord settings.', true);
    }
}

async function saveDiscordSettings() {
    const saveBtn = document.getElementById('discordSaveBtn');
    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = 'Saving...';
    try {
        const tokenEl = document.getElementById('discordToken');
        const payload = {
            guild_id: document.getElementById('discordGuildId').value.trim(),
            admin_role_id: document.getElementById('discordAdminRoleId').value.trim(),
            channel_id: document.getElementById('discordChannelId').value.trim(),
            webhook_url: document.getElementById('discordWebhook').value.trim(),
            expiring_days: parseInt(document.getElementById('discordExpiringDays').value, 10) || 7,
            notify_sales: document.getElementById('discordNotifySales').checked ? 'true' : 'false',
            notify_renewals: document.getElementById('discordNotifyRenewals').checked ? 'true' : 'false',
            notify_expiring: document.getElementById('discordNotifyExpiring').checked ? 'true' : 'false',
        };
        if (tokenEl.value.trim()) {
            payload.bot_token = tokenEl.value.trim();
        }
        const response = await fetch(`${API_BASE}/discord/settings`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not save Discord settings');
        tokenEl.value = '';
        setDiscordMessage(data.message || 'Saved. The bot is restarting...', false);
        // Poll status so the user sees the bot come online
        setTimeout(refreshDiscordStatus, 3000);
        setTimeout(refreshDiscordStatus, 8000);
    } catch (err) {
        console.error('Error saving Discord settings:', err);
        setDiscordMessage(err.message, true);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel;
    }
}

async function sendDiscordTest() {
    const testBtn = document.getElementById('discordTestBtn');
    testBtn.disabled = true;
    const originalLabel = testBtn.textContent;
    testBtn.textContent = 'Sending...';
    try {
        const response = await fetch(`${API_BASE}/discord/test`, {
            method: 'POST',
            credentials: 'include'
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Test notification failed');
        setDiscordMessage(data.message || 'Test notification sent.', false);
    } catch (err) {
        console.error('Discord test failed:', err);
        setDiscordMessage(err.message, true);
    } finally {
        testBtn.disabled = false;
        testBtn.textContent = originalLabel;
    }
}
