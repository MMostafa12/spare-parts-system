'use strict';
var express = require('express');
var router = express.Router();
var db = require('../config/db');
var sql = db.sql;
var poolPromise = db.poolPromise;
var { sendMail } = require('../config/mail');

function validSignature(sig) {
    if (!sig || sig.trim() === '') return false;
    return /^[a-zA-Z\u0600-\u06FF\s]+$/.test(sig.trim());
}

var deptManagerRoles = [
    'ctmanager',
    'mrimanager',
    'xraymanager',
    'angiomanager',
    'konicamanager',
    'salesmanager',
    'usmanager',
    'projectsmanager'
];

// ========== HELPER: Build department filter ==========
function buildDepartmentFilter(userRole, userDepartment) {
    if (userRole === 'angiomanager') {
        return { sql: "r.department_name IN ('Angio', 'X-ray')", needsParam: false };
    }
    if (userRole === 'konicamanager') {
        return { sql: "r.department_name = 'Konica'", needsParam: false };
    }
    if (userRole === 'salesmanager') {
        return { sql: "r.department_name = 'Sales'", needsParam: false };
    }
    return {
        sql: "r.department_name = @department",
        needsParam: true,
        value: userDepartment
    };
}

function hasFixedDepartmentFilter(userRole) {
    return userRole === 'angiomanager'
        || userRole === 'konicamanager'
        || userRole === 'salesmanager';
}

// ========== GET REQUESTS FOR DEPARTMENT MANAGER ==========
router.get('/requests', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    var userRole = req.session.user.role;
    var userDepartment = req.session.user.department || '';
    var hasFixed = hasFixedDepartmentFilter(userRole);

    if (deptManagerRoles.indexOf(userRole) === -1) {
        return res.status(403).json({ error: 'Unauthorized - Department Manager access required' });
    }

    if (!userDepartment && !hasFixed) {
        return res.status(400).json({ error: 'No department assigned to this manager' });
    }

    var filter = buildDepartmentFilter(userRole, userDepartment);
    console.log('Fetching requests | role:', userRole, '| filter:', filter.sql);

    poolPromise.then(function(pool) {
        var request = pool.request();
        if (filter.needsParam) {
            request.input('department', sql.NVarChar, filter.value);
        }

        return request.query(`
            SELECT r.*, u.name as requester_name, u.branch as requester_branch
            FROM Requests r
            LEFT JOIN Users u ON r.requester_id = u.id
            WHERE ${filter.sql}
            ORDER BY
                CASE
                    WHEN r.status = 'Pending Dept Manager' THEN 1
                    ELSE 2
                END,
                r.created_at DESC
        `);
    }).then(function(result) {
        var requests = result.recordset;
        console.log('Found', requests.length, 'requests');

        if (requests.length === 0) {
            return res.json([]);
        }

        var promises = requests.map(function(row) { // Renamed to 'row' to avoid shadowing Express 'req'
            return poolPromise.then(function(pool) {
                return pool.request()
                    .input('request_id', sql.Int, row.id)
                    .query('SELECT * FROM RequestItems WHERE request_id = @request_id ORDER BY line_number');
            }).then(function(itemsResult) {
                row.items = itemsResult.recordset || [];
                return row;
            });
        });

        return Promise.all(promises);
    }).then(function(requestsWithItems) {
        // FIX 1: Remove the circular '_parent' reference before sending JSON
        var cleanData = requestsWithItems.map(function(item) {
            var cleanItem = Object.assign({}, item); // Create a shallow copy
            delete cleanItem._parent; // Remove the circular reference
            
            if (cleanItem.items) {
                cleanItem.items = cleanItem.items.map(function(subItem) {
                    var cleanSubItem = Object.assign({}, subItem);
                    delete cleanSubItem._parent;
                    return cleanSubItem;
                });
            }
            return cleanItem;
        });
        
        res.json(cleanData);
    }).catch(function(err) {
        console.error('Error loading manager requests:', err);
        // FIX 2: Check if headers were already sent
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    });
});

