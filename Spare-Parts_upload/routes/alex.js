'use strict';
var express = require('express');
var router = express.Router();
var db = require('../config/db');
var sql = db.sql;
var poolPromise = db.poolPromise;
var { sendMail } = require('../config/mail');
var emailTemplates = require('../config/emailTemplates');

function validSignature(sig) {
    if (!sig || sig.trim() === '') return false;
    return /^[a-zA-Z\u0600-\u06FF\s]+$/.test(sig.trim());
}

// ========== GET ALL REQUESTS FOR ALEX ==========
router.get('/all', function(req, res) {
    if (!req.session.user || req.session.user.role !== 'alex_confirmer') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    poolPromise.then(function(pool) {
        return pool.request().query(`
            SELECT r.*, u.name as requester_name
            FROM Requests r
            LEFT JOIN Users u ON r.requester_id = u.id
            WHERE r.branch = 'Alex'
            ORDER BY r.created_at DESC
        `);
    }).then(function(result) {
        res.json(result.recordset);
    }).catch(function(err) {
        console.error('❌ Error loading Alex requests:', err);
        res.status(500).json({ error: err.message });
    });
});

// ========== GET SINGLE REQUEST DETAILS ==========
router.get('/details/:id', function(req, res) {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    var pool;
    var requestData;
    poolPromise.then(function(p) {
        pool = p;
        return pool.request()
            .input('id', sql.Int, req.params.id)
            .query('SELECT r.*, u.name as requester_name FROM Requests r LEFT JOIN Users u ON r.requester_id = u.id WHERE r.id = @id');
    }).then(function(r) {
        if (!r.recordset[0]) return res.status(404).json({ error: 'Not found' });
        requestData = r.recordset[0];
        return pool.request()
            .input('id', sql.Int, req.params.id)
            .query('SELECT * FROM RequestItems WHERE request_id = @id ORDER BY line_number');
    }).then(function(items) {
        res.json({ request: requestData, items: items.recordset });
    }).catch(function(err) {
        console.error('❌ Details error:', err);
        res.status(500).json({ error: err.message });
    });
});

// ========== CONFIRM ALEX REQUEST ==========
router.post('/confirm/:id', function(req, res) {
    if (!req.session.user || req.session.user.role !== 'alex_confirmer') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    var signature = req.body.signature || '';
    var requestId = req.params.id;
    var pool;

    if (!validSignature(signature)) {
        return res.status(400).json({ error: 'Invalid signature.' });
    }

    poolPromise.then(function(p) {
        pool = p;
        return pool.request()
            .input('id', sql.Int, requestId)
            .query('SELECT id, status, branch FROM Requests WHERE id = @id');
    }).then(function(result) {
        var req = result.recordset[0];
        if (!req) {
            return res.status(404).json({ error: 'Request not found.' });
        }
        if (req.status !== 'Pending Alex Confirmation') {
            return res.status(400).json({ error: 'Request is not pending Alex confirmation.' });
        }
        if (req.branch !== 'Alex') {
            return res.status(400).json({ error: 'This request does not require Alex confirmation.' });
        }

        return pool.request()
            .input('id', sql.Int, requestId)
            .input('signature', sql.NVarChar, signature)
            .query(`
                UPDATE Requests SET
                    status = 'Pending Service',
                    alex_confirmed = 1,
                    alex_confirmed_by = @signature,
                    alex_confirmed_date = GETDATE()
                WHERE id = @id
            `);
    }).then(function() {
        sendAlexConfirmationEmail(pool, requestId, signature);
        res.json({ success: true, message: 'Request confirmed and sent to Service.' });
    }).catch(function(err) {
        console.error('❌ Alex confirm error:', err);
        res.status(500).json({ error: err.message });
    });
});

