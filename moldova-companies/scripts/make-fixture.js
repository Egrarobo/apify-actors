// Builds small, FICTIONAL test fixtures that mimic the official ASP file layout
// (title rows above the header, Romanian column names; CSV variant with Russian headers).
// All company names, IDNOs and people below are invented.
import fs from 'node:fs';
import ExcelJS from 'exceljs';

const out = new URL('../test/fixtures/', import.meta.url);
fs.mkdirSync(out, { recursive: true });

const HEADER_RO = ['Nr.', 'IDNO/Cod fiscal', 'Data înregistrării', 'Denumirea completă', 'Forma org./jur.', 'Adresa',
    'Lista conducătorilor', 'Lista fondatorilor', 'Genuri de activitate nelicențiate', 'Genuri de activitate licențiate', 'Statutul', 'Data lichidării'];

const d = (s) => { const [dd, mm, yy] = s.split('.'); return new Date(Date.UTC(+yy, +mm - 1, +dd)); };

const ROWS = [
    ['1003600000011', d('12.03.2003'), 'ȚARA VERDE AGRO S.R.L.', 'Societate cu răspundere limitată', 'MD-2001, mun. Chișinău, str. Ștefan cel Mare 1', 'Popescu Ion', 'Popescu Ion; Rusu Maria', '01.11 Cultivarea cerealelor; 46.21 Comerț cu ridicata al cerealelor', '', 'Activ', null],
    ['1003600000022', d('05.07.2010'), 'ŞTIINŢA GRUP S.A.', 'Societate pe acțiuni', 'MD-3100, mun. Bălţi, str. Independenţei 5', 'Ciobanu Vasile', 'Ciobanu Vasile', '58.11 Editarea cărţilor', '85.59 Alte forme de învăţământ', 'Activ', null],
    ['1003600000033', d('21.01.2015'), 'ROBO SOFT S.R.L.', 'Societate cu răspundere limitată', 'MD-2004, mun. Chişinău, bd. Dacia 10', 'Munteanu Ana', 'Munteanu Ana; Lupu Dan', '62.01 Activităţi de realizare a softului la comandă; 62.02 Consultanţă în tehnologia informaţiei', '', 'Activ', null],
    ['1003600000044', d('30.09.2018'), 'ROBOSOFT LOGISTICS S.R.L.', 'Societate cu răspundere limitată', 'MD-6801, or. Ialoveni, str. Alexandru cel Bun 3', 'Lupu Dan', 'Lupu Dan', '49.41 Transporturi rutiere de mărfuri', '', 'Lichidat', d('15.02.2022')],
    ['1003600000055', d('14.02.2020'), 'МОЛДАГРОТЕХ S.R.L.', 'Societate cu răspundere limitată', 'MD-3200, mun. Bender, str. Lenin 7', 'Иванов Сергей', 'Иванов Сергей', '28.30 Fabricarea maşinilor şi utilajelor pentru agricultură', '', 'Activ', null],
    ['1003600000066', d('01.06.2021'), 'Î.I. "GHEORGHIȚĂ MARIN"', 'Întreprindere individuală', 'MD-4801, or. Orhei, str. Vasile Lupu 20', 'Gheorghiță Marin', 'Gheorghiță Marin', '47.19 Comerţ cu amănuntul în magazine nespecializate', '', 'Activ', null],
    ['1003600000077', d('11.11.2011'), 'VINĂRIA DE PE DEAL S.R.L.', 'Societate cu răspundere limitată', 'MD-7401, or. Cimișlia, str. Ștefan Vodă 2', 'Rotaru Elena', 'Rotaru Elena; Vin Invest Ltd (Cipru)', '11.02 Fabricarea vinurilor din struguri', '11.02 Fabricarea vinurilor (licenţă)', 'În proces de lichidare', null],
    ['1003600000088', d('03.04.2024'), 'ROBOCODE ACADEMY S.R.L.', 'Societate cu răspundere limitată', 'MD-2012, mun. Chișinău, str. București 45', 'Stratan Mihai', 'Stratan Mihai; Ceban Silvia', '85.59 Alte forme de învăţământ n.c.a.; 62.01 Activităţi de realizare a softului la comandă', '', 'Activ', null],
    ['1003600000099', d('19.08.1996'), 'MOLD-TRANS COMPANIE S.A.', 'Societate pe acțiuni', 'MD-2044, mun. Chișinău, str. Mihai Viteazul 15', 'Țurcanu Petru', 'Statul (Agenția Proprietății Publice)', '49.41 Transporturi rutiere de mărfuri', '', 'Activ', null],
    ['1003600000100', d('07.12.2025'), 'CAFENEAUA LUI ŢURCANU S.R.L.', 'Societate cu răspundere limitată', 'MD-3100, mun. Bălți, str. Ştefan cel Mare 99', 'Țurcanu Ion', 'Țurcanu Ion', '56.10 Restaurante', '', 'Activ', null],
    ['12345', d('01.01.2020'), 'RÂND INVALID S.R.L.', 'Societate cu răspundere limitată', 'Chișinău', '', '', '', '', 'Activ', null],
];

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('company');
ws.addRow(['Date din Registrul de stat al unităţilor de drept privind întreprinderile înregistrate în Republica Moldova']);
ws.addRow(['Informații la data de 15.09.2026']);
ws.addRow(HEADER_RO);
ROWS.forEach((r, i) => {
    const row = ws.addRow([i + 1, ...r]);
    row.getCell(3).numFmt = 'dd.mm.yyyy';
    if (r[10]) row.getCell(13).numFmt = 'dd.mm.yyyy';
});
await wb.xlsx.writeFile(new URL('company-2026.09.15.xlsx', out).pathname);

// CSV variant: Russian headers, string dates, different column order.
const HEADER_RU = ['ИДНО', 'Наименование', 'Организационно-правовая форма', 'Дата регистрации', 'Адрес', 'Руководители', 'Учредители', 'Статус'];
const csvRows = [
    ['1003600000011', 'ȚARA VERDE AGRO S.R.L.', 'Societate cu răspundere limitată', '12.03.2003', 'mun. Chișinău', 'Popescu Ion', 'Popescu Ion; Rusu Maria', 'Activ'],
    ['1003600000055', 'МОЛДАГРОТЕХ S.R.L.', 'Societate cu răspundere limitată', '14.02.2020', 'mun. Bender', 'Иванов Сергей', 'Иванов Сергей', 'Lichidat'],
];
const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
fs.writeFileSync(new URL('company-ru.csv', out), `﻿${[HEADER_RU, ...csvRows].map((r) => r.map(q).join(',')).join('\n')}\n`);
console.log('Fixtures written to test/fixtures/');