// ========== VIEW SINGLE REQUEST ==========
router.get('/view/:id', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    var userRole = req.session.user.role;
    var userDepartment = req.session.user.department || '';

    if (deptManagerRoles.indexOf(userRole) === -1) {
        return res.status(403).json({ error: 'Unauthorized - Department Manager access required' });
    }

    var requestId = parseInt(req.params.id);
    if (isNaN(requestId)) return res.status(400).json({ error: 'Invalid request ID' });

    var pool;
    var requestData;
    var filter = buildDepartmentFilter(userRole, userDepartment);

    poolPromise.then(function(p) {
        pool = p;
        var request = pool.request().input('id', sql.Int, requestId);
        if (filter.needsParam) {
            request.input('department', sql.NVarChar, filter.value);
        }
        return request.query('SELECT r.* FROM Requests r WHERE r.id = @id AND ' + filter.sql);
    }).then(function(r) {
        if (!r.recordset[0]) {
            return res.status(404).json({ error: 'Request not found or not in your department' });
        }
        requestData = r.recordset[0];

        return pool.request()
            .input('id', sql.Int, requestId)
            .query('SELECT * FROM RequestItems WHERE request_id = @id ORDER BY line_number');
    }).then(function(items) {
        if (res.headersSent) return;
        
        // FIX: Clean the parent references here too
        var cleanRequest = Object.assign({}, requestData);
        delete cleanRequest._parent;
        
        var cleanItems = (items && items.recordset ? items.recordset : []).map(function(subItem) {
            var cleanSubItem = Object.assign({}, subItem);
            delete cleanSubItem._parent;
            return cleanSubItem;
        });

        res.json({ request: cleanRequest, items: cleanItems });
    }).catch(function(err) {
        console.error('/manager/view/:id error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    });
});

// ========== UPDATE REQUEST (Department Manager edit) ==========
router.post('/update/:id', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    var userRole = req.session.user.role;
    var userDepartment = req.session.user.department || '';
    var userId = req.session.user.id;

    if (deptManagerRoles.indexOf(userRole) === -1) {
        return res.status(403).json({ error: 'Unauthorized - Department Manager access required' });
    }

    var requestId = parseInt(req.params.id);
    if (isNaN(requestId)) return res.status(400).json({ error: 'Invalid request ID' });

    var body = req.body;
    var pool;
    var requestBranch = 'Cairo';
    var newStatus = 'Pending Service';
    var filter = buildDepartmentFilter(userRole, userDepartment);

    console.log('Department Manager editing request #' + requestId);

    poolPromise.then(function(p) {
        pool = p;
        var request = pool.request().input('id', sql.Int, requestId);
        if (filter.needsParam) {
            request.input('department', sql.NVarChar, filter.value);
        }
        return request.query('SELECT r.id, r.status, r.branch, r.requester_id FROM Requests r WHERE r.id = @id AND ' + filter.sql);
    }).then(function(result) {
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Request not found or not in your department' });
        }

        var req = result.recordset[0];
        requestBranch = req.branch || 'Cairo';
        var isMyOwnRequest = (req.requester_id === userId);

        if (req.status === 'Fulfilled') {
            return res.status(403).json({ error: 'Fulfilled requests cannot be edited.' });
        }

        if (isMyOwnRequest) {
            newStatus = 'Pending Service';
        } else if (requestBranch === 'Alex') {
            newStatus = 'Pending Dept Manager';
        } else {
            newStatus = 'Pending Service';
        }

        console.log('  New status will be: ' + newStatus);

        return pool.request()
            .input('id', sql.Int, requestId)
            .input('request_date', sql.Date, body.request_date || null)
            .input('customer_name', sql.NVarChar, body.customer_name)
            .input('customer_code', sql.NVarChar, body.customer_code || null)
            .input('acquisition_type', sql.NVarChar, body.acquisition_type || null)
            .input('acquisition_sub', sql.NVarChar, body.warranty_sub_type || body.contract_sub_type || null)
            .input('installation_date', sql.Date, body.installation_date || null)
            .input('contract_number', sql.NVarChar, body.contract_number || null)
            .input('department_name', sql.NVarChar, body.department_name || userDepartment)
            .input('temporary_custody', sql.Bit, body.temporary_custody === 'true')
            .input('oh_release', sql.Bit, body.out_of_hours_release === 'true')
            .input('oh_release_dt', sql.DateTime, body.out_of_hours_release_datetime || null)
            .input('oh_return', sql.Bit, body.out_of_hours_return === 'true')
            .input('oh_return_dt', sql.DateTime, body.out_of_hours_return_datetime || null)
            .input('organization_code', sql.NVarChar, body.organization_code || null)
            .input('organization_name', sql.NVarChar, body.organization_name || null)
            .input('notes', sql.NVarChar, body.notes || null)
            .input('newStatus', sql.NVarChar, newStatus)
            .query(`
                UPDATE Requests SET
                    request_date = @request_date,
                    customer_name = @customer_name,
                    customer_code = @customer_code,
                    acquisition_type = @acquisition_type,
                    acquisition_sub_type = @acquisition_sub,
                    installation_date2 = @installation_date,
                    contract_number = @contract_number,
                    department_name = @department_name,
                    temporary_custody = @temporary_custody,
                    out_of_hours_release = @oh_release,
                    out_of_hours_release_datetime = @oh_release_dt,
                    out_of_hours_return = @oh_return,
                    out_of_hours_return_datetime = @oh_return_dt,
                    organization_code = @organization_code,
                    organization_name = @organization_name,
                    notes = @notes,
                    status = @newStatus,
                    service_signature = NULL,
                    service_signature_date = NULL,
                    service_approved_at = NULL,
                    service_rejection_reason = NULL,
                    service_rejection_signature = NULL,
                    service_rejection_date = NULL,
                    finance_signature = NULL,
                    finance_signature_date = NULL,
                    finance_approved_at = NULL,
                    finance_rejection_reason = NULL,
                    finance_rejection_signature = NULL,
                    finance_rejection_date = NULL,
                    warehouse_rejection_reason = NULL,
                    warehouse_rejection_signature = NULL,
                    warehouse_rejection_date = NULL,
                    dispatch_date = NULL,
                    dispatch_permit_number = NULL,
                    receiving_engineer = NULL,
                    engineer_signature = NULL,
                    defective_return_date = NULL,
                    addition_permit_number = NULL,
                    fulfilled_at = NULL,
                    manager_approved_service_signature = NULL,
                    manager_approved_service_date = NULL,
                    manager_approved_service_comment = NULL,
                    manager_approved_finance_signature = NULL,
                    manager_approved_finance_date = NULL,
                    manager_approved_finance_comment = NULL,
                    alex_confirmed = NULL,
                    alex_confirmed_by = NULL,
                    alex_confirmed_date = NULL,
                    alex_rejection_reason = NULL,
                    alex_rejection_signature = NULL,
                    alex_rejection_date = NULL,
                    dept_manager_approved = NULL,
                    dept_manager_approved_by = NULL,
                    dept_manager_approved_date = NULL,
                    dept_manager_rejected_by = NULL,
                    dept_manager_rejected_date = NULL,
                    dept_manager_rejected_reason = NULL
                WHERE id = @id
            `);
    }).then(function() {
        return pool.request()
            .input('id', sql.Int, requestId)
            .query('DELETE FROM RequestItems WHERE request_id = @id');
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
                        .query(`INSERT INTO RequestItems
                            (request_id, line_number, part_name, part_number, po_number, quantity, warehouse_location, defective_status)
                            VALUES (@request_id, @line_number, @part_name, @part_number, @po_number, @quantity, @warehouse_location, @defective)`)
                );
            })(i);
        }
        return Promise.all(insertPromises);
    }).then(function() {
        console.log('Dept Manager updated request #' + requestId + ' -> ' + newStatus);
        res.json({
            success: true,
            requestId: requestId,
            message: 'Request updated. Status: ' + newStatus
        });
    }).catch(function(err) {
        console.error('Dept Manager update error:', err);
        if (!res.headersSent) { // ADDED FIX
            res.status(500).json({ error: err.message });
        }
    });
});

