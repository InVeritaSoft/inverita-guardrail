/**
 * Single source of truth for detector category ids, used to validate project
 * exceptions (src/config.mjs) without creating a circular import back into
 * hooks/pre-prompt-guard.mjs (which itself imports src/config.mjs). Kept in
 * sync with the LAYER1/LAYER2 rule arrays there by test/categories.test.mjs.
 *
 * This split is a safety boundary, not just organization: LAYER1_CATEGORIES
 * must never be addable as a project exception (SSN/MRN/DOB/etc. are a hard
 * floor), and every consumer that validates or filters exception categories
 * imports from here rather than duplicating the list.
 */
export const LAYER1_CATEGORIES = [
  'ssn_pattern',
  'mrn_pattern',
  'dob_name_proximity',
  'email_clinical',
  'insurance_policy',
];

export const LAYER2_CATEGORIES = [
  'icd_code',
  'lab_value',
  'medication_dosage',
  'clinical_narrative',
  'age_condition',
];
