const mongoose = require('mongoose');
const { auteurSchema, versJson, dateJour } = require('./commun');
const acc = require('../config/accouchement');
const cpn = require('../config/cpn');

const ouiNon = { type: Boolean, default: null };
const instant = { type: Date, default: null };
const texte = { type: String, default: '', trim: true };
const nombre = (min, max) => ({ type: Number, min, max, default: null });
/** Choix facultatif dans un référentiel ('' = non renseigné). */
const choix = (valeurs) => ({ type: String, enum: [...valeurs, ''], default: '' });
/** Objet { code: définition } construit depuis un référentiel. */
const parCode = (liste, def) => Object.fromEntries(liste.map((x) => [x.code, def()]));
const codes = (liste) => liste.map((x) => x.code);
const sansId = { _id: false };

/** Module 1 — Admission : identité (copiée du dossier, modifiable) et anamnèse. */
const admissionSchema = new mongoose.Schema({
  // A. Identité
  nom: texte, postnom: texte, prenom: texte,
  age: nombre(8, 70),
  occupation: texte,
  etatMatrimonial: choix(cpn.ETATS_CIVILS),
  provenance: choix(codes(acc.PROVENANCES)),
  provenancePrecision: texte,
  nomPartenaire: texte,
  adresse: texte,
  personneAPrevenir: { nom: texte, telephone: texte },
  // B. Anamnèse
  motif: texte,
  groupeSanguin: choix(cpn.GROUPES_SANGUINS),
  rhesus: choix(cpn.RHESUS),
  statutHb: choix(acc.STATUTS_HB),
  gestite: nombre(0, 30), parite: nombre(0, 30), avortements: nombre(0, 30), enfantsVivants: nombre(0, 30),
  ddr: dateJour(), dpa: dateJour(),
  vih: { conseillee: ouiNon, testee: ouiNon, informee: ouiNon, resultat: choix(acc.RESULTATS_VIH) },
  arv: { regime: texte, depuisLe: dateJour() },
  debutTravail: instant,
  antecedents: {
    medicoChirurgicaux: texte,
    gynecoObstetricaux: {
      vivants: nombre(0, 30), morts: nombre(0, 30), mortNes: nombre(0, 30),
      eutocies: nombre(0, 30), dystocies: nombre(0, 30), bebesPlus4kg: nombre(0, 30),
      cesariennes: { type: [new mongoose.Schema({ annee: nombre(1950, 2100), indication: texte }, sansId)], default: [] },
      autres: texte,
    },
  },
  admiseLe: { type: Date, required: true },
  admisePar: { type: auteurSchema, required: true },
}, sansId);

/** Module 2 — Examen clinique général, examen gynéco-obstétrical et laboratoire d'entrée. */
const examenSchema = new mongoose.Schema({
  physique: {
    poidsKg: nombre(20, 250), tailleCm: nombre(100, 220), temperature: nombre(30, 45), pouls: nombre(30, 220),
    taSystolique: nombre(50, 260), taDiastolique: nombre(30, 180),
    oedemes: ouiNon,
    conjonctives: choix(acc.CONJONCTIVES),
    etatGeneral: choix(acc.ETATS_GENERAUX),
    systemes: parCode(acc.SYSTEMES, () => texte),
  },
  obstetrical: {
    hauteurUterineCm: nombre(0, 50),
    presentation: choix(acc.PRESENTATIONS),
    position: texte,
    bcf: nombre(50, 250),
    contractions10min: nombre(0, 10),
    contractions: texte,
    mouvementsFoetauxActifs: ouiNon,
    speculum: texte,
    colAspect: texte,
    toucherVaginal: { effacementPct: nombre(0, 100), dilatationCm: nombre(0, 10), oedemeCol: ouiNon },
    pocheEaux: { etat: choix(acc.ETATS_POCHE), rompueLe: instant, aspectLiquide: choix(acc.ASPECTS_LA) },
    engagement: choix(acc.ENGAGEMENTS),
    bassin: choix(acc.BASSINS),
  },
  laboratoire: parCode(acc.EXAMENS_LABO_ENTREE, () => texte),
  conclusion: texte,
  pronostic: texte,
  conduiteATenir: texte,
  /** Examinateur : soignant connecté ; heure de l'examen saisie (par défaut, l'enregistrement). */
  examinateur: { type: auteurSchema, required: true },
  examineLe: { type: Date, required: true },
}, sansId);

