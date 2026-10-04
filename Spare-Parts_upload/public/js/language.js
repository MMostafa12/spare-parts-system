// ============================================================
// language.js — waits for en.json AND ar.json before translating
// ============================================================

var currentLanguage = 'en';
var translations = { en: {}, ar: {} };
var enReady = false;
var arReady = false;

function translate(key) {
    var keys = key.split('.');
    var value = translations[currentLanguage];
    for (var i = 0; i < keys.length; i++) {
        if (value && value[keys[i]] !== undefined) {
            value = value[keys[i]];
        } else {
            return key;
        }
    }
    return value || key;
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(function (element) {
        var key = element.getAttribute('data-i18n');
        var translated = translate(key);
        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
            if (element.hasAttribute('placeholder')) {
                element.placeholder = translated;
            } else {
                element.value = translated;
            }
        } else {
            element.textContent = translated;
        }
    });

    var html = document.documentElement;
    var body = document.body;

    if (currentLanguage === 'ar') {
        html.setAttribute('dir', 'rtl');
        html.setAttribute('lang', 'ar');
        body.style.direction = 'rtl';
        body.style.textAlign = 'right';
        body.classList.add('lang-ar');
        body.classList.remove('lang-en');
    } else {
        html.setAttribute('dir', 'ltr');
        html.setAttribute('lang', 'en');
        body.style.direction = 'ltr';
        body.style.textAlign = 'left';
        body.classList.add('lang-en');
        body.classList.remove('lang-ar');
    }
}

function tryApplyWhenReady() {
    if (enReady && arReady) {
        applyTranslations();
        updateLanguageButton();
    }
}

function toggleLanguage() {
    var newLang = currentLanguage === 'en' ? 'ar' : 'en';
    fetch('/api/language', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: newLang })
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
        if (data.success) {
            currentLanguage = newLang;
            location.reload();
        }
    })
    .catch(function (err) { console.error('Error changing language:', err); });
}

function updateLanguageButton() {
    var button = document.getElementById('language-toggle');
    if (!button) return;
    if (currentLanguage === 'en') {
        button.textContent = '\uD83C\uDF10 \u0627\u0644\u0639\u0631\u0628\u064A\u0629';
        button.setAttribute('title', 'Switch to Arabic');
    } else {
        button.textContent = '\uD83C\uDF10 English';
        button.setAttribute('title', 'Switch to English');
    }
}

function loadTranslations() {
    fetch('/locales/en.json?v=' + Date.now())
        .then(function (r) { if (!r.ok) throw new Error('en.json HTTP ' + r.status); return r.json(); })
        .then(function (d) {
            translations['en'] = d;
            enReady = true;
            console.log('EN translations loaded.');
            tryApplyWhenReady();
        })
        .catch(function (e) {
            console.error('EN load failed:', e);
            enReady = true;
            tryApplyWhenReady();
        });

    fetch('/locales/ar.json?v=' + Date.now())
        .then(function (r) { if (!r.ok) throw new Error('ar.json HTTP ' + r.status); return r.json(); })
        .then(function (d) {
            translations['ar'] = d;
            arReady = true;
            console.log('AR translations loaded.');
            tryApplyWhenReady();
        })
        .catch(function (e) {
            console.error('AR load failed:', e);
            arReady = true;
            tryApplyWhenReady();
        });
}

document.addEventListener('DOMContentLoaded', function () {
    fetch('/api/language')
        .then(function (r) { return r.json(); })
        .then(function (data) {
            currentLanguage = (data && data.language) ? data.language : 'en';
            console.log('Current language:', currentLanguage);
            loadTranslations();
        })
        .catch(function () {
            currentLanguage = 'en';
            loadTranslations();
        });
});