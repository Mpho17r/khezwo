const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const qrcode = require('qrcode');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pgSession = require('connect-pg-simple')(session);

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// Rate limiting for API
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
    message: { error: 'Too many login attempts. Please try again later.' }
});

app.use('/api/', apiLimiter);

app.use(session({
        store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'khezwo-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: true,
        sameSite: 'strict'
    }
}));

const getBaseUrl = () => process.env.BASE_URL || `http://localhost:${PORT}`;
const query = (text, params) => pool.query(text, params);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/menu/:vendorId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer-menu.html'));
});

// ============= API ROUTES =============

app.get('/api/menu/:vendorId', async (req, res) => {
    const vendorId = req.params.vendorId;
    
    try {
        const vendorResult = await query(`SELECT * FROM vendors WHERE id = $1`, [vendorId]);
        
        if (vendorResult.rows.length === 0) {
            return res.status(404).json({ error: 'Vendor not found' });
        }
        
        const vendor = vendorResult.rows[0];
        const itemsResult = await query(`SELECT * FROM menu_items WHERE vendor_id = $1 AND is_available = 1 ORDER BY id DESC`, [vendorId]);
        
        res.json({
            vendor: {
                id: vendor.id,
                business_name: vendor.business_name,
                business_type: vendor.business_type,
                logo_url: vendor.logo_url,
                background_image: vendor.background_image,
                is_open: vendor.is_open,
                closed_message: vendor.closed_message
            },
            menu_items: itemsResult.rows || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/place-order', async (req, res) => {
    const { vendor_id, customer_name, customer_phone, items, total, payment_method } = req.body;
    
    if (!vendor_id || !items || !total) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    try {
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 1000);
        const orderNumber = `${vendor_id}-${timestamp}-${random}`;
        
        const vendorResult = await query(`SELECT platform_fee_percentage FROM vendors WHERE id = $1`, [vendor_id]);
        const platformFeePercent = vendorResult.rows[0]?.platform_fee_percentage || 5;
        const platformFee = (total * platformFeePercent) / 100;
        
        const result = await query(
            `INSERT INTO orders (vendor_id, order_number, customer_name, customer_phone, items_json, total, platform_fee, payment_method, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'received', CURRENT_TIMESTAMP)
             RETURNING order_number, id`,
            [vendor_id, orderNumber, customer_name || 'Anonymous', customer_phone || '', JSON.stringify(items), total, platformFee, payment_method]
        );
        
        await query(
            `INSERT INTO order_tracking (order_id, status) VALUES ($1, 'received')`,
            [result.rows[0].id]
        );
        
        res.json({ 
            success: true, 
            order_number: result.rows[0].order_number,
            platform_fee: platformFee,
            total_with_fee: total + platformFee
        });
    } catch (err) {
        console.error('Place order error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============= VENDOR AUTH =============

app.post('/vendor/signup', async (req, res) => {
    const { 
        business_name, owner_name, email, phone, password,
        business_type, business_size, subscription_tier,
        has_branches, branch_count 
    } = req.body;
    
    if (!business_name || !owner_name || !email || !phone || !password) {
        return res.status(400).json({ error: 'All fields required' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await query(
            `INSERT INTO vendors (
                business_name, owner_name, email, phone, password, 
                business_type, business_size, subscription_tier,
                created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP) RETURNING id`,
            [business_name, owner_name, email, phone, hashedPassword, 
             business_type || 'restaurant', business_size || 'small', subscription_tier || 'free']
        );
        
        const vendorId = result.rows[0].id;
        const baseUrl = getBaseUrl();
        const qrUrl = `${baseUrl}/menu/${vendorId}`;
        qrcode.toFile(`./uploads/qr_${vendorId}.png`, qrUrl, () => {});
        
        if (has_branches === 'yes' && branch_count && branch_count > 1) {
            await query(`UPDATE vendors SET is_headquarters = true WHERE id = $1`, [vendorId]);
        }
        
        await query(
            `INSERT INTO audit_logs (vendor_id, action, details) VALUES ($1, 'signup', $2)`,
            [vendorId, JSON.stringify({ business_type, business_size, subscription_tier })]
        );
        
        res.json({ success: true, vendor_id: vendorId });
    } catch (err) {
        if (err.constraint === 'vendors_email_key') {
            return res.status(400).json({ error: 'Email already registered' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/vendor/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const result = await query(`SELECT * FROM vendors WHERE email = $1`, [email]);
        
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        const vendor = result.rows[0];
        const valid = await bcrypt.compare(password, vendor.password);
        
        if (!valid) {
            await query(
                `INSERT INTO audit_logs (vendor_id, action, details) VALUES ($1, 'failed_login', $2)`,
                [vendor.id, JSON.stringify({ ip: req.ip })]
            );
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        req.session.vendor = vendor;
        
        await query(
            `INSERT INTO audit_logs (vendor_id, action, details) VALUES ($1, 'login', $2)`,
            [vendor.id, JSON.stringify({ ip: req.ip })]
        );
        
        res.json({ success: true, redirect: '/vendor-dashboard.html' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/vendor/logout', (req, res) => {
    if (req.session.vendor) {
        query(`INSERT INTO audit_logs (vendor_id, action) VALUES ($1, 'logout')`, [req.session.vendor.id]);
    }
    req.session.destroy();
    res.redirect('/');
});

// ============= VENDOR DASHBOARD DATA =============

app.get('/api/vendor/data', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    
    try {
        const vendorResult = await query(`SELECT * FROM vendors WHERE id = $1`, [vendorId]);
        const itemsResult = await query(`SELECT * FROM menu_items WHERE vendor_id = $1 ORDER BY id DESC`, [vendorId]);
        const ordersResult = await query(`SELECT * FROM orders WHERE vendor_id = $1 AND status IN ('received', 'preparing', 'ready') ORDER BY created_at DESC`, [vendorId]);
        
        let branches = [];
        if (vendorResult.rows[0].is_headquarters) {
            const branchesResult = await query(`
                SELECT v.*, 
                    (SELECT COUNT(*) FROM orders WHERE vendor_id = v.id) as total_orders,
                    (SELECT COALESCE(SUM(total), 0) FROM orders WHERE vendor_id = v.id) as total_sales,
                    (SELECT COUNT(*) FROM menu_items WHERE vendor_id = v.id) as menu_items
                FROM vendors v 
                WHERE v.parent_id = $1
            `, [vendorId]);
            branches = branchesResult.rows;
        }
        
        res.json({
            vendor: vendorResult.rows[0],
            menu_items: itemsResult.rows || [],
            orders: ordersResult.rows || [],
            branches: branches
        });
    } catch (err) {
        console.error('Vendor data error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============= QR CODE ENDPOINTS =============

app.get('/api/vendor/qr-code', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    const baseUrl = getBaseUrl();
    const qrUrl = `${baseUrl}/menu/${vendorId}`;
    
    try {
        const qrBase64 = await qrcode.toDataURL(qrUrl, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 300
        });
        res.json({ success: true, qrBase64: qrBase64 });
    } catch (err) {
        console.error('QR generation error:', err);
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

app.get('/api/vendor/regenerate-qr', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    const baseUrl = getBaseUrl();
    const qrUrl = `${baseUrl}/menu/${vendorId}`;
    
    try {
        await qrcode.toFile(`./uploads/qr_${vendorId}.png`, qrUrl, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 300
        });
        
        const qrBase64 = await qrcode.toDataURL(qrUrl, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 300
        });
        
        res.json({ success: true, qrBase64: qrBase64 });
    } catch (err) {
        console.error('QR regeneration error:', err);
        res.status(500).json({ error: 'Failed to regenerate QR code' });
    }
});

// ============= VENDOR MENU MANAGEMENT =============

app.post('/api/vendor/add-menu-item', uploadWithValidation.single('photo'), async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { name, price, description, ingredients } = req.body;
    const photoUrl = req.file ? `/uploads/${req.file.filename}` : null;
    
    try {
        await query(
            `INSERT INTO menu_items (vendor_id, name, price, description, ingredients, photo_url, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
            [req.session.vendor.id, name, price, description, ingredients, photoUrl]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/vendor/toggle-availability', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { item_id, is_available } = req.body;
    
    try {
        await query(
            `UPDATE menu_items SET is_available = $1 WHERE id = $2 AND vendor_id = $3`,
            [is_available, item_id, req.session.vendor.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============= VENDOR PROFILE =============

app.post('/api/vendor/update-profile', uploadWithValidation.single('logo'), async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { business_name, owner_name, phone, address, is_open, closed_message } = req.body;
    
    try {
        const currentVendor = await query(`SELECT * FROM vendors WHERE id = $1`, [req.session.vendor.id]);
        let logoUrl = currentVendor.rows[0].logo_url;
        let backgroundImage = currentVendor.rows[0].background_image;
        
        if (req.file) {
            logoUrl = `/uploads/${req.file.filename}`;
        }
        
        await query(
            `UPDATE vendors SET 
                business_name = $1, 
                owner_name = $2, 
                phone = $3, 
                address = $4, 
                is_open = $5, 
                closed_message = $6,
                logo_url = $7,
                background_image = $8
             WHERE id = $9`,
            [business_name, owner_name, phone, address, is_open || 1, closed_message || null, logoUrl, backgroundImage, req.session.vendor.id]
        );
        
        const result = await query(`SELECT * FROM vendors WHERE id = $1`, [req.session.vendor.id]);
        req.session.vendor = result.rows[0];
        
        res.json({ success: true });
    } catch (err) {
        console.error('Update profile error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/vendor/upload-background', uploadWithValidation.single('background'), async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const backgroundUrl = `/uploads/${req.file.filename}`;
    
    try {
        await query(
            `UPDATE vendors SET background_image = $1 WHERE id = $2`,
            [backgroundUrl, req.session.vendor.id]
        );
        
        const result = await query(`SELECT * FROM vendors WHERE id = $1`, [req.session.vendor.id]);
        req.session.vendor = result.rows[0];
        
        res.json({ success: true, background_url: backgroundUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/vendor/remove-background', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    try {
        await query(
            `UPDATE vendors SET background_image = NULL WHERE id = $1`,
            [req.session.vendor.id]
        );
        
        const result = await query(`SELECT * FROM vendors WHERE id = $1`, [req.session.vendor.id]);
        req.session.vendor = result.rows[0];
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============= ORDER TRACKING AND STATUS UPDATE =============

app.post('/api/vendor/update-tracking', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { order_id, status } = req.body;
    
    const validStatuses = ['received', 'preparing', 'ready', 'completed'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    
    try {
        await query(
            `UPDATE orders SET status = $1 WHERE id = $2 AND vendor_id = $3`,
            [status, order_id, req.session.vendor.id]
        );
        
        await query(
            `INSERT INTO order_tracking (order_id, status) VALUES ($1, $2)`,
            [order_id, status]
        );
        
        console.log(`✅ Order ${order_id} status updated to ${status}`);
        res.json({ success: true, status: status });
    } catch (err) {
        console.error('Update tracking error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/vendor/update-order-status', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { order_id, status } = req.body;
    
    try {
        await query(
            `UPDATE orders SET status = $1 WHERE id = $2 AND vendor_id = $3`,
            [status, order_id, req.session.vendor.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/track-order/:orderNumber', async (req, res) => {
    const { orderNumber } = req.params;
    
    try {
        const orderResult = await query(`
            SELECT o.*, v.business_name, v.logo_url 
            FROM orders o
            JOIN vendors v ON o.vendor_id = v.id
            WHERE o.order_number = $1
        `, [orderNumber]);
        
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderResult.rows[0];
        const items = typeof order.items_json === 'string' ? JSON.parse(order.items_json) : order.items_json;
        
        const statuses = ['received', 'preparing', 'ready', 'completed'];
        let currentStatus = order.status;
        if (currentStatus === 'pending') currentStatus = 'received';
        
        let currentStep = statuses.indexOf(currentStatus);
        if (currentStep === -1) currentStep = 0;
        
        const progress = (currentStep / 3) * 100;
        
        res.json({
            order: {
                order_number: order.order_number,
                customer_name: order.customer_name,
                customer_phone: order.customer_phone,
                total: order.total,
                platform_fee: order.platform_fee || 0,
                payment_method: order.payment_method,
                status: currentStatus,
                created_at: order.created_at,
                business_name: order.business_name,
                logo_url: order.logo_url
            },
            items: items,
            progress: progress,
            current_step: currentStep,
            statuses: statuses
        });
    } catch (err) {
        console.error('Track order error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============= VENDOR ORDER HISTORY =============

app.get('/api/vendor/order-history', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    const { search, date } = req.query;
    
    try {
        let queryText = `SELECT * FROM orders WHERE vendor_id = $1 AND status = 'completed'`;
        let params = [vendorId];
        let paramCount = 2;
        
        if (search) {
            queryText += ` AND (order_number ILIKE $${paramCount} OR customer_name ILIKE $${paramCount})`;
            params.push(`%${search}%`);
            paramCount++;
        }
        
        if (date) {
            queryText += ` AND DATE(created_at) = $${paramCount}`;
            params.push(date);
            paramCount++;
        }
        
        queryText += ` ORDER BY created_at DESC LIMIT 200`;
        
        const result = await query(queryText, params);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============= ADMIN ROUTES =============

app.post('/admin/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const result = await query(`SELECT * FROM admin_users WHERE username = $1`, [username]);
        
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        const admin = result.rows[0];
        const valid = await bcrypt.compare(password, admin.password);
        
        if (!valid) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        req.session.admin = admin;
        res.json({ success: true, redirect: '/admin-dashboard.html' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/vendors', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const result = await query(`
            SELECT v.*, 
                   (SELECT COUNT(*) FROM orders WHERE vendor_id = v.id) as total_orders,
                   s.name as subscription_name
            FROM vendors v
            LEFT JOIN subscription_plans s ON v.subscription_tier = s.tier
            ORDER BY v.created_at DESC
        `);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/toggle-vendor', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { vendor_id, is_suspended } = req.body;
    
    try {
        await query(`UPDATE vendors SET is_suspended = $1 WHERE id = $2`, [is_suspended ? 1 : 0, vendor_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/orders', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const result = await query(`
            SELECT o.*, v.business_name as vendor_name 
            FROM orders o 
            JOIN vendors v ON o.vendor_id = v.id 
            ORDER BY o.created_at DESC LIMIT 100
        `);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const totalVendors = await query(`SELECT COUNT(*) FROM vendors`);
        const activeVendors = await query(`SELECT COUNT(*) FROM vendors WHERE is_suspended = 0`);
        const suspendedVendors = await query(`SELECT COUNT(*) FROM vendors WHERE is_suspended = 1`);
        const totalOrders = await query(`SELECT COUNT(*) FROM orders`);
        const totalRevenue = await query(`SELECT COALESCE(SUM(platform_fee), 0) as total FROM orders`);
        const vendorsByType = await query(`SELECT business_type, COUNT(*) as count FROM vendors GROUP BY business_type`);
        
        res.json({
            total_vendors: parseInt(totalVendors.rows[0].count),
            active_vendors: parseInt(activeVendors.rows[0].count),
            suspended_vendors: parseInt(suspendedVendors.rows[0].count),
            total_orders: parseInt(totalOrders.rows[0].count),
            total_platform_revenue: parseFloat(totalRevenue.rows[0].total),
            vendors_by_type: vendorsByType.rows
        });
    } catch (err) {
        res.json({ total_vendors: 0, active_vendors: 0, suspended_vendors: 0, total_orders: 0, total_platform_revenue: 0, vendors_by_type: [] });
    }
});

// ============= FIX ENDPOINTS =============

app.get('/api/fix-order-numbers', async (req, res) => {
    try {
        const vendors = await query('SELECT id FROM vendors');
        let details = '';
        let totalUpdated = 0;
        
        for (const vendor of vendors.rows) {
            const orders = await query(
                'SELECT id FROM orders WHERE vendor_id = $1 ORDER BY created_at ASC',
                [vendor.id]
            );
            
            for (let i = 0; i < orders.rows.length; i++) {
                const seqNumber = String(i + 1).padStart(3, '0');
                await query('UPDATE orders SET order_number = $1 WHERE id = $2', [seqNumber, orders.rows[i].id]);
                totalUpdated++;
            }
            details += `Vendor ${vendor.id}: ${orders.rows.length} orders updated\n`;
        }
        
        res.json({ success: true, message: `${totalUpdated} orders updated`, details: details });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/fix-database', async (req, res) => {
    try {
        await query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_number_key`);
        await query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS background_image TEXT`);
        await query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS business_type TEXT DEFAULT 'restaurant'`);
        await query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS business_size TEXT DEFAULT 'small'`);
        await query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'free'`);
        await query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES vendors(id)`);
        await query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_headquarters BOOLEAN DEFAULT FALSE`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS platform_fee DECIMAL(10,2) DEFAULT 0`);
        await query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS platform_fee_percentage DECIMAL(5,2) DEFAULT 5`);
        
        await query(`CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            vendor_id INTEGER REFERENCES vendors(id),
            action TEXT NOT NULL,
            details TEXT,
            ip_address TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        
        await query(`CREATE TABLE IF NOT EXISTS order_tracking (
            id SERIAL PRIMARY KEY,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            status TEXT DEFAULT 'received',
            estimated_time INTEGER,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        
        await query(`CREATE TABLE IF NOT EXISTS business_types (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            icon TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        
        await query(`INSERT INTO business_types (name, icon) VALUES
            ('restaurant', '🍽️'),
            ('clothing', '👕'),
            ('farming', '🌾'),
            ('retail', '🛍️'),
            ('services', '🔧')
            ON CONFLICT (name) DO NOTHING`);
        
        await query(`CREATE TABLE IF NOT EXISTS subscription_plans (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            tier TEXT UNIQUE NOT NULL,
            price DECIMAL(10,2) NOT NULL,
            max_items INTEGER,
            max_branches INTEGER,
            has_analytics BOOLEAN DEFAULT FALSE,
            has_custom_branding BOOLEAN DEFAULT FALSE,
            has_priority_support BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        
        await query(`INSERT INTO subscription_plans (name, tier, price, max_items, max_branches, has_analytics, has_custom_branding, has_priority_support) VALUES
            ('Free', 'free', 0, 20, 1, FALSE, FALSE, FALSE),
            ('Pro', 'pro', 299, NULL, 1, TRUE, TRUE, FALSE),
            ('Enterprise', 'enterprise', 999, NULL, 10, TRUE, TRUE, TRUE)
            ON CONFLICT (tier) DO NOTHING`);
        
        res.json({ success: true, message: 'Database fixed! All tables created.' });
    } catch (err) {
        res.json({ error: err.message });
    }
});

app.get('/api/debug-orders', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    const orders = await query('SELECT id, order_number, status, created_at FROM orders WHERE vendor_id = $1', [req.session.vendor.id]);
    res.json(orders.rows);
});

// ============= VENDOR DASHBOARD PAGE =============
app.get('/vendor-dashboard.html', (req, res) => {
    if (!req.session.vendor) {
        return res.redirect('/vendor-login.html');
    }
    res.sendFile(path.join(__dirname, 'public', 'vendor-dashboard.html'));
});

app.listen(PORT, () => {
    console.log(`\n✅ KheZwo is running!`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`📍 Production URL: ${process.env.BASE_URL || 'Not set'}`);
    console.log(`🎉 Ready to go!\n`);
});// File upload validation
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only images are allowed.'), false);
    }
};

const uploadWithValidation = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: fileFilter
});

// Replace the existing upload with validated version
// Update the routes to use uploadWithValidation instead of upload
