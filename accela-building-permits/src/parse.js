// Parsers for Accela Citizen Access (ACA) pages. ACA is an ASP.NET WebForms app; the markup below is based on:
//  - a real CapDetail.aspx page (Louisville LJCMG, rendered 2026) from github.com/Zackthehouseguy/jefferson-lis-pendens-scraper-2:
//    #ctl00_PlaceHolderMain_lblPermitNumber / lblPermitType / lblRecordStatus, table#tbl_worklocation,
//    td.td_parent_left blocks ("Description:", "Owner:"), MoreDetail_ItemCol1/2 label/value pairs,
//    #..._palParceList "Parcel Number:", hidden fields __VIEWSTATE, __VIEWSTATEGENERATOR, ACA_CS_FIELD.
//  - the HTTP postback scraper for aca-prod.accela.com/PINELLAS in github.com/jbkcreator/Forced-action-
//    (pinellas_violations_engine.py): field prefix ctl00$PlaceHolderMain$generalSearchForm$, txtGSStartDate /
//    txtGSEndDate (MM/DD/YYYY), __EVENTTARGET ctl00$PlaceHolderMain$btnNewSearch, rows tr.ACA_TabRow_Odd/Even,
//    pager table.aca_pagination + span.SelectedPageButton + __doPostBack('...') next links.
//  - browserless.io skill for aca-prod.accela.com (Reno): #ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList,
//    a[id*="hlPermitNumber"], ddlGSPermitType, pager [id*="PermitList_gdvPermitList_pager"].
// Column positions differ per agency, so grid columns are mapped by header text.
import * as cheerio from 'cheerio';

export const clean = (s) => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const stripStar = (s) => clean(String(s ?? '').replace(/\s\*\s*$/, '').replace(/\*$/, ''));

export const pageTitle = (html) => clean(String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 100);

/** Extracts the target of javascript:__doPostBack('target','arg'). */
export function postBackTarget(href) {
    const m = String(href ?? '').match(/__doPostBack\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/);
    return m ? { target: m[1], argument: m[2] } : null;
}

// ─────────────────────────────── blocks / error pages ───────────────────────────────

const BLOCK_MARKERS = [
    ['Just a moment...', 'Cloudflare challenge page'],
    ['cf-browser-verification', 'Cloudflare browser check'],
    ['cf_chl_opt', 'Cloudflare challenge script'],
    ['Attention Required! | Cloudflare', 'Cloudflare block page'],
    ['_Incapsula_Resource', 'Imperva/Incapsula challenge'],
    ['Request unsuccessful. Incapsula', 'Imperva/Incapsula block page'],
    ['Access Denied', '"Access Denied" page'],
    ["You don't have permission to access", '"You don\'t have permission" page'],
    ['The requested URL was rejected', 'web application firewall rejection page'],
];

/** Anti-bot / firewall markers in a response body (first 12 kB only). */
export function findBlockMarkers(text) {
    const head = String(text ?? '').slice(0, 12_288);
    const found = [];
    for (const [needle, label] of BLOCK_MARKERS) if (head.includes(needle) && !found.includes(label)) found.push(label);
    return found;
}

export const isMaintenancePage = (html) => /scheduled maintenance|site is (?:currently )?(?:down|unavailable) for maintenance/i.test(pageTitle(html))
    || /Accela Citizen Access is (?:currently )?(?:down|unavailable)/i.test(String(html ?? '').slice(0, 20_000));

/** ACA's generic error page ("An error has occurred."), shown e.g. for an expired session or a bad postback. */
export function acaErrorMessage(html) {
    const $ = cheerio.load(String(html ?? ''));
    const title = clean($('#ctl00_PlaceHolderMain_systemErrorMessage_lblMessageTitle').text());
    if (title) return clean(`${title} ${$('#ctl00_PlaceHolderMain_systemErrorMessage_lblMessageContent, #ctl00_PlaceHolderMain_systemErrorMessage_divMessage').first().text()}`);
    return null;
}

export const isLoginPage = (html, finalUrl = '') => /\/login\.aspx/i.test(finalUrl)
    || /id="ctl00_PlaceHolderMain_LoginBox|name="ctl00\$PlaceHolderMain\$LoginBox/i.test(String(html ?? ''));

