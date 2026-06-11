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

// Create session table if not exists
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "session" (
                "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
                "sess" json NOT NULL,
                "expire" timestamp(6) NOT NULL
            )
        `);
        console.log('✅ Session table ready');
    } catch (err) {
        console.log('Session table may already exist');
    }
})();

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// File validation
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only images are allowed.'), false);
    }
};

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: fileFilter
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Rate limiting
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

// Session with PostgreSQL store
app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'khezwo-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: false, // Set to true if using HTTPS only (Render uses HTTPS)
        sameSite: 'lax'
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
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        req.session.vendor = vendor;
        
        res.json({ success: true, redirect: '/vendor-dashboard.html' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/vendor/logout', (req, res) => {
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
        
        res.json({
            vendor: vendorResult.rows[0],
            menu_items: itemsResult.rows || [],
            orders: ordersResult.rows || []
        });
    } catch (err) {
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
        res.status(500).json({ error: 'Failed to regenerate QR code' });
    }
});

// ============= VENDOR MENU MANAGEMENT =============

app.post('/api/vendor/add-menu-item', upload.single('photo'), async (req, res) => {
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

app.post('/api/vendor/update-profile', upload.single('logo'), async (req, res) => {
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
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/vendor/upload-background', upload.single('background'), async (req, res) => {
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

// ============= ORDER TRACKING =============

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
        
        res.json({ success: true, status: status });
    } catch (err) {
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
                   (SELECT COUNT(*) FROM orders WHERE vendor_id = v.id) as total_orders
            FROM vendors v
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
        
        res.json({
            total_vendors: parseInt(totalVendors.rows[0].count),
            active_vendors: parseInt(activeVendors.rows[0].count),
            suspended_vendors: parseInt(suspendedVendors.rows[0].count),
            total_orders: parseInt(totalOrders.rows[0].count)
        });
    } catch (err) {
        res.json({ total_vendors: 0, active_vendors: 0, suspended_vendors: 0, total_orders: 0 });
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
        res.json({ success: true, message: 'Database fixed!' });
    } catch (err) {
        res.json({ error: err.message });
    }
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
});
// ============= ADMIN API ENDPOINTS =============

// Get feedback from vendors
app.get('/api/admin/feedback', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const result = await query(`
        SELECT f.*, v.business_name 
        FROM feedback f 
        JOIN vendors v ON f.vendor_id = v.id 
        ORDER BY f.created_at DESC LIMIT 50
    `);
    res.json(result.rows || []);
});

// Submit feedback (vendor side)
app.post('/api/vendor/feedback', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    const { message, rating } = req.body;
    await query(
        `INSERT INTO feedback (vendor_id, message, rating, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [req.session.vendor.id, message, rating || 5]
    );
    res.json({ success: true });
});

// Get system alerts
app.get('/api/admin/alerts', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const result = await query(`SELECT * FROM alerts WHERE dismissed = false ORDER BY created_at DESC LIMIT 50`);
    res.json(result.rows || []);
});

// Create alert
app.post('/api/admin/create-alert', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { title, message, type } = req.body;
    await query(`INSERT INTO alerts (title, message, type) VALUES ($1, $2, $3)`, [title, message, type || 'info']);
    res.json({ success: true });
});

// Dismiss alert
app.delete('/api/admin/dismiss-alert/:id', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    await query(`UPDATE alerts SET dismissed = true WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
});

// Clear all alerts
app.delete('/api/admin/clear-alerts', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    await query(`UPDATE alerts SET dismissed = true`);
    res.json({ success: true });
});

// Send reply to feedback
app.post('/api/admin/send-reply', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { feedback_id, message } = req.body;
    await query(`UPDATE feedback SET reply = $1, replied_at = CURRENT_TIMESTAMP WHERE id = $2`, [message, feedback_id]);
    res.json({ success: true });
});

// Update platform settings
app.post('/api/admin/update-settings', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { platform_fee, free_trial_days, min_order_amount } = req.body;
    await query(`UPDATE platform_settings SET 
        platform_fee = COALESCE($1, platform_fee),
        free_trial_days = COALESCE($2, free_trial_days),
        min_order_amount = COALESCE($3, min_order_amount),
        updated_at = CURRENT_TIMESTAMP
    `, [platform_fee, free_trial_days, min_order_amount]);
    res.json({ success: true });
});

// Enhanced stats with charts
app.get('/api/admin/stats', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const stats = await query(`SELECT 
        (SELECT COUNT(*) FROM vendors) as total_vendors,
        (SELECT COUNT(*) FROM vendors WHERE is_suspended = 0) as active_vendors,
        (SELECT COUNT(*) FROM orders) as total_orders,
        (SELECT COALESCE(SUM(platform_fee), 0) FROM orders) as total_platform_revenue,
        (SELECT COALESCE(AVG(rating), 0) FROM feedback) as avg_rating
    `);
    
    // Get weekly revenue for chart
    const weekly = await query(`
        SELECT DATE_TRUNC('week', created_at) as week, COALESCE(SUM(platform_fee), 0) as revenue
        FROM orders GROUP BY DATE_TRUNC('week', created_at) ORDER BY week DESC LIMIT 4
    `);
    
    res.json({
        ...stats.rows[0],
        chart_labels: weekly.rows.map(w => `Week ${w.week.getWeek()}`),
        chart_data: weekly.rows.map(w => parseFloat(w.revenue)),
        platform_fee: 5,
        free_trial_days: 14,
        min_order_amount: 0,
        growth_rate: 12,
        churn_rate: 3,
        satisfaction: 92
    });
});

// Helper for week number
Date.prototype.getWeek = function() { return Math.ceil((this - new Date(this.getFullYear(), 0, 1)) / 86400000 / 7); };
// Add missing admin tables
app.get('/api/create-admin-tables', async (req, res) => {
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS feedback (
                id SERIAL PRIMARY KEY,
                vendor_id INTEGER REFERENCES vendors(id),
                message TEXT NOT NULL,
                rating INTEGER DEFAULT 5,
                reply TEXT,
                replied_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS alerts (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                type TEXT DEFAULT 'info',
                dismissed BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS platform_settings (
                id INTEGER PRIMARY KEY DEFAULT 1,
                platform_fee DECIMAL(5,2) DEFAULT 5,
                free_trial_days INTEGER DEFAULT 14,
                min_order_amount DECIMAL(10,2) DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await query(`INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
        res.json({ success: true, message: 'Admin tables created!' });
    } catch (err) {
        res.json({ error: err.message });
    }
});
// ============= ADVANCED ADMIN API =============

