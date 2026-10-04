'use strict';
var express = require('express');
var router = express.Router();
var db = require('../config/db');
var sql = db.sql;
var poolPromise = db.poolPromise;
var poolPromiseMIERP = db.poolPromiseMIERP;
var { sendMail } = require('../config/mail');
var emailTemplates = require('../config/emailTemplates');

function validSignature(sig) {
    if (!sig || sig.trim() === '') return false;
    return /^[a-zA-Z\u0600-\u06FF\s]+$/.test(sig.trim());
}

// ============================================
// HELPER: Force Arabic organization name from MIERP2
// ============================================
function forceArabicOrganization(body) {
    var code = body.organization_code;
    if (!code || !poolPromiseMIERP) {
        return Promise.resolve(body);
    }
    return poolPromiseMIERP.then(function(mierpPool) {
        if (!mierpPool) return body;
        return mierpPool.request()
            .input('code', sql.NVarChar, code)
            .query('SELECT TOP 1 Contact_FullNameA FROM dbo.Contacts WHERE Contact_Code = @code')
            .then(function(result) {
                var row = result.recordset[0];
                if (row && row.Contact_FullNameA) {
                    var arabicName = String(row.Contact_FullNameA).trim();
                    if (arabicName) {
                        body.organization_name = arabicName;
                        body.customer_name = arabicName;
                    }
                }
                return body;
            });
    }).catch(function(err) {
        console.error('Arabic name lookup failed:', err.message);
        return body;
    });
}

function getUsersByRole(pool, roles) {
    var roleList = roles.map(function(r) { return "'" + r + "'"; }).join(', ');
    return pool.request()
        .query("SELECT name, email FROM Users WHERE role IN (" + roleList + ") AND email IS NOT NULL AND email != ''");
}

function getRequesterEmail(pool, requesterId) {
    return pool.request()
        .input('id', sql.Int, requesterId)
        .query('SELECT name, email FROM Users WHERE id = @id');
}

// ========== SEND NEW REQUEST EMAIL (rich template) ==========
function sendNewRequestEmail(pool, requestId, requesterEmail, requesterName, requestDate, customerName) {
    emailTemplates.loadRequestWithItems(pool, requestId)
        .then(function (data) {
            if (!data.req) return;
            var req = data.req;

            return getUsersByRole(pool, ['service'])
                .then(function (serviceUsers) {
                    var serviceEmails = serviceUsers.recordset
                        .map(function (u) { return u.email; })
                        .filter(function (e) { return e && e.trim() !== ''; });

                    return getUsersByRole(pool, ['manager'])
                        .then(function (managerUsers) {
                            var managerEmails = managerUsers.recordset
                                .map(function (u) { return u.email; })
                                .filter(function (e) { return e && e.trim() !== ''; });

                            var allRecipients = serviceEmails.concat(managerEmails);
                            if (allRecipients.length === 0) return;

                            var uniqueRecipients = allRecipients.filter(function (email, index) {
                                return allRecipients.indexOf(email) === index;
                            });

                            var subject = '📋 New Request #' + requestId + ' - Pending Service Approval';
                            var html = emailTemplates.buildRequestEmail({
                                req: req,
                                items: data.items,
                                title: '📋 New Spare Parts Request',
                                statusColor: '#1a3a5c',
                                statusText: 'Pending Service Approval',
                                actionText: '✅ New Request Submitted',
                                roleText: 'System'
                            });

                            sendMail(uniqueRecipients.join(', '), subject, html)
                                .catch(function (err) { console.error('❌ Email error:', err.message); });
                        });
                });
        })
        .catch(function (err) { console.error('❌ Email error:', err); });
}