// ─────────────────────────────── form serialization ───────────────────────────────

/**
 * Serializes the ASP.NET form like a browser would (hidden fields, text inputs, checked boxes/radios, selected
 * options), minus submit/image/button inputs. Returns { action, fields: [[name, value], ...] }.
 */
export function serializeForm(html, baseUrl) {
    const $ = cheerio.load(String(html ?? ''));
    const form = $('form#aspnetForm').first().length ? $('form#aspnetForm').first() : $('form').first();
    const fields = [];
    form.find('input, select, textarea').each((_, el) => {
        const $el = $(el);
        const name = $el.attr('name');
        if (!name || $el.is('[disabled]')) return;
        const tag = el.tagName.toLowerCase();
        if (tag === 'select') {
            const sel = $el.find('option[selected]').first();
            const opt = sel.length ? sel : $el.find('option').first();
            if ($el.is('[multiple]')) {
                $el.find('option[selected]').each((__, o) => fields.push([name, $(o).attr('value') ?? $(o).text()]));
            } else if (opt.length) fields.push([name, opt.attr('value') ?? clean(opt.text())]);
            return;
        }
        if (tag === 'textarea') {
            fields.push([name, $el.text()]);
            return;
        }
        const type = String($el.attr('type') ?? 'text').toLowerCase();
        if (['submit', 'image', 'button', 'reset', 'file'].includes(type)) return;
        if ((type === 'checkbox' || type === 'radio') && !$el.is('[checked]')) return;
        fields.push([name, $el.attr('value') ?? (type === 'checkbox' || type === 'radio' ? 'on' : '')]);
    });
    const actionAttr = form.attr('action');
    const action = actionAttr ? new URL(actionAttr.replace(/&amp;/g, '&'), baseUrl).href : baseUrl;
    return { action, fields };
}

/** Returns a copy of fields with `name` set to `value` (replaced if present, appended otherwise). */
export function setField(fields, name, value) {
    let found = false;
    const out = fields.map(([k, v]) => {
        if (k === name) {
            found = true;
            return [k, value];
        }
        return [k, v];
    });
    if (!found) out.push([name, value]);
    return out;
}

