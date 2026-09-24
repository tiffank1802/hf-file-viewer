import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOdbStructure } from '../src/utils/odb.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:db="urn:oasis:names:tc:opendocument:xmlns:database:1.0">
  <office:body><office:database>
    <db:data-source>
      <db:connection-data><db:connection-resource xlink:href="sdbc:embedded:hsqldb"/></db:connection-data>
      <db:table-representations>
        <db:table-representation db:name="clients" db:schema-name="PUBLIC"/>
        <db:table-representation db:name="commandes &amp; lignes" db:columns="42"/>
      </db:table-representations>
      <db:queries>
        <db:query db:name="CA par client" db:command="SELECT * FROM clients"/>
      </db:queries>
    </db:data-source>
    <db:forms><db:component db:name="Saisie client"/></db:forms>
    <db:reports><db:component db:name="Facture"/></db:reports>
  </office:database></office:body>
</office:document-content>`;

const EMPTY = { tables: [], queries: [], forms: [], reports: [], dataSource: null };

test('parseOdbStructure extrait tables, requêtes, formulaires, états et source', () => {
  const structure = parseOdbStructure(SAMPLE);
  assert.deepEqual(structure.tables, ['clients', 'commandes & lignes']);
  assert.deepEqual(structure.queries, ['CA par client']);
  assert.deepEqual(structure.forms, ['Saisie client']);
  assert.deepEqual(structure.reports, ['Facture']);
  assert.equal(structure.dataSource, 'HSQLDB embarquée');
});

test('parseOdbStructure tolère la variante name= sans préfixe db:', () => {
  const structure = parseOdbStructure(
    '<db:table-representation name="t1"/><db:query name="q1"/>',
  );
  assert.deepEqual(structure.tables, ['t1']);
  assert.deepEqual(structure.queries, ['q1']);
  assert.deepEqual(structure.forms, []);
  assert.deepEqual(structure.reports, []);
  assert.equal(structure.dataSource, null);
});

test('parseOdbStructure ne mélange pas formulaires et états', () => {
  const structure = parseOdbStructure(
    '<db:forms><db:component db:name="F1"/><db:component db:name="F2"/></db:forms>'
    + '<db:reports/>',
  );
  assert.deepEqual(structure.forms, ['F1', 'F2']);
  assert.deepEqual(structure.reports, []);
});

test('parseOdbStructure ne plante pas sur entrée vide ou invalide', () => {
  for (const input of ['', null, undefined, 'pas du xml']) {
    assert.deepEqual(parseOdbStructure(input), EMPTY);
  }
});
