// Référentiel du dossier d'accouchement (fiche « Module accouchement » de l'équipe médicale) :
// admission, examen clinique, partogramme, accouchement et délivrance, nouveau-né, post-partum.
// Source unique : les modèles le valident, le tableau de bord le charge via /referentiels/accouchement.

/** Provenance de la parturiente. */
const PROVENANCES = [
  { code: 'AS', libelle: 'Aire de santé' },
  { code: 'HAS', libelle: 'Hors aire de santé' },
  { code: 'HZ', libelle: 'Hors zone de santé' },
];
const STATUTS_HB = ['AA', 'AS', 'SS'];
const RESULTATS_VIH = ['Négatif', 'Positif', 'Indéterminé'];

const CONJONCTIVES = ['Colorées', 'Pâles'];
const ETATS_GENERAUX = ['Bon', 'Passable', 'Mauvais'];
/** Les 6 systèmes de l'examen physique (constatations en texte libre). */
const SYSTEMES = [
  { code: 'respiratoire', libelle: 'Respiratoire' },
  { code: 'circulatoire', libelle: 'Circulatoire' },
  { code: 'digestif', libelle: 'Digestif' },
  { code: 'urinaire', libelle: 'Urinaire' },
  { code: 'locomoteur', libelle: 'Locomoteur' },
  { code: 'nerveux', libelle: 'Nerveux' },
];

const PRESENTATIONS = ['Sommet', 'Siège', 'Face', 'Front', 'Transversale', 'Oblique', 'Non déterminée'];
const ETATS_POCHE = ['Non rompue', 'Rompue'];
const ASPECTS_LA = ['Clair', 'Verdâtre', 'Sanguinolent', 'Jaunâtre', 'Purulent'];
/** Degré d'engagement à l'admission. */
const ENGAGEMENTS = ['Haute', 'Amorcée', 'Fixée', 'Engagée'];
/** Engagement noté sur le partogramme (M/A/F/E/D). */
const ENGAGEMENTS_PARTOGRAMME = [
  { code: 'M', libelle: 'Mobile' },
  { code: 'A', libelle: 'Amorcée' },
  { code: 'F', libelle: 'Fixée' },
  { code: 'E', libelle: 'Engagée' },
  { code: 'D', libelle: 'Dégagée' },
];
const BASSINS = ['Bon', 'Limite', 'Rétréci', 'Asymétrique'];

/** Laboratoire d'entrée (résultats en texte libre). */
const EXAMENS_LABO_ENTREE = [
  { code: 'gs', libelle: 'GS' }, { code: 'hc', libelle: 'Hc' }, { code: 'hb', libelle: 'Hb' },
  { code: 'tdrPalu', libelle: 'TDR palu' }, { code: 'ge', libelle: 'GE' }, { code: 'albuminurie', libelle: 'Albuminurie' },
  { code: 'rprSyphilis', libelle: 'RPR syphilis' }, { code: 'ecbu', libelle: 'ECBU' },
];

/** Saignement / pertes de sang (latence et phase active). */
const SAIGNEMENTS = ['0', '+', '++', '+++'];
const MEMBRANES = ['Intactes', 'Rompues'];

/** Type d'accouchement (la grossesse multiple et les gestes associés sont notés à part). */
const MODES_ACCOUCHEMENT = ['Normal', 'Ventouse', 'Forceps', 'Symphyséotomie', 'Césarienne'];
/** Correspondance avec l'issue de la grossesse (dossier prénatal). */
const MODE_ISSUE = {
  Normal: 'Voie basse', Ventouse: 'Voie basse instrumentale', Forceps: 'Voie basse instrumentale',
  Symphyséotomie: 'Voie basse instrumentale', Césarienne: 'Césarienne',
};
const MODES_DELIVRANCE = ['Spontanée', 'Artificielle'];
/** Au-delà de ce volume (ml), l'hémorragie de la délivrance est pathologique. */
const HEMORRAGIE_PHYSIOLOGIQUE_MAX_ML = 500;