export const encodeForm = (fields) => fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`).join('&');

// ─────────────────────────────── search page ───────────────────────────────

const findName = ($, re) => {
    let name = null;
    $('input[name], select[name]').each((_, el) => {
        const n = $(el).attr('name');
        if (!name && re.test(n)) name = n;
    });
    return name;
};

/**
 * Describes the general search form: date field names, record-type dropdown, search button target, CAPTCHA,
 * modules linked from the tab bar. `ok` is false when the page has no date search.
 */
export function parseSearchForm(html) {
    const $ = cheerio.load(String(html ?? ''));
    const startName = findName($, /generalSearchForm\$txtGSStartDate$/i) ?? findName($, /txtGSStartDate$/i) ?? findName($, /StartDate$/i);
    const endName = findName($, /generalSearchForm\$txtGSEndDate$/i) ?? findName($, /txtGSEndDate$/i) ?? findName($, /EndDate$/i);
    const typeName = findName($, /ddlGSPermitType$/i) ?? findName($, /ddlGSCapType$/i);
    const recordTypes = [];
    if (typeName) {
        $(`select[name="${typeName}"] option`).each((_, o) => {
            const value = $(o).attr('value') ?? '';
            const text = clean($(o).text());
            if (value && !/^--/.test(text) && !/^select/i.test(text)) recordTypes.push({ value, text });
        });
    }
    let searchTarget = null;
    $('a[id$="btnNewSearch"], a[id*="btnNewSearch"], input[name$="btnNewSearch"]').each((_, el) => {
        if (searchTarget) return;
        const pb = postBackTarget($(el).attr('href'));
        searchTarget = pb?.target ?? $(el).attr('name') ?? null;
    });
    searchTarget ??= 'ctl00$PlaceHolderMain$btnNewSearch';
    const captcha = $('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [id*="Captcha" i], [id*="captcha"]').length > 0
        || /www\.google\.com\/recaptcha\/api\.js|hcaptcha\.com\/1\/api\.js/i.test(String(html));
    const modules = [];
    $('a[href*="CapHome.aspx"]').each((_, a) => {
        const m = String($(a).attr('href')).match(/[?&]module=([^&#]+)/i);
        if (m) {
            const mod = decodeURIComponent(m[1]);
            if (!modules.some((x) => x.toLowerCase() === mod.toLowerCase())) modules.push(mod);
        }
    });
    return { ok: !!(startName && endName), startName, endName, typeName, recordTypes, searchTarget, captcha, modules, title: pageTitle(html) };
}

// ─────────────────────────────── results grid ───────────────────────────────

/** Canonical grid column keys by header text (lower-case, punctuation stripped). */
const HEADER_MAP = [
    [/^(date|opened date|open date|file date|filed date|application date|applied date|date opened|date filed|submitted date|created date)$/, 'openedDate'],
    [/^(record number|record #|record no|permit number|permit #|permit no|application number|case number|record id)$/, 'recordNumber'],
    [/^(record type|permit type|type|application type|work type|case type)$/, 'recordType'],
    [/^(description|project description|work description|desc|permit description)$/, 'description'],
    [/^(project name|project)$/, 'projectName'],
    [/^(status|record status|permit status|application status)$/, 'status'],
    [/^(address|location|property address|site address|work location|parcel address)$/, 'address'],
    [/^(expiration date|expires|expiration)$/, 'expirationDate'],
    [/^(issued date|issue date|date issued|issued)$/, 'issuedDate'],
    [/^(short notes|notes|short note)$/, 'shortNotes'],
    [/^(related records|related)$/, 'relatedRecords'],
    [/^(action|actions)$/, 'action'],
    [/^(parcel number|parcel|parcel no|apn)$/, 'parcelNumber'],
    [/^(job value|valuation|value|declared valuation|estimated value)$/, 'valuation'],
    [/^(contractor|contractor name|licensed professional)$/, 'contractorName'],
];

export function headerKey(text) {
    const t = clean(text).toLowerCase().replace(/[:.]/g, '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    for (const [re, key] of HEADER_MAP) if (re.test(t)) return key;
    return null;
}

/**
 * Parses a CapHome.aspx results page. Returns
 * { grid: bool, headers, rows: [{cells, byKey, detailHref}], nextTarget, currentPage, exportTarget, countText, noResults, message }.
 */
export function parseResults(html, baseUrl) {
    const $ = cheerio.load(String(html ?? ''));
    const table = $('table[id$="gdvPermitList"]').first().length ? $('table[id$="gdvPermitList"]').first()
        : $('table.ACA_GridView').first().length ? $('table.ACA_GridView').first() : $('table:has(tr.ACA_TabRow_Odd)').first();
    const text = clean($('#ctl00_PlaceHolderMain_dgvPermitList_updatePanel, #ctl00_PlaceHolderMain_divSearchResult, body').first().text());
    const noResults = /(?:returned|found) no (?:results|records)|no records (?:were )?found|no matching records/i.test(text) && !$('tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even').length;
    const countText = text.match(/Showing\s+\d+\s*-\s*\d+\s+of\s+[\d,]+\+?/i)?.[0] ?? null;
    const out = { grid: table.length > 0, headers: [], rows: [], nextTarget: null, nextArgument: '', currentPage: null, exportTarget: null, countText, noResults, message: null };

    // Validation / info messages ACA shows above the grid (e.g. "Please enter a date range" or a limit warning).
    const msg = clean($('.ACA_Message_Error, .ACA_Error_Label, #ctl00_PlaceHolderMain_messageSpan, .ACA_Message_Notice').first().text());
    if (msg) out.message = msg.slice(0, 300);
    if (!table.length) return out;

    // Header: the first row that holds <th> cells or has a header class, and is not a data row.
    const rowsAll = table.find('tr').toArray();
    let headerCells = [];
    for (const tr of rowsAll) {
        const $tr = $(tr);
        if ($tr.is('.ACA_TabRow_Odd, .ACA_TabRow_Even')) break;
        const ths = $tr.children('th');
        const isHeader = ths.length > 0 || /header/i.test($tr.attr('class') ?? '');
        if (isHeader) {
            headerCells = $tr.children('th, td').toArray().map((c) => clean($(c).text()));
            break;
        }
    }
    out.headers = headerCells;
    const keys = headerCells.map(headerKey);

    table.find('tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even').each((_, tr) => {
        const $tr = $(tr);
        const tds = $tr.children('td').toArray();
        if (!tds.length) return;
        const cells = tds.map((td) => clean($(td).text()));
        const byKey = {};
        // Header and data rows can differ by a leading checkbox cell; align from the right when lengths differ.
        const offset = keys.length && cells.length !== keys.length ? cells.length - keys.length : 0;
        keys.forEach((k, i) => {
            const v = cells[i + offset];
            if (k && v !== undefined && v !== '' && byKey[k] === undefined) byKey[k] = v;
        });
        const link = $tr.find('a[id*="hlPermitNumber"], a[href*="CapDetail.aspx"]').first();
        const href = link.attr('href');
        if (!byKey.recordNumber && link.length) byKey.recordNumber = clean(link.text());
        out.rows.push({
            cells,
            byKey,
            detailHref: href && !/^javascript:/i.test(href) ? new URL(href.replace(/&amp;/g, '&'), baseUrl).href : null,
        });
    });

    // Pager: current page + the __doPostBack target of "Next" (or of page current+1).
    const pager = $('table.aca_pagination, .aca_pagination, tr.ACA_Pagination, table.ACA_GridPaging, [id*="gdvPermitList_pager"], [id*="PermitList_gdvPermitList_pager"]');
    const scope = pager.length ? pager : table;
    const cur = parseInt(clean(scope.find('span.SelectedPageButton, .SelectedPageButton').first().text()), 10);
    out.currentPage = Number.isFinite(cur) ? cur : null;
    scope.find('a[href*="__doPostBack"]').each((_, a) => {
        if (out.nextTarget) return;
        const label = clean($(a).text()).toLowerCase();
        const pb = postBackTarget($(a).attr('href'));
        if (!pb) return;
        if (/^next\b|^next\s*>|›|»/.test(label) || label === '>') {
            out.nextTarget = pb.target;
            out.nextArgument = pb.argument;
        }
    });
    if (!out.nextTarget && out.currentPage) {
        scope.find('a[href*="__doPostBack"]').each((_, a) => {
            if (out.nextTarget) return;
            if (parseInt(clean($(a).text()), 10) === out.currentPage + 1) {
                const pb = postBackTarget($(a).attr('href'));
                out.nextTarget = pb?.target ?? null;
                out.nextArgument = pb?.argument ?? '';
            }
        });
    }

    // "Download results" / export link (ACA grids offer a CSV export on many portals).
    $('a[href*="__doPostBack"]').each((_, a) => {
        if (out.exportTarget) return;
        const id = $(a).attr('id') ?? '';
        const label = clean($(a).text());
        if (/btnExport/i.test(id) || /^download results?$|^export/i.test(label)) out.exportTarget = postBackTarget($(a).attr('href'))?.target ?? null;
    });
    return out;
}

/** True when the page is a record detail page (ACA opens it directly when a search matches exactly one record). */
export const isDetailPage = (html) => /id="ctl00_PlaceHolderMain_lblPermitNumber"/.test(String(html ?? ''));

// ─────────────────────────────── detail page ───────────────────────────────

/** Text of an element with <br>, rows, cells and divs turned into line breaks. Returns non-empty lines. */
function blockLines($, el) {
    const h = $(el).html() ?? '';
    const withBreaks = h
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(tr|div|p|li|h\d)>/gi, '\n')
        .replace(/<\/td>/gi, ' ');
    const text = cheerio.load(`<div>${withBreaks}</div>`)('div').first().text();
    return text.split('\n').map((l) => stripStar(l)).filter(Boolean);
}

const PHONE_RE = /(\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
const LICENSE_WORDS = /\b(licen[cs]e|lic\.?|contractor|certified|registered|registration|cert\.?)\b/i;
const BUSINESS_WORDS = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co\.?|company|ltd|lp|llp|pllc|pc|group|services?|construction|contracting|contractors?|builders?|building|roofing|solar|pools?|spas?|electric(al)?|plumbing|mechanical|air|heating|cooling|hvac|homes?|enterprises?|industries|energy|design|remodel(ing)?|restoration|systems|development)\b/i;
const CITY_STATE_ZIP_RE = /^(.*?)[,\s]+([A-Z]{2})[,\s]+(\d{5})(?:-\d{4})?\s*$/i;

export const formatPhone = (s) => {
    const m = String(s ?? '').match(PHONE_RE);
    return m ? `(${m[2]}) ${m[3]}-${m[4]}` : null;
};

/** Parses a contact block (Applicant / Licensed Professional / Owner) into its parts. */
export function parseContactLines(lines) {
    const res = { name: null, company: null, address: null, phone: null, email: null, license: null, licenseType: null, lines };
    const rest = [];
    for (const raw of lines) {
        const l = clean(raw);
        if (!l) continue;
        const email = l.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
        if (email && !res.email) {
            res.email = email[0];
            continue;
        }
        if (/(phone|tel|cell|mobile|fax)\s*\d*\s*:/i.test(l) || (PHONE_RE.test(l) && l.replace(/[\d\s().+-]/g, '').length <= 12 && !/^\d+\s+\w+\s+\w+/.test(l.replace(/[()]/g, '')))) {
            if (!/fax/i.test(l) && !res.phone) res.phone = formatPhone(l);
            else if (!/fax/i.test(l) && !PHONE_RE.test(l)) rest.push(l);
            continue;
        }
        if (LICENSE_WORDS.test(l) && /[A-Z]{0,5}\d{3,}/i.test(l) && !res.license) {
            const m = l.match(/^(.*?)[\s:#]+([A-Z]{0,5}[-\s]?\d[\w-]*)\s*$/i);
            if (m) {
                res.licenseType = clean(m[1]).replace(/[:#-]+$/, '').trim() || null;
                res.license = clean(m[2]);
            } else res.license = l;
            continue;
        }
        rest.push(l);
    }
    // Address = the line with CITY, ST ZIP plus the street line(s) before it.
    const cszIdx = rest.findIndex((l) => CITY_STATE_ZIP_RE.test(l));
    let addrStart = cszIdx;
    if (cszIdx > 0) {
        addrStart = cszIdx;
        while (addrStart > 0 && /^(\d+\s|p\.?\s?o\.?\s*box|c\/o\s|suite|ste\.?\s|apt|unit|#|\d+$)/i.test(rest[addrStart - 1])) addrStart--;
        if (addrStart === cszIdx && cszIdx >= 2) addrStart = cszIdx - 1;
        res.address = rest.slice(addrStart, cszIdx + 1).join(', ');
    }
    const head = cszIdx >= 0 ? rest.slice(0, Math.max(0, addrStart)) : rest;
    if (head.length) {
        res.name = head[0];
        const biz = head.slice(1).find((l) => !/^\d/.test(l));
        if (biz) res.company = biz;
    }
    if (!res.company && res.name && BUSINESS_WORDS.test(res.name)) res.company = res.name;
    delete res.lines;
    return res;
}

const MONEY_RE = /\$?\s*(-?[\d,]+(?:\.\d+)?)/;
const parseMoney = (s) => {
    const m = String(s ?? '').replace(/\s/g, '').match(MONEY_RE);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};

const VALUATION_LABEL = /(job value|valuation|construction (cost|value)|project (cost|value)|declared value|estimated (cost|value)|cost of (construction|work|improvement)|contract (amount|value|price)|value of work)/i;

/** Parses CapDetail.aspx into a flat object. */
export function parseDetail(html, url = null) {
    const $ = cheerio.load(String(html ?? ''));
    const out = {
        recordNumber: clean($('#ctl00_PlaceHolderMain_lblPermitNumber').text()) || null,
        recordType: clean($('#ctl00_PlaceHolderMain_lblPermitType').text()) || null,
        status: clean($('#ctl00_PlaceHolderMain_lblRecordStatus').text()) || null,
        address: null,
        description: null,
        projectName: null,
        valuation: null,
        applicant: null,
        contractor: null,
        owner: null,
        parcelNumber: null,
        moreDetails: {},
        detailUrl: url,
    };
    const loc = $('#tbl_worklocation').first();
    if (loc.length) out.address = blockLines($, loc).join(', ').replace(/\s*,\s*,/g, ',') || null;

    // Main blocks: td.td_parent_left > div > h1 (label) + span (content).
    $('#divPermitDetailInfo td.td_parent_left, [id$="PermitDetailList1_updatePanel"] td.td_parent_left, td.td_parent_left').each((_, td) => {
        const label = clean($(td).find('h1').first().text()).replace(/:$/, '').toLowerCase();
        if (!label) return;
        const content = $(td).find('h1').first().nextAll().toArray();
        const lines = content.flatMap((c) => blockLines($, c));
        if (!lines.length) return;
        if (/^(project )?description|^work description|^job description/.test(label) && !out.description) out.description = lines.join(' ');
        else if (/^applicant/.test(label) && !out.applicant) out.applicant = parseContactLines(lines);
        else if (/licensed professional|^contractor/.test(label) && !out.contractor) out.contractor = parseContactLines(lines);
        else if (/^owner/.test(label) && !out.owner) out.owner = parseContactLines(lines);
        else if (/^project name/.test(label)) out.projectName = lines.join(' ');
    });

    // "More Details" label/value pairs (Additional Information, Application Information, ...).
    $('.MoreDetail_ItemCol1').each((_, c1) => {
        const label = clean($(c1).text()).replace(/:$/, '');
        const val = clean($(c1).next('.MoreDetail_ItemCol2').text());
        if (label && val && !(label in out.moreDetails)) out.moreDetails[label] = val.slice(0, 500);
    });
    for (const [label, val] of Object.entries(out.moreDetails)) {
        if (VALUATION_LABEL.test(label)) {
            const n = parseMoney(val);
            if (n !== null) {
                out.valuation = n;
                break;
            }
        }
    }
    if (out.valuation === null) {
        const m = clean($('body').text()).match(/Total Job Valuation\s*:?\s*\$\s*([\d,]+(?:\.\d+)?)/i);
        if (m) out.valuation = parseMoney(m[1]);
    }
    const parcel = clean($('[id$="palParceList"]').text()).match(/Parcel\s+Number\s*:\s*([A-Z0-9._-]+)/i);
    if (parcel) out.parcelNumber = parcel[1];
    return out;
}

// ─────────────────────────────── CSV ───────────────────────────────

/** RFC 4180 CSV parser (quotes, doubled quotes, CR/LF). Returns an array of rows. */
export function parseCsv(text) {
    const s = String(text ?? '').replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let q = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (q) {
            if (ch === '"') {
                if (s[i + 1] === '"') {
                    field += '"';
                    i++;
                } else q = false;
            } else field += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') {
            row.push(field);
            field = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && s[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else field += ch;
    }
    if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter((r) => r.some((c) => clean(c) !== ''));
}

/** Maps CSV export rows to { byKey } objects like grid rows. Returns null when the CSV does not look like an ACA export. */
export function csvToRows(text) {
    const rows = parseCsv(text);
    if (rows.length < 1) return null;
    const keys = rows[0].map(headerKey);
    if (!keys.includes('recordNumber')) return null;
    return rows.slice(1).map((cells) => {
        const byKey = {};
        keys.forEach((k, i) => {
            const v = clean(cells[i]);
            if (k && v && byKey[k] === undefined) byKey[k] = v;
        });
        return { cells: cells.map(clean), byKey, detailHref: null };
    }).filter((r) => r.byKey.recordNumber);
}

/**
 * Finds a follow-up export/download URL in an HTML or async-postback response (pageRedirect / window.open /
 * location / link). Only URLs whose file name or query mentions export/download/csv count.
 */
export function findExportUrl(text, baseUrl) {
    const s = String(text ?? '');
    const patterns = [
        /pageRedirect\|\|([^|]+)\|/gi,
        /window\.open\(\s*['"]([^'"]+)['"]/gi,
        /(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/gi,
        /(?:href|src)=["']([^"']+\.(?:ashx|aspx|csv)(?:\?[^"']*)?)["']/gi,
    ];
    for (const re of patterns) {
        for (const m of s.matchAll(re)) {
            let u;
            try {
                u = new URL(decodeURIComponent(m[1]).replace(/&amp;/g, '&'), baseUrl);
            } catch {
                continue;
            }
            const file = u.pathname.split('/').pop();
            if (/export|download|csv/i.test(file) || /(?:^|[?&])(?:flag|format|type)=csv\b/i.test(u.search)) return u.href;
        }
    }
    return null;
}
