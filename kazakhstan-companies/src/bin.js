// Kazakhstan BIN (business identification number) parsing, checksum and structure decoding.
//
// Structure (Rules for forming IIN/BIN, Order of the Government of RK, 2023; summarized at
// https://www.zakon.kz/pravo/6398981-pravila-formirovaniya-iin-i-bin-utverdili-v-kazakhstane.html):
//   digits 1-4  : year (2 digits) and month of registration, YYMM
//   digit 5     : 4 = resident legal entity, 5 = non-resident legal entity,
//                 6 = individual entrepreneur in joint entrepreneurship (0-3 = IIN of a person)
//   digit 6     : 0 = head office, 1 = branch, 2 = representative office,
//                 4 = peasant/farm enterprise in joint entrepreneurship
//   digits 7-11 : serial number
//   digit 12    : check digit, mod 11 with weights 1..11; if 10, weights 3..11,1,2; if 10 again, invalid.

const W1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const W2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];

const ENTITY_TYPES = {
    4: 'resident_legal_entity',
    5: 'non_resident_legal_entity',
    6: 'joint_individual_entrepreneurship',
};
const UNIT_TYPES = {
    0: 'head_office',
    1: 'branch',
    2: 'representative_office',
    4: 'peasant_farm_joint_entrepreneurship',
};

/** Check digit for the first 11 digits, or null if the number cannot be valid (both passes give 10). */
export function checkDigit(first11) {
    const d = [...first11].map(Number);
    let sum = d.reduce((s, x, i) => s + x * W1[i], 0) % 11;
    if (sum === 10) {
        sum = d.reduce((s, x, i) => s + x * W2[i], 0) % 11;
        if (sum === 10) return null;
    }
    return sum;
}

/** Strips spaces, dashes and dots. Returns the cleaned string (may still be invalid). */
export function cleanBin(raw) {
    return String(raw ?? '').replace(/[\s\-.]/g, '');
}

/**
 * Validates a BIN. Returns { bin, valid, error?, info? }.
 * `valid` requires 12 digits, a legal-entity 5th digit (4, 5 or 6), a plausible month and a correct check digit.
 */
export function parseBin(raw) {
    const bin = cleanBin(raw);
    if (!/^\d{12}$/.test(bin)) {
        return { bin, valid: false, error: 'A BIN must be exactly 12 digits.' };
    }
    const month = Number(bin.slice(2, 4));
    const typeDigit = Number(bin[4]);
    if (typeDigit <= 3) {
        return { bin, valid: false, error: 'This looks like an IIN (personal identification number of an individual), not a BIN: the 5th digit of a BIN is 4, 5 or 6. Individuals are not looked up by this Actor.' };
    }
    if (!ENTITY_TYPES[typeDigit]) {
        return { bin, valid: false, error: `Invalid BIN: the 5th digit must be 4, 5 or 6 (got ${typeDigit}).` };
    }
    if (month < 1 || month > 12) {
        return { bin, valid: false, error: `Invalid BIN: digits 3-4 must be the registration month 01-12 (got ${bin.slice(2, 4)}).` };
    }
    const cd = checkDigit(bin.slice(0, 11));
    if (cd === null || cd !== Number(bin[11])) {
        return { bin, valid: false, error: 'Invalid BIN: the check digit (12th digit) does not match. Check for a typo.' };
    }
    return { bin, valid: true, info: decodeBin(bin) };
}

/**
 * Human-readable structure of a (valid) BIN. The century is not encoded: a two-digit year later than the
 * current year is read as 19xx (older entities received BINs based on their original registration date).
 */
export function decodeBin(bin, now = new Date()) {
    const yy = Number(bin.slice(0, 2));
    const year = yy > now.getUTCFullYear() % 100 ? 1900 + yy : 2000 + yy;
    return {
        registrationYearMonth: `${year}-${bin.slice(2, 4)}`,
        entityType: ENTITY_TYPES[Number(bin[4])] ?? 'unknown',
        unitType: UNIT_TYPES[Number(bin[5])] ?? 'other',
    };
}
