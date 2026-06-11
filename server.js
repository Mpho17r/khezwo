const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const qrcode = require('qrcode');
const { Pool } = require('pg');

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
app.use(session({
    secret: process.env.SESSION_SECRET || 'khezwo-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
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
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', CURRENT_TIMESTAMP)
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

app.post('/vendor/login', async (req, res) => {
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

// ============= VENDOR DASHBOARD DATA (WITH BRANCHES) =============

app.get('/api/vendor/data', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    
    try {
        const vendorResult = await query(`SELECT * FROM vendors WHERE id = $1`, [vendorId]);
        const itemsResult = await query(`SELECT * FROM menu_items WHERE vendor_id = $1 ORDER BY id DESC`, [vendorId]);
        const ordersResult = await query(`SELECT * FROM orders WHERE vendor_id = $1 AND status = 'pending' ORDER BY created_at DESC`, [vendorId]);
        
        // Get branches if this is headquarters
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

// ============= BRANCH MANAGEMENT API =============

app.get('/api/vendor/branches', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    try {
        const branches = await query(`
            SELECT v.*, 
                (SELECT COUNT(*) FROM orders WHERE vendor_id = v.id) as total_orders,
                (SELECT COALESCE(SUM(total), 0) FROM orders WHERE vendor_id = v.id) as total_sales,
                (SELECT COUNT(*) FROM menu_items WHERE vendor_id = v.id) as menu_items
            FROM vendors v 
            WHERE v.parent_id = $1
        `, [req.session.vendor.id]);
        
        res.json(branches.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/vendor/add-branch', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorCheck = await query(`SELECT is_headquarters FROM vendors WHERE id = $1`, [req.session.vendor.id]);
    if (!vendorCheck.rows[0]?.is_headquarters) {
        return res.status(403).json({ error: 'Only headquarters can add branches' });
    }
    
    const { business_name, address, phone, is_open } = req.body;
    
    if (!business_name) {
        return res.status(400).json({ error: 'Branch name required' });
    }
    
    try {
        const tempEmail = `branch_${Date.now()}@temp.com`;
        const tempPassword = await bcrypt.hash('temporary', 10);
        
        const result = await query(
            `INSERT INTO vendors (business_name, owner_name, email, phone, password, parent_id, is_open, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP) RETURNING id`,
            [business_name, req.session.vendor.owner_name, tempEmail, phone || '', tempPassword, req.session.vendor.id, is_open || 1]
        );
        
        const baseUrl = getBaseUrl();
        const qrUrl = `${baseUrl}/menu/${result.rows[0].id}`;
        qrcode.toFile(`./uploads/qr_${result.rows[0].id}.png`, qrUrl, () => {});
        
        await query(
            `INSERT INTO audit_logs (vendor_id, action, details) VALUES ($1, 'add_branch', $2)`,
            [req.session.vendor.id, JSON.stringify({ branch_name: business_name, branch_id: result.rows[0].id })]
        );
        
        res.json({ success: true, branch_id: result.rows[0].id });
    } catch (err) {
        console.error('Add branch error:', err);
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
        console.error('Update profile error:', err);
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

app.post('/api/vendor/update-order-status', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { order_id, status } = req.body;
    
    try {
        await query(
            `UPDATE orders SET status = $1 WHERE id = $2 AND vendor_id = $3`,
            [status, order_id, req.session.vendor.id]
        );
        
        await query(
            `INSERT INTO order_tracking (order_id, status) VALUES ($1, $2)`,
            [order_id, status]
        );
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============= ORDER TRACKING =============

app.get('/api/order-tracking/:orderId', async (req, res) => {
    const orderId = req.params.orderId;
    
    try {
        const tracking = await query(
            `SELECT status, estimated_time, updated_at FROM order_tracking WHERE order_id = $1 ORDER BY updated_at DESC`,
            [orderId]
        );
        res.json(tracking.rows || []);
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

// ============= VENDOR ANALYTICS =============

app.get('/api/vendor/analytics', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    const { period } = req.query;
    
    let startDate;
    const now = new Date();
    
    switch(period) {
        case 'day':
            startDate = new Date(now.setHours(0, 0, 0, 0));
            break;
        case 'week':
            startDate = new Date(now);
            startDate.setDate(now.getDate() - 7);
            break;
        case 'month':
        default:
            startDate = new Date(now);
            startDate.setDate(now.getDate() - 30);
            break;
    }
    
    try {
        const ordersResult = await query(`
            SELECT * FROM orders 
            WHERE vendor_id = $1 
            AND created_at >= $2
            ORDER BY created_at ASC
        `, [vendorId, startDate]);
        
        const orders = ordersResult.rows;
        
        if (orders.length === 0) {
            return res.json({
                total_sales: 0,
                total_orders: 0,
                avg_order_value: 0,
                total_items_sold: 0,
                platform_fees: 0,
                top_items: [],
                slow_moving_items: [],
                daily_sales: [],
                sales_by_hour: []
            });
        }
        
        let totalSales = 0;
        let totalPlatformFees = 0;
        let totalItemsSold = 0;
        const itemCounts = {};
        const hourCounts = {};
        
        for (const order of orders) {
            totalSales += parseFloat(order.total);
            totalPlatformFees += parseFloat(order.platform_fee || 0);
            
            const hour = new Date(order.created_at).getHours();
            hourCounts[hour] = (hourCounts[hour] || 0) + 1;
            
            let items;
            try {
                items = typeof order.items_json === 'string' ? JSON.parse(order.items_json) : order.items_json;
            } catch(e) {
                continue;
            }
            
            if (Array.isArray(items)) {
                for (const item of items) {
                    const quantity = parseInt(item.quantity) || 1;
                    totalItemsSold += quantity;
                    
                    const itemName = item.name;
                    if (!itemCounts[itemName]) {
                        itemCounts[itemName] = { count: 0, revenue: 0 };
                    }
                    itemCounts[itemName].count += quantity;
                    itemCounts[itemName].revenue += (parseFloat(item.price) || 0) * quantity;
                }
            }
        }
        
        const topItems = Object.entries(itemCounts)
            .map(([name, data]) => ({ name, count: data.count, revenue: data.revenue }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
        
        const slowMovingItems = Object.entries(itemCounts)
            .map(([name, data]) => ({ name, count: data.count, revenue: data.revenue }))
            .sort((a, b) => a.count - b.count)
            .slice(0, 5);
        
        const salesByHour = Object.entries(hourCounts).map(([hour, count]) => ({ hour: parseInt(hour), orders: count }));
        
        const dailyMap = {};
        for (const order of orders) {
            const dateKey = new Date(order.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            if (!dailyMap[dateKey]) {
                dailyMap[dateKey] = 0;
            }
            dailyMap[dateKey] += parseFloat(order.total);
        }
        
        const dailySales = Object.entries(dailyMap).map(([date, total]) => ({ date, total }));
        
        res.json({
            total_sales: totalSales,
            total_orders: orders.length,
            avg_order_value: orders.length > 0 ? totalSales / orders.length : 0,
            total_items_sold: totalItemsSold,
            platform_fees: totalPlatformFees,
            top_items: topItems,
            slow_moving_items: slowMovingItems,
            daily_sales: dailySales,
            sales_by_hour: salesByHour
        });
        
    } catch (err) {
        console.error('Analytics error:', err);
        res.json({
            total_sales: 0,
            total_orders: 0,
            avg_order_value: 0,
            total_items_sold: 0,
            platform_fees: 0,
            top_items: [],
            slow_moving_items: [],
            daily_sales: [],
            sales_by_hour: []
        });
    }
});

// ============= ADMIN ROUTES =============

app.post('/admin/login', async (req, res) => {
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

// ============= AD MANAGEMENT ROUTES =============

app.get('/api/admin/sponsor-ads', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const result = await query(`SELECT * FROM sponsor_ads ORDER BY id DESC`);
    res.json(result.rows || []);
});

app.post('/api/admin/add-sponsor', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { name, link } = req.body;
    
    await query(`INSERT INTO sponsor_ads (name, link) VALUES ($1, $2)`, [name, link]);
    res.json({ success: true });
});

app.delete('/api/admin/delete-sponsor/:id', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { id } = req.params;
    
    await query(`DELETE FROM sponsor_ads WHERE id = $1`, [id]);
    res.json({ success: true });
});

app.get('/api/admin/ad-settings', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const result = await query(`SELECT * FROM ad_settings LIMIT 1`);
    res.json(result.rows[0] || {});
});

app.post('/api/admin/ad-settings', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { adsense_client, top_slot, middle_slot } = req.body;
    
    await query(`
        INSERT INTO ad_settings (id, adsense_client, top_slot, middle_slot, updated_at) 
        VALUES (1, $1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET 
            adsense_client = EXCLUDED.adsense_client,
            top_slot = EXCLUDED.top_slot,
            middle_slot = EXCLUDED.middle_slot,
            updated_at = CURRENT_TIMESTAMP
    `, [adsense_client, top_slot, middle_slot]);
    res.json({ success: true });
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

app.get('/api/debug-qr-url', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    const vendorId = req.session.vendor.id;
    const baseUrl = getBaseUrl();
    res.json({ 
        vendor_id: vendorId, 
        qr_url: `${baseUrl}/menu/${vendorId}`,
        base_url: baseUrl
    });
});

// ============= SETUP TABLES ENDPOINT =============
app.get('/api/setup-tables', async (req, res) => {
    try {
        let details = '';
        
        await query(`CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            vendor_id INTEGER REFERENCES vendors(id),
            action TEXT NOT NULL,
            details TEXT,
            ip_address TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        details += '✓ audit_logs table created\n';
        
        await query(`CREATE TABLE IF NOT EXISTS order_tracking (
            id SERIAL PRIMARY KEY,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            status TEXT DEFAULT 'received',
            estimated_time INTEGER,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        details += '✓ order_tracking table created\n';
        
        await query(`CREATE TABLE IF NOT EXISTS business_types (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            icon TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        details += '✓ business_types table created\n';
        
        await query(`INSERT INTO business_types (name, icon) VALUES
            ('restaurant', '🍽️'),
            ('clothing', '👕'),
            ('farming', '🌾'),
            ('retail', '🛍️'),
            ('services', '🔧')
            ON CONFLICT (name) DO NOTHING`);
        details += '✓ business types inserted\n';
        
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
        details += '✓ subscription_plans table created\n';
        
        await query(`INSERT INTO subscription_plans (name, tier, price, max_items, max_branches, has_analytics, has_custom_branding, has_priority_support) VALUES
            ('Free', 'free', 0, 20, 1, FALSE, FALSE, FALSE),
            ('Pro', 'pro', 299, NULL, 1, TRUE, TRUE, FALSE),
            ('Enterprise', 'enterprise', 999, NULL, 10, TRUE, TRUE, TRUE)
            ON CONFLICT (tier) DO NOTHING`);
        details += '✓ subscription plans inserted\n';
        
        res.json({ success: true, message: 'All tables created successfully!', details: details });
    } catch (err) {
        console.error('Setup error:', err);
        res.json({ success: false, error: err.message });
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