// ============================================
// SEND RESUBMIT NOTIFICATION (rich template)
// - Cairo: Service + Manager
// - Alex:  Dept Manager (of that dept) + Manager
// - Both:  Confirmation email to requester
// ============================================
function sendResubmitNotification(pool, requestId, requesterName) {
    emailTemplates.loadRequestWithItems(pool, requestId)
        .then(function (data) {
            if (!data.req) return;
            var req = data.req;
            var isAlex = (req.branch === 'Alex');

            var recipientPromises = [];
            var emails = [];

            // 1. Manager — always
            recipientPromises.push(
                getUsersByRole(pool, ['manager']).then(function (r) {
                    r.recordset.forEach(function (u) {
                        if (u.email && u.email.trim() !== '') emails.push(u.email);
                    });
                })
            );

            // 2. Cairo → Service users, Alex → Dept Manager for that department
            if (isAlex) {
                if (req.department_name) {
                    recipientPromises.push(
                        pool.request()
                            .input('department', sql.NVarChar, req.department_name)
                            .query("SELECT email FROM Users WHERE role IN ('ctmanager','mrimanager','xraymanager','angiomanager','konicamanager','salesmanager','usmanager','projectsmanager') AND department = @department AND email IS NOT NULL AND email != ''")
                            .then(function (r) {
                                r.recordset.forEach(function (u) {
                                    if (u.email && u.email.trim() !== '') emails.push(u.email);
                                });
                            })
                    );
                }
            } else {
                recipientPromises.push(
                    getUsersByRole(pool, ['service']).then(function (r) {
                        r.recordset.forEach(function (u) {
                            if (u.email && u.email.trim() !== '') emails.push(u.email);
                        });
                    })
                );
            }

            return Promise.all(recipientPromises).then(function () {
                var unique = emails.filter(function (e, i) { return emails.indexOf(e) === i; });

                if (unique.length === 0) {
                    console.log('⚠️ No recipients for resubmit notification #' + requestId);
                    return;
                }

                var nextStep = isAlex ? 'Department Manager' : 'Service';
                var subject = '🔄 Request #' + requestId + ' - Resubmitted by ' + requesterName;
                var html = emailTemplates.buildRequestEmail({
                    req: req,
                    items: data.items,
                    title: '🔄 Request Resubmitted',
                    statusColor: '#c8a84b',
                    statusText: req.status || ('Pending ' + nextStep),
                    actionText: '🔄 Edited and Resubmitted by ' + requesterName,
                    roleText: 'Requester'
                });

                sendMail(unique.join(', '), subject, html)
                    .then(function () {
                        console.log('✅ Resubmit notification sent for #' + requestId + ' → ' + unique.length + ' recipients');
                    })
                    .catch(function (err) {
                        console.error('❌ Failed to send resubmit notification:', err.message);
                    });
            });
        })
        .catch(function (err) { console.error('❌ Error in sendResubmitNotification:', err); });
}

// ============================================
// SEND RESUBMIT CONFIRMATION TO REQUESTER
// ============================================
function sendResubmitConfirmation(pool, requestId, requesterEmail, requesterName) {
    emailTemplates.loadRequestWithItems(pool, requestId)
        .then(function (data) {
            if (!data.req || !requesterEmail) return;
            var req = data.req;
            var isAlex = (req.branch === 'Alex');
            var nextStep = isAlex ? 'Department Manager' : 'Service Department';

            var subject = '🔄 Your Request #' + requestId + ' has been resubmitted';
            var html = emailTemplates.buildRequestEmail({
                req: req,
                items: data.items,
                title: '🔄 Request Resubmitted',
                statusColor: '#c8a84b',
                statusText: req.status || ('Pending ' + nextStep),
                actionText: '🔄 Your request was resubmitted and sent to ' + nextStep,
                roleText: 'Requester',
                signature: requesterName
            });

            sendMail(requesterEmail, subject, html)
                .then(function () {
                    console.log('✅ Resubmit confirmation sent to requester:', requesterEmail);
                })
                .catch(function (err) {
                    console.error('❌ Failed to send resubmit confirmation:', err.message);
                });
        })
        .catch(function (err) { console.error('❌ Error in sendResubmitConfirmation:', err); });
}

router.get('/new', function(req, res) {
    if (!req.session.user) return res.redirect('/');
    res.redirect('/new-request.html');
});

