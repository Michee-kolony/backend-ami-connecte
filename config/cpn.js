// Référentiel de la fiche CPN (consultation prénatale) fourni par l'équipe médicale.
// Source unique : les modèles le valident, le tableau de bord le charge via /referentiels/cpn.

const ETATS_CIVILS = ['Célibataire', 'Mariée', 'Union libre', 'Divorcée', 'Veuve'];
const GROUPES_SANGUINS = ['A', 'B', 'AB', 'O'];
const RHESUS = ['Positif', 'Négatif'];
const ELECTROPHORESES = ['AA', 'AS', 'SS', 'SC', 'AC', 'Autre'];

/** Antécédents à cocher (dossier de la patiente, durables d'une grossesse à l'autre). */
const ATCD_MEDICAUX = [
  'Tuberculose (TBC)', 'Hypertension artérielle (HTA)', 'Drépanocytose (SCA/SS)', 'Diabète (DBT)', 'Cardiopathie (CAR)',
  'Mutilations génitales (MGF)', 'Rhumatisme articulaire aigu (RAA)', 'Syphilis', 'VIH/SIDA', 'Viol',
  'Prophylaxie post-exposition (PEP)',
];
const ATCD_GYNECO_CHIRURGICAUX = [
  'Césarienne', 'Cerclage', 'Fibrome utérin', 'Fracture du bassin', 'Grossesse extra-utérine (GEU)', 'Fistule',
  'Utérus cicatriciel', 'Traitement pour stérilité',
];
const ATCD_OBSTETRICAUX = [
  'Primipare de moins de 19 ans', 'Primipare de plus de 35 ans', 'Dystocie', 'Eutocie', 'Enfant de plus de 4 kg', 'Prématuré',
  'Post-mature', 'Mort-né', 'Décès avant 7 jours', 'Intervalle inférieur à 3 ans', 'Complication du post-partum',
];

/** Signes oui/non relevés à chaque visite CPN. */
const SIGNES_CPN = [
  { code: 'peauSeche', libelle: 'Peau sèche, hyperplissée', groupe: 'Malnutrition' },
  { code: 'ceciteNocturne', libelle: 'Cécité nocturne', groupe: 'Malnutrition' },
  { code: 'goitre', libelle: 'Goitre', groupe: 'Malnutrition' },
  { code: 'fievre', libelle: 'Fièvre', groupe: 'Infection' },
  { code: 'dysurie', libelle: 'Dysurie', groupe: 'Infection' },
  { code: 'perteVaginale', libelle: 'Pertes vaginales', groupe: 'Infection' },
  { code: 'proteinurie', libelle: 'Protéinurie', groupe: 'Pré-éclampsie' },
  { code: 'oedemes', libelle: 'Œdèmes', groupe: 'Pré-éclampsie' },
  { code: 'anemie', libelle: 'Anémie', groupe: 'Pré-éclampsie' },
  { code: 'paleur', libelle: 'Pâleur cutanéo-muqueuse', groupe: 'Pré-éclampsie' },
  { code: 'seinsNormaux', libelle: 'Seins normaux', groupe: 'Seins' },
  { code: 'masseSein', libelle: 'Masse du sein', groupe: 'Seins' },
  { code: 'presentationTransversale', libelle: 'Présentation transversale (à partir de 36 SA)', groupe: 'Risque chirurgical' },
  { code: 'eclampsie', libelle: 'Éclampsie', groupe: 'Risque chirurgical' },
];

const ETATS_GENERAUX = ['Bon', 'Mauvais'];
const PRESENTATIONS = ['Céphalique', 'Siège', 'Transversale', 'Oblique', 'Non déterminée'];

/**
 * Mesures préventives (oui/non, datées par la visite). « saisie » : valeur à noter en plus
 * (résultat, méthode…). « semaine » : âge gestationnel (SA) à partir duquel la mesure est attendue.
 */