// ========== REJECT ALEX REQUEST ==========
router.post('/reject/:id', function(req, res) {
    if (!req.session.user || req.session.user.role !== 'alex_confirmer') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    var reason = req.body.reason || '';
    var signature = req.body.signature || '';
    var requestId = req.params.id;
    var pool;

    if (!reason.trim()) {
        return res.status(400).json({ error: 'Rejection reason required.' });
    }
    if (!validSignature(signature)) {
        return res.status(400).json({ error: 'Invalid signature.' });
    }

    poolPromise.then(function(p) {
        pool = p;
        return pool.request()
            .input('id', sql.Int, requestId)
            .query('SELECT id, status, branch FROM Requests WHERE id = @id');
    }).then(function(result) {
        var req = result.recordset[0];
        if (!req) {
            return res.status(404).json({ error: 'Request not found.' });
        }
        if (req.status !== 'Pending Alex Confirmation') {
            return res.status(400).json({ error: 'Request is not pending Alex confirmation.' });
        }

        return pool.request()
            .input('id', sql.Int, requestId)
            .input('reason', sql.NVarChar, reason.trim())
            .input('signature', sql.NVarChar, signature.trim())
            .query(`
                UPDATE Requests SET
                    status = 'Rejected by Alex',
                    alex_rejection_reason = @reason,
                    alex_rejection_signature = @signature,
                    alex_rejection_date = GETDATE()
                WHERE id = @id
            `);
    }).then(function() {
        sendAlexRejectionEmail(pool, requestId, reason, signature);
        res.json({ success: true, message: 'Request rejected.' });
    }).catch(function(err) {
        console.error('❌ Alex reject error:', err);
        res.status(500).json({ error: err.message });
    });
});

// ========== HELPER: SEND CONFIRMATION EMAIL ==========
function sendAlexConfirmationEmail(pool, requestId, signature) {
    emailTemplates.loadRequestWithItems(pool, requestId)
        .then(function (data) {
            if (!data.req) return;
            var req = data.req;

            return pool.request()
                .query("SELECT email FROM Users WHERE role IN ('service', 'manager') AND email IS NOT NULL AND email != ''")
                .then(function (userResult) {
                    var emails = userResult.recordset
                        .map(function (u) { return u.email; })
                        .filter(function (e) { return e && e.trim() !== ''; });

                    if (emails.length === 0) {
                        console.log('⚠️ No recipients for Alex confirmation email');
                        return;
                    }

                    var subject = '✅ Request #' + requestId + ' - Confirmed by Alex Branch';
                    var html = emailTemplates.buildRequestEmail({
                        req: req,
                        items: data.items,
                        title: '✅ Request Confirmed by Alex Branch',
                        statusColor: '#1e6b3c',
                        statusText: 'Pending Service',
                        actionText: '✅ Confirmed by Alex Branch — Sent to Service',
                        roleText: 'Alex Branch',
                        signature: signature
                    });

                    sendMail(emails.join(', '), subject, html)
                        .then(function () {
                            console.log('✅ Alex confirmation email sent to:', emails.length, 'recipients');
                        })
                        .catch(function (err) {
                            console.error('❌ Failed to send Alex confirmation email:', err.message);
                        });
                });
        })
        .catch(function (err) {
            console.error('❌ Error sending Alex confirmation email:', err);
        });
}

// ========== HELPER: SEND REJECTION EMAIL ==========
function sendAlexRejectionEmail(pool, requestId, reason, signature) {
    emailTemplates.loadRequestWithItems(pool, requestId)
        .then(function (data) {
            if (!data.req) return;
            var req = data.req;

            return pool.request()
                .input('requester_id', sql.Int, req.requester_id)
                .query('SELECT name, email FROM Users WHERE id = @requester_id')
                .then(function (userResult) {
                    var user = userResult.recordset[0];
                    if (!user || !user.email) return;

                    var subject = '❌ Request #' + requestId + ' - Rejected by Alex Branch';
                    var html = emailTemplates.buildRequestEmail({
                        req: req,
                        items: data.items,
                        title: '❌ Request Rejected by Alex Branch',
                        statusColor: '#8b1a1a',
                        statusText: 'Rejected by Alex',
                        actionText: '❌ Rejected by Alex Branch',
                        roleText: 'Alex Branch',
                        signature: signature,
                        reason: reason
                    });

                    sendMail(user.email, subject, html)
                        .then(function () {
                            console.log('✅ Alex rejection email sent to requester:', user.email);
                        })
                        .catch(function (err) {
                            console.error('❌ Failed to send Alex rejection email:', err.message);
                        });
                });
        })
        .catch(function (err) {
            console.error('❌ Error sending Alex rejection email:', err);
        });
}

module.exports = router;