// ========== DELETE REQUEST ==========
router.delete('/delete/:id', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    var userRole = req.session.user.role;
    var userDepartment = req.session.user.department || '';
    var userId = req.session.user.id;

    if (deptManagerRoles.indexOf(userRole) === -1) {
        return res.status(403).json({ error: 'Unauthorized - Department Manager access required' });
    }

    var requestId = parseInt(req.params.id);
    if (isNaN(requestId)) return res.status(400).json({ error: 'Invalid request ID' });

    var filter = buildDepartmentFilter(userRole, userDepartment);

    console.log('Dept Manager deleting request #' + requestId);

    poolPromise.then(function(pool) {
        var request = pool.request().input('id', sql.Int, requestId);
        if (filter.needsParam) {
            request.input('department', sql.NVarChar, filter.value);
        }
        return request
            .query('SELECT r.id, r.status, r.branch, r.requester_id FROM Requests r WHERE r.id = @id AND ' + filter.sql)
            .then(function(result) {
                if (!result.recordset || result.recordset.length === 0) {
                    return res.status(404).json({ error: 'Request not found or not in your department' });
                }

                var request2 = result.recordset[0];
                var isMyOwnRequest = (request2.requester_id === userId);
                var isAlexRequest = (request2.branch === 'Alex');

                if (!isMyOwnRequest && !isAlexRequest) {
                    return res.status(403).json({ error: 'You can only delete your own requests or Alex requests.' });
                }

                if (request2.status === 'Fulfilled') {
                    return res.status(400).json({ error: 'Fulfilled requests cannot be deleted.' });
                }

                return pool.request()
                    .input('id', sql.Int, requestId)
                    .query('DELETE FROM RequestItems WHERE request_id = @id')
                    .then(function() {
                        return pool.request()
                            .input('id', sql.Int, requestId)
                            .query('DELETE FROM Requests WHERE id = @id');
                    });
            })
            .then(function() {
                if (!res.headersSent) {
                    console.log('Request #' + requestId + ' deleted');
                    res.json({ success: true, message: 'Request deleted successfully.' });
                }
            });
    }).catch(function(err) {
        console.error('Delete error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'An error occurred while deleting.' });
    });
});