/** Nouveau-né. */
const SEXES = ['Féminin', 'Masculin', 'Indéterminé'];
const ETATS_NAISSANCE = ['Vivant', 'Mort-né'];
/** Critères APGAR (0 à 2 chacun), cotés à 1, 5 et 10 minutes. */
const APGAR_CRITERES = [
  { code: 'respiration', libelle: 'Respiration' },
  { code: 'fc', libelle: 'Fréquence cardiaque' },
  { code: 'coloration', libelle: 'Coloration' },
  { code: 'reflexes', libelle: 'Réflexes' },
  { code: 'tonus', libelle: 'Tonus' },
];
const APGAR_MINUTES = [1, 5, 10];

/**
 * Surveillance post-partum : 1re et 2e heure toutes les 15 min, 3e heure toutes les 30 min,
 * puis 4e, 5e, 6e heure et J1, J2, J3. « minutes » : délai après l'accouchement.
 */
const CRENEAUX_POST_PARTUM = [
  ...[15, 30, 45, 60].map((m) => ({ code: `H1-${m}`, libelle: `1re heure — ${m} min`, minutes: m })),
  ...[15, 30, 45, 60].map((m) => ({ code: `H2-${m}`, libelle: `2e heure — ${m} min`, minutes: 60 + m })),
  ...[30, 60].map((m) => ({ code: `H3-${m}`, libelle: `3e heure — ${m} min`, minutes: 120 + m })),
  ...[4, 5, 6].map((h) => ({ code: `H${h}`, libelle: `${h}e heure`, minutes: h * 60 })),
  ...[1, 2, 3].map((j) => ({ code: `J${j}`, libelle: `Jour ${j}`, minutes: j * 1440 })),
];
const POUR_TRAITEMENT = ['Mère', 'Nouveau-né'];
const STATUTS_TRAITEMENT = ['Prévu', 'Administré'];

/** Mesures préventives de sortie : toutes doivent être renseignées (oui/non) pour clore le dossier. */
const MESURES_SORTIE_MERE = [
  { code: 'ferFolate', libelle: 'Fer / folate' }, { code: 'mebendazole', libelle: 'Mébendazole' },
  { code: 'sp', libelle: 'SP' }, { code: 'mild', libelle: 'MILD' }, { code: 'vat', libelle: 'VAT' },
  { code: 'vitamineA', libelle: 'Vitamine A' }, { code: 'rpr', libelle: 'RPR' }, { code: 'arv', libelle: 'ARV' },
  { code: 'tb', libelle: 'TB' },
];
const MESURES_SORTIE_NOUVEAU_NE = [
  { code: 'bcgVpo', libelle: 'BCG / VPO' }, { code: 'rpr', libelle: 'RPR' }, { code: 'prophylaxieTb', libelle: 'Prophylaxie TB' },
  { code: 'mild', libelle: 'MILD' }, { code: 'antibiotique', libelle: 'Antibiotique si risque infectieux' },
  { code: 'arvProphylaxie', libelle: 'ARV prophylaxie' },
];

const STATUTS_ACCOUCHEMENT = ['En travail', 'Post-partum', 'Clôturé'];

module.exports = {
  PROVENANCES, STATUTS_HB, RESULTATS_VIH, CONJONCTIVES, ETATS_GENERAUX, SYSTEMES, PRESENTATIONS, ETATS_POCHE,
  ASPECTS_LA, ENGAGEMENTS, ENGAGEMENTS_PARTOGRAMME, BASSINS, EXAMENS_LABO_ENTREE, SAIGNEMENTS, MEMBRANES,
  MODES_ACCOUCHEMENT, MODE_ISSUE, MODES_DELIVRANCE, HEMORRAGIE_PHYSIOLOGIQUE_MAX_ML, SEXES, ETATS_NAISSANCE,
  APGAR_CRITERES, APGAR_MINUTES, CRENEAUX_POST_PARTUM, POUR_TRAITEMENT, STATUTS_TRAITEMENT,
  MESURES_SORTIE_MERE, MESURES_SORTIE_NOUVEAU_NE, STATUTS_ACCOUCHEMENT,
};