router.get('/user/department', function(req, res) {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    poolPromise.then(function(pool) {
        return pool.request().input('id', sql.Int, req.session.user.id)
            .query('SELECT department FROM Users WHERE id = @id');
    }).then(function(result) {
        res.json({ department: result.recordset[0] ? result.recordset[0].department || '' : '' });
    }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

// ========== CONTACTS SEARCH (MIERP2) ==========
router.get('/contacts/search', function(req, res) {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });

    var term = req.query.term || '';

    var accountTypeRaw = req.query.account_type;
    var accountType;
    if (accountTypeRaw === 'all') {
        accountType = null;
    } else if (accountTypeRaw === undefined || accountTypeRaw === null || accountTypeRaw === '') {
        accountType = 2;
    } else {
        accountType = parseInt(accountTypeRaw, 10);
        if (isNaN(accountType)) accountType = 2;
    }

    if (!poolPromiseMIERP) return res.status(503).json({ error: 'MIERP2 not available' });

    poolPromiseMIERP.then(function(pool) {
        if (!pool) return res.status(503).json({ error: 'MIERP2 not available' });

        var request = pool.request()
            .input('term', sql.NVarChar, '%' + term + '%');

        var whereClause =
            '(' +
            ' Contact_FullName  LIKE @term' +
            ' OR Contact_FullNameA LIKE @term' +
            ' OR CAST(Contact_Code AS NVARCHAR) LIKE @term' +
            ')';

        if (accountType !== null) {
            request.input('accountType', sql.Int, accountType);
            whereClause += ' AND AccountType = @accountType';
        }

        var query =
            'SELECT Contact_Code, Contact_FullName, Contact_FullNameA ' +
            'FROM dbo.Contacts ' +
            'WHERE ' + whereClause + ' ' +
            'ORDER BY Contact_FullName';

        console.log('🔍 /contacts/search | term="' + term + '" | accountType=' +
                    (accountType === null ? 'ALL' : accountType));

        return request.query(query);
    })
    .then(function(result) {
        res.json(result.recordset || []);
    })
    .catch(function(err) {
        console.error('❌ /contacts/search error:', err.message);
        res.status(500).json({ error: err.message });
    });
});

// ========== MIERP2: SEARCH PRODUCT ITEMS ==========
router.get('/items/search', function(req, res) {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    var term = req.query.term || '';
    if (!poolPromiseMIERP) return res.status(503).json({ error: 'MIERP2 not available' });
    poolPromiseMIERP.then(function(pool) {
        if (!pool) return res.status(503).json({ error: 'MIERP2 not available' });
        var request = pool.request();
        var query;
        if (term && term.trim().length > 0) {
            request.input('term', sql.NVarChar, '%' + term.trim() + '%');
            query = `SELECT ItemCode, ItemNameL FROM [Product].[Items] WHERE ItemCode LIKE @term OR ItemNameL LIKE @term ORDER BY ItemNameL`;
        } else {
            query = `SELECT ItemCode, ItemNameL FROM [Product].[Items] WHERE ItemCode IS NOT NULL AND ItemNameL IS NOT NULL ORDER BY ItemNameL`;
        }
        return request.query(query).then(function(result) {
            return (result.recordset || []).map(function(row) { return { code: row.ItemCode || '', name: row.ItemNameL || '' }; });
        });
    }).then(function(results) { res.json(results); })
      .catch(function(err) { console.error('❌ /items/search error:', err.message); res.status(500).json({ error: err.message }); });
});

// ========== VIEW REQUEST ==========
router.get('/view/:id', function(req, res) {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    var requestId = parseInt(req.params.id);
    if (isNaN(requestId)) return res.status(400).json({ error: 'Invalid request ID' });

    var pool, requestData;
    var userRole = req.session.user.role;
    var userId = req.session.user.id;
    var userBranch = req.session.user.branch || 'Cairo';

    poolPromise.then(function(p) {
        pool = p;
        return pool.request().input('id', sql.Int, requestId).query('SELECT * FROM Requests WHERE id = @id');
    }).then(function(r) {
        if (!r.recordset[0]) return res.status(404).json({ error: 'Not found' });
        requestData = r.recordset[0];

        if (requestData.requester_id === userId) {
            return pool.request().input('id', sql.Int, requestId).query('SELECT * FROM RequestItems WHERE request_id = @id ORDER BY line_number');
        }
        if (userRole === 'requester' && userBranch === 'Alex' && requestData.branch === 'Alex') {
            return pool.request().input('id', sql.Int, requestId).query('SELECT * FROM RequestItems WHERE request_id = @id ORDER BY line_number');
        }
        var approvalRoles = ['service', 'finance', 'warehouse', 'manager', 'ctmanager', 'mrimanager', 'xraymanager', 'angiomanager', 'konicamanager', 'salesmanager', 'usmanager', 'projectsmanager'];
        if (approvalRoles.indexOf(userRole) !== -1) {
            return pool.request().input('id', sql.Int, requestId).query('SELECT * FROM RequestItems WHERE request_id = @id ORDER BY line_number');
        }
        return pool.request()
            .input('requester_id', sql.Int, requestData.requester_id)
            .input('user_id', sql.Int, userId)
            .query(`SELECT u1.department FROM Users u1 JOIN Users u2 ON u1.department = u2.department WHERE u1.id = @requester_id AND u2.id = @user_id`)
            .then(function(deptResult) {
                if (!deptResult.recordset || deptResult.recordset.length === 0) {
                    return res.status(403).json({ error: 'Not authorized' });
                }
                return pool.request().input('id', sql.Int, requestId).query('SELECT * FROM RequestItems WHERE request_id = @id ORDER BY line_number');
            });
    }).then(function(items) {
        if (res.headersSent) return;
        res.json({ request: requestData, items: items && items.recordset ? items.recordset : [] });
    }).catch(function(err) {
        console.error('❌ /view/:id error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    });
});

// ========== PRINT REQUEST ==========
router.get('/print/:id', function(req, res) {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });

    var requestId = parseInt(req.params.id);
    if (isNaN(requestId)) return res.status(400).json({ error: 'Invalid request ID' });

    var pool, requestData;

    poolPromise.then(function(p) {
        pool = p;
        return pool.request().input('id', sql.Int, requestId).query('SELECT * FROM Requests WHERE id = @id');
    }).then(function(r) {
        if (!r.recordset[0]) return res.status(404).json({ error: 'Not found' });
        requestData = r.recordset[0];
        return pool.request().input('id', sql.Int, requestId).query('SELECT * FROM RequestItems WHERE request_id = @id ORDER BY line_number');
    }).then(function(items) {
        if (res.headersSent) return;
        res.json({ request: requestData, items: items && items.recordset ? items.recordset : [] });
    }).catch(function(err) {
        console.error('❌ /print/:id error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    });
});

// ========== SUBMIT NEW REQUEST ==========
router.post('/submit', function(req, res) {
    if (!req.session.user) return res.redirect('/');
    var body = req.body;
    var signature = body.requester_signature ? body.requester_signature.trim() : '';
    if (!signature || !validSignature(signature)) {
        return res.send('<h2>Invalid signature</h2><a href="/new-request.html">Back</a>');
    }
    var pool, requestId, requesterEmail, requesterName, requestDate, customerName;

    poolPromise.then(function(p) {
        pool = p;
        return pool.request().input('user_id', sql.Int, req.session.user.id)
            .query('SELECT name, email, department, branch FROM Users WHERE id = @user_id');
    }).then(function(userResult) {
        if (userResult.recordset.length) {
            requesterName = userResult.recordset[0].name || 'User';
            requesterEmail = userResult.recordset[0].email;
            var userDepartment = userResult.recordset[0].department || '';
            var submittedDepartment = body.department_name || '';
            var userBranch = userResult.recordset[0].branch || 'Cairo';
            if (!submittedDepartment && userDepartment) body.department_name = userDepartment;
            body.branch = userBranch;
        }
        requestDate = body.request_date || new Date().toISOString().split('T')[0];
        return forceArabicOrganization(body);
    }).then(function() {
        customerName = body.customer_name || '';
        var initialStatus = body.branch === 'Alex' ? 'Pending Dept Manager' : 'Pending Service';

        return pool.request()
            .input('requester_id', sql.Int, req.session.user.id)
            .input('request_date', sql.Date, body.request_date || null)
            .input('customer_name', sql.NVarChar, body.customer_name)
            .input('customer_code', sql.NVarChar, body.customer_code || null)
            .input('acquisition_type', sql.NVarChar, body.acquisition_type || null)
            .input('acquisition_sub', sql.NVarChar, body.warranty_sub_type || body.contract_sub_type || null)
            .input('installation_date', sql.Date, body.installation_date || null)
            .input('contract_number', sql.NVarChar, body.contract_number || null)
            .input('department_name', sql.NVarChar, body.department_name)
            .input('temporary_custody', sql.Bit, body.temporary_custody === 'true')
            .input('organization_code', sql.NVarChar, body.organization_code || null)
            .input('organization_name', sql.NVarChar, body.organization_name || null)
            .input('notes', sql.NVarChar, body.notes || null)
            .input('signature', sql.NVarChar, signature)
            .input('branch', sql.NVarChar, body.branch || 'Cairo')
            .input('status', sql.NVarChar, initialStatus)
            .query(`INSERT INTO Requests 
                (requester_id, request_date, customer_name, customer_code, acquisition_type, acquisition_sub_type, installation_date2, contract_number, department_name, temporary_custody, organization_code, organization_name, notes, requester_signature, requester_signature_date, status, branch) 
                VALUES (@requester_id, @request_date, @customer_name, @customer_code, @acquisition_type, @acquisition_sub, @installation_date, @contract_number, @department_name, @temporary_custody, @organization_code, @organization_name, @notes, @signature, GETDATE(), @status, @branch);
                SELECT SCOPE_IDENTITY() AS id`);
    }).then(function(result) {
        requestId = result.recordset[0].id;
        var insertPromises = [];
        for (var i = 1; i <= 50; i++) {
            (function(lineNum) {
                var partName = body['part_name_' + lineNum];
                var partNumber = body['part_number_' + lineNum];
                if (!partName && !partNumber) return;
                insertPromises.push(
                    pool.request()
                        .input('request_id', sql.Int, requestId)
                        .input('line_number', sql.Int, lineNum)
                        .input('part_name', sql.NVarChar, partName || null)
                        .input('part_number', sql.NVarChar, partNumber || null)
                        .input('po_number', sql.NVarChar, body['po_number_' + lineNum] || null)
                        .input('quantity', sql.Int, body['quantity_' + lineNum] ? parseInt(body['quantity_' + lineNum]) : null)
                        .input('warehouse_location', sql.NVarChar, body['warehouse_location_' + lineNum] || null)
                        .input('defective', sql.Char, body['defective_' + lineNum] || 'Y')
                        .query(`INSERT INTO RequestItems (request_id, line_number, part_name, part_number, po_number, quantity, warehouse_location, defective_status) VALUES (@request_id, @line_number, @part_name, @part_number, @po_number, @quantity, @warehouse_location, @defective)`)
                );
            })(i);
        }
        return Promise.all(insertPromises);
    }).then(function() {
        sendNewRequestEmail(pool, requestId, requesterEmail, requesterName, requestDate, customerName);
        var dashboardUrl = (body.branch === 'Alex') ? '/dashboard-alex.html' : '/dashboard';
        var extraMessage = (body.branch === 'Alex') ? 'It will be reviewed by the Department Manager.' : 'It will be reviewed by the Service department.';
        res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Request Submitted</title>
<style>body{font-family:Arial;background:#f4f6f9;padding:40px;text-align:center;margin:0;}
.box{max-width:500px;margin:60px auto;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 15px rgba(0,0,0,0.1);}
h2{color:#1e6b3c;margin-top:0;}p{color:#555;}
a{display:inline-block;margin-top:20px;padding:12px 28px;background:#1a3a5c;color:white;text-decoration:none;border-radius:6px;font-weight:bold;}</style>
</head><body><div class="box">
<h2>✅ Request #${requestId} submitted successfully!</h2>
<p>${extraMessage}</p>
<a href="${dashboardUrl}">← Back to Dashboard</a>
</div></body></html>`);
    }).catch(function(err) {
        console.error('Submit error:', err);
        var dashboardUrl = (body.branch === 'Alex') ? '/dashboard-alex.html' : '/dashboard';
        res.status(500).send(`<h2>Error: ${err.message}</h2><a href="/new-request.html">Back</a> | <a href="${dashboardUrl}">Dashboard</a>`);
    });
});

// ========== UPDATE EXISTING REQUEST (RESUBMIT) ==========
router.post('/update/:id', function(req, res) {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    var requestId = req.params.id;
    var body = req.body;
    var signature = body.requester_signature ? body.requester_signature.trim() : '';
    if (!signature || !validSignature(signature)) {
        return res.status(400).json({ error: 'Invalid signature' });
    }
    var pool, requestBranch = 'Cairo';
    var requesterEmail = req.session.user.email;
    var requesterName = req.session.user.name || 'Requester';

    poolPromise.then(function(p) {
        pool = p;
        return pool.request()
            .input('id', sql.Int, requestId)
            .input('requester_id', sql.Int, req.session.user.id)
            .query('SELECT status, branch FROM Requests WHERE id = @id AND requester_id = @requester_id');
    }).then(function(result) {
        if (result.recordset.length === 0) return res.status(404).json({ error: 'Request not found or not yours' });
        var req = result.recordset[0];
        var status = req.status;
        requestBranch = req.branch || 'Cairo';
        if (status === 'Fulfilled') return res.status(403).json({ error: 'This request has been fulfilled and cannot be edited.' });
        return forceArabicOrganization(body);
    }).then(function() {
        var newStatus = (requestBranch === 'Alex') ? 'Pending Dept Manager' : 'Pending Service';

        return pool.request()
            .input('id', sql.Int, requestId)
            .input('request_date', sql.Date, body.request_date || null)
            .input('customer_name', sql.NVarChar, body.customer_name)
            .input('customer_code', sql.NVarChar, body.customer_code || null)
            .input('acquisition_type', sql.NVarChar, body.acquisition_type || null)
            .input('acquisition_sub', sql.NVarChar, body.warranty_sub_type || body.contract_sub_type || null)
            .input('installation_date', sql.Date, body.installation_date || null)
            .input('contract_number', sql.NVarChar, body.contract_number || null)
            .input('department_name', sql.NVarChar, body.department_name)
            .input('temporary_custody', sql.Bit, body.temporary_custody === 'true')
            .input('organization_code', sql.NVarChar, body.organization_code || null)
            .input('organization_name', sql.NVarChar, body.organization_name || null)
            .input('notes', sql.NVarChar, body.notes || null)
            .input('signature', sql.NVarChar, signature)
            .input('newStatus', sql.NVarChar, newStatus)
            .query(`
                UPDATE Requests SET
                    request_date = @request_date, customer_name = @customer_name, customer_code = @customer_code,
                    acquisition_type = @acquisition_type, acquisition_sub_type = @acquisition_sub,
                    installation_date2 = @installation_date, contract_number = @contract_number,
                    department_name = @department_name, temporary_custody = @temporary_custody,
                    organization_code = @organization_code, organization_name = @organization_name,
                    notes = @notes, requester_signature = @signature, requester_signature_date = GETDATE(),
                    status = @newStatus, service_signature = NULL, service_signature_date = NULL,
                    service_approved_at = NULL, service_rejection_reason = NULL,
                    service_rejection_signature = NULL, service_rejection_date = NULL,
                    finance_signature = NULL, finance_signature_date = NULL, finance_approved_at = NULL,
                    finance_rejection_reason = NULL, finance_rejection_signature = NULL, finance_rejection_date = NULL,
                    warehouse_rejection_reason = NULL, warehouse_rejection_signature = NULL, warehouse_rejection_date = NULL,
                    dispatch_date = NULL, dispatch_permit_number = NULL, receiving_engineer = NULL,
                    engineer_signature = NULL, defective_return_date = NULL, addition_permit_number = NULL,
                    fulfilled_at = NULL, manager_approved_service_signature = NULL,
                    manager_approved_service_date = NULL, manager_approved_service_comment = NULL,
                    manager_approved_finance_signature = NULL, manager_approved_finance_date = NULL,
                    manager_approved_finance_comment = NULL, alex_confirmed = NULL, alex_confirmed_by = NULL,
                    alex_confirmed_date = NULL, alex_rejection_reason = NULL, alex_rejection_signature = NULL,
                    alex_rejection_date = NULL, dept_manager_approved = NULL, dept_manager_approved_by = NULL,
                    dept_manager_approved_date = NULL, dept_manager_rejected_by = NULL,
                    dept_manager_rejected_date = NULL, dept_manager_rejected_reason = NULL
                WHERE id = @id
            `);
    }).then(function() {
        return pool.request().input('id', sql.Int, requestId).query('DELETE FROM RequestItems WHERE request_id = @id');
    }).then(function() {
        var insertPromises = [];
        for (var i = 1; i <= 50; i++) {
            (function(lineNum) {
                var partName = body['part_name_' + lineNum];
                var partNumber = body['part_number_' + lineNum];
                if (!partName && !partNumber) return;
                insertPromises.push(
                    pool.request()
                        .input('request_id', sql.Int, requestId)
                        .input('line_number', sql.Int, lineNum)
                        .input('part_name', sql.NVarChar, partName || null)
                        .input('part_number', sql.NVarChar, partNumber || null)
                        .input('po_number', sql.NVarChar, body['po_number_' + lineNum] || null)
                        .input('quantity', sql.Int, body['quantity_' + lineNum] ? parseInt(body['quantity_' + lineNum]) : null)
                        .input('warehouse_location', sql.NVarChar, body['warehouse_location_' + lineNum] || null)
                        .input('defective', sql.Char, body['defective_' + lineNum] || 'Y')
                        .query(`INSERT INTO RequestItems (request_id, line_number, part_name, part_number, po_number, quantity, warehouse_location, defective_status) VALUES (@request_id, @line_number, @part_name, @part_number, @po_number, @quantity, @warehouse_location, @defective)`)
                );
            })(i);
        }
        return Promise.all(insertPromises);
    }).then(function() {
        // ✅ Send rich resubmit notification to Service/Dept Manager + Manager
        sendResubmitNotification(pool, requestId, requesterName);

        // ✅ Send a confirmation email to the requester
        sendResubmitConfirmation(pool, requestId, requesterEmail, requesterName);

        res.json({ success: true, requestId: requestId, message: 'Request resubmitted to ' + (requestBranch === 'Alex' ? 'Department Manager' : 'Service') });
    }).catch(function(err) {
        console.error('Update error:', err);
        res.status(500).json({ error: err.message });
    });
});

// ========== DELETE REQUEST ==========
router.delete('/delete/:id', function(req, res) {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    var requestId = req.params.id;
    var userId = req.session.user.id;
    var userRole = req.session.user.role;

    poolPromise.then(function(pool) {
        return pool.request().input('id', sql.Int, requestId).query('SELECT id, requester_id, status FROM Requests WHERE id = @id')
            .then(function(result) {
                if (!result.recordset || result.recordset.length === 0) return res.status(404).json({ error: 'Request not found.' });
                var request = result.recordset[0];
                if (request.requester_id !== userId && userRole !== 'manager') return res.status(403).json({ error: 'Not authorized' });
                if (request.status === 'Fulfilled') return res.status(400).json({ error: 'Fulfilled requests cannot be deleted.' });
                return pool.request().input('id', sql.Int, requestId).query('DELETE FROM RequestItems WHERE request_id = @id')
                    .then(function() {
                        return pool.request().input('id', sql.Int, requestId).query('DELETE FROM Requests WHERE id = @id');
                    });
            })
            .then(function() {
                if (!res.headersSent) res.json({ success: true, message: 'Request deleted successfully.' });
            });
    }).catch(function(err) {
        console.error('❌ Delete error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'An error occurred while deleting.' });
    });
});

// ========== MY REQUESTS ==========
router.get('/my', function(req, res) {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    var userId = req.session.user.id;
    var userRole = req.session.user.role;
    var userDepartment = req.session.user.department || '';
    var userBranch = req.session.user.branch || 'Cairo';

    poolPromise.then(function(pool) {
        var query = '', params = [];
        if (userRole === 'requester') {
            if (userBranch === 'Alex') {
                query = `SELECT r.*, u.name as requester_name, r.branch as request_branch
                    FROM Requests r LEFT JOIN Users u ON r.requester_id = u.id 
                    WHERE r.branch = 'Alex' ORDER BY r.created_at DESC`;
            } else {
                query = `SELECT r.*, u.name as requester_name, r.branch as request_branch
                    FROM Requests r LEFT JOIN Users u ON r.requester_id = u.id 
                    WHERE r.requester_id = @id OR r.department_name = @department
                    ORDER BY r.created_at DESC`;
                params = [
                    { name: 'id', type: sql.Int, value: userId },
                    { name: 'department', type: sql.NVarChar, value: userDepartment || '' }
                ];
            }
        } else {
            query = `SELECT r.*, u.name as requester_name, r.branch as request_branch
                FROM Requests r LEFT JOIN Users u ON r.requester_id = u.id 
                ORDER BY r.created_at DESC`;
        }
        var request = pool.request();
        params.forEach(function(p) { request.input(p.name, p.type, p.value); });
        return request.query(query);
    }).then(function(result) {
        res.json(result.recordset);
    }).catch(function(err) {
        console.error('❌ Error loading requests:', err);
        res.status(500).json({ error: 'Error loading requests: ' + err.message });
    });
});

module.exports = router;