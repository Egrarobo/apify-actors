// Validates .actor/input_schema.json with the official Apify validator.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2019.js';
import { validateInputSchema } from '@apify/input_schema';

const schema = JSON.parse(readFileSync(new URL('../.actor/input_schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false });
validateInputSchema(ajv, schema);
const missing = Object.entries(schema.properties).filter(([, p]) => !p.description).map(([k]) => k);
if (missing.length) throw new Error(`Fields without description: ${missing.join(', ')}`);
console.log(`Input schema OK (${Object.keys(schema.properties).length} fields, all with descriptions).`);
