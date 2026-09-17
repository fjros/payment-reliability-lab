import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildOpenApi, OPENAPI_PATH } from '../../src/api/openapi.ts';

describe('published OpenAPI document', () => {
  it('is in sync with the schemas the server validates with (run `npm run openapi`)', async () => {
    expect(JSON.parse(await readFile(OPENAPI_PATH, 'utf8'))).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });

  it('describes amounts as strings and forbids unknown request fields', () => {
    const doc = buildOpenApi() as {
      components: { schemas: { CreateTransfer: { properties: { amountMinor: { type: string } }; additionalProperties: boolean } } };
    };
    expect(doc.components.schemas.CreateTransfer.properties.amountMinor.type).toBe('string');
    expect(doc.components.schemas.CreateTransfer.additionalProperties).toBe(false);
  });
});
