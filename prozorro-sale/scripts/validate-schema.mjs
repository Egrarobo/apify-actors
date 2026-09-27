// Validates .actor/input_schema.json with the official @apify/input_schema package.
import fs from 'node:fs';
import Ajv2019 from 'ajv/dist/2019.js';
import { validateInputSchema } from '@apify/input_schema';

const schema = JSON.parse(fs.readFileSync(new URL('../.actor/input_schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2019({ strict: false });
validateInputSchema(ajv, schema);
const missing = Object.entries(schema.properties).filter(([, p]) => !p.description?.trim()).map(([k]) => k);
if (missing.length) throw new Error(`Fields without description: ${missing.join(', ')}`);
console.log(`input_schema.json is valid (${Object.keys(schema.properties).length} fields, all described).`);
