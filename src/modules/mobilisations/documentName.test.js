import { describe, it, expect } from 'vitest';
import { mobilisationDocumentName } from './documentName.js';

const mob = { serialNumber: 'MOB-0013', workerName: 'Ahmed Ali' };

describe('mobilisationDocumentName', () => {
  it('uses what the uploader typed for an Other file and keeps the extension', () => {
    expect(mobilisationDocumentName(mob, 'Other', 'Passport copy', 'scan (1).PDF', new Set())).toBe('MOB-0013_Ahmed Ali_Passport copy.PDF');
  });

  it('uses the category name for Contract and ID Copy', () => {
    expect(mobilisationDocumentName(mob, 'Contract', '', 'a.pdf', new Set())).toBe('MOB-0013_Ahmed Ali_Contract.pdf');
    expect(mobilisationDocumentName(mob, 'IDCopy', '', 'b.jpg', new Set())).toBe('MOB-0013_Ahmed Ali_ID Copy.jpg');
  });

  it('numbers repeats, within one upload and against files already on the record', () => {
    const taken = new Set(['mob-0013_ahmed ali_contract.pdf']);
    expect(mobilisationDocumentName(mob, 'Contract', '', 'a.pdf', taken)).toBe('MOB-0013_Ahmed Ali_Contract (2).pdf');
    expect(mobilisationDocumentName(mob, 'Contract', '', 'b.pdf', taken)).toBe('MOB-0013_Ahmed Ali_Contract (3).pdf');
  });

  it('strips characters a file name cannot hold and keeps Arabic as typed', () => {
    expect(mobilisationDocumentName(mob, 'Other', 'a/b:c*"d', 'x.png', new Set())).toBe('MOB-0013_Ahmed Ali_abcd.png');
    expect(mobilisationDocumentName(mob, 'Other', 'جواز السفر', 'x.png', new Set())).toBe('MOB-0013_Ahmed Ali_جواز السفر.png');
  });

  it('falls back to "Document" when nothing usable was typed', () => {
    expect(mobilisationDocumentName(mob, 'Other', '  ', 'x.pdf', new Set())).toBe('MOB-0013_Ahmed Ali_Document.pdf');
  });
});
