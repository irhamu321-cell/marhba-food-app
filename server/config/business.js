/*
 * ============================================================================
 *  YOUR BUSINESS IDENTITY — fill this in before going live
 * ============================================================================
 *
 * These values appear in the Terms of Service, the Privacy Policy, the legal
 * notice and the contact page, in French and in Arabic. They are left empty on
 * purpose: nobody should invent a company name or a registration number for
 * you, and a wrong RC or ICE number in a published policy is a false record.
 *
 * HOW TO FILL IT IN
 *   Either edit the values below, or set the matching environment variable in
 *   your .env file (the environment always wins, so a server can carry its own
 *   details without editing code):
 *
 *       BUSINESS_NAME=...
 *       LEGAL_FORM=...
 *       RC_NUMBER=...
 *       ICE_NUMBER=...
 *       BUSINESS_ADDRESS=...
 *       BUSINESS_CITY=...
 *       BUSINESS_PHONE=...
 *       BUSINESS_EMAIL=...
 *       RESPONSIBLE_PERSON=...
 *
 * WHAT HAPPENS IF YOU LEAVE THEM EMPTY
 *   - In development: the app starts, prints a warning, and the admin panel
 *     shows a banner. The legal pages show a visible "to be completed" mark
 *     where the missing value belongs, so nobody mistakes it for finished text.
 *   - In production (NODE_ENV=production): the app REFUSES to start.
 *
 * WHICH VALUES NEED AN OFFICIAL DOCUMENT
 *   RC_NUMBER and ICE_NUMBER come from your registration papers. Do not guess
 *   them. If you are not registered yet, see the README: you may operate a
 *   closed pilot as an individual, but you cannot publish a policy that claims
 *   a company registration you do not have.
 * ============================================================================
 */

/** One field of the business identity. */
const field = (key, label, labelAr, help, required = true) => ({ key, label, labelAr, help, required });

/** Every value the legal pages need, in the order a person would fill them. */
export const BUSINESS_FIELDS = [
  field('BUSINESS_NAME', 'Nom de l’entreprise', 'اسم الشركة',
    'Le nom sous lequel tu exerces. Exemple: le nom inscrit sur ton RC.'),
  field('LEGAL_FORM', 'Forme juridique', 'الشكل القانوني',
    'SARL, SARL AU, auto-entrepreneur, personne physique… tel qu’inscrit officiellement.'),
  field('RC_NUMBER', 'Numéro de registre de commerce (RC)', 'رقم السجل التجاري',
    'Figure sur ton modèle J ou ton certificat d’immatriculation. Document officiel requis.'),
  field('ICE_NUMBER', 'Identifiant commun de l’entreprise (ICE)', 'المعرف الموحد للمقاولة',
    'Quinze chiffres, délivrés par la DGI. Document officiel requis.'),
  field('BUSINESS_ADDRESS', 'Adresse du siège', 'عنوان المقر',
    'L’adresse complète figurant sur tes documents officiels.'),
  field('BUSINESS_CITY', 'Ville', 'المدينة',
    'La ville du siège social.'),
  field('BUSINESS_PHONE', 'Téléphone de contact', 'هاتف التواصل',
    'Le numéro qu’un client ou une autorité peut appeler.'),
  field('BUSINESS_EMAIL', 'Email de contact', 'البريد الإلكتروني',
    'Une adresse que tu relis vraiment: elle sert aussi aux demandes RGPD/09-08.'),
  field('RESPONSIBLE_PERSON', 'Responsable du traitement des données', 'المسؤول عن معالجة البيانات',
    'La personne physique responsable, nommément. C’est elle que la CNDP contactera.'),
  // Optional: only needed once the declaration has actually been filed.
  field('CNDP_DECLARATION', 'Numéro de déclaration CNDP', 'رقم التصريح لدى اللجنة الوطنية',
    'Laisse vide tant que la déclaration n’est pas déposée. Ne jamais inventer.', false),
];

/* ----------------------------------------------------------------------- */
/* Edit here, or set the environment variable of the same name.            */
/* ----------------------------------------------------------------------- */
const DEFAULTS = {
  BUSINESS_NAME: '',
  LEGAL_FORM: '',
  RC_NUMBER: '',
  ICE_NUMBER: '',
  BUSINESS_ADDRESS: '',
  BUSINESS_CITY: '',
  BUSINESS_PHONE: '',
  BUSINESS_EMAIL: '',
  RESPONSIBLE_PERSON: '',
  CNDP_DECLARATION: '',
};

/** The environment wins over the file, so a server carries its own details. */
export function businessValues() {
  const out = {};
  for (const { key } of BUSINESS_FIELDS) {
    out[key] = String(process.env[key] ?? DEFAULTS[key] ?? '').trim();
  }
  return out;
}

/** The required fields still empty. */
export function missingBusinessFields() {
  const values = businessValues();
  return BUSINESS_FIELDS.filter((f) => f.required && !values[f.key]).map((f) => f.key);
}

export const businessComplete = () => missingBusinessFields().length === 0;

/**
 * What the browser receives. Empty values are sent as empty strings; the
 * interface marks them visibly rather than hiding the gap.
 */
export function businessForClient() {
  return {
    values: businessValues(),
    missing: missingBusinessFields(),
    complete: businessComplete(),
    fields: BUSINESS_FIELDS.map(({ key, label, labelAr, help, required }) =>
      ({ key, label, labelAr, help, required })),
  };
}
