// Validates .actor/input_schema.json with the official @apify/input_schema validator,
// then validates a few sample inputs against it.
import fs from 'node:fs';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { validateInputSchema, validateInputUsingValidator } from '@apify/input_schema';

const schema = JSON.parse(fs.readFileSync(new URL('../.actor/input_schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2019({ strict: false, allErrors: true });
validateInputSchema(ajv, schema);
console.log('Input schema is valid.');

const validator = ajv.compile(schema);
const samples = [
    [{ bins: ['971240001315'] }, true],
    [{ names: ['Kaspi'], language: 'kz', sources: ['registry'] }, true],
    [{ bins: ['971240001315'], language: 'de' }, false],
    [{ bins: ['971240001315'], maxConcurrency: 50 }, false],
    [{ bins: ['971240001315'], sources: ['kgd'] }, false],
];
for (const [input, ok] of samples) {
    const errors = validateInputUsingValidator(validator, schema, input);
    if ((errors.length === 0) !== ok) throw new Error(`Unexpected validation result for ${JSON.stringify(input)}: ${JSON.stringify(errors)}`);
}
console.log(`Sample inputs validated as expected (${samples.length}).`);