// Enhanced stats for dashboard
app.get('/api/admin/stats', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const totalVendors = await query(`SELECT COUNT(*) FROM vendors`);
    const activeVendors = await query(`SELECT COUNT(*) FROM vendors WHERE is_suspended = 0`);
    const ordersToday = await query(`SELECT COUNT(*) FROM orders WHERE created_at >= $1`, [today]);
    const revenueToday = await query(`SELECT COALESCE(SUM(platform_fee), 0) FROM orders WHERE created_at >= $1`, [today]);
    const newVendorsWeek = await query(`SELECT COUNT(*) FROM vendors WHERE created_at >= NOW() - INTERVAL '7 days'`);
    const vendorGrowth = await query(`SELECT COUNT(*) FROM vendors WHERE created_at >= NOW() - INTERVAL '30 days'`);
    
    // Revenue chart data (last 30 days)
    const revenueData = await query(`
        SELECT DATE(created_at) as date, COALESCE(SUM(platform_fee), 0) as revenue
        FROM orders WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date ASC
    `);
    
    // Orders chart data
    const orderData = await query(`
        SELECT DATE(created_at) as date, COUNT(*) as orders
        FROM orders WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date ASC
    `);
    
    // Vendor health
    const vendorHealth = await query(`
        SELECT v.id, v.business_name, 
            (SELECT COUNT(*) FROM orders WHERE vendor_id = v.id AND DATE(created_at) = CURRENT_DATE) as orders_today,
            (SELECT COALESCE(SUM(total), 0) FROM orders WHERE vendor_id = v.id AND DATE(created_at) = CURRENT_DATE) as revenue_today,
            COALESCE((SELECT created_at FROM audit_logs WHERE vendor_id = v.id AND action = 'login' ORDER BY created_at DESC LIMIT 1), v.created_at) as last_login,
            CASE WHEN v.is_suspended = 1 THEN 'inactive' ELSE 'active' END as status
        FROM vendors v LIMIT 10
    `);
    
    // Recent activity
    const activities = await query(`
        SELECT action, details, created_at, 'login' as type FROM audit_logs ORDER BY created_at DESC LIMIT 10
    `);
    
    res.json({
        total_vendors: parseInt(totalVendors.rows[0].count),
        active_vendors: parseInt(activeVendors.rows[0].count),
        orders_today: parseInt(ordersToday.rows[0].count),
        revenue_today: parseFloat(revenueToday.rows[0].coalesce),
        new_vendors_week: parseInt(newVendorsWeek.rows[0].count),
        vendor_growth: Math.round((parseInt(newVendorsWeek.rows[0].count) / 30) * 100),
        chart_labels: revenueData.rows.map(r => new Date(r.date).toLocaleDateString()),
        revenue_data: revenueData.rows.map(r => parseFloat(r.revenue)),
        order_labels: orderData.rows.map(r => new Date(r.date).toLocaleDateString()),
        order_data: orderData.rows.map(r => parseInt(r.orders)),
        vendor_health: vendorHealth.rows,
        activities: activities.rows.map(a => ({ text: a.action, time: new Date(a.created_at).toLocaleTimeString(), icon: 'fa-user', color: '#667eea' }))
    });
});

// Analytics endpoint
app.get('/api/admin/analytics', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const topVendors = await query(`
        SELECT v.business_name, COUNT(o.id) as orders FROM vendors v 
        LEFT JOIN orders o ON v.id = o.vendor_id GROUP BY v.id ORDER BY orders DESC LIMIT 5
    `);
    
    const topProducts = await query(`
        SELECT value->>'name' as name, COUNT(*) as sales FROM orders o, jsonb_array_elements(o.items_json) as value 
        GROUP BY value->>'name' ORDER BY sales DESC LIMIT 5
    `);
    
    const peakHours = await query(`
        SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as orders 
        FROM orders GROUP BY hour ORDER BY orders DESC LIMIT 3
    `);
    
    res.json({
        top_vendors: topVendors.rows,
        top_products: topProducts.rows,
        peak_hours: peakHours.rows.map(r => ({ hour: r.hour, orders: parseInt(r.orders) }))
    });
});

// Audit logs
app.get('/api/admin/audit-logs', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const logs = await query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100`);
    res.json(logs.rows);
});

// Subscriptions
app.get('/api/admin/subscriptions', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const subs = await query(`SELECT id, business_name, subscription_tier, created_at FROM vendors`);
    res.json(subs.rows);
});

// Vendor detail
app.get('/api/admin/vendor/:id', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const vendor = await query(`SELECT v.*, (SELECT COUNT(*) FROM orders WHERE vendor_id = v.id) as total_orders, (SELECT COALESCE(SUM(total), 0) FROM orders WHERE vendor_id = v.id) as total_revenue FROM vendors v WHERE v.id = $1`, [req.params.id]);
    res.json(vendor.rows[0]);
});