// ========== APPROVE REQUEST ==========
router.post('/approve/:id', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    var userRole = req.session.user.role;
    var userDepartment = req.session.user.department || '';
    var userId = req.session.user.id;
    var signature = req.body.signature || '';
    var requestId = req.params.id;
    var pool;

    if (deptManagerRoles.indexOf(userRole) === -1) {
        return res.status(403).json({ error: 'Unauthorized - Department Manager access required' });
    }

    if (!validSignature(signature)) {
        return res.status(400).json({ error: 'Invalid signature.' });
    }

    var filter = buildDepartmentFilter(userRole, userDepartment);

    poolPromise.then(function(p) {
        pool = p;
        var request = pool.request().input('id', sql.Int, requestId);
        if (filter.needsParam) {
            request.input('department', sql.NVarChar, filter.value);
        }
        return request.query('SELECT r.id, r.status, r.department_name, r.branch, r.requester_id FROM Requests r WHERE r.id = @id AND ' + filter.sql);
    }).then(function(result) {
        var req = result.recordset[0];
        if (!req) {
            return res.status(404).json({ error: 'Request not found or not in your department.' });
        }
        if (req.status !== 'Pending Dept Manager') {
            return res.status(400).json({ error: 'Request is not pending department manager approval. Current status: ' + req.status });
        }
        if (req.branch !== 'Alex') {
            return res.status(400).json({ error: 'Only Alex branch requests need department manager approval.' });
        }
        if (req.requester_id === userId) {
            return res.status(400).json({ error: 'You cannot approve your own request.' });
        }

        return pool.request()
            .input('id', sql.Int, requestId)
            .input('signature', sql.NVarChar, signature)
            .query(`
                UPDATE Requests SET
                    status = 'Pending Service',
                    dept_manager_approved = 1,
                    dept_manager_approved_by = @signature,
                    dept_manager_approved_date = GETDATE(),
                    dept_manager_rejected_by = NULL,
                    dept_manager_rejected_date = NULL,
                    dept_manager_rejected_reason = NULL
                WHERE id = @id
            `);
    }).then(function() {
        sendDeptManagerApprovalEmail(pool, requestId, signature);
        res.json({ success: true, message: 'Request approved and sent to Service.' });
    }).catch(function(err) {
        console.error('Dept Manager approve error:', err);
        if (!res.headersSent) { // ADDED FIX
            res.status(500).json({ error: err.message });
        }
    });
});

