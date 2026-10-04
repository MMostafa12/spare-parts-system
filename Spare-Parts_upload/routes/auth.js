'use strict';
var express = require('express');
var router = express.Router();
var path = require('path');
var bcrypt = require('bcryptjs');
var db = require('../config/db');
var sql = db.sql;
var poolPromise = db.poolPromise;

var SALT_ROUNDS = 10;

// =============================================
// Helper: Normalize branch — always returns 'Alex' or 'Cairo'
// =============================================
function normalizeBranch(rawBranch) {
    if (!rawBranch) return 'Cairo';
    var cleaned = String(rawBranch).trim().toLowerCase();
    return (cleaned === 'alex' || cleaned === 'alexandria') ? 'Alex' : 'Cairo';
}

// =============================================
// Helper: role → dashboard redirect map
// =============================================
function getRedirectUrl(role, branch) {
    var isAlex = normalizeBranch(branch) === 'Alex';
    var redirectMap = {
        'requester': isAlex ? '/dashboard-alex.html' : '/dashboard',
        'service': '/approve.service.html',
        'manager': '/approve-manager.html',
        'finance': '/approve-finance.html',
        'warehouse': '/approve-warehouse.html',
        'ctmanager': '/department-manager.html',
        'mrimanager': '/department-manager.html',
        'xraymanager': '/department-manager.html',
        'angiomanager': '/department-manager.html',
        'konicamanager': '/department-manager.html',
        'salesmanager': '/department-manager.html',
        'usmanager': '/department-manager.html',
        'projectsmanager': '/department-manager.html'
    };
    return redirectMap[role] || '/dashboard';
}

// =============================================
// ROOT / LOGIN PAGE
// =============================================
router.get('/', function(req, res) {
    if (req.session.user) {
        var role = req.session.user.role;
        var branch = normalizeBranch(req.session.user.branch);
        var url = getRedirectUrl(role, branch);
        console.log('Root redirect - role:', role, '| branch:', branch, '| ->', url);
        return res.redirect(url);
    }
    res.sendFile(path.join(__dirname, '../public/Login.html'));
});

// =============================================
// LOGIN
// =============================================
router.post('/login', function(req, res) {
    var email = req.body.email;
    var password = req.body.password;
    console.log('Login attempt:', email);

    if (!email || !password) {
        return res.send('<h2>Please enter both email and password</h2><a href="/">Back</a>');
    }

    poolPromise.then(function(pool) {
        return pool.request()
            .input('email', sql.NVarChar, email)
            .query('SELECT id, name, email, password, role, department, branch FROM Users WHERE email = @email');
    }).then(function(result) {
        if (!result.recordset || result.recordset.length === 0) {
            console.log('User not found:', email);
            return res.send('<h2>User not found</h2><a href="/">Back</a>');
        }

        var user = result.recordset[0];
        console.log('User found:', user.email);
        console.log('   Role:', user.role);
        console.log('   Department:', user.department || 'N/A');
        console.log('   Branch from DB (raw):', JSON.stringify(user.branch));

        var passwordMatch = false;

        if (user.password && user.password.startsWith('$2')) {
            passwordMatch = bcrypt.compareSync(password, user.password);
        } else {
            passwordMatch = String(password).trim() === String(user.password).trim();
            if (passwordMatch) {
                var hashedPassword = bcrypt.hashSync(password, SALT_ROUNDS);
                poolPromise.then(function(pool2) {
                    return pool2.request()
                        .input('id', sql.Int, user.id)
                        .input('password', sql.NVarChar(255), hashedPassword)
                        .query('UPDATE Users SET password = @password WHERE id = @id');
                }).catch(function(err) {
                    console.error('Failed to upgrade password:', err);
                });
            }
        }

        if (!passwordMatch) {
            console.log('Wrong password for:', email);
            return res.send('<h2>Wrong password</h2><a href="/">Back</a>');
        }

        var normalizedBranch = normalizeBranch(user.branch);
        console.log('   Branch normalized:', normalizedBranch);

        req.session.user = {
            id: user.id,
            name: user.name || 'User',
            email: user.email,
            role: user.role,
            department: user.department || '',
            branch: normalizedBranch
        };

        req.session.language = 'en';

        console.log('Login successful - Role:', user.role, '| Branch (normalized):', normalizedBranch);

        req.session.save(function(err) {
            if (err) {
                console.log('Session save error:', err);
                return res.send('<h2>Session error</h2><a href="/">Back</a>');
            }

            var redirectUrl = getRedirectUrl(user.role, normalizedBranch);
            console.log('Redirecting to:', redirectUrl);

            return res.redirect(redirectUrl);
        });

    }).catch(function(err) {
        console.log('LOGIN ERROR:', err);
        res.send('<h2>Login Error</h2><pre>' + err.message + '</pre>');
    });
});

