// HTML builders for the mock ACA portal.
//
// CapDetail pages are the REAL Louisville page (capdetail-ljcmg-real.html) with the record values swapped and an
// Applicant / Licensed Professional row and an "Additional Information" (Job Value) block added in the same markup
// style (td.td_parent_left > div > h1 + span.ACA_SmLabel; MoreDetail_ItemCol1/2).
//
// CapHome pages (search form + results grid) are RECONSTRUCTED: no raw CapHome HTML was available. They follow what
// working scrapers rely on:
//   - jbkcreator/Forced-action- pinellas_violations_engine.py (HTTP postbacks against aca-prod.accela.com/PINELLAS):
//     form field names ctl00$PlaceHolderMain$generalSearchForm$txtGSStartDate/txtGSEndDate/txtGSPermitNumber/
//     txtGSStreetName/txtGSCity/txtGSParcelNo/ddlGSDirection/ddlGSStreetSuffix, __EVENTTARGET
//     ctl00$PlaceHolderMain$btnNewSearch, hidden __VIEWSTATE/__VIEWSTATEGENERATOR/__VIEWSTATEENCRYPTED, data rows
//     tr.ACA_TabRow_Odd/Even with a leading non-data cell, pager table.aca_pagination + span.SelectedPageButton +
//     __doPostBack('…') links, "Next" link on the last page missing.
//   - browserless.io skill (aca-prod.accela.com): #ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList,
//     a[id*=hlPermitNumber], ddlGSPermitType, ddlGSSubAgency.
//   - Forced-action docs: CSV export columns = grid columns (Date, Record Number, Record Type, Description,
//     Project Name, Status, Address, Expiration Date for Pinellas Building); "#divGlobalLoadingMask".
//   - the real CapDetail page: ACA_CS_FIELD hidden field, no __EVENTVALIDATION, form#aspnetForm.
import { readFileSync } from 'node:fs';

const REAL_DETAIL = readFileSync(new URL('./capdetail-ljcmg-real.html', import.meta.url), 'utf8');

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const hidden = ({ viewstate, csField }) => `
<div class="aspNetHidden">
<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />
<input type="hidden" name="__EVENTARGUMENT" id="__EVENTARGUMENT" value="" />
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${esc(viewstate)}" />
</div>
<script type="text/javascript">
//<![CDATA[
var theForm = document.forms['aspnetForm'];
function __doPostBack(eventTarget, eventArgument) {
    if (!theForm.onsubmit || (theForm.onsubmit() != false)) {
        theForm.__EVENTTARGET.value = eventTarget;
        theForm.__EVENTARGUMENT.value = eventArgument;
        theForm.submit();
    }
}
//]]>
</script>`;

const hiddenTail = ({ csField }) => `
<span style="display: none !important;"><input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="A1B2C3D4" /></span>
<span style="display: none !important;"><input type="hidden" name="__VIEWSTATEENCRYPTED" id="__VIEWSTATEENCRYPTED" value="" /></span>
<span style="display: none !important;"><input type="hidden" name="ACA_CS_FIELD" id="ACA_CS_FIELD" value="${esc(csField)}" /></span>`;

const P = 'ctl00$PlaceHolderMain$generalSearchForm$';
const I = 'ctl00_PlaceHolderMain_generalSearchForm_';