// ========== REJECT REQUEST ==========
router.post('/reject/:id', function(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    var userRole = req.session.user.role;
    var userDepartment = req.session.user.department || '';
    var userId = req.session.user.id;
    var reason = req.body.reason || '';
    var signature = req.body.signature || '';
    var requestId = req.params.id;
    var pool;

    if (deptManagerRoles.indexOf(userRole) === -1) {
        return res.status(403).json({ error: 'Unauthorized - Department Manager access required' });
    }

    if (!reason.trim()) {
        return res.status(400).json({ error: 'Rejection reason required.' });
    }
    if (!validSignature(signature)) {
        return res.status(400).json({ error: 'Invalid signature.' });
    }

    var filter = buildDepartmentFilter(userRole, userDepartment);

    poolPromise.then(function(p) {
        pool = p;
        var request = pool.request().input('id', sql.Int, requestId);
        if (filter.needsParam) {
            request.input('department', sql.NVarChar, filter.value);
        }
        return request.query('SELECT r.id, r.status, r.department_name, r.branch, r.requester_id FROM Requests r WHERE r.id = @id AND ' + filter.sql);
    }).then(function(result) {
        var req = result.recordset[0];
        if (!req) {
            return res.status(404).json({ error: 'Request not found or not in your department.' });
        }
        if (req.status !== 'Pending Dept Manager') {
            return res.status(400).json({ error: 'Request is not pending department manager approval.' });
        }
        if (req.branch !== 'Alex') {
            return res.status(400).json({ error: 'Only Alex branch requests need department manager approval.' });
        }
        if (req.requester_id === userId) {
            return res.status(400).json({ error: 'You cannot reject your own request.' });
        }

        return pool.request()
            .input('id', sql.Int, requestId)
            .input('reason', sql.NVarChar, reason.trim())
            .input('signature', sql.NVarChar, signature.trim())
            .query(`
                UPDATE Requests SET
                    status = 'Rejected by Dept Manager',
                    dept_manager_rejected_by = @signature,
                    dept_manager_rejected_date = GETDATE(),
                    dept_manager_rejected_reason = @reason
                WHERE id = @id
            `);
    }).then(function() {
        sendDeptManagerRejectionEmail(pool, requestId, reason, signature);
        res.json({ success: true, message: 'Request rejected.' });
    }).catch(function(err) {
        console.error('Dept Manager reject error:', err);
        if (!res.headersSent) { // ADDED FIX
            res.status(500).json({ error: err.message });
        }
    });
});

// ========== HELPER: SEND APPROVAL EMAIL ==========
function sendDeptManagerApprovalEmail(pool, requestId, signature) {
    var emailTemplates = require('../config/emailTemplates');

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

                    return pool.request()
                        .input('requester_id', sql.Int, req.requester_id)
                        .query('SELECT email FROM Users WHERE id = @requester_id')
                        .then(function (requesterResult) {
                            if (requesterResult.recordset[0] && requesterResult.recordset[0].email) {
                                emails.push(requesterResult.recordset[0].email);
                            }

                            var uniqueEmails = emails.filter(function (email, index) {
                                return emails.indexOf(email) === index;
                            });

                            if (uniqueEmails.length === 0) return;

                            var subject = '✅ Request #' + requestId + ' - Approved by Department Manager';
                            var html = emailTemplates.buildRequestEmail({
                                req: req,
                                items: data.items,
                                title: '✅ Request Approved by Department Manager',
                                statusColor: '#1e6b3c',
                                statusText: 'Pending Service',
                                actionText: '✅ Department Manager Approved — Sent to Service',
                                roleText: 'Department Manager',
                                signature: signature
                            });

                            sendMail(uniqueEmails.join(', '), subject, html)
                                .catch(function (err) { console.error('Email error:', err.message); });
                        });
                });
        })
        .catch(function (err) { console.error('Email error:', err); });
}

// ========== HELPER: SEND REJECTION EMAIL ==========
function sendDeptManagerRejectionEmail(pool, requestId, reason, signature) {
    var emailTemplates = require('../config/emailTemplates');

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

                    var subject = '❌ Request #' + requestId + ' - Rejected by Department Manager';
                    var html = emailTemplates.buildRequestEmail({
                        req: req,
                        items: data.items,
                        title: '❌ Request Rejected by Department Manager',
                        statusColor: '#8b1a1a',
                        statusText: 'Rejected by Dept Manager',
                        actionText: '❌ Rejected by Department Manager',
                        roleText: 'Department Manager',
                        signature: signature,
                        reason: reason
                    });

                    sendMail(user.email, subject, html)
                        .catch(function (err) { console.error('Email error:', err.message); });
                });
        })
        .catch(function (err) { console.error('Email error:', err); });
}

module.exports = router;