// =============================================
// GET CURRENT USER
// =============================================
router.get('/api/user', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not logged in' });
    }
    res.json({
        id: req.session.user.id,
        name: req.session.user.name,
        email: req.session.user.email,
        role: req.session.user.role,
        department: req.session.user.department || '',
        branch: req.session.user.branch || 'Cairo'
    });
});

// =============================================
// LANGUAGE HANDLING
// =============================================
router.get('/api/language', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not logged in' });
    }
    var language = req.session.language || 'en';
    res.json({ language: language });
});

router.post('/api/language', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not logged in' });
    }

    var language = req.body.language || 'en';
    if (language !== 'en' && language !== 'ar') {
        language = 'en';
    }

    req.session.language = language;
    req.session.save(function(err) {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, language: language });
    });
});

// =============================================
// DASHBOARD (Cairo only - Alex users use dashboard-alex.html)
// =============================================
router.get('/dashboard', function(req, res) {
    if (!req.session.user) return res.redirect('/');
    if (req.session.user.role !== 'requester') return res.redirect('/');

    var branch = normalizeBranch(req.session.user.branch);
    if (branch === 'Alex') {
        console.log('Alex requester tried /dashboard - redirecting to /dashboard-alex.html');
        return res.redirect('/dashboard-alex.html');
    }

    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// =============================================
// LOGOUT
// =============================================
router.get('/logout', function(req, res) {
    req.session.destroy(function(err) {
        if (err) console.error('Logout error:', err);
        res.redirect('/');
    });
});

// =============================================
// SIGNUP DISABLED
// =============================================
router.get('/signup', function(req, res) {
    res.status(403).send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Not Available</title>
        <style>
            body{font-family:Arial;background:#f4f6f9;padding:40px;text-align:center;margin:0;}
            .box{max-width:500px;margin:60px auto;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 15px rgba(0,0,0,0.1);}
            h2{color:#8b1a1a;margin-top:0;} p{color:#555;font-size:15px;}
            a{display:inline-block;margin-top:20px;padding:12px 28px;background:#1a3a5c;color:white;text-decoration:none;border-radius:6px;font-weight:bold;}
            a:hover{background:#0f2a44;}
        </style>
        </head><body>
        <div class="box">
            <h2>Sign Up Disabled</h2>
            <p>Account creation is not available. Please contact the system administrator.</p>
            <a href="/">Back to Login</a>
        </div>
        </body></html>
    `);
});

router.post('/signup', function(req, res) {
    res.status(403).json({ success: false, error: 'Sign up is disabled. Contact the administrator.' });
});

// =============================================
// CHANGE PASSWORD
// =============================================
router.get('/change-password', function(req, res) {
    if (!req.session.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, '../public/change-password.html'));
});

router.post('/change-password', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not logged in' });
    }

    var currentPassword = req.body.current_password;
    var newPassword = req.body.new_password;
    var confirmPassword = req.body.confirm_password;
    var userId = req.session.user.id;
    var pool;

    if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New passwords do not match.' });
    }

    poolPromise.then(function(p) {
        pool = p;
        return pool.request()
            .input('id', sql.Int, userId)
            .query('SELECT password FROM Users WHERE id = @id');
    }).then(function(result) {
        if (!result.recordset || result.recordset.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        var user = result.recordset[0];
        var passwordMatch = false;

        if (user.password && user.password.startsWith('$2')) {
            passwordMatch = bcrypt.compareSync(currentPassword, user.password);
        } else {
            passwordMatch = String(currentPassword).trim() === String(user.password).trim();
        }

        if (!passwordMatch) {
            return res.status(400).json({ error: 'Current password is incorrect.' });
        }

        var hashedPassword = bcrypt.hashSync(newPassword, SALT_ROUNDS);

        return pool.request()
            .input('id', sql.Int, userId)
            .input('password', sql.NVarChar(255), hashedPassword)
            .query('UPDATE Users SET password = @password WHERE id = @id');
    }).then(function() {
        res.json({ success: true, message: 'Password changed successfully!' });
    }).catch(function(err) {
        console.error('Change password error:', err);
        res.status(500).json({ error: 'An error occurred. Please try again.' });
    });
});

module.exports = router;