function searchForm({ start = '', end = '', recordTypes = [], selectedType = '', captcha = false }) {
    const opts = [['', '--Select--'], ...recordTypes.map((t) => [t.value, t.text])]
        .map(([v, t]) => `<option${v === selectedType ? ' selected="selected"' : ''} value="${esc(v)}">${esc(t)}</option>`).join('');
    return `
<div id="ctl00_PlaceHolderMain_generalSearchForm" class="ACA_FLeft">
 <table role="presentation"><tr>
  <td><label for="${I}txtGSPermitNumber">Record Number:</label><input name="${P}txtGSPermitNumber" type="text" maxlength="50" id="${I}txtGSPermitNumber" class="ACA_NLonger" /></td>
  <td><label for="${I}ddlGSPermitType">Record Type:</label><select name="${P}ddlGSPermitType" id="${I}ddlGSPermitType" class="ACA_XLong">${opts}</select></td>
 </tr><tr>
  <td><label for="${I}txtGSProjectName">Project Name:</label><input name="${P}txtGSProjectName" type="text" id="${I}txtGSProjectName" /></td>
 </tr><tr>
  <td><label for="${I}txtGSStartDate">Start Date:</label><input name="${P}txtGSStartDate" type="text" value="${esc(start)}" maxlength="10" id="${I}txtGSStartDate" class="ACA_NShot" title="MM/DD/YYYY" />
      <input type="hidden" name="${P}txtGSStartDate_ext_ClientState" id="${I}txtGSStartDate_ext_ClientState" /></td>
  <td><label for="${I}txtGSEndDate">End Date:</label><input name="${P}txtGSEndDate" type="text" value="${esc(end)}" maxlength="10" id="${I}txtGSEndDate" class="ACA_NShot" title="MM/DD/YYYY" />
      <input type="hidden" name="${P}txtGSEndDate_ext_ClientState" id="${I}txtGSEndDate_ext_ClientState" /></td>
 </tr><tr>
  <td><label>Street No.:</label><input name="${P}txtGSNumber$ChildControl0" type="text" id="${I}txtGSNumber_ChildControl0" /><input name="${P}txtGSNumber$ChildControl1" type="text" id="${I}txtGSNumber_ChildControl1" /></td>
  <td><label>Direction:</label><select name="${P}ddlGSDirection" id="${I}ddlGSDirection"><option selected="selected" value="">--Select--</option><option value="N">N</option><option value="S">S</option></select></td>
  <td><label>Street Name:</label><input name="${P}txtGSStreetName" type="text" id="${I}txtGSStreetName" /></td>
  <td><label>Street Type:</label><select name="${P}ddlGSStreetSuffix" id="${I}ddlGSStreetSuffix"><option selected="selected" value="">--Select--</option><option value="AVE">AVE</option><option value="ST">ST</option></select></td>
  <td><label>City:</label><input name="${P}txtGSCity" type="text" id="${I}txtGSCity" /></td>
  <td><label>Parcel No.:</label><input name="${P}txtGSParcelNo" type="text" id="${I}txtGSParcelNo" /></td>
 </tr></table>
 ${captcha ? '<div class="g-recaptcha" data-sitekey="6Lc_TEST"></div><script src="https://www.google.com/recaptcha/api.js"></script>' : ''}
</div>
<div class="ACA_TabRow">
 <a id="ctl00_PlaceHolderMain_btnNewSearch" class="ACA_LgButton ACA_LgButton_FontSize" href="javascript:__doPostBack('ctl00$PlaceHolderMain$btnNewSearch','')"><span>Search</span></a>
 <a id="ctl00_PlaceHolderMain_btnResetSearch" href="javascript:__doPostBack('ctl00$PlaceHolderMain$btnResetSearch','')"><span>Clear</span></a>
</div>`;
}