/**
 * Module 3 — Une ligne de surveillance du travail (tableau horaire de la phase de latence ou
 * tableau de la phase active). Ajout seul : une saisie n'est jamais modifiée ni supprimée.
 */
const surveillanceSchema = new mongoose.Schema({
  le: { type: Date, required: true },
  phase: { type: String, enum: ['Latence', 'Active'], required: true },
  /** Saignement (latence) / pertes de sang (phase active). */
  saignement: choix(acc.SAIGNEMENTS),
  contractions10min: nombre(0, 10),
  dureeContractionsSec: nombre(0, 300),
  bcf: nombre(50, 250),
  /** Température axillaire. */
  temperature: nombre(30, 45),
  pouls: nombre(30, 220),
  taSystolique: nombre(50, 260), taDiastolique: nombre(30, 180),
  diurese: texte,
  dilatationCm: nombre(0, 10),
  /** Effacement du col (%). */
  effacementPct: nombre(0, 100),
  // Phase de latence
  affection: texte,
  traitements: texte,
  // Phase active
  membranes: choix(acc.MEMBRANES),
  liquideAmniotique: choix(acc.ASPECTS_LA),
  ocytocine: { uParMl: nombre(0, 100), gouttesMin: nombre(0, 200) },
  medicamentsIV: texte,
  engagement: choix(codes(acc.ENGAGEMENTS_PARTOGRAMME)),
  incident: texte,
  auteur: { type: auteurSchema, required: true },
}, { toJSON: { transform: versJson } });

/** Alerte du partogramme : conservée avec ses destinataires et son acquittement. */
const alerteSchema = new mongoose.Schema({
  code: { type: String, enum: ['BCF', 'Zone jaune', 'Stagnation', 'Zone rouge'], required: true },
  niveau: { type: String, enum: ['Avertissement', 'Critique'], required: true },
  sonore: { type: Boolean, default: false },
  message: { type: String, required: true },
  surveillanceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  le: { type: Date, required: true },
  /** Médecins notifiés automatiquement (zone rouge). */
  medecinsNotifies: { type: [String], default: [] },
  acquitteePar: { type: auteurSchema, default: undefined },
  acquitteeLe: instant,
}, { toJSON: { transform: versJson } });

/** Module 4 — Accouchement et délivrance. */
const accouchementSchema = new mongoose.Schema({
  mode: { type: String, enum: acc.MODES_ACCOUCHEMENT, required: true },
  heure: { type: Date, required: true },
  multiple: ouiNon,
  nombreEnfants: nombre(1, 6),
  dechirure: { presente: ouiNon, degre: nombre(1, 4) },
  episiotomie: ouiNon,
  indicationCesarienne: texte,
  /** Accoucheur (nom saisi, par défaut le soignant connecté) et personne qui l'a assisté. */
  accoucheur: texte,
  assiste: texte,
  delivrance: {
    ocytocine10UI: { administree: ouiNon, heure: instant },
    tractionControlee: ouiNon,
    massageUterin: ouiNon,
    mode: choix(acc.MODES_DELIVRANCE),
    heure: instant,
    placenta: { complet: ouiNon, aspect: texte },
    membranesCompletes: ouiNon,
    pertesSangMl: nombre(0, 10000),
    /** Physiologique ≤ 500 ml, pathologique au-delà (calculée si le volume est mesuré). */
    hemorragie: choix(['Physiologique', 'Pathologique']),
  },
  enregistrePar: { type: auteurSchema, required: true },
  enregistreLe: { type: Date, required: true },
}, sansId);

