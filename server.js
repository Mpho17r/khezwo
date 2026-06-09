const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const qrcode = require('qrcode');
const db = require('./database');

const app = express();
const PORT = 3000;

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
    secret: 'khezwo-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/vendor/signup', async (req, res) => {
    const { business_name, owner_name, email, phone, password } = req.body;
    
    if (!business_name || !owner_name || !email || !phone || !password) {
        return res.status(400).json({ error: 'All fields required' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        db.run(`INSERT INTO vendors (business_name, owner_name, email, phone, password, created_at) 
                VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            [business_name, owner_name, email, phone, hashedPassword],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Email already registered' });
                    }
                    return res.status(500).json({ error: err.message });
                }
                
                const qrUrl = `http://localhost:${PORT}/menu/${this.lastID}`;
                qrcode.toFile(`./uploads/qr_${this.lastID}.png`, qrUrl, () => {});
                
                res.json({ success: true, vendor_id: this.lastID });
            });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/vendor/login', (req, res) => {
    const { email, password } = req.body;
    
    db.get(`SELECT * FROM vendors WHERE email = ?`, [email], async (err, vendor) => {
        if (err || !vendor) return res.status(400).json({ error: 'Invalid credentials' });
        
        const valid = await bcrypt.compare(password, vendor.password);
        if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
        
        req.session.vendor = vendor;
        res.json({ success: true, redirect: '/vendor-dashboard.html' });
    });
});

app.get('/vendor/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/api/vendor/data', (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    
    db.get(`SELECT * FROM vendors WHERE id = ?`, [vendorId], (err, vendor) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all(`SELECT * FROM menu_items WHERE vendor_id = ? ORDER BY id DESC`, [vendorId], (err, items) => {
            if (err) return res.status(500).json({ error: err.message });
            
            db.all(`SELECT * FROM orders WHERE vendor_id = ? AND status != 'completed' ORDER BY created_at DESC`, [vendorId], (err, orders) => {
                if (err) return res.status(500).json({ error: err.message });
                
                res.json({ vendor, menu_items: items || [], orders: orders || [] });
            });
        });
    });
});

app.post('/api/vendor/add-menu-item', upload.single('photo'), (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { name, price, description, ingredients } = req.body;
    const photoUrl = req.file ? `/uploads/${req.file.filename}` : null;
    
    db.run(`INSERT INTO menu_items (vendor_id, name, price, description, ingredients, photo_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [req.session.vendor.id, name, price, description, ingredients, photoUrl],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

app.post('/api/vendor/toggle-availability', (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { item_id, is_available } = req.body;
    
    db.run(`UPDATE menu_items SET is_available = ? WHERE id = ? AND vendor_id = ?`,
        [is_available, item_id, req.session.vendor.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

app.post('/api/vendor/update-profile', upload.single('logo'), (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { business_name, owner_name, phone, address, is_open, closed_message } = req.body;
    const logoUrl = req.file ? `/uploads/${req.file.filename}` : null;
    
    let query = `UPDATE vendors SET business_name = ?, owner_name = ?, phone = ?, address = ?, is_open = ?, closed_message = ?`;
    let params = [business_name, owner_name, phone, address, is_open || 1, closed_message || null];
    
    if (logoUrl) {
        query += `, logo_url = ?`;
        params.push(logoUrl);
    }
    query += ` WHERE id = ?`;
    params.push(req.session.vendor.id);
    
    db.run(query, params, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.get(`SELECT * FROM vendors WHERE id = ?`, [req.session.vendor.id], (err, vendor) => {
            req.session.vendor = vendor;
            res.json({ success: true });
        });
    });
});

app.post('/api/vendor/update-order-status', (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { order_id, status } = req.body;
    
    db.run(`UPDATE orders SET status = ? WHERE id = ? AND vendor_id = ?`,
        [status, order_id, req.session.vendor.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get(`SELECT * FROM admin_users WHERE username = ?`, [username], async (err, admin) => {
        if (err || !admin) return res.status(400).json({ error: 'Invalid credentials' });
        
        const valid = await bcrypt.compare(password, admin.password);
        if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
        
        req.session.admin = admin;
        res.json({ success: true, redirect: '/admin-dashboard.html' });
    });
});

app.get('/api/admin/vendors', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    db.all(`SELECT v.*, (SELECT COUNT(*) FROM orders WHERE vendor_id = v.id) as total_orders 
            FROM vendors v ORDER BY v.created_at DESC`, [], (err, vendors) => {
        res.json(vendors || []);
    });
});

app.post('/api/admin/toggle-vendor', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { vendor_id, is_suspended } = req.body;
    
    db.run(`UPDATE vendors SET is_suspended = ? WHERE id = ?`,
        [is_suspended ? 1 : 0, vendor_id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

app.get('/api/admin/orders', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    db.all(`SELECT o.*, v.business_name as vendor_name 
            FROM orders o JOIN vendors v ON o.vendor_id = v.id 
            ORDER BY o.created_at DESC LIMIT 100`, [], (err, orders) => {
        res.json(orders || []);
    });
});

app.get('/api/admin/stats', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    db.get(`SELECT 
            (SELECT COUNT(*) FROM vendors) as total_vendors,
            (SELECT COUNT(*) FROM vendors WHERE is_suspended = 0) as active_vendors,
            (SELECT COUNT(*) FROM orders) as total_orders,
            (SELECT COUNT(*) FROM orders WHERE payment_method = 'card') as card_orders,
            (SELECT COUNT(*) FROM orders WHERE payment_method = 'cash') as cash_orders`,
        [], (err, stats) => {
            res.json(stats || { total_vendors: 0, active_vendors: 0, total_orders: 0, card_orders: 0, cash_orders: 0 });
        });
});

app.get('/menu/:vendorId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer-menu.html'));
});

app.get('/api/menu/:vendorId', (req, res) => {
    const vendorId = req.params.vendorId;
    
    db.get(`SELECT * FROM vendors WHERE id = ?`, [vendorId], (err, vendor) => {
        if (err || !vendor) return res.status(404).json({ error: 'Vendor not found' });
        
        db.all(`SELECT * FROM menu_items WHERE vendor_id = ? AND is_available = 1 ORDER BY id DESC`, [vendorId], (err, items) => {
            res.json({
                vendor: {
                    id: vendor.id,
                    business_name: vendor.business_name,
                    logo_url: vendor.logo_url,
                    is_open: vendor.is_open,
                    closed_message: vendor.closed_message
                },
                menu_items: items || []
            });
        });
    });
});

app.post('/api/place-order', (req, res) => {
    const { vendor_id, customer_name, customer_phone, items, total, payment_method } = req.body;
    
    const orderNumber = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    
    db.run(`INSERT INTO orders (vendor_id, order_number, customer_name, customer_phone, items_json, total, payment_method, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [vendor_id, orderNumber, customer_name, customer_phone, JSON.stringify(items), total, payment_method],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, order_number: orderNumber });
        });
});

app.listen(PORT, () => {
    console.log(`\n✅ KheZwo is running!`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`\n📋 Admin: username "khezwo_admin" | password "khezwo123"`);
    console.log(`🎉 Ready to go!\n`);
});