/** Full CapHome.aspx page. `results` is the HTML of the results area (grid, "no results" message or nothing). */
export function capHomePage({ agency, module, viewstate, csField, start, end, recordTypes, selectedType, captcha, results = '', modules = ['Home', 'Building', 'Enforcement', 'Planning'] }) {
    const tabs = modules.map((m) => `<li><a href="/${agency}/Cap/CapHome.aspx?module=${m}&amp;TabName=${m}" title="${m}">${m}</a></li>`).join('');
    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html ng-app="appAca" xmlns="http://www.w3.org/1999/xhtml" lang="en-US"><head id="ctl00_Head1"><title>
        Search for Records - Accela Citizen Access
</title><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /></head>
<body>
<form name="aspnetForm" method="post" action="./CapHome.aspx?module=${module}&amp;TabName=${module}" onsubmit="javascript:return WebForm_OnSubmit();" id="aspnetForm">
${hidden({ viewstate, csField })}
<div id="divGlobalLoadingMask" class="ACA_Hide"></div>
<div class="ACA_TabRow"><ul id="ctl00_HeaderNavigation_tabs">${tabs}</ul></div>
<div id="ctl00_PlaceHolderMain_dvSearchForm">
<h1><span id="ctl00_PlaceHolderMain_lblSearchInstruction">General Search</span></h1>
${searchForm({ start, end, recordTypes, selectedType, captcha })}
</div>
<div id="ctl00_PlaceHolderMain_dgvPermitList_updatePanel">${results}</div>
${hiddenTail({ csField })}
</form>
</body></html>`;
}

const LINK = (agency, module, r) => `/${agency}/Cap/CapDetail.aspx?Module=${module}&amp;TabName=${module}&amp;capID1=${r.capID1}&amp;capID2=00000&amp;capID3=${r.capID3}&amp;agencyCode=${agency}&amp;IsToShowInspection=`;

/** Cell HTML for one column of one record, in ACA's grid style. */
function cell(col, r, idx, agency, module) {
    const ctl = `ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList_ctl${String(idx + 3).padStart(2, '0')}`;
    switch (col) {
        case '': return `<td style="width:25px;"><div class="ACA_CapListStyle"><input id="${ctl}_ckbSelect" type="checkbox" name="${ctl.replace(/_/g, '$')}$ckbSelect" /></div></td>`;
        case 'Date': return `<td><div id="${ctl}_lblUpdatedTime_div" class="ACA_CapListStyle"><span id="${ctl}_lblUpdatedTime">${r.date}</span></div></td>`;
        case 'Record Number': return `<td><div class="ACA_CapListStyle"><a id="${ctl}_hlPermitNumber" href="${LINK(agency, module, r)}"><strong><span id="${ctl}_lblPermitNumber1">${esc(r.number)}</span></strong></a></div></td>`;
        case 'Record Type': return `<td><div class="ACA_CapListStyle"><span id="${ctl}_lblType">${esc(r.type)}</span></div></td>`;
        case 'Description': return `<td><div class="ACA_CapListStyle"><span id="${ctl}_lblDescription">${esc(r.description)}</span></div></td>`;
        case 'Project Name': return `<td><div class="ACA_CapListStyle"><span id="${ctl}_lblProjectName">${esc(r.projectName ?? '')}</span></div></td>`;
        case 'Status': return `<td><div class="ACA_CapListStyle"><span id="${ctl}_lblStatus">${esc(r.status)}</span></div></td>`;
        case 'Address': return `<td><div class="ACA_CapListStyle"><span id="${ctl}_lblAddress">${esc(r.address)}</span></div></td>`;
        case 'Expiration Date': return `<td><div class="ACA_CapListStyle"><span id="${ctl}_lblExpirationDate">${r.expiration ?? ''}</span></div></td>`;
        case 'Short Notes': return `<td><div class="ACA_CapListStyle"><span id="${ctl}_lblShortNote"></span></div></td>`;
        case 'Related Records': return `<td><div class="ACA_CapListStyle"><span id="${ctl}_lblRelatedRecords"></span></div></td>`;
        case 'Action': return `<td><div class="ACA_CapListStyle"><a id="${ctl}_btnAction" href="#">Pay Fees Due</a></div></td>`;
        default: return '<td></td>';
    }
}

/**
 * Results grid for one page. `pager`: { page, pages, targets: {page: target}, nextTarget }.
 */
export function resultsGrid({ agency, module, columns, rows, pager, total, exportTarget }) {
    const header = columns.map((c, i) => (c === ''
        ? '<th scope="col" style="width:25px;"><input id="ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList_ctl02_chkAll" type="checkbox" /></th>'
        : `<th scope="col"><div class="ACA_Header_Row"><a id="ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList_ctl02_lnk${i}Header" href="javascript:__doPostBack('ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl02$lnk${i}Header','')"><span>${esc(c)}</span></a></div></th>`)).join('');
    const body = rows.map((r, i) => `<tr class="${i % 2 ? 'ACA_TabRow_Even ACA_TabRow_Even_FontSize' : 'ACA_TabRow_Odd ACA_TabRow_Odd_FontSize'}">${columns.map((c) => cell(c, r, i, agency, module)).join('')}</tr>`).join('\n');
    const from = (pager.page - 1) * 10 + 1;
    const to = from + rows.length - 1;
    let pagerHtml = '';
    if (pager.pages > 1) {
        const links = [];
        if (pager.page > 1) links.push(`<td><a href="javascript:__doPostBack('${pager.prevTarget}','')" class="aca_simple_text font11px">&lt; Prev</a></td>`);
        for (let p = 1; p <= pager.pages; p++) {
            links.push(p === pager.page
                ? `<td><span class="SelectedPageButton font11px">${p}</span></td>`
                : `<td><a href="javascript:__doPostBack('${pager.targets[p]}','')" class="aca_simple_text font11px">${p}</a></td>`);
        }
        if (pager.page < pager.pages) links.push(`<td><a href="javascript:__doPostBack('${pager.nextTarget}','')" class="aca_simple_text font11px">Next &gt;</a></td>`);
        pagerHtml = `<tr class="ACA_Table_Pages ACA_Table_Pages_FontSize"><td colspan="${columns.length}"><table class="aca_pagination" border="0"><tr>${links.join('')}</tr></table></td></tr>`;
    }
    const exportHtml = exportTarget
        ? `<a id="ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList_gdvPermitListtop4btnExport" class="ACA_LinkButton" href="javascript:__doPostBack('${exportTarget}','')">Download results</a>`
        : '';
    return `
<div class="ACA_Grid_OverFlow">
 <div class="ACA_TabRow ACA_Page ACA_Page_FontSize"><span class="ACA_PageCounts">Showing ${from}-${to} of ${total}</span> ${exportHtml}</div>
 <table class="ACA_GridView ACA_Grid_Caption" cellspacing="0" rules="all" border="0" id="ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList" style="width:100%;border-collapse:collapse;">
  <caption>Records</caption>
  <tr class="ACA_TabRow_Header ACA_TabRow_Header_FontSize">${header}</tr>
  ${body}
  ${pagerHtml}
 </table>
</div>`;
}

export const noResults = () => '<div class="ACA_TabRow"><span id="ctl00_PlaceHolderMain_lblNoRecords" class="ACA_Message_Notice">Your search returned no results.</span></div>';

/** ACA's generic error page (seen on bad/expired postbacks). Markup of the title span is from the real ACA page. */
export const errorPage = () => `<!DOCTYPE html><html><head><title>Accela Citizen Access</title></head><body><form name="aspnetForm" id="aspnetForm" method="post" action="./Error.aspx">
<div class="ACA_Error"><span id="ctl00_PlaceHolderMain_systemErrorMessage_lblMessageTitle" class="ACA_Show">An error has occurred.</span>
<div id="ctl00_PlaceHolderMain_systemErrorMessage_divMessage">Your session may have expired. Please return to the home page.</div></div></form></body></html>`;

const contactTd = (label, lines) => `
			<td class="td_parent_left"><div>
				<h1 style="font-size:1.4em;"><span id="ctl00_PlaceHolderMain_PermitDetailList1_per_permitDetail_label_${label.toLowerCase().replace(/\W/g, '')}639230474497359606">${label}:</span></h1><span class="ACA_SmLabel ACA_SmLabel_FontSize"><table role="presentation" style="TEMPLATE_STYLE" class="table_child"><tbody><tr><td class="td_child_left font12px"></td><td class="NotBreakWord">${lines.join('<br>')}<br></td></tr></tbody></table></span>
			</div></td>`;

const moreItem = (label, value) => `<div class="MoreDetail_ItemCol MoreDetail_ItemCol1"><span class="ACA_SmLabelBolder font11px">${esc(label)}:</span></div><div class="MoreDetail_ItemCol MoreDetail_ItemCol2"><span class="ACA_SmLabel ACA_SmLabel_FontSize">${esc(value)}</span></div>`;

/** CapDetail page for a mock building permit, built from the real LJCMG page. */
export function capDetailPage(r) {
    let h = REAL_DETAIL;
    const swap = (from, to) => {
        if (!h.includes(from)) throw new Error(`fixture template changed: "${from.slice(0, 60)}" not found`);
        h = h.replace(from, to);
    };
    swap('<span id="ctl00_PlaceHolderMain_lblPermitNumber" dir="ltr">ENF-PMNT-24-012338</span>', `<span id="ctl00_PlaceHolderMain_lblPermitNumber" dir="ltr">${esc(r.number)}</span>`);
    swap('<span id="ctl00_PlaceHolderMain_lblPermitType" class="span-permittype">Property Maintenance Case</span>', `<span id="ctl00_PlaceHolderMain_lblPermitType" class="span-permittype">${esc(r.type)}</span>`);
    swap('<span id="ctl00_PlaceHolderMain_lblRecordStatus">Hearing</span>', `<span id="ctl00_PlaceHolderMain_lblRecordStatus">${esc(r.status)}</span>`);
    const [street, csz] = r.addressLines;
    swap('<span class="fontbold"> 100 SAMPLE AVE</span><br> LOUISVILLE KY 40212 ', `<span class="fontbold"> ${esc(street)}</span><br> ${esc(csz)} `);
    swap('Citizen reports the grass is knee high and there are rodents and stray cats running in the yard.', esc(r.description));
    swap('SAMPLE OWNER TRUST', esc(r.owner.name));
    swap('100 EXAMPLE PKWY PMB 1', esc(r.owner.street));
    swap('LOUISVILLE KY 40222-0000 ', `${esc(r.owner.csz)} `);
    // Applicant + Licensed Professional row, same markup as the Description/Owner row.
    const c = r.contractor;
    const lpLines = [esc(c.person), esc(c.company), esc(c.street), esc(c.csz), `Work Phone:<div class="ACA_PhoneNumberLTR">${esc(c.phone)}</div>`, `${esc(c.licenseType)} ${esc(c.license)}`];
    const apLines = [esc(r.applicant.name), esc(r.applicant.company), `Home Phone:<div class="ACA_PhoneNumberLTR">${esc(r.applicant.phone)}</div>`, `E-mail:${esc(r.applicant.email)}`];
    swap('	</tbody></table>\n	\n</div>', `<tr class="ACA_FLeft" style="margin-bottom:5px">${contactTd('Applicant', apLines)}${contactTd('Licensed Professional', lpLines)}
		</tr>
	</tbody></table>

</div>`);
    // Replace the Application Information Table content with "Additional Information" style items.
    const items = [['Job Value($)', r.valuationText], ['Number of Stories', '1'], ['Owner Phone', '(727) 555-0100'], ['Construction Type', 'V-B']]
        .filter(([, v]) => v !== null && v !== undefined);
    let first = true;
    h = h.replace(/(<td width="100%" class="ACA_AlignLeftOrRight"><div class="MoreDetail_Item">)[\s\S]*?(<\/div><\/td>)/g, (_, a, b) => {
        const out = `${a}${first ? items.map(([l, v]) => moreItem(l, v)).join('') : ''}${b}`;
        first = false;
        return out;
    });
    h = h.replace('DISTRICT COURT RESULTS', 'ADDITIONAL INFORMATION');
    h = h.replace('Parcel Number:011B00630000', `Parcel Number:${esc(r.parcel)}`);
    return h;
}