/** Module 6 — Surveillance post-partum (mère et nouveau-nés), traitements, sortie. */
const surveillancePostPartumSchema = new mongoose.Schema({
  creneau: { type: String, enum: [...codes(acc.CRENEAUX_POST_PARTUM), 'Supplémentaire'], required: true },
  le: { type: Date, required: true },
  mere: {
    taSystolique: nombre(50, 260), taDiastolique: nombre(30, 180), pouls: nombre(30, 220), temperature: nombre(30, 45),
    respiration: nombre(5, 80),
    conscience: texte,
    saignement: choix(acc.SAIGNEMENTS),
    /** Globe de sécurité bien formé. */
    globeSecurite: ouiNon,
    vessieDiurese: texte,
    allaitement: texte,
    reactionsPsy: texte,
  },
  nouveauNes: {
    type: [new mongoose.Schema({
      enfantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Enfant', required: true },
      respiration: nombre(5, 150),
      coloration: texte,
      temperatureAxillaire: nombre(30, 45),
      signesDanger: texte,
    }, sansId)],
    default: [],
  },
  observations: texte,
  auteur: { type: auteurSchema, required: true },
}, { toJSON: { transform: versJson } });

const traitementSchema = new mongoose.Schema({
  pour: { type: String, enum: acc.POUR_TRAITEMENT, required: true },
  enfantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Enfant', default: null },
  produit: { type: String, required: true, trim: true },
  dose: texte, voie: texte, frequence: texte, duree: texte,
  statut: { type: String, enum: acc.STATUTS_TRAITEMENT, default: 'Prévu' },
  administreLe: instant,
  auteur: { type: auteurSchema, required: true },
  le: { type: Date, required: true },
}, { toJSON: { transform: versJson } });

const postPartumSchema = new mongoose.Schema({
  surveillances: { type: [surveillancePostPartumSchema], default: [] },
  traitements: { type: [traitementSchema], default: [] },
  sortie: {
    type: new mongoose.Schema({
      date: dateJour(true),
      /** Rendez-vous de consultation postnatale (CPoN), créé dans l'agenda de la mère. */
      rdvCpon: instant,
      rdvCponId: { type: mongoose.Schema.Types.ObjectId, ref: 'RendezVous', default: null },
      observations: texte,
      examinePar: { type: auteurSchema, required: true },
      le: { type: Date, required: true },
    }, sansId),
    default: undefined,
  },
  conseils: texte,
  /** Mesures préventives (oui/non) : toutes renseignées pour clore le dossier. */
  mesuresPreventives: {
    mere: parCode(acc.MESURES_SORTIE_MERE, () => ouiNon),
    nouveauNe: parCode(acc.MESURES_SORTIE_NOUVEAU_NE, () => ouiNon),
  },
}, sansId);

/**
 * Dossier d'accouchement d'une grossesse : de l'admission en salle de travail à la sortie.
 * Les nouveau-nés ont leur propre dossier (Enfant), rattaché à la mère et à cet accouchement.
 */
const dossierSchema = new mongoose.Schema({
  /** Identifiant public AC-ACC-000001. */
  numero: { type: String, required: true, unique: true },
  patienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patiente', required: true, index: true },
  grossesseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Grossesse', required: true, index: true },
  etablissementId: { type: String, default: null },
  statut: { type: String, enum: acc.STATUTS_ACCOUCHEMENT, default: 'En travail', index: true },

  admission: { type: admissionSchema, required: true },
  examenClinique: { type: examenSchema, default: undefined },
  /** Début de la phase active (première dilatation ≥ 4 cm) : origine du partogramme. */
  phaseActiveLe: instant,
  surveillances: { type: [surveillanceSchema], default: [] },
  alertes: { type: [alerteSchema], default: [] },
  accouchement: { type: accouchementSchema, default: undefined },
  postPartum: { type: postPartumSchema, default: () => ({}) },

  cloture: {
    type: new mongoose.Schema({ par: { type: auteurSchema, required: true }, le: { type: Date, required: true } }, sansId),
    default: undefined,
  },
  creePar: { type: auteurSchema, required: true },
}, { timestamps: true, toJSON: { transform: versJson } });

/** AC-ACC-000001, AC-ACC-000002… (l'index unique protège des collisions). */
dossierSchema.statics.prochainNumero = async function () {
  const dernier = await this.findOne({ numero: /^AC-ACC-\d+$/ }).sort({ numero: -1 }).select('numero');
  const n = dernier ? parseInt(dernier.numero.slice(7), 10) || 0 : 0;
  return `AC-ACC-${String(n + 1).padStart(6, '0')}`;
};

module.exports = mongoose.model('Accouchement', dossierSchema);