const MESURES_PREVENTIVES = [
  ...[1, 2, 3, 4, 5].map((n) => ({ code: `vat${n}`, libelle: `VAT ${n}`, groupe: 'VAT' })),
  { code: 'sp1', libelle: 'SP 1', groupe: 'SP (TPI)', repere: 'À 16 SA', semaine: 16 },
  { code: 'sp2', libelle: 'SP 2', groupe: 'SP (TPI)', repere: 'À 24 SA', semaine: 24 },
  { code: 'sp3', libelle: 'SP 3', groupe: 'SP (TPI)', repere: 'À 32 SA', semaine: 32 },
  { code: 'cotrimoxazole', libelle: 'Début du cotrimoxazole', groupe: 'VIH' },
  { code: 'tar', libelle: 'TAR', groupe: 'VIH' },
  { code: 'cd4', libelle: 'CD4', groupe: 'VIH', saisie: 'Taux de CD4' },
  { code: 'mild', libelle: 'Dort sous MILD', groupe: 'Prévention', repere: 'Dès la CPN 1' },
  { code: 'micronutriments', libelle: 'Supplémentation en micronutriments', groupe: 'Prévention', repere: 'Dès la CPN 1' },
  { code: 'mebendazole', libelle: 'Vermifuge : mébendazole (2e trimestre)', groupe: 'Prévention', repere: 'Au-delà de 16 SA', semaine: 16 },
  { code: 'rpr', libelle: 'RPR positif', groupe: 'Dépistages', repere: 'Selon la date de réalisation' },
  { code: 'depistageCaCol', libelle: 'Dépistage du cancer du col', groupe: 'Dépistages', saisie: 'Résultat', repere: 'Selon la date de réalisation' },
  { code: 'toux', libelle: 'Dépistage TBC : toux > 2 semaines (si oui, orienter)', groupe: 'Dépistages', repere: 'À rechercher à chaque visite' },
  { code: 'conseilPf', libelle: 'Conseil PF', groupe: 'Planification familiale', repere: 'Selon la date de réalisation' },
  { code: 'methodePf', libelle: 'Méthode PF choisie', groupe: 'Planification familiale', saisie: 'Méthode' },
  { code: 'dcip', libelle: 'DCIP de la femme : conseil', groupe: 'PTME', repere: 'Selon la date de réalisation' },
  { code: 'codePtme', libelle: 'Code PTME', groupe: 'PTME', saisie: 'Code' },
  { code: 'resultatTest', libelle: 'Résultat du test annoncé', groupe: 'PTME', saisie: 'Résultat' },
  { code: 'testPartenaire', libelle: 'Test du partenaire', groupe: 'PTME', saisie: 'Résultat' },
  { code: 'planAccouchement', libelle: 'Plan d’accouchement discuté', groupe: 'Préparation' },
];

/** Examens de laboratoire (résultats saisis en texte libre). */
const EXAMENS_LABO = [
  { code: 'hb', libelle: 'Hb (g/dl)' }, { code: 'ge', libelle: 'GE' }, { code: 'tdrPalu', libelle: 'TDR palu' },
  { code: 'gs', libelle: 'GS' }, { code: 'urines', libelle: 'Urines' }, { code: 'selles', libelle: 'Selles' },
  { code: 'glycemie', libelle: 'Glycémie' }, { code: 'nfs', libelle: 'NFS' }, { code: 'crp', libelle: 'CRP' },
  { code: 'vs', libelle: 'VS' }, { code: 'autres', libelle: 'Autres' },
];

/** Intervalles proposés pour le prochain rendez-vous (date de la visite + n semaines). */
const INTERVALLES_RDV_SEMAINES = [1, 2, 4, 8];

/** Éléments de référence de la femme (cochés par le médecin ; la référence est horodatée). */
const MOTIFS_REFERENCE = [
  'Malnutrition sévère avec complication ou sans appétit', 'Goitre', 'Conjonctives pâles et Hb < 7 g/dl',
  'Conjonctives ictériques', 'TA systolique > 140', 'TA diastolique > 90 et protéinurie ++', 'Fistule réparée',
  'Discordance HU / âge de la grossesse', 'BCF négatifs à partir de 20 SA', 'Mouvements fœtaux négatifs à partir de 20 SA',
  'Présentation transversale à partir de 36 SA', 'Bassin rétréci', 'Bassin limite', 'Anomalie du col', 'Utérus cicatriciel',
  'Masse suspecte du sein', 'Maladie chronique', 'Drépanocytose', 'Autres raisons',
];

module.exports = {
  ETATS_CIVILS, GROUPES_SANGUINS, RHESUS, ELECTROPHORESES,
  ATCD_MEDICAUX, ATCD_GYNECO_CHIRURGICAUX, ATCD_OBSTETRICAUX,
  SIGNES_CPN, ETATS_GENERAUX, PRESENTATIONS, MESURES_PREVENTIVES, EXAMENS_LABO, INTERVALLES_RDV_SEMAINES, MOTIFS_REFERENCE,
};
